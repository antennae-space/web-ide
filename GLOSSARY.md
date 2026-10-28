# Glossary

The words of Web IDE, one meaning each. Docs, code, UI texts and AI agents use them as defined here; *Avoid* lists the words not to use for the same thing. No implementation details: those live in the READMEs of the code and in [docs/design](docs/).

## Machines, network, identity

**Pod**
The Web IDE program on one machine: it serves the interface to the browser and does the work there (files, git, terminals, models).
_Avoid_: server, host, agent

**Keeper**
A second program next to the pod that holds the terminals and the model answers being written, so the pod restarts without losing them.
_Avoid_: daemon

**Unit**
A pod or keeper installed as a systemd user unit, started at boot.
_Avoid_: service

**Relay**
An optional server that introduces browsers and pods across networks; it carries only signaling, TURN and encrypted data. Hosted at antennae.space, or self-hosted.
_Avoid_: proxy, server

**Level**
What an account gives the project, which sets its TURN quota on the relay: free, Backer, Supporter or VIP, from its GitHub sponsorship and the VIP list. The best live one counts; they do not add up.
_Avoid_: tier (a tier is the price on GitHub Sponsors, a level is what the relay grants), plan, supporter (for the level itself)

**Backer**
The level of a $2 monthly sponsor: the TURN quota is raised (20 GB on the hosted relay).

**Supporter**
The level of a $5 monthly sponsor, or of $5 paid once (for 30 days): no TURN quota (fair use).
_Avoid_: sponsor (for the level: a sponsor is the person on GitHub, at any level)

**VIP**
The level of a $10 monthly sponsor and above, of $10 or $50 paid once (90 or 360 days), of a person on the VIP list, or of a member of a team within its seats: no TURN quota, and the VIP badge.

**Team**
The tier of a monthly sponsorship of $50 or more, by a person or an organization: the sponsor's team, whose admin adds members who become VIPs. The owner takes no seat.
_Avoid_: company, organization (an organization is one kind of owner)

**Seat**
A place in a team: one per $5 of the monthly sponsorship ($50 is 10 seats).

**VIP list**
The people the admin of a relay makes VIPs by hand (`web-ide-pod relay vip`), by GitHub login or by account id, with an optional end and a note only the admin sees.

**Tunnel**
The encrypted WebRTC connection between a browser and a pod, or between two pods, set up through the relay.
_Avoid_: relay link, channel

**Port forward**
A local port that reaches an address seen from the SSH host of a project.
_Avoid_: tunnel, SSH tunnel
The RPC methods and the event of the Port forwards tool are still `tunnels.*`, and `.ide/tunnels.json` is read when `forwards.json` is missing (older pages and projects).

**Service**
An HTTP service of a pod's machine (Ollama, a web UI) shared with the other pods of the account, which reach it on a port of their own machine.
_Avoid_: share, shared port

**Account**
The identity shared by a user's members: a key derived from a recovery phrase.
_Avoid_: user, login

**Recovery phrase**
The 24 words the account key comes from; shown once, never stored.
_Avoid_: seed, mnemonic, password

**Device**
A browser holding its own key, certified by the account.
_Avoid_: client, machine; a pod is not a device

**Member**
A device or a pod of the account.
_Avoid_: device (for a pod), peer, node
On the wire and in storage a member is still called a device (the relay's `devices` message and `device` fields, `device.key`, `identity.json`, the text `device revoked`), so that releases keep talking; each such name says so in a comment.

**Pairing**
Adding a browser or a pod to an account: the recovery phrase typed, or an invite approved by a device already in it.
_Avoid_: enrolment, join (as a noun)

**Access token**
The secret of the first link of a pod (`?token=`) that opens it in a browser, with no account.
_Avoid_: pairing token

**Revocation**
A signed list of the members the account no longer accepts, spread by the relay and from pod to pod.
_Avoid_: ban

**Cluster**
The pods of one account that see each other on the local network.
_Avoid_: site, LAN
On the wire and in storage the cluster is still called `site` (the relay protocol fields and the `site` message, the `/api/pods` field, the `webide.relay.site` key of the bootstrap), so that a relay and pods of different releases keep talking; each such field says so in a comment.

**Gateway**
The pod of a cluster the relay sends browsers to; the role moves when it leaves.
_Avoid_: master, leader

**Vault**
The secrets synced between the pods of the account (API keys, database passwords), off by default and encrypted.
_Avoid_: keychain

**Settings sync**
The pods of one account share their settings through the relay, which stores only ciphertext.

## Projects and the window

**Project**
A folder, local or on an SSH host, opened in the IDE, with its own kanban, conversations and project commands.
_Avoid_: repo, workspace

**Projects folder**
The folder where a pod makes new projects (`~/Apps` by default).
_Avoid_: workspace
The flag `-workspace` and the `workspace` key of `config.json` are still read, and so are the RPCs `workspace.get`, `workspace.set` and `workspace.dirs` (with the `workspace` field of the answer) that pods and pages of different releases call.

**Worktree**
A git worktree of a project, made for a ticket in development; it shares the kanban and the conversations of its project.
_Avoid_: branch, clone

**Desk**
One arrangement of a project's window: its layout mode, tabs, consoles and previews. A project has one or more.
_Avoid_: workspace, session
The pod stores the state of a desk in `desks/` (it was `sessions/`, read and moved on first use); on the wire it is still called `session` (`session.update`, `session.changed`), so that a page and a pod of different releases keep talking.

**Tool**
A part of the window shown from a rail icon: Explorer, Git, Kanban, Console…
_Avoid_: panel, view; for what a model calls, see *Tool call*

**Rail** / **Tool zone**
The icon bars on both sides of the window / the four corners where the tools show.
_Avoid_: sidebar

**Corner**
The group of buttons at the top right of a tool zone or of a tile: the buttons of the tool (`toolCorner`), then the **⋮** of its options menu. It has no close button of its own: *Close* in that menu, or the rail icon of the tool. The head of a tool leaves their room; a tool has no button of its own in its head.
_Avoid_: toolbar, header buttons

**Options menu**
The **⋮** of a tool's zone or of its tile (and the menu of a tab, and a right click on either): the core items (*Open in a tab*, *Open in a window*, *Close*), then the items of the tab, then the items the tool's plugin contributes (`toolMenu`).
_Avoid_: context menu, kebab menu

**Console**
A tab of the Console tool: a **terminal** (an interactive shell) or a **task** (one command running).

**Project command**
A command saved in a project (`serve`, `test`, `setup`…), run as a task.
_Avoid_: script, saved command

**Preview**
A web app of a project shown through the pod, openable on any device.

**Buffer**
The text of an open file, shared live by every window and AI.
_Avoid_: document

**Plugin** ([plugins](docs/design/plugins.md))
A part of the IDE enabled per project, declared by a manifest: tools, tab views, assistant tools, MCP tools, commands, and an optional backend in the pod.
_Avoid_: extension, add-on, module

**Built-in plugin**
A plugin that ships compiled into the IDE, with the same manifest and API as an external one.

**Contribution**
What a plugin adds at one contribution point of the IDE: a tool, a tab view, an assistant tool, a tool of the MCP only, a command, a settings section, items of a tool's *options menu*…

**Catalog**
The texts of one language, by English text: the core's (`web/src/i18n`, `lib/i18n`), or a plugin's (`plugins/<id>/i18n`, for its page and its pod side), looked in first by the plugin.
_Avoid_: dictionary, translation file

**External plugin** ([plugins](docs/design/plugins.md#phase-3-external-plugins))
A plugin installed from its own git repository, at a version of the plugin lock; confined: its views in a sandboxed iframe, its backend under Landlock.

**Plugin lock**
`~/.web-ide/plugins.lock`: the external plugins installed on a pod, each with its version, the hash of its asset and its grants. Per pod, not synced.

**Grant**
A permission of an external plugin accepted by the user (the project's files, a folder of the host, network, connections the pod opens for it, its entries of the vault, a core method…); without it the boundary refuses the call. A connection's destination is allowed apart, at its first use.
_Avoid_: permission (what the manifest asks)

**Confined backend**
The backend of an external plugin: a process of the pod started through `plugin-exec` under Landlock and seccomp, which reaches only its folder, the system, its data folder, the project and the network as granted, and speaks JSON-RPC over its stdio.
_Avoid_: sandboxed process, plugin server

**Sandboxed view**
A view of an external plugin, run in an iframe of opaque origin that speaks to the IDE only through the sandbox API.

**Locked plugin**
A built-in plugin the IDE cannot run without (Files, Code): always enabled, shown greyed in Settings → Plugins.

**Official plugin** ([plugins](docs/design/plugins.md#official-plugins))
An external plugin of the antennae-space organisation, installed by the pod from an archive embedded in its release, with its permissions granted, and used by every project unless disabled on it; confined like any external plugin. Removed by the user, it is not put back.
_Avoid_: core plugin, first-party plugin

**Language host** ([plugins](docs/design/plugins.md#language-packs))
The built-in plugin that runs the language servers of the language packs and shows what they give: Problems, Structure, symbols, completion. Today the Languages plugin.

**Language pack** ([plugins](docs/design/plugins.md#language-packs))
An external plugin that gives one language to the language host: its grammar, its language servers (run confined on this machine with the pack's grants: its program, the folders of the host it needs; on the host of an SSH project as its granted program), its test patterns, later its debug adapter and its project templates. A server it gives a recipe is installed by the IDE into the pack's *folder of tools* (`~/.local/share/web-ide/tools/<pack>`), looked up before the PATH.
_Avoid_: language plugin, language extension

**Glyph family** ([plugins](docs/design/plugins.md#language-packs))
The group a symbol kind belongs to, which gives its color: *type*, *function*, *variable*, *value*, *other*. `plugins/languages/web/kinds.json` is the one table of the kinds (name, glyph, family) the Structure tool, the Symbols tab, the file structure list and the assistant's `lsp_*` tools read; a theme colors each family (`--sym-type`…) and the detail of a symbol (`--sym-detail`).

**Exportable** / **Private member** ([plugins](docs/design/plugins.md#language-packs))
Whether a symbol is visible outside its file. `plugins/languages/web/visibility.json` is the one table of rules the Structure tool and the pod read: Go, an uppercase first letter (*Greeter* exported, *maxFrame* private); JavaScript and TypeScript, `export`, and `private`, `protected` or `#field` for the reverse; Python, a leading underscore for private; PHP, its modifiers. A language with no entry has no badge.
_Avoid_: public member (for *exported*), visible symbol

**Speed Search** ([plugins](docs/design/plugins.md#language-packs))
The inline filter of a tree (Structure today): typing in the focused tree, Ctrl+F or the magnifier opens a box, and only the symbols whose name fuzzy-matches the query stay, along with the parents that lead to them, the characters the query hits highlighted. Escape clears it and brings the folds back.
_Avoid_: filter box, quick open (for the file list)

**Opened element** ([plugins](docs/design/plugins.md#language-packs))
The innermost symbol containing the caret. *Always Select Opened Element* keeps its row selected in the Structure tree as the caret moves, unfolding its folded ancestors as needed.

**Package view** ([plugins](docs/design/plugins.md#language-packs))
The second view of the Structure tree, switched by *Show Package Structure*: the symbols of the *package* — the files of the folder of the active file served by the same language server, `app.php` apart from a Go package — each file as a foldable node with its symbols under it, at most 40 of them. A file not open in an editor is opened in the server for the request, then closed.
_Avoid_: package tree (the pod's Go packages), folder view

**Project template** ([plugins](docs/design/plugins.md#language-packs))
What a new project starts from, given by a language pack: files and a `.ide` filled in, or the commands of a framework that the core runs in a console the user sees.
_Avoid_: skeleton, boilerplate, scaffold

**Settings page** ([plugins](docs/design/plugins.md#settings-pages))
A view of a plugin drawn by the core as a page of Settings, with its entry in the side bar; for what simple values (`contributes.settings`) cannot hold, like the models of the assistant.

**AI access** ([plugins](docs/design/plugins.md#editor-tabs-settings-and-actions))
What the AI may do with a plugin's actions that change something, per target (a connection): read only (the default), ask the user, or allowed; set by the user in Settings → Plugins, never by the plugin.
_Avoid_: AI permission (a grant is the plugin's), AI policy (in UI texts)

**Plugin SDK**
The `plugin-sdk` repository: the types of the sandbox API, a UI kit using the theme tokens, and a Go module for the JSON-RPC of a confined backend.

**Diff source**
What gives the diff view the two sides of a diff tab (Git: the working tree, the index, HEAD, a commit).

**Search provider**
What gives Search Everywhere one kind of results (files, symbols, actions, text…) and its tab: the core or a plugin.

**Decoration** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
What the plugins say about a path shown in **any** tree of the window (Explorer, Recent Files, Commit tab, Search), merged channel by channel by the core: `state` (color of the name), `badge` (letter at the end of the row), `kind`, `tint` (family of the background of the row), `label` (text after the name). A folder passes `kind`, `tint` and `label` to its content.
_Avoid_: decorator, highlight (a search match is a highlight)

**File row** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
The shared row component (`web/src/ui/FileRow.tsx`, `api.ui.FileRow`) every tree draws its files with (#183): twist, icon, name colored by its state, label, error sign, status letter, then the slots of the tree. A tree keeps its own handlers and slots, none draws a name by hand.
_Avoid_: tree item, file item

**Kind** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
The category of a path in a tree: `test`, `library`, `manifest`, `ignored`, `marked`. A symbol kind is another thing (see *Glyph family*).
_Avoid_: category, type (for a path)

**Tint** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
The family of the background wash on the row of a tree, one per kind (`--tint-test`…). A tint never covers the background of a selected, active or hovered row.
_Avoid_: background color, highlight

**Row tint** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
The tint of a whole row of the Explorer, as PhpStorm tints a test file or a library root. Switched per family in the ⋮ of the Explorer (*Row tints*: tests, library roots, manifests, marked folders, ignored files), per desk.
_Avoid_: row color, stripe

**Library root** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
A folder taken as a root of dependencies or of build output, by name and at any depth (`node_modules`, `vendor`, `.git`, `dist`, `build`, `target`, `__pycache__`…). Its row is tinted `library` and carries the label *library root*; its content inherits both.
_Avoid_: dependency folder, excluded folder (a mark, another thing)

**Badge** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
The letter at the end of the row of a tree: a status letter, with the arrows of the Git columns (Git: `M↓` worktree, `M↑` index, `M↓↑` both, `A`, `D`, `U`, `C`). The glyph of a symbol kind and the language badge of a file icon are not badges.
_Avoid_: status letter (in code: `badge`)

**Error sign** ([plugins](docs/design/plugins.md#what-explorer-decorations-added-to-the-api))
The red `!` on the row of a file the language servers report in error, and on each folder above it (#181, #184), in the right column next to the status letter. It is not a decoration channel: the row keeps its Git color and takes a red wavy underline under its name.
_Avoid_: badge (the status letter), marker, dot

**Index column** / **Worktree column**
The two halves of a `git status` entry: what changed in the index (staged: `M↑`), what changed in the worktree (`M↓`). The Explorer colors and letters a file from both.
_Avoid_: status column (the kanban has one, with that name), staging area

**Capability**
A named feature a plugin or the core provides and others require (`terminal`, `worktrees`), with the service that does it: the consoles of `terminal`. An external plugin's is served to the other external plugins only, by its background frame and its backend (`ide.use`, `service.call`).
_Avoid_: service (an HTTP service shared between pods), dependency (a ticket waiting for another)

**Bridge** ([plugins](docs/design/plugins.md#bridges))
The core's code exposing a reviewed part of a capability a built-in provides (the consoles, the assistant, the agents) to the external plugins requiring it, on the grant `use:<capability>`.

**Background frame** ([plugins](docs/design/plugins.md#services-between-external-plugins))
The hidden frame of an external plugin: it runs its commands and serves the capabilities it provides to the frames of the other plugins.

**Part** ([plugins](docs/design/plugins.md#what-the-layout-added-to-the-api))
The per-project state a plugin keeps in the runtime of a project (its language servers, its database connections), made on first use and stopped with the project.
_Avoid_: extension, module

**Interface tool**
A tool of the MCP or of the assistant that a window of the IDE runs for the pod (`ui.call`): open a file or a diff, focus a panel, show a message; a plugin adds its own (the AI: a page of its board).

## AI

**AI**
Any model at work in a project: the assistant or an agent.

**Model server**
An endpoint that serves models: llama.cpp, Ollama, an OpenAI-compatible cloud.
_Avoid_: backend, provider

**Assistant**
The AI built into the IDE: it runs in the pod against a model server, in the Assistant tool.
_Avoid_: AI assistant, integrated assistant, local assistant, agent

**Tool kit**
What the tools of the assistant and those of the MCP share, kept in the core (`pod/assistant`): the definition of a tool, its arguments and result, the console tools, `ask_user`. The rest of the assistant (conversation, prompts, the tools of each mode) is the *engine* of the AI plugin.
_Avoid_: toolbox, SDK

**Agent**
A coding agent program (Claude Code, opencode, pi) the IDE runs through ACP, in the Agents tool.
_Avoid_: CLI agent, external agent; for the assistant

**Conversation**
A thread of the assistant: the messages, its tool calls and its mode.
_Avoid_: chat, session

**Session**
A run of an agent, from its start to its end, with its thread.
_Avoid_: conversation; for the state of a desk

**Thread** ([plugins](docs/design/plugins.md#threads))
The messages of a conversation or of a session, their parts (text, thinking, tool calls, attachments) and their usage, kept in one SQLite schema of the plugin SDK and shown by its thread kit; the capability `threads` lists, reads and answers them, whichever plugin holds them.
_Avoid_: chat, history

**Mode**
How the assistant works in a conversation: Orchestrator, Build, Plan, Briefing.
_Avoid_: persona

**Tool call**
A function an AI calls (read a file, run a command, an MCP tool of the IDE) and its result.
_Avoid_: tool

**Instructions**
The files a project gives every AI: `AGENTS.md` at the root and in its folders.
_Avoid_: memory, rules

**Skill**
A folder with a `SKILL.md`, loaded by an AI when its description matches the task.

**Sub-agent**
A child run the assistant starts for a side task, with its own context.
_Avoid_: worker

**Compaction**
Replacing the start of a long conversation with a summary to free context.

**Question**
Something an AI asks the user and waits for, gathered in the Questions tool.
_Avoid_: prompt

## Kanban

**Ticket**
A unit of work of a project's kanban, from its description to its merge. Its tile on the board is its **card**.
_Avoid_: issue, task

**Status**
Where a ticket stands: New → To do → In progress → To test (`to_test`) → Done, or Abandoned.
_Avoid_: column, stage

**Briefing**
Turning an idea into tickets: the assistant in Briefing mode questions the user and writes them.

**Plan**
How a ticket will be done, written before its development.
_Avoid_: spec

**Goal**
One checkable result a ticket must reach.
_Avoid_: criterion, acceptance

**Feedback**
A remark made while testing a ticket (info, bug, feature), checked once handled.
_Avoid_: comment, review

**Note**
A decision recorded on a ticket.
_Avoid_: comment, report

**Lineage**
A ticket, its **root**, and its **steps**, developed one after the other in the root's worktree and merged together.
_Avoid_: epic, chain, children

**Dependency**
A ticket of another lineage that must be merged before this one starts.
_Avoid_: blocker, prerequisite

**Complexity**
How hard a ticket's work is (low, medium, high); it picks the model and the effort of its conversations and sessions.
_Avoid_: difficulty

**Size**
How much work a ticket holds, S to XL.
_Avoid_: estimate

**Milestone**
The tickets of one feature, across lineages, with its spec, its user stories and its feedback; always validated by the user.
_Avoid_: epic, release, sprint

**User story**
What a user can do once a milestone is done; checked by the user, and the base of its e2e coverage review.

**Objective**
A named deadline (MVP, a launch…) in an ordered list: the tickets of several milestones and lone ones due together; reached by the user once they are finished. A milestone says what, an objective says when.
_Avoid_: release, target, goal, version

**Review**
A reading of a ticket's change by a model, before its merge.
_Avoid_: test, To test

## Planned

Terms of work not merged yet; each one moves to its section, or goes, when its ticket is merged.

**Referent** (#34)
The conversation a ticket's development asks when the plan does not answer: by default the one that wrote the plan.
_Avoid_: planner, supervisor

**Worktree holder** (#46)
The step of a lineage whose development currently uses the lineage's worktree.

**Agent desk** ([desks](docs/design/desks.md))
A desk bound to an agent's session or a development conversation and its worktree; the AI acts there only.

**Activity** ([desks](docs/design/desks.md))
The list of the desks of every project with what runs in them, and the way to end them.

## Conflicts

None open: every conflict found while writing this glossary was fixed (#96-#100). A naming problem found later goes here, then to a ticket.

