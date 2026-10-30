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
// - A prompt that comes while a compaction runs (the user's, a background task's
//   report, another session's message) resumes the session by itself, so the
//   resume prompt is skipped (it would run as a second "carry on"), and `next`
//   rides in the summary's instructions so nothing is lost.
// - A prompt the user sends before a queued clear runs drops the clear: they are
//   reading and working in that conversation.
//
// A usage limit (/context-watch limitweek, limit5h) holds in the window that set it,
// and reaching it tells the model to land what is in flight and stop. It never
// clears the conversation.
//
// A night (/context-watch night 96% until 09:30, or the night tool the model calls when
// the user names a cap) runs the session on to a line on the week meter: a turn of the
// main loop that ends under it is resumed by a carry-on prompt two minutes on, or at the
// 5-hour window's reset when that is spent. The user's prompt ends it, as do its line, its
// stop time and the week's reset. A turn that ends waiting on the user ("Needs you:") or
// finding nothing ready pauses it until the next prompt; so does a resumed turn that makes
// no tool call, and the eighth resume in an hour.
//
// A suggested clear (clearAt) adds a notice when the context passes it. The
// /context-watch command shows the settings and changes them: each one for good
// (the rows /config shows), or the suggested clear for the current context alone,
// until the next clear or compaction.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionUsage, Timer } from 'claude-code'

import type { Epoch, Limit, Limits, Night, Shown } from '../types'

type Engine = EngineInterface

const NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
const TOOL = 'compact_and_continue'
const CLEAR = 'clear_and_restart'
const NIGHT = 'night'
// The mod's own tools: no tool call of the work, so neither counted nor noticed.
const OWN = new Set([TOOL, CLEAR, NIGHT].map(n => `mcp__context-watch__${n}`))
const SAID_SEP = '\n\n<!-- turn -->\n\n'

// The options, from the manifest's userConfig (see the README); defaults filled in.
type Settings = {
  step: number // a notice at every multiple of this many tokens of context
  clearAt: number // the suggested clear, in tokens of context; 0, none
  marks: Record<string, number[]> // usage percentages per window, ascending
  resumeNote: string // put into every resume prompt, before the model's own words
  statusLine: boolean
  dataDir: string // the log and the words files; a leading ~ is HOME
  log: boolean
  logCap: number // bytes; past it the log keeps its newer half
  keepTurns: number // turns the words file keeps; 0, none
}

const DEFAULTS: Settings = {
  step: 100_000,
  clearAt: 0,
  marks: { five_hour: [50, 80, 95], seven_day: [50, 75, 90] },
  resumeNote: '',
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
    clearAt: num(o.clearAt, DEFAULTS.clearAt, 0),
    marks: {
      five_hour: percents(o.fiveHourMarks, DEFAULTS.marks.five_hour ?? []),
      seven_day: percents(o.weeklyMarks, DEFAULTS.marks.seven_day ?? []),
    },
    resumeNote: typeof o.resumeNote === 'string' ? o.resumeNote.trim() : DEFAULTS.resumeNote,
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
// The current context's own suggested clear: $.state too, as a change of a setting reloads the mod.
const epoch = atom({ plugin: 'context-watch', key: 'epoch' } as const, null)

// Module variables start over on a reload; the first reading after one is taken
// silently, so a reload never repeats a notice.
let bucket: number | undefined
let lastTokens: number | undefined
const marks: Record<string, number> = {}
const recent: string[] = []
let pending: { keep: string; next: string } | undefined
let pendingClear: { brief: string } | undefined
// Each meter's last reading against its limit, and the limits this context was told it is past.
const seen: Record<string, number> = {}
const told = new Set<string>()
// Words for the model at its next tool call: a queued clear the user's prompt dropped.
const notes: string[] = []
// From the end of the turn that queued a compaction or clear until its resume prompt is sent: a
// reload then would drop it, so /context-watch changes no setting meanwhile.
let running = false
// A prompt came while a compaction ran, from where (the user, a task's notice, a peer): its
// turn resumes the session, so the resume prompt is not sent (it would run as a second
// "carry on" after that turn). The mod's own prompts never reach its own hook.
let resumedBy: string | undefined
// The user's own prompt came after a clear was queued: they are reading and working in
// this conversation, so the clear is dropped. A notice or a peer's message is not them.
let spoke = false

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
// A time (ISO, or milliseconds) as HH:MMZ.
const clock = (at?: string | number) => (at ? new Date(at).toISOString().slice(11, 16) + 'Z' : '?')

function windows(u: SessionUsage, lim: Limits = {}, resets = true) {
  return u.rateLimits
    .filter(r => NAMES[r.kind])
    .map(r => {
      const l = lim[r.kind]
      const ceiling = l ? [l.night ? `night to ${l.percent}%` : `limit ${l.percent}%`] : []
      const notes = [...ceiling, ...(resets ? [`resets ${clock(r.resetsAt)}`] : [])]
      return `${NAMES[r.kind]} ${r.percentUsed}%${notes.length ? ` (${notes.join('; ')})` : ''}`
    })
    .join(', ')
}

// The suggested clear in force: the current context's own, else the setting's (0, none).
type Target = { at: number; own: boolean }

async function target($: Engine): Promise<Target> {
  const own = await read($, epoch)
  if (own && own.session === (await $.session.id())) return { at: own.clearAt, own: true }
  return { at: cfg.clearAt, own: false }
}

// The status line: no reset times but the 5-hour window's, last, in local time.
function status(u: SessionUsage, t: Target, lim: Limits = {}) {
  const line = now(u, t, lim, false)
  const at = u.rateLimits.find(r => r.kind === 'five_hour')?.resetsAt
  if (!at) return line
  const d = new Date(at)
  return `${line}; resets ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function now(u: SessionUsage, t?: Target, lim: Limits = {}, resets = true) {
  const c = u.context
  let ctx = c.tokens === undefined ? 'context ?' : `context ${k(c.tokens)} of ${k(c.window)}`
  if (t?.at) ctx += `, clear at ${k(t.at)}${t.own ? ' (this context)' : ''}`
  const w = windows(u, lim, resets)
  return w ? `${ctx}; ${w}` : ctx
}

// The usage limits /context-watch limitweek and limit5h set, by meter: in $.state, so each holds in
// the window that set it alone (through its clears too), until its meter's window resets.
const LIMITS: Record<string, string> = { limitweek: 'seven_day', limit5h: 'five_hour' }
const limitCommand = (kind: string) => Object.keys(LIMITS).find(n => LIMITS[n] === kind) ?? kind
const held = atom({ plugin: 'context-watch', key: 'limits' } as const, null)

async function limits($: Engine): Promise<Limits> {
  const all = (await read($, held)) ?? {}
  const t = await $.clock.now()
  return Object.fromEntries(Object.entries(all).filter(([, l]) => !l.until || Date.parse(l.until) > t))
}

// The ceilings in force: the limits, and the night's line as the week's when it is lower than the
// week limit, or there is none. It is flagged night, and gone once the week's window has reset.
async function ceilings($: Engine): Promise<Limits> {
  const lim = await limits($)
  const n = await read($, night)
  if (!n || (n.weekResets && Date.parse(n.weekResets) <= (await $.clock.now()))) return lim
  if (lim.seven_day && lim.seven_day.percent <= n.line) return lim
  return { ...lim, seven_day: { percent: n.line, ...(n.weekResets ? { until: n.weekResets } : {}), night: true } }
}

// What the model is told of a limit reached: land, say where things stand, start nothing new.
// `noun` is what the user raises: a limit, or the night's line.
const stopWords = (name: string, cmd: string, how: string, noun = 'limit') =>
  `[context-watch] ${name} usage ${how} (/context-watch ${cmd}): land what is in flight (commit, notes), say in a ` +
  "few lines where things stand and what waits, and start nothing new on this plan's usage. The conversation stays " +
  `as it is; the user raises the ${noun} with /context-watch ${cmd} +N, or off.`

// A ceiling reached (a limit, or the night's line), crossed since the last reading or already past
// when the context began: a word to the model, once a context. It never clears: the user may be
// reading the conversation.
function limitWords(u: SessionUsage, lim: Limits): string[] {
  const out: string[] = []
  for (const r of u.rateLimits) {
    const before = seen[r.kind]
    seen[r.kind] = r.percentUsed
    const l = lim[r.kind]
    if (!l || r.percentUsed < l.percent || told.has(r.kind)) continue
    told.add(r.kind)
    const crossed = before !== undefined && before < l.percent
    const what = l.night ? "the night's line" : 'its limit'
    const how = crossed ? `reached ${what}, ${l.percent}%` : `${r.percentUsed}% is past ${what}, ${l.percent}%`
    out.push(stopWords(NAMES[r.kind] ?? r.kind, l.night ? NIGHT : limitCommand(r.kind), how, l.night ? 'line' : 'limit'))
  }
  return out
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
function crossings(u: SessionUsage, t: Target): string[] {
  const out: string[] = []
  const tokens = u.context.tokens
  if (tokens !== undefined) {
    const b = Math.floor(tokens / cfg.step)
    if (bucket !== undefined && b > bucket) out.push(`context passed ${k(b * cfg.step)}`)
    bucket = b // also goes down after a compaction
    if (t.at && lastTokens !== undefined && lastTokens < t.at && tokens >= t.at)
      out.push(`context passed ${k(t.at)}, the suggested clear${t.own ? ' for this context' : ''}: land the work in files, then clear`)
    lastTokens = tokens
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

// The resume note, set off from what follows it; empty when none is set.
const note = () => (cfg.resumeNote ? `${cfg.resumeNote} ` : '')

// A clear or a compaction starts a new context, back on the setting's suggested clear.
async function newContext($: Engine) {
  bucket = undefined
  lastTokens = undefined
  told.clear()
  await update($, epoch, () => null)
}

async function resume($: Engine, p: { keep: string; next: string }) {
  try {
    await compactAndResume($, p)
  } finally {
    running = false
  }
}

async function compactAndResume($: Engine, p: { keep: string; next: string }) {
  // compact() rejects while a turn runs: wait for the session to settle.
  for (let tries = 0; tries < 120; tries++) {
    try {
      resumedBy = undefined
      // `next` in the summary too, for when another prompt resumes it instead of ours.
      const done = await $.session.compact({ instructions: `${p.keep}\n\nNext, once it resumes: ${p.next}` })
      if ('skip' in done && done.skip !== undefined) {
        await log($, `compaction skipped by a hook: ${done.skip}`)
        return
      }
      // A plugin's own $.session.compact skips its own hooks, the session.compact one below too.
      await newContext($)
      // Checked last, just before the submit: nothing may come between.
      if (resumedBy) {
        await log($, `compacted; a prompt (${resumedBy}) came during it and resumes the session, so no resume prompt`)
        return
      }
      await $.prompt.submit({ text: `Resuming after the compaction you asked for. ${note()}${p.next}` })
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
// A prompt from the user while it waits drops the clear. (A plugin's own
// $.command.run skips its own hooks, so the /clear hook below never runs for this clear.)
async function restart($: Engine, p: { brief: string }) {
  try {
    await clearAndBrief($, p)
  } finally {
    running = false
  }
}

async function clearAndBrief($: Engine, p: { brief: string }) {
  const before = await $.session.id()
  await update($, shown, () => null)
  let answer = ''
  let cleared = false
  for (let tries = 0; tries < 120 && !cleared; tries++) {
    if (spoke) {
      notes.push(
        '[context-watch] The clear queued at the end of a turn was dropped: the user spoke before it ran. ' +
          'Call clear_and_restart again at the next seam if it is still wanted.',
      )
      await log($, "the queued clear was dropped: the user's prompt came first")
      return
    }
    // Read at each try, so it is the answer on screen when the clear runs.
    answer = await lastAnswer($)
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
  await newContext($)
  await log($, `cleared (was ${before}); ${answer ? `pasted the last answer (${answer.length} characters)` : 'no answer to paste'}`)
  const text =
    'Starting fresh after the clear you asked for (nothing was summarized; the conversation before it is ' +
    `${before}.jsonl in this project's transcript folder, if a detail is missing). ${note()}${p.brief}` +
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

// The settings /context-watch shows and changes, by a short name, each a userConfig field
// (the /config row `context-watch.<key>`); `epoch` (below) is the current context's alone.
type Kind = 'tokens' | 'marks' | 'flag' | 'count' | 'text'
type Field = { name: string; key: string; kind: Kind; min: number; what: string; show: (s: Settings) => string }

const onOff = (b: boolean) => (b ? 'on' : 'off')
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const FIELDS: Field[] = [
  { name: 'target', key: 'clearAt', kind: 'tokens', min: 0, what: 'the suggested clear, every context', show: s => (s.clearAt ? k(s.clearAt) : 'off') },
  { name: 'step', key: 'contextStep', kind: 'tokens', min: 1, what: 'a notice at every multiple', show: s => k(s.step) },
  { name: '5h', key: 'fiveHourMarks', kind: 'marks', min: 0, what: '5-hour usage marks (%)', show: s => s.marks.five_hour?.join(',') || 'none' },
  { name: 'week', key: 'weeklyMarks', kind: 'marks', min: 0, what: 'weekly usage marks (%)', show: s => s.marks.seven_day?.join(',') || 'none' },
  { name: 'resume', key: 'resumeNote', kind: 'text', min: 0, what: 'put into every resume prompt', show: s => (s.resumeNote ? `"${cut(s.resumeNote, 14)}"` : 'none') },
  { name: 'status', key: 'statusLine', kind: 'flag', min: 0, what: 'the status line', show: s => onOff(s.statusLine) },
  { name: 'log', key: 'log', kind: 'flag', min: 0, what: 'context-watch.log in the data folder', show: s => onOff(s.log) },
  { name: 'logcap', key: 'logMaxBytes', kind: 'count', min: 1000, what: 'bytes the log keeps', show: s => String(s.logCap) },
  { name: 'turns', key: 'keepTurns', kind: 'count', min: 0, what: 'turns kept to show after a /clear', show: s => String(s.keepTurns) },
  { name: 'data', key: 'dataDir', kind: 'text', min: 0, what: 'where the log and the turns go', show: s => s.dataDir },
]

const HOW =
  'Change one: /context-watch <name> <value>, as `target 300k`, `epoch 400k`, `epoch +50k`, `epoch reset`, ' +
  '`limitweek 44%`, `limitweek +14%`, `night 96% until 09:30`, `5h 50,90`, `status off`, `resume none`. ' +
  'The settings are /config rows too.'

// "250k", "1.5m", "250000"; "off", "none" or "0" is 0; "+50k" or "-50k" from `from`. Undefined: no number.
function tokens(s: string, from: number): number | undefined {
  const t = s.toLowerCase().replace(/[_,]/g, '')
  if (t === 'off' || t === 'none') return 0
  const m = t.match(/^([+-]?)(\d+(?:\.\d+)?)([km]?)$/)
  if (!m) return undefined
  const n = Math.round(Number(m[2]) * (m[3] === 'k' ? 1000 : m[3] === 'm' ? 1_000_000 : 1))
  return m[1] === '+' ? from + n : m[1] === '-' ? Math.max(0, from - n) : n
}

// The value a field's /config row takes, from what was typed; a string says why it can't be one.
function parse(f: Field, raw: string): { value: string | number | boolean } | string {
  const lower = raw.toLowerCase()
  if (f.kind === 'tokens' || f.kind === 'count') {
    const n = f.kind === 'tokens' ? tokens(raw, f.key === 'clearAt' ? cfg.clearAt : cfg.step) : /^\d+$/.test(raw) ? Number(raw) : undefined
    if (n === undefined) return `${f.name} takes a number${f.kind === 'tokens' ? ' of tokens, as 300k' : ''}.`
    if (n < f.min) return `${f.name} is at least ${f.min}.`
    return { value: n }
  }
  if (f.kind === 'flag') {
    if (['on', 'true', 'yes'].includes(lower)) return { value: true }
    if (['off', 'false', 'no'].includes(lower)) return { value: false }
    return `${f.name} is on or off.`
  }
  if (f.kind === 'marks') {
    if (lower === 'none' || lower === 'off') return { value: '' }
    const list = percents(raw, [])
    if (!list.length || list.length !== raw.split(',').filter(s => s.trim()).length)
      return `${f.name} takes percentages from 1 to 100, as 50,80,95, or none.`
    return { value: list.join(',') }
  }
  const text = raw.replace(/^(["'])(.*)\1$/s, '$2').trim()
  return { value: lower === 'none' || lower === 'off' ? '' : text }
}

async function overview($: Engine) {
  const u = await $.session.usage()
  const t = await target($)
  const lim = await limits($)
  const n = await read($, night)
  const row = (f: Field) => [f.name, f.show(cfg), f.what] as [string, string, string]
  const rows: [string, string, string][] = [
    ...FIELDS.slice(0, 1).map(row),
    ['epoch', t.own ? (t.at ? k(t.at) : 'off') : "the target's", "this context's own, until the next clear or compaction"],
    ...FIELDS.slice(1, 4).map(row),
    ['limitweek', showLimit(lim.seven_day), 'stops new work once the week meter reaches it, in this window'],
    ['limit5h', showLimit(lim.five_hour), 'stops new work once the 5-hour meter reaches it, in this window'],
    ['night', nightLine(n), nightState(n)],
    ...FIELDS.slice(4).map(row),
  ]
  const w = Math.min(16, Math.max(...rows.map(r => r[1].length)))
  return [now(u, t, await ceilings($)), ...rows.map(([n, v, what]) => `  ${n.padEnd(10)}${v.padEnd(w)}  ${what}`), HOW].join('\n')
}

const showLimit = (l?: Limit) => (l ? `${l.percent}%${l.until ? ` to ${l.until.slice(5, 16).replace('T', ' ')}Z` : ''}` : 'off')

// /context-watch limitweek 44% (or +14%, from the meter's reading now, or off): once a reading reaches
// it, the model is told to land and stop, in this window alone, until the meter's window resets.
async function limit($: Engine, cmd: string, kind: string, raw: string): Promise<{ text: string; context?: string[] }> {
  const all = await limits($)
  const r = (await $.session.usage()).rateLimits.find(x => x.kind === kind)
  const name = NAMES[kind] ?? kind
  if (!raw) return { text: `${cmd}: ${showLimit(all[kind])}${r ? `; the ${name} meter reads ${r.percentUsed}%` : ''}.` }
  told.delete(kind)
  if (['off', 'none'].includes(raw.toLowerCase())) {
    delete all[kind]
    await update($, held, () => all)
    return { text: `${cmd}: off.`, context: [`[context-watch] The user took the ${name} usage limit off: carry on.`] }
  }
  const m = raw.match(/^(\+?)(\d+(?:\.\d+)?)%?$/)
  if (!m) return { text: `${cmd} takes a percentage of the ${name} meter: 44%, +14% (from its reading now), or off.` }
  if (m[1] && !r) return { text: `No ${name} meter to count from on this plan.` }
  const percent = Math.round((m[1] ? (r?.percentUsed ?? 0) : 0) + Number(m[2]))
  if (percent < 1 || percent > 100) return { text: `${cmd} is between 1% and 100%.` }
  all[kind] = { percent, ...(r?.resetsAt ? { until: r.resetsAt } : {}) }
  await update($, held, () => all)
  if (r) seen[kind] = r.percentUsed
  const past = r !== undefined && r.percentUsed >= percent
  if (past) told.add(kind)
  await log($, `/context-watch ${cmd} ${raw}: ${showLimit(all[kind])}, the meter at ${r?.percentUsed ?? '?'}%`)
  return {
    text: past
      ? `${cmd}: ${percent}%, reached already (${r.percentUsed}%): the model is told to land what is in flight and start nothing new.`
      : `${cmd}: ${showLimit(all[kind])}, the meter at ${r?.percentUsed ?? '?'}%: once a reading reaches it, the model is told to land and stop, in this window alone.`,
    context: past
      ? [stopWords(name, cmd, `${r.percentUsed}% is past the limit the user just set, ${percent}%`)]
      : [`[context-watch] The user set a ${name} usage limit of ${percent}% for this window, until the meter's window resets.`],
  }
}

// The night: in $.state, so a reload keeps it and finds its resume armed (wakeAt).
const night = atom({ plugin: 'context-watch', key: 'night' } as const, null)
const MIN = 60_000
const RESUME_AFTER = 2 * MIN // a turn that ended under the line
const RETRY_AFTER = 10 * MIN // after an error, or a spent 5-hour window with no reset time
const PAST_RESET = 2 * MIN // a spent 5-hour window: this long after its reset
const RESUMES_AN_HOUR = 8 // this many in the last hour pause the night: a loop
const CARRY_ON = 'Carrying on the night'
// A turn's answer that waits on the user or finds nothing ready: a line that starts with either.
const WAITS = /^[\s>*_#-]*(needs you|nothing ready)\b/im
const NIGHT_HOW =
  'night takes a line on the week meter, and a stop time if wanted: /context-watch night 96% until 09:30 (local), ' +
  '`night 96% for 8h`, `night +3%` (from the meter now), or `night off`.'

// The armed resume; a carry-on sent whose turn has not started; whether the running turn is a
// carry-on's; the main loop's tool calls this turn (the mod's own not counted); a main-loop turn
// running (the command arms a resume only when the session is idle).
let wake: Timer | undefined
let sentResume = false
let nightTurn = false
let calls = 0
let turnRunning = false
// The words for the user's next prompt when the user's Esc ended the night; an agent's hold of the
// resume, logged once.
let endedNote: string | undefined
let heldByAgents = false

const hourAgo = (t: number) => (r: string) => Date.parse(r) > t - 60 * MIN

// Why the night is over at `t`, or undefined: the week's window reset, its stop time, or the week
// meter at its line (or at a lower week limit). No week reading: not over.
function over(n: Night, u: SessionUsage, lim: Limits, t: number): string | undefined {
  if (n.weekResets && Date.parse(n.weekResets) <= t) return "the week's window reset"
  if (n.until && Date.parse(n.until) <= t) return `its stop time, ${clock(n.until)}`
  const week = u.rateLimits.find(r => r.kind === 'seven_day')
  const line = lim.seven_day?.percent ?? n.line
  if (week && week.percentUsed >= line) return `the week meter at ${week.percentUsed}%, its line ${line}%`
  return undefined
}

// The prompt that resumes the session: where the meters stand, the user's words, what to do, and
// how to stop.
function carryOn(n: Night, u: SessionUsage, lim: Limits) {
  const at = (kind: string) => u.rateLimits.find(r => r.kind === kind)?.percentUsed
  const five = at('five_hour')
  return (
    `${CARRY_ON} (context-watch): the week meter at ${at('seven_day') ?? '?'}% of its line, ${lim.seven_day?.percent ?? n.line}%` +
    `${five === undefined ? '' : `, the 5-hour window at ${five}%`}${n.until ? `, until ${clock(n.until)}` : ''}. ` +
    `Set from the user's words: ${n.words} ${note()}${n.next}\n\n` +
    'When nothing is ready, or what is left waits on the user, end the turn with a line that starts `Needs you:` or ' +
    '`Nothing ready:`; the night then pauses until the next prompt.'
  )
}

// What the model reads beside the user's prompt after the night ended: what it was, and how to
// set it again.
const endedWords = (n: Night, how: string) =>
  `[context-watch] ${how} (to ${n.line}% of the week${n.until ? `, until ${clock(n.until)}` : ''}), set from: ` +
  `${n.words}. If the words of the prompt carry the night on, set it again with mcp__context-watch__${NIGHT}.`

function disarm() {
  wake?.cancel()
  wake = undefined
}

// The timer alone, one at a time.
async function schedule($: Engine, at: number) {
  const wait = Math.max(0, at - (await $.clock.now()))
  disarm()
  wake = $.clock.after(wait, () => void wakeUp($))
}

// The resume at `at`: written to the night first, so a reload finds it, then the timer.
async function arm($: Engine, at: number) {
  await update($, night, n => n && { ...n, wakeAt: new Date(at).toISOString() })
  await schedule($, at)
}

async function endNight($: Engine, why: string) {
  disarm()
  await update($, night, () => null)
  await log($, `the night ended: ${why}`)
}

async function pause($: Engine, why: string) {
  disarm()
  await update($, night, n => n && { ...n, paused: why, wakeAt: null })
  await log($, `the night paused: ${why}`)
}

// An agent the model or the user started, still at work: its report will start a turn of its own.
// A plugin's agents (spawnedBy) don't count.
async function agentsAtWork($: Engine) {
  try {
    return (await $.agent.list()).some(a => !a.spawnedBy && ['pending', 'running', 'waiting'].includes(a.status))
  } catch {
    return false
  }
}

// The armed resume comes due: the carry-on, unless the night is over or paused, or the session is
// busy (that turn's end arms the next). While an agent is at work, it looks again in 2 minutes.
async function wakeUp($: Engine) {
  wake = undefined
  const n = await read($, night)
  if (!n || n.paused || running || pending || pendingClear || turnRunning) return
  const t = await $.clock.now()
  const u = await $.session.usage()
  const lim = await ceilings($)
  const done = over(n, u, lim, t)
  if (done) return endNight($, done)
  if (await agentsAtWork($)) {
    if (!heldByAgents) await log($, 'the night holds its resume while an agent is at work, and looks again every 2 minutes')
    heldByAgents = true
    return arm($, t + RESUME_AFTER)
  }
  heldByAgents = false
  const resumes = [...n.resumes.filter(hourAgo(t)), new Date(t).toISOString()]
  await update($, night, cur => cur && { ...cur, resumes, wakeAt: null })
  sentResume = true
  await log($, `the night resumed the session (${resumes.length} in the last hour) | ${now(u, undefined, lim)}`)
  try {
    await $.prompt.submit({ text: carryOn(n, u, lim) })
  } catch (err) {
    sentResume = false
    await log($, `the night's carry-on was not taken (${String(err).slice(0, 120)}); trying again in 10 minutes`)
    await arm($, t + RETRY_AFTER)
  }
}

// A main-loop turn ended with a night on (`resumed`: a carry-on's turn; `made`: its tool calls).
// The night ends, pauses, or arms its next resume, in this order.
async function afterTurn($: Engine, e: { reason: string; answer: string }, resumed: boolean, made: number) {
  const n = await read($, night)
  if (!n || running) return
  if (e.reason === 'aborted') {
    endedNote = endedWords(n, 'The user interrupted a turn, which ended the night')
    return endNight($, 'the user interrupted the turn')
  }
  if (n.paused) return
  const t = await $.clock.now()
  const u = await $.session.usage()
  const lim = await ceilings($)
  const done = over(n, u, lim, t)
  if (done) return endNight($, done)
  if (e.reason === 'refusal') return pause($, 'the turn ended in a refusal')
  const waits = e.answer.match(WAITS)
  if (waits) return pause($, `the turn ended with "${waits[1]}"`)
  if (resumed && !made && e.reason === 'answer') return pause($, 'the resumed turn made no tool call')
  const lastHour = n.resumes.filter(hourAgo(t)).length
  if (lastHour >= RESUMES_AN_HOUR) return pause($, `${lastHour} resumes in the last hour`)
  // An error near the 5-hour limit is most likely the limit itself.
  const five = u.rateLimits.find(r => r.kind === 'five_hour')
  let at = t + (e.reason === 'error' ? RETRY_AFTER : RESUME_AFTER)
  let why = e.reason === 'error' ? 'the turn ended on an error' : 'the turn ended under the line'
  if (five && (five.percentUsed >= Math.min(100, lim.five_hour?.percent ?? 100) || (e.reason === 'error' && five.percentUsed >= 90))) {
    at = five.resetsAt ? Date.parse(five.resetsAt) + PAST_RESET : t + RETRY_AFTER
    why = `the 5-hour window is spent (${five.percentUsed}%)`
  }
  if (n.until && at >= Date.parse(n.until)) return endNight($, `its next resume would come after its stop time, ${clock(n.until)}`)
  if (n.weekResets && at >= Date.parse(n.weekResets))
    return endNight($, `its next resume would come after the week's window resets, ${clock(n.weekResets)}`)
  await arm($, at)
  await log($, `the night waits: ${why}; resuming at ${clock(at)}`)
}

// A stop time, in milliseconds: 09:30 (local, the next one), +8h or +90m from `t`, or an ISO time
// (with a T). Undefined: none of these.
function stopTime(raw: string, t: number): number | undefined {
  const s = raw.trim().toLowerCase()
  const hm = s.match(/^(\d{1,2}):(\d{2})$/)
  if (hm) {
    const [h, m] = [Number(hm[1]), Number(hm[2])]
    if (h > 23 || m > 59) return undefined
    const d = new Date(t)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= t) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const rel = s.match(/^\+?(\d+(?:\.\d+)?)\s*(h|m|min)$/)
  if (rel) return t + Number(rel[1]) * (rel[2] === 'h' ? 60 * MIN : MIN)
  if (!s.includes('t')) return undefined
  const at = Date.parse(raw.trim())
  return Number.isNaN(at) ? undefined : at
}

// Sets the night (the tool and the command). Refused, with why: no week meter, a line out of range
// or already reached (or a lower week limit reached), a stop time unreadable or past. The last
// hour's resumes carry over, so setting it again never lifts the cap on them.
async function setNight($: Engine, o: { line: number; until?: string; words: string; next: string }): Promise<{ text: string } | { refused: string }> {
  const u = await $.session.usage()
  const week = u.rateLimits.find(r => r.kind === 'seven_day')
  if (!week) return { refused: 'no week meter to run to on this plan.' }
  const line = Math.round(o.line)
  if (!(line >= 1 && line <= 100)) return { refused: 'the line is a percentage of the week meter, from 1 to 100.' }
  const lim = await limits($)
  const below = lim.seven_day && lim.seven_day.percent < line ? lim.seven_day.percent : undefined
  const ceiling = below ?? line
  if (week.percentUsed >= ceiling)
    return { refused: `the week meter is at ${week.percentUsed}% already, at or past ${ceiling}%${below === undefined ? '' : ", this window's week limit"}.` }
  const t = await $.clock.now()
  let until: string | null = null
  if (o.until) {
    const at = stopTime(o.until, t)
    if (at === undefined) return { refused: `"${o.until}" is no stop time: 09:30 (local), +8h, +90m, or an ISO time.` }
    if (at <= t) return { refused: `its stop time, ${clock(at)}, has passed.` }
    until = new Date(at).toISOString()
  }
  disarm()
  heldByAgents = false
  await update($, night, before => ({
    line,
    until,
    weekResets: week.resetsAt ?? null,
    words: o.words,
    next: o.next,
    set: new Date(t).toISOString(),
    resumes: (before?.resumes ?? []).filter(hourAgo(t)),
    paused: null,
    wakeAt: null,
  }))
  told.delete('seven_day')
  seen.seven_day = week.percentUsed
  const to = `to ${line}% of the week (the meter at ${week.percentUsed}%)${until ? `, until ${clock(until)}` : ''}`
  await log($, `the night set: ${to} | from: ${o.words.slice(0, 200)}`)
  return {
    text:
      `The night runs ${to}${below === undefined ? '' : `; this window's week limit, ${below}%, holds below it`}. A turn ` +
      "that ends under it is resumed after 2 minutes, at the 5-hour window's reset when that is spent. The user's prompt " +
      'ends it; a turn that ends with a line starting `Needs you:` or `Nothing ready:` pauses it until the next prompt.',
  }
}

const nightLine = (n: Night | null) => (n ? `${n.line}%${n.until ? ` to ${clock(n.until)}` : ''}` : 'off')
const nightState = (n: Night | null) =>
  !n
    ? 'runs the session on to a line on the week meter'
    : n.paused
      ? `paused: ${n.paused}, until the next prompt`
      : n.wakeAt
        ? `resumes at ${clock(n.wakeAt)}`
        : 'resumes a turn that ends under it'

// /context-watch night: the night whole; `night 96% [until 09:30 | for 8h]`, `night +3%` or
// `night off` sets or ends it. Set while the session is idle, it arms a resume: the night starts
// by itself.
async function nightCommand($: Engine, raw: string): Promise<{ text: string; context?: string[] }> {
  const n = await read($, night)
  const u = await $.session.usage()
  const week = u.rateLimits.find(r => r.kind === 'seven_day')
  if (!raw) {
    if (!n) return { text: `night: off${week ? `; the week meter reads ${week.percentUsed}%` : ''}.` }
    const t = await $.clock.now()
    const line = (await ceilings($)).seven_day?.percent ?? n.line
    return {
      text: [
        `night: ${nightLine(n)}, the week meter at ${week?.percentUsed ?? '?'}%` +
          `${line < n.line ? ` (this window's week limit, ${line}%, holds below it)` : ''}; ${nightState(n)}.`,
        `  set from: ${n.words}`,
        `  each resume: ${n.next}`,
        `  resumes in the last hour: ${n.resumes.filter(hourAgo(t)).length} of at most ${RESUMES_AN_HOUR}`,
      ].join('\n'),
    }
  }
  if (['off', 'none'].includes(raw.toLowerCase())) {
    if (!n) return { text: 'night: off.' }
    await endNight($, 'the user set it off')
    return { text: 'night: off.', context: ['[context-watch] The user ended the night: no turn is resumed.'] }
  }
  const m = raw.match(/^(\+?)(\d+(?:\.\d+)?)%?(?:\s+until\s+(\S+)|\s+for\s+(\S+))?$/i)
  if (!m) return { text: NIGHT_HOW }
  if (m[1] && !week) return { text: 'night: no week meter to count from on this plan.' }
  const t = await $.clock.now()
  const set = await setNight($, {
    line: (m[1] ? (week?.percentUsed ?? 0) : 0) + Number(m[2]),
    until: m[3] ?? (m[4] ? `+${m[4].replace(/^\+/, '')}` : undefined),
    words: `/context-watch night ${raw}, typed at ${clock(t)}`,
    next: 'Carry on with the next piece of work.',
  })
  if ('refused' in set) return { text: `night: ${set.refused}` }
  if (!turnRunning) await arm($, t + RESUME_AFTER)
  return { text: set.text, context: [`[context-watch] The user set a night: ${set.text}`] }
}

// /context-watch: the settings; `/context-watch <name> <value>` changes one.
async function command($: Engine, args: string): Promise<{ text: string; context?: string[] }> {
  const name = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const raw = args.trim().slice(name.length).trim()
  if (!name) return { text: await overview($) }
  const kind = LIMITS[name]
  if (kind) return limit($, name, kind, raw)
  if (name === NIGHT) return nightCommand($, raw)

  if (name === 'epoch') {
    const before = await target($)
    if (!raw) return { text: `epoch: ${before.own ? (before.at ? k(before.at) : 'off') : `the target's (${before.at ? k(before.at) : 'off'})`}. ${HOW}` }
    let text: string
    if (raw.toLowerCase() === 'reset') {
      await update($, epoch, () => null)
      text = `This context's suggested clear is the target's again: ${cfg.clearAt ? k(cfg.clearAt) : 'off'}.`
    } else {
      const n = tokens(raw, before.at)
      if (n === undefined) return { text: `epoch takes a number of tokens (300k, +50k, off) or reset.` }
      const session = await $.session.id()
      await update($, epoch, (): Epoch => ({ clearAt: n, session }))
      text = `This context's suggested clear: ${n ? k(n) : 'off'}, until the next clear or compaction (the target stays ${cfg.clearAt ? k(cfg.clearAt) : 'off'}).`
    }
    const u = await $.session.usage()
    const t = await target($)
    lastTokens = u.context.tokens
    if (cfg.statusLine) $.ui.status(status(u, t))
    await log($, `/context-watch epoch ${raw}: ${now(u, t)}`)
    return { text, context: [`[context-watch] The user set this context's suggested clear: ${now(u, t)}.`] }
  }

  const f = FIELDS.find(x => x.name === name || x.key.toLowerCase() === name)
  if (!f) return { text: `context-watch has no setting "${name}". ${HOW}` }
  if (!raw) return { text: `${f.name}: ${f.show(cfg)} (${f.what}).` }
  if (pending || pendingClear || running)
    return { text: 'A clear or compaction is on its way, and a change of a setting would reload the mod and drop it: change it after.' }
  const parsed = parse(f, raw)
  if (typeof parsed === 'string') return { text: parsed }
  const done = await $.config.set({ key: `context-watch.${f.key}`, value: parsed.value })
  if ('deny' in done && done.deny !== undefined) return { text: `${f.name} is unchanged: ${done.deny}` }
  const after = f.show(settings({ ...optionsNow, [f.key]: parsed.value }))
  await log($, `/context-watch ${f.name}: ${f.show(cfg)} -> ${after}`)
  return { text: `${f.name}: ${f.show(cfg)} → ${after}, from now on.`, context: [`[context-watch] The user set ${f.name} (${f.what}) to ${after}.`] }
}

// The options as the module received them, to show a changed setting the way the next load reads it.
let optionsNow: PluginOptions = {}

export const register: Register = (on, options) => {
  optionsNow = options
  cfg = settings(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 0.4.0 kept the limits in the store, for every session on the machine: gone, they hold per window now.
    try {
      await $.store.delete('limits')
    } catch {
      // no store to clean
    }
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
    await $.tool.register({
      name: NIGHT,
      description:
        'Run the session on to a line on the week meter, unattended: call it when the user names a cap for the ' +
        'night ("use up to 97% tonight": a line of 96 stops under it). A turn that ends under the line is resumed ' +
        "by a carry-on prompt after 2 minutes, or at the 5-hour window's reset when that is spent, until the line, " +
        "the stop time or the week's reset. The user's prompt ends the night; a turn that ends with a line starting " +
        '`Needs you:` or `Nothing ready:` pauses it until the next prompt. `off` ends it.',
      inputSchema: {
        type: 'object',
        properties: {
          line: { type: 'number', description: "The week meter's percentage to run to." },
          until: { type: 'string', description: 'A stop time, if the user gave one: 09:30 (local), +8h, +90m, or an ISO time.' },
          words: { type: 'string', description: "The user's words that set it, quoted, with the time they said them." },
          next: { type: 'string', description: 'What each resumed turn does: say, take the next ready task.' },
          off: { type: 'boolean', description: 'End the night.' },
        },
      },
    })
    await $.command.register({
      name: 'context-watch',
      description: "Show or change context-watch's settings, or this context's own suggested clear",
      argumentHint: '[setting value]',
      immediate: true,
    })
    // A reload cancels the old module's timers: the resume it had armed is armed again.
    const n = await read($, night)
    if (n?.wakeAt && !n.paused) await schedule($, Date.parse(n.wakeAt))
    return started
  })

  on('command.run', { command: 'context-watch' }, async ($, e) => command($, e.args))

  on('tool.call', { tool: 'mcp__context-watch__clear_and_restart' }, async ($, e) => {
    const input = e as unknown as { brief?: string }
    if (!input.brief) return { deny: 'context-watch: give a `brief` to start from.' }
    if (pending) return { deny: 'context-watch: a compaction is already queued for this turn.' }
    pendingClear = { brief: input.brief }
    spoke = false
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

  on('tool.call', { tool: `mcp__context-watch__${NIGHT}` }, async ($, e) => {
    const input = e as unknown as { line?: unknown; until?: string; words?: string; next?: string; off?: boolean }
    if (input.off) {
      const n = await read($, night)
      if (n) await endNight($, 'the model set it off')
      return { result: n ? 'The night is off: no turn is resumed.' : 'No night was on.' }
    }
    const line = typeof input.line === 'number' ? input.line : typeof input.line === 'string' ? Number.parseFloat(input.line) : Number.NaN
    if (!Number.isFinite(line) || !input.words || !input.next)
      return { deny: "context-watch: give `line` (the week meter's percentage), `words` (the user's, with their time) and `next`, or `off`." }
    const set = await setNight($, { line, until: input.until, words: input.words, next: input.next })
    return 'refused' in set ? { deny: `context-watch: ${set.refused}` } : { result: set.text }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || OWN.has(e.tool)) return ran
    calls++
    const args = e as unknown as { description?: string; file_path?: string; command?: string }
    recent.push(`${e.tool}: ${(args.description ?? args.file_path ?? args.command ?? '').slice(0, 80)}`)
    if (recent.length > 3) recent.shift()
    if ('deny' in ran && ran.deny !== undefined) return ran

    const u = await $.session.usage()
    const t = await target($)
    const lim = await ceilings($)
    if (cfg.statusLine) $.ui.status(status(u, t, lim))
    const crossed = crossings(u, t)
    const reached = limitWords(u, lim)
    if (reached.length) await log($, `${reached.join(' ').slice(0, 300)} | ${now(u, t, lim)}`)
    const words = [...notes.splice(0), ...reached]
    if (!crossed.length) return words.length ? { ...ran, context: [...(ran.context ?? []), ...words] } : ran

    let threshold = ''
    try {
      const at = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.autoCompactThreshold
      if (at) threshold = `; autocompact at ${k(at)}`
    } catch {
      threshold = ''
    }
    await log($, `${crossed.join(', ')} | ${now(u, t, lim)}${threshold} | in hand: ${recent.join(' / ')}`)
    const notice =
      `[context-watch] ${crossed.join(', ')}: ${now(u, t, lim)}${threshold}. ` +
      `Landing work at a seam keeps a compaction cheap; mcp__context-watch__${TOOL} compacts and resumes when that helps, ` +
      `and mcp__context-watch__${CLEAR} starts fresh from a brief once the state is in files and no agents run.`
    return { ...ran, context: [...(ran.context ?? []), notice, ...words] }
  })

  // Any prompt but the mod's own: typed or queued (the event fires at the user's Enter, mid-turn
  // too), from the terminal, the phone or Slack, or a notice, a peer's message, another mod's.
  // The user's own ends a night (but /context-watch, which sets it), and the model reads why beside
  // it; a slash command keeps those words for the next prompt. Any other lifts a night's pause.
  on('prompt.submit', async ($, e, next) => {
    resumedBy = e.origin.kind
    const theirs = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'slack-ping'
    if (theirs) spoke = true
    if (e.command?.name === 'context-watch') return next(e)
    const n = await read($, night)
    if (!theirs) {
      if (n?.paused) {
        await update($, night, cur => cur && { ...cur, paused: null })
        await log($, `the night's pause lifted: a prompt came (${e.origin.kind})`)
      }
      return next(e)
    }
    if (n) {
      await endNight($, "the user's prompt")
      endedNote = endedWords(n, "The user's prompt ended the night")
    }
    if (!endedNote || e.command) return next(e)
    const words = endedNote
    endedNote = undefined
    return next({ ...e, context: [...(e.context ?? []), words] })
  })

  // A main-loop turn begins: whether it is a carry-on's, and the armed resume is dropped (the turn's
  // own end arms the next).
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined) return started
    nightTurn = sentResume && (!e.text || e.text.includes(CARRY_ON))
    sentResume = false
    calls = 0
    turnRunning = true
    disarm()
    if ((await read($, night))?.wakeAt) await update($, night, n => n && { ...n, wakeAt: null })
    return started
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && !('skip' in done && done.skip !== undefined)) {
      const before = done.tokensBefore === undefined ? '?' : k(done.tokensBefore)
      const after = done.tokensAfter === undefined ? '?' : k(done.tokensAfter)
      await log($, `compacted (${e.trigger}) ${before} -> ${after} | in hand: ${recent.join(' / ')}`)
      await newContext($)
    }
    return done
  })

  // After the user's /clear, the last turn's words again (restart pastes its own into its prompt).
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    await stage($)
    const done = await next(e)
    await newContext($)
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

  // A main-loop turn ends (an agent's end is not the session's): its words are kept, then a queued
  // compaction or clear runs, else a night decides what comes next.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    turnRunning = false
    try {
      const words = await turnWords($)
      if (words) await remember($, words)
    } catch (err) {
      await log($, `the turn's words were not kept: ${String(err).slice(0, 200)}`)
    }
    if (pending) {
      const p = pending
      pending = undefined
      running = true
      $.clock.after(1000, () => void resume($, p))
    } else if (pendingClear) {
      const p = pendingClear
      pendingClear = undefined
      running = true
      $.clock.after(1000, () => void restart($, p))
    } else {
      try {
        await afterTurn($, e, nightTurn, calls)
      } catch (err) {
        await log($, `the night missed a turn's end: ${String(err).slice(0, 200)}`)
      }
    }
    nightTurn = false
    return done
  })
}
