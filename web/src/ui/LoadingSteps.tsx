// The steps of the opening of a project (#211), the look of the bootstrap page of the relay: the
// done ones ticked, the current one spinning, and a line when it takes longer than usual. The
// modules of the plugins load after the IDE shows: the status bar counts them (StatusBar.tsx).
import { createSignal, For, onCleanup, Show } from 'solid-js'
import { t } from '../i18n'
import { podState } from '../pod/rpc'

const SLOW = 5000

export function LoadingSteps() {
  const steps = [t('Connecting to the pod'), t('Opening the project')]
  const at = () => (podState() === 'connected' ? 1 : 0)
  // The time the current step started, read every second for the slow line.
  const [since, setSince] = createSignal({ step: at(), at: performance.now() })
  const [now, setNow] = createSignal(performance.now())
  const tick = setInterval(() => {
    if (since().step !== at()) setSince({ step: at(), at: performance.now() })
    setNow(performance.now())
  }, 1000)
  onCleanup(() => clearInterval(tick))
  return (
    <div class="loading-steps" data-testid="loading-steps">
      <ol class="steps">
        <For each={steps}>
          {(label, i) => (
            <li classList={{ done: i() < at(), now: i() === at() }} data-step={i()}>
              <span class="dot" />
              {label}
            </li>
          )}
        </For>
      </ol>
      <Show when={since().step === at() && now() - since().at > SLOW}>
        <p class="muted" data-testid="loading-slow">
          {t('This step takes longer than usual.')}
        </p>
      </Show>
    </div>
  )
}
