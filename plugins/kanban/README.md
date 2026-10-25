# Kanban plugin

The Kanban tool, the board, ticket, milestone and objective views. It provides `tickets` and requires `terminal` and `worktrees`. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `kanban`): The `kanban.*` methods: tickets, milestones, objectives, the git workflow of a ticket and its agent session (through the `agents` capability of AI, `caps.Agents`: the session of a ticket, the times of its conversations, the sessions of a removed worktree; off, no development agent and no times). The services of the core come through `Pod().Services()`; `assistant_tools.go` runs the `kanban_*` tools of the assistant and the Orchestrator's `kanban_next` and `kanban_history` for the AI (`kanban.assistantTool`, the conversation in its context), and answers its other calls (`kanban.markdown`, `kanban.worktreeTicket`, `kanban.renameChat`); `notify.go` the push notification of a test feedback; `mcp.go` the ticket tools of the MCP (`Host.MCPTool`, listed in `mcpTools` of the manifest); `setup.go` the migration of the old setup setting into a saved command. The manager of the tickets is the plugin's (`K.Kanban`), made in `Register` and closed on `OnStop`. The store is the package `kanban` of `kanban/` (tickets, lineages, milestones, objectives, the git of a ticket), not `internal/` since AI uses its types.
- **Page** (`web/`, the chunk `plugin-kanban`): The views, whose number is their tab state; workflow actions, linked conversations, the New ticket host; its status bar items `status.ts`. It starts the conversations and agent sessions through the `assistant` and `agents` services of AI.
- **E2e** (`e2e/`, run by `e2e/run.sh`): kanban, kanbanagents, kanbanai, kanbangit, milestones.

The design is [kanban.md](../../docs/design/kanban.md).

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.

AI imports no code of the Kanban: it calls its methods (`Pod.CallPlugin`, #158); no package of `pod/` imports either, and Kanban imports no code of AI (`caps.Agents` only).
