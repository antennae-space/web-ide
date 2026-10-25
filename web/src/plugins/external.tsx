// The page module of an external plugin, built by the core from its bundle (plugins.bundle):
// each tool and tab view a sandboxed frame running the plugin's module, its commands run in a
// hidden frame of their own. The registry loads it as it loads a built-in.
import { createEffect, createSignal, on as onSignal, onCleanup, onMount, untrack } from 'solid-js'
import { render } from 'solid-js/web'
import { request } from '../pod/rpc'
import { lang, t } from '../i18n'
import { Modal } from '../ui/overlay'
import { mutate, setActivePane, type TabState } from '../state/project'
import { Doc } from '../editor/doc'
import type { EditorView } from '../editor/view'
import { comboFromEvent } from '../keys/bindings'
import { useEditorView } from '../ui/EditorArea'
import { useCompletion } from '../ui/Completion'
import { frameDoc, projectInfo, serveFrame, type FrameEditor } from './sandbox'
import { pluginSettingValues } from './settings'
import type { PageMessage, SandboxModalSize, SandboxStatusItem, SandboxToolMenuItem } from './sandbox-api'
import { serve, setModalOpener } from './services'
import './adapters'
import type { PluginContributions, PluginManifest, PluginModule, PluginState, StatusItem } from './types'
import type { MenuItem } from '../ui/overlay'

type Bundle = { version: string; js: string; catalogs: Record<string, Record<string, string>> }

type Served = ReturnType<typeof serveFrame>

/** The status items a tab frame gave for its tab (setStatus), and how to answer its choices. */
const [tabStatus, setTabStatus] = createSignal<Record<string, { items: SandboxStatusItem[]; send: (m: PageMessage) => void }>>({})

/** The items a frame gave for the ⋮ menu of its tool (setToolMenu), by tool id, and of a tab, by tab id. */
const [frameToolMenu, setFrameToolMenu] = createSignal<Record<string, { items: SandboxToolMenuItem[]; send: (m: PageMessage) => void }>>({})
const [frameTabMenu, setFrameTabMenu] = createSignal<Record<string, { items: SandboxToolMenuItem[]; send: (m: PageMessage) => void }>>({})

/** The items of a frame as the core's menu items: a choice goes back to the frame as a message. */
const frameMenuItems = (st: { items: SandboxToolMenuItem[]; send: (m: PageMessage) => void }): MenuItem[] =>
  st.items.map((it) => ({ label: it.label, hint: it.hint, title: it.title, checked: !!it.checked, disabled: !!it.disabled, separator: !!it.separator, action: () => st.send({ toolMenu: { item: it.id } }) }))

/** The items of the status bar of a tab of an external plugin's view. */
function viewStatus(tab: TabState): StatusItem[] {
  const st = tabStatus()[tab.id]
  if (!st) return []
  return st.items.map((it) => ({
    id: it.id,
    text: it.text,
    title: it.title,
    testid: `status-${it.id}`,
    menu: it.menu ? () => it.menu!.map((c) => ({ label: c.label, checked: c.checked, disabled: c.disabled, title: c.title, action: () => st.send({ status: { item: it.id, choice: c.id } }) })) : undefined,
  }))
}

/** Whether a modal of a plugin is open: one at a time. */
let modalOpen = false

/**
 * Opens a modal view of a plugin (contributes.modals) in a modal of the core, titled with the
 * plugin's name: its frame closes it with a result (ide.closeModal); Escape, ✕ or the backdrop
 * with null.
 */
function modalOpener(state: PluginState, grants: () => string[], bundle: Bundle) {
  return (view: string, viewState: unknown, title: string, size: SandboxModalSize) =>
    new Promise<unknown>((resolve, reject) => {
      const def = state.manifest.contributes.modals?.find((v) => v.id === view)
      if (!def) return reject(new Error(t('{name} has no such modal view', { name: state.manifest.name })))
      if (modalOpen) return reject(new Error(t('A modal of a plugin is already open')))
      modalOpen = true
      const host = document.createElement('div')
      document.body.append(host)
      let closed = false
      const close = (result: unknown) => {
        if (closed) return
        closed = true
        modalOpen = false
        dispose()
        host.remove()
        resolve(result ?? null)
      }
      const label = title || (bundle.catalogs[lang()]?.[def.label] ?? def.label)
      const dispose = render(
        () => (
          <Modal title={`${state.manifest.name} · ${label}`} class={`modal-plugin modal-plugin-${size}`} onClose={() => close(null)}>
            <SandboxFrame state={state} grants={grants} bundle={bundle} view={view} modal={{ state: viewState, close }} />
          </Modal>
        ),
        host,
      )
    })
}

/** A frame of the plugin showing one of its views (a tool, a tab view, a modal view). */
function SandboxFrame(props: {
  state: PluginState
  grants: () => string[]
  bundle: Bundle
  view: string
  tab?: TabState
  editor?: FrameEditor
  served?: (s: Served) => void
  modal?: { state: unknown; close: (result: unknown) => void }
}) {
  let frame!: HTMLIFrameElement
  let served: Served | undefined
  // Served once: the frame keeps its port for its life (a new state is its own business).
  onMount(() => {
    served = serveFrame(frame, {
      plugin: props.state.manifest.id,
      name: props.state.manifest.name,
      requires: [...(props.state.manifest.requires ?? []), ...(props.state.manifest.uses ?? [])],
      provides: props.state.manifest.provides,
      tools: props.state.manifest.contributes.tools?.map((x) => x.id),
      grants: props.grants,
      catalogs: props.bundle.catalogs,
      view: props.view,
      tab: props.tab,
      editor: props.editor,
      settings: () => pluginSettingValues(props.state.manifest),
      openModal: modalOpener(props.state, props.grants, props.bundle),
      state: props.modal?.state,
      closeModal: props.modal?.close,
      // A modal view gets the focus: its fields, its dialogs.
      onReady: props.modal ? () => frame.focus() : undefined,
      setStatus: props.tab ? (items) => setTabStatus((all) => ({ ...all, [props.tab!.id]: { items, send: served!.send } })) : undefined,
      // A tool frame keys its items by tool id, a frame of a tab view by tab id (they follow the tab).
      setToolMenu: (items) =>
        props.tab
          ? setFrameTabMenu((all) => ({ ...all, [props.tab!.id]: { items, send: served!.send } }))
          : setFrameToolMenu((all) => ({ ...all, [props.view]: { items, send: served!.send } })),
    })
    props.served?.(served)
  })
  createEffect(onSignal(lang, () => served?.lang(), { defer: true }))
  // The window shows another worktree: the frame's project follows.
  createEffect(
    onSignal(
      () => projectInfo()?.id,
      () => {
        const p = projectInfo()
        if (p) served?.send({ project: p })
      },
      { defer: true },
    ),
  )
  createEffect(onSignal(() => JSON.stringify(pluginSettingValues(props.state.manifest)), () => served?.settings(), { defer: true }))
  onCleanup(() => {
    served?.stop()
    const id = props.tab?.id
    if (id) setTabStatus(({ [id]: _, ...rest }) => rest)
    else setFrameToolMenu(({ [props.view]: _, ...rest }) => rest)
  })
  return (
    <div class="panel plugin-external-view">
      <iframe
        ref={frame}
        class="plugin-frame"
      data-plugin={props.state.manifest.id}
      data-view={props.view}
      title={props.state.manifest.name}
      sandbox="allow-scripts"
        srcdoc={frameDoc(props.bundle.js)}
      />
    </div>
  )
}

type TabEditorDef = NonNullable<NonNullable<PluginManifest['contributes']['tabViews']>[number]['editor']>

/**
 * A tab view whose manifest asks the core's editor: the editor above (its text kept in the
 * tab's state as $text), the plugin's frame below, driving it through ide.editor.
 */
function EditorTab(props: { state: PluginState; grants: () => string[]; bundle: Bundle; view: string; tab: TabState; paneId: string; def: TabEditorDef }) {
  const tab = props.tab
  const doc = new Doc(`plugin:${props.state.manifest.id}:${tab.id}`, untrack(() => (tab.state as { $text?: string } | undefined)?.$text) ?? '', { lang: props.def.lang })
  const [host, setHost] = createSignal<HTMLElement>()
  let served: Served | undefined
  let view: () => EditorView | null = () => null
  const state = () => {
    const sel = view()?.getSelection()
    return { text: doc.text, from: sel?.anchor ?? 0, to: sel?.head ?? 0 }
  }
  // The text is kept with the tab (reloads, other windows), a moment after the typing stops.
  let timer: number | undefined
  const offChange = doc.onChange(() => {
    served?.editorChanged()
    clearTimeout(timer)
    timer = window.setTimeout(
      () =>
        mutate((s) => {
          const cur = s.tabs[tab.id]
          if (!cur) return
          const st = cur.state && typeof cur.state === 'object' && !Array.isArray(cur.state) ? (cur.state as Record<string, unknown>) : {}
          cur.state = { ...st, $text: doc.text }
        }),
      400,
    )
  })
  onCleanup(() => {
    offChange()
    clearTimeout(timer)
  })
  const keys = props.def.keys ?? {}
  let comp: ReturnType<typeof useCompletion> | undefined
  view = useEditorView(() => doc, host, {
    onSelection: () => {
      comp?.onSelection()
      served?.editorChanged()
    },
    onFocus: () => setActivePane(props.paneId),
    onKey: (e) => {
      if (comp?.onKey(e)) return true
      const name = keys[comboFromEvent(e) ?? '']
      if (!name) return false
      served?.editorKey(name)
      return true
    },
    onType: (t) => comp?.onType(t),
  })
  comp = useCompletion(view, () => doc)
  const Popup = comp.Popup
  const editor: FrameEditor = {
    state,
    setText: (text) => view()?.edit(0, doc.text.length, text),
    insert: (text) => {
      const v = view()
      if (!v) return
      const sel = v.getSelection()
      v.edit(Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head), text)
    },
    mark: (range) => view()?.setStatement(range),
    focus: () => view()?.focus(),
    setWords: (words) => (doc.words = words),
  }
  const size = props.def.size || 40
  return (
    <div class="plugin-editor-tab">
      <div class="plugin-editor-host" style={{ height: `${size}%` }} ref={setHost} data-testid="plugin-editor" />
      <Popup />
      <SandboxFrame state={props.state} grants={props.grants} bundle={props.bundle} view={props.view} tab={tab} editor={editor} served={(s) => (served = s)} />
    </div>
  )
}

/**
 * The background frame of a plugin, hidden: it runs its commands, made on the first one, and
 * serves the capabilities it provides (#155), made when it is activated.
 */
function backgroundFrame(state: PluginState, grants: () => string[], bundle: Bundle) {
  let ready: Promise<Served> | undefined
  let frame: HTMLIFrameElement | undefined
  let served: Served | undefined
  const start = () =>
    (ready ??= new Promise((resolve) => {
      frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.className = 'plugin-frame-hidden'
      frame.dataset.plugin = state.manifest.id
      frame.srcdoc = frameDoc(bundle.js)
      served = serveFrame(frame, {
        plugin: state.manifest.id,
        name: state.manifest.name,
        requires: [...(state.manifest.requires ?? []), ...(state.manifest.uses ?? [])],
        provides: state.manifest.provides,
        grants,
        catalogs: bundle.catalogs,
        view: '',
        settings: () => pluginSettingValues(state.manifest),
        onReady: () => resolve(served!),
      })
      document.body.append(frame)
    }))
  return {
    start,
    command: (command: string) => void start().then((s) => s.send({ command })),
    stop: () => {
      served?.stop()
      frame?.remove()
    },
  }
}

/** Loads the bundle of an external plugin and builds its module; current is its state now. */
export async function externalModule(state: PluginState, current: () => PluginState | undefined): Promise<PluginModule> {
  const bundle = await request<Bundle>('plugins.bundle', { id: state.manifest.id })
  const c = state.manifest.contributes
  const grants = () => current()?.external?.grants ?? []
  const bg = backgroundFrame(state, grants, bundle)
  const id = state.manifest.id
  setModalOpener(id, modalOpener(state, grants, bundle))
  return {
    dispose: bg.stop,
    activate: (): PluginContributions => {
      // Its capabilities, served by its background frame to the other external plugins.
      const provides = state.manifest.provides ?? []
      if (provides.length)
        void bg.start().then((s) => provides.forEach((cap) => serve(cap, id, (method, args) => s.request(cap, method, args))))
      return {
      tools: Object.fromEntries((c.tools ?? []).map((x) => [x.id, { component: () => <SandboxFrame state={state} grants={grants} bundle={bundle} view={x.id} /> }])),
      views: Object.fromEntries(
        (c.tabViews ?? []).map((v) => [
          v.id,
          (props: { tab: TabState; paneId: string }) =>
            v.editor ? (
              <EditorTab state={state} grants={grants} bundle={bundle} view={v.id} tab={props.tab} paneId={props.paneId} def={v.editor} />
            ) : (
              <SandboxFrame state={state} grants={grants} bundle={bundle} view={v.id} tab={props.tab} />
            ),
        ]),
      ),
      commands: Object.fromEntries((c.commands ?? []).map((x) => [x.id, () => bg.command(x.id)])),
      viewStatus,
      toolMenu: {
        ...Object.fromEntries((c.tools ?? []).map((x) => [x.id, () => (frameToolMenu()[x.id] ? frameMenuItems(frameToolMenu()[x.id]!) : [])])),
        ...Object.fromEntries((c.tabViews ?? []).map((v) => [v.id, (tab?: TabState) => (tab && frameTabMenu()[tab.id] ? frameMenuItems(frameTabMenu()[tab.id]!) : [])])),
      },
      aloneViews: (c.tabViews ?? []).filter((v) => v.alone).map((v) => v.id),
      }
    },
  }
}
