// Tree of changed files, drawn with the shared file row of the window (ui/FileRow): a click opens
// the file's diff, a double click the file; arrows move, Space toggles the check box of the row.
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from 'solid-js'
import type { FileDecoration } from '@ide/types'
import type { TreeNode } from './tree'
import { FileRow } from './plugin'

export function FileTree<T>(props: {
  root: TreeNode<T>
  label: JSX.Element
  /** Folders closed by the user (absolute paths). */
  closed: () => Set<string>
  setClosed: (s: Set<string>) => void
  /** Decoration of a file: the color of its state and its status letter, in the same classes as the Explorer. */
  decoOf: (item: T) => FileDecoration
  /** Decoration of a folder, from what the tree knows of its content. */
  folderDeco?: (node: TreeNode<T>) => FileDecoration
  /** Former path of a renamed file. */
  fromOf?: (item: T) => string | undefined
  /** End of a row (the check box). */
  end?: (node: TreeNode<T>) => JSX.Element
  toggle?: (node: TreeNode<T>) => void
  open: (item: T) => void
  openFile?: (item: T) => void
  menu?: (e: MouseEvent, node: TreeNode<T>) => void
  testid?: string
}) {
  const [selected, setSelected] = createSignal<string | null>(null)
  let box!: HTMLDivElement
  const isOpen = (n: TreeNode<T>) => !props.closed().has(n.path)
  const setOpen = (n: TreeNode<T>, open: boolean) => {
    const s = new Set(props.closed())
    open ? s.delete(n.path) : s.add(n.path)
    props.setClosed(s)
  }
  const rows = () => [...box.querySelectorAll<HTMLElement>('.tree-row')]
  // Rows are rebuilt with the tree: a row that had the focus gives it to its new copy
  // (read before the rows are replaced, never taken from elsewhere).
  let hadFocus = false
  const root = createMemo(() => {
    hadFocus = !!box?.contains(document.activeElement)
    return props.root
  })
  createEffect(
    on(
      root,
      () => {
        if (!hadFocus) return
        hadFocus = false
        requestAnimationFrame(() => rows().find((r) => r.dataset.path === selected())?.focus())
      },
      { defer: true },
    ),
  )

  function Row(p: { node: TreeNode<T>; depth: number; root?: boolean }) {
    const n = p.node
    const dir = !n.item
    const deco = () => (n.item ? props.decoOf(n.item) : (p.root ? undefined : props.folderDeco?.(n)))
    const from = () => (n.item && props.fromOf?.(n.item)) || ''
    return (
      <>
        <FileRow
          name={p.root ? undefined : n.name}
          path={n.path}
          // The head row of the tree shows its label in place of the icon and the name, and no twist.
          dir={p.root ? false : dir}
          open={isOpen(n)}
          depth={p.depth}
          deco={deco()}
          selected={selected() === n.path}
          expanded={dir ? isOpen(n) : undefined}
          extraClass={p.root ? 'tree-top' : undefined}
          icon={p.root ? props.label : undefined}
          after={
            <>
              <Show when={!p.root && dir}>
                <span class="git-count">{n.items.length}</span>
              </Show>
              <Show when={from()}>
                <span class="git-from">← {from()}</span>
              </Show>
            </>
          }
          end={props.end?.(n)}
          onFocus={() => setSelected(n.path)}
          onClick={(e) => {
            setSelected(n.path)
            e.currentTarget.focus()
            if ((e.target as Element).closest('.git-check')) return
            if (dir) setOpen(n, !isOpen(n))
            else props.open(n.item!)
          }}
          onDblClick={(e) => n.item && !(e.target as Element).closest('.git-check') && props.openFile?.(n.item)}
          onContextMenu={(e) => {
            setSelected(n.path)
            props.menu?.(e, n)
          }}
          onKeyDown={(e) => {
            const list = rows()
            const i = list.indexOf(e.currentTarget)
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') list[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
            else if (e.key === 'ArrowRight' && dir && !isOpen(n)) setOpen(n, true)
            else if (e.key === 'ArrowLeft' && dir && isOpen(n) && !p.root) setOpen(n, false)
            else if (e.key === 'Enter') dir ? setOpen(n, !isOpen(n)) : props.open(n.item!)
            else if (e.key === ' ' && props.toggle) props.toggle(n)
            else return
            e.preventDefault()
          }}
        />
        <Show when={dir && (p.root || isOpen(n))}>
          <For each={n.children}>{(c) => <Row node={c} depth={p.depth + 1} />}</For>
        </Show>
      </>
    )
  }

  return (
    <div class="tree git-tree" role="tree" ref={box} data-testid={props.testid}>
      <Show when={root()} keyed>
        {(root) => <Row node={root} depth={0} root />}
      </Show>
    </div>
  )
}
