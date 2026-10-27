# Write a plugin

Write an external plugin in its own repository: views that run in the IDE, a backend if it needs one, published as tagged releases that the IDE installs, checks and confines.

An external plugin is untrusted by design ([plugins.md](../design/plugins.md#phase-3-external-plugins)): its views run in a sandboxed frame without network, its backend under Landlock and seccomp, and both reach the IDE only through what the user granted. Build it with the [plugin SDK](https://github.com/antennae-space/plugin-sdk): the types of the sandbox API, a UI kit in Solid with the look and the theme of the IDE, a Vite preset that builds the page module, and a Go module for the backend. Start from [plugin-template](https://github.com/antennae-space/plugin-template): *Use this template* on GitHub, then `./scripts/rename.sh <id> "<Name>" <owner>/<repo>` gives it your id, name and repository; it has a tool, a tab view, a command, an assistant tool and a tested backend, each small. [plugin-greet](https://github.com/antennae-space/plugin-greet) is the smallest example.

## The repository

```
plugin.json                    the manifest
web/src/index.tsx              the sources of the page module (with the SDK)
web/index.js                   the page module: one ES module, built (by the SDK's preset)
i18n/fr.json, i18n/es.json     its texts in the other languages (English is the key)
backend/…                      the sources of its backend (optional)
.github/workflows/release.yml  a tag v* publishes the release with its archives
```

A release carries one archive per architecture, `<id>-linux-amd64.tar.gz` and `<id>-linux-arm64.tar.gz`, holding at their root `plugin.json`, the `index.js` of `web/`, `i18n/` and the backend's executable (`bin/<name>`). No toolchain runs on the pod: build everything in the workflow. The SDK's `plugin.schema.json` is the JSON Schema of the manifest, for an editor to check it.

## The manifest

```json
{
  "id": "greet",
  "name": "Greet",
  "version": "1.0.0",
  "apiVersion": 1,
  "ide": ">=1.23.0 <2",
  "plugins": { "git": "^1" },
  "assets": "https://github.com/you/plugin-greet/releases/download/v{version}/greet-{arch}.tar.gz",
  "backend": "bin/greet",
  "permissions": ["files:read", "core:fs.list"],
  "contributes": {
    "tools": [{ "id": "greet", "label": "Greet", "icon": "sparkle", "zone": "right" }],
    "tabViews": [{ "id": "note", "label": "Greet note" }],
    "commands": [{ "id": "hello", "label": "Say hello from Greet" }],
    "assistantTools": ["greet_count"],
    "toolSchemas": { "greet_count": { "description": "Counts the files at the root of the project.", "properties": {} } }
  }
}
```

- `id`: lowercase letters, digits and dashes; not the id of a built-in plugin. Its methods are `<id>.*`, its events `<id>.*`.
- `version`: the version of the release; the tag is `v` + it, and the IDE checks they match.
- `apiVersion`: `1`.
- `ide`: the versions of the IDE it runs on, a constraint (`^1.24`, `~1.24`, `>=1.23 <2`, `||` between alternatives). A build of the IDE made of commits after a release (`v1.23.0-111-gf8e1f5e`) counts as the next minor release (1.24.0): it already has what that release will have. `plugins`: the plugins it needs, with a constraint each.
- `assets`: the address of its archives, `{version}` and `{arch}` (`linux-amd64`, `linux-arm64`) replaced; https only.
- `backend`: its executable in the archive, `bin/<name>`; none for a plugin made of views only.
- `permissions`: what it asks, each one granted by the user or not (see *Grants*).
- `contributes`: its tools (an icon of a rail: `left`, `bottomLeft`, `bottomRight`, `right`), tab views, commands, and its assistant tools, each described in `toolSchemas` (a description and the JSON Schema properties of its arguments; its backend runs them). `links: [{"param": "note", "view": "note", "type": "string"}]`: `/project/<id>?note=x` opens the view `note`, `x` the key of its tab and `{"note": "x"}` its state (`"type": "number"` for a number).
- `provides`, `requires`: the capabilities it serves to the other external plugins and those it uses (see *Services*); it is off on a project where nothing provides one it requires.

## The page module

The `index.js` of `web/` is one ES module, with what it needs bundled in (its own UI library if any). The IDE runs it in an `<iframe sandbox="allow-scripts">` of opaque origin whose CSP forbids the network: no `fetch`, no storage, no access to the IDE's page. It calls `ide.register`:

```js
ide.register({
  views: {
    greet: (el, ide) => { el.textContent = ide.t('Hello from Greet') },        // the tool "greet"
    note: (el, ide) => { el.textContent = JSON.stringify(ide.view.state) },  // the tab view "note"
  },
  commands: { hello: (ide) => ide.toast(ide.t('Hello!')) },
})
```

With the SDK, a view is a Solid component and the kit draws it as the IDE's own tools (`@antennae-space/plugin-sdk/solid` and `/ui`, its README lists them); the preset builds the sources of `web/src/` into the `index.js` of `web/`, the CSS and the assets inside:

```tsx
import { useIde, view } from '@antennae-space/plugin-sdk/solid'
import { Button, View } from '@antennae-space/plugin-sdk/ui'

function Greet() {
  const ide = useIde()
  return <View><Button onClick={() => ide.toast(ide.t('Hello!'))}>{ide.t('Say hello')}</Button></View>
}

ide.register({ views: { greet: view(Greet) } })
```

Each tool and tab view is a frame of its own, running the module and the view of its id; the commands run in a hidden frame, its background frame, which also serves the capabilities it provides. The sandbox API, `ide` (its types: `web/src/plugins/sandbox-api.ts` of the IDE, copied in the SDK):

| | |
|---|---|
| `ide.view` | `{id, state}`: the view of the frame and the state of its tab |
| `ide.rpc(method, params)` | a promise: its own `<id>.*` methods (its backend), or a method of the core with the grant `core:<method>` |
| `ide.on(event, f)` | the events of its namespace (`<id>.*`, sent by its backend) |
| `ide.openFile(path, line)`, `ide.openView(view, state, title)`, `ide.setViewState(state)` | open a file, a tab of one of its views, save the state of its tab |
| `ide.t(text, params)`, `ide.tn(n, one, other, params)`, `ide.lang` | its texts, from its `i18n/<lang>.json` |
| `ide.toast(text, kind)` | a message of the IDE (`info`, `warn`, `error`, `ok`) |
| `ide.confirm({title, text, ok, danger})`, `ide.prompt({title, label, value, password})`, `ide.pick({title, items})` | the dialogs of the IDE, centered in its window, titled with your plugin's name: a boolean, a text (null if cancelled), the index of the item chosen; only while the user is in your frame (a click, a key) |
| `ide.openModal(view, state, {title, size})`, `ide.closeModal(result)`, `ide.modal` | one of your views (`contributes.modals: [{"id", "label"}]`) in a modal of the IDE (`small`, `medium`, `large`), while the user is in your frame, one at a time; the view closes it with a result for the promise of its opener (null when the user closes it) |
| `ide.setStatus(items)`, `ide.onStatus(f)` | in a tab view: the items of the status bar while its tab is in focus (`{id, text, title, menu: [{id, label, checked}]}`), and the choices of their menus (`{item, choice}`) |
| `ide.setToolMenu(items)`, `ide.onToolMenu(f)` | the items your tool (or the tab your view shows) adds after the core items of its **⋮ menu** (`{id, label, hint, title, checked, disabled, separator}`), and the item the user chose (`{item}`). Push them once, and again whenever they change; a frame that pushes none adds nothing |
| `ide.markdown(text)`, `ide.openLink(url)`, `ide.help(topic)` | the HTML of a Markdown text as the IDE renders it (sanitized), an http(s) address in a new tab (while the user is in the frame), a page of the IDE's documentation |
| `ide.theme`, `ide.onTheme(f)` | the colors and fonts of the IDE, also set as CSS variables (`var(--bg)`, `var(--fg)`…, the list is `themeTokens` of the SDK), its `color-scheme`, and `--ide-head-inset`: the room the IDE's buttons take over the frame's top right corner, to leave in the first row of a view (the kit's toolbar does) |

The keys pressed in the frame with a modifier, Escape and F1-F12 reach the IDE's shortcuts.

## Services

A plugin serves a capability to the other external plugins: name it in `provides`, register its methods, and publish what its users show:

```js
ide.register({
  services: { greeting: { hello: (name) => { ide.emit('greeting', 'said', name); return 'Hello ' + name } } },
})
ide.publish('greeting', 'count', 1) // a value its users read and follow
```

Another plugin, with `"requires": ["greeting"]`, uses it from any of its frames: `const g = ide.use('greeting')`, `await g.call('hello', 'Ada')`, `g.value('count')`, `g.onValue('count', f)`, `g.on('said', f)`; `ide.openModal('pick', state, {plugin: 'alpha'})` opens a modal view of the plugin providing it, titled with that plugin's name. Its backend calls the provider's backend with the core calls `service.call {capability, method, params}` (a method `<provider>.*`, which the provider's backend gets as a `call` with `from`, the caller's id) and `service.on {capability}` (the events the provider's backend emits come as the notification `event {event, data}`). A built-in's capability is reached through `core:<method>` grants, or through its **bridge**, a reviewed part the IDE offers on the grant `use:<capability>`: `ide.use('terminal')` (`open({cwd, command, title})`, `show(id)`), `ide.use('assistant')` (`newChat({mode, title, ticket})`, `send(text)`, `openChat(id)`, the values `chat` and `config`), `ide.use('agents')` (`show(session)`, `catalog()`); from the backend, `service.call` on `agents` (`agents.develop`, `agents.ticketSession`, `agents.purge`, `agents.chatTimes`). `ide.showWorktree(project)` shows a worktree of the project in the window.

## Editor tabs, settings, actions

- **A tab with the IDE's editor**: give a tab view `"editor": {"lang": "sql", "size": 40, "keys": {"Ctrl+Enter": "run"}}`. The IDE's editor (highlighting, completion, find) sits above your frame and keeps its text with the tab; your view drives it with `ide.editor` (`text()`, `selection()`, `setText`, `insert`, `mark([from, to])`, `focus`, `setWords([...])`, `onChange`, `onSelection`, `onKey("run", f)`).
- **Settings**: `"contributes": {"settings": {"properties": {"rows": {"type": "number", "title": "Rows shown", "default": 100}}}}`. The IDE shows them under your plugin in Settings → Plugins and syncs them; read them with `ide.settings` (and `ide.onSettings`) in your views, the core call `settings.get` in your backend.
- **Actions**: `"actions": [{"id": "query", "label": "Run a query", "description": "…", "properties": {…}, "required": […], "access": "write", "target": "conn"}]`. Your backend answers the method `<id>.query`; your views call it, and the AI gets the tool `<id>_query` from the same declaration. Mark what changes something `write` and name its `target` (a connection): the user decides per target whether the AI may do it (read only by default, ask, allowed), in Settings → Plugins. Declare the targets from your backend with the core call `ai.targets {targets: [{id, label}]}` so the user can choose.

## A language pack

A plugin that gives the IDE a language, like [lang-go](https://github.com/antennae-space/lang-go): no view, no backend, its manifest's `contributes.languages` and a grammar file.

- `languages: [{"id", "name", "extensions", "markers", "grammar": "grammars/<id>.json", "servers": [...], "tests": {".go": "{name}_test.go"}}]`. The grammar is a grammar of the editor as JSON (export one from Settings → Syntax).
- A server: `"argv": ["gopls"]`, its program a bare name found on the PATH of the machine (the grant `program:gopls`); `"paths"`: the folders of the machine it needs, each a name and candidates (`$GOMODCACHE`, `$GOPATH/pkg/mod`, `~/go/pkg/mod`, `@go/../..`: the folder of a program on the PATH), the first that exists, read only unless `"access": "write"`, a variable of its name with `"env": true` (the grant `path:GOMODCACHE`); `"pathDirs"` add some to its PATH; `"env"` literal variables.
- The IDE runs the server confined on this machine: its program, its folders, the project read only, its data folder as `HOME` (its caches), no network unless you ask `net`; on the host of an SSH project, its program by name.
- `"install": {"manager": "npm", "packages": ["typescript-language-server", "typescript@5"]}` (or `pip`, or `go` with one `module@version`): how the IDE installs the server when it is missing, into the pack's folder of tools (`~/.local/share/web-ide/tools/<pack>`), looked up before the PATH; a banner offers it over the editor, and *Settings → Plugins*.
- A server that is a script needs its interpreter and its package, not only its file: name them as folders, from the real path of the program. A node server ([lang-typescript](https://github.com/antennae-space/lang-typescript), [lang-php](https://github.com/antennae-space/lang-php)): `NODE` = `@node/../..` (the prefix of the node on the PATH, nvm included) with `"pathDirs": ["NODE/bin"]` for `#!/usr/bin/env node`, and its package, `@intelephense/../..` (or `@typescript-language-server/../../..`, the global `node_modules`, for its sibling `typescript`). A Python one ([lang-python](https://github.com/antennae-space/lang-python)): its venv, `@pylsp/../..`. A candidate refused (one holding the home) leaves the next one a chance.

## The backend

In Go, the SDK's `antennae.space/plugin-sdk/backend` speaks all of what follows: `backend.Serve` with its methods and tools, `backend.Core` and `backend.Emit` (its README shows one). In another language, implement it.

The IDE starts it on the first call of a project, through `web-ide-pod plugin-exec`, and stops it a while after the last window of the project leaves. It speaks JSON-RPC 2.0 over its stdin and stdout, one message per line (8 MB at most); its stderr goes to `~/.web-ide/plugin-data/<id>/backend.log`.

| From the IDE | |
|---|---|
| `initialize {apiVersion, plugin, version, grants, project: {id, root, local}}` | answer `{}` |
| `call {method, params, lang, from?}` | an `<id>.*` method of one of its views, or of another plugin's backend using a capability it provides (`from`: that plugin's id): answer its result |
| `event {event, data}` (no id) | an event of the backend of a capability it listens to (`service.on`) |
| `mcp {name, args, lang, scope: {project, main, ticket, url}}` | one of its MCP tools (`contributes.mcpTools`, described in `toolSchemas`): `project` of the client's folder, `main` its main project, `ticket` that of its worktree (0 elsewhere), `url` the address of the IDE; answer `{content, error}` |
| `questions.list {}`, `questions.answer {id, option, action, content}` | with `contributes.questions: true`: its questions waiting for the user (`[{id, kind: "permission" or "form", title, text, options: [{optionId, name, kind}], schema, time}]`), and the answer of one |
| `project.open {}` (no id) | with `contributes.hooks: ["project.open"]`: a window opened the project (the backend started for it) |
| `tool {name, args, lang}` | one of its assistant tools: answer `{content, summary, error}` |
| `shutdown` | answer, then exit |

| To the IDE | |
|---|---|
| `core {method, params}` (with an id) | a method of the core in the project, `fs.list` say: refused without `core:<method>` |
| `core {method: "dial", params: {host, port, ssh?}}` | a connection the pod opens for it (grant `dial`, and `ssh` through a tunnel): answers `{fd: n}`, the socket comes on fd 3 (SCM_RIGHTS, the message's text `n`); the user allows each new destination |
| `core {method: "vault.get" / "vault.set" / "vault.delete", params: {key, value?}}` | its own entries of the vault (grant `vault`): `vault.get` answers `{value, found}` |
| `core {method: "socket", params: {name: "docker"}}` | the Docker socket, opened by the pod (grant `socket:docker`), the host's on an SSH project: answers `{fd: n}`, as `dial` |
| `core {method: "exec", params: {argv, dir?}}` | a program on the host of an SSH project (grant `exec:<name>`: `exec:sqlite3`), run in the project, not confined there: answers `{output}`; refused on a local project (run it yourself) |
| `core {method: "terminal.open", params: {title}}` | a console of the IDE you feed (grant `terminal`): answers `{console, fd: n}`; write its output on the socket, read what is typed; the notification `terminal.resize {console, cols, rows}` (no id, no answer) tells its size; `ide.showConsole(console)` in a view shows it |
| `core {method: "service.call", params: {capability, method, params}}` | a method of the backend providing a capability it requires: answers its result |
| `core {method: "service.on", params: {capability}}` | its events come as `event` notifications: answers `{provider}` |
| `core {method: "questions.changed", params: {asked?}}` | its questions changed: the windows ask again; `asked: true` notifies the devices |
| `core {method: "notify", params: {kind, query?, tag?, urgency?, texts: {en: {title, body}, fr: …}}}` | a push notification (grant `notify`), of a kind the devices choose (`feedback`, `asks`, `finished`, `tests`), opening the project at `?<query>` |
| `core {method: "commands.list"}` (and `commands.save`, `commands.run`) | the saved commands of the project, with `core:commands.list`… |
| `core {method: "git", params: {args, dir?}}` | git in the project or one of its `.ide/worktrees/*` (grant `git`), with the user's keys: answers `{output}`; an option that would run another program (`-c core.pager=…`, `--upload-pack`…) is refused |
| `core {method: "gh", params: {args}}` | `gh pr …` (grant `gh`) |
| `core {method: "worktree.register" / "worktree.unregister" / "worktree.setup" / "ide.keepOut"}` | the worktree projects (grant `worktrees`): register a folder of `.ide/worktrees` as the project of a ticket (`{owner, title, path}`), remove it (`{owner}`), run the setup commands of the project in it (`{path}`), keep `.ide` out of git |
| `emit {event, data}` (no id) | an event to the windows of the project, `<id>.*` only, and to the backends listening to it |

A call waits two minutes at most; a backend that ends three times in a minute stays off until the project opens again. It runs confined: it reads its own folder and the system, writes its data folder (its `HOME` and `TMPDIR`), reads the project with `files:read`, writes it with `files:write`, reaches the network with `net` only; never the home, nor `~/.web-ide`, nor the other processes. A project over SSH is not on the pod: reach its files with `core` calls. Build it static (`CGO_ENABLED=0` for Go): it starts with the system's libraries only. A kernel without Landlock does not run it.

## Grants

The user grants each permission at the install, again for a new one asked by an update, and revokes them in *Settings → Plugins*, effective at once:

- `files:read`, `files:write`: its backend reads, or reads and writes, the project's files;
- `net`: its backend reaches the network (TCP, UDP), anywhere;
- `dial`: the pod opens connections for it, each new destination allowed by the user (prefer it to `net`); `ssh`: through SSH tunnels with the user's agent and keys;
- `vault`: it keeps secrets (passwords, tokens) in the vault, synced with the user's other pods;
- `exec:<name>`: the pod runs that program for it on the host of an SSH project (not confined there);
- `socket:docker`: the Docker socket, opened by the pod; whoever holds it is as much as root on the machine, and the user is told so;
- `terminal`: consoles of the IDE it feeds;
- `notify`: push notifications to the user's devices;
- `use:terminal`, `use:assistant`, `use:agents`: the bridges of the IDE's consoles (a command run as the user), assistant and agents;
- `git`, `gh`, `worktrees`: git and gh in the project with the user's keys (its hooks run: as much as the user), the worktree projects and their setup;
- `exec`: running programs (reserved);
- `core:<method>`: its views and its backend call that method of the core (`core:fs.list`, `core:fs.read`…); the files permissions do not open them.

Ask for the least, and handle a refusal: a view or a backend without a grant gets an error, `<method> is not granted to <name>`.

## Versions and releases

1. Change `version` in `plugin.json`, commit, tag `v<version>`, push the tag: the workflow builds the archives and publishes the release.
2. Never move a tag once released. The IDE keeps the sha256 of the archive it installed (`~/.web-ide/plugins.lock`) and refuses another one under the same version: release a new version instead.
3. A pre-release (`v1.1.0-rc1`) is installed only by a constraint naming it (`=1.1.0-rc1`): use it to try a version before releasing it.

The IDE resolves like Composer: it lists the tags of the repository, takes the highest matching the user's constraint whose `plugin.json` fits the IDE (`ide`), the API and the installed plugins (`plugins`), and says why when none does.

## Install it

*Settings → Plugins → Install a plugin*: the address of the repository (https, ssh, or a folder of the machine) and a version constraint (empty: the latest). It is installed on this pod and used at once by the open project; another project uses it once its box is ticked.
