import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

// The test environment has timers; the API's types do not declare them.
declare function setTimeout(fn: () => void, ms: number): unknown
const tick = () => new Promise<void>(r => setTimeout(r, 2))

const ANSWER = '## The careful answer\n\n- **one:** a point\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'
const SAID = '/home/u/.claude/context-watch-said-home-u-src-p.md'

// The engine's own clear row, beneath the mod's: plain text, no Markdown.
function engineRow(on: On) {
  on('ui.render', { component: 'CommandOutput' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>(no content)</Text>
  })
}

// The world beneath the mod: a home, a project, a words file already holding the
// last turn, a conversation, a clear that clears, a prompt that's taken.
function world(on: On, cleared: string[], sent: string[] = [], messages: unknown[] = []) {
  engineRow(on)
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  const clock = mock.clock(on)
  let file = `## 2026-01-01T15:38Z (s-1)\n\n${ANSWER}\n\n<!-- turn -->\n\n## 2026-01-01T15:20Z (s-1)\n\nolder\n`
  on('session.cwd', async () => ({ value: '/home/u/src/p' }))
  on('session.id', async () => ({ value: 's-1' }))
  on('session.usage', async () => ({ value: { context: { tokens: 205_000, window: 1_000_000 }, rateLimits: [] } }) as never)
  on('session.messages', async () => ({ value: messages }) as never)
  on('fs.read', async (_, e) => ({ value: e.path === SAID ? file : '' }))
  on('fs.write', async (_, e) => {
    if (e.path === SAID) file = e.text
    return { value: undefined }
  })
  on('command.run', { command: 'clear' }, async (_, e) => {
    cleared.push(e.origin?.kind ?? '?')
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => (sent.push(e.text), { text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  return clock
}

const ROW = { command: 'clear', args: '', text: '', isErrored: false }

async function drawn($: Engine) {
  const ui = await $.ui.mount({ plugin: 'context-watch', surface: 'terminal', component: 'CommandOutput', props: ROW })
  const md = await ui.find({ type: 'Markdown' })
  const head = await ui.find({ type: 'Text', text: /Before the clear \(15:38Z\)/ })
  await ui.unmount()
  return { md, head }
}

// The conversation before the clear: a prompt, words on the way, a tool call, then the answer.
const TURN = [
  { role: 'user', text: 'what now?', toolUses: [] },
  { role: 'assistant', text: 'Looking.', toolUses: [{ id: 't1', name: 'Bash' }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
  { role: 'assistant', text: ANSWER, toolUses: [] },
]

// A row drawn by the clear scrolls away before it can be read; restart pastes the last
// answer at the end of its own prompt instead, and the row stays empty.
test('clear_and_restart pastes the last answer at the end of its prompt', async ($, on) => {
  const cleared: string[] = []
  const prompts: string[] = []
  const clock = world(on, cleared, prompts, TURN)
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)
  for (let i = 0; i < 100 && !prompts.length; i++) await tick() // the restart runs to its brief
  const sent = prompts[0] ?? ''

  expect(cleared).toEqual(['plugin'])
  expect(sent).toContain('carry on')
  expect(sent.endsWith(`\n\n${ANSWER}`)).toBe(true)
  expect(sent).not.toContain('Looking.')
  expect((await drawn($)).md).toBeUndefined()
})

test("the user's /clear shows it in the clear's row", async ($, on) => {
  world(on, [])
  await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } } as never)
  expect((await drawn($)).md?.text).toBe(ANSWER)
})

// The row is printed into scrollback as the clear draws it, and never drawn again.
// Restart's clear must not draw the words the user's clear before it left held.
test("restart's clear draws no row, not the clear before's words", async ($, on) => {
  engineRow(on)
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  const clock = mock.clock(on)
  let file = `## 2026-01-01T15:20Z (s-1)\n\nolder\n`
  let during: string | undefined = 'unset'
  on('session.cwd', async () => ({ value: '/home/u/src/p' }))
  on('session.id', async () => ({ value: 's-1' }))
  on('session.usage', async () => ({ value: { context: { tokens: 205_000, window: 1_000_000 }, rateLimits: [] } }) as never)
  on('session.messages', async () => ({ value: TURN }) as never)
  on('fs.read', async (_, e) => ({ value: e.path === SAID ? file : '' }))
  on('fs.write', async (_, e) => {
    if (e.path === SAID) file = e.text
    return { value: undefined }
  })
  let clears = 0
  on('command.run', { command: 'clear' }, async () => {
    if (clears++ === 0) return { text: '' } // the user's clear before, which leaves its words held
    const ui = await $.ui.mount({ plugin: 'context-watch', surface: 'terminal', component: 'CommandOutput', props: ROW })
    during = (await ui.find({ type: 'Markdown' }))?.text
    await ui.unmount()
    return { text: '' }
  })
  let briefed = false
  on('prompt.submit', async (_, e) => ((briefed = true), { text: e.text }))
  on('turn.complete', async () => ({ text: '' }))

  await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)

  for (let i = 0; i < 100 && !briefed; i++) await tick() // the restart runs to its brief
  expect(briefed).toBe(true)
  expect(during).toBeUndefined()
})

// The user's question came during the compaction: the resume prompt would wait under it,
// to run as a second "carry on". The user's prompt resumes it; `next` rides in the
// summary's instructions instead.
test('compact_and_continue sends no resume prompt when the user speaks during the compaction', async ($, on) => {
  const sent: string[] = []
  const clock = world(on, [], sent, TURN)
  let asked = ''
  on('session.compact', async (_, e) => {
    asked = e.instructions ?? ''
    await $.prompt.submit({ text: 'why compact?', origin: { kind: 'composer' }, wait: false } as never)
    return { messages: [{ role: 'user', text: 'the summary', toolUses: [] }], tokensBefore: 214_000, tokensAfter: 30_000 } as never
  })
  await $.tool.call({ tool: 'mcp__context-watch__compact_and_continue', keep: 'the rules', next: 'step two next' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)
  for (let i = 0; i < 100 && !asked; i++) await tick()
  for (let i = 0; i < 20; i++) await tick() // time for a resume prompt, were one coming

  expect(asked).toContain('the rules')
  expect(asked).toContain('step two next')
  expect(sent).toEqual(['why compact?'])
})

// T182: an agent's report woke the session after a compaction, and the resume prompt queued
// behind its turn as a second "carry on". Any prompt but the mod's own resumes the session.
for (const origin of [{ kind: 'peer-send-message' }, { kind: 'task-notification' }, { kind: 'plugin', name: 'talkback' }]) {
  test(`compact_and_continue sends no resume prompt when a ${origin.kind} prompt comes during the compaction`, async ($, on) => {
    const sent: string[] = []
    const clock = world(on, [], sent, TURN)
    let compacted = false
    on('session.compact', async () => {
      await $.prompt.submit({ text: 'an agent finished', origin, wait: false } as never)
      compacted = true
      return { messages: [{ role: 'user', text: 'the summary', toolUses: [] }], tokensBefore: 214_000, tokensAfter: 30_000 } as never
    })
    await $.tool.call({ tool: 'mcp__context-watch__compact_and_continue', keep: 'the rules', next: 'step two next' } as never)
    await $.turn.complete({ reason: 'answer', answer: '' } as never)
    await clock.advance(1000)
    for (let i = 0; i < 100 && !compacted; i++) await tick()
    for (let i = 0; i < 20; i++) await tick() // time for a resume prompt, were one coming

    expect(sent).toEqual(['an agent finished'])
  })
}

// A notice while a clear waits is not the user: the clear still runs, and its brief follows.
test("a task's notice does not drop a queued clear; the user's prompt does", async ($, on) => {
  const cleared: string[] = []
  const prompts: string[] = []
  const clock = world(on, cleared, prompts, TURN)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await $.prompt.submit({ text: 'a task finished', origin: { kind: 'task-notification' }, wait: false } as never)
  await clock.advance(1000)
  for (let i = 0; i < 100 && prompts.length < 2; i++) await tick()
  expect(cleared.length).toBe(1)
  expect(prompts[0]).toBe('a task finished')
  expect(prompts[1]?.startsWith('Starting fresh after the clear you asked for')).toBe(true)
})

test('compact_and_continue resumes with next when nobody spoke', async ($, on) => {
  const sent: string[] = []
  const clock = world(on, [], sent, TURN)
  on('session.compact', async () => ({ messages: [{ role: 'user', text: 'the summary', toolUses: [] }], tokensBefore: 214_000, tokensAfter: 30_000 }) as never)
  await $.tool.call({ tool: 'mcp__context-watch__compact_and_continue', keep: 'the rules', next: 'step two next' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)
  for (let i = 0; i < 100 && !sent.length; i++) await tick()

  expect(sent).toEqual(['Resuming after the compaction you asked for. step two next'])
})

// The time the worlds below start at: the mod reads its limits' windows by $.clock, and the kit
// answers a clock only where a world mocks one.
const JAN = Date.parse('2026-01-01T12:00:00Z')

// The options: the context step and usage marks raise notices, and the log goes to the data folder.
function meters(on: On, readings: { tokens: number; week: number }[], writes: Record<string, string>) {
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  mock.clock(on, { now: JAN })
  let i = 0
  on('session.usage', async () => {
    const r = readings[Math.min(i++, readings.length - 1)] ?? { tokens: 0, week: 0 }
    return {
      value: {
        context: { tokens: r.tokens, window: 1_000_000 },
        rateLimits: [{ kind: 'seven_day', percentUsed: r.week, resetsAt: '2026-01-05T00:00:00Z' }],
      },
    } as never
  })
  on('fs.read', async (_, e) => ({ value: writes[e.path] ?? '' }))
  on('fs.write', async (_, e) => ((writes[e.path] = e.text), { value: undefined }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
}

test('the default step notices 100k and the week marks; the log goes to ~/.claude', async ($, on) => {
  const writes: Record<string, string> = {}
  meters(on, [{ tokens: 90_000, week: 40 }, { tokens: 120_000, week: 76 }], writes)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never) // the first reading is taken silently
  const ran = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: readonly string[] }

  expect(ran.context?.join(' ')).toContain('context passed 100k, week usage passed 75%')
  expect(writes['/home/u/.claude/context-watch.log']).toContain('context passed 100k')
})

test(
  'a custom step, marks and data folder',
  { options: { contextStep: 50_000, weeklyMarks: '', dataDir: '/var/tmp/cw/' } },
  async ($, on) => {
    const writes: Record<string, string> = {}
    meters(on, [{ tokens: 40_000, week: 40 }, { tokens: 60_000, week: 99 }], writes)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const ran = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: readonly string[] }

    expect(ran.context?.join(' ')).toContain('context passed 50k:')
    expect(ran.context?.join(' ')).not.toContain('week usage passed')
    expect(writes['/var/tmp/cw/context-watch.log']).toContain('context passed 50k')
    expect(Object.keys(writes).some(p => p.startsWith('/home/u'))).toBe(false)
  },
)

// The suggested clear and /context-watch: a context gauge the test sets, a clock, a session, a
// clear, and the /config rows the command writes through.
function gauge(on: On, sets: [string, unknown][] = []) {
  const g: { tokens: number; percent?: number; clock: MockClock } = { tokens: 0, clock: mock.clock(on, { now: JAN }) }
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  on('session.usage', async () => {
    const week = g.percent === undefined ? [] : [{ kind: 'seven_day', percentUsed: g.percent, resetsAt: '2099-01-02T12:00:00Z' }]
    return { value: { context: { tokens: g.tokens, window: 1_000_000 }, rateLimits: week } } as never
  })
  on('session.id', async () => ({ value: 's-1' }))
  on('session.cwd', async () => ({ value: '/home/u/src/p' }))
  on('fs.read', async () => ({ value: '' }))
  on('fs.write', async () => ({ value: undefined }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('config.set', async (_, e) => (sets.push([e.key, e.value]), { value: e.value }) as never)
  on('command.run', { command: 'clear' }, async () => ({ text: '' }))
  on('ui.status', async () => ({ value: undefined }) as never)
  return g
}

async function at($: Engine, g: { tokens: number }, tokens: number) {
  g.tokens = tokens
  const ran = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: readonly string[] }
  return ran.context?.join(' ') ?? ''
}

const cw = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'context-watch', args, origin: { kind: 'composer' } } as never)) as { text?: string; context?: string[] }

test('the suggested clear raises its notice once, on the way past it', { options: { clearAt: 250_000 } }, async ($, on) => {
  const g = gauge(on)
  await at($, g, 240_000) // the first reading is taken silently
  const past = await at($, g, 260_000)
  expect(past).toContain('context passed 250k, the suggested clear: land the work in files, then clear')
  expect(past).toContain('clear at 250k')
  expect(await at($, g, 270_000)).toBe('')
})

test('no suggested clear by default', async ($, on) => {
  const g = gauge(on)
  await at($, g, 240_000)
  expect(await at($, g, 260_000)).toBe('')
})

test('/context-watch epoch moves the suggested clear for this context alone', { options: { clearAt: 250_000 } }, async ($, on) => {
  const sets: [string, unknown][] = []
  const g = gauge(on, sets)
  await at($, g, 240_000)
  const set = await cw($, 'epoch 300k')
  expect(set.text).toContain("This context's suggested clear: 300k")
  expect(set.context?.join(' ')).toContain('clear at 300k (this context)')
  expect(await at($, g, 260_000)).toBe('')
  expect(await at($, g, 310_000)).toContain('context passed 300k, the suggested clear for this context')
  expect((await cw($, 'epoch +50k')).text).toContain('350k')
  expect(sets).toEqual([]) // no setting changed

  await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } } as never)
  expect((await cw($, 'epoch')).text).toContain("the target's (250k)")
  await at($, g, 240_000)
  expect(await at($, g, 260_000)).toContain('context passed 250k, the suggested clear:')
})

test('/context-watch epoch reset goes back to the target, and a compaction does too', { options: { clearAt: 250_000 } }, async ($, on) => {
  const { clock } = gauge(on)
  let compacted = false
  on('session.compact', async () => {
    compacted = true
    return { messages: [{ role: 'user', text: 'the summary', toolUses: [] }], tokensBefore: 280_000, tokensAfter: 30_000 } as never
  })
  on('prompt.submit', async (_, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  await cw($, 'epoch 400k')
  expect((await cw($, 'epoch reset')).text).toContain("the target's again: 250k")
  await cw($, 'epoch off')
  expect((await cw($, 'epoch')).text).toContain('epoch: off.')
  await $.tool.call({ tool: 'mcp__context-watch__compact_and_continue', keep: 'the rules', next: 'go on' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)
  for (let i = 0; i < 100 && !compacted; i++) await tick()
  for (let i = 0; i < 10; i++) await tick()
  expect((await cw($, 'epoch')).text).toContain("the target's (250k)")
})

test('/context-watch target writes its /config row', { options: { clearAt: 250_000 } }, async ($, on) => {
  const sets: [string, unknown][] = []
  gauge(on, sets)
  const done = await cw($, 'target 300k')
  expect(sets).toEqual([['context-watch.clearAt', 300_000]])
  expect(done.text).toContain('target: 250k → 300k')
  await cw($, 'status off')
  await cw($, 'week 60,80')
  await cw($, 'resume "Read the notes first."')
  expect(sets.slice(1)).toEqual([
    ['context-watch.statusLine', false],
    ['context-watch.weeklyMarks', '60,80'],
    ['context-watch.resumeNote', 'Read the notes first.'],
  ])
})

test('/context-watch refuses what it cannot take', async ($, on) => {
  const sets: [string, unknown][] = []
  gauge(on, sets)
  expect((await cw($, 'target lots')).text).toContain('takes a number of tokens')
  expect((await cw($, '5h 50,200')).text).toContain('percentages from 1 to 100')
  expect((await cw($, 'step 0')).text).toContain('at least 1')
  expect((await cw($, 'colour blue')).text).toContain('no setting "colour"')
  expect(sets).toEqual([])
})

test('/context-watch shows every setting', { options: { clearAt: 250_000 } }, async ($, on) => {
  const g = gauge(on)
  g.tokens = 120_000
  const text = (await cw($, '')).text ?? ''
  expect(text).toContain('context 120k of 1000k, clear at 250k')
  for (const name of ['target', 'epoch', 'step', '5h', 'week', 'limitweek', 'limit5h', 'night', 'resume', 'status', 'log', 'logcap', 'turns', 'data'])
    expect(text).toMatch(new RegExp(`\\n  ${name} `))
})

// A change of a setting reloads the mod, which would drop a clear on its way.
test('/context-watch changes no setting while a clear is queued', async ($, on) => {
  const sets: [string, unknown][] = []
  gauge(on, sets)
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on' } as never)
  expect((await cw($, 'target 300k')).text).toContain('on its way')
  expect(sets).toEqual([])
})

test('the resume note opens the brief after a clear', { options: { resumeNote: 'Read the notes first.' } }, async ($, on) => {
  const prompts: string[] = []
  const clock = world(on, [], prompts, TURN)
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)
  for (let i = 0; i < 100 && !prompts.length; i++) await tick()
  expect(prompts[0]).toContain('if a detail is missing). Read the notes first. carry on')
})

// A usage limit: the week meter as the test sets it, and the store the limits live in.
function meter(on: On, sets: [string, unknown][] = []) {
  const g = gauge(on, sets)
  g.percent = 40
  mock.store(on)
  return g
}

async function call($: Engine) {
  const ran = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: readonly string[] }
  return ran.context?.join(' ') ?? ''
}

test('limitweek: reached in a turn, the model is told to land and stop, and nothing clears', async ($, on) => {
  const prompts: string[] = []
  const cleared: string[] = []
  const w = meter(on)
  const clock = w.clock
  on('command.run', { command: 'clear' }, async (_, e) => (cleared.push(e.origin?.kind ?? '?'), { text: '' }))
  on('session.messages', async () => ({ value: TURN }) as never)
  on('prompt.submit', async (_, e) => (prompts.push(e.text), { text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  const set = await cw($, 'limitweek +4%')
  expect(set.text).toContain('limitweek: 44% to 01-02 12:00Z, the meter at 40%')
  await call($)
  w.percent = 44
  const word = await call($)
  expect(word).toContain('week usage reached its limit, 44% (/context-watch limitweek): land what is in flight')
  expect(word).toContain('start nothing new')
  expect(word).toContain('The conversation stays as it is')
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)
  for (let i = 0; i < 20; i++) await tick() // time for a clear, were one coming
  expect(cleared).toEqual([])
  expect(prompts).toEqual([])
  expect(await call($)).toBe('') // told once a context
})

test('limitweek off, and a limit already reached says so at once, with no clear', async ($, on) => {
  meter(on)
  const set = await cw($, 'limitweek 30%')
  expect(set.text).toContain('reached already (40%): the model is told to land what is in flight')
  expect(set.context?.join(' ')).toContain('start nothing new')
  expect(await call($)).toBe('') // already told, by the command
  expect((await cw($, 'limitweek off')).text).toBe('limitweek: off.')
  expect((await cw($, 'limitweek')).text).toBe('limitweek: off; the week meter reads 40%.')
  expect((await cw($, 'limitweek lots')).text).toContain('takes a percentage')
})

// The meters are the account's, but a limit is the window's: another session's work goes on.
test("a limit holds in its own window: nothing in the store, and 0.4.0's shared one is gone", async ($, on) => {
  gauge(on).percent = 40
  const kept: Record<string, unknown> = { limits: { seven_day: { percent: 30 } } }
  on('store.get', async (_, e) => ({ value: kept[e.key] }) as never)
  on('store.set', async (_, e) => ((kept[e.key] = e.value), { value: undefined }) as never)
  on('store.delete', async (_, e) => (delete kept[e.key], { value: undefined }) as never)
  on('session.start', async (_, e) => e as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/home/u/src/p' } as never)
  expect(kept).toEqual({})
  expect(await call($)).toBe('') // the old shared limit says nothing
  await cw($, 'limitweek 50%')
  expect(kept).toEqual({})
  expect((await cw($, 'limitweek')).text).toBe('limitweek: 50% to 01-02 12:00Z; the week meter reads 40%.')
})

// A clear waits for an idle session; the user's prompt in the meantime means they are
// reading and working in this conversation, so the clear is dropped and the model told.
test("the user's prompt drops a queued clear, and the model hears of it", async ($, on) => {
  const cleared: string[] = []
  const prompts: string[] = []
  const clock = world(on, cleared, prompts, TURN)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await $.prompt.submit({ text: 'no, stop', origin: { kind: 'composer' }, wait: false } as never)
  await clock.advance(1000)
  for (let i = 0; i < 20; i++) await tick()
  expect(cleared).toEqual([])
  expect(prompts).toEqual(['no, stop'])
  const ran = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: readonly string[] }
  expect(ran.context?.join(' ')).toContain('The clear queued at the end of a turn was dropped: the user spoke')
})

// A turn not the user's (a background task's report, say) can run before the clear finds the
// session idle: the answer pasted is the one on screen when the clear runs, not the one before.
test('the answer pasted is the one on screen when the clear runs', async ($, on) => {
  const prompts: string[] = []
  let messages: unknown[] = TURN
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  on('session.cwd', async () => ({ value: '/home/u/src/p' }))
  on('session.id', async () => ({ value: 's-1' }))
  on('session.usage', async () => ({ value: { context: { tokens: 205_000, window: 1_000_000 }, rateLimits: [] } }) as never)
  on('session.messages', async () => ({ value: messages }) as never)
  on('fs.read', async () => ({ value: '' }))
  on('fs.write', async () => ({ value: undefined }))
  let tries = 0
  on('command.run', { command: 'clear' }, async () => {
    if (tries++ === 0) {
      messages = [...TURN, { role: 'user', text: 'a task finished', toolUses: [] }, { role: 'assistant', text: 'The newer answer.', toolUses: [] }]
      throw new Error('a turn is running')
    }
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => (prompts.push(e.text), { text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on' } as never)
  await $.turn.complete({ reason: 'answer', answer: '' } as never)
  await clock.advance(1000)
  for (let i = 0; i < 20 && tries < 1; i++) await tick()
  await clock.advance(5000)
  for (let i = 0; i < 100 && !prompts.length; i++) await tick()
  expect(prompts[0]?.endsWith('\n\nThe newer answer.')).toBe(true)
})

// The night (/context-watch night, the night tool): the session runs on to a line on the week
// meter. The world: a clock at 03:00Z, the meters as the test sets them, the agents at work, the
// prompts sent and what rode beside them, the log.
const T0 = Date.parse('2026-10-30T03:00:00Z')
const MIN = 60_000
const LOG = '/home/u/.claude/context-watch.log'
const WORDS = '"use up to 97% tonight" (his words, 03:00Z)'
const NEXT = 'Take the next ready task.'

function night(on: On) {
  const g = { week: 90, five: 10, fiveResets: '2026-10-30T07:00:00Z', weekResets: '2026-10-31T12:00:00Z', agents: [] as unknown[] }
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
  const files: Record<string, string> = {}
  const sent: string[] = []
  const beside: string[] = []
  on('session.usage', async () => {
    const rateLimits = [
      { kind: 'five_hour', percentUsed: g.five, resetsAt: g.fiveResets },
      { kind: 'seven_day', percentUsed: g.week, resetsAt: g.weekResets },
    ]
    return { value: { context: { tokens: 100_000, window: 1_000_000 }, rateLimits } } as never
  })
  on('session.id', async () => ({ value: 's-1' }))
  on('session.cwd', async () => ({ value: '/home/u/src/p' }))
  on('session.messages', async () => ({ value: [] }) as never)
  on('fs.read', async (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', async (_, e) => ((files[e.path] = e.text), { value: undefined }))
  on('agent.list', async () => ({ value: g.agents }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('command.run', { command: 'clear' }, async () => ({ text: '' }))
  on('prompt.submit', async (_, e) => (sent.push(e.text), beside.push(...(e.context ?? [])), { text: e.text }))
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  const later = async (ms: number) => {
    await clock.advance(ms)
    for (let i = 0; i < 20; i++) await tick()
  }
  return { g, clock, sent, beside, later, log: () => files[LOG] ?? '' }
}

let turnIds = 0
// One turn of the main loop (or an agent's): its start with the prompt's text, its tool calls, its end.
async function turn($: Engine, answer: string, o: { text?: string; tools?: number; reason?: string; agentId?: string } = {}) {
  const turnId = `t${++turnIds}`
  const agent = o.agentId ? { agentId: o.agentId } : {}
  await $.turn.start({ text: o.text ?? 'go', turnId, ...agent } as never)
  for (let i = 0; i < (o.tools ?? 1); i++) await $.tool.call({ tool: 'Bash', command: 'ls', ...agent } as never)
  await $.turn.complete({ reason: o.reason ?? 'answer', answer, turnId, durationMs: 1, isAborted: o.reason === 'aborted', ...agent } as never)
}

const setNight = async ($: Engine, more: Record<string, unknown> = {}) =>
  (await $.tool.call({ tool: 'mcp__context-watch__night', line: 96, words: WORDS, next: NEXT, ...more } as never)) as { result?: string; deny?: string }
const his = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as never
const notice = (text: string) => ({ text, origin: { kind: 'task-notification' }, wait: false }) as never

test('a night resumes a turn that ends under its line, two minutes on, with his words', async ($, on) => {
  const w = night(on)
  expect((await setNight($)).result).toContain('The night runs to 96% of the week (the meter at 90%)')
  await turn($, 'Landed P1390.')
  await w.later(2 * MIN - 1000)
  expect(w.sent).toEqual([])
  await w.later(1000)
  expect(w.sent.length).toBe(1)
  const p = w.sent[0] ?? ''
  expect(p.startsWith('Carrying on the night')).toBe(true)
  expect(p).toContain('the week meter at 90% of its line, 96%')
  expect(p).toContain(WORDS)
  expect(p).toContain(NEXT)
  expect(p).toContain('`Needs you:`')
  expect(w.log()).toContain('the night resumed the session')
})

test('the resume note rides in every carry-on', { options: { resumeNote: 'Read the notes first.' } }, async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, 'Landed P1390.')
  await w.later(2 * MIN)
  expect(w.sent[0]).toContain(`Read the notes first. ${NEXT}`)
})

test('a spent 5-hour window: the resume waits for its reset; an error near it does too', async ($, on) => {
  const w = night(on)
  await setNight($)
  w.g.five = 100
  await turn($, 'Landed P1390.')
  await w.later(10 * MIN)
  expect(w.sent).toEqual([])
  expect(w.log()).toContain('the 5-hour window is spent (100%); resuming at 07:02Z')
  w.g.five = 0
  await w.clock.set(Date.parse('2026-10-30T07:02:00Z'))
  for (let i = 0; i < 20; i++) await tick()
  expect(w.sent.length).toBe(1)

  w.g.five = 93
  w.g.fiveResets = '2026-10-30T12:00:00Z'
  await turn($, '', { text: w.sent[0], reason: 'error', tools: 0 })
  await w.later(30 * MIN)
  expect(w.sent.length).toBe(1)
  expect(w.log()).toContain('the 5-hour window is spent (93%); resuming at 12:02Z')
})

test('an error well under the 5-hour limit retries in ten minutes', async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, '', { reason: 'error', tools: 0 })
  await w.later(9 * MIN)
  expect(w.sent).toEqual([])
  await w.later(MIN)
  expect(w.sent.length).toBe(1)
})

test('his prompt ends the night, and the model hears of it', async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, 'Landed P1390.')
  await $.prompt.submit(his('how is it going?'))
  expect(w.beside.join(' ')).toContain("The user's prompt ended the night (to 96% of the week)")
  expect(w.beside.join(' ')).toContain('mcp__context-watch__night')
  await w.later(10 * MIN)
  expect(w.sent).toEqual(['how is it going?'])
  expect((await cw($, 'night')).text).toContain('night: off')
})

test('a turn that ends waiting on him, or with nothing ready, pauses the night until the next prompt', async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, 'Landed P1390.\n\nNeeds you: Q575, the faded damper.')
  await w.later(10 * MIN)
  expect(w.sent).toEqual([])
  expect(w.log()).toContain('the night paused: the turn ended with "Needs you"')
  await $.prompt.submit(notice('a task finished'))
  await turn($, 'Read its report.', { text: 'a task finished' })
  await w.later(2 * MIN)
  expect(w.sent.length).toBe(2)
  expect(w.sent[1]?.startsWith('Carrying on the night')).toBe(true)
  await turn($, 'Checked.\n\n- **Nothing ready:** the rest waits on him.', { text: w.sent[1] })
  await w.later(10 * MIN)
  expect(w.sent.length).toBe(2)
})

test('his Esc ends the night: a later notice does not start it again, and his next prompt hears why', async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, '', { reason: 'aborted' })
  await $.prompt.submit(notice('a task finished'))
  await turn($, 'Read its report.', { text: 'a task finished' })
  await w.later(10 * MIN)
  expect(w.sent).toEqual(['a task finished'])
  expect(w.log()).toContain('the night ended: the user interrupted the turn')
  await $.prompt.submit(his('sorry, go on'))
  expect(w.beside.join(' ')).toContain('ended the night')
})

test("the night ends at its line, its stop time and the week's reset", async ($, on) => {
  const w = night(on)
  await setNight($)
  w.g.week = 96
  await turn($, 'Landed P1390.')
  await w.later(10 * MIN)
  expect(w.log()).toContain('the night ended: the week meter at 96%, its line 96%')

  w.g.week = 90
  await setNight($, { until: '2026-10-30T03:30:00Z' })
  await w.later(30 * MIN)
  await turn($, 'Landed P1391.')
  await w.later(10 * MIN)
  expect(w.log()).toContain('the night ended: its stop time, 03:30Z')

  w.g.weekResets = '2026-10-30T04:00:00Z'
  await setNight($)
  await w.later(15 * MIN)
  await turn($, 'Landed P1392.')
  await w.later(10 * MIN)
  expect(w.log()).toContain("the night ended: the week's window reset")

  w.g.weekResets = '2026-10-31T12:00:00Z'
  w.g.five = 100
  await setNight($, { until: '2026-10-30T05:00:00Z' })
  await turn($, 'Landed P1393.')
  expect(w.log()).toContain('the night ended: its next resume would come after its stop time, 05:00Z')
  expect(w.sent).toEqual([])
})

test('a resumed turn that makes no tool call pauses the night; one that works is resumed again', async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, 'Landed P1390.')
  await w.later(2 * MIN)
  await turn($, 'Landed P1391.', { text: w.sent[0] })
  await w.later(2 * MIN)
  expect(w.sent.length).toBe(2)
  await turn($, 'All done, it seems.', { text: w.sent[1], tools: 0 })
  await w.later(10 * MIN)
  expect(w.sent.length).toBe(2)
  expect(w.log()).toContain('the night paused: the resumed turn made no tool call')
})

test('eight resumes in an hour pause the night', async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, 'Landed.')
  for (let i = 0; i < 8; i++) {
    await w.later(2 * MIN)
    await turn($, 'Landed another.', { text: w.sent.at(-1) })
  }
  await w.later(10 * MIN)
  expect(w.sent.length).toBe(8)
  expect(w.log()).toContain('the night paused: 8 resumes in the last hour')
})

test('an agent at work holds the resume, which comes once it is done', async ($, on) => {
  const w = night(on)
  await setNight($)
  w.g.agents = [{ id: 'a1', description: 'a long run', type: 'general-purpose', status: 'running' }]
  await turn($, 'Waiting on the agent.')
  await w.later(6 * MIN)
  expect(w.sent).toEqual([])
  w.g.agents = [{ id: 'a1', description: 'a long run', type: 'general-purpose', status: 'completed' }]
  await w.later(2 * MIN)
  expect(w.sent.length).toBe(1)
})

test('a turn that starts in the wait cancels the resume; its own end arms the next', async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, 'Landed P1390.')
  await w.later(MIN)
  await $.prompt.submit(notice('a task finished'))
  await $.turn.start({ text: 'a task finished', turnId: 'tn' } as never)
  await w.later(5 * MIN)
  expect(w.sent).toEqual(['a task finished'])
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'Read it.', turnId: 'tn', durationMs: 1, isAborted: false } as never)
  await w.later(2 * MIN)
  expect(w.sent.length).toBe(2)
})

test("an agent's turn that ends is not the session's: nothing resumes", async ($, on) => {
  const w = night(on)
  await setNight($)
  await turn($, 'The agent is done.', { agentId: 'a1' })
  await w.later(10 * MIN)
  expect(w.sent).toEqual([])
})

test("a clear queued at a turn's end sends its brief, not a carry-on; the brief's turn carries on", async ($, on) => {
  const w = night(on)
  await setNight($)
  await $.turn.start({ text: 'go', turnId: 'tc' } as never)
  await $.tool.call({ tool: 'mcp__context-watch__clear_and_restart', brief: 'carry on from the brief' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'Clearing.', turnId: 'tc', durationMs: 1, isAborted: false } as never)
  await w.later(2 * MIN)
  expect(w.sent.length).toBe(1)
  expect(w.sent[0]).toContain('Starting fresh after the clear')
  await turn($, 'Landed P1391.', { text: w.sent[0] })
  await w.later(2 * MIN)
  expect(w.sent.length).toBe(2)
  expect(w.sent[1]?.startsWith('Carrying on the night')).toBe(true)
})

test('a reload finds the resume due and arms it again, once', async ($, on) => {
  const w = night(on)
  on('session.start', async (_, e) => e as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('store.delete', async () => ({ value: undefined }) as never)
  await setNight($)
  await turn($, 'Landed P1390.')
  await w.later(MIN)
  await $.session.start({ cwd: '/home/u/src/p' } as never) // as a reload runs it
  await w.later(MIN)
  expect(w.sent.length).toBe(1)
  await w.later(5 * MIN)
  expect(w.sent.length).toBe(1)
})

test('/context-watch night sets, shows and ends a night; set while idle, it starts the session', async ($, on) => {
  const w = night(on)
  const set = await cw($, 'night 96% until 2026-10-30T09:30:00Z')
  expect(set.text).toContain('The night runs to 96% of the week (the meter at 90%), until 09:30Z')
  expect((await cw($, 'night')).text).toContain('/context-watch night 96% until 2026-10-30T09:30:00Z, typed at 03:00Z')
  expect((await cw($, '')).text).toMatch(/\n  night +96% to 09:30Z /)
  await w.later(2 * MIN)
  expect(w.sent.length).toBe(1)
  expect((await cw($, 'night off')).text).toBe('night: off.')
  expect((await cw($, 'night 80%')).text).toContain('at or past 80%')
  expect((await cw($, 'night lots')).text).toContain('/context-watch night 96%')
})

test("the night's line is the week's ceiling: one word to land and stop", async ($, on) => {
  const w = night(on)
  await setNight($)
  w.g.week = 95
  expect(await call($)).toBe('')
  w.g.week = 96
  const word = await call($)
  expect(word).toContain("week usage reached the night's line, 96% (/context-watch night): land what is in flight")
  expect(word.match(/land what is in flight/g)?.length).toBe(1)
})

test('a week limit below the line holds: the night runs to it', async ($, on) => {
  const w = night(on)
  await cw($, 'limitweek 94%')
  expect((await setNight($)).result).toContain("this window's week limit, 94%, holds below it")
  await turn($, 'Landed.')
  await w.later(2 * MIN)
  expect(w.sent[0]).toContain('of its line, 94%')
  w.g.week = 94
  await turn($, 'Landed more.', { text: w.sent[0] })
  await w.later(10 * MIN)
  expect(w.sent.length).toBe(1)
  expect(w.log()).toContain('the night ended: the week meter at 94%, its line 94%')
})
