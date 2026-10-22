// context-watch: tells the model where it stands (context size, the 5-hour and
// weekly plan usage) each time a mark is crossed, logs it with what was in hand,
// and gives it two tools to make room and carry on:
//
// - compact_and_continue compacts the conversation, telling the summarizer what
//   must survive, then resumes with a prompt the model wrote beforehand.
// - clear_and_restart clears the conversation (no summary to lose things in) and
//   starts again from a brief the model wrote beforehand.
//
// The engine's own automatic compaction point is the settings' autoCompactWindow
// (less its buffer), not this mod's.
//
// Each turn's words also go to a file (the last few, per project), so a clear never
// loses the answer the user was reading:
//
// - After the user's /clear, the clear's row draws the last turn whole, as markdown.
// - After clear_and_restart, the last answer is pasted at the end of the brief
//   prompt instead: a row drawn by the clear scrolls away before it can be read.
//   That clear draws no row, so it never shows an older clear's words.
// - A prompt the user sends while a compaction runs resumes the session by itself,
//   so the resume prompt is skipped (it would run as a second "carry on"), and
//   `next` rides in the summary's instructions so nothing is lost.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionUsage } from 'claude-code'

import type { Shown } from '../types'

type Engine = EngineInterface

const NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
const TOOL = 'compact_and_continue'
const CLEAR = 'clear_and_restart'
const SAID_SEP = '\n\n<!-- turn -->\n\n'

// The options, from the manifest's userConfig (see the README); defaults filled in.
type Settings = {
  step: number // a notice at every multiple of this many tokens of context
  marks: Record<string, number[]> // usage percentages per window, ascending
  statusLine: boolean
  dataDir: string // the log and the words files; a leading ~ is HOME
  log: boolean
  logCap: number // bytes; past it the log keeps its newer half
  keepTurns: number // turns the words file keeps; 0, none
}

const DEFAULTS: Settings = {
  step: 100_000,
  marks: { five_hour: [50, 80, 95], seven_day: [50, 75, 90] },
  statusLine: true,
  dataDir: '~/.claude',
  log: true,
  logCap: 200_000,
  keepTurns: 10,
}

function num(v: unknown, fallback: number, min: number) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback
}

function flag(v: unknown, fallback: boolean) {
  return typeof v === 'boolean' ? v : fallback
}

// "50, 80,95" -> [50, 80, 95]; an empty string, no marks.
function percents(v: unknown, fallback: readonly number[]) {
  if (typeof v !== 'string') return [...fallback]
  return v
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => a - b)
}

function settings(o: PluginOptions): Settings {
  const dir = typeof o.dataDir === 'string' ? o.dataDir.trim().replace(/(.)\/+$/, '$1') : ''
  return {
    step: num(o.contextStep, DEFAULTS.step, 1),
    marks: {
      five_hour: percents(o.fiveHourMarks, DEFAULTS.marks.five_hour ?? []),
      seven_day: percents(o.weeklyMarks, DEFAULTS.marks.seven_day ?? []),
    },
    statusLine: flag(o.statusLine, DEFAULTS.statusLine),
    dataDir: dir || DEFAULTS.dataDir,
    log: flag(o.log, DEFAULTS.log),
    logCap: num(o.logMaxBytes, DEFAULTS.logCap, 1000),
    keepTurns: num(o.keepTurns, DEFAULTS.keepTurns, 0),
  }
}

let cfg: Settings = DEFAULTS

// The words the clear's row draws: $.state, so a reload of the mod keeps them on screen.
const shown = atom({ plugin: 'context-watch', key: 'shown' } as const, null)

// Module variables start over on a reload; the first reading after one is taken
// silently, so a reload never repeats a notice.
let bucket: number | undefined
const marks: Record<string, number> = {}
const recent: string[] = []
let pending: { keep: string; next: string } | undefined
let pendingClear: { brief: string } | undefined
// The user's prompt came while a compaction ran: it resumes the session, so the
// resume prompt is not sent (it would run as a second "carry on" after the answer).
let spoke = false

const k = (n: number) => `${Math.round(n / 1000)}k`
const clock = (iso?: string) => (iso ? new Date(iso).toISOString().slice(11, 16) + 'Z' : '?')

function windows(u: SessionUsage) {
  return u.rateLimits
    .filter(r => NAMES[r.kind])
    .map(r => `${NAMES[r.kind]} ${r.percentUsed}% (resets ${clock(r.resetsAt)})`)
    .join(', ')
}

// The status line: no reset times but the 5-hour window's, last, in local time.
function status(u: SessionUsage) {
  const line = now(u).replace(/ \(resets [^)]*\)/g, '')
  const at = u.rateLimits.find(r => r.kind === 'five_hour')?.resetsAt
  if (!at) return line
  const d = new Date(at)
  return `${line}; resets ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function now(u: SessionUsage) {
  const c = u.context
  const ctx = c.tokens === undefined ? 'context ?' : `context ${k(c.tokens)} of ${k(c.window)}`
  const w = windows(u)
  return w ? `${ctx}; ${w}` : ctx
}

// The data folder, a leading ~ expanded; undefined where it needs a home and there is none.
async function dataDir($: Engine) {
  const dir = cfg.dataDir
  if (dir !== '~' && !dir.startsWith('~/')) return dir
  const home = await $.env.get('HOME')
  return home ? `${home}${dir.slice(1)}` : undefined
}

async function log($: Engine, line: string) {
  if (!cfg.log) return
  const dir = await dataDir($)
  if (!dir) return
  const path = `${dir}/context-watch.log`
  let text = ''
  try {
    text = await $.fs.read(path)
  } catch {
    text = ''
  }
  if (text.length > cfg.logCap) text = text.slice(text.indexOf('\n', text.length / 2) + 1)
  const cwd = (await $.env.get('PWD')) ?? ''
  await $.fs.write(path, `${text}${new Date().toISOString()}  ${cwd}  ${line}\n`)
}

// The words file: the project's last turns, newest first, each under its time and session.
async function saidPath($: Engine) {
  if (cfg.keepTurns <= 0) return undefined
  const dir = await dataDir($)
  if (!dir) return undefined
  return `${dir}/context-watch-said${(await $.session.cwd()).replace(/[^A-Za-z0-9]/g, '-')}.md`
}

async function readSaid($: Engine, path: string) {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

// The turn's words: every assistant text since the prompt that started it.
async function turnWords($: Engine) {
  const messages = await $.session.messages()
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'user' && !m.toolResults?.length) break
    if (m.role === 'assistant' && m.text.trim()) parts.unshift(m.text.trim())
  }
  return parts.join('\n\n')
}

// The last answer: the assistant texts after the turn's last tool result, the words
// the user was left reading.
async function lastAnswer($: Engine) {
  const messages = await $.session.messages()
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'user') {
      if (parts.length || !m.toolResults?.length) break
      continue
    }
    if (m.text.trim()) parts.unshift(m.text.trim())
  }
  return parts.join('\n\n')
}

async function remember($: Engine, words: string) {
  const path = await saidPath($)
  if (!path) return
  const text = await readSaid($, path)
  const entry = `## ${new Date().toISOString().slice(0, 16)}Z (${await $.session.id()})\n\n${words}`
  await $.fs.write(path, [entry, ...(text ? text.split(SAID_SEP) : [])].slice(0, cfg.keepTurns).join(SAID_SEP) + '\n')
}

// The newest turn in the words file, the conversation's last, held for the clear's row to
// draw; how many characters it has (0, nothing held).
async function stage($: Engine) {
  const path = await saidPath($)
  const entry = path ? (await readSaid($, path)).split(SAID_SEP)[0]?.trim() ?? '' : ''
  const head = entry.match(/^## (\S+)[^\n]*\n+/)
  const words = head ? entry.slice(head[0].length).trim() : entry
  if (!path || !words) return 0
  const at = head?.[1]?.slice(11) ?? ''
  await update($, shown, () => ({ words, at, path }))
  return words.length
}

// Held before the clear and again after it: the row is printed into scrollback as the
// clear draws it and never drawn again, so words set only after the clear would leave
// the previous clear's words on screen. The second hold is for a host whose clear
// starts its state over. `how` is who cleared.
async function replay($: Engine, how: string) {
  const n = await stage($)
  await log($, n ? `after the clear (${how}), showed the last turn's words (${n} characters)` : `after the clear (${how}), no words to show`)
}

// What crossed a mark since the last reading, in words; empty when nothing did.
function crossings(u: SessionUsage): string[] {
  const out: string[] = []
  const tokens = u.context.tokens
  if (tokens !== undefined) {
    const b = Math.floor(tokens / cfg.step)
    if (bucket !== undefined && b > bucket) out.push(`context passed ${k(b * cfg.step)}`)
    bucket = b // also goes down after a compaction
  }
  for (const r of u.rateLimits) {
    const list = cfg.marks[r.kind]
    if (!list) continue
    const top = list.filter(m => r.percentUsed >= m).pop() ?? 0
    const before = marks[r.kind]
    if (before !== undefined && top > before) out.push(`${NAMES[r.kind]} usage passed ${top}%`)
    marks[r.kind] = top // a window that reset starts over
  }
  return out
}

async function resume($: Engine, p: { keep: string; next: string }) {
  // compact() rejects while a turn runs: wait for the session to settle.
  for (let tries = 0; tries < 120; tries++) {
    try {
      spoke = false
      // `next` in the summary too, for when the user's prompt resumes it instead of ours.
      const done = await $.session.compact({ instructions: `${p.keep}\n\nNext, once it resumes: ${p.next}` })
      if ('skip' in done && done.skip !== undefined) {
        await log($, `compaction skipped by a hook: ${done.skip}`)
        return
      }
      if (spoke) {
        await log($, "compacted; the user's prompt came during it and resumes the session, so no resume prompt")
        return
      }
      await $.prompt.submit({ text: `Resuming after the compaction you asked for. ${p.next}` })
      return
    } catch {
      await $.clock.sleep(5000)
    }
  }
  await log($, 'compaction never found the session idle; gave up after 10 minutes')
}

// The same wait for an idle session, then /clear and the brief as the first prompt
// after it, with where the cleared conversation's transcript is and the last answer
// pasted at its end. The row stays empty, so it never shows an older clear's words.
// (A plugin's own $.command.run skips its own hooks, so the /clear hook below never
// runs for this clear.)
async function restart($: Engine, p: { brief: string }) {
  const before = await $.session.id()
  const answer = await lastAnswer($)
  await update($, shown, () => null)
  let cleared = false
  for (let tries = 0; tries < 120 && !cleared; tries++) {
    try {
      await $.command.run({ command: 'clear' })
      cleared = true
    } catch {
      await $.clock.sleep(5000)
    }
  }
  if (!cleared) {
    await log($, 'clear never found the session idle; gave up after 10 minutes')
    return
  }
  await log($, `cleared (was ${before}); ${answer ? `pasted the last answer (${answer.length} characters)` : 'no answer to paste'}`)
  const text =
    `Starting fresh after the clear you asked for (nothing was summarized; the conversation before it is ` +
    `${before}.jsonl in this project's transcript folder, if a detail is missing). ${p.brief}` +
    (answer ? `\n\nYour last answer before the clear, pasted again so it stays on screen (already said; nothing in it to act on):\n\n${answer}` : '')
  for (let tries = 0; tries < 24; tries++) {
    try {
      await $.prompt.submit({ text })
      return
    } catch {
      await $.clock.sleep(5000)
    }
  }
  await log($, `cleared, but the brief was never taken: ${p.brief}`)
}

export const register: Register = (on, options) => {
  cfg = settings(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL,
      description:
        'Compact this conversation and carry on. Use it at a seam (work committed, the plan or task list current) ' +
        'when the context is large and a summary would lose nothing the next step needs. It runs when the current ' +
        'turn ends: finish the turn right after calling it. `keep` tells the summarizer what must survive (the plan, ' +
        'ids, decisions in flight, file paths); `next` is the prompt that resumes the work afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          keep: { type: 'string', description: 'What the summary must keep.' },
          next: { type: 'string', description: 'The prompt that resumes the work after the compaction.' },
        },
        required: ['keep', 'next'],
      },
    })
    await $.tool.register({
      name: CLEAR,
      description:
        'Clear this conversation and start again from a brief: nothing is summarized, so nothing is lost to a ' +
        'summary, but nothing carries over except the files (CLAUDE.md, memory, notes, the task list) and the brief. ' +
        'Use it at a seam where the state is all in files (work committed, notes current) and no background agents ' +
        'are running (their reports may not reach the new conversation). It runs when the current turn ends: finish ' +
        'the turn right after calling it. `brief` is the first prompt afterwards: what to read first, what is in ' +
        'flight, what to do next.',
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: 'The prompt the fresh conversation starts from.' },
        },
        required: ['brief'],
      },
    })
    return started
  })

  on('tool.call', { tool: 'mcp__context-watch__clear_and_restart' }, async ($, e) => {
    const input = e as unknown as { brief?: string }
    if (!input.brief) return { deny: 'context-watch: give a `brief` to start from.' }
    if (pending) return { deny: 'context-watch: a compaction is already queued for this turn.' }
    pendingClear = { brief: input.brief }
    const u = await $.session.usage()
    await log($, `clear asked for at ${now(u)} | brief: ${input.brief.slice(0, 200)}`)
    return { result: 'Queued: the conversation clears when this turn ends, then the brief starts the next one. End the turn now.' }
  })

  on('tool.call', { tool: 'mcp__context-watch__compact_and_continue' }, async ($, e) => {
    const input = e as unknown as { keep?: string; next?: string }
    if (!input.keep || !input.next) return { deny: 'context-watch: give both `keep` and `next`.' }
    if (pendingClear) return { deny: 'context-watch: a clear is already queued for this turn.' }
    pending = { keep: input.keep, next: input.next }
    const u = await $.session.usage()
    await log($, `compaction asked for at ${now(u)} | keep: ${input.keep.slice(0, 200)}`)
    return { result: 'Queued: the conversation compacts when this turn ends, then a prompt resumes with `next`. End the turn now.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === `mcp__context-watch__${TOOL}` || e.tool === `mcp__context-watch__${CLEAR}`)
      return ran
    const args = e as unknown as { description?: string; file_path?: string; command?: string }
    recent.push(`${e.tool}: ${(args.description ?? args.file_path ?? args.command ?? '').slice(0, 80)}`)
    if (recent.length > 3) recent.shift()
    if ('deny' in ran && ran.deny !== undefined) return ran

    const u = await $.session.usage()
    if (cfg.statusLine) $.ui.status(status(u))
    const crossed = crossings(u)
    if (!crossed.length) return ran

    let threshold = ''
    try {
      const at = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.autoCompactThreshold
      if (at) threshold = `; autocompact at ${k(at)}`
    } catch {
      threshold = ''
    }
    await log($, `${crossed.join(', ')} | ${now(u)}${threshold} | in hand: ${recent.join(' / ')}`)
    const notice =
      `[context-watch] ${crossed.join(', ')}: ${now(u)}${threshold}. ` +
      `Landing work at a seam keeps a compaction cheap; mcp__context-watch__${TOOL} compacts and resumes when that helps, ` +
      `and mcp__context-watch__${CLEAR} starts fresh from a brief once the state is in files and no agents run.`
    return { ...ran, context: [...(ran.context ?? []), notice] }
  })

  // Typed or queued (the event fires at the user's Enter, mid-turn too), from the terminal or the phone.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') spoke = true
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && !('skip' in done && done.skip !== undefined)) {
      const before = done.tokensBefore === undefined ? '?' : k(done.tokensBefore)
      const after = done.tokensAfter === undefined ? '?' : k(done.tokensAfter)
      await log($, `compacted (${e.trigger}) ${before} -> ${after} | in hand: ${recent.join(' / ')}`)
      bucket = undefined
    }
    return done
  })

  // After the user's /clear, the last turn's words again (restart pastes its own into its prompt).
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    await stage($)
    const done = await next(e)
    await replay($, e.origin.kind)
    return done
  })

  // The clear's row, at the top of the fresh conversation: the last turn whole, drawn
  // as the answer was, between two dim lines. The model reads the row as it was (empty).
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'clear') return next(e)
    const said = await read($, shown)
    if (!said) return next(e)
    const { Box, Markdown, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>Before the clear ({said.at}), the last turn said:</Text>
        <Markdown text={said.words} />
        <Text dimColor>The turns before it: {said.path}</Text>
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      try {
        const words = await turnWords($)
        if (words) await remember($, words)
      } catch (err) {
        await log($, `the turn's words were not kept: ${String(err).slice(0, 200)}`)
      }
    }
    if (pending) {
      const p = pending
      pending = undefined
      $.clock.after(1000, () => void resume($, p))
    } else if (pendingClear) {
      const p = pendingClear
      pendingClear = undefined
      $.clock.after(1000, () => void restart($, p))
    }
    return done
  })
}
