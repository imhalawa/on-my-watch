// What bin/on_my_watch.py stores per run and prints with `latest`; the pane only reads it.

/** A query of a named entry that crossed its alert line in the checked window. */
export type Problem = {
  /** The repository's name from the config, such as Checkout. */
  name: string
  /** The repository, owner/name. */
  repo?: string | null
  /** The service in that repository, as the config names it. */
  service?: string
  /** The query's own env, for display; the query itself says which data it reads. */
  env: string
  label: string
  /** Rank: 1 is the most urgent. */
  priority?: number | null
  /** The priority as the config names it: high, or P1 when priorities are numbers. */
  priorityName?: string
  source: 'logs' | 'traces' | 'metrics'
  value: string
  /** The alert line it crossed, in words: `above 19`. */
  alert?: string
  /** The query in Datadog, pinned to the checked window. */
  link: string
  query: string
  /** The config's notify for this query; false keeps it in the pane only. */
  notify?: boolean
  /** The count as measured; runs stored before it was kept have none. */
  raw?: number | null
  /** The alert line as a number, when the query alerts above one. */
  threshold?: number | null
  /** The last runs, worked out when the newest is read. */
  trend?: {
    /** Oldest first; null where the entry was under its line. */
    values: (number | null)[]
    /** When its current unbroken stretch over the line began. */
    since: string | null
    previous: number | null
    /** The run before didn't have it. */
    isNew: boolean
  }
}

export type PullRequest = {
  /** Its size: files changed, lines added and taken out. Older runs have none. */
  files?: number | null
  additions?: number | null
  deletions?: number | null
  /** It conflicts with its base; behind it. */
  conflicts?: boolean
  behind?: boolean
  /** Review threads not yet resolved. */
  threads?: number
  /** The names of the entries whose repo this is. */
  name?: string
  /** Older runs only, before entries had names. */
  service?: string
  alias?: string | null
  repo: string
  number: number
  title: string
  author: string | null
  /** The author is a bot account, such as dependabot. */
  bot: boolean
  draft: boolean
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  /** All checks in one state; null when the PR has none. */
  ci?: 'passing' | 'failing' | 'running' | null
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  createdAt: string
  /** Last activity; the list is sorted and filtered by it. */
  updatedAt: string
  /** Closed and merged ones: when; a later comment moves updatedAt, not this. */
  closedAt?: string | null
  /** Who reviewed or is asked to: approved, asked for changes, or still pending. */
  reviewers?: { login: string; review: 'approved' | 'changes' | 'pending' }[]
  url: string
}

export type Part = 'watch' | 'pull_requests'

export type Result = {
  /** When observability last ran; null until it has. */
  checkedAt: string | null
  window: string
  /** The exact window the watch run counted; every link of the run is pinned to it. */
  span?: { from: string; to: string }
  status: 'ok' | 'failed'
  errors: string[]
  problems: Problem[]
  pullRequests: PullRequest[]
  /** When pull requests were last fetched; null until they have been. */
  prsCheckedAt: string | null
  /** Who the GitHub CLI is signed in as: whose review a PR waits on. */
  viewer?: string | null
  prErrors: string[]
  /** What the user must do first: install or sign in to pup or gh. */
  setup: { tool: 'pup' | 'gh'; need?: 'install' | 'login'; fix: string }[]
}

/** One past watch run, from the checker's `history`. */
export type RunSummary = {
  id: number; checkedAt: string; status: 'ok' | 'failed'; span?: { from: string; to: string }
  /** Why a failed run failed: the fix it needed and what pup or gh said; absent for an ok run. */
  reason?: string | null
  /** What it found: problems, and how many per label (most urgent first). */
  problems: number; labels?: { label: string; count: number; priority: number | null; priorityName: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'on-my-watch': { result: Result | null; running: Part | 'all' | null
      runningSince: string | null; span: string; hideBots: boolean; prState: 'open' | 'merged' | 'closed'
      /** The page of pull requests shown, from 1. */
      prPage: number
      priorityFilter: string
      nameFilter: string
      envFilter: string
      /** What the Watch dropdowns offer, from the config's entries and queries. */
      choices: { names: string[]; envs: string[]; envGroups: Record<string, string[]>; priorities: string[]; bots: string[] }
      /** Entries whose notifications are turned off from the pane, as `repo name|service|env|label`. */
      quietEntries: string[]
      groupPrs: boolean
      watchView: 'latest' | 'history' | 'archived'
      /** The config as the Config pane edits it; when it was read, and the schema's objections to it. */
      configDoc: Record<string, any> | null
      configReadAt: string
      configProblems: string[]
      /** Why the last change was refused; empty when it saved. */
      configError: string
      /** Settings typed but not saved yet, by path. */
      settingsDraft: Record<string, string> | null
      /** The environment groups as typed, [name, comma-separated members] row by row; null until one changes. */
      envRows: [string, string][] | null
      /** The environment group being added. */
      envDraft: { name: string; members: string }
      /** The config with the Config pane's unsaved changes; null when it has none. */
      configDraft: Record<string, any> | null
      runs: RunSummary[]
      archived: Result | null
      watchWindow: string
      /** Reviewers' pictures as data URLs, by login: an Svg can't load one from the web. */
      avatars: Record<string, string>
      /** Notifications are muted: a flag file the checker reads, so scheduled runs stay quiet too. */
      muted: boolean
      /** Scheduled runs: paused since when (null while on), the general cron line, the next run, and queries with their own. */
      scheduleState: { paused: string | null; schedule: string; next: string | null; own: { entry: string; schedule: string }[] } | null
      /** The picker showing a Custom input: '' for the general schedule, else a query's entry; null for none. */
      customFor: string | null
      /** The Custom input's text, for Save. */
      cronDraft: string
    }
  }
}
