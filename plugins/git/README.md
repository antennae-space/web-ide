# Git plugin

The Git tool and the git content of the diff view. It provides the `worktrees` and `git` capabilities. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `git`): The `git.*` methods; *Start development* of the kanban needs its `worktrees`. Git itself runs through `pod/git`.
- **Page** (`web/`, the chunk `plugin-git`): The tabs, tree of changes, graph lanes `graph.ts`, commit detail; the git state `state.ts`, which is the `git` service — it reads the two columns of `git status` apart (worktree, index) and answers the color and the status letter of a file or a folder; the git diff source `diff.tsx`; the `fileDecorations` of the trees (`state` + `badge`: the color of the name and its letter `M↓ M↑ A D U C`); `FileTree.tsx` draws the changed files with the shared file row of the window (`ui/FileRow.tsx`), so the Commit tab shows the same colors and letters as the Explorer.
- **E2e** (`e2e/`, run by `e2e/run.sh`): git.

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.

**Pitfall: git resolves the symlinks of a path, the pod does not.** `git rev-parse --show-toplevel` on a project reached through a symlink answers the resolved folder, which the Explorer never lists. `Repo.base` picks the spelling the pod uses (its project root when it *is* the top), and every path git answers with — `status`, `ignored`, the files of a commit — is built on it, so the Explorer colors its rows. `Repo.rel` accepts both spellings.
