// Console tool: terminals and tasks run by the pod (they survive reloads), one xterm instance
// per console, kept while the page lives. It is the terminal capability of the Exec plugin.
import { createEffect, createRoot, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { ConsoleInfo } from '@ide/capabilities'
import type { MenuItem } from '@ide/api'
import { api, contextMenu, copyText, desk, errorToast, Icon, prompt, t, WorktreeChip } from './plugin'
import { adHocCommand, loadCommands } from './commands'
import { openCommands } from './CommandsModal'
import { Launcher } from './Launcher'

export type { ConsoleInfo }

const [consoles, setConsoles] = createSignal<ConsoleInfo[]>([])
export { consoles, setConsoles }

/** The Console never has zero tab: the least it holds is a **new tab**, which shows the launcher.
 *  Picking a tile converts it into the console of that command (same place in the tabs). */
export const NEW_TAB = 'new'
const [newTab, setNewTab] = createSignal(false)
export { newTab, setNewTab }
// Whether the consoles of the window have been listed once: without that, the Console would show
// its new tab while the list is still on its way.
const [listed, setListed] = createSignal(false)

/** The new tab is the one shown: the next console created takes its place. */
export function converting() {
  return newTab() && desk.get().active === NEW_TAB
}

/** Escape in the launcher: the grid lets go of the keyboard (set by ConsoleTool). */
export let releaseNewTabFocus = () => {}

/** Shows the new tab (the launcher) without forcing the tool open. There is only one. */
export function showNewTab() {
  setNewTab(true)
  desk.set((s) => (s.active = NEW_TAB))
}

/** + and console.new: shows the Console tool on the new tab. */
export function openNewTab() {
  showNewTab()
  api.showTool('console')
  void loadCommands()
}

/** Consoles of a worktree of the window (its project by default). */
export function setConsoleList(list: ConsoleInfo[], pid = api.project.id()) {
  const mine = list.map((c) => ({ ...c, project: pid }))
  setConsoles((l) => [...l.filter((c) => c.project !== pid), ...mine])
  if (pid === api.project.id()) setListed(true)
  // Forget the terminals that do not exist in the pod anymore.
  for (const id of terms.keys()) if (!consoles().some((c) => c.id === id)) disposeTerm(id)
}

/** Lists the consoles of every worktree attached to the window again (after a reconnection),
 *  and gets the output the open terminals missed: a pod restarted with a keeper still runs them. */
export async function refreshConsoles() {
  for (const pid of api.project.attached()) await api.rpcIn<ConsoleInfo[]>(pid, 'console.list').then((l) => setConsoleList(l, pid), () => {})
  for (const [id, entry] of terms) attachTerm(id, entry, entry.next)
}

/** Starts following the consoles: the events of the pod, the worktrees attached, the look. */
export function watchConsoles() {
  // The consoles of a worktree come with it and go with it.
  createRoot(() =>
    createEffect(
      on(
        () => api.project.attached(),
        (ids, prev) => {
          if (!prev) return
          for (const pid of ids) if (!prev.includes(pid) && pid !== api.project.id()) api.rpcIn<ConsoleInfo[]>(pid, 'console.list').then((l) => setConsoleList(l, pid), () => {})
          for (const pid of prev) if (!ids.includes(pid)) setConsoleList([], pid)
        },
      ),
    ),
  )
  api.on('console.created', (c: ConsoleInfo, from) => setConsoles((l) => (l.some((x) => x.id === c.id) ? l : [...l, { ...c, project: from ?? api.project.id() }])))
  api.on('console.closed', (e: { id: string }) => {
    setConsoles((l) => l.filter((c) => c.id !== e.id))
    disposeTerm(e.id)
  })
  api.on('console.renamed', (e: { id: string; title: string }) => setConsoles((l) => l.map((c) => (c.id === e.id ? { ...c, title: e.title } : c))))
  api.on('console.exit', (e: { id: string; code: number }) => {
    setConsoles((l) => l.map((c) => (c.id === e.id ? { ...c, exited: true, code: e.code } : c)))
    const entry = terms.get(e.id)
    if (entry) termExited(entry, e.code)
  })
  api.on('console.output', (e: { id: string; data: string; offset: number }) => {
    const t = terms.get(e.id)
    if (t?.ready) writeAt(t, e.offset, b64(e.data))
    else t?.queue.push(e)
  })
  createRoot(() =>
    createEffect(
      on(
        () => [api.theme.terminal(), api.theme.font()] as const,
        ([theme, font]) => {
          for (const t of terms.values()) {
            t.term.options.theme = theme
            t.term.options.fontFamily = font.family
            t.term.options.fontSize = font.size
            try {
              t.fit.fit()
            } catch {
              /* hidden */
            }
          }
        },
        { defer: true },
      ),
    ),
  )
  watchTrail()
}

const projectOf = (id: string) => consoles().find((c) => c.id === id)?.project


function b64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

// ---------- xterm instances ----------

interface TermEntry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  ready: boolean
  /** Output received while the scrollback is asked. */
  queue: { data: string; offset: number }[]
  /** Offset of the next byte of output expected. */
  next: number
  /** The end of the process is written. */
  exited?: boolean
  // Channel of the tunnel for this terminal (its own input and output), null on a
  // WebSocket.
  ch: Awaited<ReturnType<typeof api.channel.open>>
}
const terms = new Map<string, TermEntry>()

/** Writes output at its offset: what the terminal already shows is skipped. */
function writeAt(entry: TermEntry, offset: number, data: Uint8Array) {
  if (offset < entry.next) data = data.subarray(Math.min(data.length, entry.next - offset))
  if (data.length) entry.term.write(data)
  entry.next = Math.max(entry.next, offset + data.length)
}

/** Gets the scrollback of a console (from the offset the terminal has, on a reconnection). */
function attachTerm(id: string, entry: TermEntry, from?: number) {
  entry.ready = false
  api.rpcIn(projectOf(id), 'console.attach', from === undefined ? { id } : { id, from })
    .then((r) => {
      if (r.data) writeAt(entry, r.start ?? entry.next, b64(r.data))
      entry.next = Math.max(entry.next, r.offset ?? entry.next)
      for (const d of entry.queue.splice(0)) writeAt(entry, d.offset ?? entry.next, b64(d.data))
      entry.ready = true
      if (r.info.exited) termExited(entry, r.info.code)
    })
    .catch(() => (entry.ready = true))
}

function termExited(entry: TermEntry, code: number) {
  if (entry.exited) return
  entry.exited = true
  entry.term.write(`\r\n\x1b[2m[${t('process exited, code {code}', { code })}]\x1b[0m\r\n`)
}

function getTerm(id: string): TermEntry {
  let te = terms.get(id)
  if (te) return te
  const el = document.createElement('div')
  el.className = 'term-host'
  const term = new Terminal({
    fontFamily: api.theme.font().family,
    fontSize: api.theme.font().size,
    theme: api.theme.terminal(),
    scrollback: 10000,
    allowProposedApi: true,
    cursorBlink: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // Ctrl+click (Cmd+click) opens a link; a plain click stays a click in the terminal.
  term.loadAddon(new WebLinksAddon((e, uri) => (e.ctrlKey || e.metaKey) && window.open(uri, '_blank', 'noopener')))
  // Ctrl+C copies the selection instead of interrupting the command; Ctrl+Shift+C always copies.
  term.attachCustomKeyEventHandler((e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'c') return true
    if (!term.hasSelection()) return !e.shiftKey
    if (e.type === 'keydown') {
      copyText(term.getSelection())
      term.clearSelection()
    }
    e.preventDefault()
    return false
  })
  term.open(el)
  const entry: TermEntry = { term, fit, el, ready: false, queue: [], next: 0, ch: null }
  terms.set(id, entry)
  // In the tunnel, each terminal has its own channel: its input and its output go on it,
  // so a long scrollback never delays the rpc channel. On a WebSocket, ch stays null.
  void api.channel.open('term:' + id).then((ch) => (entry.ch = ch), () => {})
  term.onData((data) => api.channel.notify(entry.ch, 'console.input', { id, data }, projectOf(id)))
  term.onResize(({ cols, rows }) => api.notifyIn(projectOf(id), 'console.resize', { id, cols, rows }))
  attachTerm(id, entry)
  return entry
}

function disposeTerm(id: string) {
  const t = terms.get(id)
  if (!t) return
  t.term.dispose()
  t.el.remove()
  terms.delete(id)
}

/**
 * Shows a console in a container element and keeps it fitted. A console has one terminal per
 * window: shown in two places (the Console tool and a tile), the last one mounted has it and
 * the other offers to bring it back with a click.
 */
export function TermView(props: { id: string; focus?: boolean }) {
  let host!: HTMLDivElement
  let claim = () => {}
  onMount(() => {
    const t = getTerm(props.id)
    host.appendChild(t.el)
    claim = () => {
      if (t.el.parentElement === host) return
      host.appendChild(t.el)
      requestAnimationFrame(fit)
    }
    const fit = () => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) {
        try {
          t.fit.fit()
        } catch {
          /* not laid out yet */
        }
      }
    }
    const ro = new ResizeObserver(() => requestAnimationFrame(fit))
    ro.observe(host)
    requestAnimationFrame(() => {
      fit()
      // A popup opened meanwhile (a launcher) keeps the keyboard.
      if (props.focus && !document.activeElement?.closest('.pick, .modal, .ctx-menu, .cmd-launcher')) t.term.focus()
    })
    onCleanup(() => {
      ro.disconnect()
      if (t.el.parentElement === host) t.el.remove()
    })
  })
  return <div class="term-container" ref={host} data-elsewhere={t('Shown in another place: click to bring it here')} onPointerDown={() => claim()} />
}

// ---------- actions ----------

/** Starts a console; it shows in the Console tool unless show is false (a tile takes it). */
export async function newConsole(o: { cwd?: string; command?: string[]; title?: string; kind?: 'terminal' | 'task'; show?: boolean } = {}) {
  try {
    const info: ConsoleInfo = { ...(await api.rpc('console.create', { kind: o.kind ?? 'terminal', title: o.title, command: o.command, cwd: o.cwd, cols: 120, rows: 30 })), project: api.project.current() }
    setConsoles((l) => (l.some((x) => x.id === info.id) ? l : [...l, info]))
    // The new tab shown converts into this console.
    if (converting()) setNewTab(false)
    if (o.show !== false) api.showTool('console')
    desk.set((s) => (s.active = info.id))
    return info
  } catch (e) {
    errorToast(e)
  }
}

export async function runTask() {
  const cmd = await prompt({ title: t('Run a command'), label: t('In {folder}', { folder: api.project.root() }), placeholder: 'npm run build, go test ./…, make…' })
  if (!cmd?.trim()) return
  await newConsole({ kind: 'task', command: ['sh', '-c', cmd], title: cmd })
}

async function closeConsole(id: string) {
  try {
    await api.rpcIn(projectOf(id), 'console.close', { id })
  } catch {
    /* already gone */
  }
  setConsoles((l) => l.filter((c) => c.id !== id))
  disposeTerm(id)
  if (desk.get().active === id) desk.set((s) => (s.active = consoles()[0]?.id ?? null))
  // The Console is never left without a tab.
  if (!consoles().length) showNewTab()
}

async function renameConsole(c: ConsoleInfo) {
  const title = await prompt({ title: t('Rename the console'), value: c.title })
  if (title) api.rpcIn(c.project, 'console.rename', { id: c.id, title }).catch(errorToast)
}

// ---------- tools ----------

/** Consoles in the order of their tabs (session), the new ones last. */
export function ordered() {
  const rank = (id: string) => {
    const i = desk.get().order.indexOf(id)
    return i < 0 ? Infinity : i
  }
  return [...consoles()].sort((a, b) => rank(a.id) - rank(b.id))
}

// Console tabs shown before (back) and after (forward) the active one, for the mouse buttons:
// every change of the active console is recorded, but the moves of navigateConsoles.
const consoleTrail = { back: [] as string[], forward: [] as string[] }
let replayed: string | null = null
function watchTrail() {
createRoot(() =>
  createEffect(
    on(
      () => desk.get().active,
      (cur, prev) => {
        if (cur === replayed) return void (replayed = null)
        if (!prev || prev === cur) return
        const b = consoleTrail.back
        if (b[b.length - 1] !== prev) b.push(prev)
        if (b.length > 50) b.shift()
        consoleTrail.forward.length = 0
      },
      { defer: true },
    ),
  ),
)
}

/** Shows the console tab shown before (-1) or after (1); one closed since is skipped. */
export function navigateConsoles(dir: -1 | 1) {
  const from = consoleTrail[dir < 0 ? 'back' : 'forward']
  const to = consoleTrail[dir < 0 ? 'forward' : 'back']
  const cur = desk.get().active
  for (let id = from.pop(); id; id = from.pop()) {
    if (id === cur || !consoles().some((c) => c.id === id)) continue
    if (cur) to.push(cur)
    replayed = id
    desk.set((s) => (s.active = id))
    return
  }
}

function moveConsole(id: string, index: number) {
  const ids = ordered().map((c) => c.id)
  desk.set((s) => (s.order = api.ui.tabDrop.moveItem(ids, ids.indexOf(id), index)))
}

/** The items the Exec plugin adds to the ⋮ menu of the Console (`toolMenu` contribution). */
export function consoleMenu(): MenuItem[] {
  return [
    { label: t('New tab'), action: () => openNewTab() },
    { label: t('Edit the saved commands…'), action: () => openCommands() },
    { label: t('Refresh'), action: () => void refreshConsoles() },
  ]
}

let dragged: string | null = null

export function ConsoleTool() {
  // A console that no longer exists (pod restarted) falls back to the first one, or to the new tab.
  const active = () => {
    const a = desk.get().active
    if (a === NEW_TAB && newTab()) return NEW_TAB
    if (consoles().some((c) => c.id === a)) return a
    return ordered()[0]?.id ?? (newTab() ? NEW_TAB : null)
  }
  const setActive = (id: string) => desk.set((s) => (s.active = id))
  // The new tab shown: the keyboard goes to the launcher (a few frames: the tiles are rebuilt
  // when the commands and the consoles settle). Escape in the launcher breaks it.
  let focusToken = 0
  releaseNewTabFocus = () => focusToken++
  const focusLauncher = (token = ++focusToken, frames = 12) =>
    requestAnimationFrame(() => {
      if (token !== focusToken || active() !== NEW_TAB) return
      const el = document.querySelector<HTMLElement>('.cmd-launcher .cmd-tile[tabindex="0"]')
      const ae = document.activeElement
      // Nothing else owns the keyboard (no modal, no terminal): the grid takes it, and keeps it
      // while the tiles are rebuilt.
      if (el && (!ae || ae === document.body || ae.closest('.cmd-launcher') || !ae.closest('.modal, .pick, .ctx-menu, .xterm'))) el.focus()
      if (frames > 1) focusLauncher(token, frames - 1)
    })
  createEffect(
    on(
      active,
      (a) => {
        if (a !== NEW_TAB) return
        void loadCommands()
        focusLauncher()
      },
      { defer: true },
    ),
  )
  // The Console is never without a tab: with no console, the new tab (the launcher) is shown.
  if (listed() && !consoles().length && !newTab()) showNewTab()
  createEffect(
    on(
      () => consoles().length,
      (n) => {
        if (!n && listed() && !newTab()) showNewTab()
      },
      { defer: true },
    ),
  )

  return (
    <div class="panel">
      <div class="tabbar tool-tabbar console-tabs" role="tablist" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && api.ui.tabDrop.setDropAt(null)}>
        <For each={ordered()}>
          {(c, i) => (
            <div
              class="tab"
              role="tab"
              aria-selected={active() === c.id}
              classList={{ active: active() === c.id, exited: c.exited, ...api.ui.tabDrop.dropClasses('consoles', i(), consoles().length) }}
              draggable="true"
              onDragStart={() => (dragged = c.id)}
              onDragEnd={() => ((dragged = null), api.ui.tabDrop.setDropAt(null))}
              onDragOver={(e) => {
                if (!dragged) return
                e.preventDefault()
                api.ui.tabDrop.setDropAt({ bar: 'consoles', index: api.ui.tabDrop.dropIndex(e, i()) })
              }}
              onDrop={(e) => {
                if (!dragged) return
                e.preventDefault()
                moveConsole(dragged, api.ui.tabDrop.dropIndex(e, i()))
                dragged = null
                api.ui.tabDrop.setDropAt(null)
              }}
              title={c.command?.join(' ') ?? c.title}
              onClick={() => setActive(c.id)}
              onDblClick={() => renameConsole(c)}
              onContextMenu={(e) =>
                contextMenu(
                  e,
                  // The same core items as the ⋮ of the tile or of the zone, then the Console's own
                  // (its Close closes the console, not a tab of a pane).
                  api.ui.toolMenu(
                    { id: '', kind: 'console', console: c.id },
                    [
                      ...(api.tiles.active() ? [{ label: t('Open in a new tile'), action: () => api.tiles.open({ kind: 'console', console: c.id }) }] : []),
                      { label: t('Rename…'), action: () => void renameConsole(c) },
                      ...(adHocCommand(c) ? [{ label: t('Save “{command}” as a command…', { command: adHocCommand(c)!.length > 40 ? adHocCommand(c)!.slice(0, 40) + '…' : adHocCommand(c)! }), action: () => openCommands({ draft: { name: c.command![2].split('\n')[0].slice(0, 40), command: c.command![2] } }) }] : []),
                    ],
                    { label: t('Close'), action: () => void closeConsole(c.id) },
                  ),
                )
              }
              onMouseDown={(e) => e.button === 1 && (e.preventDefault(), closeConsole(c.id))}
            >
              <Icon name={c.kind === 'task' ? 'play' : 'terminal'} size={13} />
              <span class="tab-title">{c.title}</span>
              <WorktreeChip project={c.project} />
              <Show when={c.exited}>
                <span class={c.code === 0 ? 'ok' : 'danger'}>{c.code}</span>
              </Show>
              <button class="tab-close" title={t('Close')} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), closeConsole(c.id))}>
                <span class="x">✕</span>
              </button>
            </div>
          )}
        </For>
        <Show when={newTab()}>
          <div class="tab" role="tab" aria-selected={active() === NEW_TAB} classList={{ active: active() === NEW_TAB }} title={t('New tab: pick a command, or a new terminal')} data-testid="console-new-tab" onClick={() => (setActive(NEW_TAB), queueMicrotask(() => document.querySelector<HTMLElement>('.cmd-launcher .cmd-tile[tabindex="0"]')?.focus()))}>
            <Icon name="plus" size={13} />
            <span class="tab-title">{t('New tab')}</span>
            <WorktreeChip project={api.project.current()} />
            <Show when={consoles().length}>
              <button class="tab-close" title={t('Close')} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), (setNewTab(false), desk.set((s) => (s.active = ordered()[0]?.id ?? null))))}>
                <span class="x">✕</span>
              </button>
            </Show>
          </div>
        </Show>
        <button class="icon-btn small" title={`${t('New tab')} (${api.keys.shortcut('console.new')})`} onClick={openNewTab} data-testid="console-new-tab-button">
          <Icon name="plus" />
        </button>
      </div>
      <div class="tool-body">
        <Show when={active() === NEW_TAB}>
          <Launcher />
        </Show>
        <For each={consoles()}>
          {(c) => (
            <div class="term-slot" style={{ display: active() === c.id ? 'block' : 'none' }}>
              <TermView id={c.id} focus={active() === c.id} />
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
