// For the tests: the host where the kit's own mocks differ from it. $.state is the session's, and
// a /clear goes on in the same process under a new session id, so $.state starts over there; the
// kit's keeps it (a live check found the difference). A world built on this answers
// session.id and $.state, and its clear calls `clear()`.
import type { On } from 'claude-code'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// A time as ps's lstart writes it: local time, the C locale.
export function lstart(ms: number) {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`
  )
}

// What a command answers.
export const ran = (stdout: string, exitCode = 0) =>
  ({ value: { exitCode, stdout, stderr: exitCode ? 'failed' : '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

// The session's claude, where a world has no Mac of its own: the parent of the shell the mod
// starts, and its row in ps. The window's record is named by it (window.ts).
export function claudeAt(on: On, pid: number, start: number) {
  on('process.run', async (_, e) => {
    const [cmd] = e.argv
    if (cmd === '/bin/sh') return ran(`${pid}\n`)
    if (cmd === '/bin/ps') return ran(`${pid} 1304 ${pid} 4.0 900000 ${lstart(start)}     claude\n`)
    return ran('', 1)
  })
}

type Held = { value: unknown; version: number }
type Ref = { plugin: string; key: string; id?: string }

export function sessions(on: On) {
  let n = 1
  const held = new Map<string, Held>()
  const slot = (e: Ref) => `s-${n} ${e.plugin} ${e.key} ${e.id ?? ''}`
  on('session.id', async () => ({ value: `s-${n}` }))
  on('state.get', async (_, e) => ({ value: held.get(slot(e as Ref)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', async (_, e) => {
    const w = e as Ref & { value: unknown; ifVersion?: number }
    const was = held.get(slot(w)) ?? { value: undefined, version: 0 }
    if (w.ifVersion !== undefined && w.ifVersion !== was.version) return { value: { isSet: false, version: was.version } } as never
    held.set(slot(w), { value: JSON.parse(JSON.stringify(w.value)), version: was.version + 1 })
    return { value: { isSet: true, version: was.version + 1 } } as never
  })
  return {
    id: () => `s-${n}`,
    // A /clear: the next session.
    clear: () => {
      n += 1
    },
  }
}
