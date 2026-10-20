import contextlib
import datetime
import io
import json
import time
import shutil
import os
import sqlite3
import sys
import subprocess
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))

import on_my_watch as w  # noqa: E402

w.download = lambda url: (f'picture of {url}'.encode(), 'image/png')  # no network in tests


def query(label='Error logs', env='Production', priority=1, q='service:checkout-api env:production status:error', **more):
    return {'label': label, 'env': env, 'priority': priority, 'source': 'logs', 'query': q, 'alert': {'above': 20}, **more}


def repos(*entries):
    """repos from (owner/name, its name, service, [queries]) entries."""
    found = []
    for repo, name, service, queries in entries:
        if not found or found[-1]['repo'] != repo:
            found.append({'repo': repo, 'name': name, 'queries': []})
        found[-1].setdefault('queries', []).extend({'service': service, **q} for q in queries)
    return found


CONFIG = {
    'site': 'datadoghq.com',
    'schedule': '0 9 * * *',
    'window': '1h',
    'repos': repos(('acme/checkout-api', 'API', 'Checkout', [query()])),
}


def total(n):
    """A logs or traces aggregate answer with no grouping: one number."""
    return {'data': [{'attributes': {'compute': {'c0': n}}}]}


def by_service(counts):
    return {'data': [{'attributes': {'by': {'service': s}, 'compute': {'c0': n}}} for s, n in counts.items()]}


class FakePup:
    """Answers each pup call with now, recording the calls."""

    def __init__(self, now=None, fail=None):
        self.now, self.fail, self.calls = now if now is not None else total(0), fail, []

    def __call__(self, args):
        self.calls.append(args)
        if self.fail:
            raise RuntimeError(self.fail)
        return self.now


def node(repo, pr):
    """A PR as GitHub's search answers it, from the short form the tests write."""
    author = pr.get('author')
    return {'number': pr['number'], 'title': pr['title'], 'url': pr['url'], 'state': pr.get('state', 'OPEN'),
            'isDraft': pr.get('isDraft', False), 'createdAt': pr['createdAt'], 'updatedAt': pr.get('updatedAt', pr['createdAt']),
            'closedAt': pr.get('closedAt'), 'reviewDecision': pr.get('reviewDecision'), 'repository': {'nameWithOwner': repo},
            'author': author and {'login': author['login'], '__typename': 'Bot' if author.get('is_bot') else 'User'},
            'commits': {'nodes': [{'commit': {'statusCheckRollup': pr['ci'] and {'state': pr['ci']}}}]} if 'ci' in pr else {'nodes': []},
            'latestOpinionatedReviews': {'nodes': [{'state': state, 'author': {'login': who, 'avatarUrl': f'https://a/{who}'}}
                                                   for who, state in pr.get('reviews', {}).items()]},
            'reviewRequests': {'nodes': [{'requestedReviewer': {'login': who, 'avatarUrl': f'https://a/{who}'}}
                                         for who in pr.get('requested', [])]
                               + [{'requestedReviewer': {'slug': team, 'avatarUrl': f'https://a/t/{team}'}}
                                  for team in pr.get('teams', [])]}}


def fake_gh(prs, closed=None):
    """GitHub's PR search, paginated: open PRs per repo, and closed ones (merged or not) for an is:closed search."""
    def run_gh(args):
        q = next(a[2:] for a in args if a.startswith('q='))
        table = (closed or {}) if 'is:closed' in q else prs
        nodes = [node(repo, pr) for repo, list_ in table.items() if f'repo:{repo}' in q for pr in list_]
        # Two to a page, so tests walk the pages as GitHub's search hands them out.
        at = int(next((a[10:] for a in args if a.startswith('endCursor=')), '0'))
        more = at + 2 < len(nodes)
        return {'data': {'search': {'pageInfo': {'hasNextPage': more, 'endCursor': str(at + 2) if more else None}, 'nodes': nodes[at:at + 2]}}}
    return run_gh


class Query(unittest.TestCase):
    def test_a_query_runs_exactly_as_written_and_gives_one_number(self):
        pup = FakePup(now={'data': [{'attributes': {'compute': {'c0': 40}}}, {'attributes': {'compute': {'c0': 2}}}]})
        found = w.measure({'source': 'traces', 'query': 'service:x env:production status:error'}, pup)
        self.assertEqual(found, 42)
        self.assertEqual(pup.calls[0][pup.calls[0].index('--query') + 1], 'service:x env:production status:error')
        self.assertNotIn('--group-by', pup.calls[0])

    def test_metrics_are_reduced_over_every_point_of_the_window(self):
        pup = FakePup(now={'series': [{'pointlist': [[1, 1], [2, None], [3, 5]]}, {'pointlist': [[1, 3]]}]})
        q = {'source': 'metrics', 'query': 'sum:aws.lambda.errors{functionname:x}.as_count()', 'reduce': 'max'}
        self.assertEqual(w.measure(q, pup), 5)
        self.assertEqual(pup.calls[0][pup.calls[0].index('--query') + 1], 'sum:aws.lambda.errors{functionname:x}.as_count()')

    def test_metrics_reduce_defaults_to_average(self):
        self.assertEqual(w.reduce([2, 4, None]), 3)

    def test_queries_differing_only_in_their_service_are_counted_in_one_call(self):
        config = {**CONFIG, 'repos': repos(*[(f'acme/{svc}', name, 'Main', [query(q=f'service:{svc} env:production status:error',
                                                                                     alert={'above': 20})])
                                              for name, svc in (('API', 'checkout-api'), ('Worker', 'checkout-worker'), ('Search', 'search-api'))])}
        at = lambda counts: {'data': [{'attributes': {'by': {'service': s, 'env': 'production'}, 'compute': {'c0': n}}} for s, n in counts.items()]}
        pup = FakePup(now=at({'checkout-api': 90, 'checkout-worker': 5}))
        result, _ = w.watch(config, pup)
        # One call, not one per query; each read from its own service's count.
        self.assertEqual(len(pup.calls), 1)
        self.assertIn('service:("checkout-api" OR "checkout-worker" OR "search-api") env:("production") status:error', pup.calls[0])
        self.assertEqual([(p['name'], p['value']) for p in result['problems']], [('API', '90')])

    def test_log_queries_differing_in_service_and_env_are_one_call_grouped_by_both(self):
        both = lambda counts: {'data': [{'attributes': {'by': {'service': s, 'env': e}, 'compute': {'c0': n}}}
                                        for (s, e), n in counts.items()]}
        config = {**CONFIG, 'repos': repos(
            ('acme/api', 'API', 'Main', [query(env='Production', q='service:api env:production status:error'),
                                         query(env='Canary', q='service:api env:canary status:error')]),
            ('acme/worker', 'Worker', 'Main', [query(env='Production', q='service:worker env:production status:error')]))}
        pup = FakePup(now=both({('api', 'production'): 90, ('api', 'canary'): 3, ('worker', 'production'): 40}))
        result, _ = w.watch(config, pup)
        self.assertEqual(len(pup.calls), 1)
        self.assertIn('service:("api" OR "worker") env:("canary" OR "production") status:error', pup.calls[0])
        self.assertEqual(pup.calls[0][pup.calls[0].index('--group-by') + 1], 'service,env')
        self.assertEqual([(p['name'], p['env'], p['value']) for p in result['problems']], [('API', 'Production', '90'), ('Worker', 'Production', '40')])

    def test_a_query_no_other_shares_keeps_its_own_call(self):
        pup = FakePup(now=total(42))
        w.watch(CONFIG, pup)
        self.assertNotIn('--group-by', pup.calls[0])


class Alert(unittest.TestCase):
    def test_every_given_condition_must_hold(self):
        rule = {'above': 20, 'below': 100}
        self.assertTrue(w.alerts(rule, 72))
        self.assertFalse(w.alerts(rule, 150))
        self.assertFalse(w.alerts(rule, 15))

    def test_below_catches_a_drop_and_no_rule_never_alerts(self):
        self.assertTrue(w.alerts({'below': 100}, 40))
        self.assertFalse(w.alerts({}, 10_000))


class Format(unittest.TestCase):
    def test_the_alert_line_reads_as_words(self):
        self.assertEqual(w.describe({'source': 'logs', 'alert': {'above': 19}}), 'above 19')
        self.assertEqual(w.describe({'source': 'logs', 'alert': {'above': 19, 'below': 500}}), 'above 19, below 500')
        self.assertEqual(w.describe({'source': 'traces', 'compute': 'percentile(@duration, 95)', 'alert': {'above': 2e9}}), 'above 2.00s')

    def test_counts_read_as_whole_numbers_and_durations_as_seconds(self):
        self.assertEqual(w.display({'source': 'logs'}, 72.0), '72')
        self.assertEqual(w.display({'source': 'metrics'}, 0.256), '0.26')
        self.assertEqual(w.display({'source': 'traces', 'compute': 'percentile(@duration, 95)'}, 3_700_000_000), '3.70s')


class Ci(unittest.TestCase):
    def test_the_last_commits_check_rollup_is_one_state(self):
        self.assertEqual([w.ci({'state': s}) for s in ('SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED')],
                         ['passing', 'failing', 'failing', 'running', 'running'])
        self.assertIsNone(w.ci(None))


class Run(unittest.TestCase):
    def run_once(self, home, config=CONFIG, pup=None, gh=None):
        return w.run(config, pup or FakePup(), gh or fake_gh({}), os.path.join(home, 'history.db'))

    def test_a_query_over_its_line_is_an_entry_with_its_name_env_label_priority_and_pinned_link(self):
        with tempfile.TemporaryDirectory() as home:
            [problem] = self.run_once(home, pup=FakePup(now=total(72)))['problems']
        self.assertEqual({k: problem[k] for k in ('name', 'repo', 'env', 'label', 'priority', 'source', 'value', 'alert')},
                         {'name': 'API', 'repo': 'acme/checkout-api', 'env': 'Production', 'label': 'Error logs',
                          'priority': 1, 'source': 'logs', 'value': '72', 'alert': 'above 20'})
        self.assertRegex(problem['link'], r'^https://app\.datadoghq\.com/logs\?query=service%3Acheckout-api%20env%3Aproduction'
                                          r'%20status%3Aerror&from_ts=\d{13}&to_ts=\d{13}&live=false$')

    def test_most_urgent_first(self):
        config = {**CONFIG, 'repos': repos(('acme/checkout-api', 'API', 'Checkout', [
            query('C', priority=3, q='c'), query('B', priority=2, q='b'), query('A', priority=1, q='a')]))}
        with tempfile.TemporaryDirectory() as home:
            found = self.run_once(home, config=config, pup=FakePup(now=total(72)))['problems']
        self.assertEqual([p['label'] for p in found], ['A', 'B', 'C'])

    def test_a_config_breaking_the_schema_runs_nothing_and_says_where(self):
        broken = {**CONFIG, 'colour': 'blue', 'repos': [
            {'repo': 'Checkout', 'name': 'x', 'queries': []},
            {'repo': 'acme/api', 'name': 'API', 'queries': [
                {'service': 'Checkout', 'label': 'Half', 'source': 'logz', 'priority': 0, 'env': 'Production', 'query': 'q', 'alert': {}},
                {'service': 'Checkout', 'label': 'Half', 'source': 'logs', 'priority': 1, 'env': 'Production', 'query': 'q', 'alert': {'above': 1}}]},
            {'repo': 'acme/api', 'name': 'Again', 'queries': [query(service='Main')]}]}
        pup = FakePup(now=total(72))
        with tempfile.TemporaryDirectory() as home:
            result = self.run_once(home, config=broken, pup=pup)
        self.assertEqual(pup.calls, [])
        self.assertEqual(result['status'], 'failed')
        self.assertCountEqual(result['errors'], [
            'config.colour: is not a known field',
            "config.repos[0].repo: The GitHub repository as owner/name, such as acme/checkout-api. Got 'Checkout'",
            'config.repos[1].queries[0].priority: must be 1 (High), 2 (Medium) or 3 (Low)',
            'config.repos[1].queries[0].source: must be one of logs, traces, metrics',
            'config.repos[1].queries[0].alert: must not be empty',
            'config.repos[1].queries[1]: Checkout / Production / Half is listed already in this repository',
            'config.repos[2].repo: acme/api is listed already'])

    def test_a_repo_with_no_queries_is_allowed_for_its_pull_requests(self):
        config = {**CONFIG, 'repos': [*CONFIG['repos'], {'repo': 'acme/docs', 'name': 'Docs', 'queries': []}]}
        prs = {'acme/docs': [{'number': 4, 'title': 'Typo', 'author': {'login': 'kim'}, 'createdAt': '2026-10-15T09:00:00Z', 'url': 'u'}]}
        self.assertEqual(w.check_config(config), [])
        with tempfile.TemporaryDirectory() as home:
            [pr] = self.run_once(home, config=config, gh=fake_gh(prs))['pullRequests']
        self.assertEqual(pr['name'], 'Docs')

    def test_priorities_are_high_medium_and_low(self):
        config = {**CONFIG, 'repos': repos(('acme/api', 'API', 'Checkout', [
            query('Slow', priority=3, q='slow'), query('Errors', priority=1, q='errors'), query('Warnings', priority=2, q='warn')]))}
        self.assertEqual(w.check_config(config), [])
        with tempfile.TemporaryDirectory() as home:
            found = self.run_once(home, config=config, pup=FakePup(now=total(72)))['problems']
        self.assertEqual([(p['label'], p['priority'], p['priorityName']) for p in found],
                         [('Errors', 1, 'High'), ('Warnings', 2, 'Medium'), ('Slow', 3, 'Low')])

    def test_environments_group_names_under_one_and_leave_queries_as_they_are(self):
        config = {**CONFIG, 'environments': {'Production': ['Production', 'Canary']}}
        self.assertEqual(w.check_config(config), [])
        self.assertEqual(w.check_config({**CONFIG, 'environments': {'Production': 'Production'}}), ['config.environments.Production: must be an array'])
        self.assertEqual(w.check_config({**CONFIG, 'environments': {'Production': []}}), ['config.environments.Production: must not be empty'])

    def test_a_priority_is_1_2_or_3_and_priorities_can_no_longer_be_set(self):
        config = {**CONFIG, 'repos': repos(('acme/api', 'API', 'Checkout', [query(priority='high'), query('Other', priority=4, q='b')]))}
        self.assertEqual(w.check_config(config), [
            'config.repos[0].queries[0].priority: must be an integer',
            'config.repos[0].queries[1].priority: must be 1 (High), 2 (Medium) or 3 (Low)'])
        self.assertEqual(w.check_config({**CONFIG, 'priorities': {'1': 'Critical'}}), ['config.priorities: is not a known field'])

    def test_a_watch_only_repo_is_left_out_of_pull_requests(self):
        config = {**CONFIG, 'repos': [*CONFIG['repos'], {'repo': 'acme/infra', 'name': 'Infra', 'watch_only': True, 'queries': []}]}
        calls = []
        gh = fake_gh({'acme/infra': [{'number': 1, 'title': 'x', 'author': {'login': 'kim'}, 'createdAt': '2026-10-15T09:00:00Z', 'url': 'u'}]})
        self.assertEqual(w.check_config(config), [])
        with tempfile.TemporaryDirectory() as home:
            found = self.run_once(home, config=config, gh=lambda args: calls.append(args) or gh(args))['pullRequests']
        self.assertEqual(found, [])
        self.assertTrue(all('acme/infra' not in ' '.join(c) for c in calls))

    def test_the_example_config_holds_to_the_schema(self):
        with open(os.path.join(w.PLUGIN, 'config.example.json')) as file:
            self.assertEqual(w.check_config(json.load(file)), [])

    def test_a_compare_in_the_config_is_refused(self):
        config = {**CONFIG, 'repos': repos(('acme/checkout-api', 'API', 'Checkout', [query(alert={'above': 1, 'compare': {'ago': '7d', 'times': 3}})]))}
        self.assertTrue(any('compare' in line for line in w.check_config(config)))

    def test_only_the_current_window_is_read(self):
        pup = FakePup(now=total(72))
        with tempfile.TemporaryDirectory() as home:
            self.run_once(home, pup=pup)
        self.assertEqual([c[-1] for c in pup.calls], ['now'])

    def test_repositories_are_searched_in_small_groups_at_the_same_time(self):
        # GitHub's search takes about the same seconds whatever it finds, so a few small searches at once beat one big one.
        names = [f'acme/repo-{i}-api' for i in range(w.REPOS_PER_SEARCH * 2 + 1)]
        config = {**CONFIG, 'repos': [{'repo': r, 'name': r, 'queries': []} for r in names]}
        prs = {r: [{'number': 1, 'title': 't', 'url': f'https://github.com/{r}/pull/1', 'author': {'login': 'sam', 'is_bot': False}, 'isDraft': False,
                    'reviewDecision': None, 'createdAt': '2026-10-15T09:00:00Z', 'updatedAt': '2026-10-15T09:00:00Z'}] for r in names}
        searched, at_once, running = [], [0], [0]
        inner = fake_gh(prs)
        def run_gh(args):
            running[0] += 1
            at_once[0] = max(at_once[0], running[0])
            time.sleep(0.05)
            searched.append(next(a[2:] for a in args if a.startswith('q=')))
            running[0] -= 1
            return inner(args)
        result, _ = w.pull_requests_part(config, run_gh)
        opened = {q for q in searched if 'is:open' in q}  # one search per group, each read page by page
        self.assertEqual(len(opened), 3)
        self.assertTrue(all(q.count('repo:') <= w.REPOS_PER_SEARCH for q in opened))
        self.assertGreater(at_once[0], 2)
        self.assertEqual(len([pr for pr in result['pullRequests'] if pr['state'] == 'OPEN']), len(names))

    def test_open_pull_requests_come_from_each_services_repo(self):
        prs = {'acme/checkout-api': [{'number': 12, 'title': 'Retry failed orders', 'author': {'login': 'sam', 'is_bot': False}, 'isDraft': False,
                                      'reviewDecision': 'REVIEW_REQUIRED', 'createdAt': '2026-10-15T09:00:00Z',
                                      'updatedAt': '2026-10-16T10:00:00Z', 'url': 'https://github.com/acme/checkout-api/pull/12'}]}
        with tempfile.TemporaryDirectory() as home:
            result = self.run_once(home, gh=fake_gh(prs))
        self.assertEqual(result['pullRequests'], [{
            'name': 'API', 'repo': 'acme/checkout-api', 'number': 12, 'title': 'Retry failed orders',
            'author': 'sam', 'bot': False, 'draft': False, 'review': 'REVIEW_REQUIRED', 'state': 'OPEN', 'ci': None, 'createdAt': '2026-10-15T09:00:00Z',
            'updatedAt': '2026-10-16T10:00:00Z', 'closedAt': None, 'reviewers': [], 'url': 'https://github.com/acme/checkout-api/pull/12'}])

    def test_closed_and_merged_pull_requests_come_with_their_state(self):
        closed = {'acme/checkout-api': [
            {'number': 9, 'title': 'Shipped', 'author': {'login': 'kim'}, 'isDraft': False, 'reviewDecision': 'APPROVED',
             'state': 'MERGED', 'createdAt': '2026-10-10T09:00:00Z', 'updatedAt': '2026-10-17T09:00:00Z', 'url': 'u9'},
            {'number': 8, 'title': 'Dropped', 'author': {'login': 'kim'}, 'isDraft': False, 'reviewDecision': None,
             'state': 'CLOSED', 'createdAt': '2026-10-10T09:00:00Z', 'updatedAt': '2026-10-16T09:00:00Z', 'url': 'u8'}]}
        calls = []
        gh = fake_gh({}, closed)
        with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'now_iso', return_value='2026-10-19T09:00:00+00:00'):
            found = self.run_once(home, gh=lambda args: calls.append(args) or gh(args))['pullRequests']
        self.assertEqual([(pr['number'], pr['state']) for pr in found], [(9, 'MERGED'), (8, 'CLOSED')])
        # Two searches cover every repo, each fetched page by page: open ones, and those closed in the last 30 days.
        searches = sorted(next(a[2:] for a in c if a.startswith('q=')) for c in calls)
        self.assertEqual(searches, ['is:pr is:closed closed:>=2026-09-19T09:00:00+00:00 repo:acme/checkout-api', 'is:pr is:open repo:acme/checkout-api'])
        self.assertTrue(all('--paginate' not in c for c in calls))  # page by page, each its own request

    def test_ci_shows_on_merged_ones_and_reviewers_come_with_their_review(self):
        closed = {'acme/checkout-api': [
            {'number': 9, 'title': 'Shipped', 'author': {'login': 'kim'}, 'state': 'MERGED', 'ci': 'FAILURE',
             'createdAt': '2026-10-10T09:00:00Z', 'closedAt': '2026-10-17T09:00:00Z', 'url': 'u9',
             'reviews': {'lee': 'APPROVED', 'max': 'CHANGES_REQUESTED'}, 'requested': ['sam'], 'teams': ['ordering']}]}
        with tempfile.TemporaryDirectory() as home:
            [pr] = self.run_once(home, gh=fake_gh({}, closed))['pullRequests']
        self.assertEqual(pr['ci'], 'failing')
        self.assertEqual(pr['reviewers'], [{'login': 'lee', 'review': 'approved'}, {'login': 'max', 'review': 'changes'},
                                           {'login': 'sam', 'review': 'pending'}, {'login': 'ordering', 'review': 'pending', 'team': True}])
        # Approvals come from each person's last approval or change request, so a later comment doesn't hide one.
        self.assertIn('latestOpinionatedReviews', w.SEARCH)

    def test_closed_ones_are_kept_and_only_newly_closed_ones_are_asked_for(self):
        old = {'number': 5, 'title': 'Old', 'author': {'login': 'kim'}, 'state': 'MERGED', 'createdAt': '2026-09-01T09:00:00Z',
               'closedAt': '2026-09-10T09:00:00Z', 'url': 'u5'}
        kept = {'number': 7, 'title': 'Kept', 'author': {'login': 'kim'}, 'state': 'MERGED', 'createdAt': '2026-10-01T09:00:00Z',
                'closedAt': '2026-10-17T09:00:00Z', 'url': 'u7'}
        new = {**kept, 'number': 8, 'title': 'New', 'closedAt': '2026-10-19T08:00:00Z', 'url': 'u8'}
        calls = []
        with tempfile.TemporaryDirectory() as home:
            with mock.patch.object(w, 'now_iso', return_value='2026-10-18T09:00:00+00:00'):
                self.run_once(home, gh=fake_gh({}, {'acme/checkout-api': [old, kept]}))
            gh = fake_gh({}, {'acme/checkout-api': [new]})
            with mock.patch.object(w, 'now_iso', return_value='2026-10-19T09:00:00+00:00'):
                found = self.run_once(home, gh=lambda args: calls.append(args) or gh(args))['pullRequests']
        closed_search = next(a[2:] for c in calls for a in c if a.startswith('q=') and 'is:closed' in a)
        # Asked only from the day before the last refresh (search lags); the earlier one kept, the one past 30 days dropped.
        self.assertIn('closed:>=2026-10-17T00:00:00+00:00', closed_search)
        self.assertEqual([pr['number'] for pr in found], [8, 7])
        self.assertTrue(all(pr['name'] == 'API' for pr in found))

    def test_reviewers_pictures_are_kept_once_for_the_pane(self):
        open_ = {'acme/checkout-api': [{'number': 1, 'title': 'x', 'author': {'login': 'kim'}, 'createdAt': '2026-10-15T09:00:00Z',
                                        'url': 'u', 'reviews': {'lee': 'APPROVED'}}]}
        fetched = []
        with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'download', side_effect=lambda url: fetched.append(url) or (b'png', 'image/png')):
            self.run_once(home, gh=fake_gh(open_))
            self.run_once(home, gh=fake_gh(open_))
            pictures = json.loads(w.main(['avatars', '--home', home]))
        self.assertEqual(fetched, ['https://a/lee'])
        self.assertEqual(pictures, {'lee': 'data:image/png;base64,cG5n'})

    def test_pull_requests_show_under_their_repos_name(self):
        prs = {'acme/checkout-api': [{'number': 1, 'title': 'x', 'author': {'login': 'kim'}, 'createdAt': '2026-10-15T09:00:00Z', 'url': 'u'}]}
        with tempfile.TemporaryDirectory() as home:
            [pr] = self.run_once(home, gh=fake_gh(prs))['pullRequests']
        self.assertEqual(pr['name'], 'API')

    def test_bot_authors_are_marked(self):
        prs = {'acme/checkout-api': [{'number': 1, 'title': 'Bump x', 'author': {'login': 'app/dependabot', 'is_bot': True},
                                      'isDraft': False, 'reviewDecision': None, 'createdAt': '2026-10-15T09:00:00Z', 'url': 'u'}]}
        with tempfile.TemporaryDirectory() as home:
            [pr] = self.run_once(home, gh=fake_gh(prs))['pullRequests']
        self.assertTrue(pr['bot'])

    def test_every_query_failing_is_a_failed_run_with_the_reason(self):
        with tempfile.TemporaryDirectory() as home:
            result = self.run_once(home, pup=FakePup(fail='401 Unauthorized'))
        self.assertEqual(result['status'], 'failed')
        self.assertIn('401 Unauthorized', result['errors'][0])

    def test_runs_are_kept_in_sqlite_and_latest_reads_the_newest(self):
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            self.assertIsNone(w.latest(db))
            first = self.run_once(home)
            second = self.run_once(home, pup=FakePup(now=total(99)))
            self.assertEqual(w.latest(db), second)
            with contextlib.closing(sqlite3.connect(db)) as rows:
                self.assertEqual(rows.execute('SELECT COUNT(*) FROM runs').fetchone()[0], 2)
            self.assertNotEqual(first, second)


class Parts(unittest.TestCase):
    """Each section refreshes alone and keeps the other section's last result."""

    def test_refreshing_prs_keeps_the_last_watch_results(self):
        prs = {'acme/checkout-api': [{'number': 3, 'title': 'New', 'author': {'login': 'sam'}, 'isDraft': False,
                                      'reviewDecision': None, 'createdAt': '2026-10-15T09:00:00Z', 'url': 'u'}]}
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            first = w.run(CONFIG, FakePup(now=total(72)), fake_gh({}), db)
            pup = FakePup(now=total(0))
            second = w.run(CONFIG, pup, fake_gh(prs), db, parts={'pull_requests'})
        self.assertEqual(pup.calls, [])
        self.assertEqual((second['problems'], second['checkedAt']), (first['problems'], first['checkedAt']))
        self.assertEqual([pr['number'] for pr in second['pullRequests']], [3])
        self.assertIn('prsCheckedAt', second)

    def test_refreshing_watch_keeps_the_last_pull_requests(self):
        prs = {'acme/checkout-api': [{'number': 3, 'title': 'New', 'author': None, 'isDraft': True,
                                      'reviewDecision': None, 'createdAt': '2026-10-15T09:00:00Z', 'url': 'u'}]}
        calls = []
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            w.run(CONFIG, FakePup(now=total(0)), fake_gh(prs), db)
            second = w.run(CONFIG, FakePup(now=total(72)), lambda args: calls.append(args), db, parts={'watch'})
        self.assertEqual(calls, [])
        self.assertEqual(len(second['problems']), 1)
        self.assertEqual([pr['number'] for pr in second['pullRequests']], [3])

    def test_a_scheduled_run_checks_only_queries_due_now_and_keeps_the_rest(self):
        config = {**CONFIG, 'schedule': '0 9 * * *', 'repos': repos(('acme/api', 'API', 'Checkout', [
            query('Hourly', q='hourly', schedule='0 * * * *'), query('Morning', q='morning')]))}
        with tempfile.TemporaryDirectory() as home:
            with open(os.path.join(home, 'config.json'), 'w') as file:
                json.dump(config, file)
            db = os.path.join(home, 'history.db')
            w.run(config, FakePup(now=total(72)), fake_gh({}), db)  # both over their line
            pup = FakePup(now=total(0))
            at_ten = datetime.datetime(2026, 10, 19, 10, 0)
            with mock.patch.object(w, 'pup', pup), mock.patch.object(w, 'gh', fake_gh({})), \
                    mock.patch.object(w, 'scheduled_now', return_value=at_ten):
                w.main(['run', '--if-due', '--home', home])
            latest = w.latest(db)
        # At 10:00 only the hourly query is due: it ran and came back under its line; the morning one kept its problem.
        self.assertEqual([c[c.index('--query') + 1] for c in pup.calls], ['hourly'])
        self.assertEqual([p['label'] for p in latest['problems']], ['Morning'])

    def test_pull_requests_follow_their_own_schedule_when_the_config_gives_one(self):
        config = {**CONFIG, 'schedule': '0 9 * * *', 'pullRequestsSchedule': '30 * * * *'}
        self.assertEqual(w.check_config(config), [])
        parts = {}
        for hour, minute in ((9, 0), (10, 30)):
            with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'run', return_value={}) as run:
                with open(os.path.join(home, 'config.json'), 'w') as file:
                    json.dump(config, file)
                with mock.patch.object(w, 'scheduled_now', return_value=datetime.datetime(2026, 10, 19, hour, minute)):
                    w.main(['run', '--if-due', '--home', home])
            parts[f'{hour}:{minute:02}'] = run.call_args.kwargs['parts']
        self.assertEqual(parts, {'9:00': {'watch'}, '10:30': {'pull_requests'}})

    def test_the_installed_schedule_wakes_for_the_pull_requests_schedule_too(self):
        import schedule
        self.assertEqual(schedule.crons({**CONFIG, 'schedule': '0 9 * * *', 'pullRequestsSchedule': '30 * * * *'}), ['0 9 * * *', '30 * * * *'])

    def test_a_time_missed_while_asleep_runs_on_waking_and_only_once(self):
        # launchd runs a job it missed during sleep once on waking, minutes late: what fell due since the last check runs.
        last = datetime.datetime(2026, 10, 19, 9, 0, tzinfo=datetime.timezone.utc)
        local = last.astimezone().replace(tzinfo=None)
        missed = local + datetime.timedelta(minutes=5)
        config = {**CONFIG, 'schedule': f'{missed.minute} {missed.hour} * * *'}
        with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'run', wraps=w.run) as run:
            with open(os.path.join(home, 'config.json'), 'w') as file:
                json.dump(config, file)
            db = os.path.join(home, 'history.db')
            with mock.patch.object(w, 'now_iso', return_value=last.isoformat()):
                w.run(config, FakePup(), fake_gh({}), db)
            run.reset_mock()
            woke = local + datetime.timedelta(minutes=12)
            with mock.patch.object(w, 'scheduled_now', return_value=woke), mock.patch.object(w, 'pup', FakePup()), \
                    mock.patch.object(w, 'gh', fake_gh({})), mock.patch.object(w, 'now_iso', return_value=(last + datetime.timedelta(minutes=12)).isoformat()):
                w.main(['run', '--if-due', '--home', home])
                w.main(['run', '--if-due', '--home', home])  # woken again in the same minute: already done
        self.assertEqual(run.call_count, 1)

    def test_a_scheduled_run_with_nothing_due_does_nothing(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'run', return_value={}) as run:
            with open(os.path.join(home, 'config.json'), 'w') as file:
                json.dump({**CONFIG, 'schedule': '0 9 * * *'}, file)
            with mock.patch.object(w, 'scheduled_now', return_value=datetime.datetime(2026, 10, 19, 10, 0)):
                self.assertEqual(w.main(['run', '--if-due', '--home', home]), '')
        self.assertEqual(run.call_count, 0)

    def test_a_disabled_pane_is_never_checked(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'run', return_value={}) as run:
            with open(os.path.join(home, 'config.json'), 'w') as file:
                json.dump({**CONFIG, 'panes': {'pull_requests': False}}, file)
            w.main(['run', '--home', home])
            w.main(['run', 'pull_requests', '--home', home])
        self.assertEqual([c.kwargs['parts'] for c in run.call_args_list], [{'watch'}, set()])

    def test_prs_can_run_before_watch_ever_has(self):
        with tempfile.TemporaryDirectory() as home:
            result = w.run(CONFIG, FakePup(), fake_gh({}), os.path.join(home, 'history.db'), parts={'pull_requests'})
        self.assertEqual((result['checkedAt'], result['pullRequests']), (None, []))

    def test_the_cli_runs_one_part_by_name(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'run', return_value={}) as run:
            with open(os.path.join(home, 'config.json'), 'w') as file:
                json.dump(CONFIG, file)
            w.main(['run', 'pull_requests', '--home', home])
        self.assertEqual(run.call_args.kwargs['parts'], {'pull_requests'})


class Schedule(unittest.TestCase):
    def home_with(self, home, config):
        with open(os.path.join(home, 'config.json'), 'w') as file:
            json.dump(config, file)

    def test_a_paused_schedule_runs_nothing_until_resumed(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.object(w, 'run', return_value={}) as run, \
                mock.patch.object(w, 'scheduled_now', return_value=datetime.datetime(2026, 10, 19, 9, 0)):
            self.home_with(home, CONFIG)
            self.assertIsNotNone(json.loads(w.main(['schedule', 'pause', '--home', home]))['paused'])
            self.assertEqual(w.main(['run', '--if-due', '--home', home]), '')
            self.assertEqual(run.call_count, 0)
            self.assertIsNone(json.loads(w.main(['schedule', 'resume', '--home', home]))['paused'])
            w.main(['run', '--if-due', '--home', home])
            self.assertEqual(run.call_count, 1)

    def test_status_names_the_schedule_the_next_run_and_queries_with_their_own(self):
        config = {**CONFIG, 'repos': repos(('acme/api', 'API', 'Checkout', [query('Fast', schedule='*/15 * * * *'), query('Slow')]))}
        with tempfile.TemporaryDirectory() as home, \
                mock.patch.object(w, 'scheduled_now', return_value=datetime.datetime(2026, 10, 19, 10, 7)):
            self.home_with(home, config)
            state = json.loads(w.main(['schedule', 'status', '--home', home]))
        self.assertEqual(state['schedule'], '0 9 * * *')
        self.assertEqual(state['next'], '2026-10-19T10:15:00')
        self.assertEqual(state['own'], [{'entry': 'API|Checkout|Production|Fast', 'schedule': '*/15 * * * *'}])

    def runs(self, *pups, config=None, gh=None):
        sent = []
        config = config or {**CONFIG, 'notify': {'watch': True, 'pull_requests': True}}
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            for pup in pups:
                w.run(config, pup, gh or fake_gh({}), db, notify=sent.append)
        return sent

    def test_each_new_entry_is_its_own_notification_once(self):
        config = {**CONFIG, 'notify': {'watch': True}, 'repos': repos(('acme/checkout-api', 'Checkout', 'Worker', [
            query('Errors', 'Production', 1, 'worker production errors'),
            query('Errors', 'Staging', 2, 'worker staging errors')]))}
        quiet, loud = FakePup(now=total(1)), FakePup(now=total(72))
        sent = self.runs(quiet, loud, loud, config=config)
        self.assertEqual(sent, [{'title': 'Checkout: Production', 'subtitle': 'High · Worker · Errors', 'body': '72, above 20'},
                                {'title': 'Checkout: Staging', 'subtitle': 'Medium · Worker · Errors', 'body': '72, above 20'}])

    def test_a_failed_run_keeps_what_was_found_so_the_next_run_does_not_notify_it_again(self):
        config = {**CONFIG, 'notify': {'watch': True, 'pull_requests': True}, 'repos': repos(('acme/checkout-api', 'Checkout', 'Worker', [query('Errors')]))}
        red = {'acme/checkout-api': [{'number': 12, 'title': 'Retry', 'url': 'https://x/12', 'author': {'login': 'sam'}, 'ci': 'FAILURE',
                                      'createdAt': '2026-10-15T09:00:00Z', 'updatedAt': '2026-10-15T09:00:00Z'}]}
        def signed_out(args):
            raise w.SetupNeeded('pup', 'login', 'Error: 401')
        def gh_signed_out(args):
            raise w.SetupNeeded('gh', 'login', 'HTTP 401')
        with tempfile.TemporaryDirectory() as home:
            db, sent = os.path.join(home, 'history.db'), []
            w.run(config, FakePup(now=total(1)), fake_gh({}), db, notify=sent.append)          # baseline
            w.run(config, FakePup(now=total(72)), fake_gh(red), db, notify=sent.append)        # the problem and the red CI, once
            failed = w.run(config, signed_out, gh_signed_out, db, notify=sent.append)           # both tools signed out
            w.run(config, FakePup(now=total(72)), fake_gh(red), db, notify=sent.append)        # back: nothing new
        self.assertEqual([p['label'] for p in failed['problems']], ['Errors'])
        self.assertEqual([pr['number'] for pr in failed['pullRequests']], [12])
        self.assertCountEqual([n['body'] for n in sent], ['72, above 20', 'CI failing', 'Sign in to Datadog: pup auth login', 'Sign in to GitHub: gh auth login'])

    def test_two_runs_at_once_keep_both_their_parts(self):
        # A Watch check and a pull requests refresh started together each store only what they ran, over the newest row.
        prs = {'acme/checkout-api': [{'number': 7, 'title': 'New', 'url': 'https://x/7', 'author': {'login': 'sam'},
                                      'createdAt': '2026-10-15T09:00:00Z', 'updatedAt': '2026-10-15T09:00:00Z'}]}
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            w.run(CONFIG, FakePup(now=total(1)), fake_gh({}), db)
            def slow_pup(args):  # while Watch counts, the pull requests refresh finishes and stores
                if not slow_pup.done:
                    slow_pup.done = True
                    w.run(CONFIG, FakePup(), fake_gh(prs), db, parts={'pull_requests'})
                return total(72)
            slow_pup.done = False
            w.run(CONFIG, slow_pup, fake_gh({}), db, parts={'watch'})
            latest = w.latest(db)
        self.assertEqual([p['value'] for p in latest['problems']], ['72'])
        self.assertEqual([pr['number'] for pr in latest['pullRequests']], [7])

    def test_a_query_set_not_to_notify_only_shows_in_the_pane(self):
        config = {**CONFIG, 'notify': {'watch': True}, 'repos': repos(('acme/checkout-api', 'Checkout', 'Api', [
            query('Loud', q='a'), query('Quiet', q='b', notify=False)]))}
        sent = self.runs(FakePup(now=total(1)), FakePup(now=total(72)), config=config)
        self.assertEqual([n['subtitle'] for n in sent], ['High · Api · Loud'])

    def test_an_entry_turned_off_in_the_pane_stays_quiet_until_turned_back_on(self):
        config = {**CONFIG, 'notify': {'watch': True}, 'repos': repos(('acme/checkout-api', 'Checkout', 'Api', [query('Loud', q='a'), query('Quiet', q='b')]))}
        sent = []
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            state = json.loads(w.main(['notifications', 'quiet', 'Checkout|Api|Production|Quiet', '--home', home]))
            self.assertEqual(state['quiet'], ['Checkout|Api|Production|Quiet'])
            for pup in (FakePup(now=total(1)), FakePup(now=total(72))):
                w.run(config, pup, fake_gh({}), db, notify=sent.append)
            w.main(['notifications', 'loud', 'Checkout|Api|Production|Quiet', '--home', home])
            self.assertEqual(json.loads(w.main(['notifications', 'status', '--home', home]))['quiet'], [])
        self.assertEqual([n['subtitle'] for n in sent], ['High · Api · Loud'])

    def test_the_first_run_stays_quiet(self):
        self.assertEqual(self.runs(FakePup(now=total(72))), [])

    def test_a_part_left_out_of_notify_stays_quiet(self):
        config = {**CONFIG, 'notify': {'pull_requests': True}}
        self.assertEqual(self.runs(FakePup(now=total(0)), FakePup(now=total(72)), config=config), [])

    def test_ci_turning_red_on_an_open_pr_notifies(self):
        def pr(ci_state):
            return {'acme/checkout-api': [{'number': 12, 'title': 'Retry failed orders', 'author': {'login': 'sam'},
                                           'state': 'OPEN', 'createdAt': '2026-10-15T09:00:00Z', 'url': 'u',
                                           'ci': ci_state}]}
        sent = []
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            for ci_state in ('SUCCESS', 'FAILURE', 'FAILURE'):
                w.run({**CONFIG, 'notify': {'pull_requests': True}}, FakePup(), fake_gh(pr(ci_state)), db, parts={'pull_requests'}, notify=sent.append)
        self.assertEqual(sent, [{'title': 'Pull requests · API', 'subtitle': '#12 Retry failed orders', 'body': 'CI failing'}])

    def test_a_tool_that_needs_setup_notifies(self):
        def broken(args):
            raise w.SetupNeeded('pup', 'login')
        sent = self.runs(FakePup(now=total(0)), broken)
        self.assertEqual(sent, [{'title': 'on-my-watch needs you', 'subtitle': 'pup', 'body': 'Sign in to Datadog: pup auth login'}])

    NOTE = {'title': 'Watch · API', 'subtitle': 'production', 'body': 'say "hi"'}

    def sent_on(self, platform, note=NOTE, home=None):
        with tempfile.TemporaryDirectory() as fresh, mock.patch('sys.platform', platform), mock.patch('subprocess.run') as run, \
                mock.patch.object(w, 'notifier', return_value=None):
            w.desktop_notify(note, home or fresh)
        return run.call_args.args[0] if run.call_args else None

    def test_macos_sends_through_our_own_app_so_it_shows_our_icon(self):
        with tempfile.TemporaryDirectory() as home, mock.patch('sys.platform', 'darwin'), mock.patch('subprocess.run') as run, \
                mock.patch.object(w, 'notifier', return_value='/h/On my watch.app/Contents/MacOS/applet'):
            w.desktop_notify(self.NOTE, home)
        self.assertEqual(run.call_args.args[0], ['/h/On my watch.app/Contents/MacOS/applet', 'Watch · API', 'production', 'say "hi"'])

    def test_macos_falls_back_to_osascript_with_quotes_escaped(self):
        argv = self.sent_on('darwin')
        self.assertEqual(argv[:2], ['osascript', '-e'])
        self.assertIn('display notification "say \\"hi\\"" with title "Watch · API" subtitle "production"', argv[-1])

    def test_linux_uses_notify_send_with_our_icon(self):
        self.assertEqual(self.sent_on('linux'), ['notify-send', '--app-name=on-my-watch', f'--icon={w.ICON}', 'Watch · API',
                                                 'production\nsay "hi"'])

    def test_windows_shows_a_toast_with_our_icon_through_powershell(self):
        argv = self.sent_on('win32', note={**self.NOTE, 'body': "it's down"})
        self.assertEqual(argv[:3], ['powershell', '-NoProfile', '-Command'])
        self.assertIn('ToastImageAndText04', argv[-1])
        self.assertIn("it''s down", argv[-1])  # PowerShell escapes ' by doubling it
        self.assertIn(w.ICON, argv[-1])

    def test_muted_sends_nothing_until_unmuted(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(json.loads(w.main(['notifications', 'off', '--home', home])), {'muted': True, 'quiet': []})
            self.assertIsNone(self.sent_on('linux', home=home))
            self.assertEqual(json.loads(w.main(['notifications', 'on', '--home', home])), {'muted': False, 'quiet': []})
            self.assertIsNotNone(self.sent_on('linux', home=home))

    def test_a_missing_notifier_never_breaks_the_run(self):
        with tempfile.TemporaryDirectory() as home, mock.patch('sys.platform', 'linux'), mock.patch('subprocess.run', side_effect=FileNotFoundError):
            w.desktop_notify(self.NOTE, home)


class Setup(unittest.TestCase):
    """A missing or signed-out pup or gh becomes one instruction, not an error per call."""

    def run_once(self, home, pup, gh):
        return w.run(CONFIG, pup, gh, os.path.join(home, 'history.db'))

    def test_a_missing_pup_stops_the_queries_and_says_how_to_fix_it(self):
        calls = []

        def pup(args):
            calls.append(args)
            raise w.SetupNeeded('pup', 'install')
        with tempfile.TemporaryDirectory() as home:
            result = self.run_once(home, pup, fake_gh({}))
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['setup'], [{'tool': 'pup', 'need': 'install', 'fix': w.FIXES['pup']['install']}])
        self.assertEqual((result['status'], result['errors']), ('failed', []))

    def test_a_signed_out_gh_still_leaves_the_queries_running(self):
        def gh(args):
            raise w.SetupNeeded('gh', 'login')
        with tempfile.TemporaryDirectory() as home:
            result = self.run_once(home, FakePup(now=total(72)), gh)
        self.assertEqual(result['setup'], [{'tool': 'gh', 'need': 'login', 'fix': 'Sign in to GitHub: gh auth login'}])
        self.assertEqual((result['status'], len(result['problems'])), ('ok', 1))


def finished(code=0, out='', err=''):
    return subprocess.CompletedProcess([], code, out, err)


class Wrappers(unittest.TestCase):
    def test_a_missing_tool_asks_for_an_install(self):
        with mock.patch('subprocess.run', side_effect=FileNotFoundError):
            with self.assertRaises(w.SetupNeeded) as pup:
                w.pup(['logs'])
            with self.assertRaises(w.SetupNeeded) as gh:
                w.gh(['pr'])
        self.assertEqual((pup.exception.tool, pup.exception.need), ('pup', 'install'))
        self.assertEqual((gh.exception.tool, gh.exception.need), ('gh', 'install'))

    def test_an_auth_failure_asks_for_a_sign_in(self):
        with mock.patch('subprocess.run', return_value=finished(1, err='Error: 401 Unauthorized')), mock.patch('time.sleep'):
            with self.assertRaises(w.SetupNeeded) as pup:
                w.pup(['logs'])
        with mock.patch('subprocess.run', return_value=finished(1, err='To get started with GitHub CLI, please run:  gh auth login')):
            with self.assertRaises(w.SetupNeeded) as gh:
                w.gh(['pr'])
        self.assertEqual((pup.exception.need, gh.exception.need), ('login', 'login'))

    def test_a_sign_in_failure_keeps_what_the_tool_said(self):
        with mock.patch('subprocess.run', return_value=finished(1, err='Error: 401 Unauthorized: token expired at 11:30')), mock.patch('time.sleep'):
            with self.assertRaises(w.SetupNeeded) as pup:
                w.pup(['logs'])
        self.assertEqual(pup.exception.detail, 'Error: 401 Unauthorized: token expired at 11:30')

    def test_pup_tries_once_more_when_a_parallel_call_was_renewing_its_token(self):
        answers = [finished(1, err='Error: 401 Unauthorized'), finished(0, out='{"ok": true}')]
        with mock.patch('subprocess.run', side_effect=answers), mock.patch('time.sleep'):
            self.assertEqual(w.pup(['logs']), {'ok': True})

    def test_pup_waits_out_the_rate_limit_then_returns_its_json(self):
        answers = [finished(1, err='429 Too many requests, reset: 2'), finished(0, out='note\n{"ok": true}')]
        with mock.patch('subprocess.run', side_effect=answers), mock.patch('time.sleep') as sleep:
            self.assertEqual(w.pup(['logs']), {'ok': True})
        sleep.assert_called_once_with(3)

    def test_gh_tries_again_once_when_github_has_a_hiccup(self):
        answers = [finished(1, err='HTTP 502: 502 Bad Gateway'), finished(0, out='[{"number": 1}]')]
        with mock.patch('subprocess.run', side_effect=answers):
            self.assertEqual(w.gh(['pr']), [{'number': 1}])

    def test_any_other_failure_is_an_error_with_the_tools_message(self):
        with mock.patch('subprocess.run', return_value=finished(1, err='bad query syntax')):
            with self.assertRaisesRegex(RuntimeError, 'bad query syntax'):
                w.pup(['logs'])


class ConfigEdit(unittest.TestCase):
    """The Config pane saves through `config replace`: the whole config on stdin, checked first, the old file kept as .bak."""

    def saved(self, home, name='config.json'):
        with open(os.path.join(home, name)) as file:
            return json.load(file)

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home)
        with open(os.path.join(self.home, 'config.json'), 'w') as file:
            json.dump(CONFIG, file)
        patcher = mock.patch.object(w, 'reschedule')
        self.reschedule = patcher.start()
        self.addCleanup(patcher.stop)

    def replace(self, config):
        with mock.patch('sys.stdin', io.StringIO(json.dumps(config))):
            return json.loads(w.main(['config', 'replace', '--home', self.home]))

    def test_replace_saves_the_whole_config_the_pane_sends_and_keeps_the_old_file(self):
        self.replace({**CONFIG, 'window': '4h', 'site': 'datadoghq.eu'})
        self.assertEqual((self.saved(self.home)['window'], self.saved(self.home)['site']), ('4h', 'datadoghq.eu'))
        self.assertEqual(self.saved(self.home, 'config.json.bak')['window'], '1h')
        self.reschedule.assert_not_called()

    def test_replace_refuses_a_config_with_a_wrong_cron_line_and_saves_nothing(self):
        with self.assertRaises(SystemExit) as refused:
            self.replace({**CONFIG, 'schedule': '0 9-18 * *'})
        self.assertIn("config.schedule: '0 9-18 * *' is not a schedule", str(refused.exception))
        self.assertEqual(self.saved(self.home), CONFIG)

    def test_a_config_the_schema_refuses_saves_nothing_and_says_why(self):
        broken = {**CONFIG, 'repos': repos(('acme/checkout-api', 'API', 'Checkout', [query(priority=0)]))}
        with self.assertRaises(SystemExit) as refused:
            self.replace(broken)
        self.assertIn('priority', str(refused.exception))
        self.assertEqual(self.saved(self.home), CONFIG)

    def test_replace_updates_the_installed_schedule_when_a_schedule_changed(self):
        self.replace({**CONFIG, 'schedule': '0 8 * * 1-5'})
        self.reschedule.assert_called_once()



class History(unittest.TestCase):
    def test_each_watch_run_keeps_the_window_it_checked(self):
        with tempfile.TemporaryDirectory() as home:
            result = w.run(CONFIG, FakePup(now=total(72)), fake_gh({}), os.path.join(home, 'history.db'))
        start, end = (datetime.datetime.fromisoformat(result['span'][k]) for k in ('from', 'to'))
        self.assertEqual(end - start, datetime.timedelta(hours=1))
        self.assertIn(f"from_ts={int(start.timestamp() * 1000)}", result['problems'][0]['link'])

    def test_history_lists_watch_runs_newest_first_and_show_opens_one(self):
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            w.run(CONFIG, FakePup(now=total(72)), fake_gh({}), db)
            w.run(CONFIG, FakePup(), fake_gh({}), db, parts={'pull_requests'})  # a PR refresh is not a new watch run
            later = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=1)).isoformat(timespec='seconds')
            with mock.patch.object(w, 'now_iso', return_value=later):
                w.run(CONFIG, FakePup(now=total(0)), fake_gh({}), db, parts={'watch'})
            runs = json.loads(w.main(['history', '--home', home]))
            self.assertEqual([r['problems'] for r in runs], [0, 1])
            self.assertEqual(set(runs[0]), {'id', 'checkedAt', 'status', 'reason', 'problems', 'labels', 'span'})
            shown = json.loads(w.main(['show', str(runs[1]['id']), '--home', home]))
        self.assertEqual(len(shown['problems']), 1)

    def test_a_run_counts_its_problems_per_label_most_urgent_first(self):
        config = {**CONFIG, 'repos': repos(
            ('acme/api', 'API', 'Checkout', [query('Warnings', priority=3, q='w'), query('Errors', priority=1, q='e')]),
            ('acme/search', 'Search', 'Main', [query('Errors', priority=1, q='e2')]),
            ('acme/queue', 'Queue', 'Main', [query('Errors', priority=1, q='e3')]))}
        with tempfile.TemporaryDirectory() as home:
            w.run(config, FakePup(now=total(50)), fake_gh({}), os.path.join(home, 'history.db'))
            [run] = w.history(os.path.join(home, 'history.db'))
        self.assertEqual(run['problems'], 4)
        self.assertEqual(run['labels'], [{'label': 'Errors', 'count': 3, 'priority': 1, 'priorityName': 'High'},
                                         {'label': 'Warnings', 'count': 1, 'priority': 3, 'priorityName': 'Low'}])

    def test_a_failed_run_says_why_in_history_and_the_run_log(self):
        def signed_out(args):
            raise w.SetupNeeded('pup', 'login', 'Error: 401 Unauthorized')
        with tempfile.TemporaryDirectory() as home:
            with open(os.path.join(home, 'config.json'), 'w') as file:
                json.dump(CONFIG, file)
            with mock.patch.object(w, 'pup', signed_out), mock.patch.object(w, 'gh', fake_gh({})):
                line = w.main(['run', 'watch', '--home', home])
            [run] = w.history(os.path.join(home, 'history.db'))
        reason = 'Sign in to Datadog: pup auth login (Error: 401 Unauthorized)'
        self.assertEqual((run['status'], run['reason']), ('failed', reason))
        self.assertTrue(line.endswith(f'· {reason}'), line)

    def test_only_the_newest_run_keeps_the_pull_requests_so_history_stays_small(self):
        prs = {'acme/checkout-api': [{'number': 7, 'title': 'New', 'url': 'https://x/7', 'author': {'login': 'sam'},
                                      'createdAt': '2026-10-15T09:00:00Z', 'updatedAt': '2026-10-15T09:00:00Z'}]}
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            w.run(CONFIG, FakePup(now=total(72)), fake_gh(prs), db)
            w.run(CONFIG, FakePup(now=total(72)), fake_gh(prs), db)
            with contextlib.closing(sqlite3.connect(db)) as rows:  # Windows can't delete an open file
                [newest, older] = [json.loads(r) for (r,) in rows.execute('SELECT result FROM runs ORDER BY id DESC')]
        self.assertEqual([pr['number'] for pr in newest['pullRequests']], [7])
        self.assertNotIn('pullRequests', older)
        self.assertEqual(len(older['problems']), 1)  # History and an opened old run still have Watch's part

    def test_runs_older_than_the_kept_days_are_deleted(self):
        with tempfile.TemporaryDirectory() as home:
            db = os.path.join(home, 'history.db')
            with mock.patch.object(w, 'now_iso', return_value='2026-09-01T09:00:00+00:00'):
                w.run(CONFIG, FakePup(now=total(0)), fake_gh({}), db)
            with mock.patch.object(w, 'now_iso', return_value='2026-09-25T09:00:00+00:00'):
                w.run(CONFIG, FakePup(now=total(0)), fake_gh({}), db)
            with mock.patch.object(w, 'now_iso', return_value='2026-10-19T09:00:00+00:00'):
                w.run({**CONFIG, 'historyDays': 30}, FakePup(now=total(0)), fake_gh({}), db)
            # 30 days by default: the run from 1 September goes, the one from 25 September stays.
            self.assertEqual([r['checkedAt'][:10] for r in w.history(db)], ['2026-10-19', '2026-09-25'])


class Cli(unittest.TestCase):
    def test_latest_prints_an_empty_object_before_the_first_run(self):
        with tempfile.TemporaryDirectory() as home:
            out = w.main(['latest', '--home', home])
        self.assertEqual(json.loads(out), {})

    def test_a_window_can_be_minutes_hours_or_days(self):
        self.assertEqual(w.window_args('15m'), ['--from', '15m', '--to', 'now'])
        self.assertEqual(w.seconds('7d'), 7 * 86400)

    def test_a_bad_window_stops_the_run_before_any_query(self):
        with tempfile.TemporaryDirectory() as home:
            with open(os.path.join(home, 'config.json'), 'w') as file:
                json.dump(CONFIG, file)
            with self.assertRaises(ValueError):
                w.main(['run', 'watch', '--home', home, '--window', '4 hours'])


if __name__ == '__main__':
    unittest.main()
