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
}

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { shown: Shown | null; epoch: Epoch | null; limits: Limits | null; night: Night | null }
  }
}
