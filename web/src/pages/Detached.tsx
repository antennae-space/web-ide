// Detached windows: one panel alone, without the rest of the chrome. Each window is one more
// WebSocket client of the same pod session; the shared buffers keep them in sync.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { project, closeProject, reopenProject, panelAliases } from '../state/project'
import { EditorArea } from '../ui/EditorArea'
import { StatusBar } from '../ui/StatusBar'
import { capability } from '../plugins/capabilities'
import { pluginHosts, refreshPlugins } from '../plugins/registry'
import '../ui/uiCalls'
import { DiagramViewer } from '../ui/DiagramViewer'
import { openWithAuth, toolPanels, useProjectActions } from './ProjectPage'
import { on as onPod } from '../pod/rpc'
import { t } from '../i18n'
import { useProjectIcon } from '../ui/projectIcon'

function useProject(id: string, title: (name: string) => string) {
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal('')
  onMount(async () => {
    try {
      await openWithAuth(id)
      setReady(true)
      document.title = title(project()?.name ?? '')
    } catch (e) {
      setError((e as Error).message)
    }
  })
  const off = onPod('pod.reconnected', async () => {
    await reopenProject()
    void refreshPlugins()
  })
  onCleanup(() => {
    off()
    closeProject()
  })
  useProjectIcon(project)
  return { ready, error }
}

/** The frame of a detached window: the panel alone, its name carried by the title of the window. */
function Frame(props: { ready: boolean; error: string; statusBar?: boolean; children: any }) {
  return (
    <div class="detached">
      <div class="detached-body">
        <Show when={props.ready} fallback={<div class="center-msg">{props.error ? <p class="danger">{props.error}</p> : <p class="muted">{t('Connecting…')}</p>}</div>}>
          {props.children}
        </Show>
      </div>
      {/* Same window-level bar as the project window, at the bottom of the frame. */}
      <Show when={props.statusBar}>
        <StatusBar />
      </Show>
      {/* A diagram of rendered Markdown opened in full screen. */}
      <DiagramViewer />
    </div>
  )
}

export function DetachedEditor(props: { id: string }) {
  const s = useProject(props.id, (n) => t('{name} · editor', { name: n }))
  useProjectActions()
  return (
    <Frame ready={s.ready()} error={s.error()} statusBar>
      <EditorArea detached />
    </Frame>
  )
}

export function DetachedTool(props: { id: string; toolId: string }) {
  const id = panelAliases[props.toolId] ?? props.toolId
  const tool = () => toolPanels[id]
  const s = useProject(props.id, () => (tool() ? t(tool()!.label) : props.toolId))
  useProjectActions()
  // The tool may come after the project opens (its plugin loads): the title follows it.
  createEffect(() => {
    if (tool()) document.title = `${t(tool()!.label)} · ${project()?.name ?? ''}`
  })
  return (
    <Frame ready={s.ready()} error={s.error()}>
      <Show when={tool()} fallback={<p class="muted pad">{t('Unknown tool.')}</p>}>
        <div class="tool-full">
          <Dynamic component={tool()!.component} />
        </div>
        <For each={pluginHosts()}>{(Host) => <Host />}</For>
      </Show>
    </Frame>
  )
}

/** One console alone (a console tile opened in a window or in a tab of the browser). */
export function DetachedConsole(props: { id: string; consoleId: string }) {
  const s = useProject(props.id, () => t('Console'))
  const term = () => capability('terminal')
  const info = () => term()?.all().find((c) => c.id === props.consoleId)
  createEffect(() => {
    if (info()) document.title = `${info()!.title} · ${project()?.name ?? ''}`
  })
  return (
    <Frame ready={s.ready()} error={s.error()}>
      <Show when={info()} fallback={<p class="muted pad">{t('This console is closed')}</p>}>
        <div class="tile-console detached-console">
          <Dynamic component={term()!.TermView} id={props.consoleId} focus />
        </div>
      </Show>
    </Frame>
  )
}
