// The Mac's load in one line, for the model to check itself against at each context mark and at
// the door: the load, memory and swap, the GPU, the window server and its window
// manager, the busiest processes, and the session's own share. What runs out of line leads it as a
// check. A command that fails leaves its part out.
import type { EngineInterface } from 'claude-code'

import { size, tree } from './procs'
import type { Proc } from './procs'

type Engine = EngineInterface

// Past these, a part leads the line as a check.
const WINDOW_MANAGER_KB = 1024 * 1024 // it sits near 100 MB; two windows left 38 h grew it to 10.7 GB
const WINDOW_SERVER_CPU = 80 // percent of a core
const GPU = 90 // percent
const SESSION_CPU = 100 // the session's processes together, percent of a core
const PRESSURE: Record<string, string> = { '1': 'normal', '2': 'warn', '4': 'critical' }

const pct = (n: number) => `${Math.round(n)}%`
const gb = (mb: string | undefined) => (Number(mb) / 1024).toFixed(1)

async function run($: Engine, argv: string[]) {
  try {
    const r = await $.process.run(argv, { env: { LC_ALL: 'C' } })
    return r.exitCode === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}

// `procs` is the table the caller read; `me` the session's claude.
export async function macLine($: Engine, procs: readonly Proc[], me: number | null): Promise<string> {
  const checks: string[] = []
  const parts: string[] = []
  const [sys, gpu] = await Promise.all([
    run($, ['/usr/sbin/sysctl', '-n', 'vm.loadavg', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level', 'hw.ncpu']),
    run($, ['/usr/sbin/ioreg', '-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']),
  ])
  const [loads = '', swap = '', level = '', free = '', cores = ''] = sys.split('\n').map(s => s.trim())
  const load = Number(loads.match(/[\d.]+/)?.[0])
  if (Number.isFinite(load) && cores) {
    parts.push(`load ${Number(load.toFixed(1))} on ${cores} cores`)
    if (load > Number(cores)) checks.push(`the load, ${Number(load.toFixed(1))}, is over the ${cores} cores`)
  }
  const pressure = PRESSURE[level] ?? level
  const used = swap.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/)
  if (free) parts.push(`memory ${free}% free${pressure ? ` (${pressure})` : ''}${used ? `, swap ${gb(used[2])} of ${gb(used[1])} GB` : ''}`)
  if (level === '2' || level === '4') checks.push(`memory pressure is ${pressure}`)
  const use = [...gpu.matchAll(/"Device Utilization %"=(\d+)/g)].map(m => Number(m[1]))
  if (use.length) {
    const top = Math.max(...use)
    parts.push(`GPU ${top}%`)
    if (top > GPU) checks.push(`the GPU is at ${top}%`)
  }
  for (const name of ['WindowServer', 'WindowManager']) {
    const p = procs.find(x => x.name === name)
    if (!p) continue
    parts.push(`${name} ${pct(p.cpu)} CPU, ${size(p.rss)}`)
    if (name === 'WindowServer' && p.cpu > WINDOW_SERVER_CPU) checks.push(`WindowServer at ${pct(p.cpu)} CPU: windows drawing in the background?`)
    if (name === 'WindowManager' && p.rss > WINDOW_MANAGER_KB) checks.push(`WindowManager at ${size(p.rss)} (it sits near 100 MB): windows left open?`)
  }
  const busy = [...procs].sort((a, b) => b.cpu - a.cpu).filter(p => p.cpu >= 1).slice(0, 3)
  if (busy.length) parts.push(`busiest: ${busy.map(p => `${p.name} ${pct(p.cpu)}`).join(', ')}`)
  if (me !== null) {
    const mine = tree(procs, me)
    const cpu = mine.reduce((s, p) => s + p.cpu, 0)
    const big = mine.filter(p => p.pid !== me).sort((a, b) => b.rss - a.rss)[0]
    if (mine.length) {
      parts.push(
        `this session: ${mine.length} processes, ${pct(cpu)} CPU, ${size(mine.reduce((s, p) => s + p.rss, 0))}` +
          `${big ? ` (${big.name} ${size(big.rss)})` : ''}`,
      )
    }
    if (cpu > SESSION_CPU) checks.push(`this session's processes use ${pct(cpu)} CPU`)
  }
  if (!parts.length) return ''
  return `${checks.length ? `Check: ${checks.join('; ')}. ` : ''}Mac now: ${parts.join('; ')}.`
}
