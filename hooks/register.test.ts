import { expect, test } from 'claude-code/testing'

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
    problem('API', 'Checkout', 'Production', 'Error logs', 1, 'logs', '72', 'above 20'),
    problem('API', 'Checkout', 'Production', 'Slow requests', 3, 'traces', '3.70s', 'above 2.00s'),
    problem('Worker', 'Queue', 'Staging', 'Queue depth', 2, 'metrics', '540', 'above 500', { notify: false }),
  ],
  span: { from: '2026-10-16T12:34:00+00:00', to: '2026-10-16T13:34:00+00:00' },
  prsCheckedAt: '2026-10-16T13:40:00+00:00',
  prErrors: [],
  setup: [],
  pullRequests: [
    { ...pr('acme/checkout-api', 12, 'Retry failed orders', 'sam', 2, 2, 'APPROVED'), ci: 'failing',
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
  const seen = { opened: [] as string[], runs: [] as string[][], envs: [] as any[], submitted: [] as string[], muted: false, quiet: [] as string[], saved: [] as any[],
    schedule: { paused: null as string | null, schedule: '0 9-18 * * 1-5', next: '2026-10-19T19:00:00', own: [{ entry: 'API|Checkout|Production|Error logs', schedule: '*/15 9-18 * * 1-5' }] } }
  on('session.start', async (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', async (_: any, e: any) => ({ clientId: e.clientId }))
  on('session.surfaces', async () => ({ value: [] }))
  on('command.register', async (_: any, e: any) => ({ value: { command: e.name } }))
  on('clock.every', async () => ({ value: { cancel: () => {} } }))
  on('env.get', async (_: any, e: any) => ({ value: env[e.name] }))
  // The file as last saved, so a pane that reads it again after Save sees what was written.
  on('fs.read', async () => ({ value: JSON.stringify(seen.saved.at(-1) ?? config) }))
  on('process.run', async (_: any, e: any) => {
    seen.runs.push([...e.argv])
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

test('the desktop app attaching opens a Watch pane, a Pull requests pane and a Config pane', async ($, on) => {
  const { seen } = await mounted($, on)
  expect(seen.opened).toEqual(['on-my-watch', 'on-my-watch-prs', 'on-my-watch-config'])
})

test('a pane turned off in the config does not open', async ($, on) => {
  const { seen } = await mounted($, on, RESULT, PANE, { panes: { pull_requests: false } })
  expect(seen.opened).toEqual(['on-my-watch', 'on-my-watch-config'])
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
  expect(await ui.find({ key: 'card:API@Production', text: /^APIProductionInvestigateCheckoutError logs72above 20OnSlow requests3\.70sabove 2\.00sOn$/ })).toBeDefined()
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
  expect(row.children.map((c: any) => c.props.width ?? c.props.minWidth)).toEqual([2, 0, 2, 8, 18, undefined])
})

test('in a narrow pane a row puts the value at the right of its label, then the alert line and bell beneath', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, { ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  const row = (await ui.findAll({ key: 'q:Checkout:Error logs' }))[0]
  expect(row.props.flexDirection).toBe('column')
  const text = (node: any): string => (typeof node === 'string' ? node : (node.children ?? []).map(text).join(''))
  const [first, second] = row.children
  expect(text(first)).toBe('Error logs72')
  expect(text(second)).toBe('above 20')
  expect(await ui.find({ key: 'bell:API|Checkout|Production|Error logs', text: 'On' })).toBeDefined()
  expect(await ui.find({ key: 'q:Checkout:Error logs', text: 'Error logs72above 20On' })).toBeDefined()
})

test('a service with one query shares its row instead of a heading', async ($, on) => {
  const { ui } = await mounted($, on)
  expect(await ui.find({ key: 'svc:Queue' })).toBeUndefined()
  expect(await ui.find({ key: 'q:Queue:Queue depth', text: /^Queue · Queue depth540/ })).toBeDefined()
  expect(await ui.find({ key: 'svc:Checkout' })).toBeDefined()
})

test('each row turns its own notifications off and on; the config can keep one off', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  await ui.press({ key: 'bell:API|Checkout|Production|Error logs' })
  expect(seen.quiet).toEqual(['API|Checkout|Production|Error logs'])
  expect(await ui.find({ key: 'bell:API|Checkout|Production|Error logs', text: 'Off' })).toBeDefined()
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
  expect(await ui.find({ key: 'prs', text: /^2 open · last 3 days · Last refresh (.* )?\d\d:40/ })).toBeDefined()
  expect(await prKeys()).toEqual(['pr:acme/checkout-api#12', 'pr:acme/checkout-api#15'])
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /^#12Retry failed orderssam2h$/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#15', text: /^#15Bump the HTTP clientdependabot2d$/ })).toBeDefined()
  // Icons are our own Svgs on the desktop, each named for a screen reader.
  const alts = (await ui.findAll({ type: 'Svg' })).map((i: any) => i.props.alt)
  expect(alts).toEqual(expect.arrayContaining(['new', 'CI failing', 'lee: approved', 'max: pending']))

  await ui.select({ key: 'span', value: 'month' })
  expect(await prKeys()).toEqual(['pr:acme/checkout-api#12', 'pr:acme/checkout-api#15', 'pr:acme/checkout-worker#7'])
})

test('investigate sends the problem to Claude', async ($, on) => {
  const { ui, seen } = await mounted($, on)
  await ui.press({ key: 'inv:API@Production' })
  expect(seen.submitted[0]).toContain('Investigate API (acme/checkout-api) in Production')
  expect(seen.submitted[0]).toContain('- P1 Checkout: Error logs is 72 (above 20), logs query `service:x Error logs`')
  expect(seen.submitted[0]).toContain('https://app.datadoghq.com/Error logs')
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
  expect(await ui.find({ key: 'cron-line:', text: 'Every hour from 09:00 to 18:00, Monday to Friday · 0 9-18 * * 1-5' })).toBeDefined()
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
  const line = async (text: RegExp) => expect(await ui.find({ key: 'cron-line:', text })).toBeDefined()
  expect((await ui.findAll({ key: 'from:' }))[0].props.value).toBe('9')
  expect((await ui.findAll({ key: 'to:' }))[0].props.value).toBe('18')
  expect(await ui.find({ key: 'day:1:', text: '☑ Mon' })).toBeDefined()
  expect(await ui.find({ key: 'day:6:', text: '☐ Sat' })).toBeDefined()
  await ui.select({ key: 'cron:', value: '30m' })
  await line(/· \*\/30 9-18 \* \* 1-5$/)
  await ui.press({ key: 'day:6:' })
  await line(/· \*\/30 9-18 \* \* 1-6$/)
  await ui.select({ key: 'to:', value: '20' })
  await line(/· \*\/30 9-20 \* \* 1-6$/)
  await ui.press({ key: 'allday:' })
  await line(/· \*\/30 \* \* \* 1-6$/)
  expect(await ui.find({ key: 'from:' })).toBeUndefined()
  await ui.select({ key: 'cron:', value: 'twice' })
  await line(/^Twice a day at 09:00 and 13:00, Monday to Saturday/)
  await ui.press({ key: 'work:' })
  await line(/· 0 9-18 \* \* 1-5$/)
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
  expect(await ui.find({ key: 'cron-line:prs', text: /· \*\/15 9-18 \* \* 1-5$/ })).toBeDefined()
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
  expect(await ui.find({ key: 'prs', text: /^1 open · last 3 days/ })).toBeDefined()
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

test('an open repository lists its queries in pages of 30 too', async ($, on) => {
  const config = { ...EDITABLE, repos: [{ ...EDITABLE.repos[0]!, queries: Array.from({ length: 40 }, (_, i) => ({ ...EDITABLE.repos[0]!.queries[0]!, label: `Q${i}` })) }] }
  const { ui } = await mounted($, on, RESULT, CONFIG, config)
  await ui.press({ key: 'repo:repos.0' })
  const rows = async () => (await ui.findAll({ type: 'Box' })).filter((b: any) => String(b.key).startsWith('query:')).length
  expect(await rows()).toBe(30)
  await ui.press({ key: 'queries-page:2' })
  expect(await rows()).toBe(10)
  expect(await ui.find({ key: 'query:repos.0.queries.35' })).toBeDefined()
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
  expect(await ui.find({ key: 'prs', text: /^1 merged · last 3 days/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#9', text: /^#9Shipped retrieskim5h$/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#8' })).toBeUndefined()
  await ui.select({ key: 'state', value: 'closed' })
  expect(await ui.find({ key: 'prs', text: /^1 closed · last 3 days/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:acme/checkout-api#8', text: /^#8Dropped ideakim1d$/ })).toBeDefined()
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
  expect(row.props.flexDirection).toBe('row')
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: 'new#12Retry failed orderssam2hci failinglee approvedmax pending' })).toBeDefined()
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
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /^#12checkout-apiRetry failed orders/ })).toBeDefined()
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
  expect(await ui.find({ key: 'watch', text: /^Checked · last hour/ })).toBeDefined()
  const clear = (await ui.findAll({ key: 'clear' }))[0]
  expect(clear.props.alignItems).toBe('center')
  expect(await ui.find({ key: 'clear', text: 'All clearNo query crossed its alert line' })).toBeDefined()
})

test('Mute in Config stops every notification until unmuted; the other panes carry no Mute', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG)
  await ui.press({ key: 'mute' })
  expect(seen.muted).toBe(true)
  expect(await ui.find({ key: 'mute', text: 'Unmute' })).toBeDefined()
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
  expect(await ui.find({ key: 'config-counts', text: /^1 repository · 1 query · 1 environment\s*· valid/ })).toBeDefined()
})

test('the chevron is part of the repository button, in the accent colour: pressing it folds and unfolds', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  const button = async () => (await ui.findAll({ key: 'repo:repos.0' }))[0]
  expect(await ui.find({ key: 'repo:repos.0', text: /^▶ ?API$/ })).toBeDefined()
  expect(JSON.stringify(await button())).toContain('"color":"claude"')
  expect((await button()).props.label).toBe('▶ API') // the children's text, not a label drawn in their place
  await ui.press({ key: 'repo:repos.0' })
  expect(await ui.find({ key: 'repo:repos.0', text: /^▼ ?API$/ })).toBeDefined()
  expect(await ui.find({ key: 'query:repos.0.queries.0' })).toBeDefined()
  await ui.press({ key: 'repo:repos.0' })
  expect(await ui.find({ key: 'query:repos.0.queries.0' })).toBeUndefined()
})

test('no icon the Config pane draws repeats an attribute, which would make its SVG invalid', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.press({ key: 'repo:repos.0' })
  for (const icon of await ui.findAll({ type: 'Svg' })) {
    for (const tag of String(icon.props.source).match(/<[a-z]+[^>]*>/g) ?? []) {
      const names = [...tag.matchAll(/\s([a-z-]+)=/g)].map(m => m[1])
      expect(new Set(names).size).toBe(names.length)
    }
  }
})

test('Enter in a field saves the whole config; an emptied list is taken out', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  expect(await ui.find({ key: 'save-config' })).toBeUndefined()
  expect(await ui.find({ key: 'hint:bots', text: 'Separate usernames with commas: dependabot, renovate' })).toBeDefined()
  await ui.input({ key: 'set:site', text: 'datadoghq.eu' })
  expect(saved(seen).site).toBe('datadoghq.eu')
  await ui.input({ key: 'set:bots', text: '' })
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
  await ui.press({ key: 'add:repos' })
  expect(await ui.find({ key: 'label:field:repo', text: 'Repository (owner/name) *' })).toBeDefined()
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

test('a repository opens to its queries; a new query is added from its form', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  expect(await ui.find({ key: 'query:repos.0.queries.0' })).toBeUndefined()
  await ui.press({ key: 'repo:repos.0' })
  expect(await ui.find({ key: 'query:repos.0.queries.0', text: /^CheckoutProductionErrors/ })).toBeDefined()
  await ui.press({ key: 'add:repos.0.queries' })
  for (const [field, text] of [['service', 'Checkout'], ['label', 'Warnings'], ['query', 'service:api status:warn'], ['above', '50']])
    await ui.input({ key: `field:${field}`, text, kind: 'change' })
  // Environment and priority are picked from the config's own; Other… takes a new environment.
  expect((await ui.findAll({ key: 'field:env' }))[0].props.options.map((o: any) => o.label)).toEqual(['Production', 'Other…'])
  expect((await ui.findAll({ key: 'field:priority' }))[0].props.options.map((o: any) => o.label)).toEqual(['High', 'Medium', 'Low'])
  await ui.select({ key: 'field:env', value: 'Production' })
  await ui.select({ key: 'field:priority', value: '2' })
  expect(await ui.find({ key: 'query-preview', text: 'service:api status:warn' })).toBeDefined()
  expect(await ui.find({ key: 'field:compute' })).toBeDefined()
  expect(await ui.find({ key: 'field:reduce' })).toBeUndefined()
  expect(await ui.find({ key: 'row:field:line', text: /Line/ })).toBeDefined()
  await ui.press({ key: 'form-save' })
  expect(await ui.find({ key: 'query:repos.0.queries.1' })).toBeDefined()
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries[1]).toEqual({ service: 'Checkout', label: 'Warnings', env: 'Production', priority: 2, source: 'logs', query: 'service:api status:warn', alert: { above: 50 } })
})

test('Save changes takes in a form still open, with settings typed too', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.input({ key: 'set:window', text: '4h', kind: 'change' })
  await ui.press({ key: 'repo:repos.0' })
  await ui.press({ key: 'edit:repos.0.queries.0' })
  await ui.input({ key: 'field:above', text: '30', kind: 'change' })
  await ui.press({ key: 'save-config' })
  expect([saved(seen).window, saved(seen).repos[0].queries[0].alert]).toEqual(['4h', { above: 30 }])
})

test('Save changes takes in a form still open', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.press({ key: 'repo:repos.0' })
  await ui.press({ key: 'edit:repos.0.queries.0' })
  await ui.input({ key: 'field:above', text: '30', kind: 'change' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries[0].alert).toEqual({ above: 30 })
})

test('editing a query keeps what the form does not show, and Delete asks first', async ($, on) => {
  const config = { ...EDITABLE, repos: [{ ...EDITABLE.repos[0]!, queries: [{ ...EDITABLE.repos[0]!.queries[0]!, schedule: '*/15 * * * *' }] }] }
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, config)
  await ui.press({ key: 'repo:repos.0' })
  await ui.press({ key: 'edit:repos.0.queries.0' })
  await ui.input({ key: 'field:above', text: '30', kind: 'change' })
  await ui.press({ key: 'form-save' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries[0]).toMatchObject({ label: 'Errors', alert: { above: 30 }, schedule: '*/15 * * * *' })
  await ui.press({ key: 'delete:repos.0.queries.0' })
  expect(await ui.find({ key: 'query:repos.0.queries.0' })).toBeDefined()
  await ui.press({ key: 'delete-yes:repos.0.queries.0' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries).toEqual([])
})

test('a new environment is typed after Other…', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.press({ key: 'repo:repos.0' })
  await ui.press({ key: 'edit:repos.0.queries.0' })
  await ui.select({ key: 'field:env', value: 'other' })
  await ui.input({ key: 'field:env-other', text: 'Staging', kind: 'change' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries[0].env).toBe('Staging')
})

test('each Config section is a card with its heading', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  for (const card of ['file', 'watch', 'envs', 'prs', 'notify', 'schedule', 'repos'])
    expect((await ui.findAll({ key: `card:${card}` }))[0].props.borderStyle).toBe('round')
})

test('repository actions are real buttons: adding is the main one, deleting reads in red', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.press({ key: 'repo:repos.0' })
  const props = async (key: string) => (await ui.findAll({ key }))[0].props
  expect([(await props('add:repos.0.queries')).variant, (await props('edit:repos.0')).variant, (await props('delete:repos.0')).variant])
    .toEqual(['primary', 'secondary', 'secondary'])
  expect(JSON.stringify((await ui.findAll({ key: 'delete:repos.0' }))[0])).toContain('"color":"error"')
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

test('the query form lists the Environments section, each env under its group, and keeps the env it saves', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, GROUPED)
  await ui.press({ key: 'repo:repos.0' })
  await ui.press({ key: 'edit:repos.0.queries.1' })
  const env = (await ui.findAll({ key: 'field:env' }))[0].props
  expect(env.options.map((o: any) => o.label)).toEqual(['Production', 'Production · Canary', 'Testing', 'Other…'])
  expect(env.value).toBe('Canary')
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries[1].env).toBe('Canary')
})

test('an environment typed after Other… joins the group picked for it', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, GROUPED)
  await ui.press({ key: 'repo:repos.0' })
  await ui.press({ key: 'edit:repos.0.queries.0' })
  await ui.select({ key: 'field:env', value: 'other' })
  expect((await ui.findAll({ key: 'field:env-group' }))[0].props.options.map((o: any) => o.label)).toEqual(['No group', 'Production', 'Testing'])
  await ui.input({ key: 'field:env-other', text: 'Shadow production', kind: 'change' })
  await ui.select({ key: 'field:env-group', value: 'Production' })
  await ui.press({ key: 'form-save' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[0].queries[0].env).toBe('Shadow production')
  expect(saved(seen).environments.Production).toEqual(['Production', 'Canary', 'Shadow production'])
})

test('a new environment from Other… still joins its group when the Environments card was edited too', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, GROUPED)
  await ui.input({ key: 'env-members:1', text: 'Testing, Preview', kind: 'change' })
  await ui.press({ key: 'repo:repos.0' })
  await ui.press({ key: 'edit:repos.0.queries.0' })
  await ui.select({ key: 'field:env', value: 'other' })
  await ui.input({ key: 'field:env-other', text: 'Shadow production', kind: 'change' })
  await ui.select({ key: 'field:env-group', value: 'Production' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).environments).toEqual({ Production: ['Production', 'Canary', 'Shadow production'], Testing: ['Testing', 'Preview'] })
})

test('Config counts environments as the Environments section lists them', async ($, on) => {
  const { ui } = await mounted($, on, RESULT, CONFIG, GROUPED)
  expect(await ui.find({ key: 'config-counts', text: /· 2 environments/ })).toBeDefined()
})

test('Watch filters by the Environments section: a group, then each env no group names', async ($, on) => {
  const config = { ...GROUPED, repos: [...GROUPED.repos, { repo: 'acme/worker', name: 'Worker', queries: [{ ...EDITABLE.repos[0]!.queries[0]!, env: 'Staging' }] }] }
  const { ui } = await mounted($, on, RESULT, PANE, config)
  expect((await ui.findAll({ key: 'envs' }))[0].props.options.map((o: any) => o.label)).toEqual(['All environments', 'Production', 'Testing', 'Staging'])
})

test('the Environments card edits each group as a name and a comma-separated list', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, { ...EDITABLE, environments: { Production: ['Production', 'Canary'] } })
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

test('the filter narrows the repositories by name or repo', async ($, on) => {
  const config = { ...EDITABLE, repos: [...EDITABLE.repos, { repo: 'acme/worker', name: 'Worker', queries: [] }] }
  const { ui } = await mounted($, on, RESULT, CONFIG, config)
  await ui.input({ key: 'repo-filter', text: 'work', kind: 'change' })
  expect(await ui.find({ key: 'repo:repos.0' })).toBeUndefined()
  expect(await ui.find({ key: 'repo:repos.1' })).toBeDefined()
})

test('a new repository is added from its form', async ($, on) => {
  const { ui, seen } = await mounted($, on, RESULT, CONFIG, EDITABLE)
  await ui.press({ key: 'add:repos' })
  await ui.input({ key: 'field:repo', text: 'acme/worker', kind: 'change' })
  await ui.input({ key: 'field:name', text: 'Worker', kind: 'change' })
  await ui.press({ key: 'form-save' })
  await ui.press({ key: 'save-config' })
  expect(saved(seen).repos[1]).toEqual({ repo: 'acme/worker', name: 'Worker', queries: [] })
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
  expect(await ui.find({ key: 'pr:acme/checkout-api#12', text: /^#12Retry failed orderssam· 2h$/ })).toBeDefined()
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
