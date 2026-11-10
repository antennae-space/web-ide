# Explorer roots

The Explorer as the navigator of the project, as in PhpStorm (a foldable project root, *Scratches and Consoles*), but open to every tool: it shows a list of foldable **roots**, one per tool, each a tree of **nodes**. Decided with the user on 2026-11-10, milestone 20; the base (the contribution, the project root, the order) is done in #239, the terminals and tasks in #240, the debug sessions in #241.

## Choices

- **A tree, one root per tool.** No graph: a root holds nodes, a node may hold nodes. A tool gives one root at most; a plugin may also put nodes into the root of another one (the SQL consoles of plugin-database into *Scratches and Consoles*).
- **The tools keep their own lists.** The Console keeps its tabs, the Agents tool its sessions: the Explorer is a second way to reach them, across the tools.
- **A click focuses.** A node opens like a file: a double click or `Enter` (a single click with the option *Open files with a single click*, or on a phone) shows it in its tool. When it belongs to another worktree than the one shown, the IDE asks first, then switches the window to that worktree.
- **Global view.** A root lists the items of the whole project, every desk and every attached worktree. An item of another worktree carries a chip at the right of its row (the worktree chip, as the tabs and the consoles have; the project name for the main folder); an item of another desk carries the name of the desk. A finished item (a task that ended) is dimmed.
- **The user orders the roots, the plugin orders the nodes.** The order and the folded roots are saved in the desk; the nodes inside a root keep the order of their plugin.

## The roots

In their order by default:

| Root | Plugin | Nodes | Ticket |
|---|---|---|---|
| Conversations & Agents | AI | the active threads of the assistant and the active sessions of the Agents tool, merged; their children: the sub-agents, then the files the thread changed (those of its `edit_file` / `write_file`, of the `edit`, `delete`, `move` tool calls of an agent, kept since #242; not those a command changes; an agent tells no sub-agents) | #242 done, #243 |
| The project (its name) | Files | the file tree of the worktree shown; a folder icon | #239 |
| Scratches and Consoles | Files (empty) | the SQL consoles (plugin-database), by connection | #244, #245 |
| Terminals and tasks | Exec | the consoles of the Console tool: a terminal or a task icon, the tags of their desk and worktree, an ended one dimmed (with its exit code when it is not 0); a double click shows it in the Console (it comes to the desk shown, as when the assistant shows it); its menu renames, moves or closes it | #240, done |
| Debug sessions | Debug | the debug sessions of every attached worktree, with their state (*Paused*, *Starting*), an ended one dimmed; a double click shows it in the Debug tool (the Explorer asks before switching its worktree); its menu stops or restarts it | #241, done |

A root with no node is hidden; the project root always shows.

## In the Explorer

- The roots and their content are one flat list, the one of the virtualized tree (#225): the arrows move through roots, nodes and files alike, `ArrowLeft` goes up to the parent (a file at the top of the project goes up to the project root), and `ArrowLeft` on an open root folds it.
- A root row has a twist, an icon and a bold name. Its context menu has *Fold* / *Unfold*, *Move up* and *Move down*; the project root has the menu of the root folder first (*New file…*, *Paste*…). A root also moves by drag and drop onto another root (above or below it, from the half of the row).
- A node row is a [file row](plugins.md#what-explorer-decorations-added-to-the-api): a node with a `path` is drawn and opened as a file (its Git color, its tint), another one shows the icon its plugin gives. Its tags sit at the right end of the row: its badge (a state: *paused*, *waiting*), its desk, its worktree.
- A node with children starts closed. *Collapse all* closes the folders and the nodes, not the roots.
- The desk of Files keeps `roots` (the order the user set), `foldedRoots` and `openNodes` (the keys of the nodes left open). A root the desk does not list yet (a plugin enabled since) takes its place by default among the others.

## The API

Built-in plugins only for now; external plugins get a bridge in #244.

- `explorerRoots: ExplorerRoot[]` (`web/src/plugins/types.ts`): `id`, `label()`, `icon`, `order` (Conversations 10, the project 20, Scratches 30, Terminals 40, Debug 50) and `nodes()`, read in a memo (it may follow the state of the plugin).
- `explorerNodes: Record<rootId, () => ExplorerNode[]>`: nodes put into a root of another plugin, after its own.
- `ExplorerNode`: `id` (unique in its root), `label`, `icon`, `title`, `path` (a file), `children()`, `project` (its worktree), `desk` (its desk number), `badge`, `dimmed`, `open()` (show it in its tool), `menu()` (its context menu).
- `api.explorer.roots()`: the roots of the enabled plugins with the nodes the others put into them (`web/src/plugins/registry.tsx`). The Explorer orders them, hides the empty ones and draws them.
- The row of a root is `root:<id>` in `data-path`, the row of a node `node:<root>/<id>/<id>…`; a file row keeps its path.
- The test plugin Hello gives a root and a node of *Scratches and Consoles* once its menu asks (*Show the Explorer nodes*), checked by the `plugins` suite.

## Later

- Scratch files of their own (PhpStorm's *Scratches*), in the root *Scratches and Consoles*.
- The worktrees attached to the window as roots of files, beside the project shown.
