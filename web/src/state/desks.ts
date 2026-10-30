// Desks of the project of the window (docs/design/desks.md): each desk is a session of its own (its
// layout, tabs and tools), as the virtual desktops of a desktop environment. The window shows
// one; the list and what the desks share (the Recent Files) come with project.open and are
// saved by desks.update. The desk shown is also remembered per device: /project/:id opens it.
import { createSignal } from 'solid-js'
import { createStore, produce, reconcile, unwrap } from 'solid-js/store'
import { notify, on, request } from '../pod/rpc'
import { route } from '../app/router'

export interface Desk {
  n: number
  name?: string
  /** Full: rails and tool zones; Grid and Scroll: tiles only (state/tiles.ts). */
  mode: 'full' | 'grid' | 'scroll'
}

export interface DeskList {
  desks: Desk[]
  recent: string[]
}

const emptyList = (): DeskList => ({ desks: [{ n: 1, mode: 'full' }], recent: [] })

const [desk, setDesk] = createSignal(1)
const [desks, setDesks] = createStore<DeskList>(emptyList())
export { desk, desks }

/** Project whose desks are loaded (events of another project are ignored). */
let owner = ''

/** Sets the desks of the project opened in the window. */
export function loadDesks(project: string, list: DeskList | null | undefined, shown: number) {
  owner = project
  setDesks(reconcile(list?.desks?.length ? { desks: list.desks, recent: list.recent ?? [] } : emptyList()))
  showDesk(shown)
}

/** Records the desk the window shows. */
export function showDesk(n: number) {
  setDesk(n)
  usedDesk()
  try {
    localStorage.setItem(`desk:${owner}`, String(n))
  } catch {
    /* no storage: the window opens desk 1 */
  }
}

/**
 * Tells the pod the desk of the window is the one in use (shown, or the window back in front): the
 * home page of any device opens it. Not from a detached window, which shows desk 1 for a tool.
 */
export function usedDesk() {
  if (owner && route().name === 'project') notify('desks.used', { desk: desk() })
}
window.addEventListener('focus', usedDesk)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && usedDesk())

/** The desk last used of each project, on any device (desks.last of the pod, loaded by the home page). */
const [lastUsed, setLastUsed] = createSignal<Record<string, number>>({})
export async function loadLastDesks() {
  setLastUsed(await request<Record<string, number>>('desks.last').catch(() => ({})))
}

/** The desk the home page opens for a project: the last used on any device, else the last shown on this one (1 when none). */
export function lastDesk(project: string): number {
  if (lastUsed()[project]) return lastUsed()[project]
  try {
    return Number(localStorage.getItem(`desk:${project}`)) || 1
  } catch {
    return 1
  }
}

export function closeDesks() {
  owner = ''
  setDesks(reconcile(emptyList()))
  setDesk(1)
}

export const deskLabel = (d: Desk) => d.name || String(d.n)

/** The key of desk n of a project (pod/desks Key): the project id for desk 1, `<id>@<n>` else. */
export const deskKey = (project: string, n: number) => (n <= 1 ? project : `${project}@${n}`)

// ---------- what lives on a desk ----------

/** What a plugin ends with a desk removed: the items listed in the confirmation, and the end. */
export interface DeskEnd {
  items: string[]
  end: () => Promise<void>
}

const enders = new Set<(n: number) => DeskEnd | null>()

/** Registers what a plugin has on the desks (its consoles…), asked before a desk is removed. */
export function onDeskRemove(f: (n: number) => DeskEnd | null) {
  enders.add(f)
  return () => enders.delete(f)
}

/** What ends with desk n, from every plugin. */
export function deskEnds(n: number): DeskEnd[] {
  return [...enders].map((f) => f(n)).filter((e): e is DeskEnd => !!e && e.items.length > 0)
}

/** Something of a plugin dragged (a console tab): a desk of the bar takes it and moves it there. */
const [deskDrag, setDeskDrag] = createSignal<((n: number) => void) | null>(null)
export { deskDrag, setDeskDrag }

let pushTimer: number | undefined

function changeDesks(fn: (d: DeskList) => void, now = false) {
  setDesks(produce(fn))
  clearTimeout(pushTimer)
  pushTimer = undefined
  if (now) void request('desks.update', { desks: unwrap(desks) })
  else
    pushTimer = window.setTimeout(() => {
      pushTimer = undefined
      notify('desks.update', { desks: unwrap(desks) })
    }, 400)
}

// A reload or a closed window sends the change still waiting (a recent file).
window.addEventListener('pagehide', () => {
  if (pushTimer === undefined) return
  clearTimeout(pushTimer)
  pushTimer = undefined
  notify('desks.update', { desks: unwrap(desks) })
})

/** Adds a desk after the last one; answers its number. */
export async function addDesk(): Promise<number> {
  const n = Math.max(...desks.desks.map((d) => d.n)) + 1
  clearTimeout(pushTimer)
  pushTimer = undefined
  setDesks(produce((d) => d.desks.push({ n, mode: 'full' })))
  await request('desks.update', { desks: unwrap(desks) })
  return n
}

export function renameDesk(n: number, name: string) {
  changeDesks((d) => {
    const x = d.desks.find((x) => x.n === n)
    if (x) x.name = name.trim() || undefined
  }, true)
}

export function setDeskMode(n: number, mode: Desk['mode']) {
  changeDesks((d) => {
    const x = d.desks.find((x) => x.n === n)
    if (x) x.mode = mode
  }, true)
}

/** Removes a desk (not desk 1): its session goes with it, the files stay open elsewhere. */
export function removeDesk(n: number) {
  if (n === 1) return
  changeDesks((d) => {
    d.desks = d.desks.filter((x) => x.n !== n)
  }, true)
}

// ---------- recent files ----------

const maxRecent = 50

/** Puts a file at the top of the recent files. */
export function touchRecent(path: string) {
  if (desks.recent[0] === path) return
  changeDesks((d) => {
    d.recent = [path, ...d.recent.filter((p) => p !== path)].slice(0, maxRecent)
  })
}

export function forgetRecent(path: string) {
  changeDesks((d) => {
    d.recent = d.recent.filter((p) => p !== path)
  })
}

/** Desk list changed by another window; a window on a removed desk is told by `onDeskGone`. */
let gone: (() => void) | undefined
export function onDeskGone(f: () => void) {
  gone = f
}

on('desks.changed', (list: DeskList, from?: string) => {
  if (!owner || (from && from !== owner)) return
  setDesks(reconcile({ desks: list.desks, recent: list.recent ?? [] }))
  if (!desks.desks.some((d) => d.n === desk())) gone?.()
})
