# Languages plugin

The language host: the language servers, Problems, Structure and the Symbols provider, apart from the editor. It provides the `language` capability. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `languages`): The `lsp.*` methods; the servers are `internal/lsp`, a part of the runtime of the project (`language.go`), started on demand, stopped when idle: the defaults of `lsp.Defaults` (go, php, python, typescript) and those of the language packs the project uses (#145: `lsp.PackSpec`, `Manager.UsePacks`; the pod builds their command, confined on this machine, the bare program on the host of an SSH project). It provides the `language` capability (`plugins.Language`), through which the `lsp_*` tools of the assistant reach them.
- **Page** (`web/`, the chunk `plugin-languages`): The client and the code actions `client.ts`, rename and formatting `refactor.ts`, the completion of the servers, the buffers announced to them `sync.ts`, the Problems and Structure tools.
- **E2e** (`e2e/`, run by `e2e/run.sh`): lsp (needs `gopls`), langpack (a fixture language pack).

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.
