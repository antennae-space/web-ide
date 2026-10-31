// The Stats view of a session of the Agents tool: the session, then the ticket of its
// worktree, then the project over a period (the turns recorded by the pod, acp/stats.go).
import { createResource, createSignal, For, Show } from 'solid-js'
import { Tile } from '../llm/Stats'
import { sessions } from './state'
import { agentStats, fmtCost, fmtWork, periods, since, useAgentsTick, type Totals } from './stats'
import { t } from '../plugin'

/** The ticket of a session: the one it develops, else the one of its worktree (`<project>-t<n>`, as acp/stats.go). */
export const ticketOf = (s?: { ticket?: number; project?: string }) => s?.ticket || Number(s?.project?.match(/-t(\d+)$/)?.[1] ?? 0)

function Tiles(props: { s: Totals; testid: string }) {
  const priced = () => props.s.turns - (props.s.unpriced ?? 0) > 0
  return (
    <div class="st-tiles" data-testid={props.testid}>
      <Tile label={t('Work')} value={fmtWork(props.s.work)} hint={t('The time of the turns, the waits for you excluded')} />
      <Tile label={t('Waiting for you')} value={fmtWork(props.s.wait)} />
      <Tile label={t('Turns')} value={String(props.s.turns)} />
      <Tile label={t('Tokens')} value={props.s.tokens.toLocaleString()} />
      <Show when={priced()}>
        <Tile
          label={props.s.apiEquivalent ? t('Cost (API equivalent)') : t('Cost')}
          value={fmtCost(props.s.cost)}
          hint={props.s.apiEquivalent ? t('The agent runs on a subscription: what these turns would cost through the API') : undefined}
        />
      </Show>
      <Show when={props.s.unpriced}>
        <Tile label={t('Turns without a price')} value={String(props.s.unpriced)} hint={t('A local or unknown model')} />
      </Show>
    </div>
  )
}

export function AgentStats(props: { id: string }) {
  const info = () => sessions().find((s) => s.id === props.id)
  const tid = () => ticketOf(info())
  const tick = useAgentsTick()
  const [period, setPeriod] = createSignal('week')
  const [ticket] = createResource(
    () => (tid() ? { id: tid(), n: tick() } : false),
    ({ id }) => agentStats({ ticket: id }).catch(() => null),
  )
  const [project] = createResource(
    () => ({ p: period(), n: tick() }),
    ({ p }) => agentStats({ since: since(p) }).catch(() => null),
  )
  return (
    <div class="st-view" data-testid="agent-stats-view">
      <div class="st-head">
        <strong>{info()?.title}</strong>
      </div>
      <Show when={info()?.stats?.turns} fallback={<p class="st-note">{t('No turn yet')}</p>}>
        <Tiles s={info()!.stats!} testid="agent-stats-session" />
      </Show>
      <Show when={ticket()?.turns}>
        <h4>{t('Ticket #{id}', { id: tid() })}</h4>
        <Tiles s={ticket()!} testid="agent-stats-ticket" />
      </Show>
      <h4>
        {t('Agents in this project')}{' '}
        <select class="small" value={period()} onChange={(e) => setPeriod(e.currentTarget.value)}>
          <For each={periods()}>{(p) => <option value={p.id}>{p.label}</option>}</For>
        </select>
      </h4>
      <Show when={project()?.turns} fallback={project.state === 'ready' && <p class="st-note">{t('nothing yet')}</p>}>
        <Tiles s={project()!} testid="agent-stats-project" />
      </Show>
    </div>
  )
}
