// The load journal of the app (#204): each phase of a load, with its time and what it carried.
// Every phase is a `performance.mark` (readable in the dev tools) and a line of a journal kept in
// memory. In the iframe of the relay the lines are also sent to the bootstrap page
// (transport.traceBoot), which writes them with its own clock in the connection journal of #75:
// one journal reads a load from the tunnel to the project ready. Outside the relay the app keeps
// the same lines itself. `window.loadJournal` and Settings > Remote access > Connection journal
// read them; the journal is copied around, so it carries no path nor name of a file.
import { t } from '../i18n'
import { traceBoot } from './transport'

/** A phase of the load. `plugin` names the plugin in its detail. */
export type LoadStep = 'start' | 'rpc' | 'home' | 'project-open' | 'reattach' | 'grammars' | 'questions' | 'ready' | 'plugin' | 'bytes'

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
  bytes?: number
  bundle?: boolean
  tunnel?: number
  cache?: number
  socket?: number
}

const lines: { at: number; text: string }[] = []
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
  lines.push({ at: performance.now(), text: text(step, detail) })
  traceBoot(step, detail)
  settleBytes()
}

// The bytes of the load are worth counting once everything it loaded is in: the plugin modules
// (and the bundles of the external plugins) arrive after the project is ready. Each phase re-arms
// a short settle, so the last line comes after the last phase.
let bytesTimer: number | undefined
function settleBytes(after = 1500) {
  clearTimeout(bytesTimer)
  bytesTimer = window.setTimeout(() => void markBytes(), after)
}

/** The journal as the bootstrap page writes it: the time of each line, in seconds. */
export function loadJournalText() {
  return lines.map((e) => (e.at / 1000).toFixed(2).padStart(6) + '  ' + e.text).join('\n')
}

Object.defineProperty(window, 'loadJournal', { get: loadJournalText })

// What the load carried. Through the relay the Service Worker counts, per window, what it streamed
// through the tunnel and what it answered from its cache (#204); on a direct pod the resource
// timings give the size of the assets, and the socket totals those of the protocol.
function swBytes(): Promise<{ tunnel: number; cache: number } | null> {
  const ctrl = navigator.serviceWorker?.controller
  if (!ctrl) return Promise.resolve(null)
  const chan = new MessageChannel()
  return new Promise((resolve) => {
    const done = setTimeout(() => resolve(null), 1500)
    chan.port1.onmessage = (e) => {
      clearTimeout(done)
      chan.port1.close()
      resolve(typeof e.data?.tunnel === 'number' ? e.data : null)
    }
    try {
      ctrl.postMessage({ kind: 'stats', port: chan.port2 }, [chan.port2])
    } catch {
      clearTimeout(done)
      resolve(null)
    }
  })
}

/** Bytes of the assets the page downloaded (transferSize, or their size when the browser reports none). */
function assetBytes(): number {
  let carried = 0
  for (const e of performance.getEntriesByType('resource')) {
    const r = e as PerformanceResourceTiming
    carried += r.transferSize || r.decodedBodySize || 0
  }
  return carried
}

/** Ends the journal with what the load carried. Asked after the project is ready: it never waits
 * for the page, and a Service Worker or a browser that answers nothing leaves the line at 0. */
export async function markBytes() {
  if (seen.has('bytes')) return
  const sw = await swBytes()
  loadMark('bytes', {
    tunnel: sw?.tunnel ?? assetBytes(),
    cache: sw?.cache ?? 0,
    socket: socketBytes.down + socketBytes.up,
  })
  console.info(loadJournalText())
}
