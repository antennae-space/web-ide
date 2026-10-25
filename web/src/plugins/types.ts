// Types of the plugin system (docs/design/plugins.md): the manifest sent by the pod, the state
// of a plugin on the project, and what a plugin's module gives the page.
import type { JSX } from 'solid-js'
import type { TabState } from '../state/project'
import type { Zone } from '../state/zones'
import type { MenuItem, PluginApi } from './api'
import type { UiTool } from '../ui/uiCalls'
import type { SearchProvider } from '../popups/searchProviders'
import type { DiffSource } from '../ui/diffSources'

export interface PluginTool {
  id: string
  label: string
  icon: string
  zone: Zone
  /** The tool it comes before in its zone by default. */
  before?: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: number
  /** Locked: always enabled, the IDE does not run without it (Files, Code). */
  required?: boolean
  permissions?: string[]
  /** The executable of the confined backend of an external plugin (bin/<name>). */
  backend?: string
  provides?: string[]
  requires?: string[]
  /** Capabilities it uses when they are there (not needed to be on, #158). */
  uses?: string[]
  namespaces?: string[]
  contributes: {
    tools?: PluginTool[]
    /** editor: the tab holds the core's editor above the view (#151). */
    /** A language pack's languages (#145): the language host runs their servers. */
    languages?: { id: string; name: string; extensions: string[]; grammar?: string; languageIds?: Record<string, string> }[]
    /** Its settings (#151), rendered in Settings > Plugins. */
    settings?: { properties: Record<string, PluginSetting> }
    /** Its actions (#151): a method of its backend and an assistant tool each. */
    actions?: { id: string; label: string; description: string; properties?: Record<string, unknown>; required?: string[]; access: 'read' | 'write'; target?: string }[]
    tabViews?: { id: string; label: string; alone?: boolean; editor?: { lang: string; size?: number; keys?: Record<string, string> } }[]
    /** The views an external plugin opens in a modal of the core (#154). */
    modals?: { id: string; label: string }[]
    /** Parameters of a project's address opening a tab view (#155): ?ticket=12. */
    links?: { param: string; view: string; type?: 'number' | 'string' }[]
    assistantTools?: string[]
    mcpTools?: string[]
    /** Actions <plugin>.<id> (or the id as written when it has a prefix of the plugin's namespaces); keys: default shortcuts; replaces: the id of the action before it moved to a plugin. */
    commands?: { id: string; label: string; category?: string; keys?: string[]; replaces?: string; inTerminal?: boolean }[]
  }
}

/** A plugin as the project sees it (plugins.list): enabled, disabled by the user, or missing a capability. */
export interface PluginState {
  manifest: PluginManifest
  enabled: boolean
  disabled: boolean
  missing?: string[]
  /** An external plugin (not runnable yet): disabled is false when the project uses it. */
  /** official: installed by the pod for every project, on unless disabled on it. */
  external?: { url: string; version: string; grants: string[]; installed: boolean; official?: boolean; destinations?: string[] }
}

/** What the module of a plugin gives for the contributions of its manifest, by id. */
export interface PluginContributions {
  tools?: Record<string, { component: () => JSX.Element; badge?: () => number }>
  /** The view of the file tabs (one plugin gives it: Code). */
  fileView?: (props: { tab: TabState; paneId: string }) => JSX.Element
  /** Tab views, opened as tabs of kind plugin:<plugin>/<view>. */
  views?: Record<string, (props: { tab: TabState; paneId: string }) => JSX.Element>
  /** The title of a tab of one of these views, from its state (the label of the manifest otherwise). */
  viewTitle?: (tab: TabState) => string | undefined
  /** Views alone in their tile on a desk of tiles, like a tool (the Kanban board). */
  aloneViews?: string[]
  /** Items of the status bar while a file tab has the focus (the plugin giving fileView: Code). */
  fileStatus?: (tab: TabState) => StatusItem[]
  /** Items of the status bar while a tab of one of the plugin's views has the focus. */
  viewStatus?: (tab: TabState) => StatusItem[]
  /** Items of the status bar while a tool of the plugin has the focus, by tool id. */
  toolStatus?: Record<string, () => StatusItem[]>
  /**
   * Items added after the core items of the options menu (the ⋮) of a tool of the plugin, or of a
   * tab of one of its views, by tool or view id. Read when the menu opens: a function of the
   * current state, given the tab when there is one (a tool in a zone has none).
   */
  toolMenu?: Record<string, (tab?: TabState) => MenuItem[]>
  /**
   * The buttons the tool puts in the corner of the zone or of the tile that shows it, before the ⋮,
   * by tool or view id (#176). A tool has no button of its own in its head: the core renders these,
   * in a zone, in a bare tile, or at the right of the tab bar of a tabbed tile.
   */
  toolCorner?: Record<string, () => JSX.Element[]>
  /** Tools of the interface the pod asks the window to run (ui.call), by name: the AI draws a page of its board. */
  uiTools?: Record<string, UiTool>
  commands?: Record<string, () => void>
  /** Items of the context menu of an entry of the Explorer (Exec: a terminal here). */
  explorerItems?: (entry: ExplorerEntry) => MenuItem[]
  /** Decorations of the Explorer: the files left out, the state of a file (Git: modified…). */
  fileDecorations?: FileDecorations
  /** Sources of the diff view (the sides of a diff tab whose source is its id). */
  diffSources?: DiffSource[]
  /** Kinds of results of Search Everywhere, each with its tab. */
  searchProviders?: SearchProvider[]
  /** Components mounted once in the project window (a modal the plugin opens). */
  hosts?: (() => JSX.Element)[]
  /** Called when the window opens a project, and again after a reconnection (lists to fetch again). */
  opened?: () => void
  /** The plugin's options of a conversation of the assistant, given to its assistant tools. */
  assistantOptions?: () => unknown
}

/**
 * An item of the status bar, on its right. Read in a memo: its fields may change with what it
 * shows. A click runs its action, or opens its menu (its options) above it.
 */
export interface StatusItem {
  id: string
  text: string
  icon?: string
  title?: string
  testid?: string
  action?: () => void
  menu?: () => MenuItem[]
}

/** The page module of a plugin: activated once, when the plugin is first enabled in the window. */
export interface PluginModule {
  activate(api: PluginApi): PluginContributions
  /** What it shows on the home page (no project open): the api offers its global methods there. */
  home?(api: PluginApi): () => JSX.Element
  /** Its module is built again (an external plugin updated): what it made goes (its frames). */
  dispose?(): void
}

/** An entry of the Explorer, and the folder it is or is in. */
export interface ExplorerEntry {
  path: string
  dir: boolean
  folder: string
}

/** Category of a path, shown as the tint of its row (docs/design/plugins.md, Explorer decorations). */
export type FileKind = 'test' | 'library' | 'manifest' | 'ignored' | 'marked'

/** Family of the background of a row: one tint variable of `styles.css` each (#179). */
export type FileTint = FileKind

/**
 * What a plugin knows of a path, channel by channel: each one shows in its own place of the row,
 * a channel the plugin does not fill stays undefined and the core takes the one of the folder.
 */
export interface FileDecoration {
  /** Color of the name (`git-modified`…). */
  state?: string
  /** Letter at the end of the row (a status letter: `M`, `A`…). */
  badge?: string
  /** Category of the path. */
  kind?: FileKind
  /** Family of the background of the row. */
  tint?: FileTint
  /** Text shown after the name (“library root”). */
  label?: string
}

export interface FileDecorations {
  /** The paths among these that are left out (dimmed, as their content). */
  ignored?(paths: string[]): Promise<string[]>
  /** The channels this plugin knows for this path, null when it knows none. */
  decorate?(path: string, dir: boolean): FileDecoration | null
  /** @deprecated v1 alias of the `state` channel, folded into it by the core; kept for the plugins built before #179. */
  state?(path: string, dir: boolean): string | null
}

/** A setting of a plugin. */
export type PluginSetting = { type: 'string' | 'number' | 'boolean'; enum?: string[]; title: string; description?: string; default?: unknown }
