// The Git plugin (pod/plugins/git): the Git tool, the git source of the diff view, and
// the git service (the state of the repository) the explorer, the project bar and the editor use.
import type { PluginModule } from '@ide/types'
import { bindApi } from './plugin'
import { dirBadge, dirChanged, dirState, fileBadge, fileState, gitRevision, gitStatus, refreshGit, watchGit } from './state'
import { GitPanel, gitCorner, gitMenu } from './GitPanel'
import { gitDiff } from './diff'

export const git: PluginModule = {
  activate(api) {
    bindApi(api)
    watchGit()
    api.provide('git', {
      status: gitStatus,
      revision: gitRevision,
      refresh: refreshGit,
      fileState,
      fileBadge,
      dirState,
      dirBadge,
      dirChanged,
      ignored: (paths) => api.rpc<string[]>('git.ignored', { paths }),
      branches: () => api.rpc('git.branches'),
      show: (path, rev) => api.rpc('git.show', { path, rev }),
    })
    return {
      tools: { git: { component: GitPanel } },
      toolMenu: { git: gitMenu },
      toolCorner: { git: gitCorner },
      diffSources: [gitDiff],
      fileDecorations: {
        ignored: (paths) => api.rpc<string[]>('git.ignored', { paths }),
        // The state colors the name, its letter sits at the end of the row: both come from the
        // two columns of git status, the worktree and the index (#180).
        decorate: (path, dir) => {
          const state = dir ? dirState(path) : fileState(path)
          if (!state) return null
          return { state, badge: (dir ? dirBadge(path) : fileBadge(path)) ?? undefined }
        },
      },
      opened: () => refreshGit(0),
    }
  },
}
