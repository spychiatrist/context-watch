// The door at each new context. What the session starts in the background (a Bash
// command run in the background or sent there, a Monitor) is logged as it starts, and a clear or
// a compaction the model asks for can't pass while one still runs that is neither carried on
// (named in the next context, with why) nor stopped. After one the model didn't ask for (the
// user's /clear, the engine's own compaction), the next context's tool calls wait the same way.
// A Bash shell running from before the context that no log saw start (begun before this mod, or
// in a lost reload) is found in the process table and held too. Claude's own helpers (caffeinate,
// the language servers) are no shell of the Bash tool's, so they never count.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Job, Jobs } from '../types'
import { claude, size, span, table } from './procs'
import type { Proc } from './procs'
import { macLine } from './stats'

type Engine = EngineInterface
type Log = (line: string) => Promise<void>

export const JOBS_TOOL = 'mcp__context-watch__jobs'
const LOAD = `ToolSearch "select:${JOBS_TOOL}"`
const DAY = 24 * 3_600_000

export const jobs = atom({ plugin: 'context-watch', key: 'jobs' } as const, null)
const EMPTY: Jobs = { context: 0, since: 0, next: 1, list: [] }

// One change at a time: parallel tool calls each read the jobs and write them back.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

// The context the door last found open, and the jobs it last held for: both start over on a reload.
let openIn = -1
let heldFor = ''

export function forgetDoor() {
  openIn = -1
  heldFor = ''
}

// A shell of the Bash tool's (a Monitor's too): a child of claude leading a process group of its
// own, started from the shell snapshot.
const isShell = (p: Proc, me: number) => p.ppid === me && p.pgid === p.pid && p.command.includes('/shell-snapshots/snapshot-')

// The command a shell runs, as the model wrote it: zsh's eval argument, unquoted (ps writes a
// newline as \012).
export function commandOf(line: string) {
  const at = line.indexOf(" eval '")
  if (at < 0) return line
  const body = line.slice(at + 7)
  const end = body.lastIndexOf("' < /dev/null")
  return (end >= 0 ? body.slice(0, end) : body).replace(/'"'"'/g, "'").replace(/'\\''/g, "'").replace(/\\012/g, '\n')
}

// The job's processes now: its shell's process group, while the shell is the one it started with
// (a pid is reused). ps's start times are whole seconds.
function members(j: Job, procs: readonly Proc[]) {
  if (j.pid === null) return []
  const lead = procs.find(p => p.pid === j.pid)
  if (lead && j.start !== null && Math.abs(lead.start - j.start) > 2000) return []
  return procs.filter(p => p.pgid === j.pid && (j.start === null || p.start >= j.start - 2000))
}

function oneLine(s: string) {
  const t = s.trim().replace(/\s*\n\s*/g, ' ⏎ ')
  return t.length > 140 ? `${t.slice(0, 139)}…` : t
}

// A job in a line: its name, command, how it started, its shell, its age and what it costs now.
function describe(j: Job, procs: readonly Proc[], now: number) {
  const ps = members(j, procs)
  const cpu = Math.round(ps.reduce((s, p) => s + p.cpu, 0))
  const how = j.tool === 'found' ? 'found running, never logged' : `${j.tool}${j.task ? ` ${j.task}` : ''}`
  const age = j.start !== null ? `, ${span(now - j.start)}` : ''
  return `${j.id} \`${oneLine(j.command)}\` (${how}, pid ${j.pid ?? '?'}${age}, ${cpu}% CPU, ${size(ps.reduce((s, p) => s + p.rss, 0))})`
}

// A job by its name, its task id or its shell's pid.
const find = (list: readonly Job[], ref: string) => list.find(j => j.id === ref || j.task === ref || String(j.pid) === ref)

// Ended jobs are kept a day, for the list and the log's sake.
const prune = (list: Job[], now: number) => list.filter(j => j.ended === null || now - j.ended < DAY)

type Seen = { state: Jobs; procs: Proc[]; me: number; now: number; live: Job[] }

// The jobs against the process table now: those gone marked ended, and shells started before
// `before` that no job names taken in as found. Undefined where the host runs no commands (the
// door is off there); throws when the table can't be read.
async function look($: Engine, before: number, log: Log): Promise<Seen | undefined> {
  const me = await claude($)
  if (me === null) return undefined
  const procs = await table($)
  const now = await $.clock.now()
  const was = (await read($, jobs)) ?? EMPTY
  const lines: string[] = []
  let next = was.next
  const list = was.list.map(j => {
    if (j.ended !== null || members(j, procs).length) return j
    lines.push(`${j.id} ended`)
    return { ...j, ended: now }
  })
  for (const p of procs) {
    if (!isShell(p, me) || p.start >= before) continue
    if (list.some(j => j.pid === p.pid && (j.start === null || Math.abs(j.start - p.start) <= 2000))) continue
    const command = commandOf(p.command)
    list.push({ id: `j${next++}`, task: null, tool: 'found', command, what: '', pid: p.pid, start: p.start, context: was.context - 1, carried: null, ended: null })
    lines.push(`j${next - 1} found running from before this context (pid ${p.pid}): ${oneLine(command)}`)
  }
  const state: Jobs = { ...was, next, list: prune(list, now) }
  if (lines.length) await update($, jobs, () => state)
  for (const line of lines) await log(line)
  return { state, procs, me, now, live: state.list.filter(j => j.ended === null) }
}

// What a door holds for: a live job not carried into context `to`; for the door inside that
// context, only those started before it.
const owing = (live: readonly Job[], to: number, inside: boolean) =>
  live.filter(j => (!inside || j.context < to) && (j.carried?.to ?? -1) < to)

// The two ways out, for the jobs held.
function ways(held: readonly Job[], inCall: boolean) {
  const tasks = held.filter(j => j.task).map(j => `TaskStop ${j.task}`)
  const example = `[{"job": "${held[0]?.id ?? 'j1'}", "why": "what it is for, and when it stops"}]`
  return (
    `Stop: ${JOBS_TOOL} {"stop": [${held.map(j => `"${j.id}"`).join(', ')}]}${tasks.length ? ` (or ${tasks.join(', ')})` : ''}. ` +
    (inCall
      ? `Carry on: this call's carry ${example}; the next context reads it, with why. `
      : `Carry on: ${JOBS_TOOL} {"carry": ${example}}; the next context reads it too, with why. `) +
    `Load the jobs tool first with ${LOAD}.`
  )
}

const jobsWord = (n: number) => (n === 1 ? 'a job' : `${n} jobs`)
const could = (err: unknown) => `could not read what runs (${String(err).slice(0, 200)})`

async function held($: Engine, seen: Seen, ids: readonly Job[], log: Log) {
  const key = `${seen.state.context}:${ids.map(j => j.id).join(',')}`
  if (key !== heldFor) await log(`the door held for ${ids.map(j => j.id).join(', ')}`)
  heldFor = key
}

// The door inside a context: the words that refuse a tool call while a job from before it runs
// uncarried, or undefined. Found open once, it stays open for the context.
export function door($: Engine, log: Log): Promise<string | undefined> {
  return serial(async () => {
    const was = (await read($, jobs)) ?? EMPTY
    if (openIn === was.context) return undefined
    let seen: Seen | undefined
    try {
      seen = await look($, was.since, log)
    } catch (err) {
      return `[context-watch] The door ${could(err)}, so no tool runs: try again. The user can turn the door off with /context-watch door off.`
    }
    const owed = seen ? owing(seen.live, seen.state.context, true) : []
    if (!seen || !owed.length) {
      openIn = was.context
      return undefined
    }
    await held($, seen, owed, log)
    return [
      `[context-watch] The door: ${jobsWord(owed.length)} started before this context still ${owed.length === 1 ? 'runs' : 'run'}, ` +
        'and no other tool runs until each is carried on or stopped:',
      ...owed.map(j => `- ${describe(j, seen.procs, seen.now)}`),
      ways(owed, false),
      await macLine($, seen.procs, seen.me),
    ]
      .filter(Boolean)
      .join('\n')
  })
}

type Carry = { job: string; why: string }

function carries(input: unknown): Carry[] | string {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) return 'carry takes a list of {"job", "why"}'
  const out: Carry[] = []
  for (const c of input as { job?: unknown; why?: unknown }[]) {
    const job = typeof c?.job === 'string' || typeof c?.job === 'number' ? String(c.job) : ''
    const why = typeof c?.why === 'string' ? c.why.trim() : ''
    if (!job || !why) return 'each carry names its job and says why it keeps running'
    out.push({ job, why })
  }
  return out
}

function refs(input: unknown): string[] {
  if (input === undefined || input === null) return []
  return (Array.isArray(input) ? input : [input]).map(String)
}

// Carries jobs on into the next context, and stops others; what came of each.
async function apply($: Engine, seen: Seen, carry: readonly Carry[], stop: readonly string[], log: Log): Promise<string[]> {
  const said: string[] = []
  let list = seen.state.list
  const set = (j: Job, change: Partial<Job>) => {
    list = list.map(x => (x.id === j.id ? { ...x, ...change } : x))
  }
  for (const c of carry) {
    const j = find(list, c.job)
    if (!j) said.push(`No job ${c.job}.`)
    else if (j.ended !== null) said.push(`${j.id} has ended.`)
    else {
      set(j, { carried: { to: seen.state.context + 1, why: c.why } })
      said.push(`${j.id} carried on: ${c.why}`)
      await log(`${j.id} carried on: ${c.why}`)
    }
  }
  for (const ref of stop) {
    const j = find(list, ref)
    if (!j) said.push(`No job ${ref}.`)
    else if (j.ended !== null || !members(j, seen.procs).length) {
      set(j, { ended: j.ended ?? seen.now })
      said.push(`${j.id} had ended.`)
    } else {
      const gone = await end($, j, seen.procs)
      set(j, { ended: seen.now })
      said.push(gone ? `${j.id} stopped.` : `${j.id} was sent SIGKILL and may linger.`)
      await log(`${j.id} stopped${gone ? '' : ' (SIGKILL, may linger)'}`)
    }
  }
  await update($, jobs, () => ({ ...seen.state, list }))
  seen.state = { ...seen.state, list }
  seen.live = list.filter(j => j.ended === null)
  return said
}

// Ends a job's whole process group: SIGTERM, then SIGKILL after 3 s; whether it's gone.
async function end($: Engine, j: Job, procs: readonly Proc[]) {
  const group = ['--', `-${j.pid}`]
  await $.process.run(['/bin/kill', '-s', 'TERM', ...group])
  let now = await table($)
  for (let i = 0; i < 6 && members(j, now).length; i++) {
    await $.clock.sleep(500)
    now = await table($)
  }
  if (!members(j, now).length) return true
  await $.process.run(['/bin/kill', '-s', 'KILL', ...group])
  return !members(j, await table($)).length && procs.length > 0
}

// The door at a clear or a compaction the model asks for: carries `carry` on, then the words that
// refuse it while a job runs that is neither carried on nor stopped, or undefined. `before`: shells
// started since are a call's still running, not jobs.
export function clearDoor($: Engine, carry: unknown, what: 'clear' | 'compaction', before: number, log: Log): Promise<string | undefined> {
  const list = carries(carry)
  if (typeof list === 'string') return Promise.resolve(`context-watch: ${list}.`)
  return serial(async () => {
    let seen: Seen | undefined
    try {
      seen = await look($, before, log)
    } catch (err) {
      return `[context-watch] The ${what} waits: the door ${could(err)}. Try again; the user can turn the door off with /context-watch door off.`
    }
    if (!seen) return undefined
    const said = await apply($, seen, list, [], log)
    const owed = owing(seen.live, seen.state.context + 1, false)
    if (!owed.length) return undefined
    await held($, seen, owed, log)
    return [
      ...said,
      `[context-watch] The ${what} waits: ${jobsWord(owed.length)} still ${owed.length === 1 ? 'runs' : 'run'}. Stop each, or carry it on:`,
      ...owed.map(j => `- ${describe(j, seen.procs, seen.now)}`),
      ways(owed, true),
      await macLine($, seen.procs, seen.me),
    ]
      .filter(Boolean)
      .join('\n')
  })
}

// The jobs tool: carries on and stops what it names, then lists what runs, with the Mac's load.
export function jobsTool($: Engine, input: { carry?: unknown; stop?: unknown }, log: Log): Promise<{ result: string } | { deny: string }> {
  const carry = carries(input.carry)
  if (typeof carry === 'string') return Promise.resolve({ deny: `context-watch: ${carry}.` })
  return serial(async () => {
    const was = (await read($, jobs)) ?? EMPTY
    let seen: Seen | undefined
    try {
      seen = await look($, was.since, log)
    } catch (err) {
      return { deny: `context-watch: ${could(err)}.` }
    }
    if (!seen) return { result: 'context-watch: this host runs no commands for the mod, so it sees no jobs.' }
    const stop = refs(input.stop)
    const said = await apply($, seen, carry, stop, log)
    const procs = stop.length ? await table($) : seen.procs
    const n = seen.state.context
    return {
      result: [
        ...said,
        seen.live.length ? `Running (${seen.live.length}):` : 'No job of this session runs.',
        ...seen.live.map(j => `- ${describe(j, procs, seen.now)}${j.carried && j.carried.to >= n ? `: carried on, ${j.carried.why}` : ''}`),
        await macLine($, procs, seen.me),
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })
}

// A background job just started: logged with its shell, which the table finds among claude's
// shells started since the call (by its command where two did). The words for the model.
export async function started(
  $: Engine,
  tool: string,
  task: string,
  input: { command?: string; description?: string },
  since: number,
  log: Log,
): Promise<string | undefined> {
  const me = await claude($)
  if (me === null) return undefined
  let procs: Proc[] = []
  try {
    procs = await table($)
  } catch {
    procs = []
  }
  return serial(async () => {
    const was = (await read($, jobs)) ?? EMPTY
    const now = await $.clock.now()
    const taken = new Set(was.list.filter(j => j.ended === null).map(j => j.pid))
    const fresh = procs.filter(p => isShell(p, me) && p.start >= since - 2000 && !taken.has(p.pid)).sort((a, b) => a.start - b.start)
    const shell = fresh.find(p => commandOf(p.command) === (input.command ?? '')) ?? fresh[0]
    const job: Job = {
      id: `j${was.next}`,
      task,
      tool,
      command: input.command ?? '',
      what: input.description ?? '',
      pid: shell?.pid ?? null,
      start: shell?.start ?? null,
      context: was.context,
      carried: null,
      ended: null,
    }
    await update($, jobs, () => ({ ...was, next: was.next + 1, list: [...prune(was.list, now), job] }))
    await log(`${job.id} started (${tool} ${task}, pid ${job.pid ?? '?'}): ${oneLine(job.command)}`)
    return (
      `[context-watch] Logged as ${job.id} (pid ${job.pid ?? '?'}). Stop it once it has served (TaskStop ${task}); ` +
      'a clear waits until it is stopped or carried on.'
    )
  })
}

// What runs from before the context, for the first words the new one reads (the brief, the first
// prompt after the user's /clear, a compaction's summary): the carried with why, the rest held.
export function stillRunning($: Engine, what: 'clear' | 'compaction', log: Log): Promise<string> {
  return serial(async () => {
    const was = (await read($, jobs)) ?? EMPTY
    let seen: Seen | undefined
    try {
      seen = await look($, was.since, log)
    } catch {
      return ''
    }
    if (!seen || !seen.live.length) return ''
    const n = seen.state.context
    const lines = seen.live.map(
      j =>
        `- ${describe(j, seen.procs, seen.now)}: ` +
        (j.carried && j.carried.to >= n ? `carried on, ${j.carried.why}` : 'not carried: carry it on or stop it before other tools run'),
    )
    return [
      `Still running from before the ${what} (stop each once it has served; ${JOBS_TOOL} lists them):`,
      ...lines,
      await macLine($, seen.procs, seen.me),
    ]
      .filter(Boolean)
      .join('\n')
  })
}

// A clear or a compaction starts the next context.
export async function nextContext($: Engine) {
  const now = await $.clock.now()
  await serial(() => update($, jobs, j => ({ ...(j ?? EMPTY), context: (j ?? EMPTY).context + 1, since: now })))
}

// The Mac's line on its own, for a context mark.
export async function macNow($: Engine) {
  const me = await claude($)
  let procs: Proc[] = []
  try {
    procs = me === null ? [] : await table($)
  } catch {
    procs = []
  }
  return me === null ? '' : macLine($, procs, me)
}
