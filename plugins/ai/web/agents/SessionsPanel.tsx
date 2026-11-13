// Sessions panel of the Agents tool: every session of the project, on this desk, on another one
// or in an attached worktree (docs/design/desks.md). Search, open one here, stop the selected
// ones after a confirmation (#270). A stopped session goes from the panel, the tabs and the
// Explorer: the pod emits agents.closed and state.ts drops it.
import { createMemo, createSignal, For, Show } from 'solid-js'
import { closeAgent, sessions, setActive, shown, stateLabel, type AgentInfo } from './state'
import { ticketOf } from './AgentStats'
import { errorToast, Icon, t, tn, WorktreeChip } from '../plugin'

/** Asks, then ends each session of the list, in order. Cancel changes nothing. */
export async function stopSessions(list: AgentInfo[]) {
  if (!list.length) return
  const n = list.length
  const titles = list.map((s) => `“${s.title || s.name}”`).join(', ')
  if (!confirm(`${tn(n, 'Stop the session?', 'Stop {n} sessions?')} ${titles}`)) return
  for (const s of list) {
    try {
      await closeAgent(s.id)
    } catch (e) {
      errorToast(e)
    }
  }
}

/** The ticket a row names itself: the chip of a worktree already shows the one of its project. */
const ticketShown = (s: AgentInfo) => (s.ticket && !/-t\d+$/.test(s.project ?? '') ? s.ticket : 0)

export function SessionsPanel(props: { onClose: () => void }) {
  const [q, setQ] = createSignal('')
  const [picked, setPicked] = createSignal<string[]>([])
  // The rows kept: title, agent name, ticket number or worktree chip.
  const rows = createMemo(() => {
    const all = sessions()
    const query = q().trim().toLowerCase()
    if (!query) return all
    // The words of a row: its title, its agent, its ticket (its own, or its worktree's).
    return all.filter((s) => [s.title, s.name, ticketOf(s) ? `#${ticketOf(s)}` : ''].some((x) => x.toLowerCase().includes(query)))
  })
  const chosen = () => picked().filter((id) => sessions().some((s) => s.id === id))
  const pick = (id: string, on: boolean) =>
    setPicked((l) => (on ? [...l, id] : l.filter((x) => x !== id)))
  const open = (id: string) => {
    setActive(id)
    props.onClose()
  }
  const stop = () => void stopSessions(sessions().filter((s) => chosen().includes(s.id)))

  return (
    <>
      <div class="agent-sessions-scrim" onClick={props.onClose} />
      <aside class="agent-sessions" data-testid="agent-sessions">
        <div class="agent-sessions-head">
          <span class="agent-sessions-name">{t('Sessions')}</span>
          <span class="agent-sessions-sub">{t('Sessions of the project')}</span>
          <span class="grow" />
          <button class="icon-btn small" title={t('Close')} onClick={props.onClose} data-testid="agent-sessions-close">
            <Icon name="close" size={13} />
          </button>
        </div>
        <div class="agent-sessions-search">
          <Icon name="search" size={13} />
          <input placeholder={t('Search')} value={q()} onInput={(e) => setQ(e.currentTarget.value)} data-testid="agent-sessions-search" />
        </div>
        <div class="agent-sessions-list">
          <Show
            when={rows().length}
            fallback={<p class="muted small agent-sessions-empty">{sessions().length ? t('No session matches.') : t('No session for this project.')}</p>}
          >
            <For each={rows()}>
              {(s) => (
                <div class="agent-session-row" classList={{ picked: chosen().includes(s.id) }} data-testid="agent-session-row" data-state={s.state}>
                  <input type="checkbox" checked={chosen().includes(s.id)} onChange={(e) => pick(s.id, e.currentTarget.checked)} data-testid="agent-session-pick" />
                  <button class="agent-session-open" onClick={() => open(s.id)} title={`${s.name} · ${stateLabel(s.state)}`}>
                    <span class={`agent-dot ${s.state}`} />
                    <span class="ellipsis">{s.title || s.name}</span>
                  </button>
                  <span class="agent-session-agent ellipsis">{s.name}</span>
                  <span class="agent-session-state muted small">{stateLabel(s.state)}</span>
                  <Show when={ticketShown(s)}>
                    <span class="agent-session-ticket">#{ticketShown(s)}</span>
                  </Show>
                  <WorktreeChip project={s.project} />
                  <Show when={shown().some((x) => x.id === s.id)}>
                    <span class="agent-session-here" title={t('open on this desk')}>
                      <Icon name="locate" size={12} />
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
        <div class="agent-sessions-foot">
          <span class="muted small">{chosen().length ? tn(chosen().length, '{n} session selected', '{n} sessions selected') : t('None selected')}</span>
          <span class="grow" />
          <button class="btn small danger" disabled={!chosen().length} onClick={stop} data-testid="agent-sessions-stop">
            {t('Stop')}
          </button>
        </div>
      </aside>
    </>
  )
}
