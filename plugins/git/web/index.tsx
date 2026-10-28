// The Git plugin (pod/plugins/git): the Git tool, the git source of the diff view, and
// the git service (the state of the repository) the explorer, the project bar and the editor use.
import type { PluginModule } from '@ide/types'
import type { FileGitState } from '@ide/capabilities'
import { bindApi } from './plugin'
import { dirChanged, dirState, fileState, gitRevision, gitStatus, refreshGit, watchGit } from './state'
import { GitPanel, gitCorner, gitMenu } from './GitPanel'
import { gitDiff } from './diff'

/** Status letter of a Git state, shown at the end of a row (the index/worktree pair is #180). */
const badgeOf: Record<FileGitState, string> = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', conflict: 'C' }

export const git: PluginModule = {
  activate(api) {
    bindApi(api)
    watchGit()
    api.provide('git', {
      status: gitStatus,
      revision: gitRevision,
      refresh: refreshGit,
      fileState,
      dirState,
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
        // The state colors the name, its letter sits at the end of the row (#180 pairs it with the index).
        decorate: (path, dir) => {
          const s = dir ? dirState(path) : fileState(path)
          return s ? { state: s, badge: badgeOf[s] } : null
        },
      },
      opened: () => refreshGit(0),
    }
  },
}
