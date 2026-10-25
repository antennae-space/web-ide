# Languages plugin

The language host: the language servers, Problems, Structure and the Symbols provider, apart from the editor. It provides the `language` capability. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `languages`): The `lsp.*` methods; the servers are `internal/lsp`, a part of the runtime of the project (`language.go`), started on demand, stopped when idle: those of the language packs the project uses: the core knows no language (Go since #146, PHP, Python, JavaScript and TypeScript since #149) (#145: `lsp.PackSpec`, `Manager.UsePacks`; the pod builds their command, confined on this machine, the bare program on the host of an SSH project). It provides the `language` capability (`plugins.Language`), through which the `lsp_*` tools of the assistant reach them.
- **Page** (`web/`, the chunk `plugin-languages`): The servers of the packs, found or missing, and their install `servers.ts` (the editor's banner, Settings); the client and the code actions `client.ts`, rename and formatting `refactor.ts`, the completion of the servers, the buffers announced to them `sync.ts`, the Problems and Structure tools.
- **E2e** (`e2e/`, run by `e2e/run.sh`): lsp (needs `gopls`), langpack (a fixture language pack), langpacks (the packs of PHP, Python and JavaScript/TypeScript; each server found on the PATH), langinstall (a pack's server installed from the editor's banner, #153).

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.
