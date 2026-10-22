// What the clear's row shows: the last turn's words before it, and the file with the turns before.
export type Shown = { words: string; at: string; path: string }

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { shown: Shown | null }
  }
}
