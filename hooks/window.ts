// What a window keeps through its clears: the door's jobs, the night and the limits.
// $.state is the session's, and a /clear goes on in the same process under a new session id, so
// there $.state starts over (the door's live check: a carried job's why was gone after the
// clear, and the night's line after an earlier one). A window is a claude process: its record is a
// file of its own in the data folder, named by claude's pid, holding claude's start against a pid
// reused; no other window writes it. Where the host runs no commands there is no pid to name it
// by, and $.state keeps the three for the session, as before.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Jobs, Limits, Night } from '../types'
import { claude, table } from './procs'

type Engine = EngineInterface
export type Kept = { jobs: Jobs | null; night: Night | null; limits: Limits | null }
type Name = keyof Kept
type Held = Kept & { pid: number; start: number }

const jobsState = atom({ plugin: 'context-watch', key: 'jobs' } as const, null)
const nightState = atom({ plugin: 'context-watch', key: 'night' } as const, null)
const limitsState = atom({ plugin: 'context-watch', key: 'limits' } as const, null)

const FOLDER = 'context-watch-windows'
const FILE = /^(\d+)\.json$/
// ps's start times are whole seconds.
const sameStart = (a: number, b: number) => Math.abs(a - b) <= 2000

// The data folder's setting; this window's record, read once a load; the writes in flight.
let dataDir = '~/.claude'
let loading: Promise<{ path: string; record: Held } | null> | undefined
let writing: Promise<unknown> = Promise.resolve()

export function forgetWindow(dir: string) {
  dataDir = dir
  loading = undefined
}

// A folder setting, a leading ~ expanded; undefined where it needs a home and there is none.
export async function folder($: Engine, dir: string) {
  if (dir !== '~' && !dir.startsWith('~/')) return dir
  const home = await $.env.get('HOME')
  return home ? `${home}${dir.slice(1)}` : undefined
}

function parsed(text: string): Partial<Held> | undefined {
  try {
    const r = JSON.parse(text) as Partial<Held> | null
    return r && typeof r === 'object' && typeof r.pid === 'number' && typeof r.start === 'number' ? r : undefined
  } catch {
    return undefined
  }
}

async function readFile($: Engine, path: string) {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

// This window's file and record: the file's when claude's start matches it (none, or a torn one,
// starts empty). Null where the host runs no commands. Where ps fails the file is trusted by its
// pid, and its start is 0, unknown: a prune keeps it while the pid lives.
function mine($: Engine): Promise<{ path: string; record: Held } | null> {
  loading ??= (async () => {
    const pid = await claude($)
    const dir = pid === null ? undefined : await folder($, dataDir)
    if (pid === null || !dir) return null
    let start: number | undefined
    try {
      start = (await table($)).find(p => p.pid === pid)?.start
    } catch {
      start = undefined
    }
    await writing
    const path = `${dir}/${FOLDER}/${pid}.json`
    const was = parsed(await readFile($, path))
    const ours = was?.pid === pid && (start === undefined || sameStart(was.start ?? 0, start))
    const record: Held = {
      pid,
      start: start ?? was?.start ?? 0,
      jobs: (ours && was?.jobs) || null,
      night: (ours && was?.night) || null,
      limits: (ours && was?.limits) || null,
    }
    return { path, record }
  })()
  return loading
}

// What the window keeps under `name`.
export async function kept<N extends Name>($: Engine, name: N): Promise<Kept[N]> {
  const w = await mine($)
  if (w) return w.record[name]
  const v = name === 'jobs' ? await read($, jobsState) : name === 'night' ? await read($, nightState) : await read($, limitsState)
  return (v ?? null) as Kept[N]
}

// Changes what the window keeps under `name`; the file is written whole, in order.
export async function keep<N extends Name>($: Engine, name: N, fn: (was: Kept[N]) => Kept[N]): Promise<void> {
  const w = await mine($)
  if (!w) {
    const f = fn as (was: unknown) => never
    if (name === 'jobs') await update($, jobsState, f)
    else if (name === 'night') await update($, nightState, f)
    else await update($, limitsState, f)
    return
  }
  const record: Kept = w.record
  record[name] = fn(record[name])
  const text = JSON.stringify(w.record)
  const run = writing.then(() => $.fs.write(w.path, text))
  writing = run.catch(() => undefined)
  await run
}

// A session's start: the records of windows gone (no process has the pid, or another took it).
export async function pruneWindows($: Engine) {
  const dir = (await claude($)) === null ? undefined : await folder($, dataDir)
  if (!dir) return
  try {
    const procs = await table($)
    for (const f of await $.fs.list(`${dir}/${FOLDER}`)) {
      const pid = Number(FILE.exec(f.name)?.[1] ?? NaN)
      if (Number.isNaN(pid)) continue
      const path = `${dir}/${FOLDER}/${f.name}`
      const p = procs.find(x => x.pid === pid)
      const was = p && parsed(await readFile($, path))
      if (p && was && (was.start === 0 || sameStart(was.start ?? 0, p.start))) continue
      await $.process.run(['/bin/rm', '-f', '--', path])
    }
  } catch {
    // no folder yet, or no table: the next start prunes
  }
}
