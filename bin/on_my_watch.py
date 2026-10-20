#!/usr/bin/env python3
"""Runs your saved Datadog queries through pup and lists open pull requests through gh. No AI calls.

on_my_watch.py run [watch|pull_requests]   runs every query (or one part) and stores the result in ~/.on-my-watch/history.db
on_my_watch.py latest   prints the newest stored result as JSON ({} before the first run)
"""
import argparse
import base64
import concurrent.futures
import contextlib
import datetime
import functools
import json
import os
import plistlib
import shutil
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HOME = os.path.expanduser('~/.on-my-watch')
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REDUCERS = {
    'avg': lambda v: sum(v) / len(v),
    'sum': sum,
    'max': max,
    'min': min,
    'last': lambda v: v[-1],
}
# Every PR a search finds, page by page. 50 a page: at 100, GitHub's answer timed out (HTTP 502) across 14 repos.
# 100 is the most GitHub allows for reviews and review requests on one PR.
SEARCH = '''query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url state isDraft createdAt updatedAt closedAt reviewDecision
      repository { nameWithOwner }
      author { login __typename }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      latestOpinionatedReviews(first: 100) { nodes { state author { login avatarUrl(size: 48) } } }
      reviewRequests(first: 100) { nodes { requestedReviewer {
        ... on User { login avatarUrl(size: 48) } ... on Team { slug avatarUrl(size: 48) } } } }
    } }
  }
}'''
# Repositories per GitHub search: 28 repositories make 4 searches of open PRs and 4 of closed, all at once.
REPOS_PER_SEARCH = 7
# Closed PRs come from this many days back: the pane's longest span, Last month.
CLOSED_DAYS = 30
ROLLUP = {'SUCCESS': 'passing', 'FAILURE': 'failing', 'ERROR': 'failing', 'PENDING': 'running', 'EXPECTED': 'running'}
REVIEWS = {'APPROVED': 'approved', 'CHANGES_REQUESTED': 'changes'}
FAILED = {'FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'}
# The tools are the user's to install and sign in to; a run only says how.
FIXES = {
    'pup': {'install': 'Install pup, the Datadog CLI, and put it on your PATH', 'login': 'Sign in to Datadog: pup auth login'},
    'gh': {'install': 'Install gh, the GitHub CLI: https://cli.github.com', 'login': 'Sign in to GitHub: gh auth login'},
}
SIGNED_OUT = re.compile(r'\b40[13]\b|unauthori[sz]ed|auth login|not logged in|expired', re.I)


class SetupNeeded(Exception):
    """pup or gh is missing (need 'install') or signed out (need 'login')."""

    def __init__(self, tool, need, detail=''):
        super().__init__(FIXES[tool][need])
        self.tool, self.need, self.detail = tool, need, detail  # detail: what the tool itself said, kept for History


def call(tool, args, timeout):
    try:
        done = subprocess.run([tool, *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise SetupNeeded(tool, 'install') from None
    if done.returncode != 0 and SIGNED_OUT.search(done.stdout + done.stderr):
        raise SetupNeeded(tool, 'login', (done.stdout + done.stderr).strip()[-400:])
    return done


def pup(args):
    """Runs pup and returns its JSON, waiting out Datadog's rate limit up to three times."""
    for attempt in range(4):
        try:
            done = call('pup', ['--no-agent', *args], 120)
        except SetupNeeded as needed:
            if needed.need != 'login':
                raise
            # Parallel calls race to renew pup's hourly token; the ones that lose see 401 while it renews.
            time.sleep(2)
            done = call('pup', ['--no-agent', *args], 120)
        out = done.stdout + done.stderr
        if done.returncode != 0 and 'Too many requests' in out and attempt < 3:
            reset = re.search(r'reset: (\d+)', out)
            time.sleep(min(int(reset.group(1)) + 1, 30) if reset else 10)
            continue
        if done.returncode != 0:
            raise RuntimeError(out.strip()[-400:])
        return json.loads(done.stdout[done.stdout.index('{'):])
    raise RuntimeError('rate limited')


def gh(args):
    done = call('gh', args, 60)
    if done.returncode != 0 and re.search(r'\b50[234]\b|unexpected end of JSON', done.stderr):
        done = call('gh', args, 60)  # GitHub drops heavy queries now and then; once more usually works
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip()[-400:])
    return json.loads(done.stdout or '[]')


UNITS = {'m': 60, 'h': 3600, 'd': 86400}


def seconds(window):
    """A window such as 1m, 4h or 7d, in seconds."""
    if len(window) < 2 or window[-1] not in UNITS or not window[:-1].isdigit():
        raise ValueError(f'window must be a number then m, h or d, such as 4h: {window!r}')
    return int(window[:-1]) * UNITS[window[-1]]


def window_args(window):
    """pup's --from/--to for the window ending now."""
    return ['--from', window, '--to', 'now']


def reduce(values, how='avg'):
    values = [v for v in values if v is not None]
    return REDUCERS[how](values) if values else 0


def count_of(attrs):
    return float((attrs.get('compute') or attrs.get('computes') or {}).get('c0') or 0)


def rows(response):
    data = response.get('data')
    return (data.get('buckets') if isinstance(data, dict) else data) or []


def aggregate(source, query, compute, span, group=None, limit=None):
    """pup's logs or traces aggregate for one query; grouped by a field when group is given."""
    command = ['logs', 'aggregate', '--storage', 'indexes'] if source == 'logs' else ['traces', 'aggregate']
    grouping = ['--group-by', group] if group else []
    # pup's traces aggregate takes no --limit.
    limited = ['--limit', str(limit)] if limit and source == 'logs' else []
    return [*command, '--query', query, '--compute', compute, *grouping, *limited, *span]


def measure(query, run_pup, window='1h'):
    """The query's value over the window: one number, the query run exactly as written."""
    span = window_args(window)
    if query['source'] == 'metrics':
        response = run_pup(['metrics', 'query', '--query', query['query'], *span])
        return reduce([p[1] for s in response.get('series') or [] for p in s.get('pointlist') or []], query.get('reduce', 'avg'))
    response = run_pup(aggregate(query['source'], query['query'], query.get('compute', 'count'), span))
    return sum(count_of(row.get('attributes', row)) for row in rows(response))


SLOT = '\x00service\x00'
ENV_SLOT = '\x00env\x00'
NAMED = re.compile(r'(?<!\S)service:([^\s()"]+)(?!\S)')
ENV = re.compile(r'(?<!\S)env:([^\s()"]+)(?!\S)')
TRACE_GROUPS = 10  # what pup's traces aggregate returned at most when tried
# Datadog's own limit: 10 log aggregate calls each 10 seconds.
AT_ONCE = 10


def shape(query):
    """Queries that differ only in the one `service:<name>` they name, and for logs the one `env:<name>`, can be counted
    in one call grouped by those fields: (key shared by them, this query's (service, env)). env is None when it
    stays in the query: traces group by one field only. None for a metric, or a query naming no single service."""
    if query['source'] == 'metrics':
        return None
    services = NAMED.findall(query['query'])
    if len(services) != 1:
        return None
    template = NAMED.sub(f'service:{SLOT}', query['query'])
    envs = ENV.findall(query['query']) if query['source'] == 'logs' else []
    env = envs[0] if len(envs) == 1 else None
    if env:
        template = ENV.sub(f'env:{ENV_SLOT}', template)
    return (query['source'], template, query.get('compute', 'count')), (services[0], env)


def measure_together(shared, members, run_pup, window):
    """A query many services (and envs) share, counted for all of them at once: {(service, env): number}. Datadog allows
    few aggregate calls a second (10 per 10s for logs, 5 a minute for traces), so one call per query soon waits on it."""
    source, template, compute = shared
    span = window_args(window)
    services = sorted({service for service, _ in members})
    envs = sorted({env for _, env in members if env})
    any_of = lambda names: '(' + ' OR '.join(f'"{name}"' for name in names) + ')'
    group = 'service,env' if envs else 'service'
    # Traces return at most TRACE_GROUPS groups a call; logs take a limit as large as needed.
    size = TRACE_GROUPS if source == 'traces' else len(services)
    values = {member: 0.0 for member in members}
    for start in range(0, len(services), size):
        batch = services[start:start + size]
        query = template.replace(SLOT, any_of(batch)).replace(ENV_SLOT, any_of(envs))
        for row in rows(run_pup(aggregate(source, query, compute, span, group, max(len(batch), len(envs), 10)))):
            attrs = row.get('attributes', row)
            by = attrs.get('by') or {}
            member = (by.get('service'), by.get('env') if envs else None)
            if member in values:
                values[member] += count_of(attrs)
    return values


def alerts(rule, now):
    """True when every condition the rule sets holds; a rule with none never alerts."""
    checks = []
    if 'above' in rule:
        checks.append(now > rule['above'])
    if 'below' in rule:
        checks.append(now < rule['below'])
    return bool(checks) and all(checks)


def display(query, value):
    if query['source'] == 'traces' and '@duration' in query.get('compute', ''):
        return f'{value / 1e9:.2f}s'  # span durations are in nanoseconds
    return str(int(value)) if float(value).is_integer() else f'{value:.2f}'


def describe(query):
    """The alert line in words, as the entry shows it: `above 5`."""
    rule, parts = query.get('alert', {}), []
    if 'above' in rule:
        parts.append(f"above {display(query, rule['above'])}")
    if 'below' in rule:
        parts.append(f"below {display(query, rule['below'])}")
    return ', '.join(parts)


def link(site, query, span_ms):
    """The query in Datadog, pinned to the window the run checked."""
    app = f'https://app.{site}'
    pinned = f'&from_ts={span_ms[0]}&to_ts={span_ms[1]}&live=false'
    if query['source'] == 'metrics':
        # shortcut: opens the metric explorer on the query; check the parameter if Datadog changes it
        return f"{app}/metric/explorer?exp_query={urllib.parse.quote(query['query'])}{pinned}"
    path = 'logs' if query['source'] == 'logs' else 'apm/traces'
    return f"{app}/{path}?query={urllib.parse.quote(query['query'])}{pinned}"


SCHEMA = os.path.join(PLUGIN, 'config.schema.json')


def check_config(config, schema=None):
    """Where the config breaks config.schema.json, one line each such as `repos.a/b.services.Api.queries[0].priority:
    must be at least 1`; empty when it holds. The checker runs nothing on a config that breaks it."""
    if schema is None:
        with open(SCHEMA) as file:
            schema = json.load(file)
    defs, found = schema.get('$defs', {}), []
    types = {'object': dict, 'array': list, 'string': str, 'boolean': bool}

    def walk(value, rule, path):
        if '$ref' in rule:
            rule = defs[rule['$ref'].rsplit('/', 1)[-1]]
        kind = rule.get('type')
        number = isinstance(value, (int, float)) and not isinstance(value, bool)
        ok = (not kind or (kind == 'integer' and number and float(value).is_integer())
              or (kind == 'number' and number) or (kind in types and isinstance(value, types[kind])))
        if not ok:
            return found.append(f'{path}: must be {"an" if kind in ("object", "array", "integer") else "a"} {kind}')
        if 'enum' in rule and value not in rule['enum']:
            return found.append(f"{path}: must be one of {', '.join(map(str, rule['enum']))}")
        if isinstance(value, str):
            if len(value) < rule.get('minLength', 0):
                found.append(f'{path}: must not be empty')
            elif 'pattern' in rule and not re.search(rule['pattern'], value):
                found.append(f"{path}: {rule.get('description', 'is not valid')} Got {value!r}")
        if number and 'minimum' in rule and value < rule['minimum']:
            found.append(f"{path}: must be at least {rule['minimum']}")
        if number and 'exclusiveMinimum' in rule and value <= rule['exclusiveMinimum']:
            found.append(f"{path}: must be more than {rule['exclusiveMinimum']}")
        if isinstance(value, dict):
            for key in rule.get('required', []):
                if key not in value:
                    found.append(f'{path}: {key} is missing')
            if len(value) < rule.get('minProperties', 0):
                found.append(f'{path}: must not be empty')
            props, patterns, extra = rule.get('properties', {}), rule.get('patternProperties', {}), rule.get('additionalProperties', True)
            for key, item in value.items():
                at = f'{path}.{key}'
                match = next((sub for pattern, sub in patterns.items() if re.search(pattern, key)), None)
                if key in props:
                    walk(item, props[key], at)
                elif match is not None:
                    walk(item, match, at)
                elif extra is False:
                    found.append(f'{at}: must be a GitHub owner/name' if patterns else f'{at}: is not a known field')
                elif isinstance(extra, dict):
                    walk(item, extra, at)
        if isinstance(value, list):
            if len(value) < rule.get('minItems', 0):
                found.append(f'{path}: must not be empty')
            for index, item in enumerate(value):
                walk(item, rule.get('items', {}), f'{path}[{index}]')

    walk(config, schema, 'config')
    # Beyond what JSON Schema says: a query's priority 1, 2 or 3; a repository listed once, and within it a service, env
    # and label together once.
    repos = config.get('repos') if isinstance(config.get('repos'), list) else []
    for index, repo in enumerate(repos):
        for at, query in enumerate(repo.get('queries') or [] if isinstance(repo, dict) else []):
            if not isinstance(query, dict) or 'priority' not in query:
                continue
            given, where = query['priority'], f'config.repos[{index}].queries[{at}].priority'
            number = isinstance(given, int) and not isinstance(given, bool)
            if number and not 1 <= given <= len(PRIORITY_NAMES):
                found.append(f'{where}: must be 1 (High), 2 (Medium) or 3 (Low)')
    for index, repo in enumerate(repos):
        if not isinstance(repo, dict):
            continue
        if repo.get('repo') in [other.get('repo') for other in repos[:index] if isinstance(other, dict)]:
            found.append(f"config.repos[{index}].repo: {repo['repo']} is listed already")
        entries = [(q.get('service'), q.get('env'), q.get('label')) for q in repo.get('queries') or [] if isinstance(q, dict)]
        for at, entry in enumerate(entries):
            if entry in entries[:at]:
                found.append(f"config.repos[{index}].queries[{at}]: {' / '.join(map(str, entry))} is listed already in this repository")
    return found


PRIORITY_NAMES = ['High', 'Medium', 'Low']  # priority 1, 2 and 3, the most urgent first


def urgency(config, priority):
    """A query's priority as (rank, name): rank 1, High, is the most urgent."""
    return priority, PRIORITY_NAMES[priority - 1] if 1 <= priority <= len(PRIORITY_NAMES) else f'P{priority}'


def queries_of(config):
    """Every query with where it sits: (repo, the repo's name, service, query)."""
    return [(repo['repo'], repo['name'], query['service'], query) for repo in config['repos'] for query in repo['queries']]




def ci(rollup):
    """The last commit's checks as one state: passing, failing or running; None when it has no checks."""
    return ROLLUP.get((rollup or {}).get('state'))


def pull_requests(services, run_gh, setup, avatars, closed_since):
    """Open PRs on every service's repo, and those closed since closed_since: two searches, each read page by page,
    so nothing is cut off at a count. Reviewers come with their review; their pictures' addresses go into avatars."""
    repos = {repo['repo']: repo['name'] for repo in services if not repo.get('watch_only')}
    if not repos:
        return [], []
    # GitHub's search takes about 8 s a call whatever it finds, and a search's pages come one after another: small groups
    # of repos, all searched at once, finish in about the time of one call.
    names = list(repos)
    scopes = [' '.join(f'repo:{repo}' for repo in names[at:at + REPOS_PER_SEARCH]) for at in range(0, len(names), REPOS_PER_SEARCH)]
    found, errors = [], []
    searches = [f'is:pr is:open {scope}' for scope in scopes] + [f'is:pr is:closed closed:>={closed_since} {scope}' for scope in scopes]

    def search(q):
        """Every page of one search, a request each: one command for all pages ran past gh's time limit."""
        pages, cursor = [], None
        try:
            while True:
                page = run_gh(['api', 'graphql', '-F', f'q={q}', *(['-F', f'endCursor={cursor}'] if cursor else []),
                               '-f', f'query={SEARCH}'])
                pages.append(page)
                info = page['data']['search']['pageInfo']
                if not info['hasNextPage']:
                    return pages
                cursor = info['endCursor']
        except Exception as error:
            return error

    with concurrent.futures.ThreadPoolExecutor(len(searches)) as pool:
        answers = list(pool.map(search, searches))
    for q, pages in zip(searches, answers):
        if isinstance(pages, SetupNeeded):
            setup.append(pages)
            break
        if isinstance(pages, Exception):
            error = f"pull requests ({q.split()[1][3:]}): {pages}"
            if error not in errors:
                errors.append(error)
            continue
        for pr in (pr for page in pages for pr in page['data']['search']['nodes'] if pr):
            repo = pr['repository']['nameWithOwner']
            if repo not in repos:
                continue
            reviewers = []
            # Each person's last approval or request for changes: a comment after an approval doesn't undo it.
            for review in pr['latestOpinionatedReviews']['nodes']:
                if review['state'] in REVIEWS and review.get('author'):
                    reviewers.append({'login': review['author']['login'], 'review': REVIEWS[review['state']]})
                    avatars[review['author']['login']] = review['author']['avatarUrl']
            # Still asked: people by login, teams by their slug.
            for request in pr['reviewRequests']['nodes']:
                who = request.get('requestedReviewer') or {}
                name = who.get('login') or who.get('slug')
                if name:
                    reviewers.append({'login': name, 'review': 'pending', **({'team': True} if who.get('slug') else {})})
                    if who.get('avatarUrl'):
                        avatars[name] = who['avatarUrl']
            commits = pr['commits']['nodes']
            author = pr.get('author') or {}
            found.append({'name': repos[repo], 'repo': repo, 'number': pr['number'],
                          'title': pr['title'], 'author': author.get('login'), 'bot': author.get('__typename') == 'Bot',
                          'draft': pr['isDraft'], 'review': pr.get('reviewDecision'), 'state': pr['state'],
                          'ci': ci(commits[0]['commit']['statusCheckRollup']) if commits else None,
                          'createdAt': pr['createdAt'], 'updatedAt': pr['updatedAt'], 'closedAt': pr.get('closedAt'),
                          'reviewers': reviewers, 'url': pr['url']})
    return sorted(found, key=lambda pr: pr['closedAt'] or pr['updatedAt'], reverse=True), errors


def watch(config, run_pup, before=None, due=None):
    """The observability part: every query of every entry, run as written, against its alert line."""
    window = config.get('window', '1h')
    end_ms = int(time.time()) * 1000  # whole seconds, so the stored span and the links' from_ts/to_ts agree
    span_ms = (end_ms - seconds(window) * 1000, end_ms)
    problems, errors, attempted, setup = [], [], 0, []
    # A scheduled run checks the queries due now; the others keep what they found last time.
    everything = queries_of(config)
    entries = [entry for entry in everything if not due or due(entry[3])]
    resting = {(repo, service, query['env'], query['label']) for repo, _, service, query in everything if (repo, _, service, query) not in entries}

    sharing = {}
    for *_, query in entries:
        if shape(query):
            key, member = shape(query)
            sharing.setdefault(key, set()).add(member)

    # Every count the run needs, asked for at once: one call per shared query, one per query on its own.
    wanted = {}
    for *_, query in entries:
        found = shape(query)
        if found and len(sharing[found[0]]) >= 2:
            key = found[0]
            wanted[key] = lambda key=key: measure_together(key, sharing[key], run_pup, window)
        else:
            wanted[id(query)] = lambda query=query: measure(query, run_pup, window)

    def fetch(job):
        try:
            return job()
        except Exception as error:  # every query sharing the call fails alike, without calling again
            return error
    with concurrent.futures.ThreadPoolExecutor(AT_ONCE) as pool:
        counted = dict(zip(wanted, pool.map(fetch, wanted.values())))

    def count(query):
        found = shape(query)
        shared = found and len(sharing[found[0]]) >= 2
        answer = counted[found[0] if shared else id(query)]
        if isinstance(answer, Exception):
            raise answer
        return answer[found[1]] if shared else answer

    for repo, name, service, query in entries:
        if setup:  # pup can't run; every other query would fail the same way
            break
        attempted += 1
        rule = query['alert']
        try:
            now = count(query)
        except SetupNeeded as needed:
            setup.append(needed)
            break
        except Exception as error:  # one query failing still leaves the others' results
            errors.append(f"{name} › {service} / {query['label']}: {error}")
            continue
        if alerts(rule, now):
            rank, shown = urgency(config, query['priority'])
            problems.append({'name': name, 'repo': repo, 'service': service, 'env': query['env'], 'label': query['label'],
                             'priority': rank, 'priorityName': shown, 'source': query['source'], 'value': display(query, now),
                             'alert': describe(query), 'link': link(config['site'], query, span_ms), 'query': query['query'],
                             # false keeps the entry in the pane only; left out, it notifies
                             'notify': query.get('notify', True) is not False})

    problems += [p for p in (before or {}).get('problems', [])
                 if (p.get('repo'), p.get('service'), p['env'], p['label']) in resting]
    if setup:  # pup couldn't run: keep what the last run found, or the next good run would notify it all again
        problems = list((before or {}).get('problems', []))
    # Most urgent first.
    problems.sort(key=lambda p: (p['priority'], p['name'], p['env'], p['service'], p['label']))
    return {
        'checkedAt': now_iso(),
        'window': window,
        # The exact window counted; every link of this run is pinned to it, so history opens on the same data.
        'span': {'from': iso_ms(span_ms[0]), 'to': iso_ms(span_ms[1])},
        'status': 'failed' if setup or (attempted and len(errors) >= attempted) else 'ok',
        'errors': errors,
        'problems': problems,
    }, setup


def pull_requests_part(config, run_gh, before=None, due=None):
    """The pull request part: open and recently closed PRs on every service's repo, and where reviewers' pictures are.
    A closed PR rarely changes, so the last refresh's are kept and only those closed since then are asked for."""
    setup, avatars = [], {}
    stamp = datetime.datetime.fromisoformat(now_iso())
    cutoff = stamp - datetime.timedelta(days=CLOSED_DAYS)
    when = lambda iso: datetime.datetime.fromisoformat(iso.replace('Z', '+00:00'))
    last = (before or {}).get('closedThrough')
    # GitHub's search index lags: ask again from the start of the day before the last refresh, so a late one still comes.
    since = max(cutoff, when(last).replace(hour=0, minute=0, second=0) - datetime.timedelta(days=1)) if last else cutoff
    repos = {repo['repo'] for repo in config['repos'] if not repo.get('watch_only')}
    kept = [pr for pr in (before or {}).get('pullRequests') or []
            if pr.get('state', 'OPEN') != 'OPEN' and pr.get('closedAt') and when(pr['closedAt']) >= cutoff and pr['repo'] in repos]
    found, errors = pull_requests(config['repos'], run_gh, setup, avatars, since.isoformat(timespec='seconds'))
    if setup:  # gh couldn't run: keep the last pull requests, or every red CI would notify again on the next good run
        return {'prsCheckedAt': (before or {}).get('prsCheckedAt'), 'closedThrough': last, 'pullRequests': (before or {}).get('pullRequests') or [],
                'prErrors': errors, 'avatarUrls': {}}, setup
    fresh = {(pr['repo'], pr['number']) for pr in found}
    # Kept ones take today's repo name; those stored before names existed carried service and alias instead.
    names = {repo['repo']: repo['name'] for repo in config['repos']}
    found += [{**{k: v for k, v in pr.items() if k not in ('service', 'alias')}, 'name': names[pr['repo']]}
              for pr in kept if (pr['repo'], pr['number']) not in fresh]
    found.sort(key=lambda pr: pr.get('closedAt') or pr['updatedAt'], reverse=True)
    # The next refresh asks for closed ones from here; after a failed search, from the last good one so none is skipped.
    closed_failed = any(error.startswith('pull requests (closed)') for error in errors) or setup
    return {'prsCheckedAt': now_iso(), 'closedThrough': last if closed_failed else stamp.isoformat(timespec='seconds'),
            'pullRequests': found, 'prErrors': errors, 'avatarUrls': avatars}, setup


PARTS = {'watch': ('pup', watch), 'pull_requests': ('gh', pull_requests_part)}
EMPTY = {'checkedAt': None, 'window': None, 'status': 'ok', 'errors': [], 'problems': [],
         'prsCheckedAt': None, 'pullRequests': [], 'prErrors': [], 'setup': []}


def iso_ms(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat(timespec='seconds')


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def run(config, run_pup, run_gh, db_path, parts=frozenset(PARTS), notify=None, due=None):
    """Runs the given parts and stores them over the last result, so a part left out keeps its last values."""
    before = latest(db_path)
    broken = check_config(config)
    if broken:  # nothing runs on a config that breaks the schema; the panes say where
        updates = {'status': 'failed', 'errors': broken, 'prErrors': broken, 'checkedAt': now_iso()}
        return store(db_path, updates, config.get('historyDays', 30) if isinstance(config.get('historyDays'), int) else 30)
    tools, updates, needs = {'pup': run_pup, 'gh': run_gh}, {}, []
    for part in parts:
        tool, check = PARTS[part]
        fields, setup = check(config, tools[tool], before, due)
        updates.update(fields)
        needs += [{'tool': n.tool, 'need': n.need, 'fix': str(n), **({'detail': n.detail} if n.detail else {})} for n in setup]
    result = store(db_path, updates, config.get('historyDays', 30), {PARTS[part][0] for part in parts}, needs)
    if 'pull_requests' in parts:
        keep_avatars(db_path, result.get('avatarUrls') or {})
    for note in critical(config, before, result, parts, quiet_entries(os.path.dirname(db_path))):
        if notify:
            notify(note)
        else:
            desktop_notify(note, os.path.dirname(db_path))
    return result


def entry_key(problem):
    """An entry as the pane names it to turn its notifications off: repo name|service|env|label."""
    return f"{problem.get('name')}|{problem.get('service')}|{problem['env']}|{problem['label']}"


def quiet_entries(home):
    """Entries whose notifications are turned off from the pane."""
    try:
        with open(os.path.join(home, 'quiet.json')) as file:
            return set(json.load(file))
    except (FileNotFoundError, ValueError):
        return set()


def critical(config, before, after, parts, quiet=frozenset()):
    """What turned critical since the last run, one notification each: {title, subtitle, body}. The first run only
    sets the baseline."""
    wanted = config.get('notify', {})
    if not before or not any(wanted.get(part) for part in parts):
        return []
    notes = []
    known = {s['fix'] for s in before.get('setup', [])}
    for s in after['setup']:
        if s['fix'] not in known:
            notes.append({'title': 'on-my-watch needs you', 'subtitle': s['tool'], 'body': s['fix']})
    key = lambda p: (p.get('name'), p.get('service'), p['env'], p['label'])
    if 'watch' in parts and wanted.get('watch') and before.get('checkedAt'):
        seen = {key(p) for p in before.get('problems', [])}
        for p in after['problems']:
            if key(p) not in seen and p.get('notify', True) and entry_key(p) not in quiet:
                notes.append({'title': f"{p['name']}: {p['env']}",
                              'subtitle': f"{p.get('priorityName') or 'P' + str(p['priority'])} · {p['service']} · {p['label']}",
                              'body': f"{p['value']}, {p['alert']}" if p['alert'] else p['value']})
    if 'pull_requests' in parts and wanted.get('pull_requests') and before.get('prsCheckedAt'):
        was = {(p['repo'], p['number']): p.get('ci') for p in before.get('pullRequests', [])}
        for p in after['pullRequests']:
            if p['state'] == 'OPEN' and p.get('ci') == 'failing' and was.get((p['repo'], p['number'])) != 'failing':
                notes.append({'title': f"Pull requests · {p['name']}",
                              'subtitle': f"#{p['number']} {p['title']}", 'body': 'CI failing'})
    return notes


ICON = os.path.join(PLUGIN, 'assets', 'icon.png')
ICNS = os.path.join(PLUGIN, 'assets', 'icon.icns')
NOTIFIER = 'On my watch.app'
# The macOS sender: a tiny app of our own, so notifications carry our icon and name rather than Script Editor's.
# Opened with no text, as macOS does when a notification is clicked, it does nothing rather than fail.
NOTIFIER_SCRIPT = """on run argv
  try
    set {heading, subheading, message} to {item 1 of argv, item 2 of argv, item 3 of argv}
  on error
    return
  end try
  display notification message with title heading subtitle subheading
end run"""


def notifier(home):
    """Builds the macOS sender app in home once; None when it can't be built (osascript then sends them plainly)."""
    app = os.path.join(home, NOTIFIER)
    applet = os.path.join(app, 'Contents', 'MacOS', 'applet')
    # Built from this exact script; a changed script rebuilds it.
    built = os.path.join(app, 'Contents', 'Resources', 'on-my-watch.applescript')
    with contextlib.suppress(FileNotFoundError):
        with open(built) as file:
            if file.read() == NOTIFIER_SCRIPT:
                return applet
    shutil.rmtree(app, ignore_errors=True)
    try:
        subprocess.run(['osacompile', '-o', app, '-e', NOTIFIER_SCRIPT], check=True, capture_output=True, timeout=60)
        resources = os.path.join(app, 'Contents', 'Resources')
        with contextlib.suppress(FileNotFoundError):
            os.remove(os.path.join(resources, 'Assets.car'))  # its icon catalogue wins over applet.icns
        with open(ICNS, 'rb') as source, open(os.path.join(resources, 'applet.icns'), 'wb') as target:
            target.write(source.read())
        info = os.path.join(app, 'Contents', 'Info.plist')
        with open(info, 'rb') as file:
            plist = plistlib.load(file)
        plist.update({'CFBundleIdentifier': 'com.on-my-watch.notifier', 'CFBundleName': 'On my watch',
                      'CFBundleIconFile': 'applet', 'LSUIElement': True})
        plist.pop('CFBundleIconName', None)
        with open(info, 'wb') as file:
            plistlib.dump(plist, file)
        with open(built, 'w') as file:
            file.write(NOTIFIER_SCRIPT)
        subprocess.run(['codesign', '--force', '-s', '-', app], check=True, capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return applet


def muted(home):
    return os.path.exists(os.path.join(home, 'muted'))


# shortcut: shown under PowerShell's own app id; an unregistered one is dropped on some Windows versions.
TOAST = """
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastImageAndText04)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('{title}')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode('{subtitle}')) | Out-Null
$x.Item(2).AppendChild($t.CreateTextNode('{body}')) | Out-Null
$t.GetElementsByTagName('image').Item(0).SetAttribute('src', '{icon}')
$app = '{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
"""


def desktop_notify(note, home=HOME):
    """One desktop notification, {title, subtitle, body}, on macOS, Linux or Windows, with our icon; nothing while
    muted. It works from the schedule with Claude Code closed."""
    if muted(home):
        return
    title, subtitle, body = note['title'], note.get('subtitle', ''), note['body']
    if sys.platform == 'darwin':
        applet = notifier(home)
        if applet:
            argv = [applet, title, subtitle, body]
        else:
            quote = lambda text: '"' + text.replace('\\', '\\\\').replace('"', '\\"') + '"'
            argv = ['osascript', '-e', f'display notification {quote(body)} with title {quote(title)} subtitle {quote(subtitle)}']
    elif sys.platform == 'win32':
        quote = lambda text: text.replace("'", "''")
        argv = ['powershell', '-NoProfile', '-Command',
                TOAST.format(title=quote(title), subtitle=quote(subtitle), body=quote(body), icon=quote(ICON))]
    else:
        argv = ['notify-send', '--app-name=on-my-watch', f'--icon={ICON}', title, f'{subtitle}\n{body}' if subtitle else body]
    try:
        subprocess.run(argv, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        pass  # no notifier on this machine: the pane still shows everything


def connect(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    db = sqlite3.connect(db_path)
    db.execute('CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS avatars (login TEXT PRIMARY KEY, data TEXT NOT NULL)')
    return db


def store(db_path, updates, keep_days, tools=frozenset(), needs=()):
    """Adds a run: the newest row with this run's parts (updates) over it, read and written in one locked step, so two
    runs at once each keep the other's parts. Only the newest row keeps the pull requests: History needs Watch's part
    alone, and a month of runs with them came to hundreds of megabytes. Runs older than keep_days go."""
    stamp = now_iso()
    cutoff = (datetime.datetime.fromisoformat(stamp) - datetime.timedelta(days=keep_days)).isoformat(timespec='seconds')
    with contextlib.closing(connect(db_path)) as db:
        db.isolation_level = None
        db.execute('BEGIN IMMEDIATE')  # takes the write lock before reading, so no other run slips in between
        try:
            row = db.execute('SELECT result FROM runs ORDER BY id DESC LIMIT 1').fetchone()
            result = {**EMPTY, **(json.loads(row[0]) if row else {}), **updates}
            # The tools this run used say what they need now; the others keep what they said last.
            result['setup'] = [s for s in result.get('setup') or [] if s['tool'] not in tools] + list(needs)
            new = db.execute('INSERT INTO runs (checked_at, status, result) VALUES (?, ?, ?)', (stamp, result['status'], json.dumps(result))).lastrowid
            db.execute("UPDATE runs SET result = json_remove(result, '$.pullRequests', '$.avatarUrls') "
                       "WHERE id < ? AND json_type(result, '$.pullRequests') IS NOT NULL", (new,))
            db.execute('DELETE FROM runs WHERE checked_at < ?', (cutoff,))
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
    return result


def download(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read(), response.headers.get_content_type()


def keep_avatars(db_path, urls):
    """Reviewers' pictures, downloaded once each: the pane draws them as images that can't load from the web."""
    with contextlib.closing(connect(db_path)) as db, db:
        have = {login for (login,) in db.execute('SELECT login FROM avatars')}
        for login, url in urls.items():
            if login in have:
                continue
            try:
                data, kind = download(url)
            except Exception:  # no picture: the pane shows the name instead
                continue
            db.execute('INSERT INTO avatars (login, data) VALUES (?, ?)',
                       (login, f'data:{kind};base64,{base64.b64encode(data).decode()}'))


def avatars(db_path):
    with contextlib.closing(connect(db_path)) as db:
        return dict(db.execute('SELECT login, data FROM avatars'))


def failure(result):
    """Why a run failed, in one line: the first fix it needed with what the tool said, or its first error; None when ok."""
    if result.get('status') != 'failed':
        return None
    for need in result.get('setup') or []:
        return f"{need['fix']} ({need['detail']})" if need.get('detail') else need['fix']
    return (result.get('errors') or ['no reason was recorded'])[0]


def history(db_path):
    """Watch runs kept, newest first: one entry per observability check (a PR refresh alone is not one), with what it
    found: problems per label, most urgent first."""
    runs, seen = [], set()
    with contextlib.closing(connect(db_path)) as db:
        for row_id, text in db.execute('SELECT id, result FROM runs ORDER BY id DESC'):
            r = json.loads(text)
            if r.get('checkedAt') and r['checkedAt'] not in seen:
                seen.add(r['checkedAt'])
                # Problems per label, the most urgent label first, each with its most urgent priority for the icon.
                labels = {}
                for p in sorted(r['problems'], key=lambda p: (p.get('priority') is None, p.get('priority') or 0)):
                    shown = p.get('priorityName') or (f"P{p['priority']}" if p.get('priority') is not None else 'P–')
                    labels.setdefault(p['label'], {'label': p['label'], 'count': 0, 'priority': p.get('priority'), 'priorityName': shown})['count'] += 1
                runs.append({'id': row_id, 'checkedAt': r['checkedAt'], 'status': r['status'], 'reason': failure(r), 'problems': len(r['problems']),
                             'labels': list(labels.values()), 'span': r.get('span')})
    return runs


def show(db_path, row_id):
    with contextlib.closing(connect(db_path)) as db:
        row = db.execute('SELECT result FROM runs WHERE id = ?', (row_id,)).fetchone()
    return json.loads(row[0]) if row else None


def latest(db_path):
    with contextlib.closing(connect(db_path)) as db:
        row = db.execute('SELECT result FROM runs ORDER BY id DESC LIMIT 1').fetchone()
    return json.loads(row[0]) if row else None


def scheduled_now():
    return datetime.datetime.now()


def paused(home):
    """When scheduled runs were paused, or None while they run."""
    try:
        with open(os.path.join(home, 'paused')) as file:
            return file.read().strip() or None
    except FileNotFoundError:
        return None


def next_run(config, now):
    """The next minute any of the config's schedules fires, within a week and a day."""
    import schedule
    times, at = schedule.crons(config), now.replace(second=0, microsecond=0)
    for _ in range(8 * 24 * 60):
        at += datetime.timedelta(minutes=1)
        if any(schedule.due(cron, at) for cron in times):
            return at.isoformat()
    return None


def reschedule(home):
    """Rewrites the installed schedule for the config's times; leaves an uninstalled one alone. Windows wakes every
    minute and reads the config itself, so it needs nothing."""
    import schedule
    if sys.platform == 'darwin':
        installed = os.path.exists(schedule.AGENT)
    elif sys.platform != 'win32':
        current = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
        installed = schedule.MARK in current.stdout
    else:
        installed = False
    if installed:
        done = subprocess.run([sys.executable, os.path.join(PLUGIN, 'bin', 'schedule.py'), 'install', '--home', home], capture_output=True, text=True)
        if done.returncode != 0:
            sys.exit(f'the schedule was saved but not installed: {done.stderr.strip()}')


def save_config(home, config):
    """Writes the config once it holds to the schema; the file it replaces stays as config.json.bak."""
    broken = check_config(config)
    if broken:
        sys.exit('\n'.join(broken))
    path = os.path.join(home, 'config.json')
    if os.path.exists(path):
        shutil.copyfile(path, path + '.bak')
    with open(path + '.tmp', 'w') as file:  # written whole, then swapped in: a crash never leaves half a config
        json.dump(config, file, indent=2)
        file.write('\n')
    os.replace(path + '.tmp', path)


def schedules(config):
    return [config.get('schedule'), config.get('pullRequestsSchedule'), *(query.get('schedule') for *_, query in queries_of(config))]


def replace_config(home, config):
    """The whole config as the Config pane sends it on Save: every cron line read first, then checked and written."""
    import schedule
    with open(os.path.join(home, 'config.json')) as file:
        before = schedules(json.load(file))
    wrong = []
    lines = [('config.schedule', config.get('schedule')), ('config.pullRequestsSchedule', config.get('pullRequestsSchedule'))] + [
        (f'config.repos[{i}].queries[{j}].schedule', q.get('schedule'))
        for i, repo in enumerate(config.get('repos') or []) for j, q in enumerate(repo.get('queries') or []) if isinstance(q, dict)]
    for where, cron in lines:
        if isinstance(cron, str):
            try:
                schedule.cron_to_intervals(cron)
            except ValueError as error:
                wrong.append(f'{where}: {cron!r} is not a schedule: {error}')
    if wrong:
        sys.exit('\n'.join(wrong))
    save_config(home, config)
    if schedules(config) != before:
        reschedule(home)
    return config


def schedule_status(home):
    with open(os.path.join(home, 'config.json')) as file:
        config = json.load(file)
    own = [{'entry': entry_key({'name': name, 'service': service, 'env': q['env'], 'label': q['label']}), 'schedule': q['schedule']}
           for _, name, service, q in queries_of(config) if q.get('schedule')]
    return {'paused': paused(home), 'schedule': config['schedule'], 'pullRequests': config.get('pullRequestsSchedule'),
            'next': next_run(config, scheduled_now()), 'own': own}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Run your saved Datadog queries and list open pull requests.')
    parser.add_argument('command', choices=['run', 'latest', 'history', 'show', 'avatars', 'notifications', 'schedule', 'validate', 'config'])
    parser.add_argument('part', nargs='?', help="run: only this part (watch or pull_requests); show: the run's id from history; "
                                                "notifications: on, off, status, or quiet/loud with an entry")
    parser.add_argument('entry', nargs='?', help='notifications quiet|loud: the entry as name|service|env|label')
    parser.add_argument('--home', default=HOME)
    parser.add_argument('--if-due', action='store_true', help="run only when the config's schedule fires this minute (Windows)")
    parser.add_argument('--window', help="run: check this window instead of the config's, such as 15m, 4h or 7d")
    args = parser.parse_args(argv)
    db = os.path.join(args.home, 'history.db')
    if args.command == 'latest':
        return json.dumps(latest(db) or {})
    if args.command == 'history':
        return json.dumps(history(db))
    if args.command == 'validate':
        with open(os.path.join(args.home, 'config.json')) as file:
            broken = check_config(json.load(file))
        return '\n'.join(broken) if broken else 'config.json holds to the schema'
    if args.command == 'avatars':
        return json.dumps(avatars(db))
    if args.command == 'notifications':
        flag = os.path.join(args.home, 'muted')
        if args.part == 'off':
            os.makedirs(args.home, exist_ok=True)
            open(flag, 'w').close()
        elif args.part == 'on':
            with contextlib.suppress(FileNotFoundError):
                os.remove(flag)
        elif args.part in ('quiet', 'loud') and args.entry:
            entries = quiet_entries(args.home)
            (entries.add if args.part == 'quiet' else entries.discard)(args.entry)
            os.makedirs(args.home, exist_ok=True)
            with open(os.path.join(args.home, 'quiet.json'), 'w') as file:
                json.dump(sorted(entries), file)
        elif args.part != 'status':
            parser.error('notifications takes on, off, status, or quiet/loud with an entry')
        return json.dumps({'muted': muted(args.home), 'quiet': sorted(quiet_entries(args.home))})
    if args.command == 'schedule':
        if args.part == 'pause':
            os.makedirs(args.home, exist_ok=True)
            with open(os.path.join(args.home, 'paused'), 'w') as file:
                file.write(now_iso())
        elif args.part == 'resume':
            with contextlib.suppress(FileNotFoundError):
                os.remove(os.path.join(args.home, 'paused'))
        elif args.part != 'status':
            parser.error('schedule takes status, pause or resume')
        return json.dumps(schedule_status(args.home))
    if args.command == 'config':
        if args.part == 'replace':  # the whole config, as JSON on stdin
            try:
                given = json.load(sys.stdin)
            except ValueError:
                sys.exit('the config sent is not JSON')
            return json.dumps(replace_config(args.home, given))
        parser.error('config takes replace, with the config on stdin')
    if args.command == 'show':
        return json.dumps(show(db, int(args.part)) or {})
    if args.part and args.part not in PARTS:
        parser.error(f'part must be one of {", ".join(sorted(PARTS))}')
    with open(os.path.join(args.home, 'config.json')) as file:
        config = json.load(file)
    due = None
    if args.if_due:
        if paused(args.home):
            return ''
        import schedule  # the scheduler's cron reading, beside this file
        now = scheduled_now()
        # What fell due since each part's last check, so a time missed while the machine slept runs when it wakes.
        last = latest(db) or {}
        local = lambda iso: datetime.datetime.fromisoformat(iso).astimezone().replace(tzinfo=None) if iso else None
        fired = functools.lru_cache(maxsize=None)(lambda cron, after: schedule.due_since(cron, after, now))
        watched = local(last.get('checkedAt'))
        due = lambda query: fired(query.get('schedule') or config['schedule'], watched)
        # Watch runs when any query is due; pull requests on their own schedule, the general one when they have none.
        watching = any(due(query) for *_, query in queries_of(config))
        pulls = fired(config.get('pullRequestsSchedule') or config['schedule'], local(last.get('prsCheckedAt')))
        if not watching and not pulls:
            return ''
        if watching != pulls:
            args.part = 'watch' if watching else 'pull_requests'
    if args.window:
        seconds(args.window)  # a bad window stops here, before any query runs
        config['window'] = args.window
    enabled = {part for part in PARTS if config.get('panes', {}).get(part, True)}
    r = run(config, pup, gh, db, parts=({args.part} if args.part else set(PARTS)) & enabled, due=due)
    # One line for the log: the pane reads results from the database, not from this output.
    count = lambda n, word: f"{n} {word}{'' if n == 1 else 's'}"
    why = failure(r)
    return (f"{now_iso()} {r.get('status', 'ok')}: {count(len(r.get('problems', [])), 'problem')}, {count(len(r.get('pullRequests', [])), 'pull request')}"
            + (f' · {why}' if why else ''))


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    print(main())
    sys.exit(0)
