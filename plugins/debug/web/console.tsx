// The Console of a session: the output of the program and of the adapter, and a line that
// evaluates an expression in the selected frame (↑ and ↓ walk its history).
import { createEffect, createSignal, For, on } from 'solid-js'
import { api, t } from './plugin'
import { evaluate, viewOf, type Session } from './state'

const history: string[] = []

export function DebugConsole(props: { session: Session }) {
  const [text, setText] = createSignal('')
  let at = history.length
  let out: HTMLDivElement | undefined
  const lines = () => viewOf(props.session.id)?.output ?? []
  // The latest output stays in sight.
  createEffect(on(() => lines().length, () => queueMicrotask(() => out && (out.scrollTop = out.scrollHeight))))
  const submit = () => {
    const expr = text().trim()
    if (!expr) return
    if (history[history.length - 1] !== expr) history.push(expr)
    at = history.length
    setText('')
    void evaluate(props.session.id, expr)
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'ArrowUp' && at > 0) {
      e.preventDefault()
      setText(history[--at] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      at = Math.min(history.length, at + 1)
      setText(history[at] ?? '')
    }
  }
  return (
    <div class="dbg-console">
      <div class="dbg-output" data-testid="debug-output" ref={out}>
        <For each={lines()}>{(l) => <span class={`dbg-out dbg-out-${l.category}`}>{api.ui.stripAnsi(l.text)}</span>}</For>
      </div>
      <input
        class="dbg-repl"
        data-testid="debug-repl"
        placeholder={props.session.state === 'stopped' ? t('Evaluate in the selected frame') : t('Pause the program to evaluate')}
        disabled={props.session.state !== 'stopped'}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={key}
      />
    </div>
  )
}
