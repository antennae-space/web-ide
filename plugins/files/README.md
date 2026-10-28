# Files plugin

Locked (`required`): the Explorer, the Files tab of Search Everywhere and the files service. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `files`): No method: the files are the core's.
- **Page** (`web/`, the chunk `plugin-files`): `Explorer.tsx` (the tree, and the rendering of the decoration channels: tint on the row, color on the name, label after it, badge at its end — [plugins.md](../../docs/design/plugins.md#what-explorer-decorations-added-to-the-api)), `tints.ts` (its built-in rules: test names, library roots, manifests, folder marks — each family switchable from the *Row tints* submenu of the ⋮), `search.tsx` (the Files provider).
- **E2e** (`e2e/`, run by `e2e/run.sh`): explorer.

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.
