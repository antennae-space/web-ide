// File explorer: lazy tree (one fs.list per expanded folder), refreshed by the pod watch events.
// A click selects, a double click (or Enter) opens the file and gives it the focus.
// Virtualized (#225): the expanded tree is a flat list of rows, and only the rows in view (plus a
// margin) are in the DOM, so a folder of thousands of files stays as quick as a small one.
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { MenuItem } from '@ide/api'
import type { FileKind, FileTint } from '@ide/types'
import { api, contextMenu, copyText, desk, errorToast, FileRow, Icon, prompt, t, toast } from './plugin'
import { isLibraryName, markLabels, type FolderMark } from './tints'

const folderMark = (p: string) => api.folders.mark(p)
const inExcluded = (p: string) => api.folders.inExcluded(p)
const root = () => api.project.root()
const relPath = (p: string) => api.project.relPath(p)

interface Entry {
  name: string
  path: string
  dir: boolean
  link?: boolean
  size: number
}

const [children, setChildren] = createStore<Record<string, Entry[] | undefined>>({})
const [errors, setErrors] = createStore<Record<string, string | undefined>>({})
// Paths left out by .gitignore (their content is too).
const [ignored, setIgnored] = createStore<Record<string, boolean | undefined>>({})
const [selected, setSelected] = createSignal<string | null>(null)

async function load(dir: string) {
  let list: Entry[]
  try {
    list = await api.rpc<Entry[]>('fs.list', { path: dir })
    // Reconciled by path: the entries kept stay the same objects, so are their rows.
    setChildren(dir, reconcile(list, { key: 'path' }))
    setErrors(dir, undefined)
  } catch (e) {
    setErrors(dir, (e as Error).message)
    return
  }
  await askIgnored(list)
}

/** The files the decorations (Git) leave out: dimmed, and so is their content. */
async function askIgnored(list: Entry[]) {
  for (const d of api.explorer.decorations()) {
    try {
      const ign = new Set((await d.ignored?.(list.map((e) => e.path))) ?? [])
      batch(() => {
        for (const e of list) setIgnored(e.path, ign.has(e.path) || undefined)
      })
    } catch {
      // Not a repository, or git missing: nothing is ignored.
    }
  }
}

/** Starts following the folders: a folder listed again when its content changes. */
export function watchFolders() {
  api.on('fs.dir', (e: { path: string }) => {
    if (children[e.path]) load(e.path)
  })
}

function isExpanded(p: string) {
  return desk.get().expanded.includes(p)
}

function setExpanded(p: string, open: boolean) {
  desk.set((s) => {
    const i = s.expanded.indexOf(p)
    if (open && i < 0) s.expanded.push(p)
    if (!open && i >= 0) s.expanded.splice(i, 1)
  })
  if (open && !children[p]) load(p)
}

const rowOf = (path: string) => document.querySelector<HTMLElement>(`.explorer .tree-row[data-path="${CSS.escape(path)}"]`)

/** The mounted Explorer: brings a row of the flat list into view (it may not be in the DOM). */
let view: { show(path: string): boolean } | null = null

/**
 * Brings the row of a path into view and focuses it when asked, once rendered. The folders just
 * opened list their content first: tried again for a while.
 */
function showRow(path: string, focus: boolean) {
  let n = 0
  const show = () => {
    if (!view?.show(path)) return void (n++ < 30 && setTimeout(show, 50))
    // The rows of the new range are drawn at once (the scroll signal is synchronous).
    if (focus) rowOf(path)?.focus({ preventScroll: true })
  }
  // A row of the list (an arrow key): at once, so that the next key starts from it.
  if (view?.show(path)) {
    if (focus) rowOf(path)?.focus({ preventScroll: true })
    return
  }
  requestAnimationFrame(show)
}

/** Expands the folders down to a file and selects it (focusing its row when asked). */
export function revealInExplorer(path: string, focus = false) {
  const r = root()
  if (!path.startsWith(r + '/')) return
  const parts = path.slice(r.length + 1).split('/')
  let cur = r
  for (const part of parts.slice(0, -1)) {
    cur += '/' + part
    if (!isExpanded(cur)) setExpanded(cur, true)
  }
  setSelected(path)
  showRow(path, focus)
}

/** Opens a file and moves the focus to its editor. */
async function openAndFocus(path: string) {
  await api.openFile(path)
  let n = 0
  const focus = () => {
    const ed = document.querySelector<HTMLElement>('.pane.active .ed-content')
    if (ed && api.activePath() === path) ed.focus()
    else if (n++ < 20) requestAnimationFrame(focus)
  }
  requestAnimationFrame(focus)
}

/** Opens every folder, level by level, except the ignored, excluded and library ones. */
async function expandAll() {
  const opened: string[] = []
  let level = [root()]
  while (level.length && opened.length < 300) {
    await Promise.all(level.filter((d) => !children[d]).map(load))
    const next: string[] = []
    for (const d of level)
      for (const e of children[d] ?? []) {
        if (!e.dir || e.link || isLibraryName(e.name) || ignored[e.path] || inExcluded(e.path)) continue
        if (!desk.get().hidden && e.name.startsWith('.')) continue
        next.push(e.path)
      }
    level = next.slice(0, 300 - opened.length)
    opened.push(...level)
  }
  desk.set((s) => {
    for (const p of opened) if (!s.expanded.includes(p)) s.expanded.push(p)
  })
}

function collapseAll() {
  desk.set((s) => {
    s.expanded = []
  })
}

/** Asks the name of a new file or folder in dir, creates it and opens the file. */
export async function createIn(dir: string, isDir: boolean) {
  const name = await prompt({ title: isDir ? t('New folder') : t('New file'), label: t('In {dir}', { dir: relPath(dir) || '/' }), placeholder: isDir ? t('name') : t('name.ext (or sub/folder/name.ext)') })
  if (!name) return
  const path = dir + '/' + name.replace(/^\/+/, '')
  try {
    await api.rpc('fs.create', { path, dir: isDir })
    setExpanded(dir, true)
    await load(dir)
    if (!isDir) openAndFocus(path)
  } catch (e) {
    errorToast(e)
  }
}

async function rename(e: Entry) {
  const name = await prompt({ title: t('Rename'), value: e.name })
  if (!name || name === e.name) return
  const dir = e.path.slice(0, e.path.lastIndexOf('/'))
  try {
    await api.rpc('fs.rename', { path: e.path, to: dir + '/' + name })
    load(dir)
  } catch (err) {
    errorToast(err)
  }
}

async function remove(e: Entry) {
  if (!confirm(e.dir ? t('Delete the folder “{path}” and all its content?', { path: relPath(e.path) }) : t('Delete the file “{path}”?', { path: relPath(e.path) }))) return
  try {
    await api.rpc('fs.delete', { path: e.path })
    load(e.path.slice(0, e.path.lastIndexOf('/')))
  } catch (err) {
    errorToast(err)
  }
}

function refreshAll() {
  for (const k of Object.keys(children)) if (children[k]) load(k)
  toast(t('Explorer refreshed'), 'info')
}

function menuFor(ev: MouseEvent, e: Entry) {
  const dir = e.dir ? e.path : e.path.slice(0, e.path.lastIndexOf('/'))
  const items: MenuItem[] = [
    { label: t('New file…'), action: () => createIn(dir, false) },
    { label: t('New folder…'), action: () => createIn(dir, true) },
    { separator: true, label: '' },
    { label: t('Rename…'), action: () => rename(e), disabled: e.path === root() },
    { label: t('Delete'), action: () => remove(e), danger: true, disabled: e.path === root() },
    { separator: true, label: '' },
    { label: t('Copy the path'), action: () => copyText(e.path) },
    { label: t('Copy the relative path'), action: () => copyText(relPath(e.path)) },
    // The items the other plugins give (Exec: a terminal here).
    ...api.explorer.items({ path: e.path, dir: e.dir, folder: dir }),
    { label: t('Refresh'), action: () => load(dir) },
  ]
  if (e.dir && e.path !== root()) {
    const cur = folderMark(e.path)
    items.push(
      { separator: true, label: '' },
      ...(Object.keys(markLabels) as FolderMark[]).map((m) => ({ label: t(markLabels[m]), checked: cur === m, action: () => api.folders.setMark(e.path, cur === m ? '' : m) })),
    )
  }
  contextMenu(ev, items)
}

/**
 * The items the Files plugin adds to the ⋮ menu of the Explorer (`toolMenu` contribution): the
 * choices of the tree, read when the menu opens. The same list from the ⋮ of a zone, of a tile, or
 * from a right click on either.
 */
export function explorerMenu(): MenuItem[] {
  const toggle = (k: 'hidden' | 'excluded' | 'singleClick' | 'follow' | 'tintTests' | 'tintLibrary' | 'tintManifests' | 'tintMarks' | 'tintIgnored') => () =>
    desk.set((s) => {
      s[k] = !s[k]
    })
  /** One switch per family of the built-in rules (#182), in a submenu of the ⋮. */
  const tints = (k: 'tintTests' | 'tintLibrary' | 'tintManifests' | 'tintMarks' | 'tintIgnored', label: string) => ({ label: t(label), checked: desk.get()[k], action: toggle(k) })
  return [
    { label: t('New file…'), action: () => createIn(root(), false) },
    { label: t('New folder…'), action: () => createIn(root(), true) },
    { separator: true, label: '' },
    { label: t('Show the hidden files'), checked: desk.get().hidden, action: toggle('hidden') },
    { label: t('Show the excluded folders'), checked: desk.get().excluded, action: toggle('excluded') },
    { label: t('Open files with a single click'), checked: desk.get().singleClick, action: toggle('singleClick') },
    { label: t('Always select the opened file'), checked: desk.get().follow, action: toggle('follow') },
    {
      label: t('Row tints'),
      items: [tints('tintTests', 'Tests'), tints('tintLibrary', 'Library roots'), tints('tintManifests', 'Manifests'), tints('tintMarks', 'Marked folders'), tints('tintIgnored', 'Ignored files')],
    },
    { separator: true, label: '' },
    { label: t('Refresh all'), action: refreshAll },
  ]
}

/** The buttons of the Explorer in the corner of its zone or tile (`toolCorner` contribution). */
export function explorerCorner(): JSX.Element[] {
  return [
    <button class="icon-btn" data-testid="explorer-locate" title={t('Locate the active file')} onClick={() => api.activePath() && revealInExplorer(api.activePath()!, true)}>
      <Icon name="locate" />
    </button>,
    <button class="icon-btn" data-testid="explorer-expand" title={t('Expand all')} onClick={expandAll}>
      <Icon name="expandAll" />
    </button>,
    <button class="icon-btn" data-testid="explorer-collapse" title={t('Collapse all')} onClick={collapseAll}>
      <Icon name="collapseAll" />
    </button>,
  ]
}

/** What a folder passes to its content: ignored by git, excluded, and the decoration channels of the folder (#179). */
interface Inherited {
  ignored: boolean
  excluded: boolean
  kind?: FileKind
  tint?: FileTint
  label?: string
}

/** A line of the flat tree: a row of an entry, or the error of a folder that could not be listed. */
type Item = { entry: Entry; depth: number; inherited: Inherited; error?: undefined } | { error: string; dir: string; depth: number; entry?: undefined }

const sameInherited = (a: Inherited, b: Inherited) => a.ignored === b.ignored && a.excluded === b.excluded && a.kind === b.kind && a.tint === b.tint && a.label === b.label

/**
 * The channels of a row (#179, #182): what the plugins say about the entry (Git: state and badge;
 * Files: its kind, from its name or the marks of its folders) and the error the core knows, else
 * what its folder passes down. The state falls back to ignored or clean, as before the badges; the
 * git-ignored tint is the Explorer's own, since it is the one that reads the ignored set.
 */
function channels(e: Entry, inherited: Inherited) {
  const isIgnored = inherited.ignored || !!ignored[e.path]
  const d = api.explorer.decorate(e.path, e.dir)
  return {
    ignored: isIgnored,
    excluded: inherited.excluded || (e.dir && folderMark(e.path) === 'excluded'),
    state: d.state ?? (isIgnored ? 'ignored' : 'clean'),
    badge: d.badge,
    kind: d.kind ?? inherited.kind,
    tint: d.tint ?? inherited.tint ?? (isIgnored && desk.get().tintIgnored ? 'ignored' : undefined),
    label: d.label ?? inherited.label,
    error: d.error,
  }
}

/**
 * The expanded tree as one list, in the order of the rows: the content of a folder after it when
 * it is open. Only the folders compute what they pass down; the items are reused by path while
 * nothing of theirs changes, so `<For>` keeps their rows.
 */
function flatTree(): () => Item[] {
  let cache = new Map<string, Item>()
  return createMemo(() => {
    const out: Item[] = []
    const next = new Map<string, Item>()
    const s = desk.get()
    const expanded = new Set(s.expanded)
    const walk = (dir: string, depth: number, inherited: Inherited) => {
      const err = errors[dir]
      if (err) {
        const key = '\0' + dir
        const old = cache.get(key)
        const it: Item = old && old.error === err && old.depth === depth ? old : { error: err, dir, depth }
        next.set(key, it)
        out.push(it)
      }
      for (const e of children[dir] ?? []) {
        if (!s.hidden && e.name.startsWith('.')) continue
        if (!s.excluded && folderMark(e.path) === 'excluded') continue
        const old = cache.get(e.path)
        const it: Item = old && old.entry === e && old.depth === depth && sameInherited(old.inherited, inherited) ? old : { entry: e, depth, inherited }
        next.set(e.path, it)
        out.push(it)
        if (e.dir && expanded.has(e.path)) {
          const c = channels(e, inherited)
          walk(e.path, depth + 1, { ignored: c.ignored, excluded: c.excluded, kind: c.kind, tint: c.tint, label: c.label })
        }
      }
    }
    walk(root(), 0, { ignored: false, excluded: false })
    cache = next
    return out
  })
}

/** Rows drawn beyond each edge of the view: a quick scroll or a key press shows no blank. */
const MARGIN = 20

function Row(props: { entry: Entry; depth: number; inherited: Inherited; move: (path: string, delta: number) => void }) {
  const e = props.entry
  const open = () => isExpanded(e.path)
  const mark = () => (e.dir ? folderMark(e.path) : null)
  const eff = () => channels(e, props.inherited)
  const toggle = () => setExpanded(e.path, !open())
  const activate = () => (e.dir ? toggle() : openAndFocus(e.path))
  return (
    <FileRow
      name={e.name}
      path={e.path}
      dir={e.dir}
      open={open()}
      depth={props.depth}
      deco={eff()}
      error={eff().error}
      errorWavy
      selected={selected() === e.path}
      current={api.activePath() === e.path}
      excluded={eff().excluded}
      mark={mark()}
      title={mark() ? t(markLabels[mark()!]) : undefined}
      expanded={e.dir ? open() : undefined}
      chosen={selected() === e.path}
      after={e.link && <span class="tree-link" title={t('Symbolic link')}>↪</span>}
      onFocus={() => setSelected(e.path)}
      onClick={(ev) => {
        setSelected(e.path)
        ;(ev.currentTarget as HTMLElement).focus()
        if (e.dir && (ev.target as Element).closest('.tree-twist')) toggle()
        else if (desk.get().singleClick || api.tiles.phone()) e.dir ? toggle() : api.openFile(e.path) // a phone has no double click
      }}
      onDblClick={(ev) => {
        if (desk.get().singleClick || (ev.target as Element).closest('.tree-twist')) return
        activate()
      }}
      onKeyDown={(ev) => {
        // The rows next to this one may be out of the DOM: the moves go through the flat list.
        if (ev.key === 'Enter') activate()
        else if (ev.key === 'ArrowRight' && e.dir) {
          if (!open()) setExpanded(e.path, true)
          else props.move(e.path, 1)
        } else if (ev.key === 'ArrowLeft') {
          if (e.dir && open()) setExpanded(e.path, false)
          else {
            const parent = e.path.slice(0, e.path.lastIndexOf('/'))
            if (parent !== root()) showRow(parent, true)
          }
        } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') props.move(e.path, ev.key === 'ArrowDown' ? 1 : -1)
        else if (ev.key === 'F2') rename(e)
        else if (ev.key === 'Delete') remove(e)
        else return
        ev.preventDefault()
      }}
      onContextMenu={(ev) => {
        setSelected(e.path)
        menuFor(ev, e)
      }}
    />
  )
}

export function Explorer() {
  const items = flatTree()
  let body!: HTMLDivElement
  let block!: HTMLDivElement
  const [scrollTop, setScrollTop] = createSignal(0)
  const [height, setHeight] = createSignal(800)
  // The height of a row, measured once one is drawn (the styles give 24px).
  const [rowH, setRowH] = createSignal(24)
  /** Where the block of the rows starts in the scrolled body (after the root line). */
  const offset = () => (block ? block.offsetTop - body.offsetTop : 0)
  const range = () => {
    const h = rowH()
    const top = scrollTop() - offset()
    const start = Math.max(0, Math.floor(top / h) - MARGIN)
    const end = Math.min(items().length, Math.ceil((top + height()) / h) + MARGIN)
    return [start, end] as const
  }
  const shown = createMemo(() => {
    const [start, end] = range()
    return items().slice(start, end)
  })
  const indexOf = (path: string) => items().findIndex((it) => it.entry?.path === path)
  /** Scrolls the row of a path into view: false while it is not in the list yet. */
  const show = (path: string) => {
    const i = indexOf(path)
    if (i < 0) return false
    const h = rowH()
    const top = offset() + i * h
    if (top < body.scrollTop) body.scrollTop = top
    else if (top + h > body.scrollTop + body.clientHeight) body.scrollTop = top + h - body.clientHeight
    setScrollTop(body.scrollTop)
    return true
  }
  /** Focuses the row delta lines away from a path (the error lines are skipped). */
  const move = (path: string, delta: number) => {
    const list = items()
    for (let i = indexOf(path) + delta; i >= 0 && i < list.length; i += delta) {
      const e = list[i].entry
      if (e) return showRow(e.path, true)
    }
  }
  onMount(() => {
    view = { show }
    const r = root()
    if (r) load(r)
    for (const p of desk.get().expanded) if (!children[p]) load(p)
    const ro = new ResizeObserver(() => setHeight(body.clientHeight || 800))
    ro.observe(body)
    onCleanup(() => {
      ro.disconnect()
      if (view?.show === show) view = null
    })
  })
  // The row height, from the first row drawn.
  createEffect(() => {
    if (!shown().length) return
    const h = block.querySelector<HTMLElement>('.tree-row')?.offsetHeight
    if (h && h !== rowH()) setRowH(h)
  })
  createEffect(() => {
    const r = root()
    if (r && !children[r]) load(r)
    if (r) void api.folders.load()
  })
  // "Always select the opened file".
  createEffect(() => {
    const p = api.activePath()
    if (desk.get().follow && p) untrack(() => revealInExplorer(p))
  })
  // A folder asks the paths its decorations leave out when it is listed. A decoration that
  // arrives later — the page module of Git loaded after the first listing — asks them again for
  // the folders already listed, so an ignored file is not left uncolored until the next refresh.
  createEffect(
    on(
      () => api.explorer.decorations().filter((d) => d.ignored).length,
      (n, prev) => {
        if (!n || n === prev) return
        for (const k of Object.keys(children)) if (children[k]) void askIgnored(children[k]!)
      },
      { defer: true },
    ),
  )
  const rootEntry = (): Entry => ({ name: api.project.name() ?? api.project.basename(root()), path: root(), dir: true, size: 0 })
  return (
    <div class="panel explorer">
      <div class="panel-head">
        <span class="panel-title">{t('Explorer')}</span>
      </div>
      <div
        ref={body}
        class="panel-body tree"
        role="tree"
        onScroll={() => setScrollTop(body.scrollTop)}
        onContextMenu={(e) => e.target === e.currentTarget && menuFor(e, rootEntry())}
      >
        <div class="tree-root" onContextMenu={(e) => menuFor(e, rootEntry())}>
          <span>{rootEntry().name}</span>
          <span class="muted" title={root()}>
            <bdi>{relPath(root()) === root() ? root() : ''}</bdi>
          </span>
        </div>
        {/* The full height of the list, fixed while scrolling; the rows in view moved down by a
            transform (a padding would change the layout, and the scroll anchoring of the browser
            would move the scroll back, leaving ghost rows). */}
        <div ref={block} class="tree-rows" style={{ height: `${items().length * rowH()}px` }}>
          <div class="tree-window" style={{ transform: `translateY(${range()[0] * rowH()}px)` }}>
            <For each={shown()}>
              {(it) =>
                it.entry ? (
                  <Row entry={it.entry} depth={it.depth} inherited={it.inherited} move={move} />
                ) : (
                  <div class="tree-error" style={{ 'padding-left': `${it.depth * 14 + 22}px` }} title={it.error}>
                    {it.error}
                  </div>
                )
              }
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
