// The Debug tool (docs/design/debug.md#the-debug-tool): one tab per session, then its two views,
// Threads & Variables and Console. Its run buttons are in the corner of its zone (toolCorner).
import { For, Show, type JSX } from 'solid-js'
import { EmptyState, Icon, t } from './plugin'
import { act, debug, setDebug, stateLabel, current, type Session } from './state'
import { ThreadsAndVariables } from './frames'
import { DebugConsole } from './console'
import { runDebug } from './run'

export function DebugTool() {
  const s = () => debug.sessions.find((x) => x.id === debug.selected)
  return (
    <div class="panel dbg" data-testid="debug-tool" tabindex="-1">
      <Show
        when={debug.sessions.length}
        fallback={<EmptyState icon="bug" testid="debug-empty" text={t('No debug session. Run › Debug… starts a configuration of .ide/debug.json.')} action={t('Debug…')} onAction={() => void runDebug()} />}
      >
        <div class="tabbar tool-tabbar" role="tablist">
          <For each={debug.sessions}>
            {(x) => (
              <div class="tab" role="tab" data-testid="debug-session-tab" aria-selected={x.id === debug.selected} classList={{ active: x.id === debug.selected }} title={stateLabel(x)} onClick={() => setDebug('selected', x.id)}>
                <span class={`dbg-state dbg-state-${x.state}`} />
                <span class="tab-title">{x.name}</span>
                <button class="tab-close" title={t('Stop')} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), setDebug('selected', x.id), void act('stop'))}>
                  <span class="x">✕</span>
                </button>
              </div>
            )}
          </For>
        </div>
        <Show when={s()}>
          {(cur) => (
            <>
              <div class="dbg-views" role="tablist">
                <button class="dbg-view" role="tab" data-testid="debug-tab-frames" aria-selected={debug.tab === 'frames'} classList={{ active: debug.tab === 'frames' }} onClick={() => setDebug('tab', 'frames')}>
                  {t('Threads & Variables')}
                </button>
                <button class="dbg-view" role="tab" data-testid="debug-tab-console" aria-selected={debug.tab === 'console'} classList={{ active: debug.tab === 'console' }} onClick={() => setDebug('tab', 'console')}>
                  {t('Console')}
                </button>
                <span class="dbg-status" data-testid="debug-status">{stateLabel(cur())}</span>
              </div>
              <div class="tool-body dbg-body">
                <Show when={debug.tab === 'console'} fallback={<ThreadsAndVariables session={cur()} />}>
                  <DebugConsole session={cur()} />
                </Show>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}

/** The run buttons, in the corner of the zone: enabled by the state of the current session. */
export function debugCorner(): JSX.Element[] {
  const s = (): Session | undefined => current()
  const paused = () => s()?.state === 'stopped'
  const running = () => s()?.state === 'running'
  const btn = (icon: string, title: string, testid: string, enabled: () => boolean, run: () => unknown) => (
    <button class="icon-btn" data-testid={testid} title={title} disabled={!enabled()} onClick={() => void run()}>
      <Icon name={icon} size={14} />
    </button>
  )
  return [
    btn('refresh', t('Rerun'), 'debug-rerun', () => !!s(), () => act('restart')),
    btn('stop', t('Stop'), 'debug-stop', () => !!s(), () => act('stop')),
    btn('resume', t('Resume program'), 'debug-resume', paused, () => act('continue')),
    btn('pause', t('Pause program'), 'debug-pause', running, () => act('pause')),
    btn('stepOver', t('Step over'), 'debug-step-over', paused, () => act('next')),
    btn('stepInto', t('Step into'), 'debug-step-into', paused, () => act('stepIn')),
    btn('forceStepInto', t('Force step into'), 'debug-force-step-into', paused, () => act('stepIn')),
    btn('stepOut', t('Step out'), 'debug-step-out', paused, () => act('stepOut')),
  ]
}
