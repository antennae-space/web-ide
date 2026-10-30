# Debug plugin

The debug host: a client of the [Debug Adapter Protocol](../../docs/design/debug.md) in the pod, which runs the debug sessions of a project and relays their events to its windows. It provides the `debug` capability. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `debug`): the sessions are `internal/dap`, a part of the runtime of the project (`rt.Part("debug")`) — started adapters, stopped with the project, not on idle. `config.go` reads `.ide/debug.json` of the main project (the configurations, `${workspaceFolder}`, `${file}`, `${fileDirname}`, `${env:NAME}` replaced) and `breakpoints.go` `.ide/breakpoints.json` of the worktree. The adapters themselves are the language packs' (`contributes.debuggers`); the core runs them on their grant `debugger:<type>` (`server/plugins_debuggers.go`).
- **Methods**: `debug.debuggers` (the adapters of the packs, where each is), `debug.configurations` (the file's configurations and the packs' templates), `debug.templates`, `debug.start`, `debug.stop`, `debug.restart`, `debug.sessions`, `debug.threads`, `debug.stack`, `debug.scopes`, `debug.variables`, `debug.evaluate`, `debug.continue`, `debug.pause`, `debug.next`, `debug.stepIn`, `debug.stepOut`, `debug.breakpoints`, `debug.setBreakpoints`, `debug.install`. A `runInTerminal` of an adapter opens a console of the Console tool.
- **Events**: `debug.session` (a session appeared, changed, ended), `debug.stopped` (the thread, the reason, the file and the line), `debug.output`, `debug.breakpoint`, `debug.thread`, `debug.event`. The variables stay lazy: a row asks for its `variablesReference`.
- **Page**: none yet — the Debug tool is #189.
- **E2e** (`e2e/`, run by `e2e/run.sh`): debug (the lang-go pack with `debugger:go`, a Go program stopped on a line breakpoint by `dlv dap`, its stack and a local read through the methods; skipped when `dlv` is not installed).

The Go package imports the core of `pod/`; its texts are in `i18n/<lang>.json`, added in `init` (`i18n.go`).
