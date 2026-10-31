// The load journal of the app (#204): each phase of a load, with its time and what it carried.
// Every phase is a `performance.mark` (readable in the dev tools) and a line of a journal kept in
// memory. In the iframe of the relay the lines are also sent to the bootstrap page
// (transport.traceBoot), which writes them with its own clock in the connection journal of #75:
// one journal reads a load from the tunnel to the project ready. Outside the relay the app keeps
// the same lines itself. `window.loadJournal` and Settings > Remote access > Connection journal
// read them; the journal is copied around, so it carries no path nor name of a file.
import { t } from '../i18n'
import { bootBytes, traceBoot } from './transport'

/** A phase of the load. `plugin` names the plugin in its detail, `warm` and `ask` count the
 * module asks they start (#206). */
export type LoadStep = 'start' | 'rpc' | 'home' | 'warm' | 'project-open' | 'ask' | 'reattach' | 'grammars' | 'questions' | 'ready' | 'plugin' | 'bytes'

/** What a phase carries: durations in ms, sizes in bytes, the id of a plugin. `pod` is the time
 * the pod spent on `project.open`, split by the steps it names. */
export type LoadDetail = {
  ms?: number
  pod?: number
  runtime?: number
  git?: number
  commands?: number
  attach?: number
  tracked?: number
  plugins?: number
  id?: string
  n?: number
  bytes?: number
  bundle?: boolean
  tunnel?: number
  cache?: number
  socket?: number
}

// A phase is kept as it happened (its time and its numbers) and worded when the journal is read:
// the language of the app is only known once its settings have arrived, a moment after the first
// phases — wording them at mark time would mix the browser's language and the one the user chose.
const lines: { at: number; step: LoadStep; detail: LoadDetail }[] = []
const seen = new Set<string>()

/** Bytes carried on the socket since the page opened, counted by pod/rpc on every message. */
export const socketBytes = { down: 0, up: 0 }
export function countSocket(n: number, up = false) {
  if (up) socketBytes.up += n
  else socketBytes.down += n
}

const kb = (n: number) => (n / 1024).toFixed(1)

/** The words of a phase, in the language of the app (the bootstrap page has its own). */
function text(step: LoadStep, d: LoadDetail): string {
  switch (step) {
    case 'start':
      return t('The IDE starts (script loaded)')
    case 'rpc':
      return t('The IDE talks to the pod (first message)')
    case 'home':
      return t('Home page shown')
    case 'warm':
      return t('Plugin modules of the last opening asked ({n})', { n: d.n ?? 0 })
    case 'ask':
      return t('Plugin modules of the project asked ({n})', { n: d.n ?? 0 })
    case 'project-open':
      return t('Project opened ({ms} ms, pod {pod} ms: runtime {runtime} ms, git {git} ms, commands {commands} ms, attach {attach} ms, tracked {tracked} ms, plugins {plugins} ms)', {
        ms: d.ms ?? 0,
        pod: d.pod ?? 0,
        runtime: d.runtime ?? 0,
        git: d.git ?? 0,
        commands: d.commands ?? 0,
        attach: d.attach ?? 0,
        tracked: d.tracked ?? 0,
        plugins: d.plugins ?? 0,
      })
    case 'reattach':
      return t('Worktrees attached ({ms} ms)', { ms: d.ms ?? 0 })
    case 'grammars':
      return t('Language packs ready ({ms} ms)', { ms: d.ms ?? 0 })
    case 'questions':
      return t('Questions loaded ({ms} ms)', { ms: d.ms ?? 0 })
    case 'ready':
      return t('Project ready ({ms} ms after the page opened)', { ms: d.ms ?? 0 })
    case 'plugin':
      return d.bytes
        ? t(d.bundle ? 'Plugin {id} loaded from its bundle ({ms} ms, {kb} kB)' : 'Plugin {id} loaded from its chunk ({ms} ms, {kb} kB)', { id: d.id ?? '', ms: d.ms ?? 0, kb: kb(d.bytes) })
        : t('Plugin {id} loaded ({ms} ms)', { id: d.id ?? '', ms: d.ms ?? 0 })
    case 'bytes':
      return t('Load carried {tunnel} kB from the pod, {cache} kB from the cache, {socket} kB on the socket', {
        tunnel: kb(d.tunnel ?? 0),
        cache: kb(d.cache ?? 0),
        socket: kb(d.socket ?? 0),
      })
  }
}

/**
 * Records a phase: a mark, a line of the journal (once per phase) and, in the relay, the same
 * phase in the journal of the bootstrap page. Synchronous by nature: a mark never awaits.
 */
export function loadMark(step: LoadStep, detail: LoadDetail = {}) {
  const key = step + (detail.id ?? '')
  if (seen.has(key)) return // a phase is written once: a mark per message would pile up
  seen.add(key)
  try {
    performance.mark('webide:' + key)
  } catch {
    /* no marks in an old browser: the journal is what matters */
  }
  lines.push({ at: performance.now(), step, detail })
  traceBoot(step, detail)
  settleBytes()
}

/** An open asked again (its channel dropped before the project was ready): the phases of the
 * project are forgotten so the load that succeeds writes them all, with its own times. The
 * modules already in stay out of the journal — a chunk is really loaded once. */
export function loadRetry() {
  const steps = new Set(['project-open', 'reattach', 'grammars', 'questions', 'ready', 'bytes'])
  for (const s of steps) seen.delete(s)
  for (let i = lines.length - 1; i >= 0; i--) if (steps.has(lines[i].step)) lines.splice(i, 1)
}

// The summary of what the load carried comes once the project is ready, and only then: a page
// read at the home page for a minute is not a load, and on a slow link the phases are seconds
// apart — arming it from any phase wrote it before the socket had carried anything. Each phase
// after `ready` re-arms a short settle, so it lands after the last module that arrived, and
// asking it again replaces the line: the journal is read live, not a snapshot taken mid-load.
let bytesTimer: number | undefined
function settleBytes(after = 1500) {
  if (!seen.has('ready')) return
  clearTimeout(bytesTimer)
  bytesTimer = window.setTimeout(() => void markBytes(), after)
}

// What the load still waits for: the plugin modules it asked for, the questions it asked the pod.
// `loadPending` counts a request as it leaves and is released when its answer lands (or fails);
// the table of the journal is printed once the settle finds nothing pending — one table at the end
// of a slow load, not one per measure of the bytes.
let pending = 0
let printed = false
export function loadPending(): () => void {
  pending++
  return () => {
    if (pending > 0) pending--
    settleBytes() // a request that failed settles the journal too
  }
}

/** The journal, worded in the language of the app now, each line with its time in seconds, in the
 * order the phases happened — the summary of the load last, wherever its measure landed. */
export function loadJournalText() {
  const order = [...lines].sort((a, b) => a.at - b.at)
  order.sort((a, b) => Number(a.step === 'bytes') - Number(b.step === 'bytes')) // stable: the times keep their order
  return order.map((e) => (e.at / 1000).toFixed(2).padStart(6) + '  ' + text(e.step, e.detail)).join('\n')
}

Object.defineProperty(window, 'loadJournal', { get: loadJournalText })

// What the load carried. Through the relay the bootstrap page counts the bytes it streamed
// through the tunnel and what its Service Worker answered from a cache of this origin (#204);
// on a direct pod, or from a bootstrap page that does not answer, the resource timings of the
// page give the size of the assets it downloaded.
function assetBytes(): number {
  let carried = 0
  for (const e of performance.getEntriesByType('resource')) {
    const r = e as PerformanceResourceTiming
    carried += r.transferSize || r.decodedBodySize || 0
  }
  return carried
}

/** Ends the journal with what the load carried, or rewrites the line when a late module changed
 * the totals. A page or a browser that answers nothing leaves the columns at 0. */
export async function markBytes() {
  const b = await bootBytes()
  const detail: LoadDetail = {
    tunnel: b?.tunnel ?? assetBytes(),
    cache: b?.cache ?? 0,
    socket: socketBytes.down + socketBytes.up,
  }
  const line = { at: performance.now(), step: 'bytes' as LoadStep, detail }
  const at = lines.findIndex((l) => l.step === 'bytes')
  if (at >= 0) lines[at] = line
  else lines.push(line)
  seen.add('bytes')
  traceBoot('bytes', detail)
  // The table once, when the load has nothing pending any more: a late module re-arms the settle
  // and the journal stays live in Settings, but the console is not filled again.
  if (!printed && pending === 0) {
    printed = true
    console.info(loadJournalText())
  }
}
