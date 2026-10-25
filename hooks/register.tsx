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
//
// A suggested clear (clearAt) adds a notice when the context passes it. The
// /context-watch command shows the settings and changes them: each one for good
// (the rows /config shows), or the suggested clear for the current context alone,
// until the next clear or compaction.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionUsage } from 'claude-code'

import type { Epoch, Shown } from '../types'

type Engine = EngineInterface

const NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
const TOOL = 'compact_and_continue'
const CLEAR = 'clear_and_restart'
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
let pendingClear: { brief: string; why?: string } | undefined
// Each meter's last reading against its limit, the limits this context was told it is past, and a
// limit crossed this turn (the conversation clears when the turn ends).
const seen: Record<string, number> = {}
const told = new Set<string>()
let limitHit: { kind: string; percent: number; limit: number } | undefined
// From the end of the turn that queued a compaction or clear until its resume prompt is sent: a
// reload then would drop it, so /context-watch changes no setting meanwhile.
let running = false
// The user's prompt came while a compaction ran: it resumes the session, so the
// resume prompt is not sent (it would run as a second "carry on" after the answer).
let spoke = false

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const clock = (iso?: string) => (iso ? new Date(iso).toISOString().slice(11, 16) + 'Z' : '?')

function windows(u: SessionUsage, lim: Limits = {}, resets = true) {
  return u.rateLimits
    .filter(r => NAMES[r.kind])
    .map(r => {
      const l = lim[r.kind]
      const notes = [...(l ? [`limit ${l.percent}%`] : []), ...(resets ? [`resets ${clock(r.resetsAt)}`] : [])]
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

// The usage limits /context-watch limitweek and limit5h set, by meter: in the store, as the meters
// are the account's, so every session on this machine keeps them, each until its window resets.
type Limit = { percent: number; until?: string }
type Limits = Record<string, Limit>
const LIMITS: Record<string, string> = { limitweek: 'seven_day', limit5h: 'five_hour' }
const limitCommand = (kind: string) => Object.keys(LIMITS).find(n => LIMITS[n] === kind) ?? kind

async function limits($: Engine): Promise<Limits> {
  let all: Limits = {}
  try {
    all = ((await $.store.get('limits')) ?? {}) as Limits
  } catch {
    all = {}
  }
  const t = Date.now()
  return Object.fromEntries(Object.entries(all).filter(([, l]) => !l.until || Date.parse(l.until) > t))
}

// A limit reached: crossed since the last reading, the conversation clears when the turn ends;
// already past when the context began, a word to the model, once a context.
function limitWords(u: SessionUsage, lim: Limits): string[] {
  const out: string[] = []
  for (const r of u.rateLimits) {
    const before = seen[r.kind]
    seen[r.kind] = r.percentUsed
    const l = lim[r.kind]
    if (!l || r.percentUsed < l.percent || told.has(r.kind)) continue
    told.add(r.kind)
    const name = NAMES[r.kind] ?? r.kind
    const cmd = limitCommand(r.kind)
    if (before !== undefined && before < l.percent) {
      limitHit = { kind: r.kind, percent: r.percentUsed, limit: l.percent }
      out.push(
        `[context-watch] ${name} usage reached its limit, ${l.percent}% (/context-watch ${cmd}): the conversation clears ` +
          'when this turn ends, and the fresh one starts with word of it. Land what is in flight now (commit, notes), ' +
          'call clear_and_restart with a brief if there is one to give, and start nothing new.',
      )
    } else
      out.push(
        `[context-watch] ${name} usage ${r.percentUsed}% is past its limit, ${l.percent}% (/context-watch ${cmd}): ` +
          `start nothing new on this plan's usage; the user raises it with /context-watch ${cmd} +N.`,
      )
  }
  return out
}

// What the fresh conversation after a limit's clear is told.
function limitBrief(h: { kind: string; percent: number; limit: number }) {
  const cmd = limitCommand(h.kind)
  return (
    `The ${NAMES[h.kind] ?? h.kind} usage limit (${h.limit}%, /context-watch ${cmd}) was reached at ${h.percent}%. ` +
    'Start nothing new on this plan\'s usage: say in a few lines where things stand and what waits, then stop. ' +
    `The user raises it with /context-watch ${cmd} +N, or off.`
  )
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
      spoke = false
      // `next` in the summary too, for when the user's prompt resumes it instead of ours.
      const done = await $.session.compact({ instructions: `${p.keep}\n\nNext, once it resumes: ${p.next}` })
      if ('skip' in done && done.skip !== undefined) {
        await log($, `compaction skipped by a hook: ${done.skip}`)
        return
      }
      // A plugin's own $.session.compact skips its own hooks, the session.compact one below too.
      await newContext($)
      if (spoke) {
        await log($, "compacted; the user's prompt came during it and resumes the session, so no resume prompt")
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
// (A plugin's own $.command.run skips its own hooks, so the /clear hook below never
// runs for this clear.)
async function restart($: Engine, p: { brief: string; why?: string }) {
  try {
    await clearAndBrief($, p)
  } finally {
    running = false
  }
}

async function clearAndBrief($: Engine, p: { brief: string; why?: string }) {
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
  await newContext($)
  await log($, `cleared (was ${before}); ${answer ? `pasted the last answer (${answer.length} characters)` : 'no answer to paste'}`)
  const text =
    `${p.why ? `Starting fresh: ${p.why}, so the conversation was cleared when the turn ended` : 'Starting fresh after the clear you asked for'}` +
    ` (nothing was summarized; the conversation before it is ` +
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
  '`limitweek 44%`, `limitweek +14%`, `5h 50,90`, `status off`, `resume none`. The settings are /config rows too.'

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
  const row = (f: Field) => [f.name, f.show(cfg), f.what] as [string, string, string]
  const rows: [string, string, string][] = [
    ...FIELDS.slice(0, 1).map(row),
    ['epoch', t.own ? (t.at ? k(t.at) : 'off') : "the target's", "this context's own, until the next clear or compaction"],
    ...FIELDS.slice(1, 4).map(row),
    ['limitweek', showLimit(lim.seven_day), 'clears once the week meter reaches it'],
    ['limit5h', showLimit(lim.five_hour), 'clears once the 5-hour meter reaches it'],
    ...FIELDS.slice(4).map(row),
  ]
  const w = Math.min(16, Math.max(...rows.map(r => r[1].length)))
  return [now(u, t, lim), ...rows.map(([n, v, what]) => `  ${n.padEnd(10)}${v.padEnd(w)}  ${what}`), HOW].join('\n')
}

const showLimit = (l?: Limit) => (l ? `${l.percent}%${l.until ? ` to ${l.until.slice(5, 16).replace('T', ' ')}Z` : ''}` : 'off')

// /context-watch limitweek 44% (or +14%, from the meter's reading now, or off): the conversation clears
// once a reading reaches it and the turn ends, in every session on this machine, until the window resets.
async function limit($: Engine, cmd: string, kind: string, raw: string): Promise<{ text: string; context?: string[] }> {
  const all = await limits($)
  const r = (await $.session.usage()).rateLimits.find(x => x.kind === kind)
  const name = NAMES[kind] ?? kind
  if (!raw) return { text: `${cmd}: ${showLimit(all[kind])}${r ? `; the ${name} meter reads ${r.percentUsed}%` : ''}.` }
  told.delete(kind)
  if (['off', 'none'].includes(raw.toLowerCase())) {
    delete all[kind]
    await $.store.set('limits', all)
    return { text: `${cmd}: off.`, context: [`[context-watch] The user took the ${name} usage limit off.`] }
  }
  const m = raw.match(/^(\+?)(\d+(?:\.\d+)?)%?$/)
  if (!m) return { text: `${cmd} takes a percentage of the ${name} meter: 44%, +14% (from its reading now), or off.` }
  if (m[1] && !r) return { text: `No ${name} meter to count from on this plan.` }
  const percent = Math.round((m[1] ? (r?.percentUsed ?? 0) : 0) + Number(m[2]))
  if (percent < 1 || percent > 100) return { text: `${cmd} is between 1% and 100%.` }
  all[kind] = { percent, ...(r?.resetsAt ? { until: r.resetsAt } : {}) }
  await $.store.set('limits', all)
  if (r) seen[kind] = r.percentUsed
  const past = r !== undefined && r.percentUsed >= percent
  if (past) {
    told.add(kind)
    limitHit = { kind, percent: r.percentUsed, limit: percent }
  }
  await log($, `/context-watch ${cmd} ${raw}: ${showLimit(all[kind])}, the meter at ${r?.percentUsed ?? '?'}%`)
  return {
    text: past
      ? `${cmd}: ${percent}%, reached already (${r.percentUsed}%): the conversation clears when this turn, or the next, ends.`
      : `${cmd}: ${showLimit(all[kind])}, the meter at ${r?.percentUsed ?? '?'}%: the conversation clears when a turn that reaches it ends, in every session here.`,
    context: [
      `[context-watch] The user set a ${name} usage limit of ${percent}% (every session on this machine, until the window resets)` +
        (past ? ': reached already, so the conversation clears when this turn ends. Land what is in flight.' : '.'),
    ],
  }
}

// /context-watch: the settings; `/context-watch <name> <value>` changes one.
async function command($: Engine, args: string): Promise<{ text: string; context?: string[] }> {
  const name = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const raw = args.trim().slice(name.length).trim()
  if (!name) return { text: await overview($) }
  const kind = LIMITS[name]
  if (kind) return limit($, name, kind, raw)

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
    await $.command.register({
      name: 'context-watch',
      description: "Show or change context-watch's settings, or this context's own suggested clear",
      argumentHint: '[setting value]',
      immediate: true,
    })
    return started
  })

  on('command.run', { command: 'context-watch' }, async ($, e) => command($, e.args))

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
    const t = await target($)
    const lim = await limits($)
    if (cfg.statusLine) $.ui.status(status(u, t, lim))
    const crossed = crossings(u, t)
    const reached = limitWords(u, lim)
    if (reached.length) await log($, `${reached.join(' ').slice(0, 300)} | ${now(u, t, lim)}`)
    if (!crossed.length) return reached.length ? { ...ran, context: [...(ran.context ?? []), ...reached] } : ran

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
    return { ...ran, context: [...(ran.context ?? []), notice, ...reached] }
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
    if (limitHit && e.agentId === undefined) {
      const h = limitHit
      limitHit = undefined
      const words = limitBrief(h)
      const why = `the ${NAMES[h.kind] ?? h.kind} usage limit, ${h.limit}%, was reached (${h.percent}%)`
      if (pending) pending = { ...pending, next: `${pending.next}\n\n${words}` }
      else pendingClear = pendingClear ? { brief: `${pendingClear.brief}\n\n${words}`, why } : { brief: words, why }
      await log($, `${why}: ${pending ? 'the queued compaction carries it' : 'the conversation clears now the turn has ended'}`)
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
    }
    return done
  })
}
