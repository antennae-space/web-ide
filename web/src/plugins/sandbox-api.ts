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

/** What a plugin's module registers: its views by id, its commands by id. */
export type SandboxContributions = {
  views?: Record<string, (el: HTMLElement, ide: SandboxAPI) => void>
  commands?: Record<string, (ide: SandboxAPI) => void>
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

/** The global `ide` of a frame. */
export interface SandboxAPI {
  register(c: SandboxContributions): void
  /** The view this frame shows; its id is "" in the hidden frame of the commands. */
  readonly view: SandboxView | null
  readonly lang: string | null
  readonly theme: SandboxTheme | null
  /** A method of its own (`<id>.*`, to its backend) or of the core with the grant `core:<method>`. */
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>
  /** An event of its own namespace (`<id>.*`), emitted by its backend. */
  on(event: string, f: (data: unknown) => void): void
  /** A path relative to the project, a line from 1. */
  openFile(path: string, line?: number): void
  openView(view: string, state?: unknown, title?: string): void
  /** The state of this frame's tab, kept with it (a tab view only). */
  setViewState(state: unknown): void
  toast(text: string, kind?: ToastKind): void
  /** A text of its catalog, `{name}` filled from `params`. */
  t(text: string, params?: Record<string, unknown>): string
  tn(n: number, one: string, other: string, params?: Record<string, unknown>): string
  onTheme(f: (theme: SandboxTheme) => void): void
  /** The editor of the tab (a tab view with an editor), else null. */
  readonly editor: SandboxEditor | null
  /** Its settings (contributes.settings), the defaults where the user set nothing. */
  readonly settings: Record<string, unknown>
  onSettings(f: (settings: Record<string, unknown>) => void): void
}

/** What the frame asks the page; `rpc` waits for a `reply` with its `id`. */
export type FrameCall =
  | { call: 'rpc'; id: number; method: string; params?: unknown }
  | { call: 'on'; event: string }
  | { call: 'openFile'; path: string; line?: number }
  | { call: 'openView'; view: string; state?: unknown; title?: string }
  | { call: 'setViewState'; state: unknown }
  | { call: 'toast'; text: string; kind?: ToastKind }
  | { call: 'key'; key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  | { call: 'focus' }
  | { call: 'ready' }
  | { call: 'editorSet'; text: string }
  | { call: 'editorInsert'; text: string }
  | { call: 'editorMark'; range: [number, number] | null }
  | { call: 'editorFocus' }
  | { call: 'editorWords'; words: string[] }

/** What the page sends the frame. */
export type PageMessage =
  | { init: { view: SandboxView; lang: string; catalog: Record<string, string>; theme: SandboxTheme; editor?: SandboxEditorState; settings?: Record<string, unknown> } }
  | { reply: number; result?: unknown; error?: string }
  | { theme: SandboxTheme }
  | { lang: string; catalog: Record<string, string> }
  | { event: string; data: unknown }
  | { command: string }
  | { editor: SandboxEditorState }
  | { editorKey: string }
  | { settings: Record<string, unknown> }
