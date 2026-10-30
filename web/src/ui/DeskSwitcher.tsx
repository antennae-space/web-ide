// Desks of the project, on the left of the status bar (docs/design/desks.md): 1 2 3 +. A desk is a
// link: a click switches the window, a middle click opens it in a new tab. A tab dropped on a desk
// moves there. On a phone it is the whole content of the floating bar at the bottom of the menus
// mode (pages/ProjectPage.tsx).
import { createSignal, For, Show } from 'solid-js'
import { podPath } from '../app/base'
import { deskPath, navigate } from '../app/router'
import { home, moveTabToDesk, switchDesk } from '../state/project'
import { addDesk, desk, deskDrag, deskEnds, deskLabel, desks, removeDesk, renameDesk, setDeskDrag, type Desk } from '../state/desks'
import { changeMode, tileMode, nextSplit, resizing, toggleSplit } from '../state/tiles'
import { tileLauncher } from './tileLauncher'
import { Icon } from './icons'
import { draggedTab } from './EditorArea'
import { shortcutOf } from '../keys/bindings'
import { confirmModal, contextMenu, prompt } from './overlay'
import { toast } from './toast'
import { t } from '../i18n'

export function DeskSwitcher() {
  const [over, setOver] = createSignal(0)
  const path = (n: number) => deskPath(home()!.id, n)
  const go = (e: MouseEvent, n: number) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return // the browser opens a new tab
    e.preventDefault()
    navigate(path(n))
  }
  const menu = (e: MouseEvent, d: Desk) =>
    contextMenu(e, [
      { label: t('Open in a new tab'), action: () => window.open(podPath(path(d.n)), '_blank') },
      {
        label: t('Rename…'),
        action: async () => {
          const v = await prompt({ title: t('Rename the desk'), label: t('Name of desk {n}', { n: d.n }), value: d.name ?? '' })
          if (v !== null) renameDesk(d.n, v)
        },
      },
      { separator: true, label: '' },
      { label: t('Full layout'), title: t('Rails and tool zones'), checked: d.mode === 'full', action: () => changeMode(d.n, 'full') },
      { label: t('Grid of tiles'), title: t('Tiles only, like i3'), checked: d.mode === 'grid', action: () => changeMode(d.n, 'grid') },
      { label: t('Scrolling columns'), title: t('Columns of tiles side by side, like niri'), checked: d.mode === 'scroll', action: () => changeMode(d.n, 'scroll') },
      { separator: true, label: '' },
      { label: t('Remove the desk'), disabled: d.n === 1, title: d.n === 1 ? t('Desk 1 stays') : undefined, danger: true, action: () => remove(d) },
    ])
  const remove = async (d: Desk) => {
    // What runs on the desk (its consoles…) is listed: it ends with the desk.
    const ends = deskEnds(d.n)
    const text = t('Remove the desk {name}? Its tabs close, the files stay open on the other desks.', { name: deskLabel(d) })
    const items = ends.flatMap((e) => e.items)
    if (!items.length) {
      if (!confirm(text)) return
    } else if (!(await confirmModal({ title: t('Remove the desk'), text: `${text}\n\n${t('These end with it:')}\n${items.map((i) => `• ${i}`).join('\n')}`, ok: t('Remove and end them'), danger: true }))) return
    await Promise.all(ends.map((e) => e.end().catch(() => {})))
    // Leave it first: its last changes must not write it back once removed.
    if (d.n === desk()) {
      await switchDesk(1)
      navigate(path(1), true)
    }
    removeDesk(d.n)
  }
  const add = async () => {
    try {
      navigate(path(await addDesk()))
    } catch (e) {
      toast((e as Error).message, 'warn')
    }
  }
  const drop = (e: DragEvent, n: number) => {
    const d = draggedTab()
    const other = deskDrag()
    setOver(0)
    if ((!d && !other) || n === desk()) return
    e.preventDefault()
    if (other) {
      setDeskDrag(null)
      return other(n)
    }
    void moveTabToDesk(d!.pane, d!.tab, n).catch((err) => toast((err as Error).message, 'warn'))
  }
  return (
    <nav class="sb-desks" aria-label={t('Desks')} data-testid="desks">
      <For each={desks.desks}>
        {(d) => (
          <a
            class="sb-desk"
            classList={{ active: d.n === desk(), over: over() === d.n }}
            href={podPath(path(d.n))}
            aria-current={d.n === desk() ? 'page' : undefined}
            title={[d.name ? t('Desk {n}: {name}', { n: d.n, name: d.name }) : t('Desk {n}', { n: d.n }), shortcutOf(`desk.go.${d.n}`)].filter(Boolean).join(' · ')}
            data-testid={`desk-${d.n}`}
            onClick={(e) => go(e, d.n)}
            onContextMenu={(e) => menu(e, d)}
            onDragOver={(e) => {
              if ((!draggedTab() && !deskDrag()) || d.n === desk()) return
              e.preventDefault()
              setOver(d.n)
            }}
            onDragLeave={() => setOver(0)}
            onDrop={(e) => drop(e, d.n)}
          >
            {deskLabel(d)}
          </a>
        )}
      </For>
      <button class="sb-desk add" title={t('New desk')} onClick={add} data-testid="desk-add">
        +
      </button>
      <Show when={tileMode()}>
        <button
          class="sb-desk tile-add"
          title={[t('Open in a new tile…'), shortcutOf('tile.launcher')].filter(Boolean).join(' · ')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            // The launcher opens above the bar (overlay clamps the popup to the viewport).
            void tileLauncher({ left: r.left, top: r.top })
          }}
          data-testid="tile-launcher"
        >
          <Icon name="split" size={13} />
        </button>
        <button
          class="sb-desk tile-split"
          title={[nextSplit() === 'row' ? t('New tiles open on the right') : t('New tiles open below'), shortcutOf('tile.toggleSplit')].filter(Boolean).join(' · ')}
          onClick={toggleSplit}
          data-testid="tile-split"
          data-split={nextSplit()}
        >
          {nextSplit() === 'row' ? '◨' : '⬓'}
        </button>
        <Show when={resizing()}>
          <span class="sb-resizing" data-testid="tile-resizing">
            {t('Resize: arrows, Shift for more, Esc to end')}
          </span>
        </Show>
      </Show>
    </nav>
  )
}
