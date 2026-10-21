import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Part, Problem, PullRequest, Result } from '../types'

// Two panes, so the app can place and size them apart; each can be turned off in the config.
const PANES = {
  watch: { id: 'on-my-watch', title: 'Watch' },
  pull_requests: { id: 'on-my-watch-prs', title: 'Pull requests' },
} as const
// Config and the schedule, for both parts: a pane of its own, always open beside the others.
const CONFIG_PANE = { id: 'on-my-watch-config', title: 'Config' } as const
// A desktop app can start with a short PATH; these are where pup and gh usually live on macOS and Linux.
const TOOL_DIRS = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

const result = atom({ plugin: 'on-my-watch', key: 'result' } as const, null)
const running = atom({ plugin: 'on-my-watch', key: 'running' } as const, null)
const runningSince = atom({ plugin: 'on-my-watch', key: 'runningSince' } as const, null)
const span = atom({ plugin: 'on-my-watch', key: 'span' } as const, '3d')
const hideBots = atom({ plugin: 'on-my-watch', key: 'hideBots' } as const, false)
const prState = atom({ plugin: 'on-my-watch', key: 'prState' } as const, 'open')
// Long lists draw a page at a time: the pull requests' page, and the open repository's page of queries.
const prPage = atom({ plugin: 'on-my-watch', key: 'prPage' } as const, 1)
// Watch narrows to one priority, name or environment; empty is all. The choices come from the config's queries.
const priorityFilter = atom({ plugin: 'on-my-watch', key: 'priorityFilter' } as const, '')
const nameFilter = atom({ plugin: 'on-my-watch', key: 'nameFilter' } as const, '')
const envFilter = atom({ plugin: 'on-my-watch', key: 'envFilter' } as const, '')
const choices = atom({ plugin: 'on-my-watch', key: 'choices' } as const, { names: [], envs: [], envGroups: {}, priorities: [], bots: ['dependabot'] })
const quietEntries = atom({ plugin: 'on-my-watch', key: 'quietEntries' } as const, [])
const groupPrs = atom({ plugin: 'on-my-watch', key: 'groupPrs' } as const, true)
const watchView = atom({ plugin: 'on-my-watch', key: 'watchView' } as const, 'latest')
const runs = atom({ plugin: 'on-my-watch', key: 'runs' } as const, [])
const archived = atom({ plugin: 'on-my-watch', key: 'archived' } as const, null)
const watchWindow = atom({ plugin: 'on-my-watch', key: 'watchWindow' } as const, '')
const avatars = atom({ plugin: 'on-my-watch', key: 'avatars' } as const, {})
const muted = atom({ plugin: 'on-my-watch', key: 'muted' } as const, false)
const scheduleState = atom({ plugin: 'on-my-watch', key: 'scheduleState' } as const, null)
const customFor = atom({ plugin: 'on-my-watch', key: 'customFor' } as const, null)
const cronDraft = atom({ plugin: 'on-my-watch', key: 'cronDraft' } as const, '')
// The config as the Config pane edits it, when it was read and what the schema says of it.
const configDoc = atom({ plugin: 'on-my-watch', key: 'configDoc' } as const, null)
const configReadAt = atom({ plugin: 'on-my-watch', key: 'configReadAt' } as const, '')
const configProblems = atom({ plugin: 'on-my-watch', key: 'configProblems' } as const, [])
const configError = atom({ plugin: 'on-my-watch', key: 'configError' } as const, '')
// Every change the Config pane makes lands here first; Save changes writes it, Discard and Reload drop it.
const configDraft = atom({ plugin: 'on-my-watch', key: 'configDraft' } as const, null)
// The environment groups as typed, [name, members] row by row, and the row being added; null until one changes.
const envRows = atom({ plugin: 'on-my-watch', key: 'envRows' } as const, null)
const envDraft = atom({ plugin: 'on-my-watch', key: 'envDraft' } as const, { name: '', members: '' })

const settingsDraft = atom({ plugin: 'on-my-watch', key: 'settingsDraft' } as const, null)
// The schedule builder: how often, between which hours (or at which), on which days. It reads a cron line back
// into those parts, and makes one from them; a line it can't make is Custom.
type Build = { every: '15m' | '30m' | '1h' | 'once' | 'twice'; allDay: boolean; from: number; to: number; at: number[]; days: number[] }
const EVERY = [
  { value: '15m', label: 'Every 15 minutes' },
  { value: '30m', label: 'Every 30 minutes' },
  { value: '1h', label: 'Every hour' },
  { value: 'once', label: 'Once a day' },
  { value: 'twice', label: 'Twice a day' },
] as const
const STEP: Record<string, number> = { '15m': 15, '30m': 30, '1h': 60 }
// Work hours are 09:00–18:00, Monday to Friday, as the example config's schedule.
const WORK: Build = { every: '1h', allDay: false, from: 9, to: 18, at: [9, 13], days: [1, 2, 3, 4, 5] }
const WEEK = [[1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'], [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'], [0, 'Sun', 'Sunday']] as const
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))
const hh = (h: number, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

function readDays(field: string): number[] | null {
  if (field === '*') return [0, 1, 2, 3, 4, 5, 6]
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^([0-7])(?:-([0-7]))?$/.exec(part)
    if (!m) return null
    for (let d = Number(m[1]); d <= Number(m[2] ?? m[1]); d++) days.add(d % 7)
  }
  return [...days].sort((a, b) => a - b)
}
function daysField(days: number[]) {
  if (days.length === 7) return '*'
  const runs: number[][] = []
  for (const d of [...days].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last && d === last.at(-1)! + 1) last.push(d)
    else runs.push([d])
  }
  return runs.map(r => (r.length > 2 ? `${r[0]}-${r.at(-1)}` : r.join(','))).join(',')
}
function readBuild(cron: string): Build | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*') return null
  const [minute, hour] = f as [string, string]
  const days = readDays(f[4]!)
  const every = ({ '*/15': '15m', '*/30': '30m', 0: '1h' } as Record<string, Build['every']>)[minute]
  if (!days || !every) return null
  if (hour === '*') return { ...WORK, every, allDay: true, days }
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(hour)
  if (range && Number(range[1]) <= Number(range[2]) && Number(range[2]) < 24) return { ...WORK, every, from: Number(range[1]), to: Number(range[2]), days }
  const at = hour.split(',')
  if (every === '1h' && at.length <= 2 && at.every(h => /^\d{1,2}$/.test(h) && Number(h) < 24))
    return { ...WORK, every: at.length === 1 ? 'once' : 'twice', at: at.map(Number), days }
  return null
}
function cronOfBuild(b: Build) {
  const daily = b.every === 'once' || b.every === 'twice'
  const minute = ({ '15m': '*/15', '30m': '*/30' } as Record<string, string>)[b.every] ?? '0'
  const hour = daily ? b.at.slice(0, b.every === 'once' ? 1 : 2).join(',') : b.allDay ? '*' : `${b.from}-${b.to}`
  return `${minute} ${hour} * * ${daysField(b.days)}`
}
// What a build runs, in words: `Every 30 minutes from 09:00 to 18:30, Monday to Friday`.
function describeBuild(b: Build) {
  const order = WEEK.filter(([d]) => b.days.includes(d))
  const at = WEEK.map(([d]) => d as number)
  const unbroken = order.length > 1 && order.every(([d], i) => i === 0 || at.indexOf(d) === at.indexOf(order[i - 1]![0]) + 1)
  const days = b.days.length === 7 ? 'every day'
    : b.days.length === 2 && b.days.includes(0) && b.days.includes(6) ? 'weekends'
      : unbroken && order.length > 2 ? `${order[0]![2]} to ${order.at(-1)![2]}`
        : order.map(([, , name]) => name).join(', ')
  const step = STEP[b.every]
  const when = b.every === 'once' ? `Once a day at ${hh(b.at[0]!)}`
    : b.every === 'twice' ? `Twice a day at ${hh(b.at[0]!)} and ${hh(b.at[1]!)}`
      : `${EVERY.find(e => e.value === b.every)!.label}${b.allDay ? ', all day' : ` from ${hh(b.from)} to ${hh(b.to, 60 - step!)}`}`
  return `${when}, ${days}`
}
// The width, in cells, of every label in the Config pane, so the fields after them line up.
const LABEL_WIDTH = 18
// Fields for short values, in cells: `15m`, `30`.
const SHORT_FIELDS: Record<string, number> = { window: 12, historyDays: 8 }

// A query's priority: 1, 2 or 3, the most urgent first.
const PRIORITY_NAMES = ['High', 'Medium', 'Low']
// The mod's own accent: section icons, chevrons and the new mark, in Claude's orange.
const ACCENT = 'accent' as const
// The rows whose field the schema requires, by row key: their labels carry a red asterisk.
const REQUIRED = new Set(['site', 'window', 'field:repo', 'field:name',
  'field:service', 'field:label', 'field:env', 'field:priority', 'field:source', 'field:query', 'field:line'])
// The widths, in cells, of History's columns: when and the window, then each count.
const HISTORY_WHEN_WIDTH = 22
const HISTORY_COUNT_WIDTH = 7
// The width, in cells, of an environment group's name field, so the members after them line up.
const ENV_GROUP_WIDTH = 18
const CUSTOM = { value: 'custom', label: 'Custom…' }
// A pull request's state as GitHub gives it: Closed is closed without merging.
const STATES = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
] as const

// A box drawn before a label: the engine has no checkbox element.
function checkbox(ui: any, look: Look, key: string, label: string, checked: boolean, toggle: () => unknown, hotkey?: string) {
  return <ui.Button key={key} plain hotkey={hotkey ? look.hotkey(hotkey) : undefined} label={`${checked ? '☑' : '☐'} ${label}`} onPress={toggle} />
}

// One change to the draft: `set` a JSON value at a dotted path (`+` adds to a list) or `delete` it. Nothing is written.
function applyEdit(o: any, [action, path, json]: string[]) {
  const keys = path!.split('.')
  const last = keys.pop()!
  let node = o
  for (const k of keys) node = Array.isArray(node) ? node[Number(k)] : (node[k] ??= {})
  if (action === 'delete') {
    if (Array.isArray(node)) node.splice(Number(last), 1)
    else delete node[last]
  } else if (last === '+') node.push(JSON.parse(json!))
  else node[Array.isArray(node) ? Number(last) : last] = JSON.parse(json!)
}
async function saveConfig($: any, args: string[]) {
  const base = (await read($, configDraft)) ?? (await read($, configDoc))
  const next = JSON.parse(JSON.stringify(base ?? {}))
  applyEdit(next, args)
  await update($, configDraft, () => next)
}
// Save changes: what is still being typed joins the draft, then the checker checks the whole of it and writes it,
// keeping the file it replaces.
async function saveAll($: any) {
  await saveSettings($, (await read($, settingsDraft)) ?? {})
  const groups = await read($, envRows)
  if (groups) {
    const names = groups.map(([name]) => name.trim())
    if (names.some(n => !n) || new Set(names).size !== names.length) return update($, configError, () => 'Each environment group needs a name of its own.')
    const object = Object.fromEntries(groups.map(([name, members]) => [name.trim(), list(members)]))
    await saveConfig($, groups.length ? ['set', 'environments', JSON.stringify(object)] : ['delete', 'environments'])
  }
  const typed = await read($, customFor)
  if (typed !== null) await setSchedule($, await read($, cronDraft), typed)
  const draft = await read($, configDraft)
  if (!draft) return
  const done = await checker($, ['config', 'replace'], JSON.stringify(draft))
  const refused = done.exitCode === 0 ? '' : done.stderr.trim() || 'the config was not saved'
  await update($, configError, () => refused)
  if (refused) return
  await discard($)
  await readPanes($)
  await scheduleCommand($, ['status'])
}
async function discard($: any) {
  for (const clear of [() => update($, configDraft, () => null), () => update($, settingsDraft, () => null),
    () => update($, customFor, () => null), () => update($, envRows, () => null)]) await clear()
}

// The settings the Config pane edits: what a field shows of the config, and the JSON it saves (null takes it out).
const list = (v: string) => v.split(',').map(x => x.trim()).filter(Boolean)
const listJson = (v: string) => (list(v).length ? JSON.stringify(list(v)) : null)
const SETTINGS = [
  { path: 'site', section: 'watch', label: 'Datadog site', hint: 'datadoghq.com', of: (d: any) => d.site ?? '', json: (v: string) => JSON.stringify(v) },
  { path: 'window', section: 'watch', label: 'Window', hint: '1h', of: (d: any) => d.window ?? '', json: (v: string) => JSON.stringify(v) },
  { path: 'historyDays', section: 'watch', label: 'History rotation', unit: 'days', hint: '30', of: (d: any) => (d.historyDays == null ? '' : String(d.historyDays)), json: (v: string) => v || null },
  { path: 'bots', section: 'prs', label: 'Bots', hint: 'dependabot, renovate', of: (d: any) => (d.bots ?? ['dependabot']).join(', '), json: listJson },
] as const
// The settings as typed, each changed one put into the draft.
async function saveSettings($: any, typed: Record<string, string>) {
  for (const f of SETTINGS) {
    const doc = ((await read($, configDraft)) ?? (await read($, configDoc))) as any
    const v = typed[f.path]?.trim()
    if (v === undefined || v === f.of(doc ?? {})) continue
    const json = f.json(v)
    await saveConfig($, json === null ? ['delete', f.path] : ['set', f.path, json])
  }
  await update($, settingsDraft, () => null)
}

// The Config pane: the file and what it holds, settings, environments, panes and notifications, and the schedule.
async function configView($: any, ui: any, look: Look, picker: ReturnType<typeof pickerFor>, narrow = false) {
  const { Box, Text, Button } = ui
  const canType = 'Input' in ui
  const dirtyDraft = await read($, configDraft)
  const doc = (dirtyDraft ?? (await read($, configDoc))) as any
  const readAt = await read($, configReadAt)
  const problems = await read($, configProblems)
  const saveError = await read($, configError)
  const state = await read($, scheduleState)
  const custom = await read($, customFor)
  const draft = await read($, cronDraft)
  const changes = await read($, settingsDraft)
  const when = (iso: string) => (day(iso) === 'Today' ? time(iso) : `${day(iso)} ${time(iso)}`)
  // The environments the config's queries already use, for the query form's dropdown.
  const environments = environmentList(doc)

  // A section as a card: its icon and name, its actions at the right, then what it holds.
  const card = (key: string, icon: IconName, text: string, right: unknown, ...body: unknown[]) => (
    <Box key={`card:${key}`} flexDirection="column" rowGap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
      <Box key={`h:${key}`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2} flexWrap="wrap">
        {/* The icon is decoration here: the terminal writes no word for it, the title says it. */}
        <Box flexDirection="row" alignItems="center" columnGap={1}>{look.icon(icon, ACCENT, text, '')}<Text bold>{text}</Text></Box>
        {right}
      </Box>
      {body}
    </Box>
  )
  // A group's name inside a form, dim, above the fields it heads.
  const group = (key: string, text: string) => <Box key={`group:${key}`} marginTop={1}><Text dimColor>{text}</Text></Box>
  // A labelled line: every label takes the same width, so the fields after them line up.
  // Narrow: the label above its field, so the field and its hint get the whole width.
  const row = (key: string, label: string, ...control: unknown[]) => (
    <Box key={`row:${key}`} flexDirection={narrow ? 'column' : 'row'} alignItems={narrow ? 'stretch' : 'center'} columnGap={1}>
      <Box key={`label:${key}`} width={narrow ? undefined : LABEL_WIDTH} flexShrink={0} flexDirection="row">
        <Text dimColor>{label}</Text>{REQUIRED.has(key) && <Text key={`required:${key}`} color="error"> *</Text>}
      </Box>
      <Box flexDirection="row" flexGrow={1} minWidth={0} columnGap={2} alignItems="center" flexWrap="wrap">{control}</Box>
    </Box>
  )

  // The schedule builder for one entry ('' is every query): each change saves the cron line it makes.
  const cronPicker = (entry: string, cron: string, extra: { value: string; label: string }[] = [], same = false) => {
    // `same`: it has no line of its own and follows Watch's, so only the dropdown shows, on Same as Watch.
    if (same) {
      const from = readBuild(cron) ?? WORK
      return (
        <Box key={`picker:${entry}`} flexDirection="row">
          {picker(`cron:${entry}`, '', [...extra, ...EVERY, CUSTOM], 'default', (v: string) => (v === CUSTOM.value
            ? Promise.all([update($, customFor, () => entry), update($, cronDraft, () => cron)])
            : v === 'default' ? null : setSchedule($, cronOfBuild({ ...from, every: v as Build['every'] }), entry)))}
        </Box>
      )
    }
    const built = custom === entry ? null : readBuild(cron)
    const save = (b: Build) => setSchedule($, cronOfBuild(b), entry)
    const base = built ?? WORK
    const pick = (v: string) => {
      if (v === CUSTOM.value) return Promise.all([update($, customFor, () => entry), update($, cronDraft, () => cron)])
      if (v === 'default') return setSchedule($, v, entry)
      return save({ ...base, every: v as Build['every'] })
    }
    const hotkey = (k: string) => (entry ? '' : k)
    const daily = built && (built.every === 'once' || built.every === 'twice')
    return (
      <Box key={`picker:${entry}`} flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={2} alignItems="center" flexWrap="wrap">
          {picker(`cron:${entry}`, hotkey('c'), [...extra, ...EVERY, CUSTOM], built ? built.every : CUSTOM.value, pick)}
          {built && !daily && !built.allDay && [
            <Text key="from-word" dimColor>from</Text>,
            picker(`from:${entry}`, '', HOURS, String(built.from), v => save({ ...built, from: Number(v), to: Math.max(built.to, Number(v)) })),
            <Text key="to-word" dimColor>to</Text>,
            picker(`to:${entry}`, '', HOURS, String(built.to), v => save({ ...built, to: Number(v), from: Math.min(built.from, Number(v)) })),
          ]}
          {built && !daily && checkbox(ui, look, `allday:${entry}`, 'All day', built.allDay, () => save({ ...built, allDay: !built.allDay }))}
          {daily && [
            <Text key="at-word" dimColor>at</Text>,
            picker(`at1:${entry}`, '', HOURS, String(built.at[0]), v => save({ ...built, at: [Number(v), built.at[1] ?? 13] })),
            ...(built.every === 'twice' ? [<Text key="and-word" dimColor>and</Text>,
              picker(`at2:${entry}`, '', HOURS, String(built.at[1] ?? 13), v => save({ ...built, at: [built.at[0]!, Number(v)] }))] : []),
          ]}
        </Box>
        {built && (
          <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
            {WEEK.map(([d, short]) => checkbox(ui, look, `day:${d}:${entry}`, short, built.days.includes(d), () => {
              const days = built.days.includes(d) ? built.days.filter(x => x !== d) : [...built.days, d]
              return days.length ? save({ ...built, days }) : null // a schedule needs one day at least
            }))}
            <Button key={`work:${entry}`} variant="secondary" label="Use work hours" onPress={() => save({ ...WORK, every: daily ? '1h' : built.every })} />
          </Box>
        )}
        {built && <Box key={`cron-line:${entry}`}><Text dimColor wrap="wrap">{describeBuild(built)}</Text></Box>}
        {!built && canType && (
          <ui.Input key={`cron-input:${entry}`} value={custom === entry ? draft : cron} placeholder="0 9-18 * * 1-5"
            onInput={(v: string) => update($, cronDraft, () => v)} onSubmit={(v: string) => update($, cronDraft, () => v).then(() => saveAll($))} />
        )}
        {!built && <Text dimColor>minute hour day month weekday</Text>}
      </Box>
    )
  }

  // A setting's field: typing keeps a draft; submitting it, or Save changes, saves what changed.
  const setting = (f: typeof SETTINGS[number]) => row(f.path, f.label, canType
    // A short value gets a short field; the rest take the line.
    ? <Box key={`fill:set:${f.path}`} {...(SHORT_FIELDS[f.path] ? { width: SHORT_FIELDS[f.path], flexShrink: 0 } : { flexGrow: 1, minWidth: 0 })}>
      <ui.Input key={`set:${f.path}`} value={changes?.[f.path] ?? f.of(doc)} placeholder={f.hint}
        onInput={(v: string) => update($, settingsDraft, d => ({ ...(d ?? {}), [f.path]: v }))}
        onSubmit={(v: string) => update($, settingsDraft, d => ({ ...(d ?? {}), [f.path]: v })).then(() => saveAll($))} />
    </Box>
    : <Text>{f.of(doc) || '—'}</Text>,
  'unit' in f && <Text key={`unit:${f.path}`} dimColor>{f.unit}</Text>)
  const toggle = (path: string, label: string, on: boolean) => checkbox(ui, look, `set:${path}`, label, on, () => saveConfig($, ['set', path, String(!on)]))

  const reload = <Button key="reload-config" variant="secondary" hotkey={look.hotkey('k')} label="Reload" onPress={() => discard($).then(() => readPanes($))} />
  if (!doc) {
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>No config yet. Put it in ~/.on-my-watch/config.json, then press Reload.</Text>
        <Box flexDirection="row">{reload}</Box>
      </Box>
    )
  }
  const repos = (Array.isArray(doc.repos) ? doc.repos : []) as any[]
  const queries = repos.flatMap(r => r?.queries ?? [])
  const envs = environments.length
  // Settings typed and not saved yet, by the card they sit in: that card gets Save changes.
  // Unsaved: the draft, settings typed, or a cron line typed.
  const groupRows = await read($, envRows)
  const dirty = !!dirtyDraft || !!groupRows || custom !== null || SETTINGS.some(f => changes?.[f.path] !== undefined && changes[f.path]!.trim() !== f.of(doc))
  const saveBar = (
    <Box key="save-bar" flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
      {dirty && [
        <Text key="unsaved" color="warning">Unsaved changes</Text>,
        <Button key="discard-config" variant="secondary" label="Discard" onPress={() => discard($)} />,
        <Button key="save-config" variant="primary" label="Save changes" onPress={() => saveAll($)} />,
      ]}
      {reload}
      {/* Repositories and queries are edited in the file: its $schema gives the editor checks and completion. */}
      <Button key="open-config" variant="secondary" label="Open in editor" onPress={() => openConfig($)} />
    </Box>
  )
  const saveRow = (_section: string) => null
  const newGroup = await read($, envDraft)
  const stateLine = state && (
    <Box flexDirection="row" columnGap={2} alignItems="center">
      {state.paused
        ? <Box key="schedule-state" flexDirection="row" columnGap={1} alignItems="center">{look.icon('pause', 'warning', 'paused')}<Text color="warning">{`Paused since ${when(state.paused)}`}</Text></Box>
        : <Box key="schedule-state" flexDirection="row" columnGap={1} alignItems="center">{look.icon('dot', 'success', 'running')}<Text color="success">Running</Text><Text dimColor>{state.next ? ` · next ${when(state.next)}` : ''}</Text></Box>}
      {state.paused
        ? <Button key="resume" variant="secondary" label="Resume" onPress={() => scheduleCommand($, ['resume'])} />
        : <Button key="pause" variant="secondary" label="Pause" onPress={() => scheduleCommand($, ['pause'])} />}
    </Box>
  )
  // A refusal can name every query it breaks: the first three say enough.
  const errorLines = saveError ? saveError.split('\n') : []
  return (
    <Box flexDirection="column" rowGap={1}>
      {card('file', 'logs', 'Config file', saveBar,
        <Box key="config-file"><Text dimColor>~/.on-my-watch/config.json</Text></Box>,
        <Box key="config-counts">
          <Text dimColor wrap="wrap">{[plural(repos.length, 'repository', 'repositories'), plural(queries.length, 'query', 'queries'), plural(envs, 'environment')].join(' · ')}</Text>
        </Box>,
        <Box key="config-state">
          <Text color={problems.length ? 'error' : 'success'}>{`${problems.length ? 'not valid' : 'valid'}${readAt ? ` · read ${time(readAt)}` : ''}`}</Text>
        </Box>,
        ...problems.slice(0, 3).map((p: string) => <Text key={`problem:${p}`} color="error" wrap="truncate-end">{p}</Text>),
        errorLines.length > 0 && (
          <Box key="config-error" flexDirection="column">
            <Text color="error" bold>Not saved:</Text>
            {errorLines.slice(0, 3).map((l: string, i: number) => <Text key={`error:${i}`} color="error" wrap="truncate-end">{l}</Text>)}
            {errorLines.length > 3 && <Text color="error">{`and ${errorLines.length - 3} more`}</Text>}
          </Box>
        ))}

      {card('watch', 'metrics', 'General', null,
        ...SETTINGS.filter(f => f.section === 'watch').flatMap(f => [setting(f),
          ...(f.path === 'window' ? [row('hint:window-row', '', <Box key="hint:window"><Text dimColor>A number and m, h or d: 15m, 4h, 7d</Text></Box>)] : [])]),
        saveRow('watch'))}

      {(() => {
        // Environment groups: each a name and the envs it covers, comma-separated; the panes show it as one.
        const rows = (groupRows ?? Object.entries((doc.environments ?? {}) as Record<string, string[]>).map(([n, m]) => [n, m.join(', ')])) as [string, string][]
        const setRows = (next: [string, string][]) => update($, envRows, () => next)
        const field = (key: string, value: string, hint: string, onInput: (v: string) => unknown, width?: number) => (
          <Box key={`fill:${key}`} {...(width ? { width, flexShrink: 0 } : { flexGrow: 1, minWidth: 0 })}>
            <ui.Input key={key} value={value} placeholder={hint} onInput={onInput} onSubmit={() => saveAll($)} />
          </Box>
        )
        // On the desktop each group is its name and chips, each taking effect at once; the terminal, which draws no
        // dropdown to pick from, types members as a comma-separated list.
        const chips = !look.isTerminal
        const known = [...new Set([...environments.flatMap(([, m]) => m), ...rows.flatMap(([, m]) => list(m))])]
        const change = (next: [string, string][]) => setRows(next).then(() => saveAll($))
        const removeButton = (i: number) => (
          <Button key={`env-remove:${i}`} plain dimColor hover={{ color: 'error' }} label="Remove" onPress={() => (chips ? change : setRows)(rows.filter((_, j) => j !== i))} />
        )
        const chip = (key: string, text: string, drop: () => unknown) => (
          <Box key={key} flexDirection="row" columnGap={1} alignItems="center" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text>{text}</Text>
            <Button key={`${key.replace(':', '-remove:')}`} plain dimColor label="×" onPress={drop} />
          </Box>
        )
        return card('envs', 'list', 'Environments', <Text dimColor>Shown as one in Watch</Text>,
          ...(rows.length ? [] : [<Box key="envs-none"><Text dimColor>No groups: each environment shows on its own.</Text></Box>]),
          ...rows.map(([name, members], i) => chips
            ? (
              <Box key={`env-row:${i}`} flexDirection="column" rowGap={1}>
                <Box flexDirection="row" columnGap={1} alignItems="center" justifyContent="space-between">
                  {field(`env-group:${i}`, name, 'Name', v => setRows(rows.map((r, j) => (j === i ? [v, r[1]] : r))), ENV_GROUP_WIDTH)}
                  {removeButton(i)}
                </Box>
                <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center">
                  {list(members).map(m => chip(`env-chip:${i}:${m}`, m, () => change(rows.map((r, j) => (j === i ? [r[0], list(r[1]).filter(x => x !== m).join(', ')] : r)))))}
                  {picker(`env-add:${i}`, '', [{ value: '', label: '+ add' }, ...known.filter(k => !list(members).includes(k)).map(k => ({ value: k, label: k }))], '',
                    (v: string) => v && change(rows.map((r, j) => (j === i ? [r[0], [...list(r[1]), v].join(', ')] : r))))}
                </Box>
              </Box>
            )
            : canType && narrow
              // Narrow: the name and Remove, then the members on a line of their own.
              ? (
                <Box key={`env-row:${i}`} flexDirection="column">
                  <Box flexDirection="row" columnGap={1} alignItems="center" justifyContent="space-between">
                    {field(`env-group:${i}`, name, 'Name', v => setRows(rows.map((r, j) => (j === i ? [v, r[1]] : r))), ENV_GROUP_WIDTH)}
                    {removeButton(i)}
                  </Box>
                  {field(`env-members:${i}`, members, 'Production, Canary', v => setRows(rows.map((r, j) => (j === i ? [r[0], v] : r))))}
                </Box>
              )
              : (
                <Box key={`env-row:${i}`} flexDirection="row" columnGap={1} alignItems="center">
                  {canType ? [
                    field(`env-group:${i}`, name, 'Name', v => setRows(rows.map((r, j) => (j === i ? [v, r[1]] : r))), ENV_GROUP_WIDTH),
                    field(`env-members:${i}`, members, 'Production, Canary', v => setRows(rows.map((r, j) => (j === i ? [r[0], v] : r)))),
                  ] : <Text>{`${name}: ${members}`}</Text>}
                  {removeButton(i)}
                </Box>
              )),
          canType && (
            <Box key="env-row:new" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center">
              {field('env-group-new', newGroup.name, 'Name, such as Production', v => update($, envDraft, x => ({ ...x, name: v })), ENV_GROUP_WIDTH)}
              {chips
                ? picker('env-new-first', '', [{ value: '', label: 'Pick an environment' }, ...known.map(k => ({ value: k, label: k }))], list(newGroup.members)[0] ?? '',
                  (v: string) => update($, envDraft, x => ({ ...x, members: v })))
                : field('env-members-new', newGroup.members, 'Production, Canary', v => update($, envDraft, x => ({ ...x, members: v })))}
              <Button key="env-add" variant="primary" label="Add" onPress={async () => {
                if (!newGroup.name.trim() || !list(newGroup.members).length) return update($, configError, () => 'A group needs a name and at least one environment.')
                await (chips ? change : setRows)([...rows, [newGroup.name.trim(), newGroup.members]])
                await update($, envDraft, () => ({ name: '', members: '' }))
              }} />
            </Box>
          ))
      })()}

      {card('prs', 'merged', 'Pull requests', null,
        ...(look.isTerminal
          ? [...SETTINGS.filter(f => f.section === 'prs').map(setting),
            row('hint:bots-row', '', <Box key="hint:bots"><Text dimColor>Separate usernames with commas: dependabot, renovate</Text></Box>)]
          // On the desktop, a chip per bot; typing a name and Enter adds one.
          : [row('bots', 'Bots', <Box key="bot-chips" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center">
            {((doc.bots ?? ['dependabot']) as string[]).map(b => (
              <Box key={`bot-chip:${b}`} flexDirection="row" columnGap={1} alignItems="center" borderStyle="round" borderColor="subtle" paddingX={1}>
                <Text>{b}</Text>
                <Button key={`bot-chip-remove:${b}`} plain dimColor label="×"
                  onPress={() => saveConfig($, ['set', 'bots', JSON.stringify(((doc.bots ?? ['dependabot']) as string[]).filter(x => x !== b))]).then(() => saveAll($))} />
              </Box>
            ))}
            {canType && <Box key="fill:bot-add" width={16} flexShrink={0}>
              <ui.Input key="bot-add" value="" placeholder="+ add a bot"
                onSubmit={(v: string) => v.trim() && saveConfig($, ['set', 'bots', JSON.stringify([...new Set([...((doc.bots ?? ['dependabot']) as string[]), v.trim()])])]).then(() => saveAll($))} />
            </Box>}
          </Box>)]),
        saveRow('prs'))}

      {card('notify', 'bell', 'Panes and notifications', muteControl(ui, look, $, await read($, muted)),
        row('panes', 'Show', toggle('panes.watch', 'Watch', doc.panes?.watch !== false), toggle('panes.pull_requests', 'Pull requests', doc.panes?.pull_requests !== false)),
        row('notify', 'Notify', toggle('notify.watch', 'Watch', doc.notify?.watch === true), toggle('notify.pull_requests', 'Pull requests', doc.notify?.pull_requests === true)))}

      {card('schedule', 'schedule', 'Schedule', stateLine,
        ...(!doc.schedule ? [<Text key="no-schedule" dimColor>No schedule yet.</Text>] : [
          group('watch-schedule', 'Watch'),
          cronPicker('', doc.schedule),
          look.divider('sep:prs-schedule'),
          group('prs-schedule', 'Pull requests'),
          cronPicker('prs', doc.pullRequestsSchedule ?? doc.schedule, [{ value: 'default', label: 'Same as Watch' }], !doc.pullRequestsSchedule && custom !== 'prs'),
          ...(ownSchedules(doc).length ? [
            look.divider('sep:own'),
            group('own', 'Own schedules'),
            ...ownSchedules(doc).map(o => (
              <Box key={`own:${o.entry}`} flexDirection="column" rowGap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
                <Text wrap="truncate-end">{o.entry.split('|').filter(Boolean).join(' › ')}</Text>
                {cronPicker(o.entry, o.schedule, [{ value: 'default', label: 'Same as every query' }])}
              </Box>
            )),
          ] : []),
        ]))}

    </Box>
  )
}

// The engine caps a process at 10 minutes; a scheduled run has no cap.
async function checker($: any, args: string[], stdin?: string) {
  const script = `${$.plugin.root}/bin/on_my_watch.py`
  const timeoutMs = args[0] === 'run' ? 600_000 : 30_000
  // Windows has no /usr/bin/env and names it python; its own PATH already finds the tools.
  if ((await $.env.get('OS')) === 'Windows_NT') return $.process.run(['python', script, ...args], { timeoutMs, stdin })
  const path = [await $.env.get('PATH'), TOOL_DIRS].filter(Boolean).join(':')
  return $.process.run(['/usr/bin/env', 'python3', script, ...args], { env: { PATH: path }, timeoutMs, stdin })
}

async function load($: any) {
  const done = await checker($, ['latest'])
  if (done.exitCode !== 0) return
  const latest = JSON.parse(done.stdout || '{}')
  await update($, result, () => (latest.checkedAt || latest.prsCheckedAt ? latest : null))
  const quiet = await checker($, ['notifications', 'status'])
  if (quiet.exitCode === 0) {
    const state = JSON.parse(quiet.stdout || '{}')
    await update($, muted, () => state.muted === true)
    await update($, quietEntries, () => state.quiet ?? [])
  }
  const scheduled = await checker($, ['schedule', 'status'])
  if (scheduled.exitCode === 0) await update($, scheduleState, () => JSON.parse(scheduled.stdout || 'null'))
  // Pictures change only when pull requests are fetched: read them again only then, not every minute.
  if (latest.prsCheckedAt && latest.prsCheckedAt !== picturesFor) {
    const pictures = await checker($, ['avatars'])
    if (pictures.exitCode === 0) {
      await update($, avatars, () => JSON.parse(pictures.stdout || '{}'))
      picturesFor = latest.prsCheckedAt
    }
  }
}
// The pull request fetch the pictures in `avatars` were read after.
let picturesFor: string | undefined

// `panes` in ~/.on-my-watch/config.json; a pane left out is on.
// Every environment the config knows, as [group, members]: the Environments section's groups in its order, then each
// env the queries use that no group names, on its own. The Watch filter, the query form and the counts all read this.
function environmentList(doc: any): [string, string[]][] {
  const groups = Object.entries((doc?.environments ?? {}) as Record<string, string[]>).filter(([, m]) => Array.isArray(m))
  const named = new Set(groups.flatMap(([, m]) => m))
  const loose = [...new Set(((doc?.repos ?? []) as any[]).flatMap(r => r?.queries ?? []).map((q: any) => q.env).filter(Boolean))] as string[]
  return [...groups, ...loose.filter(e => !named.has(e)).map(e => [e, [e]] as [string, string[]])]
}

async function readPanes($: any) {
  let panes: Partial<Record<Part, boolean>> = {}
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const config = JSON.parse(await $.fs.read(`${home}/.on-my-watch/config.json`))
    panes = config.panes ?? {}
    await update($, configDoc, () => config)
    // A refusal belongs to the file it was made against: a fresh read leaves it behind.
    await update($, configError, () => '')
    await update($, configReadAt, () => new Date().toISOString())
    const checked = await checker($, ['validate'])
    const verdict = checked.stdout.trim()
    await update($, configProblems, () => (checked.exitCode === 0 && verdict === 'config.json holds to the schema' ? [] : (verdict || checked.stderr.trim()).split('\n')))
    const repos = (Array.isArray(config.repos) ? config.repos : []) as any[]
    const queries = repos.flatMap(repo => repo?.queries ?? [])
    const distinct = (values: unknown[]) => [...new Set(values.filter(v => v !== undefined && v !== null && v !== ''))]
    await update($, choices, () => ({
      names: repos.map(repo => repo?.name).filter(Boolean),
      // A grouped env shows as its group, once; the rest as themselves.
      envs: environmentList(config).map(([group]) => group),
      envGroups: (config.environments && typeof config.environments === 'object' ? config.environments : {}) as Record<string, string[]>,
      // The priorities the queries use, most urgent first, by name: High, Medium, Low.
      priorities: (distinct(queries.map((q: any) => q.priority)) as number[]).sort((a, b) => a - b).map(n => PRIORITY_NAMES[n - 1] ?? `P${n}`),
      bots: Array.isArray(config.bots) ? config.bots : ['dependabot'],
    }))
  } catch {} // no config yet: both panes, the Watch one saying where it goes
  return { watch: panes.watch !== false, pull_requests: panes.pull_requests !== false }
}

async function show($: any) {
  try {
    await load($)
    const on = await readPanes($)
    for (const part of ['watch', 'pull_requests'] as const) if (on[part]) await $.ui.open(PANES[part])
    await $.ui.open(CONFIG_PANE)
    // The last pane opened is shown, and opening an open one only retitles it: focus brings Watch to the front.
    if (on.watch) await $.ui.open({ ...PANES.watch, focus: true })
  } catch (error) {
    $.ui.toast(`on-my-watch: ${String(error)}`)
  }
}

// Set only by a run this load of the module started. State outlives a reload but the run doesn't, so a `running`
// flag with this unset is left over from before the reload and must not hold Refresh back.
let runHere = false

async function checkNow($: any, part: Part | 'all') {
  if (runHere) return // one run at a time
  runHere = true
  await update($, running, () => part)
  await update($, runningSince, () => new Date().toISOString())
  try {
    const chosen = part === 'pull_requests' ? '' : await read($, watchWindow)
    const done = await checker($, [...(part === 'all' ? ['run'] : ['run', part]), ...(chosen ? ['--window', chosen] : [])])
    if (done.exitCode !== 0) $.ui.toast(`on-my-watch: check failed: ${done.stderr.trim().split('\n').pop()}`)
    await load($)
  } finally {
    runHere = false
    await update($, running, () => null)
  }
}

// pup signs in through the browser and waits for it, up to the engine's 10-minute cap; then Watch checks again.
async function signIn($: any) {
  const path = [await $.env.get('PATH'), TOOL_DIRS].filter(Boolean).join(':')
  const done = await $.process.run(['pup', 'auth', 'login'], { env: { PATH: path }, timeoutMs: 600_000 })
  if (done.exitCode !== 0) return $.ui.toast(`on-my-watch: sign-in failed: ${done.stderr.trim().split('\n').pop()}`)
  await checkNow($, 'watch')
}

// Opt-in AI: nothing reaches Claude until Investigate is pressed. `investigate` in the config picks the
// session (a new one by default, or this one), a skill the problem is handed to, and the `prompt` and
// `problem` templates; a query's own `investigate` overrides each template for its problem.
async function investigate($: any, r: Result, problems: Problem[], surface: string) {
  const first = problems[0]!
  const config = (await read($, configDoc)) as any
  const options = config?.investigate ?? {}
  const own = (config?.repos ?? []).find((c: any) => c.name === first.name)?.queries
    ?.find((q: any) => q.service === first.service && q.env === first.env && q.label === first.label)?.investigate ?? {}
  const prompt = own.prompt ?? options.prompt
  const problem = own.problem ?? options.problem
  const fill = (template: string, values: Record<string, unknown>) =>
    template.replace(/\{\{(\w+)\}\}/g, (all, name) => (name in values ? String(values[name] ?? '') : all))
  const lines = problems.map(p => problem
    ? fill(problem, { name: p.name, repo: p.repo, env: p.env, priority: p.priority != null ? `P${p.priority}` : '', service: p.service,
      label: p.label, value: p.value, alert: p.alert, source: p.source, query: p.query, link: p.link })
    : `- ${p.priority != null ? `P${p.priority} ` : ''}${p.service ? `${p.service}: ` : ''}${p.label} is ${p.value}${p.alert ? ` (${p.alert})` : ''}, ${p.source} query \`${p.query}\`. Datadog: ${p.link}`)
  const body = prompt
    ? fill(prompt, { name: first.name, repo: first.repo, env: first.env, window: r.window, checkedAt: r.checkedAt,
      from: r.span?.from, to: r.span?.to, problems: lines.join('\n') })
    : [`Investigate ${first.name} (${first.repo}) in ${first.env}, in the ${r.window} before ${r.checkedAt ?? 'the last check'}.`, ...lines].join('\n')
  if (options.session !== 'current' && (await openSession($, options.skill ? `/${options.skill} ${body}` : body, surface))) return
  if (options.skill) await $.command.run({ command: options.skill, args: body })
  else await $.prompt.submit({ text: body })
}

// A new interactive session in this session's folder: the desktop app's own link, or a Terminal window.
// shortcut: macOS only (`open`, Terminal.app); elsewhere the command fails and Investigate stays in this session.
async function openSession($: any, text: string, surface: string) {
  const cwd = await $.session.cwd()
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const argv = surface === 'terminal'
    ? ['osascript', '-e', 'on run argv', '-e', 'tell application "Terminal" to activate', '-e', 'tell application "Terminal" to do script (item 1 of argv)', '-e', 'end run',
      // $'…' keeps the prompt's lines on one command line, so Terminal runs it as typed.
      `cd ${quote(cwd)} && claude $'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`]
    : ['open', `claude://code/new?${new URLSearchParams({ q: text, folder: cwd })}`]
  try {
    if ((await $.process.run(argv)).exitCode === 0) return true
  } catch {}
  await $.ui.toast('on-my-watch: could not open a new session, investigating here')
  return false
}

// Opens a file or an address with the system's opener, on the machine Claude runs on. The terminal presses these in
// place of links: one without link support prints a link's whole URL beside its text.
async function openWith($: any, target: string) {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  for (const argv of windows ? [['cmd', '/c', 'start', '', target]] : [['open', target], ['xdg-open', target]]) {
    try {
      if ((await $.process.run(argv)).exitCode === 0) return
    } catch {}
  }
  $.ui.toast(`on-my-watch: could not open ${target}`)
}
async function openConfig($: any) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  await openWith($, `${home}/.on-my-watch/config.json`)
}

// Mutes every notification, Watch and Pull requests alike, scheduled runs included, until unmuted.
async function toggleMute($: any) {
  const done = await checker($, ['notifications', (await read($, muted)) ? 'on' : 'off'])
  if (done.exitCode === 0) await update($, muted, () => JSON.parse(done.stdout || '{}').muted === true)
}

// One entry's notifications on or off; the general Mute still silences everything.
const entryKey = (p: Problem) => `${p.name}|${p.service}|${p.env}|${p.label}`
async function toggleEntry($: any, p: Problem) {
  const off = (await read($, quietEntries)).includes(entryKey(p))
  const done = await checker($, ['notifications', off ? 'loud' : 'quiet', entryKey(p)])
  if (done.exitCode === 0) await update($, quietEntries, () => JSON.parse(done.stdout || '{}').quiet ?? [])
}

async function openHistory($: any) {
  const done = await checker($, ['history'])
  if (done.exitCode === 0) await update($, runs, () => JSON.parse(done.stdout || '[]'))
  await update($, watchView, () => 'history')
}

// Pause and resume write a flag file the scheduled run reads: the schedule itself stays installed.
async function scheduleCommand($: any, args: string[]) {
  const done = await checker($, ['schedule', ...args])
  if (done.exitCode !== 0) return done.stderr.trim().split('\n').pop() || 'the schedule could not be changed'
  await update($, scheduleState, () => JSON.parse(done.stdout))
  return ''
}

// A cron line for every query (entry '') or one query's own; 'default' drops a query's own.
// A cron line into the draft: '' is Watch's, 'prs' the pull requests', else a query's own by its entry; 'default' drops it.
async function setSchedule($: any, cron: string, entry: string) {
  const doc = ((await read($, configDraft)) ?? (await read($, configDoc))) as any
  const path = entry === '' ? 'schedule' : entry === 'prs' ? 'pullRequestsSchedule'
    : ownSchedules(doc).find(o => o.entry === entry)?.path
  if (path) await saveConfig($, cron === 'default' ? ['delete', path] : ['set', path, JSON.stringify(cron.trim())])
  await update($, customFor, () => null)
}
// The queries with a schedule of their own: where each sits in the config, its entry, and its cron line.
function ownSchedules(doc: any) {
  return ((doc?.repos ?? []) as any[]).flatMap((r, i) => ((r?.queries ?? []) as any[]).map((q, j) => ({ q, j }))
    .filter(({ q }) => q?.schedule)
    .map(({ q, j }) => ({ path: `repos.${i}.queries.${j}.schedule`, entry: [r.name, q.service, q.env, q.label].join('|'), schedule: q.schedule as string })))
}

async function openRun($: any, id: number) {
  const done = await checker($, ['show', String(id)])
  if (done.exitCode !== 0) return $.ui.toast(`on-my-watch: run ${id} could not be read`)
  await update($, archived, () => JSON.parse(done.stdout))
  await update($, watchView, () => 'archived')
}

const window = (span?: { from: string; to: string }) => (span ? `${time(span.from)}–${time(span.to)}` : '')
// A run's day as people say it: Today, Yesterday, else the weekday and date.
function day(iso: string) {
  const at = new Date(iso)
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const ago = Math.round((start(new Date()) - start(at)) / 86_400_000)
  return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}
// A row's runs from where its history begins.
const fromStart = (all: (number | null)[]) => all.slice(Math.max(0, all.findIndex(v => v != null)))
// Two counts draw a hook, not a trend: a row's chart waits for a third.
const charted = (p: Problem) => !!p.trend && !p.trend.isNew && p.trend.values.filter(v => v != null).length >= 3
const sinceText = (p: Problem) => (p.trend?.since && !p.trend.isNew ? `since ${short(p.trend.since)}` : '')
// Each value placed between the lowest and highest of the values and the threshold, 0 to 1; null stays null.
function spark(all: (number | null)[], threshold?: number | null) {
  const values = fromStart(all)
  const seen = [...values, threshold].filter((v): v is number => v != null)
  const low = Math.min(...seen), span = Math.max(...seen) - low
  const at = (v: number) => (span ? (v - low) / span : 0.5)
  return { points: values.map(v => (v == null ? null : at(v))), line: threshold == null ? null : at(threshold) }
}
// A tinted box in the priority's colour: the threshold dashed, the runs as a line with the area under it shaded.
// A run with no count (stored before every count was kept) breaks the line.
function sparkSvg(values: (number | null)[], hex: string, threshold: number | null | undefined, width: number) {
  const pad = 3, h = 20, { points, line } = spark(values, threshold)
  const x = (i: number) => (points.length > 1 ? pad + (i * (width - 2 * pad)) / (points.length - 1) : width - pad)
  const y = (v: number) => h - pad - v * (h - 2 * pad)
  const runs: [number, number][][] = [[]]
  points.forEach((v, i) => (v == null ? runs.push([]) : runs.at(-1)!.push([x(i), y(v)])))
  const xy = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`
  const marks = runs.filter(r => r.length).map(r => (r.length > 1
    ? `<path d="M${r[0]![0].toFixed(1)},${h - pad} L${r.map(xy).join(' L')} L${r.at(-1)![0].toFixed(1)},${h - pad} Z" fill="${hex}" fill-opacity="0.12"/>`
      + `<polyline points="${r.map(xy).join(' ')}" fill="none" stroke="${hex}" stroke-width="1.5" stroke-linejoin="round"/>`
    : `<circle cx="${r[0]![0].toFixed(1)}" cy="${r[0]![1].toFixed(1)}" r="1.4" fill="${hex}"/>`))
  const last = points.at(-1) == null ? null : [x(points.length - 1), y(points.at(-1)!)] as [number, number]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}">`
    + `<rect width="${width}" height="${h}" rx="4" fill="${hex}" fill-opacity="0.08"/>`
    + (line == null ? '' : `<line x1="${pad}" y1="${y(line).toFixed(1)}" x2="${width - pad}" y2="${y(line).toFixed(1)}" stroke="${hex}" stroke-opacity="0.55" stroke-dasharray="2 2"/>`)
    + marks.join('') + (last ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${hex}"/>` : '') + '</svg>'
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
function age(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}

const DAY = 86_400_000
// Rows drawn per page. The desktop app stops drawing a pane whose tree grows past what it takes: 60 closed pull
// requests with their reviewers' pictures drew, 90 did not, nor one repository's 142 queries in Config.
const PAGE = 30
// Page numbers under a long list: ‹ 1 2 3 … 10 ›, the page shown as the main button. Nothing for one page.
function pager(ui: any, key: string, page: number, pages: number, go: (n: number) => unknown) {
  if (pages <= 1) return null
  const shown = pages <= 7 ? Array.from({ length: pages }, (_, i) => i + 1)
    : [...new Set([1, page - 1, page, page + 1, pages].filter(n => n >= 1 && n <= pages))].sort((a, b) => a - b)
  const items: unknown[] = []
  if (page > 1) items.push(<ui.Button key={`${key}-prev`} variant="secondary" label="‹" onPress={() => go(page - 1)} />)
  shown.forEach((n, i) => {
    if (i > 0 && n - shown[i - 1]! > 1) items.push(<ui.Text key={`${key}-gap:${n}`} dimColor>…</ui.Text>)
    items.push(<ui.Button key={`${key}:${n}`} variant={n === page ? 'primary' : 'secondary'} label={String(n)} onPress={() => go(n)} />)
  })
  if (page < pages) items.push(<ui.Button key={`${key}-next`} variant="secondary" label="›" onPress={() => go(page + 1)} />)
  return <ui.Box key={`${key}-pager`} flexDirection="row" columnGap={1} alignItems="center" marginTop={1}>{items}</ui.Box>
}
// When a refresh last ran, as the panes say it: `Last refresh 16:02`, or with the day when not today.
// A time today, else with its day: a time alone from yesterday would read as later than today's.
const when = (iso: string) => (day(iso) === 'Today' ? time(iso) : `${day(iso)} ${time(iso)}`)
// The same, short enough for a row: a weekday this week, else the date.
const short = (iso: string) => {
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000
  const on = day(iso) === 'Today' ? '' : days < 6 ? new Date(iso).toLocaleDateString([], { weekday: 'short' }) : new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' })
  return on ? `${on} ${time(iso)}` : time(iso)
}
const refreshed = (iso: string) => `Last refresh ${when(iso)}`
const SPANS = [
  { value: 'today', label: 'Today', since: () => new Date().setHours(0, 0, 0, 0) },
  { value: '3d', label: 'Last 3 days', since: () => Date.now() - 3 * DAY },
  { value: 'week', label: 'Last week', since: () => Date.now() - 7 * DAY },
  { value: 'month', label: 'Last month', since: () => Date.now() - 30 * DAY },
]
// What Refresh checks in Watch; empty is the config's window, which the schedule always uses.
const WINDOWS = [
  { value: '', label: 'Config window' },
  { value: '1m', label: 'Last minute' },
  { value: '5m', label: 'Last 5 minutes' },
  { value: '15m', label: 'Last 15 minutes' },
  { value: '30m', label: 'Last 30 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '4h', label: 'Last 4 hours' },
  { value: '12h', label: 'Last 12 hours' },
  { value: '1d', label: 'Last day' },
  { value: '7d', label: 'Last 7 days' },
]
// Below this many cells a Watch row's label and its facts don't fit on one line: priority, label, icon, value, an
// alert line such as `above 19` and the bell take about this much.
const NARROW = 64
const WIDE = 100
// A chart's column, in cells; the long one, on a narrow row's own line, is twice that.
const CHART_CELLS = 10
// A run's window in words, as the picker names it: `1h` is "last hour".
const windowLabel = (w: string) => (WINDOWS.find(o => o.value === w)?.label ?? `Last ${w}`).toLowerCase()
// A dropdown where the surface draws one and isn't a terminal; else a button that steps to the next value.
function pickerFor(ui: any, surface: string) {
  const Select = 'Select' in ui && surface !== 'terminal' ? ui.Select : undefined
  const { Button } = ui
  return (key: string, hotkey: string, options: readonly { value: string; label: string }[], value: string, set: (v: string) => unknown) => {
    if (Select) return <Select key={key} options={options} value={value} onSelect={(v: string) => set(v)} />
    const at = Math.max(0, options.findIndex(o => o.value === value))
    return <Button key={key} plain hotkey={hotkey || undefined} label={options[at]!.label} onPress={() => set(options[(at + 1) % options.length]!.value)} />
  }
}
// A pull request idle this many days has stalled: its idle time turns amber.
const STALE_DAYS = 7
// Whose move it is on an open pull request, and in which tone.
function waitingOn(pr: PullRequest, me: string | null): readonly [string, Tone] | null {
  const pending = (pr.reviewers ?? []).filter(r => r.review === 'pending').map(r => r.login)
  if (pr.conflicts) return ['Conflicts', 'warning']
  if (pr.review === 'CHANGES_REQUESTED') return ['Changes requested', 'error']
  if (pr.draft) return ['Draft', 'muted']
  if (pr.review === 'APPROVED' && pr.ci !== 'failing') return ['Ready to merge', 'success']
  if (me && pending.includes(me)) return ['Waiting on you', ACCENT]
  if (pending.length) return [`Waiting on ${pending[0]}${pending.length > 1 ? ` +${pending.length - 1}` : ''}`, 'muted']
  return ['Waiting on review', 'muted']
}
// Open and on you: your review is asked for, or it is yours and changes were asked for or CI is red.
const needsYou = (pr: PullRequest, me: string | null) => !!me && (pr.state ?? 'OPEN') === 'OPEN' && (
  (pr.reviewers ?? []).some(r => r.review === 'pending' && r.login === me)
  || (pr.author === me && (pr.review === 'CHANGES_REQUESTED' || pr.ci === 'failing')))
// A PR opened in the last day gets the "new" mark.
const isNew = (pr: PullRequest) => Date.now() - new Date(pr.createdAt).getTime() < DAY

// When a PR last moved: closed ones when they closed, open ones when last updated.
const moved = (pr: PullRequest) => pr.closedAt ?? pr.updatedAt ?? pr.createdAt
const freshest = (a: PullRequest, b: PullRequest) => moved(b).localeCompare(moved(a))

// PRs active in the span, grouped by repo; repos and PRs freshest first.
function repos(prs: PullRequest[], chosen: string, bots: string[], state: string) {
  const since = (SPANS.find(s => s.value === chosen) ?? SPANS[1]!).since()
  // Runs stored before `state` existed held open PRs only.
  const inState = prs.filter(pr => (pr.state ?? 'OPEN') === state.toUpperCase())
  const fresh = inState
    .filter(pr => new Date(moved(pr)).getTime() >= since)
    // gh names bot accounts app/<name>; the config names them bare, in any case.
    .filter(pr => !bots.includes(pr.author?.replace(/^app\//, '').toLowerCase() ?? ''))
    .sort(freshest)
  const byRepo = new Map<string, PullRequest[]>()
  for (const pr of fresh) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr])
  return { groups: [...byRepo], shown: fresh.length }
}


// Our own icons: 16x16, one colour. An Svg is an image and can't take theme colours, so each tone has a mid
// hex that reads on light and dark; the terminal, which draws no Svg, gets the glyph in the theme colour.
const TONES = {
  error: ['#D0485C', 'error'],
  warning: ['#C48A00', 'warning'],
  success: ['#2F9E44', 'success'],
  merged: ['#8957E5', 'merged'],
  accent: ['#D97757', 'claude'],
  info: ['#4C6EF5', 'suggestion'],
  muted: ['#8A8A8A', 'inactive'],
} as const
type Tone = keyof typeof TONES
const stroke = 'fill="none" stroke="C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
const ICONS = {
  dot: ['<circle cx="8" cy="8" r="4.5" fill="C"/>', '●'],
  check: [`<path ${stroke} d="M3 8.5l3 3 7-7"/>`, '✓'],
  cross: [`<path ${stroke} d="M4 4l8 8M12 4l-8 8"/>`, '✗'],
  ring: [`<circle ${stroke} cx="8" cy="8" r="5"/>`, '○'],
  draft: [`<circle ${stroke} stroke-dasharray="2.5 2" cx="8" cy="8" r="5"/>`, '◌'],
  merged: [`<g ${stroke}><circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11.5" cy="8.5" r="1.6"/><path d="M5 5.1v5.8M5 5.5c0 2.5 4.8 1.2 4.9 3"/></g>`, '●'],
  closed: [`<g ${stroke}><circle cx="8" cy="8" r="5"/><path d="M4.5 11.5l7-7"/></g>`, '⊘'],
  spark: ['<path fill="C" d="M8 1.5l1.7 4.8 4.8 1.7-4.8 1.7L8 14.5l-1.7-4.8L1.5 8l4.8-1.7z"/>', '✦'],
  warning: ['<path fill="C" d="M8 1.8l6.6 11.7H1.4z"/>', '!'],
  error: [`<g><circle fill="C" cx="8" cy="8" r="6.5"/><path stroke="#fff" stroke-width="1.8" stroke-linecap="round" d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/></g>`, '✗'],
  bell: [`<g ${stroke}><path d="M4 11.5h8l-1-1.6V7a3 3 0 0 0-6 0v2.9z"/><path d="M7 13.6h2"/></g>`, '!'],
  logs: [`<g ${stroke}><path d="M4 1.8h5l3 3v9.4H4z"/><path d="M6 8h4M6 10.6h4"/></g>`, ''],
  metrics: [`<g ${stroke}><path d="M2 13.5h12"/><path d="M2.5 10.5l3-3.5 2.8 2.2L13.5 3"/></g>`, ''],
  traces: ['<g fill="C"><rect x="1.5" y="2.2" width="9" height="2.8" rx="1.2"/><rect x="4.5" y="6.6" width="8.5" height="2.8" rx="1.2"/><rect x="8" y="11" width="6.5" height="2.8" rx="1.2"/></g>', ''],
  history: [`<g ${stroke}><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.6"/></g>`, ''],
  group: [`<g ${stroke}><rect x="2" y="2" width="12" height="5" rx="1.5"/><rect x="2" y="9" width="12" height="5" rx="1.5"/></g>`, ''],
  list: [`<path ${stroke} d="M2.5 4h11M2.5 8h11M2.5 12h11"/>`, ''],
  schedule: [`<g ${stroke}><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4M8 8.6v2.2l1.5 1"/></g>`, ''],
  pause: ['<g fill="C"><rect x="4" y="3" width="3" height="10" rx="0.8"/><rect x="9" y="3" width="3" height="10" rx="0.8"/></g>', ''],
  play: ['<path fill="C" d="M5 2.8v10.4L13 8z"/>', ''],
  bellOff: [`<g ${stroke}><path d="M4 11.5h8l-1-1.6V7a3 3 0 0 0-6 0v2.9z"/><path d="M7 13.6h2M2.5 2.5l11 11"/></g>`, ''],
  // A dog's face: the watch dog that investigates.
  comment: [`<path ${stroke} d="M2.5 3.5h11v7.5H8l-3 2.5V11H2.5z"/>`, ''],
  investigate: [`<g ${stroke}><path d="M4.6 6C4 3.6 2 3.8 1.8 6c-.2 2 .5 3.6 1.8 4.2"/><path d="M11.4 6c.6-2.4 2.6-2.2 2.8 0 .2 2-.5 3.6-1.8 4.2"/><path d="M4.3 7.4c0-2.3 1.7-3.6 3.7-3.6s3.7 1.3 3.7 3.6v3.2c0 1.9-1.7 3.2-3.7 3.2s-3.7-1.3-3.7-3.2z"/></g><g fill="C"><circle cx="6.4" cy="8.3" r=".85"/><circle cx="9.6" cy="8.3" r=".85"/><ellipse cx="8" cy="11" rx="1.3" ry=".95"/></g>`, ''],
} as const
// What the terminal presses in place of a control's icon.
const MARKS = { investigate: '✻', bell: '◉', bellOff: '◯', history: 'History' } as const
type IconName = keyof typeof ICONS
// Wider than any pane: an Svg with no width takes its own width up to the slot, so it fills the line.
const HAIRLINE = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1"><rect width="4000" height="1" fill="${'#8A8A8A'}" fill-opacity="0.35"/></svg>`
const BADGES = {
  approved: `<circle cx="15" cy="15" r="4.5" fill="${'#2F9E44'}" stroke="#fff" stroke-width="1"/><path d="M13 15.2l1.4 1.4 2.6-2.8" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  changes: `<circle cx="15" cy="15" r="4.5" fill="${'#D0485C'}" stroke="#fff" stroke-width="1"/><path d="M13.4 13.4l3.2 3.2M16.6 13.4l-3.2 3.2" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>`,
  pending: '',
} as const
const avatarSvg = (login: string, review: keyof typeof BADGES, picture?: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs><clipPath id="c"><circle cx="9" cy="9" r="8"/></clipPath></defs>` +
  (picture
    ? `<image href="${picture}" x="1" y="1" width="16" height="16" clip-path="url(#c)"/>`
    : `<circle cx="9" cy="9" r="8" fill="#8A8A8A"/><text x="9" y="12.5" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#fff">${login.slice(0, 1).toUpperCase()}</text>`) +
  `${BADGES[review]}</svg>`
const svg = (name: IconName, tone: Tone) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${ICONS[name][0].replaceAll('"C"', `"${TONES[tone][0]}"`)}</svg>`

const REVIEW = {
  APPROVED: ['check', 'success', 'approved'],
  CHANGES_REQUESTED: ['cross', 'error', 'changes requested'],
  REVIEW_REQUIRED: ['ring', 'warning', 'waiting for review'],
} as const
const CI = { passing: ['dot', 'success', 'ci ok'], failing: ['dot', 'error', 'ci failing'], running: ['dot', 'warning', 'ci running'] } as const
// What the terminal writes for a mark; empty means the mark is only decoration there.
const WORDS: Record<IconName, string> = {
  dot: '', check: 'approved', cross: 'changes', ring: 'review', draft: 'draft', merged: 'merged', closed: 'closed',
  spark: 'new', warning: '', bell: '', bellOff: '', investigate: '', comment: '', error: '', logs: '', metrics: '', traces: '', history: '', group: '', list: '', schedule: '', pause: '', play: '',
}

const review = (pr: PullRequest) =>
  pr.state === 'MERGED' ? (['merged', 'merged', 'merged'] as const)
    : pr.state === 'CLOSED' ? (['closed', 'muted', 'closed'] as const)
      : pr.draft ? (['draft', 'muted', 'draft'] as const) : pr.review ? REVIEW[pr.review] : null

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'watch', description: 'Show your services and pull requests' })
    // State outlives a reload but the run that set this flag doesn't: left set, Refresh would never come back.
    await update($, running, () => null)
    // Runs land in the database from launchd; read the newest while the session runs.
    $.clock.every(60_000, () => load($))
    if (e.surface || (await $.session.surfaces()).length > 0) await show($)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await show($)

    return attached
  })

  on('command.run', { command: 'watch' }, async $ => {
    await show($)

    return { text: 'On my watch opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANES.watch.id }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    const look = surfaceLook(ui, e.surface)
    const picker = pickerFor(ui, e.surface)
    const latestRun = await read($, result)
    const busy = await read($, running)
    const view = await read($, watchView)
    const since = await read($, runningSince)
    const refresh = (part: Part | 'all') => refreshControl(ui, look, $, part, busy, since)
    // A full button, not plain: the desktop draws a plain one with a hotkey as a hint, easy to miss as clickable.
    const back = <Button key="latest" variant="secondary" hotkey={look.hotkey('l')} label="← Latest" onPress={() => update($, watchView, () => 'latest')} />

    if (!latestRun) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No runs yet. Put your config in ~/.on-my-watch/config.json, then check.</Text>
          <Box flexDirection="row">{refresh('all')}</Box>
        </Box>
      )
    }

    if (view === 'history') {
      const past = await read($, runs)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between"><Text bold>History</Text>{back}</Box>
          {past.length === 0 && <Text dimColor>No runs yet.</Text>}
          {/* Grouped by day; each run: when, the window it checked, then what it found. */}
          {past.flatMap((run, i) => [
            ...(i === 0 || day(run.checkedAt) !== day(past[i - 1]!.checkedAt)
              ? [<Box key={`day:${day(run.checkedAt)}`} marginTop={1}><Text bold dimColor>{day(run.checkedAt)}</Text></Box>]
              : [look.divider(`sep:run:${run.id}`)]),
            // Columns that line up down the list: when and the window, then each priority's count.
            <Box key={`row:${run.id}`} flexDirection="row" columnGap={1} alignItems="center">
              <Box key={`col:when:${run.id}`} width={HISTORY_WHEN_WIDTH} flexShrink={0}>
                <Button key={`run:${run.id}`} plain onPress={() => openRun($, run.id)}>
                  {`${time(run.checkedAt)}${run.span ? ` · ${window(run.span)}` : ''}`}
                </Button>
              </Box>
              {run.status === 'failed'
                // What went wrong, as the checker kept it: the fix it needs and what pup or gh said.
                ? <Box key={`reason:${run.id}`} flexDirection="row" columnGap={1} minWidth={0} flexShrink={1}>
                  <Text color="error">check failed</Text>
                  {run.reason && <Text dimColor wrap="truncate-end">{run.reason}</Text>}
                </Box>
                : !run.problems
                  ? <Text color="success">all clear</Text>
                  : [
                    // How many services each priority had failing; the words go to screen readers.
                    ...[1, 2, 3].map(rank => {
                      const n = (run.labels ?? []).filter(l => l.priority === rank).reduce((sum, l) => sum + l.count, 0)
                      return (
                        <Box key={`col:p${rank}:${run.id}`} width={HISTORY_COUNT_WIDTH} flexShrink={0} flexDirection="row" alignItems="center">
                          {n > 0 && [serviceIcon(ui, look, rank, n), <Text key="n">{String(n)}</Text>]}
                        </Box>
                      )
                    }),
                  ]}
            </Box>,
          ])}
        </Box>
      )
    }

    const stored = view === 'archived' ? ((await read($, archived)) ?? latestRun) : latestRun
    const [chosenPriority, chosenName, chosenEnv] = [await read($, priorityFilter), await read($, nameFilter), await read($, envFilter)]
    const known = await read($, choices)
    // Runs stored before entries had names carry service instead; they show under it until refreshed.
    const named = stored.problems.map(p => ({ ...p, name: p.name ?? (p as any).alias ?? (p as any).service }))
    const r = {
      ...stored,
      problems: named
        .filter(p => !chosenPriority || nameOf(p) === chosenPriority)
        .filter(p => !chosenName || p.name === chosenName)
        .filter(p => !chosenEnv || p.env === chosenEnv || (known.envGroups?.[chosenEnv] ?? []).includes(p.env)),
    }
    // The config's choices; before the config is read, those this run found.
    // Narrow panes put each row's facts under its label; the width is in character cells.
    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? 100
    const narrow = columns < NARROW
    // Wide rows also say since when and what they read; below that the label keeps the room.
    const wide = columns >= WIDE
    const quietOnes = await read($, quietEntries)
    const listed = <T,>(fromConfig: T[], found: T[]) => (fromConfig.length ? fromConfig : [...new Set(found)])
    const priorityOptions = [{ value: '', label: narrow ? 'Priority' : 'All priorities' }, ...listed(known.priorities, named.map(nameOf)).map(p => ({ value: p, label: p }))]
    const nameOptions = [{ value: '', label: narrow ? 'Repository' : 'All repositories' }, ...listed(known.names, named.map(p => p.name)).map(n => ({ value: n, label: n }))]
    const envOptions = [{ value: '', label: narrow ? 'Env' : 'All environments' }, ...listed(known.envs, named.map(p => p.env)).map(n => ({ value: n, label: n }))]

    // One card per name and environment; the most urgent first, a query without priority after all that have one.
    const rank = (p: Problem) => (p.priority == null ? Number.MAX_SAFE_INTEGER : p.priority)
    const cards: Problem[][] = [...r.problems.reduce((all, p) => all.set(`${p.name}@${p.env}`, [...(all.get(`${p.name}@${p.env}`) ?? []), p]), new Map<string, Problem[]>()).values()]
      .map(list => [...list].sort((a, b) => rank(a) - rank(b)))
    cards.sort((a, b) => rank(a[0]!) - rank(b[0]!) || a[0]!.name.localeCompare(b[0]!.name))
    // The history column fits the widest history on screen: every row lines up, no cell is left blank for a
    // longer one that isn't there.
    const historyCells = Math.max(3, ...r.problems.map(p => {
      const said = sinceText(p).length
      const drawn = charted(p) ? (look.isTerminal ? fromStart(p.trend!.values).length : CHART_CELLS) : 0
      return p.trend?.isNew ? 3 : drawn + (drawn && said ? 1 : 0) + said
    }))
    const pausedAt = (await read($, scheduleState))?.paused
    const controls = [
      pausedNote(ui, look, pausedAt),
      wide || look.isTerminal
        ? (
          <Box key="history-row" flexDirection="row" alignItems="center">
            {look.icon('history', 'muted', 'History')}
            <Button key="history" plain dimColor hotkey={look.hotkey('h')} label="History" onPress={() => openHistory($)} />
          </Box>
        )
        : look.control('history', 'history', 'History', () => openHistory($)),
    ]
    // The window is picked in the header, so the filters fit one line; picking one checks it right away.
    // The config's choice names the config's window; the last run's may be another, picked earlier.
    const configured = ((await read($, configDoc)) as any)?.window as string | undefined
    const windows = WINDOWS.map(o => (o.value === '' && configured ? { ...o, label: `Config: ${windowLabel(configured)}` } : o))
    const windowPicker = picker('window', 't', windows, await read($, watchWindow), async v => { await update($, watchWindow, () => v); await checkNow($, 'watch') })
    const checked = r.checkedAt ? (wide ? ` · ${refreshed(r.checkedAt)}` : ` · ${when(r.checkedAt)}`) : ''

    return (
      <Box flexDirection="column">
        {r.setup?.filter(s => s.tool === 'pup').map(s => (
          <Box key={`setup:${s.tool}`} flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
            <Text color="warning">{s.fix}</Text>
            {s.need === 'login' && <Button key="signin:pup" variant="secondary" label="Sign in" onPress={() => signIn($)} />}
          </Box>
        ))}
        {view === 'archived'
          ? (
            <Box key="archived" flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Text dimColor>{`Run ${r.checkedAt ? time(r.checkedAt) : ''}${r.span ? ` · ${window(r.span)}` : ''}`}</Text>
              {back}
            </Box>
          )
          : (
            // Line one: what the last check found, History and Refresh; line two: what to show and check.
            <Box key="watch" flexDirection="column">
              <Box key="header" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
                <Box flexDirection="row" flexShrink={1} minWidth={0} columnGap={1} alignItems="center" flexWrap="wrap">
                  {!r.checkedAt
                    ? <Text dimColor>not checked yet</Text>
                    : r.status === 'failed'
                      ? <Text color="error" bold>check failed</Text>
                      : r.problems.length
                        // How many services each priority has failing, the most urgent first.
                        ? <Box key="counts" flexDirection="row" columnGap={2} alignItems="center">
                          {[1, 2, 3, null].map(rank => [rank, r.problems.filter(p => (p.priority ?? null) === rank).length] as const)
                            .filter(([, n]) => n > 0)
                            .map(([rank, n]) => (
                              <Box key={`count:${rank}`} flexDirection="row" alignItems="center">
                                {serviceIcon(ui, look, rank, n)}<Text bold>{String(n)}</Text>
                              </Box>
                            ))}
                        </Box>
                        : <Text dimColor>Checked</Text>}
                  {windowPicker}
                  <Text dimColor>{checked}</Text>
                </Box>
                <Box flexDirection="row" columnGap={2} alignItems="center" flexShrink={0} flexGrow={1} justifyContent="flex-end">
                  {controls}
                  {refresh('watch')}
                </Box>
              </Box>
              {look.divider('sep:watch')}
              <Box key="filters" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center">
                {picker('priorities', 'p', priorityOptions, chosenPriority, v => update($, priorityFilter, () => v))}
                {picker('names', 'v', nameOptions, chosenName, v => update($, nameFilter, () => v))}
                {picker('envs', 'e', envOptions, chosenEnv, v => update($, envFilter, () => v))}
              </Box>
            </Box>
          )}

        {/* Nothing crossed a line: say so in the middle of where the cards would be. */}
        {r.checkedAt && r.status !== 'failed' && cards.length === 0 && (
          <Box key="clear" flexDirection="column" alignItems="center" marginY={2}>
            <Box flexDirection="row" columnGap={1} alignItems="center">
              {look.icon('check', 'success', 'all clear')}
              <Text color="success" bold>All clear</Text>
            </Box>
            <Text dimColor>No query crossed its alert line</Text>
          </Box>
        )}
        {cards.map(list => {
          const first = list[0]!
          const id = `card:${first.name}@${first.env}`
          return (
            // A card: name and environment under its most urgent priority, then one row per query over its line.
            <Box key={id} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1}>
              {/* Top-aligned: a title that wraps keeps its priority beside its first line. */}
              <Box key={`card-head:${first.name}@${first.env}`} flexDirection="row" columnGap={1} alignItems="flex-start">
                {priorityBadge(ui, look, first.priority, nameOf(first))}
                <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" flexWrap="wrap" columnGap={1}>
                  <Text bold wrap={narrow ? 'wrap' : 'truncate-end'}>{first.name}</Text>
                  <Text dimColor>{first.env}</Text>
                </Box>
              </Box>
              {/* Every service gets its heading, one query or many, so every card reads the same way. */}
              {[...new Set(list.map(p => p.service ?? ''))].flatMap(service => {
                const mine = list.filter(p => (p.service ?? '') === service)
                return [
                  ...(service ? [look.divider(`sep:${id}:${service}`), <Box key={`svc:${service}`} backgroundColor={look.isTerminal ? undefined : '#8A8A8A1A'} paddingX={look.isTerminal ? 0 : 1}><Text bold dimColor wrap="truncate-end">{service}</Text></Box>] : []),
                  ...mine.flatMap((p, i) => {
                    const off = quietOnes.includes(entryKey(p))
                    const bell = p.notify === false
                      ? <Box key="bell" flexShrink={0}>{look.icon('bellOff', 'muted', 'notifications off in the config', 'quiet')}</Box>
                      : (
                        <Box key="bell" flexDirection="row" alignItems="center" flexShrink={0}>
                          {look.control(`bell:${entryKey(p)}`, off ? 'bellOff' : 'bell', off ? 'notifications off' : 'notifications on', () => toggleEntry($, p))}
                        </Box>
                      )
                    const ask = (
                      <Box key="investigate" flexShrink={0}>
                        {look.control(`inv:${entryKey(p)}`, 'investigate', 'Investigate', () => investigate($, r, [p], e.surface))}
                      </Box>
                    )
                    const badge = priorityBadge(ui, look, p.priority, nameOf(p))
                    const label = (
                      // One text, so a long one is cut once at its end, not service and label each.
                      <Box key="label" flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
                        <Text wrap="truncate-end">
                          {p.label}
                        </Text>
                      </Box>
                    )
                    const type = <Box key="type" width={look.iconWidth} flexShrink={0}>{look.icon(p.source, 'muted', p.source)}</Box>
                    // Up or down against the last run: what an on-call glance needs, not the threshold it crossed.
                    const moved = p.raw != null && p.trend?.previous != null && p.raw !== p.trend.previous
                      ? (p.raw > p.trend.previous ? ['↑', 'error'] as const : ['↓', 'success'] as const) : null
                    const value = (
                      <Box key="value" width={narrow ? undefined : look.valueWidth} flexShrink={0} flexDirection="row" justifyContent="flex-end">
                        {moved && <Text color={TONES[moved[1]][1]}>{moved[0]}</Text>}
                        {look.isTerminal
                          ? <Button key={`open:${entryKey(p)}`} plain label={p.value} onPress={() => openWith($, p.link)} />
                          : <Link href={p.link} label={p.value} />}
                      </Box>
                    )
                    const t = p.trend
                    const chart = charted(p) && look.sparkline(t.values, p.priority, p.threshold, `${p.label} over the last ${plural(t.values.length, 'run')}`, narrow)
                    const since = sinceText(p) && <Text key="since" dimColor wrap="truncate-end">{sinceText(p)}</Text>
                    const fresh = t?.isNew && <Text key="new" bold color={TONES[ACCENT][1]}>new</Text>
                    const key = `q:${service}:${p.label}`
                    // One line per query at every width; parts drop as it narrows: since when and what it reads first,
                    // then the chart moves to a line of its own. The label is cut last.
                    return [
                      look.divider(`sep:${id}:${service}:${i}`),
                      narrow
                        ? (
                          <Box key={key} flexDirection="column">
                            <Box flexDirection="row" columnGap={1} alignItems="center">{badge}{label}{fresh}{value}{bell}{ask}</Box>
                            {(chart || since) && <Box flexDirection="row" columnGap={1} alignItems="center" paddingLeft={3}>{chart}{since}</Box>}
                          </Box>
                        )
                        : (
                          <Box key={key} flexDirection="row" columnGap={1} alignItems="center">
                            {badge}{label}
                            {/* A fixed column, so the values line up whether a row shows its chart or new. */}
                            <Box key="history" width={historyCells} flexShrink={0} flexDirection="row" columnGap={1} alignItems="center">
                              {fresh}{chart}{since}
                            </Box>
                            {wide && type}{value}{bell}{ask}
                          </Box>
                        ),
                    ]
                  }),
                ]
              })}
            </Box>
          )
        })}

        {r.errors.map(err => <Text dimColor wrap="truncate-end">{err}</Text>)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CONFIG_PANE.id }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? 100
    return configView($, ui, surfaceLook(ui, e.surface), pickerFor(ui, e.surface), columns < NARROW)
  })

  on('ui.render', { component: 'Pane', requestId: PANES.pull_requests.id }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Link, Button } = ui
    const look = surfaceLook(ui, e.surface)
    const picker = pickerFor(ui, e.surface)
    const r = await read($, result)
    const busy = await read($, running)
    // A span no longer offered, such as All time, reads as the longest one, Last month.
    const saved = await read($, span)
    const chosen = SPANS.some(x => x.value === saved) ? saved : 'month'
    const noBots = await read($, hideBots)
    const state = await read($, prState)
    const grouped = await read($, groupPrs)
    const prs = r?.pullRequests ?? []
    const prGroups = repos(prs, chosen, noBots ? (await read($, choices)).bots.map(b => b.toLowerCase()) : [], state)
    const width = (e.props as { bodyColumns?: number }).bodyColumns ?? 0
    const spanLabel = (SPANS.find(s => s.value === chosen) ?? SPANS[1]!).label.toLowerCase()
    const pictures = await read($, avatars)
    // Below this many cells a pull request's title and its details don't share one line.
    const narrow = width < NARROW
    // The desktop app stops redrawing a pane whose tree grows past what it takes (a week of closed PRs did), so the
    // list draws a page at a time, freshest first.
    const pages = Math.max(1, Math.ceil(prGroups.shown / PAGE))
    const page = Math.min(await read($, prPage), pages)
    const drawn = new Set(prGroups.groups.flatMap(([, list]) => list).sort(freshest).slice((page - 1) * PAGE, page * PAGE))
    const cards = (grouped ? prGroups.groups : [['', prGroups.groups.flatMap(([, list]) => list).sort(freshest)] as const])
      .map(([repo, list]) => [repo, list.filter(pr => drawn.has(pr))] as const)

    const me = r?.viewer ?? null
    // A pull request as two lines: its title (the link) and who it waits on; then its number, author, size, how long
    // it has been idle and its open threads, with CI and reviewers at the right edge.
    const row = (pr: PullRequest) => {
      const mark = review(pr)
      const open = (pr.state ?? 'OPEN') === 'OPEN'
      const fresh = isNew(pr) && open
      const who = (pr.author ?? '').replace(/^app\//, '')
      // The author's profile on the same GitHub the PR is on; a bot's is under /apps.
      const host = pr.url.split('/').slice(0, 3).join('/')
      const profile = `${host}/${pr.bot || pr.author?.startsWith('app/') ? 'apps/' : ''}${who}`
      const key = `pr:${pr.repo}#${pr.number}`
      // Open: the new mark leads. Closed: merged or closed leads.
      const lead = open ? (fresh && look.icon('spark', pr.draft ? 'muted' : ACCENT, pr.draft ? 'new draft' : 'new')) : (mark && look.icon(mark[0], mark[1], mark[2]))
      const status = open ? waitingOn(pr, me) : null
      const reviewers = pr.reviewers ?? []
      const idleDays = (Date.now() - new Date(pr.updatedAt).getTime()) / 86_400_000
      const chip = status && <Box key="status" flexShrink={0}><Text bold color={TONES[status[1]][1]}>{status[0]}</Text></Box>
      const checks = [
        pr.ci && <Box key="ci" flexShrink={0}>{look.icon(CI[pr.ci][0], CI[pr.ci][1], `CI ${pr.ci}`, CI[pr.ci][2])}</Box>,
        reviewers.length > 0 && (
          <Box key="reviewers" flexDirection="row" flexWrap="wrap" columnGap={look.isTerminal ? 1 : 0}>
            {reviewers.map(r => look.avatar(r.login, r.review, pictures[r.login]))}
          </Box>
        ),
      ]
      const indent = look.isTerminal ? (lead ? 2 : 0) : look.iconWidth + 1
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row" columnGap={1} alignItems="flex-start">
            {(lead || !look.isTerminal) && <Box width={look.isTerminal ? undefined : look.iconWidth} flexShrink={0}>{lead}</Box>}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {look.isTerminal
                ? <Button key={`open:${pr.repo}#${pr.number}`} plain label={pr.title} onPress={() => openWith($, pr.url)} />
                : <Link href={pr.url} label={pr.title} />}
            </Box>
            {!narrow && chip}
          </Box>
          <Box flexDirection="row" columnGap={1} alignItems="center" paddingLeft={indent}>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor>{`#${pr.number}`}</Text>
              {!grouped && <Text dimColor>{pr.repo.split('/').pop()}</Text>}
              {who && (look.isTerminal ? <Text>{who}</Text> : <Link href={profile} label={who} />)}
              {pr.files != null && (
                <Box flexDirection="row" columnGap={1}>
                  <Text dimColor>{plural(pr.files, 'file')}</Text>
                  <Text color="success">{`+${pr.additions ?? 0}`}</Text>
                  <Text color="error">{`−${pr.deletions ?? 0}`}</Text>
                </Box>
              )}
              {open
                // Idle a week or more: the review has stalled.
                ? <Text color={idleDays >= STALE_DAYS ? 'warning' : undefined} dimColor={idleDays < STALE_DAYS}>{`idle ${age(pr.updatedAt)}`}</Text>
                : <Text dimColor>{age(moved(pr))}</Text>}
              {(pr.threads ?? 0) > 0 && (look.isTerminal
                ? <Text dimColor>{`${plural(pr.threads!, 'open thread')}`}</Text>
                : <Box flexDirection="row">{look.icon('comment', 'muted', 'open threads')}<Text dimColor>{String(pr.threads)}</Text></Box>)}
            </Box>
            {!narrow && checks}
          </Box>
          {/* Narrow: who it waits on, CI and reviewers get a line of their own, so the title keeps the width. */}
          {narrow && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" justifyContent="space-between" paddingLeft={indent}>
              {chip}
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">{checks}</Box>
            </Box>
          )}
        </Box>
      )
    }
    // A band naming a group, as Watch heads its services.
    const band = (key: string, name: string, count: number) => (
      <Box key={key} flexDirection="row" columnGap={1} backgroundColor={look.isTerminal ? undefined : '#8A8A8A1A'} paddingX={look.isTerminal ? 0 : 1}>
        <Text bold wrap="truncate-end">{name}</Text>
        <Text dimColor>{String(count)}</Text>
      </Box>
    )
    const cardsOf = (list: PullRequest[]) => (grouped
      ? [...new Set(list.map(pr => pr.repo))].map(repo => [repo, list.filter(pr => pr.repo === repo)] as const)
      : [['', list] as const])
      .filter(([, l]) => l.length > 0)
      .map(([repo, l]) => (
        <Box key={grouped ? `repo:${repo}` : 'all'} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1}>
          {grouped && band(`band:${repo}`, repo.split('/').pop()!, prGroups.groups.find(([r]) => r === repo)?.[1].length ?? l.length)}
          {l.flatMap((pr, i) => (grouped || i > 0 ? [look.divider(`sep:${pr.repo}#${pr.number}`), row(pr)] : [row(pr)]))}
        </Box>
      ))
    const shown = cards.flatMap(([, list]) => list)
    // Open ones split by whether they need you; merged and closed ones need nobody.
    const sections = state === 'open'
      ? [['you', 'Needs you', shown.filter(pr => needsYou(pr, me))], ['rest', 'Everyone else', shown.filter(pr => !needsYou(pr, me))]] as const
      : [['all', '', shown]] as const

    return (
      <Box flexDirection="column">
        {r?.setup?.filter(s => s.tool === 'gh').map(s => <Box key={`setup:${s.tool}`}><Text color="warning">{s.fix}</Text></Box>)}
        {/* Line one: how many over which span, when, then Refresh; line two: what to show. */}
        <Box key="prs" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
          <Box flexDirection="row" flexShrink={1} minWidth={0} flexWrap="wrap" columnGap={1} alignItems="center">
            {r?.prsCheckedAt
              ? [
                <Text key="count" bold>{`${prGroups.shown} ${state}`}</Text>,
                picker('span', 's', SPANS, chosen, v => Promise.all([update($, span, () => v), update($, prPage, () => 1)])),
                <Text key="when" dimColor>{` · ${narrow ? when(r.prsCheckedAt) : refreshed(r.prsCheckedAt)}`}</Text>,
              ]
              : <Text dimColor>not checked yet</Text>}
          </Box>
          <Box flexDirection="row" columnGap={2} alignItems="center" flexShrink={0} flexGrow={1} justifyContent="flex-end">
            {pausedNote(ui, look, (await read($, scheduleState))?.paused)}
            {refreshControl(ui, look, $, 'pull_requests', busy, await read($, runningSince))}
          </Box>
        </Box>
        {look.divider('sep:prs')}
        <Box key="filters" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center">
          {picker('state', 'o', STATES, state, v => Promise.all([update($, prState, () => (STATES.find(x => x.value === v)?.value ?? 'open')), update($, prPage, () => 1)]))}
          {checkbox(ui, look, 'grouping', narrow ? 'By repository' : 'Group by repository', grouped, () => update($, groupPrs, g => !g), 'g')}
          {checkbox(ui, look, 'bots', 'Hide bots', noBots, () => update($, hideBots, b => !b), 'b')}
        </Box>
        {(r?.prErrors ?? []).map(err => <Text dimColor wrap="truncate-end">{err}</Text>)}
        {sections.filter(([, , list]) => list.length > 0).map(([key, title, list]) => (
          <Box key={`section:${key}`} flexDirection="column" marginTop={1}>
            {title && band(`head:${key}`, title, list.length)}
            {cardsOf(list)}
          </Box>
        ))}
        {pager(ui, 'prs-page', page, pages, n => update($, prPage, () => n))}
      </Box>
    )
  })
}

// A priority as people say it, `P1`: the most urgent in the error colour, the next in the warning colour.
// A priority as signal bars in its colour: the most urgent three red bars, then two amber, one blue, one grey. The
// name (P1, or high) goes to screen readers and to the terminal, which draws no Svg.
// High in red, Medium in yellow, Low in grey.
const PRIORITY_TONES = [['#D0485C', 'error'], ['#E0B400', 'warning'], ['#8A8A8A', 'inactive']] as const
const bars = (rank: number, color: string) => {
  const lit = Math.max(1, 4 - rank)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    [0, 1, 2].map(i => `<rect x="${2 + i * 4.5}" y="${11 - i * 4}" width="3" height="${3 + i * 4}" rx="1" fill="${color}" opacity="${i < lit ? 1 : 0.2}"/>`).join('') +
    `</svg>`
}
function priorityBadge(ui: any, look: Look, rank: number | null | undefined, name: string) {
  const { Box, Text, Svg } = ui
  const [hex, theme] = (rank != null && rank >= 1 && rank <= 3 ? PRIORITY_TONES[rank - 1]! : ['#8A8A8A', 'inactive']) as readonly [string, string]
  if (!look.isTerminal) {
    return <Box width={2} flexShrink={0}><Svg source={bars(rank ?? 4, hex)} alt={`priority ${name}`} width={14} height={14} /></Box>
  }
  return <Box minWidth={3} flexShrink={0}><Text bold color={theme}>{name}</Text></Box>
}

// A count of failing services: a service icon in the priority's colour, not its bars, which read as a count of errors.
function serviceIcon(ui: any, look: Look, rank: number | null, n: number) {
  const name = rank ? PRIORITY_NAMES[rank - 1]! : 'none'
  const tone: Tone = rank === 1 ? 'error' : rank === 2 ? 'warning' : 'muted'
  return <ui.Box key="icon" minWidth={2} flexShrink={0}>{look.icon('group', tone, plural(n, `${name} service`), name)}</ui.Box>
}

// High, Medium or Low; a run stored before they had names keeps its own.
const nameOf = (p: Problem) => (p.priority != null && PRIORITY_NAMES[p.priority - 1]) || p.priorityName || (p.priority == null ? 'P–' : `P${p.priority}`)

type Look = ReturnType<typeof surfaceLook>

// A paused schedule, said in a pane's header: resuming it is in Config.
function pausedNote(ui: any, look: Look, pausedAt: string | null | undefined) {
  const { Box, Text } = ui
  if (!pausedAt) return null
  return (
    <Box key="paused" flexDirection="row" alignItems="center">
      {look.icon('pause', 'warning', 'Scheduled runs paused')}<Text color="warning">Schedule paused</Text>
    </Box>
  )
}

function muteControl(ui: any, look: Look, $: any, quiet: boolean) {
  const { Box, Button } = ui
  return (
    <Button key="mute" variant="secondary" hotkey={look.hotkey('m')} label={quiet ? 'Unmute all' : 'Mute all'} onPress={() => toggleMute($)} />
  )
}

// The engine's Button has no disabled state: while its part runs, a plain line takes its place.
function refreshControl(ui: any, look: Look, $: any, part: Part | 'all', busy: Part | 'all' | null, since: string | null) {
  const { Button, Text, Box } = ui
  const key = part === 'all' ? 'check' : `check:${part}`
  // Only the shared state: after a reload the press may run in the old module, whose `runHere` this one can't see.
  if (busy === part) {
    return <Box key={part === 'all' ? 'refreshing' : `refreshing:${part}`} flexShrink={0}><Text dimColor>{`Refreshing · since ${since ? time(since) : 'now'}`}</Text></Box>
  }
  return <Button key={key} variant="secondary" hotkey={look.hotkey('r')} label={look.refresh} onPress={() => checkNow($, part)} />
}

// How a surface draws marks: our Svgs on the desktop; plain words in the terminal, which draws no Svg.
function surfaceLook(ui: any, surface: string) {
  const { Box, Text, Button } = ui
  const Svg = 'Svg' in ui && surface !== 'terminal' ? ui.Svg : undefined
  const isTerminal = !Svg
  return {
    isTerminal,
    refresh: isTerminal ? 'Refresh' : '↻',
    // Hotkeys are for the keyboard-driven terminal; on the desktop their badges only add noise.
    hotkey: (key: string) => (isTerminal ? key : undefined),
    // Column widths in cells, so a card's rows line up: an icon, a value, an alert line such as `above 19`.
    iconWidth: isTerminal ? 0 : 2,
    valueWidth: 8,
    // A Box has no one-sided border: on the desktop a hairline image as wide as the pane, in the terminal a dim rule.
    divider: (key: string) =>
      // Clipped: the image is wider than any pane, and must not widen the card it sits in.
      // One line high: the terminal's rule wraps out of sight instead of ending in an ellipsis.
      <Box key={key} flexShrink={0} marginY={Svg ? 1 : 0} minWidth={0} overflow="hidden" height={Svg ? undefined : 1}>
        {Svg
          ? <Svg source={HAIRLINE} alt="separator" height={1} />
          : <Text dimColor wrap="wrap">{'─'.repeat(400)}</Text>}
      </Box>,
    // A reviewer: their picture in a circle, a check badge for approved, a cross for changes; a letter when there's
    // no picture. The terminal names them with their review.
    avatar: (login: string, review: 'approved' | 'changes' | 'pending', picture?: string) =>
      Svg
        ? <Svg key={`rev:${login}`} source={avatarSvg(login, review, picture)} alt={`${login}: ${review === 'changes' ? 'changes requested' : review}`} width={20} height={20} />
        : <Text key={`rev:${login}`} dimColor>{`${login} ${review === 'changes' ? 'changes' : review}`}</Text>,
    // An entry's last runs, oldest first, in its priority's colour: a line on the desktop, block characters in the
    // terminal, a gap where it was under its line.
    sparkline: (values: (number | null)[], rank: number | null | undefined, threshold: number | null | undefined, alt: string, long = false) => {
      const [hex, theme] = (rank != null && rank >= 1 && rank <= 3 ? PRIORITY_TONES[rank - 1]! : ['#8A8A8A', 'inactive']) as readonly [string, string]
      return Svg
        // No width: the drawing scales to its column, so it never spills past it however wide a cell is drawn.
        ? <Box key="spark" width={long ? 2 * CHART_CELLS : CHART_CELLS} flexShrink={0}><Svg source={sparkSvg(values, hex, threshold, long ? 120 : 72)} alt={alt} /></Box>
        : <Text key="spark" color={theme}>{spark(values).points.map(v => (v == null ? ' ' : '▁▂▃▄▅▆▇█'[Math.round(v * 7)])).join('')}</Text>
    },
    // An icon you press. A Button holds text, not an Svg: on the desktop an invisible Button lies over the Svg;
    // the terminal presses a symbol any font has, as Claude's own marks are.
    // VS Code draws every Button filled, plain or not: there an invisible one would show as a blank box, so it gets
    // the terminal's symbol.
    control: (key: string, name: keyof typeof MARKS, alt: string, onPress: () => void, hotkey?: string) =>
      Svg && surface !== 'vscode'
        ? (
          <Box key={`icon:${key}`} position="relative" flexShrink={0}>
            <Svg source={svg(name, 'muted')} alt={alt} width={16} height={16} />
            <Box position="absolute" top={0} left={0}>
              <Button key={key} plain onPress={onPress}><Text color="transparent">{'\u2003'}</Text></Button>
            </Box>
          </Box>
        )
        : <Button key={key} plain dimColor hotkey={hotkey} label={MARKS[name]} onPress={onPress} />,
    // `word` replaces the icon's own terminal word, for icons that mean different things (a CI dot).
    icon: (name: IconName, tone: Tone, alt: string, word = WORDS[name]) =>
      Svg
        ? <Svg source={svg(name, tone)} alt={alt} width={16} height={16} />
        : word && <Text color={TONES[tone][1]}>{word}</Text>,
  }
}
