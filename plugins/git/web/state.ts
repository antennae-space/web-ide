// Git state of the worktree shown, refreshed after file changes and Git actions: the git service
// of the plugin (explorer colors, project bar, editor markers).
import { createEffect, createMemo, createRoot, createSignal, on as track } from 'solid-js'
import type { FileGitState, GitFile, GitStatus } from '@ide/capabilities'
import { api } from './plugin'

export type { GitFile, GitStatus, FileGitState }

const [status, setStatus] = createSignal<GitStatus | null>(null)
const [revision, setRevision] = createSignal(0)
export { status as gitStatus }
/** Bumped when HEAD or the index may have changed (diffs and markers are recomputed). */
export const gitRevision = revision

let timer: number | undefined
let running = false
let again = false

export function refreshGit(delay = 400) {
  clearTimeout(timer)
  timer = window.setTimeout(load, delay)
}

async function load() {
  if (!api.project.current()) return
  if (running) {
    again = true
    return
  }
  running = true
  try {
    const st = await api.rpc<GitStatus>('status')
    // A commit made in a terminal moves HEAD without any event of the pod.
    if (status() && st.head !== status()!.head) setRevision((r) => r + 1)
    setStatus(st)
  } catch {
    setStatus(null)
  } finally {
    running = false
    if (again) {
      again = false
      refreshGit(100)
    }
  }
}

/** Starts following the repository: the events of the pod, the worktree shown, the focus. */
export function watchGit() {
// Events of another worktree attached to the window do not change the one shown.
const shown = (from?: string) => !from || from === api.project.current()
api.on('git.changed', (_, from) => {
  if (!shown(from)) return
  setRevision((r) => r + 1)
  refreshGit(50)
})
// A file written, created or removed anywhere in the project.
api.on('fs.dir', (e: { path: string }, from) => {
  if (!shown(from)) return
  if (e.path.includes('/.git')) setRevision((r) => r + 1)
  refreshGit()
})
api.on('fs.changed', (_, from) => shown(from) && refreshGit())
// Another worktree shown in the window.
createRoot(() =>
  createEffect(
    track(
      () => api.project.current(),
      (id, prev) => {
        if (!id || !prev) return
        setRevision((r) => r + 1)
        refreshGit(0)
      },
    ),
  ),
)
window.addEventListener('focus', () => {
  setRevision((r) => r + 1)
  refreshGit(100)
})
}

// A column of `git status`: what changed in the worktree, what changed in the index.
type GitColumn = FileGitState

/** Worktree column: `M`/`T` modified, `D` deleted, `C` conflict, `?` untracked, `.` nothing. */
function workOf(f: GitFile): GitColumn | null {
  if (f.untracked) return 'untracked'
  if (f.conflict) return 'conflict'
  switch (f.work) {
    case 'M':
    case 'T':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'C':
      return 'conflict'
    case '?':
      return 'untracked'
  }
  return null
}

/** Index column: `M`/`T`/`R` staged, `A` added, `D` deleted, `C` conflict, `.` nothing. */
function indexOf(f: GitFile): GitColumn | null {
  if (f.conflict) return 'conflict'
  switch (f.index) {
    case 'M':
    case 'T':
    case 'R':
      return 'staged'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'C':
      return 'conflict'
  }
  return null
}

/** Color state of a file: the strongest of its two columns. */
function stateOf(f: GitFile): FileGitState {
  const w = workOf(f)
  const i = indexOf(f)
  if (w === 'conflict' || i === 'conflict') return 'conflict'
  if (w === 'untracked') return 'untracked'
  if (w === 'deleted' || i === 'deleted') return 'deleted'
  if (i === 'added') return 'added'
  if (w === 'modified') return 'modified'
  if (i) return 'staged'
  return 'modified'
}

const letterOf: Record<FileGitState, string> = { modified: 'M', staged: 'M', added: 'A', untracked: 'U', deleted: 'D', conflict: 'C' }

/** Arrows of the columns, as JetBrains IDEs: `↓` a change in the worktree, `↑` a change in the index. */
function arrows(st: FileGitState, w: GitColumn | null, i: GitColumn | null) {
  if (st === 'untracked' || st === 'conflict') return ''
  return (w ? '↓' : '') + (i ? '↑' : '')
}

// States and status letters by file, and what sits under each folder, recomputed with the status.
interface FileGitInfo {
  state: FileGitState
  badge: string
  work: GitColumn | null
  index: GitColumn | null
}
interface DirGitInfo {
  states: Set<FileGitState>
  work: boolean
  index: boolean
}

const states = createRoot(() =>
  createMemo(() => {
    const files = new Map<string, FileGitInfo>()
    const dirs = new Map<string, DirGitInfo>()
    for (const f of status()?.files ?? []) {
      const work = workOf(f)
      const index = indexOf(f)
      const st = stateOf(f)
      files.set(f.path, { state: st, badge: letterOf[st] + arrows(st, work, index), work, index })
      for (let i = f.path.lastIndexOf('/'); i > 0; i = f.path.lastIndexOf('/', i - 1)) {
        const d = f.path.slice(0, i)
        const info = dirs.get(d) ?? { states: new Set<FileGitState>(), work: false, index: false }
        info.states.add(st)
        info.work ||= work !== null
        info.index ||= index !== null
        dirs.set(d, info)
      }
    }
    return { files, dirs }
  }),
)

/** Git state of a file in the working tree view (explorer colors). */
export function fileState(path: string): FileGitState | null {
  return states().files.get(path)?.state ?? null
}

/** Status letter of a file and the arrows of its columns: `M↓` worktree, `M↑` index, `M↓↑` both. */
export function fileBadge(path: string): string | null {
  return states().files.get(path)?.badge ?? null
}

/** Git state of a folder from its content: untracked or added when all its changes are, modified otherwise. */
export function dirState(dir: string): FileGitState | null {
  const info = states().dirs.get(dir)
  if (!info) return null
  if (info.states.has('conflict')) return 'conflict'
  if (info.states.size === 1 && (info.states.has('untracked') || info.states.has('added'))) return [...info.states][0]
  return 'modified'
}

/** Status letter of a folder: the letter of its state, with the arrows of the changes found below it. */
export function dirBadge(dir: string): string | null {
  const st = dirState(dir)
  if (!st) return null
  const info = states().dirs.get(dir)!
  return letterOf[st] + arrows(st, info.work ? 'modified' : null, info.index ? 'staged' : null)
}

/** True when a folder contains changes (explorer). */
export function dirChanged(dir: string): boolean {
  return states().dirs.has(dir)
}
