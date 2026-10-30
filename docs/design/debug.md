# Debug

Debugging in the IDE, as close as it can be to PhpStorm: breakpoints (simple and conditional), the threads and the stack, the variables shown as a tree with their types, watches, a console that evaluates in the paused frame. One host for every language, fed by the language packs. Decided on 2026-10-29; the debug host and Go are done in #188, the Debug tool, the line breakpoints and the focus on a stop in #189; the advanced breakpoints, the watches, the inline values and the hover come with #190.

## Choices

- **DAP everywhere.** The **debug host** is a built-in plugin, `plugins/debug`, a client of the Debug Adapter Protocol: the pod speaks DAP to the adapters and relays their events to the windows of the project. The host knows no language: each language pack contributes its **debug adapter**, as it contributes its language servers.
- **Order of the languages**: Go (`dlv dap`), then JavaScript/TypeScript on Node (`js-debug`), then PHP (Xdebug). Python (`debugpy`) after them; the browser (Chrome DevTools Protocol) later still.
- **The configurations have their own file**, `.ide/debug.json` of the main project, apart from the saved commands. The breakpoints are kept in `.ide/breakpoints.json` of each worktree (its lines are its branch's).
- **When the program stops**, the IDE does what PhpStorm does (its *Show debug window on breakpoint*, *Focus application on breakpoint*, *Hide debug window on process termination*): see [Focus on a stop](#focus-on-a-stop). No layout of its own: the desk stays the user's.

## Words

- **Debug host**: the built-in plugin that runs the debug sessions and shows them (the Debug tool, the breakpoints in the editor). It provides the `debug` capability.
- **Debug adapter**: the program a language pack names that speaks DAP for one runtime (`dlv`, `js-debug`, the Xdebug bridge).
- **Debug configuration**: a named way to start or reach a program under the debugger, an entry of `.ide/debug.json`: launch (the IDE starts the program), attach (to a running process or a port), listen (the program connects to the IDE, as Xdebug does).
- **Debug session**: one run of a configuration, a tab of the Debug tool, from its start to its end.
- **Breakpoint**: a line where the program stops, optionally with a condition or a hit count; a **logpoint** writes a message to the console instead of stopping; an **exception breakpoint** stops on a thrown exception, per filter of the adapter.

## The language packs

A pack declares its adapters beside its servers: `contributes.debuggers: [{type, label, languages, argv, transport: stdio | tcp, paths?, pathDirs?, env?, install?, templates: [{label, request, config}]}]`.

- `type` is the key the configurations name (`go`, `node`, `php`); `templates` fill a new configuration (*Launch the package*, *Attach to a process*, *Listen for Xdebug*).
- `install` is a recipe, as a server's: the IDE installs the adapter into the pack's folder of tools.
- **Not confined.** An adapter traces a process (ptrace), opens sockets and runs the user's program: the confinement of a pack's backend forbids all three. The **core** runs it, on the grant `debugger:<type>` (its program and folders shown as for a server), with the trust of a saved command run in a console: it is the user's program. An official pack gets the grant without asking, as for its servers.
- **SSH project**: the adapter runs on the host of the project through its runner, as the servers do.

Done in #188: the host (`plugins/debug`) and Go ([lang-go](https://github.com/antennae-space/lang-go) 1.2.0, `dlv dap`).

- **The manifest** (`pod/plugins/manifest.go`): `contributes.debuggers`, checked as a server is — a bare program, the grant `debugger:<type>`, `request` of `launch | attach | listen`, `{port}` in `argv` only for `tcp`, a recipe of `install` shared with the servers.
- **The core runs it** (`server/plugins_debuggers.go`): the program found in the pack's folder of tools then on the `PATH`, the pack's `env` and `pathDirs` applied, `sh -c '… exec "$0" "$@"'` (the user's own environment stays there: an adapter runs their program), the same through the runner on an SSH project. Not confined, never through `plugin-exec`.
- **The client** (`plugins/debug/internal/dap`): the framing, the sequences, the requests with their context, the events, and the reverse requests — `runInTerminal` opens a console of the Console tool. `stdio` pipes the adapter; `tcp` picks a free port, puts it in `{port}` and dials until the adapter answers.
- **The sessions** are a part of the runtime (`rt.Part("debug")`): one worktree, one set of sessions, stopped with the project, kept while it is open. A start is `initialize` → `launch` / `attach` → `initialized` → the breakpoints of the file → `configurationDone`.
- **The methods** `debug.*` and the **events** `debug.session`, `debug.stopped`, `debug.output`, `debug.breakpoint`, `debug.thread`: the threads, the frames, the scopes and the variables stay lazy (nothing crosses the relay but what a row opens); `debug.stopped` names the file and the line, read from the top frame when the adapter does not send them.
- Tested by the e2e suite `debug`: `dlv dap` starts a Go program, it stops on a line breakpoint with its condition, and the stack, the scopes and a local variable come back through the methods.

## Configurations

`.ide/debug.json`: `{"configurations": [{name, type, request: launch | attach | listen, ...}]}`. Past `name`, `type` and `request`, the fields are the adapter's own, passed through (the shape of VS Code's `launch.json`, so the documentation of each adapter applies): `program`, `args`, `cwd`, `env`, `port`, `pathMappings`… The variables `${workspaceFolder}` (the worktree of the session), `${file}` (the active file), `${env:NAME}` are replaced by the host.

- *Run › Debug…* and the Debug tool pick a configuration; an empty file offers the templates of the packs the project uses.
- A configuration is edited as text in a tab (the JSON schema of its adapter completes it), or from *Edit configurations…*.
- `.ide` is git-ignored: the configurations are not shared with the team. A versioned place, as PhpStorm's *Store as project file*, may come later.

## The Debug tool

A tool of the bottom zone, one tab per session (its configuration's name and its language icon, ✕ stops it).

- **Tool bar**: rerun, stop, resume (F9), pause, step over (F8), step into (F7), force step into (Alt+Shift+F7), step out (Shift+F8), run to cursor (Alt+F9), view breakpoints (Ctrl+Shift+F8), mute breakpoints. The PhpStorm keys by default, in the keymap.
- **Threads & Variables** (the first tab):
  - On the left, the thread picker (a dot for its state: running, paused) above the frames of the paused thread: `function, file:line`, the frames of the libraries dimmed and folded (*Hide library frames*). A click on a frame opens its file at its line and shows its variables.
  - On the right, the bar *Evaluate expression* (Enter evaluates, Ctrl+Shift+Enter adds a watch), the watches, then the variables of the frame by scope: one row per value, `name = {type} value`, an icon per kind (primitive, array, object, protected, special, from the `presentationHint` of the adapter), children loaded when a row opens (`variablesReference`: nothing more crosses the relay).
  - On a variable: *Set value* (F2), *Copy value*, *Copy name*, *Add to watches*, *View as…* (text or JSON, in a popup for a long value).
- **Console**: the output of the program and a REPL that evaluates in the selected frame, with completion when the adapter has it. A program the adapter starts in a terminal (`runInTerminal`) runs in a console of the Console tool instead, linked from the tab.

Done in #189 (`plugins/debug/web`, the page of the plugin):

- **The tool**: one tab per session (a dot for its state, the chip of the worktree as on the consoles, ✕ stops it), the run buttons in the corner of its zone (rerun, stop, resume, pause, step over, step into, force step into, step out), enabled by the state of the session; *Threads & Variables* and *Console*. The commands and their PhpStorm keys are in the keymap and in the **Run** menu of the menu bar (shown while the Debug plugin is on): *Debug…* (Shift+F9), *Edit configurations…*, resume (F9), pause, step over (F8), step into (F7), force step into (Alt+Shift+F7, a plain step into for the adapters that have no other), step out (Shift+F8), rerun (Ctrl+F5), stop (Ctrl+F2), toggle the breakpoint of the caret's line (Ctrl+F8). A key with no session to act on goes on to the others.
- **Threads & Variables**: the thread picker when there are several, the frames (`function`, `file:line`; a frame outside the worktree is a library frame, dimmed and folded under *N library frames*), the scopes of the selected frame with the first cheap one open, the rows `name = {type} value` with a mark per kind (primitive, object, array, method); children asked when a row opens, all dropped when the program runs again. *Copy value*, *Copy name* on a row.
- **Console**: the output of the session (the adapter's error output in red) and a line that evaluates in the selected frame (↑ ↓ for its history).
- **Run › Debug…**: the configurations of `.ide/debug.json`; an empty file offers the templates of the packs, the one chosen is written into the file (`debug.addConfiguration`, its name made unique) then started. *Edit configurations…* opens the file.
- **The pod**: a step or a continue puts the session in `running` from its request on (the stop that ends a step may come before its answer); `debug.setBreakpoints` sends `debug.breakpoints` to the other windows; a stop sends the push notification of the kind `debug`.

## In the editor

The file view is the Code plugin's: the debug host decorates it through a contribution of the plugin API (`editorDecorations`: gutter marks, line classes, widgets at the end of a line, hovers, items of the context menu), which the Debug plugin is the first to use. The contribution exists since #187 (fixture: the Hello plugin on `deco.txt`, suite `decorations`); the debug host uses it since #189 for the line breakpoints and the execution line.

- Done in #189: the lane shows in the files of a language an adapter of the packs debugs (`languages` of `contributes.debuggers`), or a file that already has breakpoints; a click toggles a line breakpoint, the gutter menu adds or removes it, Ctrl+F8 toggles the caret's line. A line moved by an edit is kept in the page and saved (sent to the live sessions) when the file is saved. A breakpoint the adapter could not set (a line with no statement, a file the program was not built from: a worktree's copy opened from the main folder) is crossed out, its reason in its title (`debug.verified`, sent with each `setBreakpoints` to an adapter, and the adapter's `breakpoint` events). The execution line has a blue arrow over its breakpoint and a blue row, drawn over the current line; the line of a frame selected below the top one is tinted ochre.

- **The gutter**: a click toggles a breakpoint; its context menu (or Ctrl+Shift+F8 on the line) edits its condition, its hit count, its log message, and enables or disables it. A disabled breakpoint is hollow, a muted one grey, one the adapter could not set crossed.
- The breakpoints follow the edits of the buffer (its line moves with the text) and are sent again when the file is saved.
- **The execution line** is highlighted, the line of the selected frame in another tint.
- **Inline values**: while paused, the values of the variables of the visible lines at the end of their line (from the scopes of the frame, matched to the identifiers of the line).
- **Hover**: a variable under the mouse is evaluated in a tooltip that opens as a tree.
- *Run to cursor* and *Add to watches* in the context menu.

## The breakpoints

- Kinds: line, conditional, hit count, logpoint, exception (the filters of the adapter: all, uncaught…), function (by name, where the adapter has it).
- **Breakpoints** (Ctrl+Shift+F8): a popup listing them by file, with their condition and a checkbox each, the exception breakpoints of the adapters on top.
- **Mute breakpoints**: the session runs without stopping on them, kept for the next sessions until the user unmutes.

## Focus on a stop

1. **The Debug tool opens on the first stop** of a session and takes the focus, even when it was closed; the editor shows the file and the line where the program stopped. At the end of the session the tool closes, unless the setting *Keep the Debug tool open at the end* is on. Both are settings of the plugin (*Settings › Plugins › Debug*: *Show the Debug tool on a stop*, on; *Keep the Debug tool open at the end*, off), as in PhpStorm.
2. **Focus of the application**: a page cannot raise its window, so when the window of the IDE is hidden (`document.hidden`) on a stop, the IDE sends a notification (*Stopped at `index.php:42`*, a click brings the tab back), marks the title and the icon of its tab, and the phone gets the notification through the relay as for an agent (the kind *A debug session stopped* of *Settings › Notifications*). The browser asks for the permission of the notifications at the first *Debug…*. Done in #189, apart from the mark on the icon of the tab (its title only).

## PHP and Xdebug

Xdebug connects to the IDE: the configuration is *listen*.

- **Listen for PHP debug connections**: a toggle of the tool bar (the phone of PhpStorm) opens the port (9003 by default) for the project.
- **Path mappings**: a program in a container sees `/var/www`, the IDE sees the project. The configuration holds them; the Docker plugin proposes those of the volumes of the Compose file.
- **An unknown connection** (a file no mapping covers) opens a dialog that names the path and asks for its folder in the project, then saves the mapping, as PhpStorm does.
- **The adapter**: first `vscode-php-debug` (Node), to try the host; then a DBGp to DAP bridge written in Go in the pack, with no Node.
- Trigger: the user starts Xdebug as usual (`XDEBUG_TRIGGER`, a browser extension); the guide shows how.

## The AI

Every plugin serves the human and the AIs alike ([plugins](plugins.md#the-ai-uses-the-plugins-too)):

- **Actions** of the Debug plugin, as assistant and MCP tools: `debug_start`, `debug_breakpoint`, `debug_step`, `debug_continue`, `debug_stack`, `debug_variables`, `debug_evaluate`, `debug_stop`.
- **One session per worktree**: an agent debugs in its own worktree; the user watches its session in the Debug tool, read only, and may take it over.
- **Ask the AI** on a frame: the stack, the variables of the frame and the line, sent to the thread of the assistant.

## On a phone

While paused, a compact view: the frames and the variables, with large step buttons, through the relay as the rest.

## Later

Python (`debugpy`), the browser (CDP), compound sessions (a front end and its back end together), *Set next statement*, hot code replacement, a versioned place for the configurations.

## Tickets

Milestone 16 *Debug*, #187 to #194: the plugin API to decorate the editor; the debug host and Go; the Debug tool and the line breakpoints; the advanced breakpoints and evaluation; JavaScript/TypeScript on Node; PHP with Xdebug; the AI; Python.
