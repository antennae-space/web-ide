// The breakpoints in the file view of Code (editorDecorations, #187): a click in the lane of the
// gutter toggles a line breakpoint, kept in .ide/breakpoints.json of the worktree by the pod; the
// marks follow the edits of the buffer and the new lines are saved with the file. The line where
// the program stopped is highlighted, the line of the selected frame in another tint.
import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { EditorDecorations } from '@ide/types'
import { api, errorToast, relOf, t } from './plugin'
import { debug, viewOf } from './state'

/** A breakpoint as .ide/breakpoints.json keeps it (lines from 1). */
export interface Breakpoint {
  line: number
  condition?: string
  hitCondition?: string
  logMessage?: string
  enabled: boolean
}

/** The breakpoints of the worktree shown, by file relative to it. */
export const [breakpoints, setBreakpoints] = createStore<Record<string, Breakpoint[]>>({})
/** Lines moved by an edit and not saved yet, by file: sent to the pod when the file is saved. */
const pending = new Set<string>()

/** The languages an adapter of the packs debugs: only their files take breakpoints (a lane). */
const [languages, setLanguages] = createSignal<string[]>([])
const debuggable = (path: string) => {
  const lang = api.editor.serverLanguage(path)
  return !!lang && languages().includes(lang)
}

export async function refreshBreakpoints() {
  try {
    const ds = await api.rpc<{ languages?: string[] }[]>('debuggers')
    setLanguages([...new Set(ds.flatMap((d) => d.languages ?? []))])
    const all = await api.rpc<Record<string, Breakpoint[]>>('breakpoints')
    setBreakpoints((cur) => {
      const next: Record<string, Breakpoint[] | undefined> = { ...all }
      for (const k of Object.keys(cur)) if (!(k in all)) next[k] = undefined
      return next as Record<string, Breakpoint[]>
    })
  } catch {
    // No debug host here.
  }
}

/** Saves the breakpoints of a file: the pod keeps them and sends them to the live sessions. */
async function save(file: string, list: Breakpoint[]) {
  setBreakpoints(file, list.length ? list : undefined!)
  try {
    await api.rpc('setBreakpoints', { file, breakpoints: list })
  } catch (e) {
    errorToast(e)
  }
}

/** Puts or takes back the breakpoint of a line (0-based) of a file. */
export function toggleBreakpoint(path: string, line0: number) {
  const file = relOf(path)
  if (!file) return api.ui.toast(t('A breakpoint goes in a file of the worktree'), 'info')
  if (!debuggable(path) && !breakpoints[file]) return api.ui.toast(t('No debugger of the language packs debugs this file'), 'info')
  const list = breakpoints[file] ?? []
  const line = line0 + 1
  const next = list.some((b) => b.line === line) ? list.filter((b) => b.line !== line) : [...list, { line, enabled: true }]
  void save(file, next)
}

/** The line where the program of the selected session is (its top frame), and the selected frame. */
function stopLines(path: string) {
  const s = debug.sessions.find((x) => x.id === debug.selected)
  if (!s || s.state !== 'stopped') return []
  const v = viewOf(s.id)
  const out: { id: string; line: number; class: string }[] = []
  const top = v?.frames[0]
  const execFile = top?.source?.path ?? s.file
  const execLine = top?.line ?? s.line
  if (execFile && execLine && execFile === path) out.push({ id: 'exec', line: execLine - 1, class: 'dbg-exec-line' })
  const f = v?.frames.find((x) => x.id === v.frame)
  if (f && f !== top && f.source?.path === path && f.line) out.push({ id: 'frame', line: f.line - 1, class: 'dbg-frame-line' })
  return out
}

/** Watches the saves: the lines an edit moved go to the pod with the file. */
export function watchSaves() {
  api.buffers.onSave((doc) => {
    const file = relOf(doc.path)
    if (!file || !pending.has(file)) return
    pending.delete(file)
    void save(file, breakpoints[file] ?? [])
  })
}

export const decorations: EditorDecorations = {
  gutter: (path) => {
    const file = relOf(path)
    if (!file || (!debuggable(path) && !breakpoints[file])) return undefined
    const marks = (breakpoints[file] ?? []).map((b) => ({
      id: `bp${b.line}`,
      line: b.line - 1,
      class: b.enabled ? 'dbg-bp' : 'dbg-bp dbg-bp-off',
      title: b.condition ? t('Breakpoint: {condition}', { condition: b.condition }) : t('Line breakpoint'),
    }))
    const s = debug.sessions.find((x) => x.id === debug.selected)
    const top = s && viewOf(s.id)?.frames[0]
    const execFile = top?.source?.path ?? s?.file
    const execLine = top?.line ?? s?.line
    if (s?.state === 'stopped' && execFile === path && execLine) marks.push({ id: 'exec', line: execLine - 1, class: 'dbg-exec', title: t('The program is here') })
    return marks
  },
  lines: (path) => {
    const out = stopLines(path)
    return out.length ? out : undefined
  },
  gutterClick: (path, line) => toggleBreakpoint(path, line),
  gutterMenu: (path, line) => {
    const file = relOf(path)
    if (!file) return []
    const has = (breakpoints[file] ?? []).some((b) => b.line === line + 1)
    return [{ label: has ? t('Remove the breakpoint') : t('Add a breakpoint'), action: () => toggleBreakpoint(path, line) }]
  },
  moved: (path, marks) => {
    const file = relOf(path)
    if (!file) return
    const byId = new Map(marks.map((m) => [m.id, m]))
    const next = (breakpoints[file] ?? []).flatMap((b) => {
      const m = byId.get(`bp${b.line}`)
      if (!m) return [b]
      return m.removed ? [] : [{ ...b, line: m.line + 1 }]
    })
    setBreakpoints(file, next.length ? next : undefined!)
    pending.add(file)
  },
}
