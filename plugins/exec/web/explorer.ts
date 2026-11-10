// The root Terminals and tasks of the Explorer (docs/design/explorer.md): every console of the
// project, whatever its desk and its worktree; a double click shows it in the Console tool.
import type { ExplorerNode, ExplorerRoot } from '@ide/types'
import { allConsoles, closeConsole, deskItems, renameConsole, type ConsoleInfo } from './consoles'
import { show } from './commands'
import { t } from './plugin'

/** The desk of a console from its desk key (`<project>@<n>`; none: desk 1). */
const deskOf = (c: ConsoleInfo) => Number(c.desk?.split('@')[1] ?? 1) || 1

function nodeOf(c: ConsoleInfo): ExplorerNode {
  return {
    id: c.id,
    label: c.title,
    icon: c.kind === 'task' ? 'play' : 'terminal',
    title: c.command?.join(' '),
    project: c.project,
    desk: deskOf(c),
    dimmed: c.exited,
    // A task that failed says its code; one that ended well is only dimmed.
    badge: c.exited && c.code ? t('code {code}', { code: c.code }) : undefined,
    open: () => show(c.id),
    menu: () => [{ label: t('Rename…'), action: () => void renameConsole(c) }, ...deskItems(c.id), { separator: true, label: '' }, { label: t('Close'), action: () => void closeConsole(c.id) }],
  }
}

export const terminalsRoot: ExplorerRoot = {
  id: 'terminals',
  label: () => t('Terminals and tasks'),
  icon: 'terminal',
  order: 40,
  nodes: () => allConsoles().map(nodeOf),
}
