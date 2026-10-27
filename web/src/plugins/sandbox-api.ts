// The sandbox API of apiVersion 1: what the module of an external plugin gets in its frame as the
// global `ide`, and the messages the frame and the page exchange over its MessagePort. The
// bootstrap (`sandbox.ts`) builds `ide`; `serveFrame` answers each `FrameCall`. The plugin SDK
// (github.com/antennae-space/plugin-sdk) ships a copy of this file, checked against it: change
// it only to add, never to remove, while apiVersion stays 1.

/** The CSS variables of the theme (`--bg`, `--fg`, `--accent`…), and `color-scheme`. */
export type SandboxTheme = Record<string, string>

/** A message kind of `toast`. */
export type ToastKind = 'info' | 'warn' | 'error' | 'ok'

/** A view of the frame: its id in `contributes`, and the state kept with its tab (a tab view). */
export type SandboxView = { id: string; state?: unknown }

/**
 * What a plugin's module registers: its views by id, its commands by id, and the methods of the
 * capabilities it provides (run in its background frame, #155).
 */
export type SandboxContributions = {
  views?: Record<string, (el: HTMLElement, ide: SandboxAPI) => void>
  commands?: Record<string, (ide: SandboxAPI) => void>
  services?: Record<string, Record<string, (...args: never[]) => unknown>>
}

/**
 * A capability of another external plugin (`ide.use`), one the manifest requires: its methods,
 * the values its provider publishes, its events.
 */
export interface SandboxService {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  /** A value published, undefined before the first one arrives. */
  value<T = unknown>(key: string): T | undefined
  onValue(key: string, f: (value: unknown) => void): void
  on(event: string, f: (data: unknown) => void): void
}

/** The text and the selection of the editor of a tab (offsets in UTF-16 code units). */
export type SandboxEditorState = { text: string; from: number; to: number }

/**
 * The editor of the core above the view, in a tab view whose manifest asks it (`editor`): the
 * page pushes its text and selection, so the getters answer at once.
 */
export interface SandboxEditor {
  text(): string
  selection(): { from: number; to: number; text: string }
  setText(text: string): void
  /** Replaces the selection (inserts at the caret). */
  insert(text: string): void
  /** Frames a range of the text (a statement); null clears it. */
  mark(range: [number, number] | null): void
  focus(): void
  /** Words offered by the completion besides those of the text (tables, columns). */
  setWords(words: string[]): void
  onChange(f: (text: string) => void): void
  onSelection(f: (sel: { from: number; to: number }) => void): void
  /** A key of the manifest's editor.keys, by its name, pressed while the editor has the focus. */
  onKey(name: string, f: () => void): void
}

/** A yes or no asked by the core (`ide.confirm`). */
export type SandboxConfirm = { title: string; text: string; ok?: string; danger?: boolean }
/** A text asked by the core (`ide.prompt`), a password hidden. */
export type SandboxPrompt = { title: string; label?: string; value?: string; password?: boolean; placeholder?: string }
/** An item chosen in a list by the core (`ide.pick`): its index. */
export type SandboxPick = { title: string; items: { label: string; detail?: string }[]; initial?: number }
/** The size of a modal view: its width (480, 680, 920 px at most), its height up to 80% of the window. */
export type SandboxModalSize = 'small' | 'medium' | 'large'

/** An item of the status bar a tab view gives for its tab (#157), its menu's choices by id. */
export type SandboxStatusItem = {
  id: string
  text: string
  title?: string
  menu?: { id: string; label: string; checked?: boolean; disabled?: boolean; title?: string }[]
}

/**
 * An item a frame adds to the options menu (the ⋮) of its tool or of the tab of one of its views
 * (#175), after the core items. A choice the user makes comes back through `onToolMenu`.
 */
export type SandboxToolMenuItem = {
  id: string
  label: string
  hint?: string
  title?: string
  checked?: boolean
  disabled?: boolean
  /** A line between the items before and after it. */
  separator?: boolean
}

/** The global `ide` of a frame. */
export interface SandboxAPI {
  register(c: SandboxContributions): void
  /** The view this frame shows; its id is "" in the hidden frame of the commands. */
  readonly view: SandboxView | null
  readonly lang: string | null
  readonly theme: SandboxTheme | null
  /**
   * A method of its own (`<id>.*`, to its backend) or of the core with the grant `core:<method>`.
   * A coded error of the backend (a password to ask) rejects with an Error carrying `code` and `data`.
   */
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>
  /** An event of its own namespace (`<id>.*`), emitted by its backend. */
  on(event: string, f: (data: unknown) => void): void
  /** A path relative to the project, a line from 1. */
  openFile(path: string, line?: number): void
  /**
   * Opens a tab of one of its views. key tells its tabs apart: one with the same key is shown
   * again (a table), a new key opens another (a console); without one, the view has one tab.
   */
  openView(view: string, state?: unknown, title?: string, key?: string): void
  /** The state of this frame's tab, kept with it (a tab view only). */
  setViewState(state: unknown): void
  toast(text: string, kind?: ToastKind): void
  /** Shows a console of the core in the Console tool: one its backend feeds (terminal.open). */
  showConsole(id: string): void
  /** Copies a text to the clipboard (the frame has no access to it), with the IDE's clipboard history. */
  copyText(text: string): void
  /** A text of its catalog, `{name}` filled from `params`. */
  t(text: string, params?: Record<string, unknown>): string
  tn(n: number, one: string, other: string, params?: Record<string, unknown>): string
  onTheme(f: (theme: SandboxTheme) => void): void
  /** The editor of the tab (a tab view with an editor), else null. */
  readonly editor: SandboxEditor | null
  /** Its settings (contributes.settings), the defaults where the user set nothing. */
  readonly settings: Record<string, unknown>
  onSettings(f: (settings: Record<string, unknown>) => void): void
  /**
   * The dialogs of the core, centered in the window and titled with the plugin's name, while the
   * user is in the frame (a click, a key): refused otherwise.
   */
  confirm(o: SandboxConfirm): Promise<boolean>
  prompt(o: SandboxPrompt): Promise<string | null>
  pick(o: SandboxPick): Promise<number | null>
  /**
   * Opens one of its modal views (`contributes.modals`) in a modal of the core, while the user is
   * in the frame; one at a time. With `plugin`, a modal view of that plugin, which provides a
   * capability this one requires (#155). Resolves with what the view gives `closeModal`, null when the
   * user closes it.
   */
  openModal(view: string, state?: unknown, o?: { title?: string; size?: SandboxModalSize; plugin?: string }): Promise<unknown>
  /** In a modal view: closes it, its opener getting result. */
  closeModal(result?: unknown): void
  /** Whether this frame is a modal view. */
  readonly modal: boolean
  /** A capability the manifest requires, provided by another external plugin (#155). */
  use(capability: string): SandboxService
  /** A value of a capability it provides, kept by the page and pushed to its users. */
  publish(capability: string, key: string, value: unknown): void
  /** An event of a capability it provides, to its users. */
  emit(capability: string, event: string, data?: unknown): void
  /** The items of the status bar while its tab is in focus (a tab view, #157). */
  setStatus(items: SandboxStatusItem[]): void
  /** A choice of the menu of one of its status items. */
  onStatus(f: (e: { item: string; choice: string }) => void): void
  /**
   * The items this frame adds after the core items of the options menu (the ⋮) of its tool, or of
   * the tab it shows (#175). Pushed, like `setStatus`: push them again when they change.
   */
  setToolMenu(items: SandboxToolMenuItem[]): void
  /** The user chose one of the items of this frame's tool menu. */
  onToolMenu(f: (e: { item: string }) => void): void
  /** The HTML of a Markdown text, rendered and sanitized by the IDE as its own. */
  markdown(text: string): Promise<string>
  /** Opens an http(s) address in a new tab of the browser, while the user is in the frame. */
  openLink(url: string): void
  /** Opens a page of the IDE's documentation, by its help topic. */
  help(topic: string): void
  /** Shows in the window a worktree of its project (its id), or the project itself (#167). */
  showWorktree(project: string): void
}

/** What the frame asks the page; `rpc` waits for a `reply` with its `id`. */
export type FrameCall =
  | { call: 'rpc'; id: number; method: string; params?: unknown }
  | { call: 'on'; event: string }
  | { call: 'openFile'; path: string; line?: number }
  | { call: 'openView'; view: string; state?: unknown; title?: string; key?: string }
  | { call: 'setViewState'; state: unknown }
  | { call: 'toast'; text: string; kind?: ToastKind }
  | { call: 'copyText'; text: string }
  | { call: 'showConsole'; id: string }
  | { call: 'key'; key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  | { call: 'focus' }
  | { call: 'ready' }
  | { call: 'editorSet'; text: string }
  | { call: 'editorInsert'; text: string }
  | { call: 'editorMark'; range: [number, number] | null }
  | { call: 'editorFocus' }
  | { call: 'editorWords'; words: string[] }
  | { call: 'dialog'; id: number; confirm?: SandboxConfirm; prompt?: SandboxPrompt; pick?: SandboxPick }
  | { call: 'openModal'; id: number; view: string; state?: unknown; title?: string; size?: SandboxModalSize; plugin?: string }
  | { call: 'serviceCall'; id: number; capability: string; method: string; args?: unknown[] }
  | { call: 'serviceWatch'; capability: string }
  | { call: 'serviceReply'; id: number; result?: unknown; error?: string }
  | { call: 'publish'; capability: string; key: string; value?: unknown }
  | { call: 'serviceEmit'; capability: string; event: string; data?: unknown }
  | { call: 'setStatus'; items: SandboxStatusItem[] }
  | { call: 'setToolMenu'; items: SandboxToolMenuItem[] }
  | { call: 'markdown'; id: number; text: string }
  | { call: 'openLink'; url: string }
  | { call: 'help'; topic: string }
  | { call: 'showWorktree'; project: string }
  | { call: 'closeModal'; result?: unknown }

/** What the page sends the frame. */
export type PageMessage =
  | { init: { view: SandboxView; lang: string; catalog: Record<string, string>; theme: SandboxTheme; editor?: SandboxEditorState; settings?: Record<string, unknown>; modal?: boolean } }
  | { reply: number; result?: unknown; error?: string; code?: string; data?: Record<string, string> }
  | { theme: SandboxTheme }
  | { lang: string; catalog: Record<string, string> }
  | { event: string; data: unknown }
  | { command: string }
  | { editor: SandboxEditorState }
  | { editorKey: string }
  | { settings: Record<string, unknown> }
  | { serviceRequest: number; capability: string; method: string; args: unknown[] }
  | { serviceValues: { capability: string; values: Record<string, unknown> } }
  | { serviceValue: { capability: string; key: string; value: unknown } }
  | { serviceEvent: { capability: string; event: string; data: unknown } }
  | { status: { item: string; choice: string } }
  | { toolMenu: { item: string } }
