// Structure tool: the symbols of the active file (classes, functions, methods), from its server,
// as a tree — or, with "Show Package Structure", the symbols of the whole package: one node per
// file of the active file's folder served by the same language server, its symbols under it. A
// twisty folds the children of a symbol or of a file node (the folded state is kept per file in
// the desk), one click selects a row, a double click jumps to it (one click with "Navigate with
// Single Click"), a lock next to the glyph tells an exported symbol from a private one (the rules
// of web/visibility.json), the ⋮ of its zone or of its tile holding the choices of the tree (the
// plugin's `toolMenu` contribution). Speed Search filters the rows by typing (or Ctrl+F) while the
// tree has the focus, highlighting what the query matches; "Always Select Opened Element" keeps the
// row of the symbol around the caret selected.
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, untrack, type JSX } from 'solid-js'
import type { MenuItem } from '@ide/api'
import { api, desk, EmptyState, Icon, t } from './plugin'
import {
  dirOf,
  documentSymbols,
  enclosingSymbols,
  fileSymbol,
  filterPrivate,
  filterSymbols,
  fuzzyMarks,
  packageFiles,
  packageSymbols,
  rowKey,
  sortByExportability,
  sortSymbols,
  symbolId,
  treeRows,
  type DocumentSymbol,
  type TreeRow,
} from './client'
import { SymGlyph } from './glyph'

/** A name or a detail, with the characters the Speed Search query hit set apart. */
function Marked(props: { text: string; query: string }) {
  const parts = () => {
    const at = fuzzyMarks(props.query, props.text)
    if (!at.length) return [{ s: props.text, hit: false }]
    const out: { s: string; hit: boolean }[] = []
    let i = 0
    while (i < props.text.length) {
      const hit = at.includes(i)
      let j = i
      while (j < props.text.length && at.includes(j) === hit) j++
      out.push({ s: props.text.slice(i, j), hit })
      i = j
    }
    return out
  }
  return <For each={parts()}>{(p) => (p.hit ? <mark>{p.s}</mark> : <>{p.s}</>)}</For>
}

const activePath = () => (api.activeFile() ?? '')

/** The tree each file was last shown with: the commands work even when the tool is closed. */
const shownTrees = new Map<string, DocumentSymbol[]>()
/** The package tree each folder was last shown with: its file nodes, the files seen, the files kept. */
interface PackageTree {
  tree: DocumentSymbol[]
  total: number
  shown: number
}

const packageTrees = new Map<string, PackageTree>()

/**
 * The package tree of a file: one node per sibling file of the same language server, its symbols
 * as children. Cached by folder; a `fs` event drops it (see the listeners of the tool).
 */
async function packageTreeOf(path: string): Promise<PackageTree> {
  const dir = dirOf(path)
  const known = packageTrees.get(dir)
  if (known) return known
  const { files, total } = await packageFiles(path)
  const found = await packageSymbols(files)
  for (const p of files) shownTrees.set(p, found.get(p) ?? [])
  const tree = files.map((p) => ({ ...fileSymbol(p), children: found.get(p) ?? [] }))
  const entry = { tree, total, shown: files.length }
  packageTrees.set(dir, entry)
  return entry
}

/** Drops the cached trees of a folder (and of the files it holds). */
function forgetPackage(dir: string) {
  const entry = packageTrees.get(dir)
  if (!entry) return false
  packageTrees.delete(dir)
  for (const node of entry.tree) shownTrees.delete(node.file!)
  return true
}

/** The tree each file was last shown with, fetched when the tool has not seen it. */
async function treeOf(path: string): Promise<DocumentSymbol[]> {
  const known = shownTrees.get(path)
  if (known) return known
  const list = await documentSymbols(path).catch(() => [] as DocumentSymbol[])
  shownTrees.set(path, list)
  return list
}

/** The folded ids of the given files, keyed by file so two files never share a fold. */
function foldedIds(files: string[]): Set<string> {
  const out = new Set<string>()
  const all = desk.get().folded
  for (const f of files) for (const id of all[f] ?? []) out.add(rowKey(f, id))
  return out
}

function setFolded(path: string, ids: string[]) {
  desk.set((s) => {
    s.folded[path] = ids
  })
}

/**
 * The package tree: the file nodes stay in name order, the active file first with "Sort in the
 * file"; the alphabetical and exportability sorts apply inside each file.
 */
function sortPackage(tree: DocumentSymbol[], sort: string, lang: string, active: string): DocumentSymbol[] {
  const files = sort === 'file' ? [...tree.filter((f) => f.file === active), ...tree.filter((f) => f.file !== active)] : tree
  if (sort === 'file') return files
  return files.map((f) => ({ ...f, children: sort === 'alpha' ? sortSymbols(f.children ?? []) : sortByExportability(f.children ?? [], lang) }))
}

/** Unfolds every symbol of the shown tree. */
export async function expandAllStructure() {
  const p = activePath()
  if (!p) return
  const files = desk.get().showPackage ? (await packageTreeOf(p)).tree.map((n) => n.file!) : [p]
  for (const f of files) setFolded(f, [])
}

/** Folds every symbol of the shown tree that has children (a file node folds its whole file). */
export async function collapseAllStructure() {
  const p = activePath()
  if (!p) return
  const collect = (list: DocumentSymbol[], ids: string[]) => {
    for (const s of list) {
      if (!s.children?.length) continue
      ids.push(symbolId(s))
      collect(s.children, ids)
    }
  }
  if (!desk.get().showPackage) {
    const ids: string[] = []
    collect(await treeOf(p), ids)
    setFolded(p, ids)
    return
  }
  for (const node of (await packageTreeOf(p)).tree) {
    const ids: string[] = []
    collect([node], ids)
    setFolded(node.file!, ids)
  }
}

/** The filter box of the shown tool (null: the tool is closed), for the palette's command. */
let askFilter: ((seed?: string) => void) | null = null
let filterWanted = false

/** Opens the Speed Search box, showing the tool when it is closed. */
export function openStructureSearch() {
  if (askFilter) askFilter()
  else {
    filterWanted = true
    api.showTool('structure')
  }
}

/** Switches "Always Select Opened Element" (the ⋮ menu and the palette do the same). */
export function toggleAlwaysSelectStructure() {
  desk.set((s) => (s.selectOpened = !s.selectOpened))
}

/** Switches the package view (the ⋮ menu and the palette do the same). */
export function togglePackageStructure() {
  desk.set((s) => (s.showPackage = !s.showPackage))
}

/** Set by the shown tool: the tree of the active file must be fetched again. */
let askRefresh: (() => void) | null = null

/** Drops the cached trees of the active file and shows the tree again (the corner button and the ⋮). */
export function refreshStructure() {
  const p = activePath()
  if (p) {
    forgetPackage(dirOf(p))
    shownTrees.delete(p)
  }
  askRefresh?.()
}

/** The buttons of the Structure tool in the corner of its zone or tile (`toolCorner` contribution). */
export function structureCorner(): JSX.Element[] {
  return [
    <button class="icon-btn" data-testid="structure-expand" title={t('Expand all')} onClick={() => void expandAllStructure()}>
      <Icon name="expandAll" size={14} />
    </button>,
    <button class="icon-btn" data-testid="structure-collapse" title={t('Collapse all')} onClick={() => void collapseAllStructure()}>
      <Icon name="collapseAll" size={14} />
    </button>,
    <button class="icon-btn" data-testid="structure-search" title={t('Speed Search')} onClick={openStructureSearch}>
      <Icon name="search" size={14} />
    </button>,
    <button class="icon-btn" data-testid="structure-refresh" title={t('Refresh')} onClick={refreshStructure}>
      <Icon name="refresh" size={14} />
    </button>,
  ]
}

/**
 * The items the plugin adds to the ⋮ menu of the Structure tool (`toolMenu` contribution): the
 * choices of the tree, read when the menu opens.
 */
export function structureItems(): MenuItem[] {
  const lang = api.editor.serverLanguage(activePath())
  return [
    { label: t('Expand all'), action: () => void expandAllStructure() },
    { label: t('Collapse all'), action: () => void collapseAllStructure() },
    { separator: true, label: '' },
    { label: t('Navigate with Single Click'), checked: desk.get().singleClick, action: () => desk.set((s) => (s.singleClick = !s.singleClick)) },
    { label: t('Always Select Opened Element'), checked: desk.get().selectOpened, action: toggleAlwaysSelectStructure },
    { label: t('Speed Search'), action: openStructureSearch },
    { separator: true, label: '' },
    { label: t('Sort in the file'), checked: desk.get().structureSort === 'file', action: () => desk.set((s) => (s.structureSort = 'file')) },
    { label: t('Sort alphabetically'), checked: desk.get().structureSort === 'alpha', action: () => desk.set((s) => (s.structureSort = 'alpha')) },
    { label: t('Sort by Exportability'), checked: desk.get().structureSort === 'export', action: () => desk.set((s) => (s.structureSort = 'export')) },
    { separator: true, label: '' },
    { label: t('Show Package Structure'), checked: desk.get().showPackage, disabled: !lang, title: lang ? undefined : t('No language server for this file type'), action: togglePackageStructure },
    { label: t('Show Private Members'), checked: desk.get().showPrivate, action: () => desk.set((s) => (s.showPrivate = !s.showPrivate)) },
  ]
}

export function StructureTool() {
  const path = activePath
  const [tick, setTick] = createSignal(0)
  const [rev, setRev] = createSignal(0)
  const [selected, setSelected] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal('')
  const [searching, setSearching] = createSignal(false)
  let filterEl: HTMLInputElement | undefined
  let rootEl: HTMLDivElement | undefined
  let timer: number | undefined
  createEffect(
    on([path, api.buffers.version], () => {
      const d = path() ? api.buffers.get(path()) : null
      if (!d) return
      const off = d.onChange(() => {
        clearTimeout(timer)
        timer = window.setTimeout(() => setTick((t) => t + 1), 1200)
      })
      onCleanup(off)
    }),
  )
  // A sibling file changed (here or in another window): the package tree of its folder is fetched again.
  const offDir = api.on('fs.dir', (e: { path: string }) => {
    if (forgetPackage(e.path)) setRev((r) => r + 1)
  })
  const offFile = api.on('fs.changed', (e: { path: string }) => {
    if (forgetPackage(dirOf(e.path)) || shownTrees.delete(e.path)) setRev((r) => r + 1)
  })
  onCleanup(offDir)
  onCleanup(offFile)
  const [symbols] = createResource(
    () => (path() ? { p: path(), pkg: desk.get().showPackage, t: tick(), v: api.buffers.version(), r: rev() } : null),
    async ({ p, pkg }): Promise<PackageTree & { error: string }> => {
      try {
        if (pkg) return { ...(await packageTreeOf(p)), error: '' }
        const list = await documentSymbols(p)
        shownTrees.set(p, list)
        return { tree: list, total: 0, shown: 0, error: '' }
      } catch (e) {
        return { tree: [] as DocumentSymbol[], total: 0, shown: 0, error: (e as Error).message }
      }
    },
  )
  const filtering = () => searching() && !!query()
  const rows = createMemo(() => {
    const entry = symbols()
    const list = entry?.tree ?? []
    const lang = path() ? api.editor.serverLanguage(path()) : ''
    const sort = desk.get().structureSort
    const pkg = desk.get().showPackage
    const sorted = pkg
      ? sortPackage(list, sort, lang, path())
      : sort === 'alpha'
        ? sortSymbols(list)
        : sort === 'export'
          ? sortByExportability(list, lang)
          : list
    const shown = desk.get().showPrivate ? sorted : filterPrivate(sorted, lang)
    const files = pkg ? list.map((n) => n.file!) : [path()]
    // While filtering, the folds are set aside: a match must not hide under a folded parent.
    return treeRows(filtering() ? filterSymbols(shown, query()) : shown, filtering() ? new Set<string>() : foldedIds(files), lang, 0, [], path())
  })
  const capLine = () => {
    const e = symbols()
    return desk.get().showPackage && !filtering() && !!e && e.total > e.shown
  }
  const jump = (r: TreeRow) => api.openFile({ path: r.file, line: r.s.selectionRange.start.line, col: r.s.selectionRange.start.character })
  const toggle = (r: TreeRow) => {
    if (!r.hasChildren) return
    const ids = new Set(desk.get().folded[r.file] ?? [])
    const id = symbolId(r.s)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    setFolded(r.file, [...ids])
  }
  /** Unfolds the ancestors of a symbol, and only when one of them is actually folded. */
  const revealSymbol = (p: string, ids: string[]) => {
    const folded = desk.get().folded[p] ?? []
    const hidden = new Set(ids)
    const kept = folded.filter((id) => !hidden.has(id))
    if (kept.length !== folded.length) setFolded(p, kept)
  }
  const rowEls = () => [...document.querySelectorAll<HTMLElement>('.structure .tree-row')]
  /** Back to the tree: the selected row when it is still shown, the first one else. */
  const focusTree = () => {
    const id = untrack(selected)
    const els = rowEls()
    ;(els.find((e) => e.dataset.sym === id) ?? els[0])?.focus()
  }
  const openSearch = (seed?: string) => {
    setSearching(true)
    setQuery(seed ?? '')
    queueMicrotask(() => filterEl?.focus())
  }
  const clearSearch = () => {
    setQuery('')
    setSearching(false)
    queueMicrotask(focusTree)
  }
  askFilter = openSearch
  askRefresh = () => setTick((t) => t + 1)
  onCleanup(() => {
    if (askFilter === openSearch) askFilter = null
    if (askRefresh) askRefresh = null
  })
  if (filterWanted) {
    filterWanted = false
    openSearch()
  }
  // Ctrl+F belongs to the editor: the tool takes it only while the tree owns the focus (its
  // handler, registered last, runs before the editor's).
  let disarmFind: (() => void) | null = null
  const armFind = () => {
    if (disarmFind) return
    disarmFind = api.keys.register('search.find', () => void openSearch())
  }
  const lowerFind = () => {
    disarmFind?.()
    disarmFind = null
  }
  onCleanup(lowerFind)
  // "Always Select Opened Element": the row of the symbol around the caret follows the caret.
  let followTimer: number | undefined
  const followCaret = (p: string, line: number, col: number) => {
    const list = shownTrees.get(p) ?? []
    const chain = enclosingSymbols(list, line - 1, col - 1)
    const target = chain[chain.length - 1]
    if (!target) return
    const ids = chain.map(symbolId)
    if (desk.get().showPackage) ids.push(symbolId(fileSymbol(p))) // the file node itself
    revealSymbol(p, ids)
    const id = rowKey(p, symbolId(target))
    setSelected(id)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.structure .tree-row[data-sym="${id}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  createEffect(() => {
    if (!desk.get().selectOpened) return
    const p = path()
    const c = api.editor.cursor()
    if (!p || !c || api.activeFile() !== p) return
    clearTimeout(followTimer)
    followTimer = window.setTimeout(() => followCaret(p, c.line, c.col), 200)
  })
  onCleanup(() => clearTimeout(followTimer))
  return (
    <div
      class="panel structure"
      ref={rootEl}
      onFocusIn={armFind}
      onFocusOut={(ev) => {
        const next = ev.relatedTarget as Node | null
        if (!next || !rootEl?.contains(next)) lowerFind()
      }}
    >
      <div class="panel-head">
        <span class="panel-title">{t('Structure')}</span>
      </div>
      <Show when={searching()}>
        <div class="tree-filter">
          <input
            class="input small"
            data-testid="structure-filter"
            placeholder={t('Filter symbols')}
            value={query()}
            ref={filterEl}
            onInput={(ev) => setQuery(ev.currentTarget.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') clearSearch()
              else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                const els = rowEls()
                els[ev.key === 'ArrowDown' ? 0 : els.length - 1]?.focus()
              } else return
              ev.preventDefault()
            }}
          />
          <button class="icon-btn" title={t('Clear')} onClick={clearSearch}>
            <Icon name="close" size={12} />
          </button>
        </div>
      </Show>
      <div class="panel-body tree" role="tree">
        <Show when={path()} fallback={<EmptyState icon="outline" text={t('No active file.')} />}>
          <Show when={symbols()?.error}>
            <p class="muted pad small">{symbols()!.error}</p>
          </Show>
          <Show when={filtering() && !rows().length}>
            <p class="muted pad small">{t('No symbol matches.')}</p>
          </Show>
          <Show when={capLine()}>
            <p class="muted pad small">{t('Package: {n} files, showing the first {m}', { n: symbols()!.total, m: symbols()!.shown })}</p>
          </Show>
          <For each={rows()}>
            {(r) => {
              const id = () => rowKey(r.file, symbolId(r.s))
              return (
                <div
                  class="tree-row"
                  role="treeitem"
                  tabIndex={-1}
                  data-sym={id()}
                  aria-expanded={r.hasChildren ? !r.folded : undefined}
                  aria-selected={selected() === id()}
                  classList={{ selected: selected() === id() }}
                  style={{ 'padding-left': `${r.depth * 14 + 6}px` }}
                  onFocus={() => setSelected(id())}
                  onClick={(ev) => {
                    setSelected(id())
                    ;(ev.currentTarget as HTMLElement).focus()
                    if ((ev.target as Element).closest('.tree-twist')) {
                      toggle(r)
                      return
                    }
                    if (desk.get().singleClick || api.tiles.phone()) jump(r)
                    else toggle(r)
                  }}
                  onDblClick={(ev) => {
                    if (desk.get().singleClick || (ev.target as Element).closest('.tree-twist')) return
                    jump(r)
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') jump(r)
                    else if (ev.key === 'ArrowRight' && r.hasChildren) {
                      if (r.folded) toggle(r)
                      else {
                        const els = rowEls()
                        els[els.indexOf(ev.currentTarget) + 1]?.focus()
                      }
                    } else if (ev.key === 'ArrowLeft') {
                      if (r.hasChildren && !r.folded) toggle(r)
                      else {
                        const els = rowEls()
                        for (let i = els.indexOf(ev.currentTarget) - 1; i >= 0; i--)
                          if (rows()[i].depth < r.depth) {
                            els[i].focus()
                            break
                          }
                      }
                    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                      const els = rowEls()
                      els[els.indexOf(ev.currentTarget) + (ev.key === 'ArrowDown' ? 1 : -1)]?.focus()
                    } else if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.length === 1) {
                      openSearch(ev.key) // Speed Search: typing in the focused tree filters it
                    } else return
                    ev.preventDefault()
                  }}
                >
                  <span class="tree-twist" classList={{ open: r.hasChildren && !r.folded, none: !r.hasChildren }}>
                    <Show when={r.hasChildren}>
                      <Icon name="chevron" size={12} />
                    </Show>
                  </span>
                  <SymGlyph kind={r.s.kind} />
                  <Show when={r.visibility !== 'none'}>
                    <span class={`sym-lock ${r.visibility}`} title={r.visibility === 'exported' ? t('Exported') : t('Private')}>
                      <Icon name={r.visibility === 'exported' ? 'lockOpen' : 'lock'} size={12} />
                    </span>
                  </Show>
                  <span class="tree-name"><Marked text={r.s.name} query={query()} /></span>
                  <Show when={r.s.detail}>
                    <span class="tree-detail"><Marked text={r.s.detail!} query={query()} /></span>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
