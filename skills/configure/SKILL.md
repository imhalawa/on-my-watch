---
name: configure
description: Set up or change the on-my-watch config, ~/.on-my-watch/config.json. Use for first-time setup, adding, changing or removing a repository or a Datadog query, and for settings such as the Datadog site, the window, schedules, environments, notifications, panes, bots and history. Triggers - "set up on-my-watch", "watch this service", "add a query", "add a repo", "stop watching", "change the schedule", "mute".
---

# Configure on-my-watch

The plugin root is two folders above this skill's base directory. It holds `config.schema.json`, `config.example.json` and `bin/on_my_watch.py`. The config lives in `~/.on-my-watch/config.json`.

## Steps

1. Read `config.schema.json` and the current config. If the config does not exist, this is a first-time setup.
2. Ask what to change with AskUserQuestion: add a repository, add a query, change or remove one, or change a setting. Skip the question when the request already says.
3. Collect each field the schema needs.
   - Fixed choices go through AskUserQuestion: `source` (logs, traces, metrics), `priority` (1 High, 2 Medium, 3 Low), alert direction (above, below), notifications on or off.
   - Free values come from the user: the GitHub `owner/name`, the display name, the service, env and label, the Datadog query, the threshold. Never guess a threshold or a query.
   - Offer `"notify": false` for a new query, so the user can watch it in the pane before it sends notifications.
4. Show the user the entry you will add or the change you will make, and wait for a yes.
5. Save the whole config through the engine, which checks it against the schema, keeps the old file as `config.json.bak` and updates an installed schedule:

   ```bash
   python3 <plugin root>/bin/on_my_watch.py config replace < /tmp/on-my-watch-config.json
   ```

   On a first-time setup, first copy `config.example.json` to `~/.on-my-watch/config.json` (create the folder), then replace it the same way.
6. If the engine refuses the config, it prints each field that breaks the schema. Fix those fields and save again.
7. Tell the user to press **Reload** in the Config pane, or wait for the next run. If they want checks while Claude Code is closed, offer `python3 <plugin root>/bin/schedule.py install`.

## Rules

- A repository is listed once. Within it, each combination of service, env and label is used once.
- `pup` and `gh` must be installed and signed in. If `command -v pup gh` misses one, say so: `pup auth login`, `gh auth login`.
- Edit only what the user asked for. Keep every other field as it is.
