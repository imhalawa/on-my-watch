import os
import datetime
import plistlib
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))

import schedule  # noqa: E402


class CronToIntervals(unittest.TestCase):
    def test_hourly_on_weekdays_expands_to_one_entry_per_hour_and_day(self):
        intervals = schedule.cron_to_intervals('0 9-18 * * 1-5')
        self.assertEqual(len(intervals), 50)
        self.assertIn({'Minute': 0, 'Hour': 9, 'Weekday': 1}, intervals)
        self.assertIn({'Minute': 0, 'Hour': 18, 'Weekday': 5}, intervals)

    def test_steps_and_stars_leave_unset_fields_out(self):
        self.assertEqual(schedule.cron_to_intervals('*/30 * * * *'), [{'Minute': 0}, {'Minute': 30}])

    def test_lists_and_a_bad_field_count(self):
        self.assertEqual(schedule.cron_to_intervals('15 8,12 * * *'), [{'Minute': 15, 'Hour': 8}, {'Minute': 15, 'Hour': 12}])
        with self.assertRaises(ValueError):
            schedule.cron_to_intervals('0 9 * *')


@unittest.skipIf(os.name == 'nt', 'builds macOS and Linux paths, which only run there')
class Plist(unittest.TestCase):
    def test_wakes_at_every_schedules_times_and_runs_what_is_due(self):
        data = plistlib.loads(schedule.plist_for(['0 9 * * 1', '30 9 * * 1', '0 9 * * 1'], '/plugin', '/home/.on-my-watch'))
        self.assertEqual(data['Label'], 'com.on-my-watch')
        self.assertEqual(data['ProgramArguments'][-3:], ['/plugin/bin/on_my_watch.py', 'run', '--if-due'])
        self.assertEqual(data['StartCalendarInterval'], [{'Minute': 0, 'Hour': 9, 'Weekday': 1}, {'Minute': 30, 'Hour': 9, 'Weekday': 1}])
        self.assertEqual(data['StandardErrorPath'], '/home/.on-my-watch/run.log')
        self.assertIn('/opt/homebrew/bin', data['EnvironmentVariables']['PATH'])


class Crons(unittest.TestCase):
    def test_the_general_schedule_and_every_query_schedule_once_each(self):
        config = {'schedule': '0 9 * * *', 'repos': [{'queries': [{'schedule': '*/15 * * * *'}, {}, {'schedule': '0 9 * * *'}]}]}
        self.assertEqual(schedule.crons(config), ['*/15 * * * *', '0 9 * * *'])


@unittest.skipIf(os.name == 'nt', 'builds macOS and Linux paths, which only run there')
class Linux(unittest.TestCase):
    def test_the_cron_line_goes_into_the_crontab_replacing_an_older_one(self):
        line = schedule.crontab_line('0 9-18 * * 1-5', '/usr/bin/python3', '/my plugin', '/home/me/.on-my-watch', '/home/me/.local/bin:/usr/bin')
        self.assertEqual(line, "0 9-18 * * 1-5 PATH=/home/me/.local/bin:/usr/bin /usr/bin/python3 '/my plugin/bin/on_my_watch.py' run --if-due"
                               " >> /home/me/.on-my-watch/run.log 2>&1 # on-my-watch")
        other = schedule.crontab_line('*/15 * * * *', '/usr/bin/python3', '/p', '/h', '/usr/bin')
        old = 'MAILTO=me\n*/5 * * * * backup\n0 8 * * * /old/on_my_watch.py run # on-my-watch\n'
        self.assertEqual(schedule.with_lines(old, [line, other]), f'MAILTO=me\n*/5 * * * * backup\n{line}\n{other}\n')
        self.assertEqual(schedule.with_lines(old, []), 'MAILTO=me\n*/5 * * * * backup\n')


class Windows(unittest.TestCase):
    def test_a_task_wakes_every_minute_and_runs_only_when_due(self):
        argv = schedule.schtasks_create('C:\\Python\\python.exe', 'C:\\plugin')
        self.assertEqual(argv[:5], ['schtasks', '/Create', '/F', '/TN', 'on-my-watch'])
        self.assertEqual(argv[argv.index('/SC') + 1:argv.index('/SC') + 4], ['MINUTE', '/MO', '1'])
        # pythonw: no console window flashing up every minute.
        self.assertEqual(argv[-1], '"C:\\Python\\pythonw.exe" "C:\\plugin\\bin\\on_my_watch.py" run --if-due')

    def test_due_matches_the_cron_line_to_the_minute(self):
        monday_9 = datetime.datetime(2026, 10, 19, 9, 0)
        self.assertTrue(schedule.due('0 9-18 * * 1-5', monday_9))
        self.assertFalse(schedule.due('0 9-18 * * 1-5', monday_9.replace(minute=1)))
        self.assertFalse(schedule.due('0 9-18 * * 1-5', monday_9 - datetime.timedelta(days=1)))  # Sunday
        self.assertTrue(schedule.due('*/30 * * * *', monday_9.replace(minute=30)))


if __name__ == '__main__':
    unittest.main()
