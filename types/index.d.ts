// What the clear's row shows: the last turn's words before it, and the file with the turns before.
export type Shown = { words: string; at: string; path: string }

// The suggested clear for the current context alone (`/context-watch epoch`), and the session
// it was set in: a clear or a compaction starts the next context on the setting again.
export type Epoch = { clearAt: number; session: string }

// A usage limit (`/context-watch limitweek`, `limit5h`): a percentage of the meter, until its
// window resets (an ISO time). Limits is keyed by the meter's kind, as seven_day. `night` marks
// the night's line standing in as the week's ceiling: derived, never stored.
export type Limit = { percent: number; until?: string; night?: boolean }
export type Limits = Record<string, Limit>

// A night (`/context-watch night`, the night tool): the session runs on to a line on the week
// meter. Times are ISO; `wakeAt` is the resume armed, so a reload of the mod finds it.
export type Night = {
  line: number // the week meter's percentage it runs to
  until: string | null // its stop time
  weekResets: string | null // the week window's reset when it was set: the night ends there
  words: string // the user's words that set it, with their time
  next: string // what each carry-on asks for
  set: string // when it was set
  resumes: string[] // when it resumed the session, within the last hour
  paused: string | null // why it waits for the next prompt; null, it runs
  wakeAt: string | null // the resume armed
  errors?: Errors | null // the main loop's turns in a row that ended on an error; absent before 0.8.1
}

// The main loop's turns in a row that ended on an API error while a night ran: when the first ended
// (ISO), and how many. `held`: a carry-on's turn is among them, so a resume has failed in the run (the
// window's, kept until a turn ends well). `whole`: a carry-on's turn among them failed in this
// conversation, so the whole carry-on is in it (a new context starts it over). `kind`: the last
// turn's own error as the engine words it (StopFailure's: overloaded, billing_error,
// oauth_org_not_allowed ...), null until it is said.
export type Errors = { since: string; turns: number; held: boolean; whole: boolean; kind: string | null }

// A background job of the session's: a Bash command run in the background (or sent there), a
// Monitor, or a Bash shell found running from before the context that no log saw start. Its shell
// leads a process group of its own: `pid` names the group, and `start` with it the shell itself,
// as a pid is reused. Times are milliseconds.
export type Job = {
  id: string // j1, j2, ...: how the door and the jobs tool name it
  task: string | null // the engine's task id, for TaskStop
  tool: string // Bash, Monitor, or found
  command: string
  what: string // its description
  pid: number | null
  start: number | null
  context: number // the context it started in
  carried: { to: number; why: string } | null // carried on into context `to`, and why
  ended: number | null // when it was stopped or seen gone
}

// The jobs, and the context they are counted against: each clear and compaction starts the next,
// at `since`.
export type Jobs = { context: number; since: number; next: number; list: Job[] }

// The jobs, the night and the limits are the window's, in its file (hooks/window.ts): a /clear
// starts $.state over. $.state holds them only where the host runs no commands.
declare module 'claude-code' {
  interface PluginState {
    'context-watch': { shown: Shown | null; epoch: Epoch | null; limits: Limits | null; night: Night | null; jobs: Jobs | null }
  }
}
