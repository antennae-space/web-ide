// The Files plugin, locked (pod/plugins/files): the Explorer and its roots, the Files tab of Search
// Everywhere, and the files service (reveal a file, create a file or a folder).
import type { PluginModule } from '@ide/types'
import { api as theApi, bindApi } from './plugin'
import { createIn, Explorer, explorerCorner, explorerMenu, revealInExplorer, watchFolders } from './Explorer'
import { projectRoot, scratchesRoot } from './roots'
import { filesProvider } from './search'
import { decorate } from './tints'

/** Where New file creates: the folder of the active file, else the root. */
function newEntryDir() {
  const path = theApi.activeFile() ?? ''
  return path && theApi.project.relPath(path) !== path ? path.slice(0, path.lastIndexOf('/')) : theApi.project.root()
}

export const files: PluginModule = {
  activate(api) {
    bindApi(api)
    watchFolders()
    api.provide('files', { reveal: revealInExplorer, createIn })
    api.keys.register('file.newFile', () => void createIn(newEntryDir(), false))
    api.keys.register('file.newFolder', () => void createIn(newEntryDir(), true))
    return {
      tools: { explorer: { component: Explorer } },
      toolMenu: { explorer: explorerMenu },
      toolCorner: { explorer: explorerCorner },
      searchProviders: [filesProvider],
      // The built-in rules of the Explorer rows (#182): tests, library roots, manifests, marks.
      fileDecorations: { decorate },
      // The project and Scratches and Consoles; the other roots come from their plugins.
      explorerRoots: [projectRoot, scratchesRoot],
    }
  },
}
