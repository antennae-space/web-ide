// Structure tool: the symbols of the active file (classes, functions, methods), from its server,
// as a tree. A twisty folds the children of a symbol (the folded state is kept per file in the
// desk), one click selects a row, a double click jumps to it (one click with "Navigate with
// Single Click"), a lock next to the glyph tells an exported symbol from a private one (the rules
// of web/visibility.json), the ⋮ menu holds the choices of the tree. Speed Search filters the
// rows by typing (or Ctrl+F) while the tree has the focus; "Always Select Opened Element" keeps
// the row of the symbol around the caret selected.
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, untrack } from 'solid-js'
import type { MenuItem } from '@ide/api'
import { api, contextMenu, desk, EmptyState, Icon, t } from './plugin'
import { documentSymbols, enclosingSymbols, filterPrivate, filterSymbols, sortByExportability, sortSymbols, symbolId, treeRows, type DocumentSymbol, type TreeRow } from './client'
import { SymGlyph } from './glyph'

const activePath = () => (api.activeFile() ?? '')

/** The tree each file was last shown with: the commands work even when the tool is closed. */
const shownTrees = new Map<string, DocumentSymbol[]>()

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

async function treeOf(path: string): Promise<DocumentSymbol[]> {
  const known = shownTrees.get(path)
  if (known) return known
  const list = await documentSymbols(path).catch(() => [] as DocumentSymbol[])
  shownTrees.set(path, list)
  return list
}

function foldedIds(path: string): Set<string> {
  return new Set(desk.get().folded[path] ?? [])
}

function setFolded(path: string, ids: string[]) {
  desk.set((s) => {
    s.folded[path] = ids
  })
}

/** Unfolds every symbol of the active file. */
export function expandAllStructure() {
  const p = activePath()
  if (p) setFolded(p, [])
}

/** Folds every symbol of the active file that has children. */
export async function collapseAllStructure() {
  const p = activePath()
  if (!p) return
  const ids: string[] = []
  const walk = (list: DocumentSymbol[]) => {
    for (const s of list) {
      if (!s.children?.length) continue
      ids.push(symbolId(s))
      walk(s.children)
    }
  }
  walk(await treeOf(p))
  setFolded(p, ids)
}

function optionsMenu(ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  const soon = t('Coming soon')
  const items: MenuItem[] = [
    { label: t('Expand all'), action: expandAllStructure },
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
    { label: t('Show Package Structure'), disabled: true, title: soon },
    { label: t('Show Private Members'), checked: desk.get().showPrivate, action: () => desk.set((s) => (s.showPrivate = !s.showPrivate)) },
  ]
  contextMenu(new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom + 2 }), items)
}

export function StructureTool() {
  const path = activePath
  const [tick, setTick] = createSignal(0)
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
  const [symbols] = createResource(
    () => (path() ? { p: path(), t: tick(), v: api.buffers.version() } : null),
    async ({ p }) => {
      try {
        const list = await documentSymbols(p)
        shownTrees.set(p, list)
        return { list, error: '' }
      } catch (e) {
        return { list: [] as DocumentSymbol[], error: (e as Error).message }
      }
    },
  )
  const filtering = () => searching() && !!query()
  const rows = createMemo(() => {
    const list = symbols()?.list ?? []
    const lang = path() ? api.editor.serverLanguage(path()) : ''
    const sort = desk.get().structureSort
    const sorted = sort === 'alpha' ? sortSymbols(list) : sort === 'export' ? sortByExportability(list, lang) : list
    const shown = desk.get().showPrivate ? sorted : filterPrivate(sorted, lang)
    // While filtering, the folds are set aside: a match must not hide under a folded parent.
    return treeRows(filtering() ? filterSymbols(shown, query()) : shown, filtering() ? new Set<string>() : foldedIds(path()), lang)
  })
  const jump = (s: DocumentSymbol) => api.openFile({ path: path(), line: s.selectionRange.start.line, col: s.selectionRange.start.character })
  const toggle = (r: TreeRow) => {
    if (!r.hasChildren) return
    const ids = foldedIds(path())
    const id = symbolId(r.s)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    setFolded(path(), [...ids])
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
  onCleanup(() => {
    if (askFilter === openSearch) askFilter = null
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
    const list = untrack(() => symbols()?.list) ?? shownTrees.get(p) ?? []
    const chain = enclosingSymbols(list, line - 1, col - 1)
    const target = chain[chain.length - 1]
    if (!target) return
    const id = symbolId(target)
    revealSymbol(p, chain.map(symbolId))
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
        <span class="grow" />
        <button class="icon-btn" data-testid="structure-expand" title={t('Expand all')} onClick={expandAllStructure}>
          <Icon name="expandAll" size={14} />
        </button>
        <button class="icon-btn" data-testid="structure-collapse" title={t('Collapse all')} onClick={() => void collapseAllStructure()}>
          <Icon name="collapseAll" size={14} />
        </button>
        <button class="icon-btn" data-testid="structure-search" title={t('Speed Search')} onClick={() => openSearch()}>
          <Icon name="search" size={14} />
        </button>
        <button class="icon-btn" title={t('Refresh')} onClick={() => setTick((t) => t + 1)}>
          <Icon name="refresh" size={14} />
        </button>
        <button class="icon-btn" data-testid="structure-options" title={t('Options')} onClick={optionsMenu}>
          <Icon name="more" size={14} />
        </button>
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
          <For each={rows()}>
            {(r) => {
              const id = () => symbolId(r.s)
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
                    if (desk.get().singleClick || api.tiles.phone()) jump(r.s)
                    else toggle(r)
                  }}
                  onDblClick={(ev) => {
                    if (desk.get().singleClick || (ev.target as Element).closest('.tree-twist')) return
                    jump(r.s)
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') jump(r.s)
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
                  <span class="tree-name">{r.s.name}</span>
                  <Show when={r.s.detail}>
                    <span class="tree-detail">{r.s.detail}</span>
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
