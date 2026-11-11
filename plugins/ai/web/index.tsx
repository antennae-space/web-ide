// The AI plugin (pod/plugins/ai): the Assistant and Agents tools, the doodle editor
// an agent asks through the MCP, the interface tools of the assistant (a page of its board, a
// doodle), the root Conversations & Agents of the Explorer, and the assistant and agents services
// the Kanban plugin and the core use.
import type { PluginModule } from '@ide/types'
import { bindApi } from './plugin'
import { AssistantTool } from './llm/AssistantTool'
import { AgentsTool } from './agents/AgentsTool'
import { DoodleHost } from './llm/doodle/DoodleModal'
import { newDoodle } from './llm/Composer'
import { aiUiTools } from './llm/uiTools'
import { chat, config, loadConfig, refreshChats, resetChat, setChat } from './llm/state'
import { loadStates, navigateChats, openChat, send } from './llm/assistant'
import { conversationsRoot } from './explorer'
import { catalog, refreshAgents, setActive, watchAgents } from './agents/state'
import { ProjectAgentStats, TicketAgentStats } from './agents/stats'

export const ai: PluginModule = {
  activate(api) {
    bindApi(api)
    watchAgents()
    api.provide('assistant', {
      chat: () => chat,
      config: () => config,
      loadConfig,
      newChat: (o) => {
        resetChat()
        setChat(o as any)
      },
      send: (text) => send(text, [], []),
      openChat: (id) => openChat(id),
      navigate: (dir) => void navigateChats(dir),
    })
    api.provide('agents', { catalog, show: setActive, TicketStats: TicketAgentStats, ProjectStats: ProjectAgentStats })
    return {
      tools: { assistant: { component: AssistantTool }, agents: { component: AgentsTool } },
      hosts: [() => <DoodleHost external onSettings={() => api.settings.open()} />],
      commands: {
        'assistant.doodle': () => {
          api.showTool('assistant')
          newDoodle()
        },
      },
      uiTools: aiUiTools,
      explorerRoots: [conversationsRoot],
      opened: () => {
        void refreshAgents()
        // The root of the Explorer lists them while the Assistant is closed.
        void refreshChats()
        void loadStates()
      },
    }
  },
}
