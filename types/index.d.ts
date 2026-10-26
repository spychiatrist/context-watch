// What the clear's row shows: the last turn's words before it, and the file with the turns before.
export type Shown = { words: string; at: string; path: string }

// The suggested clear for the current context alone (`/context-watch epoch`), and the session
// it was set in: a clear or a compaction starts the next context on the setting again.
export type Epoch = { clearAt: number; session: string }

// A usage limit (`/context-watch limitweek`, `limit5h`): a percentage of the meter, until its
// window resets (an ISO time). Limits is keyed by the meter's kind, as seven_day.
export type Limit = { percent: number; until?: string }
export type Limits = Record<string, Limit>

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { shown: Shown | null; epoch: Epoch | null; limits: Limits | null }
  }
}
