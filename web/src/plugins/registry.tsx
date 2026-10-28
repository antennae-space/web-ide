// Plugins of the window (docs/design/plugins.md): the states the pod sends (project.open,
// plugins.changed), the page modules of the built-in plugins, each a chunk loaded when the plugin
// is first enabled and activated once, and the contributions of the enabled ones (tools, tab
// views, commands). While a module loads, its tools and views show a placeholder.
import { createMemo, createRoot, createSignal, type JSX } from 'solid-js'
import { on, request } from '../pod/rpc'
import { setPluginActions } from '../keys/bindings'
import { API_VERSION, makeApi } from './api'
import { externalModule } from './external'
import type { ExplorerEntry, PluginContributions, PluginModule, PluginState, StatusItem } from './types'
import type { MenuItem } from '../ui/overlay'
import { setCapabilityGate } from './capabilities'
import { setPluginProviders } from '../popups/searchProviders'
import { setDiffSources } from '../ui/diffSources'
import { setPluginUiTools } from '../ui/uiCalls'
import { setAloneView } from '../state/tiles'
import { t } from '../i18n'
import { errorToast, toast } from '../ui/toast'
import { setPackGrammars, setPackLanguages } from '../editor/languages'
import { refreshPackGrammars } from '../editor/packGrammars'
import { placePluginTools, type TabState } from '../state/project'

// The page module of each built-in, a chunk of its own (vite.config.ts: plugin-<id>).
const builtins: Record<string, () => Promise<PluginModule>> = {
  ai: () => import('../../../plugins/ai/web').then((m) => m.ai),
  code: () => import('../../../plugins/code/web').then((m) => m.code),
  exec: () => import('../../../plugins/exec/web').then((m) => m.exec),
  files: () => import('../../../plugins/files/web').then((m) => m.files),
  git: () => import('../../../plugins/git/web').then((m) => m.git),
  hello: () => import('../../../plugins/hello/web').then((m) => m.hello),
  kanban: () => import('../../../plugins/kanban/web').then((m) => m.kanban),
  languages: () => import('../../../plugins/languages/web').then((m) => m.languages),
  previews: () => import('../../../plugins/previews/web').then((m) => m.previews),
  search: () => import('../../../plugins/search/web').then((m) => m.search),
  services: () => import('../../../plugins/services/web').then((m) => m.services),
}
/** The built-ins with a part of the home page (no project there: no states to wait for). */
const homeIds = ['previews', 'services']

const [states, setStates] = createSignal<PluginState[]>([])
export const pluginStates = states
const active: Record<string, PluginContributions> = {}
const modules: Record<string, PluginModule> = {}
// Bumped when a module arrives: what reads the active plugins follows.
const [version, setVersion] = createSignal(0)
const loading: Record<string, Promise<PluginModule | undefined>> = {}
// The version an external plugin's module was built from.
const builtVersion: Record<string, string> = {}

/** A plugin with a page module: a built-in, or an external one installed (external.tsx). */
const hasModule = (s: PluginState) => {
  if (builtins[s.manifest.id]) return true
  const c = s.manifest.contributes
  // A language pack may have no view: the language host is all it needs. One providing a
  // capability serves it from its background frame.
  return !!s.external?.installed && !!(c.tools?.length || c.tabViews?.length || c.commands?.length || s.manifest.provides?.length)
}

/** The page module of a plugin, loaded once (undefined when it cannot be). */
function load(id: string): Promise<PluginModule | undefined> {
  const external = states().find((s) => s.manifest.id === id && s.external?.installed)
  if (external) builtVersion[id] = external.external!.version
  const get = builtins[id] ?? (external ? () => externalModule(external, () => states().find((s) => s.manifest.id === id)) : () => Promise.reject(new Error('no page module')))
  return (loading[id] ??= get().then(
    (m) => (modules[id] = m),
    (e) => {
      console.warn('plugin', id, e)
      delete loading[id] // asked again at the next states
      return undefined
    },
  ))
}

// The plugins enabled in the window at the last states, and those to refresh (the project just
// opened) once their module is in.
let running = new Set<string>()
const toRefresh = new Set<string>()

/**
 * Takes the states of the plugins of the project: the enabled ones are loaded (the locked ones
 * first) and activated, and those just enabled (all of them when the project was just opened)
 * refresh.
 */
export function setPluginStates(list: PluginState[] | undefined, opened = false) {
  list ??= []
  if (list.some((s) => s.manifest.contributes.languages?.length)) refreshPackGrammars()
  else setPackGrammars([])
  setPackLanguages(list.filter((s) => s.enabled).flatMap((s) => s.manifest.contributes.languages ?? []))
  // An external plugin updated: its module is built again from its new manifest and bundle.
  for (const s of list) {
    const id = s.manifest.id
    if (!s.external || !(id in builtVersion) || builtVersion[id] === s.external.version) continue
    delete active[id]
    modules[id]?.dispose?.()
    delete modules[id]
    delete loading[id]
    delete builtVersion[id]
  }
  setStates(list)
  if (opened) for (const s of list) if (s.enabled) toRefresh.add(s.manifest.id)
  const wanted = list.filter((s) => s.enabled && hasModule(s) && !active[s.manifest.id] && s.manifest.apiVersion === API_VERSION)
  wanted.sort((a, b) => Number(!!b.manifest.required) - Number(!!a.manifest.required))
  for (const s of wanted)
    void load(s.manifest.id).then((m) => {
      if (!m || active[s.manifest.id]) return
      active[s.manifest.id] = m.activate(makeApi(s.manifest.id))
      setVersion((v) => v + 1)
      contribute()
    })
  contribute()
}

/** The contributions of the enabled plugins given to the core, and the refresh of those just running. */
function contribute() {
  setPluginActions(
    enabled().flatMap((s) => [
      ...(s.manifest.contributes.tools ?? []).map((x) => ({ id: `tool.${x.id}`, label: x.label, category: 'Tools', inTerminal: true })),
      ...(s.manifest.contributes.commands ?? []).map((c) => ({ id: c.id.includes('.') ? c.id : `${s.manifest.id}.${c.id}`, label: c.label, category: c.category ?? s.manifest.name, keys: c.keys, replaces: c.replaces, inTerminal: c.inTerminal, run: active[s.manifest.id]?.commands?.[c.id] })),
      // An action needing no argument is a command too (#151): the user runs it, no AI policy.
      ...(s.manifest.contributes.actions ?? [])
        .filter((a) => !a.required?.length)
        .map((a) => ({ id: `${s.manifest.id}.${a.id}`, label: a.label, category: s.manifest.name, run: () => void runAction(s.manifest.name, `${s.manifest.id}.${a.id}`, a.label) })),
    ]),
  )
  setPluginProviders(enabled().flatMap((s) => active[s.manifest.id].searchProviders ?? []))
  setDiffSources(enabled().flatMap((s) => active[s.manifest.id].diffSources ?? []))
  setPluginUiTools(Object.assign({}, ...enabled().map((s) => active[s.manifest.id].uiTools ?? {})))
  const now = new Set(enabled().map((s) => s.manifest.id))
  for (const id of now) {
    if (toRefresh.has(id) || !running.has(id)) active[id].opened?.()
    toRefresh.delete(id)
  }
  running = now
}

/** Runs an action of a plugin from the palette, its outcome in a toast. */
async function runAction(plugin: string, method: string, label: string) {
  try {
    await request(method, {})
    toast(t('{plugin}: {action} done', { plugin, action: label }), 'ok')
  } catch (e) {
    errorToast(e)
  }
}

on('plugins.changed', (e: { plugins: PluginState[] }) => {
  placePluginTools(e?.plugins ?? [])
  setPluginStates(e?.plugins)
})
/** The window opened a project (project.open gave the states): each enabled plugin refreshes. */
export const pluginsOpened = (list: PluginState[] | undefined) => setPluginStates(list, true)

/** After a reconnection, once the project is open again. */
export async function refreshPlugins() {
  try {
    pluginsOpened((await request<{ plugins: PluginState[] }>('plugins.list')).plugins)
  } catch {
    /* no project */
  }
}

const enabled = () => (version(), states().filter((s) => s.enabled && active[s.manifest.id]))

/** An enabled plugin whose module is still loading. */
const pending = (id: string) => (version(), states().some((s) => s.manifest.id === id && s.enabled && hasModule(s) && !active[id]))

/** What a tool or a view of a plugin shows while its module loads. */
function Loading(): JSX.Element {
  return (
    <div class="panel plugin-loading" data-testid="plugin-loading">
      <div class="muted pad">
        <span class="spinner" /> {t('Loading…')}
      </div>
    </div>
  )
}

export const pluginEnabled = (id: string) => states().some((s) => s.manifest.id === id && s.enabled)
setCapabilityGate(pluginEnabled)

/** The tools of the enabled plugins: their component, or the placeholder while the module loads. */
export const pluginTools = createRoot(() =>
  createMemo(() =>
    states().flatMap((s) => {
      if (!s.enabled || !hasModule(s)) return []
      if (pending(s.manifest.id)) return (s.manifest.contributes.tools ?? []).map((x) => ({ ...x, component: Loading, badge: undefined }))
      if (!active[s.manifest.id]) return []
      return (s.manifest.contributes.tools ?? []).flatMap((x) => {
        const c = active[s.manifest.id].tools?.[x.id]
        return c ? [{ ...x, component: c.component, badge: c.badge }] : []
      })
    }),
  ),
)

const [homeList, setHomeList] = createSignal<(() => JSX.Element)[]>([])
let homeAsked = false
/** The parts of the home page the built-ins give (no project: whether it is enabled is moot), loaded the first time. */
export function homeParts() {
  if (!homeAsked) {
    homeAsked = true
    void Promise.all(homeIds.map((id) => load(id).then((m) => (m?.home ? [m.home(makeApi(id))] : [])))).then((l) => setHomeList(l.flat()))
  }
  return homeList()
}

/** The items of the Explorer menu of an entry, given by the enabled plugins. */
export const explorerItems = (entry: ExplorerEntry) => enabled().flatMap((s) => active[s.manifest.id].explorerItems?.(entry) ?? [])

/** The decorations of the Explorer of the enabled plugins. */
export const fileDecorations = () => enabled().flatMap((s) => (active[s.manifest.id].fileDecorations ? [active[s.manifest.id].fileDecorations!] : []))

/** The hosts of the enabled plugins (modals), mounted by the project window. */
export const pluginHosts = createRoot(() => createMemo(() => enabled().flatMap((s) => active[s.manifest.id].hosts ?? [])))

/** The tab view of a kind plugin:<plugin>/<view>, when its plugin is enabled. */
export function pluginView(kind: string) {
  const m = /^plugin:([^/]+)\/(.+)$/.exec(kind)
  if (!m || !pluginEnabled(m[1])) return undefined
  if (pending(m[1])) return Loading
  return active[m[1]]?.views?.[m[2]]
}

/** The options of the enabled plugins for a conversation of the assistant, by plugin id. */
export function pluginAssistantOptions(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of enabled()) {
    const f = active[s.manifest.id].assistantOptions
    if (f) out[s.manifest.id] = f()
  }
  return out
}

/** The view of the file tabs, given by an enabled plugin (Code). */
export function pluginFileView() {
  for (const s of enabled()) {
    const v = active[s.manifest.id].fileView
    if (v) return v
  }
  // Code (locked) is loading: the file tabs wait for it.
  return states().some((s) => s.manifest.required && pending(s.manifest.id)) ? Loading : undefined
}

/** The title of a tab of a plugin view: the plugin's viewTitle, then the tab's own title. */
export function pluginViewTitle(tab: TabState) {
  const m = /^plugin:([^/]+)\//.exec(tab.kind)
  return m && pluginEnabled(m[1]) ? active[m[1]]?.viewTitle?.(tab) : undefined
}

setAloneView((kind) => {
  const m = /^plugin:([^/]+)\/(.+)$/.exec(kind)
  return !!m && pluginEnabled(m[1]) && !!active[m[1]]?.aloneViews?.includes(m[2])
})

/**
 * The items of the status bar for a tab (a file: the plugin giving fileView; a plugin view: its
 * plugin) or for a tool, given by the enabled plugins.
 */
export function pluginStatus(target: { tab: TabState } | { tool: string }): StatusItem[] {
  if ('tool' in target) {
    for (const s of enabled()) {
      const f = active[s.manifest.id].toolStatus?.[target.tool]
      if (f) return f()
    }
    return []
  }
  const tab = target.tab
  if (tab.kind === 'file') {
    for (const s of enabled()) if (active[s.manifest.id].fileView) return active[s.manifest.id].fileStatus?.(tab) ?? []
    return []
  }
  if (tab.kind === 'tool' && tab.tool) return pluginStatus({ tool: tab.tool })
  const m = /^plugin:([^/]+)\//.exec(tab.kind)
  return m && pluginEnabled(m[1]) ? (active[m[1]]?.viewStatus?.(tab) ?? []) : []
}

/**
 * The items a plugin adds after the core items of the options menu (the ⋮) of one of its tools, or
 * of a tab of one of its views. The same resolution as `pluginStatus`: the enabled plugin owning
 * the tool, or the one of `plugin:<id>/<view>`; nothing for a tool with no contribution.
 */
export function toolMenuFor(target: { tool: string } | { tab: TabState }): MenuItem[] {
  if ('tool' in target) {
    for (const s of enabled()) {
      const f = active[s.manifest.id].toolMenu?.[target.tool]
      if (f) return f()
    }
    return []
  }
  const tab = target.tab
  if (tab.kind === 'tool' && tab.tool) return toolMenuFor({ tool: tab.tool })
  const m = /^plugin:([^/]+)\/(.+)$/.exec(tab.kind)
  return m && pluginEnabled(m[1]) ? (active[m[1]]?.toolMenu?.[m[2]]?.(tab) ?? []) : []
}

/**
 * The buttons a tool gives to the corner of the zone or of the tile showing it (before the ⋮),
 * or to the tab bar of a tabbed tile. The same resolution as `toolMenuFor`.
 */
export function toolCornerFor(target: { tool: string } | { tab: TabState }): JSX.Element[] {
  if ('tool' in target) {
    for (const s of enabled()) {
      const f = active[s.manifest.id].toolCorner?.[target.tool]
      if (f) return f()
    }
    return []
  }
  const tab = target.tab
  if (tab.kind === 'tool' && tab.tool) return toolCornerFor({ tool: tab.tool })
  const m = /^plugin:([^/]+)\/(.+)$/.exec(tab.kind)
  return m && pluginEnabled(m[1]) ? (active[m[1]]?.toolCorner?.[m[2]]?.() ?? []) : []
}

/** The label of a tab view, as its manifest declares it. */
export function pluginViewLabel(kind: string) {
  const m = /^plugin:([^/]+)\/(.+)$/.exec(kind)
  return m ? states().find((s) => s.manifest.id === m[1])?.manifest.contributes.tabViews?.find((v) => v.id === m[2])?.label : undefined
}

export const setPluginEnabled = (id: string, enabled: boolean) =>
  request<{ plugins: PluginState[] }>('plugins.set', { id, enabled }).then((r) => {
    placePluginTools(r.plugins)
    setPluginStates(r.plugins)
  })
