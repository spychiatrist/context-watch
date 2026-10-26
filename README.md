# context-watch

A small mod for Claude Code that keeps an eye on two things while you work:

- how big the conversation's context has grown,
- how much of your plan's 5-hour and weekly usage you have used.

When either crosses a mark, it tells the model (and logs it). It also gives the model two tools to make room and keep going: compact and continue, or clear and restart from a written brief.

context-watch is free and will stay free. It is a non-commercial project and will never be monetized. MIT licensed.

---

## Why

Every turn, the model re-reads the whole conversation so far. A turn at 300k tokens of context costs roughly three times what the same turn costs at 100k. Prompt caching makes re-reading cheaper, not free, and it still uses up your plan's limits.

So long sessions get expensive quietly. In the author's own use, most of a week's cost turned out to be re-reading long contexts, not doing new work.

The fix is a habit, not a feature:

1. Land the work in files (commit it, update your notes or task list).
2. Clear the conversation.
3. Start again from a short brief: what to read first, what's in flight, what's next.

context-watch helps with both halves:

- **Knowing when.** You and the model get a plain notice at 100k, 200k, 300k... and at usage marks, instead of finding out from the bill or a rate limit.
- **Making it one step.** The model can call `clear_and_restart` with a brief. The clear and the fresh start happen by themselves when the turn ends. No copy, `/clear`, paste.

---

## How it works

### Notices

After each tool call in the main conversation, context-watch reads the session's usage and checks it against the marks:

- **Context:** every multiple of `contextStep` (default 100k tokens).
- **Suggested clear:** once, when the context passes `clearAt` (off by default), with "land the work in files, then clear". `/context-watch epoch` moves it for the current context alone (below).
- **5-hour window:** 50%, 80%, 95% (`fiveHourMarks`).
- **Weekly window:** 50%, 75%, 90% (`weeklyMarks`).

When one is crossed, a short notice is added to that tool result, which only the model reads:

```
[context-watch] context passed 200k: context 201k of 1000k; 5h 34% (resets 16:00Z),
week 41% (resets 00:00Z); autocompact at 950k. Landing work at a seam keeps a
compaction cheap; mcp__context-watch__compact_and_continue compacts and resumes
when that helps, and mcp__context-watch__clear_and_restart starts fresh from a
brief once the state is in files and no agents run.
```

Notes:

- Each mark fires once on the way up. After a compaction the context marks start over; after a usage window resets, its marks start over.
- The first reading after the mod loads (or reloads) is taken silently, so a reload never repeats a notice.
- Subagents' tool calls are ignored.
- The usage windows only appear on plans that have them. Without them you get the context notices only.

### Status line

After each tool call the status line shows the same reading, with the 5-hour reset time in local time at the end:

```
context 201k of 1000k, clear at 250k; 5h 34%, week 41%; resets 18:00
```

`clear at` shows when a suggested clear is set, with `(this context)` after it when `/context-watch epoch` set the current context's own. Turn the status line off with `statusLine: false`.

### The log

Each crossing, compaction and clear is appended to `context-watch.log` in the data folder (default `~/.claude/context-watch.log`). One line each: the time, the working folder, what happened, and the last three tool calls ("in hand"):

```
2026-01-05T14:02:11.120Z  /home/me/src/app  context passed 200k | context 201k of 1000k; ... | in hand: Bash: Run the tests / Edit: src/app.ts / Read: src/app.ts
```

Past `logMaxBytes` (default 200 KB) the log keeps its newer half.

### The two tools

Both are registered as MCP tools of the session, so the model sees them as:

- `mcp__context-watch__compact_and_continue` with `keep` and `next`
- `mcp__context-watch__clear_and_restart` with `brief`

Both are queued when called and run when the current turn ends, once the session is idle. The model is told to end its turn right after calling one.

**compact_and_continue** (`keep`, `next`)

1. Compacts the conversation, telling the summarizer what must survive (`keep`).
2. Sends `next` as the prompt that resumes the work.
3. If you type a prompt while the compaction runs, yours resumes the session instead and no second "carry on" is sent. `next` is in the summary's instructions too, so it isn't lost.

**clear_and_restart** (`brief`)

1. Clears the conversation. Nothing is summarized, so nothing is lost to a summary; only files carry over (CLAUDE.md, memory, notes, the task list) plus the brief.
2. Sends the brief as the first prompt of the fresh conversation. It also names the old transcript file (`<session id>.jsonl` in the project's transcript folder), in case a detail is missing.
3. Pastes the model's last answer at the end of that prompt (the one on screen when the clear runs), marked as already said, so you can still read it after the clear.

If the session never goes idle, each tool gives up after about 10 minutes and logs it. A prompt you send before the clear runs drops it, as you are still reading and working in that conversation; the model is told at its next tool call.

`resumeNote`, when set, goes into both prompts before the model's own words: something every fresh start should do first, like reading the project's notes.

### The /context-watch command

`/context-watch` shows the settings, the context's reading and how to change them:

```
context 120k of 1000k, clear at 250k
  target 250k           the suggested clear, every context
  epoch  the target's   this context's own, until the next clear or compaction
  step   100k           a notice at every multiple
  5h     50,80,95       5-hour usage marks (%)
  ...
```

`/context-watch <name> <value>` changes one:

| Name | Option | Example |
| --- | --- | --- |
| `target` | `clearAt` | `target 250k`, `target +50k`, `target off` |
| `epoch` | none: the current context's suggested clear | `epoch 400k`, `epoch +50k`, `epoch off`, `epoch reset` |
| `step` | `contextStep` | `step 50k` |
| `5h`, `week` | `fiveHourMarks`, `weeklyMarks` | `week 60,80,95`, `5h none` |
| `limitweek`, `limit5h` | none: a usage limit for this window, until its meter resets | `limitweek 44%`, `limitweek +14%`, `limit5h off` |
| `resume` | `resumeNote` | `resume "Read NOTES.md first."`, `resume none` |
| `status`, `log` | `statusLine`, `log` | `status off` |
| `logcap`, `turns`, `data` | `logMaxBytes`, `keepTurns`, `dataDir` | `turns 5` |

- Every name but `epoch` writes its `/config` row (`pluginConfigs` in `~/.claude/settings.json`), which reloads the mod. While a compaction or clear is on its way it refuses, as the reload would drop it.
- `epoch` is held for the session and lasts until the next clear or compaction; then the next context starts on `target` again. `epoch reset` goes back to `target` right away.
- `limitweek` and `limit5h` cap a usage meter in the window that sets them: when a reading reaches the limit, the model is told to land what is in flight, say where things stand and start nothing new. The conversation stays as it is; nothing clears. A context that starts past the limit is told once. A limit holds in that window alone (other sessions on the machine carry on), through its clears, until its meter's window resets. `+14%` counts from the meter's reading now. (0.4.0 kept limits for every session and cleared at them; 0.5.0 drops that shared limit when it loads.)
- The model is told of each change. The command runs at once, even while a turn is in flight.

### Keeping the last answer across a clear

A `/clear` normally wipes the answer you were in the middle of reading. context-watch keeps the words of each turn in a small file per project (`context-watch-said-<project path>.md` in the data folder, the last `keepTurns` turns, newest first).

- After **your** `/clear`, the clear's row at the top of the fresh conversation shows the last turn in full, as markdown, and names that file.
- After **clear_and_restart**, the answer is pasted into the brief prompt instead (see above), and the row stays empty.

Set `keepTurns: 0` to turn this off.

### Hooks it registers

| Event | What it does |
| --- | --- |
| `session.start` | Registers the two tools and `/context-watch`. |
| `tool.call` (every call) | Reads usage, updates the status line, checks the marks, adds the notice, logs. |
| `tool.call` (its own two tools) | Checks the input and queues the compaction or clear. |
| `turn.complete` | Saves the turn's words; starts a queued compaction or clear a second later. |
| `prompt.submit` | Notes that you typed something, so a compaction doesn't send a second resume prompt. |
| `session.compact` | Logs the tokens before and after; resets the context marks and the context's own suggested clear. |
| `command.run` (`/clear`) | Holds the last turn's words for the clear's row; resets the context marks and the context's own suggested clear. |
| `command.run` (`/context-watch`) | Shows the settings, or changes one. |
| `ui.render` (`CommandOutput`) | Draws those words under `/clear`. |

---

## Requirements

- **Claude Code with mod support** (plugins with function hooks, the `register(on, options)` API). That API is early access. context-watch was built and tested on Claude Code 2.1.30x.
- Nothing else to run it. The module runs inside Claude Code; no Node, no npm install.
- For development only: TypeScript 5.4 or newer to type-check.

---

## Install

### Option A: from GitHub (recommended)

At the prompt of a Claude Code terminal session:

```
/plugin install context-watch --marketplace spychiatrist/context-watch
```

1. Answer `y` to add the marketplace (`github:spychiatrist/context-watch`).
2. Pick a scope. **User** (the first one) loads it in every project.
3. The options screen comes up; Enter keeps the defaults.

It is active right away, and in every session after.

From a shell instead:

```sh
claude plugin install context-watch --marketplace spychiatrist/context-watch
```

Options can be set at install time with `--config`, e.g. `--config contextStep=150000`.

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `spychiatrist/context-watch`, then **Add plugin**.

### Option B: from a clone, with `CLAUDE_CODE_PLUGIN_DIRS`

Useful if you want to read or change the code, or run it straight from a folder you control.

1. Clone it somewhere you keep tools:

   ```sh
   git clone https://github.com/spychiatrist/context-watch.git ~/.claude/mods/context-watch
   ```

2. Add the folder to the `env` block of `~/.claude/settings.json` (user settings; a project's settings are not read for this):

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/context-watch"
     }
   }
   ```

   Several folders are separated by `:` (`;` on Windows). You can also export the variable in your shell instead.

3. Start a new Claude Code session.

Claude Code watches that folder: saving a file in it reloads the mod in a running session. A `git pull` updates it.

### Option C: one session only

```sh
claude --plugin-dir ~/.claude/mods/context-watch
```

### Teach the model when to use it

The notices already name the tools. A line in your `CLAUDE.md` makes the habit explicit, for example:

```markdown
When context-watch says the context passed the suggested clear, finish the current
step, land it in files (commit, update the notes), then call clear_and_restart with a brief:
what to read first, what is in flight, what to do next.
```

---

## Configuration

Every option is optional. The defaults are what the mod has always done.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `contextStep` | number | `100000` | A notice each time the context passes a multiple of this many tokens. |
| `clearAt` | number | `0` | The suggested clear: a notice when the context passes this many tokens. `0`: none. |
| `fiveHourMarks` | string | `"50,80,95"` | Percentages of the 5-hour usage window that raise a notice. Empty: none. |
| `weeklyMarks` | string | `"50,75,90"` | Percentages of the weekly usage window that raise a notice. Empty: none. |
| `resumeNote` | string | `""` | Put into every prompt that resumes after the mod's compaction or clear, before the model's own words. |
| `statusLine` | boolean | `true` | Show the reading in the status line after each tool call. |
| `dataDir` | string | `"~/.claude"` | Where the log and the per-project turn files go. Use an absolute path or one starting with `~`; a relative path would land in each project. Created if missing. |
| `log` | boolean | `true` | Write `context-watch.log` in the data folder. |
| `logMaxBytes` | number | `200000` | Past this size the log keeps its newer half. Minimum 1000. |
| `keepTurns` | number | `10` | Turns kept per project to show again after a `/clear`. `0` turns that off. |

How to set them:

- **`/context-watch <name> <value>`** in a session (above).
- **`/config`** in a session. Each option is a row; a change reloads the mod.
- **`claude plugin configure context-watch`** shows the options and which are set.
- **By hand**, in `~/.claude/settings.json`, under `pluginConfigs`. For Option B or C the key is the plugin's name:

  ```json
  {
    "pluginConfigs": {
      "context-watch": {
        "options": { "contextStep": 150000, "clearAt": 250000, "weeklyMarks": "60,80,95", "keepTurns": 5 }
      }
    }
  }
  ```

---

## Files it writes

All in the data folder (default `~/.claude`):

- `context-watch.log`: the log described above.
- `context-watch-said-<project path>.md`: the last turns' words for each project, the project's path with every non-alphanumeric character as `-`.

Both are plain text and stay on your machine. The turn files hold the text of the model's recent answers, so treat them like your transcripts.

---

## Uninstall

Installed from GitHub (Option A):

```
/plugin uninstall context-watch
/plugin marketplace remove context-watch
```

(or `claude plugin uninstall context-watch` and `claude plugin marketplace remove context-watch` from a shell)

From a clone (Option B):

1. Remove its path from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.
2. Start a new session, then delete the folder.

Either way, the files it wrote stay until you delete them:

```sh
rm ~/.claude/context-watch.log ~/.claude/context-watch-said-*.md
```

and remove the `context-watch` entry from `pluginConfigs` in `~/.claude/settings.json` if you set options by hand.

---

## Limits and caveats

- **Early-access API.** The mod API can change between Claude Code releases, and a release can break this mod until it's updated.
- **Checks run after tool calls.** A long answer with no tool calls isn't checked until the next tool call.
- **Managed installs.** Where an organization manages Claude Code, hooks on `session.compact` don't run for plugins a person installs. There, compactions aren't logged and the context marks don't reset after one. Everything else works.
- **A clear only carries files.** After `clear_and_restart`, background agents' reports may not reach the new conversation; use it when none are running. Anything not in files or the brief is gone (the old transcript is still on disk).
- **The tools wait for idle.** They run when the turn ends and the session is idle, retrying for about 10 minutes before giving up (logged).
- **It nudges, it doesn't decide.** The notices are advice to the model. Whether it lands the work and clears depends on the model and your instructions.
- **Reloads start fresh.** The marks are kept in memory; a reload takes the next reading silently and notices only later crossings.

---

## Development

```sh
claude plugin validate .   # what the module hooks and calls, and anything Claude Code would refuse
claude plugin test .       # runs hooks/register.test.tsx against Claude Code's test kit
```

To type-check, load the folder in a session once (Option B or C). Claude Code then writes the API types to `.claude-plugin/types/` (ignored by git), and `tsc -p .` works.

Layout:

- `.claude-plugin/plugin.json`: the manifest, with the options (`userConfig`).
- `.claude-plugin/marketplace.json`: makes this repo installable with `/plugin install`.
- `hooks/hooks.json`: names the hooks module.
- `hooks/register.tsx`: the mod.
- `hooks/register.test.tsx`: its tests.
- `types/index.d.ts`: the type of the state it keeps on screen.

---

## License

[MIT](LICENSE). Free, non-commercial, and never to be monetized.
