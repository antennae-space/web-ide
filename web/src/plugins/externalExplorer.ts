// The Explorer nodes of the external plugins (#244, docs/design/explorer.md): their frames push
// them as data (`ide.setExplorerNodes`), kept here per frame, so that a tab view of each console
// gives its own; a double click or a menu choice goes back to the frame that pushed the node.
import { createSignal } from 'solid-js'
import { lang } from '../i18n'
import { resolvePath } from '../ui/uiCalls'
import type { PageMessage, SandboxExplorerNode } from './sandbox-api'
import type { ExplorerNode, ExplorerRoot, PluginManifest } from './types'

type Pushed = { plugin: string; frame: number; root: string; nodes: SandboxExplorerNode[]; send: (m: PageMessage) => void }

const [pushed, setPushed] = createSignal<Pushed[]>([])
let nextFrame = 1

/** The roots a plugin may push nodes into: its own, and those its manifest names. */
const rootsOf = (m: PluginManifest) => [...(m.contributes.explorerRoots ?? []).map((r) => r.id), ...(m.contributes.explorerNodes ?? [])]

/** What the host of one frame gets: push its nodes into a root, and take them all back when it stops. */
export function explorerHost(m: PluginManifest, send: () => (msg: PageMessage) => void) {
  const frame = nextFrame++
  const roots = rootsOf(m)
  return {
    set: (root: string, nodes: SandboxExplorerNode[]) => {
      if (!roots.includes(root)) return
      setPushed((l) => [...l.filter((p) => !(p.frame === frame && p.root === root)), ...(nodes.length ? [{ plugin: m.id, frame, root, nodes, send: send() }] : [])])
    },
    drop: () => setPushed((l) => l.filter((p) => p.frame !== frame)),
  }
}

/** A node of a frame as the core's: its id scoped by the plugin (two plugins may fill one root). */
function toNode(n: SandboxExplorerNode, p: Pushed): ExplorerNode {
  const back = (item?: string) => p.send({ explorer: { root: p.root, node: n.id, item } })
  return {
    id: `${p.plugin}:${n.id}`,
    label: n.label,
    icon: n.icon,
    title: n.title,
    path: n.path ? resolvePath(n.path) : undefined,
    project: n.project,
    desk: n.desk,
    badge: n.badge,
    dimmed: n.dimmed,
    children: n.children?.length ? () => n.children!.map((c) => toNode(c, p)) : undefined,
    open: n.open ? () => back() : undefined,
    menu: n.menu?.length ? () => n.menu!.map((it) => ({ label: it.label, hint: it.hint, title: it.title, checked: it.checked, disabled: it.disabled, separator: it.separator, action: () => back(it.id) })) : undefined,
  }
}

/**
 * Siblings with the same id are one node: the first one's, with the children of all. Each frame
 * pushes its own part (a console tab its console under the node of its connection).
 */
function merge(list: ExplorerNode[]): ExplorerNode[] {
  const out: ExplorerNode[] = []
  for (const n of list) {
    const i = out.findIndex((o) => o.id === n.id)
    if (i < 0) out.push(n)
    else if (n.children) {
      const a = out[i].children
      const b = n.children
      out[i] = { ...out[i], children: () => merge([...(a?.() ?? []), ...b()]) }
    }
  }
  return out.map((n) => (n.children ? { ...n, children: ((c) => () => merge(c()))(n.children) } : n))
}

/** The nodes the frames of a plugin gave a root. */
const nodesOf = (plugin: string, root: string) => merge(pushed().flatMap((p) => (p.plugin === plugin && p.root === root ? p.nodes.map((n) => toNode(n, p)) : [])))

/** The Explorer contributions of an external plugin, from its manifest: its roots, the nodes it puts into others. */
export function explorerContributions(m: PluginManifest, catalogs: Record<string, Record<string, string>>) {
  const label = (text: string) => catalogs[lang()]?.[text] ?? text
  const roots: ExplorerRoot[] = (m.contributes.explorerRoots ?? []).map((r) => ({ id: r.id, label: () => label(r.label), icon: r.icon ?? 'puzzle', order: r.order ?? 60, nodes: () => nodesOf(m.id, r.id) }))
  const nodes = Object.fromEntries((m.contributes.explorerNodes ?? []).map((root) => [root, () => nodesOf(m.id, root)]))
  return { roots, nodes, any: roots.length > 0 || (m.contributes.explorerNodes ?? []).length > 0 }
}
