// The one menu of a tool, a console or a tab (docs/design/spec.md §9): opened by the ⋮ of its
// zone or of its tile, by a right click on the zone or on its tab — the same list everywhere.
// The corner of a zone and of a tile is made by CornerButtons: the ⋮ and the ✕ next to it.
import { Icon } from './icons'
import { contextMenu, type MenuItem } from './overlay'
import { shortcutOf } from '../keys/bindings'
import { t } from '../i18n'
import { closeTab, mutate, session, type TabState } from '../state/project'
import { shownIn, toggleTool, type Zone } from '../state/zones'
import { detachTab, openInBrowserTab, tileMode } from '../state/tiles'
import { toolMenuFor } from '../plugins/registry'

/** What a menu is opened for: a tool shown in a zone, or a tab of a pane. */
export type ToolSubject = { zone: Zone } | { pane: string; tab: TabState }

/** The tab of the subject (a zone gives the tool it shows, with no tab of its own). */
function subjectTab(s: ToolSubject): TabState | null {
  if ('zone' in s) {
    const id = shownIn(session, s.zone)
    return id ? { id: '', kind: 'tool', tool: id } : null
  }
  return s.tab
}

/**
 * The items of the menu, in order: *Open in a tab* and *Open in a window* for a tool or a console
 * (a desk of tiles only for the browser tab: Full keeps its zones), *Close* — it hides the tool
 * from its zone, closes the tab of a tile — then the items of the tab (`extra`), then the items the
 * tool's plugin contributes (`toolMenu` contribution point, #175). The same list from the ⋮ of a
 * zone, of a tile, and from a right click on either.
 */
export function toolMenuItems(subject: ToolSubject, extra: MenuItem[] = []): MenuItem[] {
  const tab = subjectTab(subject)
  const openable = !!tab && (tab.kind === 'tool' || tab.kind === 'console')
  const items: MenuItem[] = []
  if (openable && tileMode()) items.push({ label: t('Open in a tab'), action: () => openInBrowserTab(tab!) })
  if (openable) items.push({ label: t('Open in a window'), action: () => detachTab(tab!) })
  items.push(
    'zone' in subject
      ? { label: t('Close'), action: () => mutate((s) => toggleTool(s, shownIn(s, subject.zone) ?? '')) }
      : { label: t('Close'), hint: shortcutOf('view.closeTab'), action: () => closeTab(subject.pane, subject.tab.id) },
  )
  if (extra.length) items.push({ separator: true, label: '' }, ...extra)
  const contributed = tab ? toolMenuFor({ tab }) : []
  if (contributed.length) items.push({ separator: true, label: '' }, ...contributed)
  return items
}

/** The corner of a zone or of a tile: the ⋮ opening the menu, and the ✕ beside it. */
export function CornerButtons(props: {
  kind: 'zone' | 'tile'
  /** The name of the tool or console, in the tooltip of the ⋮. */
  title: string
  items: () => MenuItem[]
  close: () => void
  closeTitle?: string
}) {
  return (
    <div class={props.kind === 'zone' ? 'zone-corner' : 'tile-corner'}>
      <button class="icon-btn corner-btn" title={props.title} onClick={(e) => contextMenu(e, props.items())} data-testid={props.kind === 'zone' ? 'zone-menu' : 'tile-menu'}>
        <Icon name="more" size={13} />
      </button>
      <button class="icon-btn corner-btn" title={props.closeTitle ?? t('Close')} onClick={props.close} data-testid={props.kind === 'zone' ? 'zone-close' : 'tile-close'}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
