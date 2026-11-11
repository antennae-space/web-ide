// The root Conversations & Agents of the Explorer (docs/design/explorer.md): the active
// conversations of the assistant and the sessions of the Agents tool in one root; under each one,
// its sub-agents, then the files it changed (#242). A double click shows it in its tool.
import type { ExplorerNode, ExplorerRoot } from '@ide/types'
import { chatList, renameChat, type ChatInfo } from './llm/state'
import { openChat, runStates } from './llm/assistant'
import { closeAgent, sessions, setActive, type AgentInfo } from './agents/state'
import { api, errorToast, prompt, relPath, t } from './plugin'

/** A conversation counts as active this long after its last change. */
const RECENT = 24 * 3600 * 1000
/** The conversations of the assistant shown at most, the most recent first. */
const MAX_CHATS = 15

function fileNodes(files: string[] | undefined): ExplorerNode[] {
  return (files ?? []).map((p) => ({ id: 'f:' + p, label: p.slice(p.lastIndexOf('/') + 1), path: p, title: relPath(p) }))
}

function chatBadge(c: ChatInfo): string | undefined {
  const s = runStates()[c.id]
  if (s === 'waiting_user' || c.waiting) return t('waiting')
  if (s && s !== 'idle') return t('working')
  if (c.failed) return t('failed')
}

function chatNode(c: ChatInfo, all: ChatInfo[]): ExplorerNode {
  const subs = all.filter((x) => x.parent === c.id)
  return {
    id: 'chat:' + c.id,
    label: c.title || t('Conversation'),
    icon: c.parent ? 'branch' : 'comment',
    badge: chatBadge(c),
    children: subs.length || c.files?.length ? () => [...subs.map((x) => chatNode(x, all)), ...fileNodes(c.files)] : undefined,
    open: () => {
      api.showTool('assistant')
      openChat(c.id).catch(errorToast)
    },
    menu: () => [
      {
        label: t('Rename…'),
        action: async () => {
          const title = await prompt({ title: t('Rename the conversation'), value: c.title })
          if (title?.trim()) await renameChat(c.id, title.trim()).catch(errorToast)
        },
      },
    ],
  }
}

const agentBadges: Record<AgentInfo['state'], string | undefined> = { starting: 'starting', ready: undefined, busy: 'working', asking: 'waiting', error: 'error' }

function agentNode(s: AgentInfo): ExplorerNode {
  const badge = agentBadges[s.state]
  return {
    id: 'agent:' + s.id,
    label: s.title || s.name,
    icon: 'sparkle',
    title: s.name,
    project: s.project,
    badge: badge && t(badge),
    children: s.files?.length ? () => fileNodes(s.files) : undefined,
    open: () => {
      api.showTool('agents')
      setActive(s.id)
    },
    menu: () => [{ label: t('Stop the session'), danger: true, action: () => void closeAgent(s.id).catch(errorToast) }],
  }
}

/** The conversations of the assistant at the top (not sub-agents) still active: running, waiting, failed or recent. */
function activeChats(): ChatInfo[] {
  const now = Date.now()
  return chatList()
    .filter((c) => !c.parent && ((runStates()[c.id] ?? 'idle') !== 'idle' || c.waiting || c.failed || now - c.updated < RECENT))
    .slice(0, MAX_CHATS)
}

export const conversationsRoot: ExplorerRoot = {
  id: 'conversations',
  label: () => t('Conversations & Agents'),
  icon: 'sparkle',
  order: 10,
  nodes: () => {
    const all = chatList()
    return [...activeChats().map((c) => chatNode(c, all)), ...sessions().map(agentNode)]
  },
}
