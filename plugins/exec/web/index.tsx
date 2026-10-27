// The Exec plugin (pod/plugins/exec): the Console tool, the saved commands, and the
// terminal and commands capabilities other parts of the IDE use.
import type { PluginModule } from '@ide/types'
import { bindApi } from './plugin'
import { ConsoleTool, consoleMenu, navigateConsoles, newConsole, openNewTab, refreshConsoles, runTask, setConsoleList, TermView, consoles, watchConsoles } from './consoles'
import { commands, loadCommands, show, watchCommands } from './commands'
import { CommandsHost, openCommands } from './CommandsModal'

export const exec: PluginModule = {
  activate(a) {
    bindApi(a)
    watchConsoles()
    watchCommands()
    a.provide('terminal', { consoles, open: newConsole, show, TermView, setList: setConsoleList, navigate: navigateConsoles })
    a.provide('commands', { list: commands, load: loadCommands, edit: openCommands })
    return {
      tools: { console: { component: ConsoleTool } },
      toolMenu: { console: consoleMenu },
      explorerItems: (e) => [{ label: a.t('Open a terminal here'), action: () => void newConsole({ cwd: e.folder }) }],
      hosts: [CommandsHost],
      commands: {
        // The new tab of the Console: the launcher, which converts into a console.
        'console.new': () => openNewTab(),
        // An ad hoc command, the same prompt as the launcher.
        'console.run': () => void runTask(),
      },
      opened: () => {
        void loadCommands()
        void refreshConsoles()
      },
    }
  },
}
