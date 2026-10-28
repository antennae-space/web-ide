// Folder marks of the open project (source, tests, excluded), kept by the pod in
// .ide/folders.json. Excluded folders are left out of the search and "go to file".
import { createSignal } from 'solid-js'
import { on, request } from '../pod/rpc'
import { project, root } from './project'
import { errorToast } from '../ui/toast'

export type FolderMark = 'source' | 'tests' | 'excluded'

const [marks, setMarks] = createSignal<Record<string, FolderMark>>({})
let loadedFor = ''

on('folders.changed', (m: Record<string, FolderMark>, from) => (!from || from === project()?.id) && setMarks(m ?? {}))

/** Loads the marks once per project root. */
export async function loadFolderMarks() {
  const r = root()
  if (!r || loadedFor === r) return
  loadedFor = r
  try {
    setMarks((await request<Record<string, FolderMark>>('folders.get')) ?? {})
  } catch {
    setMarks({})
  }
}

const rel = (path: string) => (path.startsWith(root() + '/') ? path.slice(root().length + 1) : '')

/** Mark of a folder itself. */
export function folderMark(path: string): FolderMark | null {
  return marks()[rel(path)] ?? null
}

/** Mark of the nearest marked folder above the path (the root itself is never a mark). */
export function markOf(path: string): FolderMark | null {
  const r = rel(path)
  let best: string | null = null
  for (const k of Object.keys(marks())) {
    if (!k || r === k || !r.startsWith(k + '/')) continue
    if (!best || k.length > best.length) best = k
  }
  return best ? marks()[best] : null
}

/** True when the path is an excluded folder or inside one. */
export function inExcluded(path: string): boolean {
  return folderMark(path) === 'excluded' || markOf(path) === 'excluded'
}

export async function markFolder(path: string, mark: FolderMark | '') {
  try {
    setMarks(await request<Record<string, FolderMark>>('folders.mark', { path, mark }))
  } catch (e) {
    errorToast(e)
  }
}
