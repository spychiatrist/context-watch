// GPT's usage beside Claude's: the Codex CLI's meters, read from a fake `codex app-server` in the
// background at most every 5 minutes, follow Claude's in the status line, the notices and the log.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { reading, words } from './codex'
import { lstart, ran } from './host'

// The test environment has timers; the API's types do not declare them.
declare function setTimeout(fn: () => void, ms: number): unknown
const tick = () => new Promise<void>(r => setTimeout(r, 2))

const JAN = Date.parse('2026-01-01T12:00:00Z')
const MIN = 60_000
const ME = 4351 // the session's claude
const LOG = '/home/u/.claude/context-watch.log'

// The answers of `codex app-server` to account/rateLimits/read: a ChatGPT plan's two meters (made up).
const answer = (five: number, week: number) =>
  JSON.stringify({
    id: 1,
    result: {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: five, windowDurationMins: 300, resetsAt: (JAN + 3 * 3_600_000) / 1000 },
        secondary: { usedPercent: week, windowDurationMins: 10080, resetsAt: (JAN + 6 * 86_400_000) / 1000 },
        planType: 'plus',
      },
    },
  })
const SIGNED_OUT = '{"error":{"code":-32600,"message":"codex account authentication required to read rate limits"},"id":1}'

type Codex = 'absent' | 'signed out' | { five: number; week: number }

// The world: Claude's meters, a context that grows, a clock, the log, the status lines drawn, and
// codex as the test sets it: absent (the shell prints nothing), signed out, or its two meters.
function world(on: On) {
  const w = { codex: { five: 11, week: 2 } as Codex, tokens: 50_000, reads: 0, statuses: [] as string[], files: {} as Record<string, string>, clock: undefined as unknown as MockClock }
  w.clock = mock.clock(on, { now: JAN })
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  on('session.usage', async () => {
    const rateLimits = [
      { kind: 'five_hour', percentUsed: 6, resetsAt: '2026-01-01T13:10:00Z' },
      { kind: 'seven_day', percentUsed: 61, resetsAt: '2026-01-02T12:00:00Z' },
    ]
    return { value: { context: { tokens: w.tokens, window: 1_000_000 }, rateLimits } } as never
  })
  on('session.id', async () => ({ value: 's-1' }))
  on('session.cwd', async () => ({ value: '/home/u/src/p' }))
  on('fs.read', async (_, e) => ({ value: w.files[e.path] ?? '' }))
  on('fs.write', async (_, e) => ((w.files[e.path] = e.text), { value: undefined }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.status', async (_, e) => (w.statuses.push(e.text ?? ''), { value: undefined }) as never)
  on('process.run', async (_, e) => {
    const [cmd, , script] = e.argv
    if (cmd === '/bin/sh' && script?.includes('codex app-server')) {
      w.reads++
      if (w.codex === 'absent') return ran('')
      return ran(`${w.codex === 'signed out' ? SIGNED_OUT : answer(w.codex.five, w.codex.week)}\n`)
    }
    // The session's claude, alone on the Mac: the door finds nothing running.
    if (cmd === '/bin/sh') return ran(`${ME}\n`)
    if (cmd === '/bin/ps') return ran(`${ME} 1304 ${ME} 4.0 900000 ${lstart(JAN - 3_600_000)}     claude\n`)
    return ran('', 1)
  })
  return w
}

type World = ReturnType<typeof world>

// A tool call of the main loop, then the background read's turn to finish.
async function call($: Engine, command = 'ls') {
  const done = (await $.tool.call({ tool: 'Bash', command } as never)) as { context?: readonly string[] }
  for (let i = 0; i < 20; i++) await tick()
  return done.context?.join(' ') ?? ''
}

const lastStatus = (w: World) => w.statuses[w.statuses.length - 1] ?? ''
const gptLines = (w: World) => (w.files[LOG] ?? '').split('\n').filter(l => /\s{2}GPT /.test(l))

test("GPT's usage follows Claude's in the status line: the 5 hours, then the week", async ($, on) => {
  const w = world(on)
  await call($)
  expect(w.reads).toBe(1)
  expect(lastStatus(w)).toMatch(/^context 50k of 1000k; 5h 6%, week 61%; resets \d\d:\d\d; GPT 11%\/2%$/)
  expect(gptLines(w)).toHaveLength(1)
  expect(gptLines(w)[0]).toContain('GPT 11%/2% read (5h resets 15:00Z, week 01-07 12:00Z; plus)')
})

test('the notices and their log lines carry it too, after Claude’s meters', async ($, on) => {
  const w = world(on)
  await call($)
  w.tokens = 120_000
  const notice = await call($)
  expect(notice).toContain('5h 6% (resets 13:10Z), week 61% (resets 12:00Z); GPT 11%/2%')
  expect(w.files[LOG]).toContain('context passed 100k | context 120k of 1000k; 5h 6% (resets 13:10Z), week 61% (resets 12:00Z); GPT 11%/2%')
})

test('read again after 5 minutes, not before; a codex command reads at once', async ($, on) => {
  const w = world(on)
  await call($)
  await w.clock.advance(4 * MIN)
  await call($)
  expect(w.reads).toBe(1)
  await w.clock.advance(MIN)
  await call($)
  expect(w.reads).toBe(2)
  await call($, 'codex exec -s read-only "review this"')
  expect(w.reads).toBe(3)
})

test('a reading that moves is logged and drawn; one that holds is not logged', async ($, on) => {
  const w = world(on)
  await call($)
  await w.clock.advance(5 * MIN)
  await call($)
  expect(gptLines(w)).toHaveLength(1)
  w.codex = { five: 17, week: 3 }
  await w.clock.advance(5 * MIN)
  await call($)
  expect(gptLines(w)).toHaveLength(2)
  expect(gptLines(w)[1]).toContain('GPT 17%/3% read')
  expect(lastStatus(w)).toMatch(/; GPT 17%\/3%$/)
})

test('no codex, or signed out: nothing shown, nothing logged, and asked again 5 minutes on', async ($, on) => {
  const w = world(on)
  w.codex = 'absent'
  await call($)
  expect(lastStatus(w)).not.toContain('GPT')
  w.codex = 'signed out'
  await w.clock.advance(5 * MIN)
  w.tokens = 120_000
  const notice = await call($)
  expect(w.reads).toBe(2)
  expect(notice).toContain('context passed 100k')
  expect(notice).not.toContain('GPT')
  expect(lastStatus(w)).not.toContain('GPT')
  expect(gptLines(w)).toHaveLength(0)
})

test('signed out after a reading: the reading goes from the line', async ($, on) => {
  const w = world(on)
  await call($)
  expect(lastStatus(w)).toContain('GPT 11%/2%')
  w.codex = 'signed out'
  await w.clock.advance(5 * MIN)
  await call($)
  expect(lastStatus(w)).not.toContain('GPT')
})

test('gpt off: codex is never asked', { options: { gptUsage: false } }, async ($, on) => {
  const w = world(on)
  await call($)
  await call($, 'codex exec "x"')
  expect(w.reads).toBe(0)
  expect(lastStatus(w)).not.toContain('GPT')
})

test("an agent's tool call reads nothing", async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  for (let i = 0; i < 20; i++) await tick()
  expect(w.reads).toBe(0)
})

test('an answer read: the meters by their windows, an error or no meter is none', () => {
  expect(reading(answer(11, 2))).toEqual({ five: 11, week: 2, fiveResets: JAN + 3 * 3_600_000, weekResets: JAN + 6 * 86_400_000, plan: 'plus' })
  expect(reading(SIGNED_OUT)).toBeNull()
  expect(reading('')).toBeNull()
  expect(reading('{"id":1,"result":{"rateLimits":{"primary":null,"secondary":null}}}')).toBeNull()
  // The week alone, as primary: "GPT ?/4%".
  const week = reading('{"id":1,"result":{"rateLimits":{"primary":{"usedPercent":4.4,"windowDurationMins":10080}}}}')
  expect(week).toEqual({ five: null, week: 4, fiveResets: null, weekResets: null, plan: null })
  expect(words(week!)).toBe('GPT ?/4%')
})
