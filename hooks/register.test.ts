import { expect, test } from 'claude-code/testing'

// What a desktop control's icon says: its Svg's alt, under the invisible button.
const iconOf = async (ui: any, key: string) => (await ui.findAll({ key: `icon:${key}` }))[0]?.children[0].props.alt

// The clock time the row shows for an ISO stamp, in this machine's zone.
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

// Today at 09:04, so a row's since reads as a time alone.
const SINCE = new Date(new Date().setHours(9, 4, 0, 0)).toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
// An open PR, last updated and created the given hours ago.
const pr = (repo: string, number: number, title: string, author: string, updated: number, created: number, review: string | null) => ({
  name: repo.endsWith('checkout-api') ? 'API' : 'Worker', repo, number, title, author,
  bot: author.startsWith('app/'), draft: false, review, state: 'OPEN', ci: null as string | null,
  createdAt: hoursAgo(created), updatedAt: hoursAgo(updated), url: `https://github.com/${repo}/pull/${number}`,
})

const problem = (name: string, service: string, env: string, label: string, priority: number | null, source: string, value: string, alert: string, more = {}) => ({
  name, service, repo: 'acme/checkout-api', env, label, priority, source, value, alert,
  link: `https://app.datadoghq.com/${label}`, query: `service:x ${label}`, notify: true, ...more,
})

const RESULT = {
  checkedAt: '2026-10-16T13:34:00+00:00',
  window: '1h',
  status: 'ok',
  errors: [],
  problems: [
    problem('API', 'Checkout', 'Production', 'Error logs', 1, 'logs', '72', 'above 20',
      { raw: 72, threshold: 20, trend: { values: [null, 48, 60, 72], since: SINCE, previous: 60, isNew: false } }),
    problem('API', 'Checkout', 'Production', 'Slow requests', 3, 'traces', '3.70s', 'above 2.00s',
      { raw: 3.7, trend: { values: [null, null, 3.7], since: '2026-10-16T13:34:00+00:00', previous: null, isNew: true } }),
    problem('Worker', 'Queue', 'Staging', 'Queue depth', 2, 'metrics', '540', 'above 500', { notify: false }),
  ],
  span: { from: '2026-10-16T12:34:00+00:00', to: '2026-10-16T13:34:00+00:00' },
  prsCheckedAt: '2026-10-16T13:40:00+00:00',
  viewer: 'max',
  prErrors: [],
  setup: [],
  pullRequests: [
    { ...pr('acme/checkout-api', 12, 'Retry failed orders', 'sam', 2, 2, 'APPROVED'), ci: 'failing', files: 14, additions: 610, deletions: 288, threads: 2,
      reviewers: [{ login: 'lee', review: 'approved' }, { login: 'max', review: 'pending' }] },
    pr('acme/checkout-api', 15, 'Bump the HTTP client', 'app/dependabot', 50, 240, 'REVIEW_REQUIRED'),
    pr('acme/checkout-worker', 7, 'Drain the retry queue', 'lee', 120, 200, null),
    { ...pr('acme/checkout-api', 9, 'Shipped retries', 'kim', 5, 90, 'APPROVED'), state: 'MERGED' },
    { ...pr('acme/checkout-api', 8, 'Dropped idea', 'kim', 30, 90, null), state: 'CLOSED' },
  ],
}

const PANE = {
  plugin: 'on-my-watch',
  surface: 'desktop',
  component: 'Pane',
  requestId: 'on-my-watch',
  props: { title: 'Watch', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as const
const PRS = { ...PANE, requestId: 'on-my-watch-prs', props: { ...PANE.props, title: 'Pull requests' } } as const
const CONFIG = { ...PANE, requestId: 'on-my-watch-config', props: { ...PANE.props, title: 'Config' } } as const

// The engine beneath the mod: the checker process answering `latest` and `run`, the prompt, a desktop surface.
function world(on: any, latest: unknown, config: unknown = {}, env: Record<string, string> = { HOME: '/home/me', PATH: '/usr/bin' }) {
  const seen = { opened: [] as string[], runs: [] as string[][], envs: [] as any[], submitted: [] as string[], commands: [] as string[], refuse: [] as string[], muted: false, quiet: [] as string[], saved: [] as any[],
    schedule: { paused: null as string | null, schedule: '0 9-18 * * 1-5', next: '2026-10-19T19:00:00', own: [{ entry: 'API|Checkout|Production|Error logs', schedule: '*/15 9-18 * * 1-5' }] } }
  on('session.start', async (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', async (_: any, e: any) => ({ clientId: e.clientId }))
  on('session.surfaces', async () => ({ value: [] }))
  on('session.cwd', async () => ({ value: '/work' }))
  on('command.register', async (_: any, e: any) => ({ value: { command: e.name } }))
  on('clock.every', async () => ({ value: { cancel: () => {} } }))
  on('env.get', async (_: any, e: any) => ({ value: env[e.name] }))
  // The file as last saved, so a pane that reads it again after Save sees what was written.
  on('fs.read', async () => ({ value: JSON.stringify(seen.saved.at(-1) ?? config) }))
  on('process.run', async (_: any, e: any) => {
    seen.runs.push([...e.argv])
    if (seen.refuse.includes(e.argv[0])) return { value: { exitCode: 1, stdout: '', stderr: 'refused' } }
    seen.envs.push(e.init?.env ?? e.env)
    const command = e.argv.find((a: string) => ['latest', 'history', 'show', 'run', 'notifications', 'schedule', 'validate', 'config'].includes(a))
    if (command === 'validate') return { value: { exitCode: 0, stdout: 'config.json holds to the schema', stderr: '' } }
    if (command === 'config') {
      // The whole config on stdin; a site of "bad" or "many" stands for what the schema refuses, as does a short cron line.
      const sent = JSON.parse(e.init?.stdin ?? e.stdin ?? '{}')
      const refuse = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr } })
      if (sent.site === 'bad') return refuse('config.site: must be a known Datadog site')
      if (sent.site === 'many') return refuse(Array.from({ length: 10 }, (_, i) => `config.repos[${i}]: wrong`).join('\n'))
      if (sent.schedule && sent.schedule.split(' ').length !== 5) return refuse(`config.schedule: '${sent.schedule}' is not a schedule: cron needs 5 fields, got ${sent.schedule.split(' ').length}`)
      seen.saved.push(sent)
      return { value: { exitCode: 0, stdout: JSON.stringify(sent), stderr: '' } }
    }
    if (command === 'schedule') {
      const [what, cron, entry] = e.argv.slice(e.argv.indexOf('schedule') + 1)
      if (what === 'pause') seen.schedule.paused = '2026-10-19T16:24:00+00:00'
      if (what === 'resume') seen.schedule.paused = null
      if (what === 'set') {
        if (cron.split(' ').length !== 5) return { value: { exitCode: 1, stdout: '', stderr: `'${cron}' is not a schedule: cron needs 5 fields, got ${cron.split(' ').length}` } }
        if (!entry) seen.schedule.schedule = cron
        else seen.schedule.own = seen.schedule.own.map(o => (o.entry === entry ? { ...o, schedule: cron } : o))
      }
      return { value: { exitCode: 0, stdout: JSON.stringify(seen.schedule), stderr: '' } }
    }
    if (command === 'notifications') {
      const [what, entry] = e.argv.slice(e.argv.indexOf('notifications') + 1)
      if (what === 'on' || what === 'off') seen.muted = what === 'off'
      if (what === 'quiet') seen.quiet = [...new Set([...seen.quiet, entry])]
      if (what === 'loud') seen.quiet = seen.quiet.filter((q: string) => q !== entry)
      return { value: { exitCode: 0, stdout: JSON.stringify({ muted: seen.muted, quiet: seen.quiet }), stderr: '' } }
    }
    const answer = command === 'latest' ? latest
      : command === 'history' ? [{ id: 8, checkedAt: '2026-10-16T12:30:00+00:00', status: 'failed', reason: 'Sign in to Datadog: pup auth login (Error: 401 Unauthorized)', problems: 0, labels: [] }, { id: 7, checkedAt: '2026-10-16T12:34:00+00:00', status: 'ok', problems: 3, labels: [{ label: 'Errors', count: 2, priority: 1, priorityName: 'P1' }, { label: 'Warnings', count: 1, priority: 2, priorityName: 'P2' }], span: { from: '2026-10-16T11:34:00+00:00', to: '2026-10-16T12:34:00+00:00' } }]
        : command === 'show' ? { ...(latest as any), checkedAt: '2026-10-16T12:34:00+00:00', problems: [(latest as any).problems[0]] }
          : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(answer), stderr: '' } }
  })
  on('command.run', async (_: any, e: any) => {
    seen.commands.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  on('prompt.submit', async (_: any, e: any) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.open', async (_: any, e: any) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  return seen
}

async function mounted($: any, on: any, latest: unknown = RESULT, pane: any = PANE, config: unknown = {}) {
  const seen = world(on, latest, config)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  return { seen, ui: await $.ui.mount(pane) }
}

test('the desktop app attaching opens a Watch pane, a Pull requests pane and a Config pane, Watch in front', async ($, on) => {
  const { seen } = await mounted($, on)
  // Watch is opened again last, with focus: the last pane opened is the one shown.
  expect(seen.opened).toEqual(['on-my-watch', 'on-my-watch-prs', 'on-my-watch-config', 'on-my-watch'])
})

test('a pane turned off in the config does not open', async ($, on) => {
  const { seen } = await mounted($, on, RESULT, PANE, { panes: { pull_requests: false } })
  expect(seen.opened).toEqual(['on-my-watch', 'on-my-watch-config', 'on-my-watch'])
})

test('one card per name and environment, the most urgent first, a row per query over its line', async ($, on) => {
  const { ui } = await mounted($, on)
  // One icon and count per priority, High first: 1 High, 1 Medium, 1 Low.
  expect(await ui.find({ key: 'counts', text: /^111$/ })).toBeDefined()
  const counted = (await ui.findAll({ key: 'counts' }))[0]
  // The count is of services, so its icon is a service in the priority's colour, not the priority's bars.
  expect(JSON.stringify(counted).match(/\d+ (High|Medium|Low) services?/g)).toEqual(['1 High service', '1 Medium service', '1 Low service'])
  expect(JSON.stringify(counted)).not.toContain('priority ')
  const cards = (await ui.findAll({ type: 'Box' })).map((b: any) => String(b.key)).filter(k => k.startsWith('card:'))
  expect(cards).toEqual(['card:API@Production', 'card:Worker@Staging'])
  expect((await ui.findAll({ key: 'card:API@Production' }))[0].props.borderStyle).toBe('round')
  expect(await ui.find({ key: 'card:API@Production', text: new RegExp(`^APIProductionCheckoutError logssince ${clock(SINCE)}↑72\u2003\u2003Slow requestsnew3\\.70s\u2003\u2003$`) })).toBeDefined()
  // Priority is an icon on the desktop, named for screen readers.
  const alts = (await ui.findAll({ type: 'Svg' })).map((i: any) => i.props.alt)
  expect(alts.filter((a: string) => a.startsWith('priority '))).toEqual(['priority High', 'priority High', 'priority Low', 'priority Medium', 'priority Medium'])
})

test('priority, name and environment pickers narrow Watch; their choices come from the config', async ($, on) => {
  const config = { repos: [
    { repo: 'acme/api', name: 'API', queries: [{ service: 'Checkout', env: 'Production', priority: 1 }, { service: 'Checkout', env: 'Production', priority: 3 }] },
    { repo: 'acme/worker', name: 'Worker', queries: [{ service: 'Queue', env: 'Staging', priority: 2 }] },
    { repo: 'acme/search', name: 'Search', queries: [] }] }
  const { ui } = await mounted($, on, RESULT, PANE, config)
  const labels = async (key: string) => (await ui.findAll({ key }))[0].props.options.map((o: any) => o.label)
  expect(await labels('priorities')).toEqual(['All priorities', 'High', 'Medium', 'Low'])
  expect(await labels('names')).toEqual(['All repositories', 'API', 'Worker', 'Search'])
  expect(await labels('envs')).toEqual(['All environments', 'Production', 'Staging'])
  await ui.select({ key: 'priorities', value: 'Medium' })
  expect(await ui.find({ key: 'card:API@Production' })).toBeUndefined()
  expect(await ui.find({ key: 'card:Worker@Staging' })).toBeDefined()
  await ui.select({ key: 'priorities', value: '' })
  await ui.select({ key: 'envs', value: 'Production' })
  expect(await ui.find({ key: 'card:Worker@Staging' })).toBeUndefined()
  await ui.select({ key: 'envs', value: '' })
  await ui.select({ key: 'names', value: 'Worker' })
  expect(await ui.find({ key: 'card:API@Production' })).toBeUndefined()
})

test('a card draws a line between its rows, and each row keeps fixed columns', async ($, on) => {
  const { ui } = await mounted($, on)
  const seps = (await ui.findAll({ type: 'Box' })).map((b: any) => String(b.key)).filter(k => k.startsWith('sep:card:API@Production'))
  expect(seps).toEqual(['sep:card:API@Production:Checkout', 'sep:card:API@Production:Checkout:0', 'sep:card:API@Production:Checkout:1'])
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(row.props.flexDirection).toBe('row')
  expect(row.children.map((c: any) => c.props.width ?? c.props.minWidth)).toEqual([2, 0, 22, 2, 8, undefined, undefined])
})

test('in a narrow pane a row puts the value and its controls at the right of its label, then its last runs beneath', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, { ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(row.props.flexDirection).toBe('column')
  const text = (node: any): string => (typeof node === 'string' ? node : (node.children ?? []).map(text).join(''))
  const [first, second] = row.children
  expect(text(first)).toBe('Error logs↑72\u2003\u2003')
  expect(text(second)).toBe(`since ${clock(SINCE)}`)
  expect(await iconOf(ui, 'bell:API|Checkout|Production|Error logs')).toBe('notifications on')
  expect(await iconOf(ui, 'inv:API|Checkout|Production|Error logs')).toBe('Investigate')
})

test('every service gets its heading, even alone in its card with one query', async ($, on) => {
  const { ui } = await mounted($, on)
  expect(await ui.find({ key: 'svc:Queue' })).toBeDefined()
  expect(await ui.find({ key: 'q:Queue:Queue depth', text: /^Queue depth540/ })).toBeDefined()
  expect(await ui.find({ key: 'svc:Checkout' })).toBeDefined()
})

test('in a card with more than one service, every service gets a heading, one query or many', async ($, on) => {
  const mixed = { ...RESULT, problems: [...RESULT.problems, problem('API', 'Payments', 'Production', 'Warnings', 2, 'logs', '9', 'above 5')] }
  const { ui } = await mounted($, on, mixed)
  expect(await ui.find({ key: 'svc:Checkout' })).toBeDefined()
  expect(await ui.find({ key: 'svc:Payments' })).toBeDefined()
  expect(await ui.find({ key: 'q:Payments:Warnings', text: /^Warnings/ })).toBeDefined()
})

test('a service heading sits on a tinted band on the desktop, and plain in the terminal', async ($, on) => {
  const { ui } = await mounted($, on)
  expect((await ui.findAll({ key: 'svc:Checkout' }))[0].props.backgroundColor).toBe('#8A8A8A1A')
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect((await terminal.findAll({ key: 'svc:Checkout' }))[0].props.backgroundColor).toBeUndefined()
})

test('a row\'s label is one text, cut once at the end when long', async ($, on) => {
  const { ui } = await mounted($, on)
  const row = (await ui.findAll({ key: 'q:Queue:Queue depth' }))[0]
  const texts = row.children[1].children  // after the priority badge
  expect(texts).toHaveLength(1)
  const label = texts[0]
  expect(label.type).toBe('Text')
  expect(label.props.wrap).toBe('truncate-end')
  expect(textOf(label)).toBe('Queue depth')
})

test('each row turns its own notifications off and on; the config can keep one off', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  await ui.press({ key: 'bell:API|Checkout|Production|Error logs' })
  expect(seen.quiet).toEqual(['API|Checkout|Production|Error logs'])
  expect(await iconOf(ui, 'bell:API|Checkout|Production|Error logs')).toBe('notifications off')
  await ui.press({ key: 'bell:API|Checkout|Production|Error logs' })
  expect(seen.quiet).toEqual([])
  // notify: false in the config: a mark, no toggle.
  expect(await ui.find({ key: 'bell:Worker|Queue|Staging|Queue depth' })).toBeUndefined()
  const alts = (await ui.findAll({ type: 'Svg' })).map((i: any) => i.props.alt)
  expect(alts).toContain('notifications off in the config')
})

test('a run stored before entries had names shows under its service', async ($, on) => {
  const old = { ...RESULT, problems: [{ service: 'checkout-api', alias: 'API', env: 'production', label: 'Error logs', source: 'logs', value: '72', link: 'x', query: 'q' }] }
  const { ui } = await mounted($, on, old)
  expect(await ui.find({ key: 'card:API@production' })).toBeDefined()
})

test('history lists past runs with the window each checked, and opens one with its pinned links', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  await ui.press({ key: 'history' })
  expect(await ui.find({ key: 'run:7', text: /^\d\d:34 · \d\d:34–\d\d:34$/ })).toBeDefined()
  expect(await ui.find({ key: 'row:7', text: /^\d\d:34 · \d\d:34–\d\d:3421$/ })).toBeDefined()
  await ui.press({ key: 'run:7' })
  expect(seen.runs.some(argv => argv.includes('show') && argv.at(-1) === '7')).toBe(true)
  expect(await ui.find({ key: 'archived', text: /^Run \d\d:34 · \d\d:34–\d\d:34← Latest/ })).toBeDefined()
  expect(await ui.find({ key: 'check:watch' })).toBeUndefined()
  await ui.press({ key: 'latest' })
  expect(await ui.find({ key: 'check:watch' })).toBeDefined()
})

test('pull requests show the chosen span, grouped by repo, freshest first, new ones marked', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  const prKeys = async () => (await ui.findAll({ type: 'Box' })).map((b: any) => String(b.key)).filter(k => k.startsWith('pr:'))
  expect(await ui.find({ key: 'prs', text: /^2 open.* · Last refresh (.* )?\d\d:40/ })).toBeDefined()
  expect(await prKeys()).toEqual(['pr:acme/checkout-api#12', 'pr:acme/checkout-api#15'])
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /^Retry failed ordersWaiting on you#12sam14 files\+610−288idle 2h2$/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#15', text: /^Bump the HTTP clientWaiting on review#15dependabotidle 2d$/ })).toBeDefined()
  // Icons are our own Svgs on the desktop, each named for a screen reader.
  const alts = (await ui.findAll({ type: 'Svg' })).map((i: any) => i.props.alt)
  expect(alts).toEqual(expect.arrayContaining(['new', 'CI failing', 'lee: approved', 'max: pending']))

  await ui.select({ key: 'span', value: 'month' })
  expect(await prKeys()).toEqual(['pr:acme/checkout-api#12', 'pr:acme/checkout-api#15', 'pr:acme/checkout-worker#7'])
})

test('a row shows its last runs, since when it is over its line, and which way it moved; a new one says new', async ($, on) => {
  const { ui } = await mounted($, on)
  const row = await ui.find({ key: 'q:Checkout:Error logs' })
  expect(await ui.find({ key: 'q:Checkout:Error logs', text: new RegExp(`since ${clock(SINCE)}`) })).toBeDefined()
  expect(await ui.find({ key: 'q:Checkout:Error logs', text: /↑72/ })).toBeDefined()
  expect(row).toBeDefined()
  const alts = (await ui.findAll({ type: 'Svg' })).map((i: any) => i.props.alt)
  expect(alts).toContain('Error logs over the last 4 runs')
  expect(await ui.find({ key: 'q:Checkout:Slow requests', text: /new/ })).toBeDefined()
  // The threshold it crossed is no longer drawn: a row is only there because it crossed it.
  expect(await ui.find({ key: 'q:Checkout:Error logs', text: /above 20/ })).toBeUndefined()
})

const at = (bodyColumns: number) => ({ ...PANE, props: { ...PANE.props, bodyColumns } }) as any
const svgAlts = (node: any): string[] => node.type === 'Svg' ? [node.props.alt] : (node.children ?? []).flatMap((c: any) => (typeof c === 'string' ? [] : svgAlts(c)))
const textOf = (node: any): string => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''))

test('wide, a row has everything on one line: its chart, since when, what it reads, and its value', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, at(120))
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(row.props.flexDirection).toBe('row')
  expect(textOf(row)).toContain('since')
  expect(svgAlts(row)).toEqual(expect.arrayContaining(['Error logs over the last 4 runs', 'logs']))
})

test('medium, a row drops what it reads, so its label keeps its room', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, at(80))
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(row.props.flexDirection).toBe('row')
  expect(textOf(row)).toContain('since')
  expect(svgAlts(row)).toContain('Error logs over the last 4 runs')
  expect(svgAlts(row)).not.toContain('logs')
})

test('narrow, a row keeps its label, value and controls on one line and gives its chart the line beneath', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, at(40))
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(row.props.flexDirection).toBe('column')
  const [first, second] = row.children
  expect(svgAlts(first)).toEqual(expect.arrayContaining(['notifications on', 'Investigate']))
  expect(svgAlts(second)).toContain('Error logs over the last 4 runs')
  expect(textOf(second)).toContain('since')
})

test('the window is chosen in the header; three filters stay below, named short when narrow', async ($, on) => {
  const { ui: wide } = await mounted($, on, { ...RESULT, window: '15m' }, at(120), { window: '1h' })
  expect(await wide.find({ key: 'header', type: 'Box' })).toBeDefined()
  expect((await wide.findAll({ key: 'header' }))[0].children.flat(9).some((c: any) => c?.key === 'window' || JSON.stringify(c ?? '').includes('"window"'))).toBe(true)
  expect((await wide.findAll({ key: 'filters' }))[0].children.filter(Boolean)).toHaveLength(3)
  // The config's own window, not the last run's: that run may have checked another window picked earlier.
  expect((await wide.findAll({ key: 'window' }))[0].props.options[0].label).toBe('Config: last hour')
  await wide.unmount()
  const narrow = await $.ui.mount(at(40))
  expect((await narrow.findAll({ key: 'priorities' }))[0].props.options[0].label).toBe('Priority')
  expect((await narrow.findAll({ key: 'names' }))[0].props.options[0].label).toBe('Repository')
  expect((await narrow.findAll({ key: 'envs' }))[0].props.options[0].label).toBe('Env')
})

test('Refresh stays on screen however narrow: the header wraps rather than clip it', async ($, on) => {
  const { ui: tiny } = await mounted($, on, RESULT, at(30))
  expect(await tiny.find({ key: 'check:watch' })).toBeDefined()
  expect((await tiny.findAll({ key: 'header' }))[0].props.flexWrap).toBe('wrap')
})

test('a row with fewer than three counts shows since when, without a chart that would read as a glitch', async ($, on) => {
  const sparse = { ...RESULT, problems: [problem('API', 'Checkout', 'Production', 'Error logs', 1, 'logs', '72', 'above 20',
    { raw: 72, trend: { values: [null, null, 60, 72], since: SINCE, previous: 60, isNew: false } })] }
  const { ui } = await mounted($, on, sparse)
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(svgAlts(row).some(a => a.includes('over the last'))).toBe(false)
  expect(textOf(row)).toContain('since')
})

test('narrow, a row without enough runs for a chart still says since when, on the line beneath', async ($, on) => {
  const sparse = { ...RESULT, problems: [problem('API', 'Checkout', 'Production', 'Error logs', 1, 'logs', '72', 'above 20',
    { raw: 72, trend: { values: [null, 60, 72], since: SINCE, previous: 60, isNew: false } })] }
  const { ui } = await mounted($, on, sparse, at(40))
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(textOf(row.children[1])).toBe(`since ${clock(SINCE)}`)
})

test('since names the day when it is not today, so it never reads later than the last check', async ($, on) => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString()
  const old = { ...RESULT, problems: [problem('API', 'Checkout', 'Production', 'Error logs', 1, 'logs', '72', 'above 20',
    { raw: 72, trend: { values: [60, 66, 72], since: yesterday, previous: 66, isNew: false } })] }
  const { ui } = await mounted($, on, old, at(120))
  const weekday = new Date(yesterday).toLocaleDateString([], { weekday: 'short' })
  expect(await ui.find({ key: 'q:Checkout:Error logs', text: new RegExp(`since ${weekday} ${clock(yesterday)}`) })).toBeDefined()
})

test('medium, a row without a chart shows since when in the chart\'s column', async ($, on) => {
  const sparse = { ...RESULT, problems: [problem('API', 'Checkout', 'Production', 'Error logs', 1, 'logs', '72', 'above 20',
    { raw: 72, trend: { values: [null, 60, 72], since: SINCE, previous: 60, isNew: false } })] }
  const { ui } = await mounted($, on, sparse, at(80))
  expect(await ui.find({ key: 'history', text: `since ${clock(SINCE)}` })).toBeDefined()
})

test('the terminal draws a divider as one full line, clipped rather than cut with an ellipsis', async ($, on) => {
  await mounted($, on)
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  const sep = (await terminal.findAll({ key: 'sep:watch' }))[0]
  expect(sep.props.height).toBe(1)
  expect(sep.children[0].props.wrap).toBe('wrap')
})

test('the history column is as wide as the widest history on screen, so labels keep the room', async ($, on) => {
  const weekAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const older = { ...RESULT, problems: [...RESULT.problems.slice(0, 1), problem('API', 'Checkout', 'Production', 'Latency', 1, 'logs', '9', 'above 5',
    { raw: 9, trend: { values: [6, 7, 9], since: weekAgo, previous: 7, isNew: false } })] }
  const { ui } = await mounted($, on, older, at(120))
  // `since Tue 14:58` is four cells longer than `since 14:58`: both rows take the longer.
  const widths = (await ui.findAll({ key: 'history', type: 'Box' })).map((b: any) => b.props.width)
  expect(widths).toEqual([26, 26])
})

test('a card whose title wraps keeps its priority beside the first line', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, at(40))
  expect((await ui.findAll({ key: 'card-head:API@Production' }))[0].props.alignItems).toBe('flex-start')
})

test('narrow, History stays in the header as an icon rather than taking a line of its own', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, at(40))
  const header = (await ui.findAll({ key: 'header' }))[0]
  expect(svgAlts(header)).toContain('History')
})

test('VS Code draws every Button filled, so its controls are symbol buttons, not an invisible button over an icon', async ($, on) => {
  await mounted($, on)
  const code = await $.ui.mount({ ...PANE, surface: 'vscode' } as any)
  const bell = (await code.findAll({ key: 'bell:API|Checkout|Production|Error logs' }))[0]
  expect(bell.type).toBe('Button')
  expect(bell.props.label).toBe('◉')
  expect((await code.findAll({ key: 'inv:API|Checkout|Production|Error logs' }))[0].props.label).toBe('✻')
})

test('in the terminal a value opens its Datadog query on press, so a terminal without links never prints the URL', async ($, on) => {
  const { seen } = await mounted($, on)
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await terminal.find({ type: 'Link' })).toBeUndefined()
  const value = (await terminal.findAll({ key: 'open:API|Checkout|Production|Error logs' }))[0]
  expect([value.type, value.props.label]).toEqual(['Button', '72'])
  await terminal.press({ key: 'open:API|Checkout|Production|Error logs' })
  expect(seen.runs).toContainEqual(['open', 'https://app.datadoghq.com/Error logs'])
})

test('in the terminal a pull request\'s title opens it on press; its author is plain text', async ($, on) => {
  const { seen } = await mounted($, on)
  const terminal = await $.ui.mount({ ...PRS, surface: 'terminal' } as any)
  expect(await terminal.find({ type: 'Link' })).toBeUndefined()
  await terminal.press({ key: 'open:acme/checkout-api#12' })
  expect(seen.runs).toContainEqual(['open', 'https://github.com/acme/checkout-api/pull/12'])
})

test('a chart draws its threshold as a dashed line', async ($, on) => {
  const { ui } = await mounted($, on)
  const chart = (await ui.findAll({ type: 'Svg' })).find((i: any) => i.props.alt === 'Error logs over the last 4 runs')
  expect(chart.props.source).toContain('stroke-dasharray')
})

test('the terminal draws the last runs as block characters, from where its history begins', async ($, on) => {
  await mounted($, on)
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  // Runs before the entry's history began are not drawn: no blank lead-in that reads as indentation.
  expect(await terminal.find({ key: 'q:Checkout:Error logs', text: /logs▁▅█/ })).toBeDefined()
})

test('investigate in the current session sends the problem to Claude', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, PANE, { investigate: { session: 'current' } })
  await ui.press({ key: 'inv:API|Checkout|Production|Error logs' })
  expect(seen.submitted[0]).toContain('Investigate API (acme/checkout-api) in Production')
  expect(seen.submitted[0]).toContain('- P1 Checkout: Error logs is 72 (above 20), logs query `service:x Error logs`')
  expect(seen.submitted[0]).toContain('https://app.datadoghq.com/Error logs')
  // One query each: the card's other rows have their own button.
  expect(seen.submitted[0]).not.toContain('Slow requests')
})

test('investigate on the desktop opens a new Code session in the same folder', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  await ui.press({ key: 'inv:API|Checkout|Production|Error logs' })
  expect(seen.submitted).toEqual([])
  const [cmd, link] = seen.runs.find(r => r[0] === 'open')!
  const url = new URL(link!)
  expect([cmd, url.protocol, url.host, url.pathname]).toEqual(['open', 'claude:', 'code', '/new'])
  expect(url.searchParams.get('folder')).toBe('/work')
  expect(url.searchParams.get('q')).toContain('Investigate API (acme/checkout-api) in Production')
})

test('investigate in the terminal opens a new terminal window running claude in the same folder', async ($, on) => {
  const { seen } = await mounted($, on)
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  // The terminal's controls are symbols, not emoji: Investigate and the row's bell.
  expect((await terminal.findAll({ key: 'inv:API|Checkout|Production|Error logs' }))[0].props.label).toBe('✻')
  expect((await terminal.findAll({ key: 'bell:API|Checkout|Production|Error logs' }))[0].props.label).toBe('◉')
  await terminal.press({ key: 'inv:API|Checkout|Production|Error logs' })
  expect(seen.submitted).toEqual([])
  const run = seen.runs.find(r => r[0] === 'osascript')!
  const command = run.at(-1)!
  expect(command.startsWith(`cd '/work' && claude $'Investigate API (acme/checkout-api) in Production`)).toBe(true)
  expect(command).toContain(`\\n- P1 Checkout: Error logs is 72`)
  expect(command).not.toContain('\n')
})

test('investigate runs the configured skill with the problem', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, PANE, { investigate: { session: 'current', skill: 'triage' } })
  await ui.press({ key: 'inv:API|Checkout|Production|Error logs' })
  expect(seen.commands[0]!.startsWith('/triage Investigate API (acme/checkout-api) in Production')).toBe(true)
  expect(seen.submitted).toEqual([])
})

test('investigate fills the configured prompt and problem templates', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, PANE, { investigate: { session: 'current',
    prompt: 'Look at {{name}} ({{repo}}) in {{env}}, {{window}} to {{checkedAt}}, {{from}}–{{to}}.\n{{problems}}\nNo tests. {{nope}}',
    problem: '* {{priority}} {{service}} {{label}}={{value}} [{{alert}}] {{source}} `{{query}}` {{link}}' } })
  await ui.press({ key: 'inv:API|Checkout|Production|Error logs' })
  expect(seen.submitted[0]).toBe([
    'Look at API (acme/checkout-api) in Production, 1h to 2026-10-16T13:34:00+00:00, 2026-10-16T12:34:00+00:00–2026-10-16T13:34:00+00:00.',
    '* P1 Checkout Error logs=72 [above 20] logs `service:x Error logs` https://app.datadoghq.com/Error logs',
    // A misspelled variable stays as written.
    'No tests. {{nope}}',
  ].join('\n'))
})

test("a query's own investigate templates override the general ones, each on its own", async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, PANE, {
    investigate: { session: 'current', prompt: 'General {{problems}}', problem: '{{label}} is {{value}}' },
    repos: [{ repo: 'acme/checkout-api', name: 'API', queries: [
      { service: 'Checkout', env: 'Production', label: 'Error logs', investigate: { prompt: 'Own: {{problems}}' } },
    ] }],
  })
  await ui.press({ key: 'inv:API|Checkout|Production|Error logs' })
  expect(seen.submitted[0]).toBe('Own: Error logs is 72')
  await ui.press({ key: 'inv:API|Checkout|Production|Slow requests' })
  expect(seen.submitted[1]).toBe('General Slow requests is 3.70s')
})

test('a new session starts with the configured skill', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, PANE, { investigate: { skill: 'triage' } })
  await ui.press({ key: 'inv:API|Checkout|Production|Error logs' })
  const link = new URL(seen.runs.find(r => r[0] === 'open')!.at(-1)!)
  expect(link.searchParams.get('q')!.startsWith('/triage Investigate API')).toBe(true)
})

test('investigate falls back to the current session when a new one cannot open', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  seen.refuse.push('open')
  await ui.press({ key: 'inv:API|Checkout|Production|Error logs' })
  expect(seen.submitted[0]).toContain('Investigate API (acme/checkout-api) in Production')
})

test('Reload config shows environments added to the config since the pane opened', async ($, on) => {
  const config = { repos: [{ repo: 'acme/api', name: 'API', queries: [{ service: 'Checkout', env: 'Production', priority: 1 }] }] }
  const { ui } = await mounted($, on, RESULT, PANE, config)
  const envs = async () => (await ui.findAll({ key: 'envs' }))[0].props.options.map((o: any) => o.label)
  expect(await envs()).toEqual(['All environments', 'Production'])
  config.repos[0]!.queries.push({ service: 'Checkout', env: 'Testing', priority: 1 })
  await ui.press({ key: 'check:watch' })
  expect(await envs()).toEqual(['All environments', 'Production'])
  await (await $.ui.mount(CONFIG)).press({ key: 'reload-config' })
  expect(await envs()).toEqual(['All environments', 'Production', 'Testing'])
})

test('each pane refreshes only its own part, with no AI', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  await ui.press({ key: 'check:watch' })
  await (await $.ui.mount(PRS)).press({ key: 'check:pull_requests' })
  const runs = seen.runs.filter(argv => argv.includes('run') && argv.some(a => a.endsWith('/bin/on_my_watch.py')))
  expect(runs.map(argv => argv.at(-1))).toEqual(['watch', 'pull_requests'])
})

test('picking a window checks Watch over it right away; the config window passes none', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  await ui.select({ key: 'window', value: '4h' })
  await ui.press({ key: 'check:watch' })
  await ui.select({ key: 'window', value: '' })
  const runs = seen.runs.filter(argv => argv.includes('run')).map(argv => argv.slice(argv.indexOf('run')))
  expect(runs).toEqual([['run', 'watch', '--window', '4h'], ['run', 'watch', '--window', '4h'], ['run', 'watch']])
})

test('before the first run the pane says where the config goes', async ($, on) => {
  const { ui } = await mounted($, on, {})
  expect(await ui.find({ type: 'Text', text: /~\/\.on-my-watch\/config\.json/ })).toBeDefined()
  expect(await ui.find({ key: 'check' })).toBeDefined()
})

test('open pull requests that need you come first, under Needs you; the rest under Everyone else', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  // max is asked to review #12.
  expect(await ui.find({ key: 'section:you', text: /Needs you1.*Retry failed orders/ })).toBeDefined()
  expect(await ui.find({ key: 'section:rest', text: /Everyone else1.*Bump the HTTP client/ })).toBeDefined()
})

test('a pull request says who it waits on, how big it is, how long it has been idle and its open threads', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /Waiting on you/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /14 files\+610−288/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /idle 2h/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /2 open threads|2$/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#15', text: /Waiting on review/ })).toBeDefined()
})

test('a pull request\'s title is its link; its number is plain', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  const links = (await ui.findAll({ type: 'Link' })).map((l: any) => l.props)
  expect(links).toEqual(expect.arrayContaining([{ href: 'https://github.com/acme/checkout-api/pull/12', label: 'Retry failed orders' }]))
  expect(links.some((l: any) => l.label === '#12')).toBe(false)
})

test('pull requests keep the span in the header and three filters below', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  expect(JSON.stringify((await ui.findAll({ key: 'prs' }))[0])).toContain('"span"')
  expect((await ui.findAll({ key: 'filters' }))[0].children.filter(Boolean)).toHaveLength(3)
})

test('narrow, a pull request gives its title the whole first line; who it waits on, CI and reviewers get the third', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, { ...PRS, props: { ...PRS.props, bodyColumns: 40 } })
  const row = (await ui.findAll({ key: 'pr:acme/checkout-api#12' }))[0]
  expect(row.children).toHaveLength(3)
  expect(textOf(row.children[0])).not.toContain('Waiting')
  expect(textOf(row.children[2])).toContain('Waiting on you')
})

test('a pull request idle a week or more says so in amber', async ($, on) => {
  const stale = { ...RESULT, pullRequests: [{ ...pr('acme/checkout-api', 21, 'Old idea', 'kim', 24 * 8, 24 * 9, null) }] }
  const { ui } = await mounted($, on, stale, PRS)
  await ui.select({ key: 'span', value: 'month' })
  const idle = (await ui.findAll({ type: 'Text' })).find((t: any) => textOf(t) === 'idle 8d')
  expect(idle.props.color).toBe('warning')
})

test('pull requests show even before observability has run', async ($, on) => {
  const { ui } = await mounted($, on, { ...RESULT, checkedAt: null, problems: [] })
  expect(await ui.find({ key: 'watch', text: /not checked yet/ })).toBeDefined()
  expect(await (await $.ui.mount(PRS)).find({ key: 'repo:acme/checkout-api' })).toBeDefined()
})

test('a missing or signed-out tool shows the fix first', async ($, on) => {
  const { ui } = await mounted($, on, { ...RESULT, setup: [{ tool: 'gh', fix: 'Sign in to GitHub: gh auth login' }] }, PRS)
  expect(await ui.find({ key: 'setup:gh', text: 'Sign in to GitHub: gh auth login' })).toBeDefined()
})

test('a signed-out pup gets a Sign in button that runs pup auth login, then checks Watch again', async ($, on) => {
  const { ui, seen } = await mounted($, on, { ...RESULT, setup: [{ tool: 'pup', need: 'login', fix: 'Sign in to Datadog: pup auth login' }] })
  await ui.press({ key: 'signin:pup' })
  const login = seen.runs.findIndex(argv => argv.join(' ') === 'pup auth login')
  expect(login).toBeGreaterThan(-1)
  expect(seen.runs.slice(login).some(argv => argv.at(-1) === 'watch')).toBe(true)
})

test('a missing pup gets no Sign in button', async ($, on) => {
  const { ui } = await mounted($, on, { ...RESULT, setup: [{ tool: 'pup', need: 'install', fix: 'Install pup' }] })
  expect(await ui.find({ key: 'signin:pup' })).toBeUndefined()
})

test('Config shows the schedule: whether runs are on, when the next is, and what Watch runs in words', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, schedule: '0 9-18 * * 1-5' })
  expect(await ui.find({ key: 'schedule-state', text: /^Running · next (.* )?19:00$/ })).toBeDefined()
  expect((await ui.findAll({ key: 'cron:' }))[0].props.value).toBe('1h')
  // The plain sentence alone: the cron line it stands for is the config's business.
  expect(await ui.find({ key: 'cron-line:', text: 'Every hour from 09:00 to 18:00, Monday to Friday' })).toBeDefined()
  expect(await ui.find({ key: 'work:', text: 'Use work hours' })).toBeDefined()
  expect(await ui.find({ key: 'reload-config' })).toBeDefined()
})

test('Config lives in its own pane: Watch and Pull requests carry no Config of their own', async ($, on) => {
  const { ui } = await mounted($, on)
  expect(await ui.find({ key: 'config' })).toBeUndefined()
  expect(await (await $.ui.mount(PRS)).find({ key: 'config' })).toBeUndefined()
})

test('Pause stops scheduled runs until Resume, and the header says so', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG)
  await ui.press({ key: 'pause' })
  expect(seen.runs.some(argv => argv.slice(-2).join(' ') === 'schedule pause')).toBe(true)
  expect(await ui.find({ key: 'schedule-state', text: /^Paused since/ })).toBeDefined()
  const watch = await $.ui.mount(PANE)
  expect(await watch.find({ key: 'paused', text: 'Schedule paused' })).toBeDefined()
  expect(await (await $.ui.mount(PRS)).find({ key: 'paused', text: 'Schedule paused' })).toBeDefined()
  await ui.press({ key: 'resume' })
  expect(await ui.find({ key: 'schedule-state', text: /^Running/ })).toBeDefined()
  expect(await watch.find({ key: 'paused' })).toBeUndefined()
})

test('the builder makes the cron line from how often, the hours and the days, says it in words, and Save writes it', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, schedule: '0 9-18 * * 1-5' })
  // The line says the schedule in words; Save writes the cron line it stands for.
  const line = async (text: RegExp) => expect(await ui.find({ key: 'cron-line:', text })).toBeDefined()
  expect((await ui.findAll({ key: 'from:' }))[0].props.value).toBe('9')
  expect((await ui.findAll({ key: 'to:' }))[0].props.value).toBe('18')
  expect(await ui.find({ key: 'day:1:', text: '☑ Mon' })).toBeDefined()
  expect(await ui.find({ key: 'day:6:', text: '☐ Sat' })).toBeDefined()
  await ui.select({ key: 'cron:', value: '30m' })
  await line(/^Every 30 minutes from 09:00 to 18:30, Monday to Friday$/)
  await ui.press({ key: 'day:6:' })
  await line(/^Every 30 minutes from 09:00 to 18:30, Monday to Saturday$/)
  await ui.select({ key: 'to:', value: '20' })
  await line(/^Every 30 minutes from 09:00 to 20:30, Monday to Saturday$/)
  await ui.press({ key: 'allday:' })
  await line(/^Every 30 minutes, all day, Monday to Saturday$/)
  expect(await ui.find({ key: 'from:' })).toBeUndefined()
  await ui.select({ key: 'cron:', value: 'twice' })
  await line(/^Twice a day at 09:00 and 13:00, Monday to Saturday/)
  await ui.press({ key: 'work:' })
  await line(/^Every hour from 09:00 to 18:00, Monday to Friday$/)
  await ui.select({ key: 'cron:', value: '30m' })
  expect(seen.saved).toEqual([])
  await ui.press({ key: 'save-config' })
  expect(saved(seen).schedule).toBe('*/30 9-18 * * 1-5')
})

test('pull requests follow Watch until given a schedule of their own', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, schedule: '0 9-18 * * 1-5' })
  expect((await ui.findAll({ key: 'cron:prs' }))[0].props.value).toBe('default')
  expect(await ui.find({ key: 'sep:prs-schedule' })).toBeDefined() // a line between Watch's schedule and theirs
  expect(await ui.find({ key: 'from:prs' })).toBeUndefined()
  await ui.select({ key: 'cron:prs', value: '15m' })
  expect(await ui.find({ key: 'cron-line:prs', text: /^Every 15 minutes from 09:00 to 18:45, Monday to Friday$/ })).toBeDefined()
  await ui.press({ key: 'save-config' })
  expect([saved(seen).schedule, saved(seen).pullRequestsSchedule]).toEqual(['0 9-18 * * 1-5', '*/15 9-18 * * 1-5'])
})

test('a line the builder cannot make shows as Custom with an input, whose wrong line is refused with the reason', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, schedule: '0 9-18 * * 1-5' })
  expect(await ui.find({ key: 'cron-input:' })).toBeUndefined()
  await ui.select({ key: 'cron:', value: 'custom' })
  await ui.input({ key: 'cron-input:', text: '0 9-18 * *' })
  expect(await ui.find({ key: 'config-error', text: /needs 5 fields/ })).toBeDefined()
  expect(seen.saved).toEqual([])
  await ui.select({ key: 'cron:', value: 'custom' })
  await ui.input({ key: 'cron-input:', text: '0 8-20/2 * * 1-5' })
  expect(saved(seen).schedule).toBe('0 8-20/2 * * 1-5')
  expect(await ui.find({ key: 'config-error' })).toBeUndefined()
  expect((await ui.findAll({ key: 'cron:' }))[0].props.value).toBe('custom')
})

test('a query with its own schedule gets its own picker, saved with the rest', async ($, on) => {
  const config = { ...EDITABLE, schedule: '0 9-18 * * 1-5', repos: [{ ...EDITABLE.repos[0]!, queries: [{ ...EDITABLE.repos[0]!.queries[0]!, schedule: '*/15 9-18 * * 1-5' }] }] }
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, config)
  const key = 'cron:API|Checkout|Production|Errors'
  expect((await ui.findAll({ key }))[0].props.value).toBe('15m')
  await ui.select({ key, value: '1h' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries[0].schedule).toBe('0 9-18 * * 1-5')
})

test('the Hide bots checkbox hides dependabot by default, and shows it again', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  expect(await ui.find({ key: 'bots', text: '☐ Hide bots' })).toBeDefined()
  await ui.press({ key: 'bots' })
  expect(await ui.find({ key: 'bots', text: '☑ Hide bots' })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#15' })).toBeUndefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#12' })).toBeDefined()
  expect(await ui.find({ key: 'prs', text: /^1 open/ })).toBeDefined()
  await ui.press({ key: 'bots' })
  expect(await ui.find({ key: 'pr:acme/checkout-api#15' })).toBeDefined()
})

test('the bots to hide are the usernames the config lists', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS, { bots: ['Sam'] })
  await ui.press({ key: 'bots' })
  expect(await ui.find({ key: 'pr:acme/checkout-api#12' })).toBeUndefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#15' })).toBeDefined()
})

test('a long list draws in pages of 30 with page numbers; the count stays the whole', async ($, on) => {
  // The desktop app stops drawing a pane whose tree grows past what it takes, so long lists draw a page at a time.
  const many = { ...RESULT, pullRequests: Array.from({ length: 75 }, (_, i) => pr('acme/checkout-api', 100 + i, `Change ${i}`, 'sam', 1 + i / 2, 1 + i / 2, null)) }
  const { ui } = await mounted($, on, many, PRS)
  const rows = async () => (await ui.findAll({ type: 'Box' })).filter((b: any) => String(b.key).startsWith('pr:')).length
  expect(await ui.find({ key: 'prs', text: /^75 open/ })).toBeDefined()
  expect(await ui.find({ key: 'repo:acme/checkout-api', text: /^checkout-api75/ })).toBeDefined() // the card counts them all
  expect(await rows()).toBe(30)
  expect((await ui.findAll({ key: 'prs-page:1' }))[0].props.variant).toBe('primary')
  await ui.press({ key: 'prs-page:3' })
  expect(await rows()).toBe(15)
  await ui.press({ key: 'prs-page-prev' })
  expect(await rows()).toBe(30)
  expect((await ui.findAll({ key: 'prs-page:2' }))[0].props.variant).toBe('primary')
  await ui.select({ key: 'span', value: 'month' })
  expect((await ui.findAll({ key: 'prs-page:1' }))[0].props.variant).toBe('primary') // a new span starts at page 1
})

test('spans stop at Last month: closed pull requests are fetched for 30 days', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  expect((await ui.findAll({ key: 'span' }))[0].props.options.map((o: any) => o.label)).toEqual(['Today', 'Last 3 days', 'Last week', 'Last month'])
})

test('the state picker offers Open, Merged and Closed; Closed is closed without merging', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  expect((await ui.findAll({ key: 'state' }))[0].props.options.map((o: any) => o.label)).toEqual(['Open', 'Merged', 'Closed'])
  expect(await ui.find({ key: 'pr:acme/checkout-api#9' })).toBeUndefined()
  await ui.select({ key: 'state', value: 'merged' })
  expect(await ui.find({ key: 'prs', text: /^1 merged/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#9', text: /^Shipped retries#9kim5h$/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#8' })).toBeUndefined()
  await ui.select({ key: 'state', value: 'closed' })
  expect(await ui.find({ key: 'prs', text: /^1 closed/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#8', text: /^Dropped idea#8kim1d$/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#9' })).toBeUndefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#12' })).toBeUndefined()
})

const TERMINAL = (columns: number) => ({ ...PRS, surface: 'terminal', props: { ...PRS.props, bodyColumns: columns } }) as any

test('in the terminal, filters are buttons that step through their values, and marks are words', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, TERMINAL(120))
  expect(await ui.find({ type: 'Select' })).toBeUndefined()
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ key: 'span', text: 'Last 3 days' })).toBeDefined()
  await ui.press({ key: 'span' })
  expect(await ui.find({ key: 'span', text: 'Last week' })).toBeDefined()
  const row = (await ui.findAll({ key: 'pr:acme/checkout-api#12' }))[0]
  expect(row.props.flexDirection).toBe('column')
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: 'newRetry failed ordersWaiting on you#12sam14 files+610−288idle 2h2 open threadsci failinglee approvedmax pending' })).toBeDefined()
})

test('in a narrow terminal, a pull request splits onto two lines', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, TERMINAL(30))
  expect((await ui.findAll({ key: 'pr:acme/checkout-api#12' }))[0].props.flexDirection).toBe('column')
})

test('the checker starts with python on Windows and python3 elsewhere, keeping the user PATH', async ($, on) => {
  const seen = world(on, RESULT, {}, { USERPROFILE: 'C:\\Users\\me', OS: 'Windows_NT', PATH: 'C:\\tools' })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(seen.runs[0]!.slice(0, 1)).toEqual(['python'])
  expect(seen.envs[0]).toBeUndefined()
})

test('on macOS and Linux the user PATH comes first, then the usual tool folders', async ($, on) => {
  const { seen } = await mounted($, on)
  expect(seen.runs[0]!.slice(0, 2)).toEqual(['/usr/bin/env', 'python3'])
  expect(seen.envs[0].PATH.startsWith('/usr/bin:')).toBe(true)
})

test('pull requests can be listed without grouping, each row naming its repo', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  expect(await ui.find({ key: 'grouping', text: '☑ Group by repository' })).toBeDefined()
  await ui.press({ key: 'grouping' })
  expect(await ui.find({ key: 'grouping', text: '☐ Group by repository' })).toBeDefined()
  expect(await ui.find({ key: 'repo:acme/checkout-api' })).toBeUndefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /^Retry failed ordersWaiting on you#12checkout-api/ })).toBeDefined()
})

test('while a part refreshes, its button gives way to a plain line saying since when', async ($, on) => {
  let finish = () => {}
  on('session.start', async (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', async (_: any, e: any) => ({ clientId: e.clientId }))
  on('session.surfaces', async () => ({ value: [] }))
  on('command.register', async (_: any, e: any) => ({ value: { command: e.name } }))
  on('clock.every', async () => ({ value: { cancel: () => {} } }))
  on('env.get', async () => ({ value: undefined }))
  on('fs.read', async () => ({ value: '{}' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('process.run', async (_: any, e: any) => {
    if (e.argv.includes('run')) await new Promise<void>(done => { finish = done })
    return { value: { exitCode: 0, stdout: JSON.stringify(RESULT), stderr: '' } }
  })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  const ui = await $.ui.mount(PRS)
  const pressing = ui.press({ key: 'check:pull_requests' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await ui.find({ key: 'check:pull_requests' })).toBeUndefined()
  expect(await ui.find({ key: 'refreshing:pull_requests', text: /^Refreshing · since \d\d:\d\d$/ })).toBeDefined()
  finish()
  await pressing
  expect(await ui.find({ key: 'check:pull_requests' })).toBeDefined()
})

test('a reload during a refresh brings the Refresh button back', async ($, on) => {
  on('session.start', async (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', async (_: any, e: any) => ({ clientId: e.clientId }))
  on('session.surfaces', async () => ({ value: [] }))
  on('command.register', async (_: any, e: any) => ({ value: { command: e.name } }))
  on('clock.every', async () => ({ value: { cancel: () => {} } }))
  on('env.get', async () => ({ value: undefined }))
  on('fs.read', async () => ({ value: '{}' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('process.run', async (_: any, e: any) => {
    if (e.argv.includes('run')) await new Promise<void>(() => {}) // the reload cuts it off; it never finishes
    return { value: { exitCode: 0, stdout: JSON.stringify(RESULT), stderr: '' } }
  })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  const ui = await $.ui.mount(PRS)
  void ui.press({ key: 'check:pull_requests' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await ui.find({ key: 'check:pull_requests' })).toBeUndefined()
  await $.session.start({ cwd: '/tmp' } as any)
  expect(await ui.find({ key: 'check:pull_requests' })).toBeDefined()
})

test('history rows line up as columns: when, then High, Medium and Low counts, and no services column', async ($, on) => {
  const { ui } = await mounted($, on)
  await ui.press({ key: 'history' })
  const width = async (key: string) => (await ui.findAll({ key }))[0]?.props.width
  expect([await width('col:when:7'), await width('col:p1:7'), await width('col:p2:7'), await width('col:p3:7')].every(w => typeof w === 'number')).toBe(true)
  expect(await ui.find({ key: 'col:services:7' })).toBeUndefined()
  expect(await ui.find({ key: 'col:p1:7', text: '2' })).toBeDefined()
  expect(JSON.stringify((await ui.findAll({ key: 'col:p1:7' }))[0])).toContain('2 High services')
  expect(await ui.find({ key: 'col:p2:7', text: '1' })).toBeDefined()
  expect(await ui.find({ key: 'col:p3:7', text: '' })).toBeDefined()
})

test('a failed run in History says why, from what the tool itself said', async ($, on) => {
  const { ui } = await mounted($, on)
  await ui.press({ key: 'history' })
  expect(await ui.find({ key: 'row:8', text: /check failed/ })).toBeDefined()
  expect(await ui.find({ key: 'reason:8', text: 'Sign in to Datadog: pup auth login (Error: 401 Unauthorized)' })).toBeDefined()
})

test('Latest leaves the history list', async ($, on) => {
  const { ui } = await mounted($, on)
  await ui.press({ key: 'history' })
  expect(await ui.find({ key: 'run:7' })).toBeDefined()
  await ui.press({ key: 'latest' })
  expect(await ui.find({ key: 'run:7' })).toBeUndefined()
  expect(await ui.find({ key: 'check:watch' })).toBeDefined()
})

test('with nothing over its line, All clear sits in the middle of the card area', async ($, on) => {
  const { ui } = await mounted($, on, { ...RESULT, problems: [] })
  expect(await ui.find({ key: 'watch', text: /^Checked/ })).toBeDefined()
  const clear = (await ui.findAll({ key: 'clear' }))[0]
  expect(clear.props.alignItems).toBe('center')
  expect(await ui.find({ key: 'clear', text: 'All clearNo query crossed its alert line' })).toBeDefined()
})

test('Mute in Config stops every notification until unmuted; the other panes carry no Mute', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG)
  await ui.press({ key: 'mute' })
  expect(seen.muted).toBe(true)
  expect(await ui.find({ key: 'mute', text: 'Unmute all' })).toBeDefined()
  await ui.press({ key: 'mute' })
  expect(seen.muted).toBe(false)
  expect(await (await $.ui.mount(PANE)).find({ key: 'mute' })).toBeUndefined()
  expect(await (await $.ui.mount(PRS)).find({ key: 'mute' })).toBeUndefined()
})

const EDITABLE = {
  site: 'datadoghq.com', window: '1h', notify: { watch: true },
  repos: [{ repo: 'acme/api', name: 'API', queries: [
    { service: 'Checkout', label: 'Errors', env: 'Production', priority: 1, source: 'logs', query: 'service:api status:error', alert: { above: 19 } }] }],
}
// What Save changes wrote: every config sent to the checker's config replace, the last one last.
const saved = (seen: any) => seen.saved.at(-1)

test('Config names the file, what it holds and that it holds to the schema', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  expect(await ui.find({ key: 'config-file', text: /~\/\.on-my-watch\/config\.json/ })).toBeDefined()
  expect(await ui.find({ key: 'config-counts', text: /^1 repository · 1 query · 1 environment$/ })).toBeDefined()
  // Its own line, no leading dot.
  expect(await ui.find({ key: 'config-state', text: /^valid · read \d\d:\d\d$/ })).toBeDefined()
})

test('Open in editor opens the config file with the system\'s opener', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.press({ key: 'open-config' })
  expect(seen.runs).toContainEqual(['open', '/home/me/.on-my-watch/config.json'])
})

test('narrow, each label sits above its field so the field and its hint get the width', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, { ...CONFIG, props: { ...CONFIG.props, bodyColumns: 40 } }, EDITABLE)
  expect((await ui.findAll({ key: 'row:site' }))[0].props.flexDirection).toBe('column')
})

test('short settings get short fields', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  expect((await ui.findAll({ key: 'fill:set:window' }))[0].props.width).toBe(12)
  expect((await ui.findAll({ key: 'fill:set:historyDays' }))[0].props.width).toBe(8)
})

test('on the desktop an environment group is a name and chips: × takes one out, + add picks one the queries use', async ($, on) => {
  const doc = { ...EDITABLE, environments: { Production: ['Production', 'Canary'] },
    repos: [{ ...EDITABLE.repos[0], queries: [...EDITABLE.repos[0]!.queries, { ...EDITABLE.repos[0]!.queries[0], env: 'Shadow' }] }] }
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, doc)
  expect(await ui.find({ key: 'env-chip:0:Canary', text: 'Canary' })).toBeDefined()
  await ui.press({ key: 'env-chip-remove:0:Canary' })
  expect(saved(seen).environments).toEqual({ Production: ['Production'] })
  const add = (await ui.findAll({ key: 'env-add:0' }))[0]
  // Canary is in no group and no query any more, so only the queries' Shadow is left to add.
  expect(add.props.options.map((o: any) => o.label)).toEqual(['+ add', 'Shadow'])
  await ui.select({ key: 'env-add:0', value: 'Shadow' })
  expect(saved(seen).environments).toEqual({ Production: ['Production', 'Shadow'] })
})

test('Remove is a dim plain button, so three of them do not pull the eye', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, environments: { Production: ['Production'] } })
  const remove = (await ui.findAll({ key: 'env-remove:0' }))[0]
  // Its red on hover is the desktop's to draw; the test kit does not report hover styles.
  expect([remove.props.plain, remove.props.dimColor, remove.props.label]).toEqual([true, true, 'Remove'])
})

test('on the desktop the bots are chips: × takes one out, typing a name adds one', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, bots: ['dependabot', 'renovate'] })
  await ui.press({ key: 'bot-chip-remove:renovate' })
  expect(saved(seen).bots).toEqual(['dependabot'])
  await ui.input({ key: 'bot-add', text: 'snyk-bot' })
  expect(saved(seen).bots).toEqual(['dependabot', 'snyk-bot'])
})

test('no icon the Config pane draws repeats an attribute, which would make its SVG invalid', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  for (const icon of await ui.findAll({ type: 'Svg' })) {
    for (const tag of String(icon.props.source).match(/<[a-z]+[^>]*>/g) ?? []) {
      const names = [...tag.matchAll(/\s([a-z-]+)=/g)].map(m => m[1])
      expect(new Set(names).size).toBe(names.length)
    }
  }
})

test('Enter in a field saves the whole config; in the terminal an emptied list is taken out', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  const terminal = await $.ui.mount({ ...CONFIG, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'save-config' })).toBeUndefined()
  expect(await terminal.find({ key: 'hint:bots', text: 'Separate usernames with commas: dependabot, renovate' })).toBeDefined()
  expect(await ui.find({ key: 'hint:window', text: 'A number and m, h or d: 15m, 4h, 7d' })).toBeDefined()
  await ui.input({ key: 'set:site', text: 'datadoghq.eu' })
  expect(saved(seen).site).toBe('datadoghq.eu')
  await terminal.input({ key: 'set:bots', text: '' })
  expect('bots' in saved(seen)).toBe(false)
})

test('every change waits for the one Save changes; Discard drops them', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.input({ key: 'set:window', text: '4h', kind: 'change' })
  await ui.input({ key: 'set:historyDays', text: '14', kind: 'change' })
  await ui.press({ key: 'set:notify.watch' })
  expect(await ui.find({ key: 'save-bar', text: /Unsaved changes/ })).toBeDefined()
  expect(seen.saved).toEqual([])
  await ui.press({ key: 'save-config' })
  expect([saved(seen).window, saved(seen).historyDays, saved(seen).notify.watch]).toEqual(['4h', 14, false])
  expect(await ui.find({ key: 'save-config' })).toBeUndefined()
  await ui.input({ key: 'set:window', text: '2h', kind: 'change' })
  await ui.press({ key: 'discard-config' })
  expect((await ui.findAll({ key: 'set:window' }))[0].props.value).toBe('4h') // back to what was saved
  expect(seen.saved.length).toBe(1)
})

test('fields the schema requires carry a red asterisk; optional ones do not', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  expect(await ui.find({ key: 'label:site', text: 'Datadog site *' })).toBeDefined()
  expect(await ui.find({ key: 'label:historyDays', text: 'History rotation' })).toBeDefined()
})

test('every field label takes the same width, so the fields line up', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  const widths = (await ui.findAll({ type: 'Box' })).filter((b: any) => String(b.key).startsWith('label:')).map((b: any) => b.props.width)
  expect(widths.length).toBeGreaterThan(4)
  expect(new Set(widths).size).toBe(1)
})

test('notification and pane switches save as booleans', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  expect(await ui.find({ key: 'set:notify.watch', text: '☑ Watch' })).toBeDefined()
  await ui.press({ key: 'set:notify.watch' })
  expect(await ui.find({ key: 'set:notify.watch', text: '☐ Watch' })).toBeDefined()
  await ui.press({ key: 'set:panes.pull_requests' })
  await ui.press({ key: 'save-config' })
  expect([saved(seen).notify.watch, saved(seen).panes.pull_requests]).toEqual([false, false])
})

test('a refusal with many problems shows the first three and how many more', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.input({ key: 'set:site', text: 'many' })
  expect(await ui.find({ key: 'config-error', text: /^Not saved:config\.repos\[0\]: wrong.*config\.repos\[2\]: wrong.*and 7 more$/ })).toBeDefined()
})

test('Reload clears an old refusal, which no longer says anything about the file read', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.input({ key: 'set:site', text: 'bad' })
  expect(await ui.find({ key: 'config-error' })).toBeDefined()
  await ui.press({ key: 'reload-config' })
  expect(await ui.find({ key: 'config-error' })).toBeUndefined()
})

test('a refused change says why and saves nothing', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.input({ key: 'set:site', text: 'bad' })
  expect(await ui.find({ key: 'config-error', text: 'config.site: must be a known Datadog site' })).toBeDefined()
})

test('each Config section is a card with its heading; repositories are edited in the file, not here', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  for (const card of ['file', 'watch', 'envs', 'prs', 'notify', 'schedule'])
    expect((await ui.findAll({ key: `card:${card}` }))[0].props.borderStyle).toBe('round')
  expect(await ui.find({ key: 'card:repos' })).toBeUndefined()
})

test('environments grouped in the config are one choice in Watch, covering each env they name', async ($, on) => {
  const config = { environments: { Production: ['Production', 'Staging'] }, repos: [{ repo: 'acme/api', name: 'API', queries: [
    { service: 'Checkout', env: 'Production', priority: 1 }, { service: 'Queue', env: 'Staging', priority: 2 }, { service: 'Queue', env: 'Testing', priority: 2 }] }] }
  const { ui } = await mounted($, on, RESULT, PANE, config)
  expect((await ui.findAll({ key: 'envs' }))[0].props.options.map((o: any) => o.label)).toEqual(['All environments', 'Production', 'Testing'])
  await ui.select({ key: 'envs', value: 'Production' })
  expect(await ui.find({ key: 'card:API@Production' })).toBeDefined()
  expect(await ui.find({ key: 'card:Worker@Staging' })).toBeDefined()
})

const GROUPED = { ...EDITABLE, environments: { Production: ['Production', 'Canary'], Testing: ['Testing'] }, repos: [{ repo: 'acme/api', name: 'API', queries: [
  EDITABLE.repos[0]!.queries[0]!, { ...EDITABLE.repos[0]!.queries[0]!, env: 'Canary' }] }] }

test('Config counts environments as the Environments section lists them', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, GROUPED)
  expect(await ui.find({ key: 'config-counts', text: /· 2 environments/ })).toBeDefined()
})

test('Watch filters by the Environments section: a group, then each env no group names', async ($, on) => {
  const config = { ...GROUPED, repos: [...GROUPED.repos, { repo: 'acme/worker', name: 'Worker', queries: [{ ...EDITABLE.repos[0]!.queries[0]!, env: 'Staging' }] }] }
  const { ui } = await mounted($, on, RESULT, PANE, config)
  expect((await ui.findAll({ key: 'envs' }))[0].props.options.map((o: any) => o.label)).toEqual(['All environments', 'Production', 'Testing', 'Staging'])
})

test('in a narrow terminal an environment group puts its members on a line of their own', async ($, on) => {
  await mounted($, on, RESULT, CONFIG, { ...EDITABLE, environments: { Production: ['Production', 'Legacy production'] } })
  const ui = await $.ui.mount({ ...CONFIG, surface: 'terminal', props: { ...CONFIG.props, bodyColumns: 50 } } as any)
  expect((await ui.findAll({ key: 'env-row:0' }))[0].props.flexDirection).toBe('column')
})

test('a Config card\'s icon is not written out as a word in the terminal', async ($, on) => {
  await mounted($, on, RESULT, CONFIG, EDITABLE)
  const ui = await $.ui.mount({ ...CONFIG, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'h:prs', text: /^Pull requests/ })).toBeDefined()
})

test('in the terminal, the Environments card edits each group as a name and a comma-separated list', async ($, on) => {
  const { seen } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, environments: { Production: ['Production', 'Canary'] } })
  const ui = await $.ui.mount({ ...CONFIG, surface: 'terminal' } as any)
  const value = async (key: string) => (await ui.findAll({ key }))[0].props.value
  expect([await value('env-group:0'), await value('env-members:0')]).toEqual(['Production', 'Production, Canary'])
  await ui.input({ key: 'env-members:0', text: 'Production, Canary, Shadow', kind: 'change' })
  await ui.input({ key: 'env-group-new', text: 'Testing', kind: 'change' })
  await ui.input({ key: 'env-members-new', text: 'Testing, Preview', kind: 'change' })
  await ui.press({ key: 'env-add' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).environments).toEqual({ Production: ['Production', 'Canary', 'Shadow'], Testing: ['Testing', 'Preview'] })
  await ui.press({ key: 'env-remove:0' })
  await ui.press({ key: 'env-remove:0' })
  await ui.press({ key: 'save-config' })
  expect('environments' in saved(seen)).toBe(false)
})

test('each repository card is headed by the repository name and its count', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  expect(await ui.find({ key: 'repo:acme/checkout-api', text: /^checkout-api2/ })).toBeDefined()
})

test('priorities are High in red, Medium in yellow and Low in grey, with no Priorities card to set them', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PANE)
  const icon = async (name: string) => (await ui.findAll({ type: 'Svg' })).find((i: any) => i.props.alt === `priority ${name}`)?.props.source
  expect([await icon('High'), await icon('Medium'), await icon('Low')].map(src => src?.match(/fill="(#[0-9A-F]+)"/)?.[1]))
    .toEqual(['#D0485C', '#E0B400', '#8A8A8A'])
  expect(await (await $.ui.mount(CONFIG)).find({ key: 'card:priorities' })).toBeUndefined()
})

test('in a narrow desktop pane a pull request puts its title first, then who, when, CI and reviewers', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, { ...PRS, props: { ...PRS.props, bodyColumns: 40 } })
  const row = (await ui.findAll({ key: 'pr:acme/checkout-api#12' }))[0]
  expect(row.props.flexDirection).toBe('column')
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /^Retry failed orders#12sam.*Waiting on you$/ })).toBeDefined()
  const alts = (await ui.findAll({ type: 'Svg' })).map((i: any) => i.props.alt)
  expect(alts).toEqual(expect.arrayContaining(['CI failing', 'lee: approved', 'max: pending']))
})

test('an author links to their GitHub profile, a bot to its app page', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, PRS)
  const links = (await ui.findAll({ type: 'Link' })).map((l: any) => [l.props.label, l.props.href])
  expect(links).toContainEqual(['sam', 'https://github.com/sam'])
  expect(links).toContainEqual(['dependabot', 'https://github.com/apps/dependabot'])
})

test('reviewer pictures are read once per pull request fetch, not on every reload', async ($, on) => {
  const { seen } = await mounted($, on, RESULT, PRS)
  await $.ui.mount(PANE)
  await $.command.run({ name: 'watch' } as any).catch(() => {})
  expect(seen.runs.filter(argv => argv.includes('avatars')).length).toBe(1)
})
