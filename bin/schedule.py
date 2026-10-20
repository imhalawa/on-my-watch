#!/usr/bin/env python3
"""Runs on_my_watch.py on the config's cron line: launchd on macOS, the crontab on Linux, Task Scheduler on Windows.

schedule.py plan|install|uninstall [--home DIR]
  plan       prints what it would install, changes nothing
  install    adds the schedule (replacing an older one)
  uninstall  removes it
"""
import argparse
import datetime
import itertools
import json
import ntpath
import os
import plistlib
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
HOME = os.path.expanduser('~/.on-my-watch')
LABEL = 'com.on-my-watch'
AGENT = os.path.expanduser(f'~/Library/LaunchAgents/{LABEL}.plist')
FIELDS = [('Minute', 0, 59), ('Hour', 0, 23), ('Day', 1, 31), ('Month', 1, 12), ('Weekday', 0, 6)]


def expand(field, low, high):
    """One cron field as its values, or None for every value."""
    if field == '*':
        return None
    values = set()
    for part in field.split(','):
        span, _, step = part.partition('/')
        if span == '*':
            start, end = low, high
        elif '-' in span:
            start, end = map(int, span.split('-'))
        else:  # "5" is one value, "5/15" runs from 5 to the top
            start = int(span)
            end = high if step else start
        if not (low <= start <= end <= high):
            raise ValueError(f'{part} is outside {low}-{high}')
        values.update(range(start, end + 1, int(step or 1)))
    return sorted(values)


def cron_to_intervals(expr):
    """A five-field cron line as launchd StartCalendarInterval entries; unset fields mean every value."""
    fields = expr.split()
    if len(fields) != 5:
        raise ValueError(f'cron needs 5 fields, got {len(fields)}: {expr!r}')
    columns = [(name, expand(field, low, high)) for field, (name, low, high) in zip(fields, FIELDS)]
    set_columns = [(name, values) for name, values in columns if values is not None]
    names = [name for name, _ in set_columns]
    return [dict(zip(names, combo)) for combo in itertools.product(*(values for _, values in set_columns))]


def crons(config):
    """Every schedule the config names: the general one, the pull requests' own and each query's own, once each."""
    found = {config['schedule'], *([config['pullRequestsSchedule']] if config.get('pullRequestsSchedule') else [])}
    found.update(query['schedule'] for repo in config.get('repos', []) for query in repo.get('queries', []) if query.get('schedule'))
    return sorted(found)


def plist_for(crons_, plugin_dir, home):
    """Wakes at every schedule's times; the checker then runs only what is due that minute."""
    log = os.path.join(home, 'run.log')
    slots = []
    for cron in crons_:
        slots += [slot for slot in cron_to_intervals(cron) if slot not in slots]
    return plistlib.dumps({
        'Label': LABEL,
        'ProgramArguments': ['/usr/bin/env', 'python3', os.path.join(plugin_dir, 'bin', 'on_my_watch.py'), 'run', '--if-due'],
        'StartCalendarInterval': slots,
        # launchd starts with a bare PATH; pup and gh usually live in Homebrew's
        'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
        'StandardOutPath': log,
        'StandardErrorPath': log,
    })


def due(cron, now):
    """Whether a five-field cron line fires at this minute. Cron counts weekdays from Sunday as 0."""
    # shortcut: day and weekday must both match; cron fires when either does if both are set, rare in practice.
    values = [now.minute, now.hour, now.day, now.month, (now.weekday() + 1) % 7]
    return all(expand(field, low, high) is None or value in expand(field, low, high)
               for field, (_, low, high), value in zip(cron.split(), FIELDS, values))


def due_since(cron, after, now):
    """Whether a cron line fired after `after` and up to `now`, both local times, so a time missed while the machine
    slept still counts once it wakes. Without an earlier check, or with one not before now, just this minute."""
    now = now.replace(second=0, microsecond=0)
    if after is None or after >= now:
        return due(cron, now)
    at = max(after.replace(second=0, microsecond=0), now - datetime.timedelta(days=8))
    while at < now:
        at += datetime.timedelta(minutes=1)
        if due(cron, at):
            return True
    return False


MARK = '# on-my-watch'


def crontab_line(cron, python, plugin_dir, home, path):
    # cron starts with a bare PATH; the one at install time finds pup and gh as the user's shell does.
    script, log = os.path.join(plugin_dir, 'bin', 'on_my_watch.py'), os.path.join(home, 'run.log')
    return f"{cron} PATH={shlex.quote(path)} {shlex.quote(python)} {shlex.quote(script)} run --if-due >> {shlex.quote(log)} 2>&1 {MARK}"


def with_lines(crontab, lines):
    """The crontab with our lines replaced (or removed, for none); every other line kept."""
    kept = [row for row in crontab.splitlines() if not row.endswith(MARK)]
    return '\n'.join(kept + list(lines)) + '\n'


def schtasks_create(python, plugin_dir):
    # A task wakes each minute and the checker runs only when the cron line is due:
    # Task Scheduler has no cron syntax. pythonw opens no console window.
    pythonw = ntpath.join(ntpath.dirname(python), 'pythonw.exe')
    script = ntpath.join(plugin_dir, 'bin', 'on_my_watch.py')
    return ['schtasks', '/Create', '/F', '/TN', 'on-my-watch', '/SC', 'MINUTE', '/MO', '1',
            '/TR', f'"{pythonw}" "{script}" run --if-due']


def linux(command, crons_, home):
    current = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
    lines = [crontab_line(cron, sys.executable, PLUGIN, home, os.environ.get('PATH', '')) for cron in crons_] if command != 'uninstall' else []
    if command == 'plan':
        return print('\n'.join(lines))
    subprocess.run(['crontab', '-'], input=with_lines(current.stdout if current.returncode == 0 else '', lines), text=True, check=True)
    print('crontab updated')


def windows(command):
    argv = schtasks_create(sys.executable, PLUGIN) if command != 'uninstall' else ['schtasks', '/Delete', '/F', '/TN', 'on-my-watch']
    if command == 'plan':
        return print(' '.join(argv))
    subprocess.run(argv, check=True)
    print('task', 'removed' if command == 'uninstall' else 'installed')


def main():
    parser = argparse.ArgumentParser(description='Schedule on-my-watch: launchd, crontab or Task Scheduler.')
    parser.add_argument('command', choices=['plan', 'install', 'uninstall'])
    parser.add_argument('--home', default=HOME)
    args = parser.parse_args()
    found = []
    if args.command != 'uninstall':
        with open(os.path.join(args.home, 'config.json')) as file:
            found = crons(json.load(file))
        for cron in found:
            cron_to_intervals(cron)  # a bad cron line stops here, on every system
    if sys.platform == 'win32':
        return windows(args.command)
    if sys.platform != 'darwin':
        return linux(args.command, found, args.home)
    domain = f'gui/{os.getuid()}'

    if args.command == 'uninstall':
        subprocess.run(['launchctl', 'bootout', domain, AGENT], capture_output=True)
        if os.path.exists(AGENT):
            os.remove(AGENT)
        print('removed', AGENT)
        return

    slots = len(plistlib.loads(plist_for(found, PLUGIN, args.home))['StartCalendarInterval'])
    if args.command == 'plan':
        print(f"{', '.join(repr(c) for c in found)} -> {slots} launchd slots -> {AGENT}")
        return
    with open(AGENT, 'wb') as out:
        out.write(plist_for(found, PLUGIN, args.home))
    subprocess.run(['launchctl', 'bootout', domain, AGENT], capture_output=True)  # reload when already loaded
    loaded = subprocess.run(['launchctl', 'bootstrap', domain, AGENT], capture_output=True, text=True)
    if loaded.returncode != 0:
        sys.exit(f'launchctl bootstrap failed: {loaded.stderr.strip()}')
    print(f'installed ({slots} slots): {AGENT}')


if __name__ == '__main__':
    main()
