import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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

// The options: the context step and usage marks raise notices, and the log goes to the data folder.
function meters(on: On, readings: { tokens: number; week: number }[], writes: Record<string, string>) {
  mock.env(on, { HOME: '/home/u', PWD: '/home/u/src/p' })
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
