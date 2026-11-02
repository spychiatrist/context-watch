// GPT's plan usage beside Claude's: the 5-hour and weekly meters of the Codex CLI on a ChatGPT
// plan, read from `codex app-server` (account/rateLimits/read, which spends nothing). The server
// quits as its input ends, before it answers, so a shell holds the input open until the answer
// comes and ends it then, or after WAIT seconds. No codex, signed out, or no answer: no reading.
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

// A reading: each meter's percentage used and when its window resets (ms), the plan's name.
export type Gpt = { five: number | null; week: number | null; fiveResets: number | null; weekResets: number | null; plan: string | null }

const WAIT = 8
// Read again at most this often.
export const EVERY = 5 * 60_000

// The requests, a JSON message a line. The version is the reader's own, not the mod's.
const ASK = [
  { method: 'initialize', id: 0, params: { clientInfo: { name: 'context-watch', title: 'context-watch', version: '1' } } },
  { method: 'initialized' },
  { method: 'account/rateLimits/read', id: 1 },
].map(m => JSON.stringify(m))

// $1 to $3 the requests, $4 the seconds to wait. The server writes into a FIFO; sed prints the
// answer to id 1 (a result or an error, its keys in either order) and quits, which ends the input,
// and with it the server. A watchdog ends a server that never answers. Nothing is left running.
const SCRIPT = `exec 2>/dev/null
command -v codex >/dev/null || exit 0
d=$(mktemp -d "\${TMPDIR:-/tmp}/context-watch.XXXXXX") || exit 1
trap 'rm -rf "$d"' EXIT
mkfifo "$d/out" || exit 1
exec 3>&1
{ printf '%s\\n' "$1" "$2" "$3"; sed -n '/^{"method"/d; /"id":1[,}]/{p;q;}' "$d/out" >&3; } | codex app-server >"$d/out" 3>&- &
p=$!
( trap 'kill "$s"; exit' TERM; sleep "$4" & s=$!; wait "$s"; kill "$p" ) >/dev/null 3>&- &
w=$!
wait "$p"
kill "$w"
wait "$w"`

type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }

// The answer's line as a reading; null for an error (signed out) or no meter at all. A window of a
// day or less is the 5-hour one, a longer one the week; without durations, primary and secondary.
export function reading(line: string): Gpt | null {
  let r: { primary?: Window | null; secondary?: Window | null; planType?: unknown } | undefined
  try {
    r = JSON.parse(line)?.result?.rateLimits
  } catch {
    return null
  }
  if (!r) return null
  const both = [r.primary, r.secondary].filter((w): w is Window => !!w && typeof w.usedPercent === 'number')
  const short = (w: Window) => (typeof w.windowDurationMins === 'number' ? w.windowDurationMins <= 24 * 60 : w === r?.primary)
  const five = both.find(short)
  const week = both.find(w => !short(w))
  if (!five && !week) return null
  const pct = (w?: Window) => (w ? Math.round(w.usedPercent as number) : null)
  const at = (w?: Window) => (w && typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null)
  return { five: pct(five), week: pct(week), fiveResets: at(five), weekResets: at(week), plan: typeof r.planType === 'string' ? r.planType : null }
}

// One reading, or null; never throws.
export async function read($: Engine): Promise<Gpt | null> {
  try {
    const r = await $.process.run(['/bin/sh', '-c', SCRIPT, 'context-watch', ...ASK, String(WAIT)], { timeoutMs: (WAIT + 5) * 1000 })
    return r.exitCode === 0 ? reading(r.stdout.trim().split('\n')[0] ?? '') : null
  } catch {
    return null
  }
}

// "GPT 11%/2%": the 5 hours, then the week; a meter the plan lacks is "?".
export function words(g: Gpt) {
  const p = (n: number | null) => (n === null ? '?' : `${n}%`)
  return `GPT ${p(g.five)}/${p(g.week)}`
}

// The last reading and when it was taken (null: none came), and whether a read is out.
let last: { at: number; gpt: Gpt | null } | undefined
let out = false

export function forgetGpt() {
  last = undefined
  out = false
}

// The reading in hand, or null.
export const gptNow = () => last?.gpt ?? null

// A read is due: none yet, the last EVERY old, or a codex command ran since (stale()).
export const due = (t: number) => !out && (!last || t - last.at >= EVERY)

export function stale() {
  if (last) last = { ...last, at: -Infinity }
}

// Reads now; the reading before and after, or undefined when a read was out already.
export async function refresh($: Engine): Promise<{ before: Gpt | null; after: Gpt | null } | undefined> {
  if (out) return undefined
  out = true
  try {
    const before = gptNow()
    const gpt = await read($)
    last = { at: await $.clock.now(), gpt }
    return { before, after: gpt }
  } finally {
    out = false
  }
}
