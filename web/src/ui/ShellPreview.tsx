// The shape of a desk drawn at once while its project opens (#212): the zones with the title of
// their tool, the panes with the titles of their tabs, as this device showed them last, dimmed
// under the steps of the opening (LoadingSteps). Nothing of a file is kept, only titles and sizes,
// so nothing stale passes for live: the real IDE replaces it when the project is ready.
import { For, Show, type JSX } from 'solid-js'
import type { LayoutNode, SessionData, TabState } from '../state/project'
import { LoadingSteps } from './LoadingSteps'

type ShellNode = { tabs: string[]; active: number } | { dir: 'row' | 'col'; sizes: number[]; children: ShellNode[] }
export interface Shell {
  left?: { title: string; width: number }
  right?: { title: string; width: number }
  bottom?: { left?: string; right?: string; height: number; split: number }
  layout: ShellNode
  /** A grid desk is drawn by its tiles, not by this shape: no preview. */
  grid?: boolean
}

const MAX_TABS = 40
const MAX_TITLE = 60
const key = (project: string, desk: number) => `shell:${project}:${desk}`

/** The shape of the desk shown: the titles come from the window, which knows its tools and tabs. */
export function shellOf(
  s: SessionData,
  sizes: { left: number; right: number; bottom: number; split: number },
  shown: (zone: 'left' | 'right' | 'bottomLeft' | 'bottomRight') => string | null,
  toolTitle: (id: string) => string,
  tabTitle: (tab: TabState) => string,
  grid: boolean,
): Shell {
  let tabs = 0
  const node = (n: LayoutNode): ShellNode => {
    if (n.type === 'split') return { dir: n.dir, sizes: [...n.sizes], children: n.children.map(node) }
    const ids = n.tabs.slice(0, Math.max(0, MAX_TABS - tabs))
    tabs += ids.length
    return { tabs: ids.map((id) => (s.tabs[id] ? tabTitle(s.tabs[id]) : '').slice(0, MAX_TITLE)), active: Math.max(0, ids.indexOf(n.active ?? '')) }
  }
  const [l, r, bl, br] = [shown('left'), shown('right'), shown('bottomLeft'), shown('bottomRight')]
  return {
    left: l ? { title: toolTitle(l), width: sizes.left } : undefined,
    right: r ? { title: toolTitle(r), width: sizes.right } : undefined,
    bottom: bl || br ? { left: bl ? toolTitle(bl) : undefined, right: br ? toolTitle(br) : undefined, height: sizes.bottom, split: sizes.split } : undefined,
    layout: node(s.layout),
    grid: grid || undefined,
  }
}

export function saveShell(project: string, desk: number, shell: Shell) {
  try {
    localStorage.setItem(key(project, desk), JSON.stringify(shell))
  } catch {
    /* private mode or quota: the preview is a comfort */
  }
}

export function loadShell(project: string, desk: number): Shell | null {
  try {
    const raw = localStorage.getItem(key(project, desk))
    const s = raw ? (JSON.parse(raw) as Shell) : null
    return s?.layout && !s.grid ? s : null
  } catch {
    return null
  }
}

function Node(props: { node: ShellNode }): JSX.Element {
  const n = props.node
  if ('dir' in n)
    return (
      <div class="sp-split" style={{ 'flex-direction': n.dir === 'row' ? 'row' : 'column' }}>
        <For each={n.children}>{(c, i) => <div style={{ flex: `${n.sizes[i()] ?? 1} 1 0`, display: 'flex', 'min-width': 0, 'min-height': 0 }}><Node node={c} /></div>}</For>
      </div>
    )
  return (
    <div class="sp-pane">
      <div class="sp-tabs">
        <For each={n.tabs}>{(title, i) => <span class="sp-tab" classList={{ active: i() === n.active }}>{title}</span>}</For>
      </div>
    </div>
  )
}

/** The dimmed shape of the desk, with the steps of the opening in a card above it. */
export function ShellPreview(props: { shell: Shell }) {
  const s = props.shell
  return (
    <div class="shell-preview" data-testid="shell-preview">
      <div class="sp-body" aria-hidden="true">
        <div class="menubar" />
        <div class="workbench">
          <div class="rail" />
          <div class="work">
            <div class="work-top">
              <Show when={s.left}>{(z) => <div class="sp-zone" style={{ width: `${z().width}px` }}><div class="sp-head">{z().title}</div></div>}</Show>
              <div class="sp-center">
                <Node node={s.layout} />
              </div>
              <Show when={s.right}>{(z) => <div class="sp-zone" style={{ width: `${z().width}px` }}><div class="sp-head">{z().title}</div></div>}</Show>
            </div>
            <Show when={s.bottom}>
              {(b) => (
                <div class="sp-bottom" style={{ height: `${b().height}px` }}>
                  <Show when={b().left}>{(t) => <div class="sp-zone" style={{ flex: b().right ? `0 0 ${b().split * 100}%` : '1 1 0' }}><div class="sp-head">{t()}</div></div>}</Show>
                  <Show when={b().right}>{(t) => <div class="sp-zone" style={{ flex: '1 1 0' }}><div class="sp-head">{t()}</div></div>}</Show>
                </div>
              )}
            </Show>
          </div>
          <div class="rail" />
        </div>
      </div>
      <div class="sp-steps">
        <LoadingSteps />
      </div>
    </div>
  )
}
