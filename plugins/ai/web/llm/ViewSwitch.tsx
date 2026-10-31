// The views of a conversation, floating at the top right of its zone: Chat, Board, Stats.
// Wide, Board and Stats open a column next to the conversation and Chat closes it; narrow,
// each takes the place of the others. The arrows move between them (ui/roving.ts of the core).
import { For, Show } from 'solid-js'
import { Icon, t } from '../plugin'

export type View = 'chat' | 'board' | 'stats'

export function ViewSwitch(props: {
  view: View
  onView: (v: View) => void
  /** Pages of the board, on its icon. */
  count: number
  /** A page drawn while the board is not shown: its icon pulses. */
  fresh?: boolean
  /** The thread scrolls: the switch fades, opaque again under the pointer. */
  faded?: boolean
}) {
  const views = (): { id: View; icon: string; label: string; testid: string }[] => [
    { id: 'chat', icon: 'comment', label: t('Conversation'), testid: 'ai-view-chat' },
    { id: 'board', icon: 'layout', label: t('Board of the conversation'), testid: 'ai-board-toggle' },
    { id: 'stats', icon: 'chart', label: t('Statistics'), testid: 'ai-stats-toggle' },
  ]
  return (
    <div class="ai-views" classList={{ faded: props.faded }} role="tablist" aria-label={t('Views of the conversation')} data-testid="ai-views">
      <For each={views()}>
        {(v) => (
          <button
            role="tab"
            aria-selected={props.view === v.id}
            classList={{ on: props.view === v.id, fresh: v.id === 'board' && props.fresh }}
            title={v.label}
            aria-label={v.label}
            onClick={() => props.onView(v.id)}
            data-testid={v.testid}
          >
            <Icon name={v.icon} size={15} />
            <Show when={v.id === 'board' && props.count}>
              <span class="ai-board-count">{props.count}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}
