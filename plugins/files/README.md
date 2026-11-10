# Files plugin

Locked (`required`): the Explorer, the Files tab of Search Everywhere and the files service. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `files`): No method: the files are the core's.
- **Page** (`web/`, the chunk `plugin-files`): `Explorer.tsx` (the tree: its rows are the shared file row of the window (`ui/FileRow.tsx`), which renders the decoration channels — tint on the row, color on the name, label after it, badge at its end, error sign — [plugins.md](../../docs/design/plugins.md#what-explorer-decorations-added-to-the-api)), `roots.ts` (the roots of the Explorer: its own two, the project and *Scratches and Consoles*, their order and folding in the desk, [explorer.md](../../docs/design/explorer.md)), `tints.ts` (its built-in rules: test names, library roots, manifests, folder marks — each family switchable from the *Row tints* submenu of the ⋮), `search.tsx` (the Files provider).
- **E2e** (`e2e/`, run by `e2e/run.sh`): explorer.

Pitfall: the Explorer is virtualized (#225). The expanded tree is one flat list and only the rows in view, plus a margin of 20, are in the DOM. A test or a feature looking for a row out of view (`.explorer .tree-row[data-path=…]`) finds nothing: scroll the panel first, or go through `revealInExplorer`. The arrow keys move through the flat list, not through the DOM.

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.
