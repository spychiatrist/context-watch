// The Mac's processes as ps lists them, and the session's own claude among them: what the door
// (jobs.ts) and the Mac's line (stats.ts) read. macOS commands; the C locale, so the dates parse.
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

// One process: its ids, its share of a CPU (100 is one core), its resident memory in KB, when it
// started (ms, to the second), the executable's name, and its command line.
export type Proc = { pid: number; ppid: number; pgid: number; cpu: number; rss: number; start: number; name: string; command: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// pid ppid pgid %cpu rss, lstart ("Mon Nov  2 12:15:32 2026", local time), then the command.
const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s+(.*)$/

// The executable's name: an app's from inside its bundle (such names hold spaces), else the last
// part of the command's first word.
export function nameOf(command: string) {
  const app = command.match(/\.app\/Contents\/MacOS\/(.+?)(?= -|$)/)
  return app?.[1]?.trim() || (command.split(' ')[0] ?? '').split('/').pop() || command
}

export function parse(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split('\n')) {
    const m = line.match(LINE)
    if (!m) continue
    const n = (i: number) => Number(m[i])
    const command = m[12] ?? ''
    const start = new Date(n(11), MONTHS.indexOf(m[6] ?? ''), n(7), n(8), n(9), n(10)).getTime()
    out.push({ pid: n(1), ppid: n(2), pgid: n(3), cpu: n(4), rss: n(5), start, name: nameOf(command), command })
  }
  return out
}

// Every process now; throws when ps can't be run.
export async function table($: Engine): Promise<Proc[]> {
  const r = await $.process.run(['/bin/ps', '-A', '-ww', '-o', 'pid=,ppid=,pgid=,pcpu=,rss=,lstart=,command='], { env: { LC_ALL: 'C' } })
  if (r.exitCode !== 0) throw new Error(`ps failed: ${r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`}`)
  return parse(r.stdout)
}

// The session's claude, the parent of a shell the mod starts; null where the host runs no commands
// (the CLI alone does), which turns the door off. Asked once a load.
let me: number | null | undefined

export function forget() {
  me = undefined
}

export async function claude($: Engine): Promise<number | null> {
  if (me !== undefined) return me
  try {
    const r = await $.process.run(['/bin/sh', '-c', 'echo $PPID'])
    const pid = Number(r.stdout.trim())
    me = r.exitCode === 0 && pid > 1 ? pid : null
  } catch {
    me = null
  }
  return me
}

// A process and everything under it.
export function tree(procs: readonly Proc[], root: number): Proc[] {
  const out = procs.filter(p => p.pid === root)
  for (let i = 0; i < out.length; i++) {
    const pid = out[i]?.pid
    for (const p of procs) if (p.ppid === pid && p.pid !== pid) out.push(p)
  }
  return out
}

// KB as MB or GB.
export const size = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`)

// A span as 38h 5m, 12m or 40s.
export function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`
}
