// The corner of the Agents tool (docs/design/plugins.md, `toolCorner` #176): the **+** that opens
// an agent, or a session of another desk or of a worktree, and the items of its ⋮ menu. The state
// lives here rather than in AgentsTool, since the core draws the corner of the zone outside it.
import type { JSX } from 'solid-js'
import { createSignal } from 'solid-js'
import { catalog, createAgent, installAgent, others, setActive, stateLabel } from './state'
import { stopSessions } from './SessionsPanel'
import { copyText, contextMenu, errorToast, Icon, openHelp, t, toast } from '../plugin'
import type { MenuItem } from '../plugin'

/** Whether the sessions panel is shown; its drawer is drawn by AgentsTool. */
export const [sessionsPanel, setSessionsPanel] = createSignal(false)
/** The agent whose installation runs, if one does. */
export const [installingAgent, setInstallingAgent] = createSignal<string | null>(null)

export async function openAgent(agent: string) {
  try {
    await createAgent(agent)
  } catch (e) {
    errorToast(e)
  }
}

export async function installCatalogAgent(a: { id: string; name: string; package?: string; hint?: string }) {
  if (!a.package) {
    if (a.hint) void copyText(a.hint)
    return toast(t('{name} is installed by hand: {command} (copied)', { name: a.name, command: a.hint ?? '' }), 'info', undefined, 8000)
  }
  setInstallingAgent(a.id)
  try {
    await installAgent(a.id)
    toast(t('{name} is installed.', { name: a.name }))
    return true
  } catch (e) {
    errorToast(e)
  } finally {
    setInstallingAgent(null)
  }
}

/** The + menu: the agents to open or install, then the sessions of the project not open on this desk. */
export async function newSessionMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const at = { clientX: r.left, clientY: r.bottom + 2, preventDefault() {}, stopPropagation() {} } as MouseEvent
  try {
    const c = await catalog()
    if (!c.local) return toast(t('Agents run on local projects only, for now.'), 'warn')
    const items: MenuItem[] = c.agents.map((a) =>
      a.installed ? { label: a.name, hint: a.missing ? t('needs {command}', { command: a.missing }) : '', action: () => void openAgent(a.id) } : { label: t('Install {name}…', { name: a.name }), action: () => void installCatalogAgent(a) },
    )
    // The sessions of the project not open on this desk: one opens here, or is stopped.
    const rest = others()
    if (rest.length)
      items.push({
        separator: true,
        label: '',
      }, {
        label: t('Other sessions'),
        items: rest.flatMap((s) => [
          { label: t('Open “{title}”', { title: s.title }), hint: stateLabel(s.state), action: () => setActive(s.id) },
          { label: t('Stop “{title}”', { title: s.title }), danger: true, action: () => void stopSessions([s]) },
        ]),
      })
    contextMenu(at, items)
  } catch (err) {
    errorToast(err)
  }
}

/** The buttons of the corner of the zone or of the tile showing the Agents tool. */
export function AgentsCorner(): JSX.Element[] {
  return [
    <button class="icon-btn" title={t('New agent session')} onClick={(e) => void newSessionMenu(e)} data-testid="agent-new">
      <Icon name="plus" size={15} />
    </button>,
  ]
}

/** The items the Agents tool adds to the ⋮ menu of its zone or of its tab. */
export function agentsMenu(): MenuItem[] {
  return [{ label: t('Help: the Agents tool'), action: () => openHelp('agents') }]
}
