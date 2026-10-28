// The decoration of a path, answered the same way for every tree of the window (#183): the
// Explorer, Recent Files, the Commit tab and Search results ask `decoratePath`, so a file looks
// the same wherever it appears.
import { createMemo, createRoot } from 'solid-js'
import { capability } from './capabilities'
import { fileDecorations } from './registry'
import { root } from '../state/project'
import type { FileDecoration } from './types'

/**
 * A decoration, with what the core itself knows of the path: `decorate()` answers the channels of
 * the plugins, `error` is the mark of a language server (#184).
 */
export interface PathDecoration extends FileDecoration {
  /** A file a language server reports in error, or a folder holding one below it. */
  error: boolean
}

/**
 * The files in error and every folder above them, built once from `errorPaths()` of the language
 * capability and followed as the servers publish. A row only asks whether it is in the set.
 */
export const errorMarked = createRoot(() =>
  createMemo(() => {
    const marked = new Set<string>()
    const r = root()
    for (const p of capability('language')?.errorPaths() ?? []) {
      let cur = p
      while (cur.length > r.length && cur.startsWith(r + '/')) {
        marked.add(cur)
        cur = cur.slice(0, cur.lastIndexOf('/'))
      }
    }
    return marked
  }),
)

/**
 * The decoration of a path, merged channel by channel from what the enabled plugins know of it
 * (#179): a plugin answers with `decorate()`, or with the deprecated `state()`, folded into the
 * `state` channel. A channel no plugin fills stays undefined: the tree takes the one its folder
 * passes down, or its own fallback.
 */
export function decorateEntry(path: string, dir: boolean): FileDecoration {
  const merged: FileDecoration = {}
  for (const d of fileDecorations()) {
    const part = d.decorate ? d.decorate(path, dir) : d.state ? { state: d.state(path, dir) ?? undefined } : null
    if (!part) continue
    if (merged.state === undefined) merged.state = part.state
    if (merged.badge === undefined) merged.badge = part.badge
    if (merged.kind === undefined) merged.kind = part.kind
    if (merged.tint === undefined) merged.tint = part.tint
    if (merged.label === undefined) merged.label = part.label
  }
  return merged
}

/** The merged channels of the plugins, and the error mark of the core. */
export function decoratePath(path: string, dir: boolean): PathDecoration {
  return { ...decorateEntry(path, dir), error: errorMarked().has(path) }
}
