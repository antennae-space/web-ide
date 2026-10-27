// Structure tool: the symbols of the active file (classes, functions, methods), from its server,
// as a tree. A twisty folds the children of a symbol (the folded state is kept per file in the
// desk), one click selects a row, a double click jumps to it (one click with "Navigate with
// Single Click"), the ⋮ menu holds the choices of the tree.
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from 'solid-js'
import type { MenuItem } from '@ide/api'
import { api, contextMenu, desk, EmptyState, Icon, t } from './plugin'
import { documentSymbols, sortSymbols, symbolId, treeRows, type DocumentSymbol, type TreeRow } from './client'
import { SymGlyph } from './glyph'

const activePath = () => (api.activeFile() ?? '')

/** The tree each file was last shown with: the commands work even when the tool is closed. */
const shownTrees = new Map<string, DocumentSymbol[]>()

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
    { label: t('Always Select Opened Element'), disabled: true, title: soon },
    { label: t('Speed Search'), disabled: true, title: soon },
    { separator: true, label: '' },
    { label: t('Sort in the file'), checked: desk.get().structureSort === 'file', action: () => desk.set((s) => (s.structureSort = 'file')) },
    { label: t('Sort alphabetically'), checked: desk.get().structureSort === 'alpha', action: () => desk.set((s) => (s.structureSort = 'alpha')) },
    { separator: true, label: '' },
    { label: t('Show Package Structure'), disabled: true, title: soon },
    { label: t('Show Private Members'), disabled: true, title: soon },
  ]
  contextMenu(new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom + 2 }), items)
}

export function StructureTool() {
  const path = activePath
  const [tick, setTick] = createSignal(0)
  const [selected, setSelected] = createSignal<string | null>(null)
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
  const rows = createMemo(() => {
    const list = symbols()?.list ?? []
    const sorted = desk.get().structureSort === 'alpha' ? sortSymbols(list) : list
    return treeRows(sorted, foldedIds(path()))
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
  return (
    <div class="panel structure">
      <div class="panel-head">
        <span class="panel-title">{t('Structure')}</span>
        <span class="grow" />
        <button class="icon-btn" data-testid="structure-expand" title={t('Expand all')} onClick={expandAllStructure}>
          <Icon name="expandAll" size={14} />
        </button>
        <button class="icon-btn" data-testid="structure-collapse" title={t('Collapse all')} onClick={() => void collapseAllStructure()}>
          <Icon name="collapseAll" size={14} />
        </button>
        <button class="icon-btn" title={t('Refresh')} onClick={() => setTick((t) => t + 1)}>
          <Icon name="refresh" size={14} />
        </button>
        <button class="icon-btn" data-testid="structure-options" title={t('Options')} onClick={optionsMenu}>
          <Icon name="more" size={14} />
        </button>
      </div>
      <div class="panel-body tree" role="tree">
        <Show when={path()} fallback={<EmptyState icon="outline" text={t('No active file.')} />}>
          <Show when={symbols()?.error}>
            <p class="muted pad small">{symbols()!.error}</p>
          </Show>
          <For each={rows()}>
            {(r) => {
              const id = () => symbolId(r.s)
              return (
                <div
                  class="tree-row"
                  role="treeitem"
                  tabIndex={-1}
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
                    const rowEls = () => [...document.querySelectorAll<HTMLElement>('.structure .tree-row')]
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
