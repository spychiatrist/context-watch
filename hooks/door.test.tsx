// The door at each new context: a background job is logged as it starts, and a clear
// or a compaction cannot pass while one runs that is neither carried on (named in the next brief,
// with why) nor stopped. The Mac's load rides with the door and each context mark.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { lstart, ran, sessions } from './host'

// The test environment has timers; the API's types do not declare them.
declare function setTimeout(fn: () => void, ms: number): unknown
const tick = () => new Promise<void>(r => setTimeout(r, 2))

const ME = 4351 // the session's claude
const JAN = Date.parse('2026-01-01T12:00:00Z')

type Row = { pid: number; ppid: number; pgid: number; cpu: number; rss: number; start: number; command: string }

// The shell the Bash tool runs a command in, as ps writes it: a child of claude, leading a process
// group of its own, the command quoted as zsh's eval gets it.
const shell = (pid: number, start: number, cmd: string): Row => ({
  pid,
  ppid: ME,
  pgid: pid,
  cpu: 0.5,
  rss: 2048,
  start,
  command:
    '/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1-x.sh 2>/dev/null || true && ' +
    `eval '${cmd.replace(/'/g, `'"'"'`).replace(/\n/g, '\\012')}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`,
})

// The Mac: the window server, its window manager, the session's claude and two of its helpers.
const mac = (): Row[] => [
  { pid: 476, ppid: 1, pgid: 476, cpu: 30.2, rss: 1_400_000, start: JAN - 86_400_000, command: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon' },
  { pid: 1936, ppid: 1, pgid: 1936, cpu: 0.4, rss: 35_000, start: JAN - 3_600_000, command: '/System/Library/CoreServices/WindowManager.app/Contents/MacOS/WindowManager' },
  { pid: ME, ppid: 1304, pgid: ME, cpu: 4, rss: 900_000, start: JAN - 7_200_000, command: 'claude' },
  { pid: 9882, ppid: ME, pgid: ME, cpu: 0, rss: 1000, start: JAN - 60_000, command: 'caffeinate -i -t 300' },
  { pid: 61052, ppid: ME, pgid: ME, cpu: 0.1, rss: 5_700_000, start: JAN - 86_400_000, command: '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd --background-index' },
]

type World = { rows: Row[]; kills: string[]; sent: string[]; writes: Record<string, string>; clock: MockClock; tokens: { n: number }; broken: boolean }

// The world beneath the mod: the Mac's commands (ps over `rows`, kill, sysctl, ioreg), a
// conversation, a clear that clears (and starts $.state over, as the host's does), a prompt that's
// taken, and a Bash tool whose background command starts a shell in `rows` and answers with its
// task at once.
function world(on: On, rows: Row[] = mac()): World {
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  const clock = mock.clock(on, { now: JAN })
  const w: World = { rows, kills: [], sent: [], writes: {}, clock, tokens: { n: 50_000 }, broken: false }
  on('process.run', async (_, e) => {
    const [cmd] = e.argv
    if (cmd === '/bin/sh') return ran(`${ME}\n`)
    if (cmd === '/bin/ps' && w.broken) return ran('', 1)
    if (cmd === '/bin/ps')
      return ran(w.rows.map(r => `${r.pid} ${r.ppid} ${r.pgid} ${r.cpu.toFixed(1)} ${r.rss} ${lstart(r.start)}     ${r.command}`).join('\n') + '\n')
    if (cmd === '/bin/kill') {
      w.kills.push(e.argv.join(' '))
      const group = Number(e.argv[e.argv.length - 1]?.slice(1))
      w.rows = w.rows.filter(r => r.pgid !== group)
      return ran('')
    }
    if (cmd === '/bin/rm') return (delete w.writes[e.argv[e.argv.length - 1] ?? ''], ran(''))
    if (cmd === '/usr/sbin/sysctl') return ran('{ 2.50 2.40 2.30 }\ntotal = 3072.00M  used = 1024.00M  free = 2048.00M  (encrypted)\n1\n92\n18\n')
    if (cmd === '/usr/sbin/ioreg') return ran('"PerformanceStatistics" = {"Device Utilization %"=7,"Renderer Utilization %"=7}\n')
    return ran('', 1)
  })
  on('session.cwd', async () => ({ value: '/home/u/src/p' }))
  const host = sessions(on)
  on('session.usage', async () => ({ value: { context: { tokens: w.tokens.n, window: 1_000_000 }, rateLimits: [] } }) as never)
  on('session.messages', async () => ({ value: [] }) as never)
  on('fs.read', async (_, e) => ({ value: w.writes[e.path] ?? '' }))
  on('fs.write', async (_, e) => ((w.writes[e.path] = e.text), { value: undefined }))
  on('fs.list', async (_, e) => {
    const dir = `${e.path ?? ''}/`
    const names = Object.keys(w.writes).filter(p => p.startsWith(dir)).map(p => p.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('command.run', { command: 'clear' }, async () => (host.clear(), { text: '' }))
  on('prompt.submit', async (_, e) => (w.sent.push([e.text, ...(e.context ?? [])].join('\n')), { text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.status', async () => ({ value: undefined }) as never)
  let pid = 20_000
  let task = 0
  on('tool.call', async (_, e) => {
    const input = e as unknown as { command?: string; run_in_background?: boolean }
    if (e.tool === 'Bash' && input.run_in_background) {
      w.rows.push(shell(++pid, clock.now(), input.command ?? ''))
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++task}` } } as never
    }
    return { result: 'ok' } as never
  })
  return w
}

type Answer = { deny?: string; result?: unknown; context?: readonly string[] }
const call = async ($: Engine, input: Record<string, unknown>) => (await $.tool.call(input as never)) as Answer
const words = (a: Answer) => `${a.deny ?? ''}${typeof a.result === 'string' ? a.result : ''}${(a.context ?? []).join('\n')}`
const SERVER = 'python3 -m http.server 8765'

// The user's /clear, a minute on.
async function userClear($: Engine, w: World) {
  await w.clock.advance(60_000)
  await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } } as never)
}

// The mod's clear: queued by the tool, run as the turn ends; resolves with the brief sent.
async function restart($: Engine, w: World, input: Record<string, unknown>) {
  const asked = await call($, { tool: 'mcp__context-watch__clear_and_restart', ...input })
  if (asked.deny) return { asked, brief: '' }
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await w.clock.advance(1000)
  for (let i = 0; i < 100 && !w.sent.length; i++) await tick()
  return { asked, brief: w.sent[0] ?? '' }
}

test('a background job is logged as it starts, with its task and its shell', async ($, on) => {
  const w = world(on)
  const started = await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  expect(words(started)).toContain('j1')

  const list = words(await call($, { tool: 'mcp__context-watch__jobs' }))
  expect(list).toContain('j1')
  expect(list).toContain(SERVER)
  expect(list).toContain('b1')
  expect(list).toContain('pid 20001')
  expect(w.writes['/home/u/.claude/context-watch.log']).toContain(`j1 started (Bash b1, pid 20001): ${SERVER}`)
})

test('clear_and_restart waits while a job runs, naming it and the two ways out', async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  const { asked } = await restart($, w, { brief: 'carry on' })

  expect(asked.deny).toContain('j1')
  expect(asked.deny).toContain(SERVER)
  expect(asked.deny).toContain('stop')
  expect(asked.deny).toContain('carry')
  expect(asked.deny).toContain('TaskStop b1')
  expect(w.sent).toEqual([])
})

test('a stopped job lets the clear through: its whole process group is ended', async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  const stopped = words(await call($, { tool: 'mcp__context-watch__jobs', stop: ['j1'] }))
  expect(w.kills).toEqual(['/bin/kill -s TERM -- -20001'])
  expect(stopped).toContain('j1')

  const { asked, brief } = await restart($, w, { brief: 'carry on' })
  expect(asked.deny).toBeUndefined()
  expect(brief).toContain('carry on')
  expect(brief).not.toContain(SERVER)
})

test('a job carried on through clear_and_restart is named in the brief, with why', async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  const { asked, brief } = await restart($, w, { brief: 'carry on', carry: [{ job: 'j1', why: 'the phone check of the menu' }] })

  expect(asked.deny).toBeUndefined()
  expect(brief).toContain('Still running')
  expect(brief).toContain(SERVER)
  expect(brief).toContain('the phone check of the menu')
  expect(w.kills).toEqual([])
  // Carried into this context, it lets the work through; the next clear asks again.
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect((await call($, { tool: 'mcp__context-watch__clear_and_restart', brief: 'again' })).deny).toContain('j1')
})

test("after the user's /clear the next context's tool calls wait until each job is carried or stopped", async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  await call($, { tool: 'Bash', command: 'sleep 600', run_in_background: true })
  await userClear($, w)

  const shut = await call($, { tool: 'Bash', command: 'ls' })
  expect(shut.deny).toContain('j1')
  expect(shut.deny).toContain('j2')
  expect(shut.deny).toContain('load 2.5')
  // The way out stays open: the jobs tool, TaskStop, ToolSearch and Read.
  expect((await call($, { tool: 'ToolSearch', query: 'select:mcp__context-watch__jobs' })).deny).toBeUndefined()

  await call($, { tool: 'mcp__context-watch__jobs', carry: [{ job: 'j1', why: 'the phone check' }] })
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toContain('j2')
  await call($, { tool: 'mcp__context-watch__jobs', stop: ['j2'] })
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test("the user's /clear names what still runs at the first prompt after it, the carried with why", async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  await call($, { tool: 'mcp__context-watch__jobs', carry: [{ job: 'j1', why: 'the phone check' }] })
  await userClear($, w)
  await $.prompt.submit({ text: 'what now?', origin: { kind: 'composer' } } as never)

  expect(w.sent[0]).toContain(SERVER)
  expect(w.sent[0]).toContain('the phone check')
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test('a shell running from before the clear that no log saw start is found and held too', async ($, on) => {
  const rows = [...mac(), shell(21863, JAN - 38 * 3_600_000, "./build/tools/viewer/viewer --replay '/tmp/blade/sheath.code'")]
  const w = world(on, rows)
  await userClear($, w)

  const shut = await call($, { tool: 'Bash', command: 'ls' })
  expect(shut.deny).toContain("viewer --replay '/tmp/blade/sheath.code'")
  expect(shut.deny).toContain('pid 21863')
  await call($, { tool: 'mcp__context-watch__jobs', stop: [String(21863)] })
  expect(w.kills).toEqual(['/bin/kill -s TERM -- -21863'])
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test("a job that ended by itself holds nothing, and claude's own helpers never count", async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: 'sleep 5', run_in_background: true })
  w.rows = w.rows.filter(r => r.pid !== 20001)
  await userClear($, w)
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test("a subagent's tool calls pass the door; the main loop's wait", async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  await userClear($, w)
  expect((await call($, { tool: 'Bash', command: 'ls', agentId: 'a-1' })).deny).toBeUndefined()
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toContain('j1')
})

test('compact_and_continue waits too, and a carried job rides in the summary and the resume', async ($, on) => {
  const w = world(on)
  let keep = ''
  on('session.compact', async (_, e) => {
    keep = e.instructions ?? ''
    return { messages: [{ role: 'user', text: 'the summary', toolUses: [] }], tokensBefore: 214_000, tokensAfter: 30_000 } as never
  })
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  expect((await call($, { tool: 'mcp__context-watch__compact_and_continue', keep: 'the plan', next: 'step two' })).deny).toContain('j1')

  const asked = await call($, {
    tool: 'mcp__context-watch__compact_and_continue',
    keep: 'the plan',
    next: 'step two',
    carry: [{ job: 'j1', why: 'the phone check' }],
  })
  expect(asked.deny).toBeUndefined()
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await w.clock.advance(1000)
  for (let i = 0; i < 100 && !w.sent.length; i++) await tick()
  expect(keep).toContain('the phone check')
  expect(w.sent[0]).toContain(SERVER)
})

test("the door stays shut when it can't read what runs", async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  await userClear($, w)
  w.broken = true
  const shut = await call($, { tool: 'Bash', command: 'ls' })
  expect(shut.deny).toContain('could not')
})

test('the door off lets everything through', { options: { door: false } }, async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: SERVER, run_in_background: true })
  await userClear($, w)
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect((await restart($, w, { brief: 'carry on' })).asked.deny).toBeUndefined()
})

test("the Mac's load shows at a context mark: memory, swap, GPU, the window server, the session's share", async ($, on) => {
  const w = world(on)
  await call($, { tool: 'Bash', command: 'ls' }) // the first reading is taken silently
  w.tokens.n = 120_000
  const mark = words(await call($, { tool: 'Bash', command: 'ls' }))

  expect(mark).toContain('context passed 100k')
  expect(mark).toContain('load 2.5 on 18 cores')
  expect(mark).toContain('memory 92% free')
  expect(mark).toContain('swap 1.0 of 3.0 GB')
  expect(mark).toContain('GPU 7%')
  expect(mark).toContain('WindowServer 30% CPU, 1.3 GB')
  expect(mark).toContain('WindowManager 0% CPU, 34 MB')
  expect(mark).toContain('clangd 5.4 GB')
})

test('a window manager grown huge is flagged', async ($, on) => {
  const rows = mac().map(r => (r.pid === 1936 ? { ...r, rss: 10_700_000 } : r))
  const w = world(on, rows)
  await call($, { tool: 'Bash', command: 'ls' })
  w.tokens.n = 120_000
  expect(words(await call($, { tool: 'Bash', command: 'ls' }))).toContain('WindowManager at 10.2 GB')
})

// The window's record (window.ts): a file of its own, named by claude's pid.
const WINDOWS = '/home/u/.claude/context-watch-windows'
const record = (pid: number, start: number, jobs: unknown = null) => JSON.stringify({ pid, start, jobs, night: null, limits: null })

test("a session's start removes the records of windows gone, and keeps its own", async ($, on) => {
  const w = world(on)
  w.writes[`${WINDOWS}/${ME}.json`] = record(ME, JAN - 7_200_000) // this window's: kept
  w.writes[`${WINDOWS}/5555.json`] = record(5555, JAN - 60_000) // its claude gone
  w.writes[`${WINDOWS}/61052.json`] = record(61052, JAN) // its pid another process's now
  on('session.start', async (_, e) => e as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/home/u/src/p' } as never)
  expect(Object.keys(w.writes).filter(p => p.startsWith(WINDOWS))).toEqual([`${WINDOWS}/${ME}.json`])
})

test('a record left by a claude whose pid this one took is not read as its own', async ($, on) => {
  const w = world(on)
  const old = { context: 3, since: JAN - 90_000_000, next: 8, list: [] }
  w.writes[`${WINDOWS}/${ME}.json`] = record(ME, JAN - 90_000_000, old)
  expect(words(await call($, { tool: 'Bash', command: SERVER, run_in_background: true }))).toContain('Logged as j1 ')
  expect(JSON.parse(w.writes[`${WINDOWS}/${ME}.json`] ?? '{}').start).toBe(JAN - 7_200_000)
})
