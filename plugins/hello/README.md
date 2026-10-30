# Hello plugin

The plugin of the browser tests, registered only with `WEBIDE_TEST_PLUGINS`: a tool, an RPC method, an assistant tool, a status bar item, the items it adds to the ⋮ menu of its tool, and the editor decorations it puts on `deco.txt` (`editorDecorations`, #187). A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `hello`): `hello.go`.
- **Page** (`web/`, the chunk `plugin-hello`): `index.tsx`, `deco.css` (the classes of its decorations).
- **E2e**: none of its own.

Its assertions are in the `plugins` suite of the core (`e2e/suites/plugins.cjs`) and in `decorations` (`plugins/code/e2e/decorations.cjs`).

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.
