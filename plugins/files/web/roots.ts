// The roots of the Explorer (docs/design/explorer.md): the project and Scratches and Consoles are
// the Files plugin's, the others come from the plugins (`explorerRoots`). The user orders the
// roots of a desk and folds them; the desk of Files keeps both, and the nodes left open.
import type { ExplorerRoot } from '@ide/types'
import { api, desk, t } from './plugin'

/** The id of the root of the project, the one root drawn with the file tree. */
export const PROJECT = 'files'

export const projectRoot: ExplorerRoot = {
  id: PROJECT,
  label: () => api.project.name() ?? api.project.basename(api.project.root()),
  icon: 'folder',
  order: 20,
  nodes: () => [],
}

/** Filled by the other plugins (`explorerNodes.scratches`): the SQL consoles. */
export const scratchesRoot: ExplorerRoot = { id: 'scratches', label: () => t('Scratches and Consoles'), icon: 'file', order: 30, nodes: () => [] }

/**
 * Every root of the enabled plugins, in the order of the desk. A root the desk does not list yet
 * (a plugin enabled since) takes its place by default among the others.
 */
export function orderedRoots(): ExplorerRoot[] {
  const all = api.explorer.roots()
  const saved = desk.get().roots
  const out = saved.flatMap((id) => all.filter((r) => r.id === id))
  for (const r of [...all].sort((a, b) => a.order - b.order)) {
    if (saved.includes(r.id)) continue
    const i = out.findIndex((o) => o.order > r.order)
    if (i < 0) out.push(r)
    else out.splice(i, 0, r)
  }
  return out
}

/** A root shows when it has a node; the project always does. */
export const isShown = (r: ExplorerRoot, nodes: number) => r.id === PROJECT || nodes > 0

/** Moves a root before another one (a drop), or to the end when before is undefined. */
export function placeRoot(id: string, before?: string) {
  const order = orderedRoots()
    .map((r) => r.id)
    .filter((x) => x !== id)
  const i = before ? order.indexOf(before) : -1
  if (i < 0) order.push(id)
  else order.splice(i, 0, id)
  desk.set((s) => {
    s.roots = order
  })
}

/** Moves a root one place up or down among the roots shown (shown: their ids, in order). */
export function moveRoot(id: string, delta: -1 | 1, shown: string[]) {
  const i = shown.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= shown.length) return
  if (delta < 0) placeRoot(id, shown[j])
  else placeRoot(id, shown[j + 1])
}

export const isFolded = (id: string) => desk.get().foldedRoots.includes(id)

export function setFolded(id: string, folded: boolean) {
  desk.set((s) => {
    const i = s.foldedRoots.indexOf(id)
    if (folded && i < 0) s.foldedRoots.push(id)
    if (!folded && i >= 0) s.foldedRoots.splice(i, 1)
  })
}

/** A node with children is closed until the user opens it; key: `<root>/<id>/<id>…`. */
export const isNodeOpen = (key: string) => desk.get().openNodes.includes(key)

export function setNodeOpen(key: string, open: boolean) {
  desk.set((s) => {
    const i = s.openNodes.indexOf(key)
    if (open && i < 0) s.openNodes.push(key)
    if (!open && i >= 0) s.openNodes.splice(i, 1)
  })
}
