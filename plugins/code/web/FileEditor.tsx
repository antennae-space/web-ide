// The view of a file buffer, the default view of the file tabs (fileView contribution): the
// editor, its find bar, rendered Markdown, the change markers against HEAD or the last saved
// content (clickable, with the popup of their hunk), the completion, the context menu and the
// editing actions while it is the active one.
import { createEffect, createResource, createSignal, on, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js'
import type { Diagnostic, Doc, EditorView, Hunk, LspDiagnostic, MarkdownViewApi, TabState, WordSpan } from '@ide/api'
import type { GutterMark, LineClass, LineWidget, MovedMark } from '@ide/types'
import {
  actionOf, api, basename, capability, contextMenu, copyText, docError, docsVersion, editorDecorations, FindBar, getDoc, Icon, isMarkdownPath, languageName,
  lineHunks, loadDoc, marksOfHunks, MarkdownView, openConflict, openDiffTab, openFile, pick, prompt, registerAction, relPath, request, reveal,
  runAction, saveCursor, saveDoc, setActivePane, setCursorInfo, shortcutOf, showRaw, shownRaw, t, toast, toggleWrap, useCompletion, useEditorView,
  wordHunks,
} from './plugin'
import { HunkPopup, type HunkLine, type HunkView } from './HunkPopup'

/** Lines of a hunk shown on each side of its popup, and the context lines kept around it. */
const POPUP_LINES = 14
const CONTEXT_LINES = 2
/** Width the popup of a hunk does not pass. */
const POPUP_WIDTH = 620

function toDiagnostics(doc: Doc, list: LspDiagnostic[]): Diagnostic[] {
  return (list as any[]).map((d) => ({
    from: doc.offset(d.range.start.line, d.range.start.character),
    to: doc.offset(d.range.end.line, d.range.end.character),
    severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
    message: d.message,
    source: d.source,
  }))
}

export function FileEditor(props: { tab: TabState; paneId: string }) {
  const path = props.tab.path!
  let host!: HTMLDivElement
  const [hostEl, setHostEl] = createSignal<HTMLElement>()
  const [doc, setDoc] = createSignal<Doc | null>(getDoc(path))
  const [findOpen, setFindOpen] = createSignal(false)
  const [findInitial, setFindInitial] = createSignal('')
  const [findFocus, setFindFocus] = createSignal(0)
  const error = () => (docsVersion(), docError(path))

  onMount(() => {
    setHostEl(host)
    loadDoc(path).then((d) => setDoc(d))
  })

  const isActive = () => api.panes.isActive(props.paneId, props.tab.id)

  // Markdown: rendered by default, the source on demand, at about the same place.
  const markdown = isMarkdownPath(path)
  const rendered = () => markdown && !shownRaw(props.tab.id) && !!doc() && !error()
  let md: MarkdownViewApi | undefined
  const toggleMarkdown = (caretLine?: number) => {
    const v = view()
    if (!v) return
    if (rendered()) {
      const top = md?.topLine() ?? 0
      showRaw(props.tab.id, true)
      if (caretLine !== undefined) v.setSelection(v.doc.offset(caretLine, 0), undefined, false)
      v.scrollToLine(top)
      requestAnimationFrame(() => v.focus())
    } else {
      const top = v.visibleLines()[0]
      showRaw(props.tab.id, false)
      requestAnimationFrame(() => {
        md?.scrollToLine(top)
        md?.focus()
      })
    }
  }

  // The completion needs the view, the view forwards keys and keystrokes to the completion.
  let completion: ReturnType<typeof useCompletion> | null = null
  const view = useEditorView(doc, hostEl, {
    onKey: (e) => hunkKeys(e) || (completion?.onKey(e) ?? false),
    onType: (t) => {
      closeHunk()
      completion?.onType(t)
    },
    onSelection: (v) => {
      completion?.onSelection()
      const sel = v.getSelection()
      save(v)
      const { line, col } = v.doc.pos(sel.head)
      setCursorInfo({ line: line + 1, col: col + 1, sel: Math.abs(sel.head - sel.anchor), lang: languageName(v.doc.lang) })
    },
    onFolds: (v) => save(v),
    onCtrlClick: (v, off) => capability('language')?.gotoDeclaration(v.doc, off),
    onFocus: () => setActivePane(props.paneId),
    onMarkClick: (_, line) => openHunk(line),
    onDecoClick: (_, line, e) => {
      for (const p of editorDecorations()) p.decorations.gutterClick?.(path, line, e)
    },
    onDecoMenu: (_, line, e) => {
      const items = editorDecorations().flatMap((p) => p.decorations.gutterMenu?.(path, line) ?? [])
      if (items.length) contextMenu(e, items)
    },
    onHoverAt: (_, off, x, y) => void askHover(off, x, y),
    onDecosMoved: (_, moved) => decosMoved(moved),
    onScroll: (v) => {
      followHunk(v)
      closeHover()
    },
  })
  // Cursor, folds and chosen indentation of the file, kept in the session.
  function save(v: EditorView) {
    const sel = v.getSelection()
    const indent = v.doc.indentChosen ? (v.doc.indent() ?? undefined) : undefined
    saveCursor(path, { anchor: sel.anchor, head: sel.head, scroll: v.scroller.scrollTop, folds: v.foldedLines(), indent })
  }
  createEffect(
    on(
      () => doc()?.indent(),
      () => {
        const v = view()
        if (v && v.doc.indentChosen) save(v)
      },
      { defer: true },
    ),
  )
  const comp = useCompletion(view, doc)
  completion = comp

  // Restore the cursor and scroll of the file, then focus when this pane is the active one.
  createEffect(
    on(view, (v) => {
      if (!v) return
      const c = untrack(() => api.buffers.cursor(path))
      if (c) {
        if (c.indent && !v.doc.indentChosen) v.doc.chooseIndent(c.indent)
        if (c.folds?.length) v.restoreFolds(c.folds)
        v.scroller.scrollTop = c.scroll
        if (untrack(isActive)) v.setSelection(c.anchor, c.head, false)
        else v.restoreSelection({ anchor: c.anchor, head: c.head })
      } else if (untrack(isActive)) v.setSelection(0, 0, false)
      const { line, col } = v.doc.pos(c?.head ?? 0)
      if (untrack(isActive)) setCursorInfo({ line: line + 1, col: col + 1, sel: 0, lang: languageName(v.doc.lang) })
    }),
  )

  // Jumps requested by navigation (goto, search results, outline).
  createEffect(() => {
    const r = reveal()
    const v = view()
    if (!r || !v || r.path !== path || !untrack(isActive)) return
    untrack(() => {
      if (r.seq > revealSeen && rendered()) showRaw(props.tab.id, true)
      revealSeen = Math.max(revealSeen, r.seq)
      const t = r.target
      const from = t.offset ?? v.doc.offset(t.line ?? 0, t.col ?? 0)
      v.setSelection(from, t.end ?? from, false)
      v.scrollToOffset(from, true)
    })
  })

  createEffect(() => {
    const v = view()
    const d = doc()
    if (!v || !d) return
    d.changed()
    v.setDiagnostics(toDiagnostics(d, capability('language')?.diagnostics(path) ?? []))
  })

  // ---------- decorations given by the other plugins (editorDecorations, #187) ----------
  /** The marks, line classes and widgets of the enabled plugins for this file, ids scoped per plugin. */
  function collectDecos() {
    const gutter: GutterMark[] = []
    const lines: LineClass[] = []
    const widgets: LineWidget[] = []
    let lane = false
    for (const p of editorDecorations()) {
      const g = p.decorations.gutter?.(path)
      if (g) {
        lane = true
        for (const m of g) gutter.push({ ...m, id: `${p.id}:${m.id}` })
      }
      for (const m of p.decorations.lines?.(path) ?? []) lines.push({ ...m, id: `${p.id}:${m.id}` })
      for (const m of p.decorations.widgets?.(path) ?? []) widgets.push({ ...m, id: `${p.id}:${m.id}` })
    }
    return { gutter, lines, widgets, lane }
  }

  createEffect(() => {
    const v = view()
    if (!v) return
    const d = collectDecos()
    v.setGutterDecos(d.gutter, d.lane)
    v.setLineClasses(d.lines)
    v.setLineWidgets(d.widgets)
  })

  /** An edit moved or removed a plugin's marks: the plugin is told, with its own ids back. */
  function decosMoved(moved: MovedMark[]) {
    for (const p of editorDecorations()) {
      const pre = `${p.id}:`
      const own = moved.filter((m) => m.id.startsWith(pre)).map((m) => ({ ...m, id: m.id.slice(pre.length) }))
      if (own.length) p.decorations.moved?.(path, own)
    }
  }

  // The hover a plugin asks for: a popup at the mouse, closed by a move, a scroll or Escape.
  const [hover, setHover] = createSignal<{ x: number; y: number; text?: string; content?: () => JSX.Element } | null>(null)
  let hoverSeq = 0
  let hoverOff: (() => void) | undefined

  function closeHover() {
    hoverSeq++
    if (hover() === null) return
    setHover(null)
    hoverOff?.()
    hoverOff = undefined
  }

  async function askHover(off: number, x: number, y: number) {
    const seq = ++hoverSeq
    for (const p of editorDecorations()) {
      const h = await p.decorations.hover?.(path, off)
      if (seq !== hoverSeq) return
      if (!h) continue
      setHover({ x, y, text: h.text, content: h.content })
      if (!hoverOff) {
        const away = (e: MouseEvent) => {
          if ((e.target as HTMLElement).closest('.ed-hover')) return
          closeHover()
        }
        const keys = (e: KeyboardEvent) => e.key === 'Escape' && closeHover()
        document.addEventListener('mousemove', away)
        document.addEventListener('keydown', keys)
        hoverOff = () => {
          document.removeEventListener('mousemove', away)
          document.removeEventListener('keydown', keys)
        }
      }
      return
    }
    setHover(null)
  }
  onCleanup(() => hoverOff?.())

  // Change markers against HEAD or the last saved content, and the hunks behind them: a click on
  // a marker opens the popup of its hunk. Recomputed a moment after the edits.
  const [head] = createResource(
    () => (capability('git')?.status()?.repo ? { rev: capability('git')!.revision(), d: doc() } : null),
    async ({ d }) => {
      if (!d || d.readOnly) return null
      try {
        return (await capability('git')?.show(path, 'HEAD')) ?? null
      } catch {
        return null
      }
    },
  )
  // The *before* side of the markers never changes with the popup: HEAD when the file is in the
  // repository, its last saved content otherwise. The popup alone can show the other reference.
  const [side, setSide] = createSignal<'head' | 'base'>('head')
  const [refHunks, setRefHunks] = createSignal<Hunk[]>([])
  const [sideLines, setSideLines] = createSignal<string[]>([])
  const [sideHunks, setSideHunks] = createSignal<Hunk[]>([])
  /** The popup: the line it was opened at, the lines it shows, and its hunk among the changes of the side (-1: none). */
  const [popup, setPopup] = createSignal<{ anchor: number; region: [number, number]; idx: number } | null>(null)
  const [popupPos, setPopupPos] = createSignal({ left: 0, top: 0 })

  const untrackedFile = () => capability('git')?.status()?.files.some((f) => f.path === path && f.untracked) ?? false
  const canSwitchSide = () => !!capability('git')?.status()?.repo && !untrackedFile()
  const refSide = () => (capability('git')?.status()?.repo && !untrackedFile() ? 'head' : 'base')
  const shownSide = () => (canSwitchSide() ? side() : refSide())
  /** The content of a reference (null: HEAD not read yet). */
  function textFor(d: Doc, s: 'head' | 'base'): string | null {
    if (s === 'head') {
      const h = head()
      return h ? (h.exists ? h.content.replace(/\r\n/g, '\n') : '') : null
    }
    return d.base.replace(/\r\n/g, '\n')
  }

  let markTimer: number | undefined
  createEffect(() => {
    const v = view()
    const d = doc()
    if (!v || !d) return
    side()
    head()
    capability('git')?.revision()
    d.changed()
    clearTimeout(markTimer)
    if (d.readOnly) {
      setRefHunks([])
      setSideHunks([])
      v.setLineMarks(new Map())
      return
    }
    markTimer = window.setTimeout(() => {
      const b = d.text.split('\n')
      const rs = refSide()
      const refText = textFor(d, rs)
      const ra = refText === null ? [] : refText.split('\n')
      const rh = refText === null ? [] : lineHunks(ra, b) ?? []
      setRefHunks(rh)
      v.setLineMarks(marksOfHunks(rh, b))
      const ss = shownSide()
      if (ss === rs) {
        setSideLines(ra)
        setSideHunks(rh)
      } else {
        const st = textFor(d, ss)
        const sa = st === null ? [] : st.split('\n')
        setSideLines(sa)
        setSideHunks(st === null ? [] : lineHunks(sa, b) ?? [])
      }
      // The markers the popup was opened from are gone, or the side changed: keep it on its line.
      if (!rh.length) closeHunk()
      else reanchor()
    }, 250)
  })
  onCleanup(() => clearTimeout(markTimer))

  // ---------- the popup of a hunk ----------
  let offOutside: (() => void) | undefined

  /** Index of the hunk whose mark sits on that line (a pure deletion: the line after the gap). */
  function hunkAt(hs: Hunk[], line: number): number {
    const last = (doc()?.lineCount ?? 1) - 1
    for (let i = 0; i < hs.length; i++) {
      const [bs, bl] = hs[i].b
      if (line >= bs && line <= (bl === 0 ? Math.min(bs, last) : bs + bl - 1)) return i
    }
    const next = hs.findIndex((h) => h.b[0] >= line)
    return next >= 0 ? next : hs.length - 1
  }

  /** Index of the hunk of a side covering that line (-1: the line is unchanged against it). */
  function covering(hs: Hunk[], line: number): number {
    for (let i = 0; i < hs.length; i++) {
      const [bs, bl] = hs[i].b
      if (line >= bs && line <= (bl === 0 ? bs : bs + bl - 1)) return i
    }
    return -1
  }

  /** Line of the *before* text matching a line of the current text (the hunks above it shift it). */
  function alignOffset(hs: Hunk[], line: number): number {
    let d = 0
    for (const h of hs) {
      if (h.b[0] + h.b[1] <= line) d += h.a[1] - h.b[1]
      else break
    }
    return d
  }

  function openHunk(line: number) {
    const hs = refHunks()
    if (!hs.length) return
    const h = hs[hunkAt(hs, line)]
    setPopup({ anchor: line, region: h.b, idx: covering(sideHunks(), line) })
    placeHunk()
    offOutside?.()
    const away = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-testid="hunk-popup"]')) return
      closeHunk()
    }
    // Registered after the click that opened it: the marker's own mousedown must not close it.
    window.setTimeout(() => {
      document.addEventListener('mousedown', away)
      offOutside = () => document.removeEventListener('mousedown', away)
    })
  }

  /** Keeps the popup on the lines it shows, and re-picks its hunk for the side shown. */
  function reanchor() {
    const p = popup()
    if (!p) return
    const hs = sideHunks()
    const i = covering(hs, p.anchor)
    setPopup(i >= 0 ? { anchor: p.anchor, region: hs[i].b, idx: i } : { ...p, idx: -1 })
    placeHunk()
  }

  function closeHunk(refocus = false) {
    if (popup() === null) return
    setPopup(null)
    offOutside?.()
    offOutside = undefined
    if (refocus) view()?.focus()
  }
  onCleanup(() => offOutside?.())

  /** Anchored at the first line shown, flipped above when the pane is too short below it. */
  function placeHunk() {
    const v = view()
    const d = doc()
    const p = popup()
    if (!v || !d || !p) return
    const line = Math.min(p.region[0], d.lineCount - 1)
    const c = v.coordsAt(d.offset(line, 0))
    const rows = Math.min(p.region[1] + 2 * CONTEXT_LINES, POPUP_LINES)
    const height = 92 + rows * v.lineHeight
    const below = c.bottom + 6
    setPopupPos({
      left: Math.max(8, Math.min(c.left + 12, innerWidth - POPUP_WIDTH - 12)),
      top: below + height > innerHeight ? Math.max(8, c.top - height - 6) : below,
    })
  }

  /** The scroll closes the popup once its lines are out of view, and keeps it on them. */
  function followHunk(v: EditorView) {
    const p = popup()
    if (!p) return
    const [first, last] = v.visibleLines()
    const line = Math.min(p.region[0], v.doc.lineCount - 1)
    if (line < first || line > last) closeHunk()
    else placeHunk()
  }

  /** ArrowUp / ArrowDown walk the hunks, Escape closes the popup. */
  function hunkKeys(e: KeyboardEvent): boolean {
    if (popup() === null) return false
    if (e.key === 'Escape') {
      closeHunk(true)
      return true
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return stepHunk(e.key === 'ArrowDown' ? 1 : -1)
    return false
  }

  function stepHunk(dir: number): boolean {
    const v = view()
    const d = doc()
    const p = popup()
    const hs = sideHunks()
    if (!v || !d || !p || !hs.length) return false
    let i: number
    if (p.idx >= 0) i = (((p.idx + dir) % hs.length) + hs.length) % hs.length
    else if (dir > 0) i = hs.findIndex((h) => h.b[0] > p.anchor)
    else {
      i = -1
      for (let k = 0; k < hs.length; k++) if (hs[k].b[0] + Math.max(hs[k].b[1], 1) - 1 < p.anchor) i = k
      if (i < 0) i = hs.length - 1
    }
    if (i < 0) i = 0
    setPopup({ anchor: hs[i].b[0], region: hs[i].b, idx: i })
    const off = d.offset(Math.min(hs[i].b[0], d.lineCount - 1), 0)
    v.setSelection(off, off, false)
    v.scrollToOffset(off)
    placeHunk()
    return true
  }

  /** Any edit makes the hunks stale: the popup closes (they are recomputed right after). */
  createEffect(
    on(view, (v) => {
      if (!v) return
      const off = v.doc.onChange(() => closeHunk())
      onCleanup(off)
    }),
  )

  function hunkData(p: { anchor: number; region: [number, number]; idx: number }): HunkView {
    const a = sideLines()
    const b = doc()?.text.split('\n') ?? []
    const hs = sideHunks()
    const [bs, bl] = p.region
    const h = p.idx >= 0 ? hs[p.idx] : undefined
    // A hunk of the side shown, or the same lines against it when the line is unchanged there.
    const [as, al] = h ? h.a : [bs + alignOffset(hs, bs), 0]
    const lStart = h ? as : bs + (as - bs)
    const lLen = h ? al : bl
    /** One column: the lines shown, each paired with the line it is compared to on the other side. */
    const column = (
      arr: string[],
      start: number,
      len: number,
      pairOf: (l: number) => string | undefined,
      kindOf: (l: number, pair: string | undefined) => HunkLine['kind'],
    ) => {
      const from = Math.max(0, start - CONTEXT_LINES)
      const to = Math.min(arr.length, start + len + CONTEXT_LINES)
      const shown = Math.min(to - from, POPUP_LINES)
      const lines: HunkLine[] = []
      for (let l = from; l < from + shown; l++) {
        const text = arr[l] ?? ''
        const pair = pairOf(l)
        const kind = kindOf(l, pair)
        let spans: WordSpan[]
        if (pair === undefined) spans = text ? [{ text, changed: kind !== 'ctx' }] : []
        else if (pair === text) spans = text ? [{ text, changed: false }] : []
        // The spans of the line of this side (wordHunks compares it with the other side).
        else spans = wordHunks(text, pair).left
        lines.push({ no: l + 1, kind, spans })
      }
      return { lines, hidden: to - from - shown }
    }
    const inHunk = (l: number, start: number, len: number) => l >= start && l < start + len
    const left = column(
      a,
      lStart,
      lLen,
      (l) => (h && inHunk(l, as, al) && l - as < bl ? b[bs + (l - as)] : h ? undefined : b[l - (as - bs)]),
      (l, pair) => (h ? (inHunk(l, as, al) ? 'del' : 'ctx') : pair !== undefined && pair !== a[l] ? 'mod' : 'ctx'),
    )
    const right = column(
      b,
      bs,
      bl,
      (l) => (h && inHunk(l, bs, bl) && l - bs < al ? a[as + (l - bs)] : h ? undefined : a[l + (as - bs)]),
      (l, pair) => (h ? (inHunk(l, bs, bl) ? (al === 0 ? 'add' : 'mod') : 'ctx') : pair !== undefined && pair !== b[l] ? 'mod' : 'ctx'),
    )
    return {
      from: bs,
      to: bl === 0 ? bs : bs + bl - 1,
      added: h ? bl : 0,
      removed: h ? al : 0,
      index: p.idx,
      total: hs.length,
      side: shownSide(),
      canSwitch: canSwitchSide(),
      before: left.lines,
      after: right.lines,
      hiddenBefore: left.hidden,
      hiddenAfter: right.hidden,
      truncated: left.hidden > 0 || right.hidden > 0,
    }
  }

  /** Puts the old lines back (or drops the added ones), as one undo step. */
  function revertHunk(p: { idx: number }) {
    const v = view()
    const d = doc()
    const h = sideHunks()[p.idx]
    if (!v || !d || !h || d.readOnly) return
    const [as, al] = h.a
    const [bs, bl] = h.b
    const old = sideLines().slice(as, as + al)
    const atEnd = bs >= d.lineCount
    const from = atEnd ? d.text.length : d.lineStart(bs)
    const to = bs + bl >= d.lineCount ? d.text.length : d.lineStart(bs + bl)
    // Each restored line keeps its newline, except at the very end of the text; a pure deletion
    // sits on the line after the gap, a pure addition is simply removed.
    const text =
      bl === 0
        ? atEnd ? '\n' + old.join('\n') : old.join('\n') + '\n'
        : al === 0
          ? ''
          : bs + bl < d.lineCount ? old.join('\n') + '\n' : old.join('\n')
    closeHunk()
    d.breakUndoGroup()
    d.transact(() => d.replace(from, to, text, 'hunk-revert'))
    d.breakUndoGroup()
    v.focus()
  }

  const copyHunk = (p: { idx: number }) => {
    const h = sideHunks()[p.idx]
    if (!h) return
    const text = sideLines().slice(h.a[0], h.a[0] + h.a[1]).join('\n')
    if (text) copyText(text)
  }

  // Context menu of the text: code navigation, clipboard, comment, file, then the plugins.
  const editorMenu = (e: MouseEvent) => {
    const v = view()
    const d = doc()
    if (!v || !d || !(e.target as HTMLElement).closest('.ed')) return
    const offset = v.offsetAt(e.clientX, e.clientY) ?? v.getSelection().head
    const pluginItems = editorDecorations().flatMap((p) => p.decorations.menu?.(path, offset) ?? [])
    const content = host.querySelector<HTMLElement>('.ed-content')
    // An action of a plugin that is off (the language servers) is not offered.
    const item = (id: string, disabled = false) => {
      const a = actionOf(id)
      return a ? [{ label: t(a.label), hint: shortcutOf(id), disabled, action: () => void runAction(id) }] : []
    }
    const sep = { separator: true, label: '' }
    const paste = async () => {
      const data = new DataTransfer()
      data.setData('text/plain', await navigator.clipboard.readText().catch(() => ''))
      content?.focus()
      content?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }
    contextMenu(e, [
      ...item('lsp.definition'),
      ...item('lsp.references'),
      ...item('lsp.implementation'),
      ...item('lsp.rename', d.readOnly),
      ...item('lsp.format', d.readOnly),
      sep,
      { label: t('Cut'), hint: 'Ctrl+X', disabled: d.readOnly, action: () => document.execCommand('cut') },
      { label: t('Copy'), hint: 'Ctrl+C', action: () => document.execCommand('copy') },
      { label: t('Paste'), hint: 'Ctrl+V', disabled: d.readOnly, action: () => void paste() },
      ...item('edit.pasteHistory', d.readOnly),
      sep,
      ...item('edit.toggleComment', d.readOnly),
      ...item('edit.duplicateLine', d.readOnly),
      sep,
      {
        label: t('Show in the explorer'),
        disabled: relPath(path) === path,
        action: () => {
          api.showTool('explorer')
          capability('files')?.reveal(path, true)
        },
      },
      { label: t('Copy the relative path'), action: () => copyText(relPath(path)) },
      ...(pluginItems.length ? [sep, ...pluginItems] : []),
    ])
  }
  onCleanup(api.editor.register(() => (view() && doc() && isActive() ? { view: view()!, doc: doc()! } : null)))
  const when = (f: (v: EditorView, d: Doc) => void, needFocus = false) => () => {
    const v = view()
    const d = doc()
    if (!v || !d || !isActive() || (needFocus && !v.hasFocus())) return false
    // Another editor has the focus (the message box of the assistant): its own actions run.
    const other = api.editor.View.of(document.activeElement)
    if (other && other !== v) return false
    f(v, d)
  }
  const offs: (() => void)[] = [
    registerAction('file.save', when((_, d) => saveDoc(d))),
    registerAction('edit.undo', when((v) => v.undo(), true)),
    registerAction('edit.redo', when((v) => v.redo(), true)),
    registerAction('edit.duplicateLine', when((v) => v.duplicateLine(), true)),
    registerAction('edit.deleteLine', when((v) => v.deleteLine(), true)),
    registerAction('edit.toggleComment', when((v) => v.toggleComment(), true)),
    registerAction('edit.nextOccurrence', when((v) => v.addNextOccurrence(), true)),
    registerAction('edit.unselectOccurrence', when((v) => v.removeLastOccurrence(), true)),
    registerAction('edit.allOccurrences', when((v) => v.selectAllOccurrences(), true)),
    registerAction('edit.selectAll', when((v) => v.selectAll(), true)),
    registerAction('edit.fold', when((v) => v.fold(), true)),
    registerAction('edit.unfold', when((v) => v.unfold(), true)),
    registerAction('edit.foldAll', when((v) => v.foldAll(), true)),
    registerAction('edit.unfoldAll', when((v) => v.unfoldAll(), true)),
    registerAction('view.wordWrap', when((_, d) => toggleWrap(d))),
    registerAction('view.markdown', () => (markdown && isActive() ? toggleMarkdown() : false)),
    registerAction('nav.subwordLeft', when((v) => v.moveSubword(-1, false), true)),
    registerAction('nav.subwordRight', when((v) => v.moveSubword(1, false), true)),
    registerAction('nav.subwordLeftSelect', when((v) => v.moveSubword(-1, true), true)),
    registerAction('nav.subwordRightSelect', when((v) => v.moveSubword(1, true), true)),
    registerAction('search.find', when((v) => {
      if (rendered()) toggleMarkdown()
      if (findOpen() && !v.hasFocus()) {
        setFindOpen(false)
        v.focus()
        return
      }
      const sel = v.selectedText()
      setFindInitial(sel && !sel.includes('\n') ? sel : findInitial())
      setFindOpen(true)
      setFindFocus((n) => n + 1)
    })),
    registerAction('conflict.resolve', when((_, d) => {
      if (d.conflict()) openConflict(d)
    })),
    registerAction('edit.complete', when(() => completion?.open(), true)),
    registerAction('nav.gotoLine', when(async (v, d) => {
      const { line, col } = d.pos(v.getSelection().head)
      const s = await prompt({ title: t('Go to line'), label: t('Line[:column] (1 – {n})', { n: d.lineCount }), value: `${line + 1}:${col + 1}` })
      if (!s) return
      const [l, c] = s.split(':').map((x) => parseInt(x, 10))
      if (!l) return
      const off = d.offset(l - 1, (c || 1) - 1)
      v.setSelection(off)
      v.scrollToOffset(off, true)
    })),
    registerAction('nav.test', when(async (_, d) => {
      const r = await request('fs.related', { path: d.path })
      const list: string[] = r.isTest ? r.sources : r.tests
      if (!list.length) {
        toast(r.isTest ? t('Source of the test not found') : t('No test found for this file'), 'info')
        return
      }
      if (list.length === 1) return void openFile(list[0])
      const p = await pick({ placeholder: r.isTest ? t('Tested sources') : t('Tests'), pathDetail: true, items: list.map((x) => ({ label: basename(x), detail: relPath(x), value: x })) })
      if (p) openFile(p)
    })),
    registerAction('nav.related', when(async (_, d) => {
      const r = await request('fs.related', { path: d.path })
      const items = [
        ...r.tests.map((x: string) => ({ label: basename(x), detail: relPath(x), hint: 'test', value: x })),
        ...r.sources.map((x: string) => ({ label: basename(x), detail: relPath(x), hint: 'source', value: x })),
        ...r.related.map((x: string) => ({ label: basename(x), detail: relPath(x), value: x })),
      ]
      if (!items.length) {
        toast(t('No related file'), 'info')
        return
      }
      const p = await pick<string>({ placeholder: t('Related symbols'), items })
      if (p) openFile(p)
    })),
  ]
  onCleanup(() => offs.forEach((f) => f()))

  const keepMine = () => {
    const d = doc()
    const c = d?.conflict()
    if (!d || !c) return
    d.setBase(c.remote, c.rev)
    d.setConflict(null)
    toast(t('Your version is kept (save to overwrite the file)'), 'info')
  }
  const takeTheirs = () => {
    const d = doc()
    const c = d?.conflict()
    if (!d || !c) return
    d.setText(c.remote, 'remote')
    d.setBase(c.remote, c.rev)
    d.setConflict(null)
  }

  return (
    <div class="file-editor">
      <Show when={doc()?.conflict()}>
        <div class="banner banner-conflict" role="alert">
          <span>{t('The file changed on disk while you were editing it, and the automatic merge failed. Your version is kept.')}</span>
          <button class="btn small primary" onClick={() => openConflict(doc()!)}>
            {t('Resolve')} ({shortcutOf('conflict.resolve')})
          </button>
          <button class="btn small" onClick={keepMine}>
            {t('Keep my version')}
          </button>
          <button class="btn small" onClick={takeTheirs}>
            {t('Take the new version')}
          </button>
        </div>
      </Show>
      <Show when={doc()?.deleted()}>
        <div class="banner banner-warn">{t('This file was deleted from the disk. Saving it creates it again.')}</div>
      </Show>
      <Show when={!doc()?.readOnly && capability('language')?.missingServer(path)} keyed>
        {(sv) => (
          <Show when={!capability('language')!.notNow(sv.lang)}>
            <div class="banner banner-info" data-testid="server-banner">
              <span>{t('No language server for {language}: no diagnostics, completion nor navigation.', { language: sv.language })}</span>
              <Show
                when={sv.install && !sv.needs}
                fallback={<span>{sv.needs ? t('Install {needs} to install {program}.', { needs: sv.needs, program: sv.program }) : t('Install {program} on the machine of the project.', { program: sv.program })}</span>}
              >
                <button class="btn small primary" title={sv.command} onClick={() => void capability('language')!.installServer(sv)}>
                  {t('Install {program}', { program: sv.program })}
                </button>
              </Show>
              <button class="btn small" onClick={() => capability('language')!.putOff(sv.lang)}>
                {t('Not now')}
              </button>
            </div>
          </Show>
        )}
      </Show>
      <Show when={doc()?.readOnly}>
        <div class="banner banner-info">{t('Read-only: file outside the project ({path})', { path })}</div>
      </Show>
      <Show when={error()}>
        <div class="empty-pane">{error() === 'binary' ? t('Binary or too large file: no preview.') : t('Cannot read: {error}', { error: error() ?? '' })}</div>
      </Show>
      <div class="editor-host" onContextMenu={editorMenu}>
        {/* The view is mounted by hand: it gets its own node, never touched by Solid. */}
        <div class="editor-mount" ref={host} inert={rendered()} />
        <Show when={rendered()}>
          <MarkdownView doc={doc()!} path={path} api={(a) => (md = a)} onEdit={(line) => toggleMarkdown(line)} />
        </Show>
        <Show when={markdown && doc() && !error() && !findOpen()}>
          <button
            class="icon-btn md-toggle"
            classList={{ on: !rendered() }}
            title={`${rendered() ? t('Show the source') : t('Show the rendering')} (${shortcutOf('view.markdown')})`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMarkdown()}
            data-testid="md-toggle"
          >
            <Icon name={rendered() ? 'code' : 'eye'} size={16} />
          </button>
        </Show>
        <Show when={findOpen() && view() && doc()}>
          <FindBar view={view()!} doc={doc()!} initial={findInitial()} focusSignal={findFocus()} onClose={() => setFindOpen(false)} />
        </Show>
        <comp.Popup />
        <Show when={hover()}>
          {(h) => (
            <div class="ed-hover" data-testid="editor-hover" style={{ left: `${h().x + 10}px`, top: `${h().y + 18}px` }}>
              {(() => {
                const c = h().content
                return c ? c() : h().text
              })()}
            </div>
          )}
        </Show>
        <Show when={popup() !== null}>
          <HunkPopup
            view={() => hunkData(popup()!)}
            pos={popupPos}
            onClose={() => closeHunk(true)}
            onRevert={() => revertHunk(popup()!)}
            onCopy={() => copyHunk(popup()!)}
            onFullDiff={() => openDiffTab(path)}
            onSide={(s) => setSide(s)}
          />
        </Show>
      </div>
    </div>
  )
}

/** Reveals handled: an old one does not show the source of a Markdown file opened again. */
let revealSeen = 0

/** Read-only text (DDL, definitions, merge markers). */
