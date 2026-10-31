// Bar of a session of the Agents tool, on top of its message box, like the Assistant's
// (llm/TopBar.tsx): the work time and cost of the session, then on the right the ticket of
// its worktree and the role on it. The tooltip details them, with the total of the ticket
// (its other sessions included).
import { createResource, Show } from 'solid-js'
import { RoleBadge, roleFor, TicketButton } from '../llm/TopBar'
import { ticketOf } from './AgentStats'
import { sessions } from './state'
import { agentStats, fmtCost, fmtWork, statsTitle, useAgentsTick, type Totals } from './stats'
import { capability, Icon, t } from '../plugin'

const priced = (s: Totals) => s.turns - (s.unpriced ?? 0) > 0

export function AgentStatusBar(props: { id: string; onStats?: () => void }) {
  const info = () => sessions().find((s) => s.id === props.id)
  const stats = () => info()?.stats
  const tid = () => ticketOf(info())
  const tick = useAgentsTick()
  const [ticket] = createResource(
    () => (tid() ? { id: tid(), n: tick() } : false),
    ({ id }) => agentStats({ ticket: id }).catch(() => null),
  )
  const tip = () => {
    const lines = [stats()?.turns ? statsTitle(stats()!) : t('No turn yet')]
    const k = ticket()
    if (k?.turns) lines.push('', t('Ticket #{id}: {stats}', { id: tid(), stats: fmtWork(k.work) + (priced(k) ? ` · ${fmtCost(k.cost)}` : '') }))
    return lines.join('\n')
  }
  return (
    <div class="ai-topbar" data-testid="agent-topbar">
      <button class="ai-bar-item ai-bar-time" data-testid="agent-gentime" onClick={() => props.onStats?.()} title={tip()}>
        <Icon name="clock" size={13} />
        <span class="mono">{fmtWork(stats()?.work ?? 0)}</span>
        <Show when={stats() && priced(stats()!)}>
          <span class="mono" data-testid="agent-cost">
            · {fmtCost(stats()!.cost)}
          </span>
        </Show>
      </button>
      <span class="grow" />
      <Show when={tid() ? capability('tickets') : undefined}>
        {(k) => (
          <>
            <TicketButton tickets={k()} id={tid()} />
            <Show when={k().summary(tid())}>{(s) => <RoleBadge tickets={k()} role={roleFor(s().status)} />}</Show>
          </>
        )}
      </Show>
    </div>
  )
}
