// The row of a file, drawn the same way in every tree of the window (#183): the Explorer, Recent
// Files, the Commit tab and Search results. Each tree keeps its own handlers and its own slots,
// none writes a name span by hand: the channels of the decoration (`decoratePath`) take their
// place in the row, and `styles.css` gives them their look once.
import { Show, type JSX } from 'solid-js'
import { FileIcon } from './fileIcons'
import { Icon } from './icons'
import { t } from '../i18n'
import type { FileDecoration, FileTint } from '../plugins/types'

export interface FileRowProps {
  /** Name shown. Undefined: no name, the `icon` slot carries the whole head of the row. */
  name?: string
  /** Absolute path: `data-path`, what the trees query rows by. */
  path: string
  dir?: boolean
  /** The channels of the path (`decoratePath`, or what the tree resolved for itself). */
  deco?: FileDecoration
  /** A file in error, or a folder holding one below it (#184): the red sign. */
  error?: boolean
  /** The red wavy underline under the name too: the Explorer asks for it, no other tree does. */
  errorWavy?: boolean
  /** Folder open (the twist, the folder icon). */
  open?: boolean
  /** Indentation: `depth * 14 + 6` px. */
  depth?: number
  /** No indentation: the row is placed by its own layout. */
  noIndent?: boolean
  selected?: boolean
  /** The file shown in the active editor. */
  current?: boolean
  excluded?: boolean
  /** Mark of the folder (`source`, `tests`, `excluded`): `data-mark` and the tinted icon. */
  mark?: string | null
  /** false: no twist at all (a list that is not a tree). A folder row shows it by default. */
  twist?: boolean
  /** Class of the row: `tree-row`, what the trees and the styles query. */
  rowClass?: string
  /** Extra class of the row (`tree-top` for the head row of a tree). */
  extraClass?: string
  /** Replaces the file icon: the label of the head row of a tree. */
  icon?: JSX.Element
  /** After the name and its label (the link sign, the count of a folder). */
  after?: JSX.Element
  /** At the right end of the row (a staging check box, a worktree chip). */
  end?: JSX.Element
  /** Family of the background, when the tree resolved one of its own. */
  tint?: FileTint
  title?: string
  role?: JSX.HTMLAttributes<HTMLDivElement>['role']
  /** `aria-expanded` (a folder row). */
  expanded?: boolean
  /** `aria-selected`. */
  chosen?: boolean
  tabIndex?: number
  /** `data-index` (the pick lists move the selection by it). */
  index?: number
  style?: JSX.CSSProperties
  /** Handlers of the tree: `currentTarget` is the row. */
  onFocus?: (e: FocusEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onClick?: (e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onDblClick?: (e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onKeyDown?: (e: KeyboardEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onContextMenu?: (e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onMouseEnter?: (e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onMouseDown?: (e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }) => void
}

/** One class string: a `classList` entry would be wiped when the decoration rewrites `class`. */
function classes(props: FileRowProps) {
  let c = props.rowClass ?? 'tree-row'
  if (props.extraClass) c += ' ' + props.extraClass
  if (props.selected) c += ' selected'
  if (props.current) c += ' current'
  if (props.excluded) c += ' excluded'
  return c
}

export function FileRow(props: FileRowProps): JSX.Element {
  const state = () => props.deco?.state ?? 'clean'
  const badge = () => props.deco?.badge
  const label = () => props.deco?.label
  const tint = () => props.tint ?? props.deco?.tint
  return (
    <div
      class={classes(props)}
      role={props.role ?? 'treeitem'}
      tabIndex={props.tabIndex ?? -1}
      aria-expanded={props.expanded}
      aria-selected={props.chosen}
      data-path={props.path}
      data-index={props.index}
      data-mark={props.mark ?? undefined}
      data-kind={props.deco?.kind}
      data-tint={tint()}
      title={props.title}
      style={props.noIndent ? props.style : { 'padding-left': `${(props.depth ?? 0) * 14 + 6}px`, ...props.style }}
      onFocus={props.onFocus}
      onClick={props.onClick}
      onDblClick={props.onDblClick}
      onKeyDown={props.onKeyDown}
      onContextMenu={props.onContextMenu}
      onMouseEnter={props.onMouseEnter}
      onMouseDown={props.onMouseDown}
    >
      <Show when={props.twist !== false}>
        <span class="tree-twist" classList={{ open: !!props.open, none: !props.dir }}>
          <Show when={props.dir}>
            <Icon name="chevron" size={12} />
          </Show>
        </span>
      </Show>
      {props.icon ?? <FileIcon name={props.name ?? ''} dir={props.dir} open={props.open} mark={props.mark ?? null} />}
      <Show when={props.name !== undefined}>
        <span class={`tree-name git-${state()}${props.error && props.errorWavy ? ' has-error' : ''}`}>{props.name}</span>
      </Show>
      <Show when={label()}>
        <span class="tree-label">{label()}</span>
      </Show>
      <Show when={props.error}>
        <span class="tree-error-sign" title={t(props.dir ? 'Error in a file below' : 'Error in this file')}>
          <Icon name="alert" size={13} />
        </span>
      </Show>
      <Show when={badge()}>
        <span class={`tree-badge git-${state()}`} title={t(state())}>
          {badge()}
        </span>
      </Show>
      {props.after}
      {/* The free space of the row, kept by the filler only when nothing else carries the auto
          margin: a `flex:1` span placed before `margin-left:auto` swallows it, which used to pin
          the status letter next to the name in the trees with an `end` slot (the Commit tree). */}
      <Show when={props.end !== undefined && !badge() && !props.error}>
        <span class="grow" />
      </Show>
      {props.end}
    </div>
  )
}
