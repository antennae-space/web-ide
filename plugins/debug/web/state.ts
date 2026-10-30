// The debug sessions of the worktree shown, as the pod tells them (debug.session, debug.stopped,
// debug.output…), and what the Debug tool shows of each: its threads, the frames of the paused
// thread, the scopes and the variables of the selected frame, its console. The threads, the
// frames and the variables stay lazy: a row asks for its children when it opens, and all of it is
// dropped when the program runs again.
import { batch } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { api, errorToast, relOf, t } from './plugin'
import { onEnd } from './focus'

export interface Session {
  id: string
  name: string
  type: string
  pack: string
  request: string
  state: 'starting' | 'running' | 'stopped' | 'ended'
  thread?: number
  file?: string
  line?: number
}
export interface Thread {
  id: number
  name: string
}
export interface Frame {
  id: number
  name: string
  line: number
  column?: number
  source?: { path?: string; name?: string }
  presentationHint?: string
}
export interface Scope {
  name: string
  variablesReference: number
  expensive?: boolean
}
export interface Variable {
  name: string
  value: string
  type?: string
  variablesReference: number
  evaluateName?: string
  presentationHint?: { kind?: string; attributes?: string[]; visibility?: string }
}
export interface OutputLine {
  category: string
  text: string
}

/** What the tool shows of one session. */
export interface SessionView {
  threads: Thread[]
  thread?: number
  frames: Frame[]
  frame?: number
  scopes: Scope[]
  /** The children of a variablesReference, once a row opened it. */
  vars: Record<number, Variable[]>
  /** The rows opened, by their path of names (scope/name/name). */
  open: Record<string, boolean>
  output: OutputLine[]
  /** It stopped once: the next stops do not bring the tool up again. */
  stoppedOnce: boolean
  /** The library frames are shown (folded by default). */
  libraries: boolean
}

const emptyView = (): SessionView => ({ threads: [], frames: [], scopes: [], vars: {}, open: {}, output: [], stoppedOnce: false, libraries: false })

/** The most lines a console keeps. */
const MAX_OUTPUT = 5000

export const [debug, setDebug] = createStore<{ sessions: Session[]; selected?: string; views: Record<string, SessionView>; tab: 'frames' | 'console' }>({
  sessions: [],
  views: {},
  tab: 'frames',
})

export const selected = () => debug.sessions.find((s) => s.id === debug.selected)
export const viewOf = (id?: string) => (id ? debug.views[id] : undefined)
const ensureView = (id: string) => {
  if (!debug.views[id]) setDebug('views', id, emptyView())
}

/** The sessions the pod said ended: an answer of start arriving after the end does not bring one back. */
const ended = new Set<string>()

/** Puts a session in the list, or ends it there. */
export function upsertSession(s: Session) {
  if (s.state !== 'ended' && ended.has(s.id)) return
  batch(() => {
    if (s.state === 'ended') {
      ended.add(s.id)
      setDebug('sessions', (l) => l.filter((x) => x.id !== s.id))
      if (debug.selected === s.id) setDebug('selected', debug.sessions[debug.sessions.length - 1]?.id)
      setDebug('views', produce((v) => void delete v[s.id]))
      return
    }
    ensureView(s.id)
    const i = debug.sessions.findIndex((x) => x.id === s.id)
    if (i < 0) setDebug('sessions', (l) => [...l, s])
    else setDebug('sessions', i, s)
    if (!debug.selected) setDebug('selected', s.id)
    // Running again: what the pause showed is gone.
    if (s.state === 'running') setDebug('views', s.id, (v) => ({ ...v, frames: [], frame: undefined, scopes: [], vars: {} }))
  })
}

/** The library frames: outside the worktree (the Go module cache, GOROOT). */
export const isLibrary = (f: Frame) => !f.source?.path || relOf(f.source.path) === undefined || f.presentationHint === 'subtle'

/** Reads the threads and the frames of a paused session, then the variables of its frame. */
export async function loadStop(id: string, thread?: number) {
  ensureView(id)
  try {
    const th = await api.rpc<{ threads: Thread[] }>('threads', { session: id })
    const tid = thread || debug.sessions.find((s) => s.id === id)?.thread || th.threads?.[0]?.id
    const st = await api.rpc<{ stackFrames: Frame[] }>('stack', { session: id, thread: tid })
    const frames = st.stackFrames ?? []
    setDebug('views', id, (v) => ({ ...v, threads: th.threads ?? [], thread: tid, frames, vars: {} }))
    const top = frames[0]
    if (top) await selectFrame(id, top.id)
  } catch (e) {
    errorToast(e)
  }
}

/** Selects a frame: its scopes, and the variables of the first cheap one (the locals). */
export async function selectFrame(id: string, frame: number) {
  setDebug('views', id, (v) => ({ ...v, frame, scopes: [] }))
  const sc = await api.rpc<{ scopes: Scope[] }>('scopes', { session: id, frame })
  const scopes = sc.scopes ?? []
  setDebug('views', id, 'scopes', scopes)
  const first = scopes.find((s) => !s.expensive)
  if (first) {
    setDebug('views', id, 'open', first.name, true)
    await loadVars(id, first.variablesReference)
  }
}

/** Selects a thread: its frames. */
export async function selectThread(id: string, thread: number) {
  setDebug('views', id, 'thread', thread)
  try {
    const st = await api.rpc<{ stackFrames: Frame[] }>('stack', { session: id, thread })
    setDebug('views', id, (v) => ({ ...v, frames: st.stackFrames ?? [], vars: {} }))
    const top = st.stackFrames?.[0]
    if (top) await selectFrame(id, top.id)
  } catch (e) {
    errorToast(e)
  }
}

/** The children of a variable or a scope, asked once. */
export async function loadVars(id: string, ref: number) {
  if (!ref || viewOf(id)?.vars[ref]) return
  try {
    const r = await api.rpc<{ variables: Variable[] }>('variables', { session: id, reference: ref })
    if (viewOf(id)) setDebug('views', id, 'vars', ref, r.variables ?? [])
  } catch (e) {
    errorToast(e)
  }
}

export function toggleRow(id: string, key: string, ref: number) {
  const open = !viewOf(id)?.open[key]
  setDebug('views', id, 'open', key, open)
  if (open) void loadVars(id, ref)
}

/** Adds output to the console of a session. */
export function addOutput(id: string, category: string, text: string) {
  if (!text) return
  ensureView(id)
  setDebug('views', id, 'output', (l) => {
    const next = [...l, { category, text }]
    return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next
  })
}

/** Evaluates an expression of the console in the selected frame. */
export async function evaluate(id: string, expression: string) {
  const v = viewOf(id)
  addOutput(id, 'input', `> ${expression}\n`)
  try {
    const r = await api.rpc<{ result: string; type?: string }>('evaluate', { session: id, expression, frame: v?.frame ?? 0 })
    addOutput(id, 'result', `${r.result}\n`)
  } catch (e) {
    addOutput(id, 'stderr', `${(e as Error).message}\n`)
  }
}

/** The sessions of the worktree shown, read again (a reconnection, another worktree shown). */
export async function refreshSessions() {
  try {
    const list = await api.rpc<Session[]>('sessions')
    batch(() => {
      const ids = new Set(list.map((s) => s.id))
      setDebug('sessions', (l) => l.filter((s) => ids.has(s.id)))
      for (const s of list) upsertSession(s)
      if (debug.selected && !ids.has(debug.selected)) setDebug('selected', list[0]?.id)
    })
    for (const s of list) if (s.state === 'stopped' && !viewOf(s.id)?.frames.length) void loadStop(s.id, s.thread)
  } catch {
    // No debug host on this project (a pod without the plugin's backend): nothing to show.
  }
}

/** The session the run actions act on: the selected one, else the latest. */
export const current = () => selected() ?? debug.sessions[debug.sessions.length - 1]

/** A run action on the current session: continue, a step, pause, stop. */
export async function act(method: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' | 'stop' | 'restart') {
  const s = current()
  if (!s) return false
  const v = viewOf(s.id)
  if ((method === 'continue' || method === 'next' || method === 'stepIn' || method === 'stepOut') && s.state !== 'stopped') return false
  if (method === 'pause' && s.state !== 'running') return false
  try {
    const r = await api.rpc<Session | null>(method, { session: s.id, thread: v?.thread ?? s.thread ?? 0 })
    if (method === 'restart' && r) {
      upsertSession(r)
      setDebug('selected', r.id)
    }
  } catch (e) {
    // The pod no longer has it (it ended while the window missed it): the tab goes.
    const gone = !(await api.rpc<Session[]>('sessions').catch(() => [] as Session[])).some((x) => x.id === s.id)
    if (gone) {
      upsertSession({ ...s, state: 'ended' })
      onEnd()
    } else errorToast(e)
  }
}

/** Starts a configuration of .ide/debug.json by name, or one given as it is (a template). */
export async function start(o: { name?: string; config?: Record<string, unknown> }) {
  const active = api.activeFile()
  try {
    const s = await api.rpc<Session>('start', { ...o, file: active ? relOf(active) ?? '' : '' })
    batch(() => {
      upsertSession(s)
      setDebug('selected', s.id)
    })
    api.showTool('debug')
    return s
  } catch (e) {
    errorToast(e)
  }
}

export const stateLabel = (s: Session) =>
  ({ starting: t('Starting'), running: t('Running'), stopped: t('Paused'), ended: t('Ended') })[s.state] ?? s.state
