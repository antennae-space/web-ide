// Message box of an agent session: the shared frame of the assistant (ComposerShell: the editor
// with @paths, files, images, doodles and dictation) with the /commands the agent announces and
// its settings in the bar. A prompt sent during a turn is queued by the pod. The draft is kept
// per session (drafts.ts), after a reload too.
import { createSignal, For, Show, type JSX } from 'solid-js'
import { aliasItems } from '../llm/aliases'
import type { CompletionItem } from '../llm/MessageBox'
import type { Prepared } from '../llm/attachments'
import type { Picture } from '../llm/doodle/background'
import { ComposerShell } from '../llm/ComposerShell'
import { newDoodleFor, type DoodleTarget } from '../llm/drafts'
import { formatTokens, Popover } from '../llm/parts'
import type { Caps } from '../llm/state'
import { cancelAgent, configAgent, followAgent, promptAgent, sessions, threads, unqueueAgent, type AgentPart, type ConfigOption } from './state'
import { errorToast, Icon, t } from '../plugin'

/** The message box over the whole session (the thread hidden), as in the assistant. */
export const [agentFull, setAgentFull] = createSignal(false)

/** What the agent reads, in the terms of the attachments of the assistant. */
const capsOf = (id: string): Caps => ({ vision: !!sessions().find((s) => s.id === id)?.caps?.image, video: false, audio: false, tools: true, thinking: false, known: true })

/** The draft and the doodles of a session: drawn in the host of the project window (the assistant may be closed). */
export const targetOf = (id: string): DoodleTarget => ({ key: 'agents.draft.' + id, caps: () => capsOf(id), external: true })

/** The parts of the prepared attachments, as the pod takes them. */
function partsOf(list: Prepared[]): AgentPart[] {
  const out: AgentPart[] = []
  for (const p of list)
    for (const x of p.parts) {
      if (x.type === 'image_url') {
        const m = /^data:([^;]+);base64,(.*)$/.exec(x.image_url.url)
        if (m) out.push({ kind: 'image', name: p.attachment.name, mime: m[1], data: m[2] })
      } else if (x.type === 'text') out.push({ kind: 'text', name: p.attachment.name, text: x.text })
    }
  return out
}

/** Opens a new doodle for a session, on a picture (a page of its board, a screenshot) or blank. */
export function doodleFor(id: string, background?: Picture) {
  newDoodleFor(targetOf(id), background)
}

export function AgentComposer(props: { id: string; onSent?: () => void; head?: JSX.Element }) {
  const info = () => sessions().find((s) => s.id === props.id)
  const busy = () => info()?.state === 'busy' || info()?.state === 'asking'

  // The commands the agent announces (its own commands and skills), then the aliases.
  const agentItems = (): CompletionItem[] => (info()?.commands ?? []).map((c) => ({ kind: 'command', label: `/${c.name}`, detail: c.input?.hint ? `${c.description} · ${c.input.hint}` : c.description, insert: `/${c.name} ` }))
  const slashItems = (): CompletionItem[] => [...agentItems(), ...aliasItems(agentItems())]
  const history = () => (threads[props.id]?.entries ?? []).filter((e) => e.kind === 'user').map((e) => e.text ?? '')

  const submit = async (text: string, atts: Prepared[], clear: () => void) => {
    props.onSent?.()
    try {
      await promptAgent(props.id, text, partsOf(atts))
      clear()
    } catch (e) {
      errorToast(e)
    }
  }
  /** Shift+Tab: the next mode of the agent. */
  const onKey = (e: KeyboardEvent): boolean => {
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && modeOption()) {
      const o = modeOption()!
      const list = flatOptions(o)
      const next = list[(list.findIndex((x) => x.value === o.currentValue) + 1) % list.length]
      if (next) void configAgent(props.id, o.id, next.value).catch(errorToast)
      return true
    }
    return false
  }
  const config = () => (info()?.config ?? []).filter((c) => c.type === 'select' && flatOptions(c).length > 1)
  const modeOption = () => config().find((c) => c.category === 'mode')
  const modelOption = () => config().find((c) => c.category === 'model')
  const otherOptions = () => config().filter((c) => c !== modeOption() && c !== modelOption())

  return (
    <ComposerShell
      target={targetOf(props.id)}
      class={`agent-composer mode-${modeTone(modeOption()?.currentValue)}`}
      classList={{ busy: busy() }}
      testid="agent-composer"
      ids={{ queue: 'agent-queue', atts: 'agent-atts', input: 'agent-input', full: 'agent-full', attach: 'agent-attach', enqueue: 'agent-enqueue', send: 'agent-send', stop: 'agent-stop' }}
      head={props.head}
      barStart={<Show when={modeOption()}>{(o) => <ModePill id={props.id} option={o()} />}</Show>}
      barTools={
        <>
          <button
            class="ai-icon"
            classList={{ on: !!info()?.follow }}
            aria-pressed={!!info()?.follow}
            title={info()?.follow ? t('Following the edits: each file the agent edits opens in the editor (click to stop)') : t('Follow the edits: open each file the agent edits')}
            data-testid="agent-follow"
            onClick={() => void followAgent(props.id, !info()?.follow).catch(errorToast)}
          >
            <Icon name="eye" size={16} />
          </button>
          <Show when={otherOptions().length}>
            <AgentOptions id={props.id} options={otherOptions()} />
          </Show>
        </>
      }
      barEnd={
        <>
          <Show when={info()?.usage}>{(u) => <ContextPop id={props.id} used={u().used} size={u().size} />}</Show>
          <Show when={modelOption()}>{(o) => <ModelPill id={props.id} option={o()} />}</Show>
        </>
      }
      busy={busy}
      queue={() => info()?.queue ?? []}
      queueTitle={() => t('Queued: sent at the end of the turn')}
      queueHint={() => t('Queue: sent at the end of the turn')}
      unqueue={(i, edit) => unqueueAgent(props.id, i).then((r) => (edit ? r.text : undefined))}
      stop={() => void cancelAgent(props.id).catch(errorToast)}
      submit={submit}
      canSend={() => info()?.state !== 'error'}
      slashItems={slashItems}
      placeholder={() => (busy() ? t('Queued message…') : t('Ask the agent…'))}
      history={history}
      onKey={onKey}
      full={agentFull}
      setFull={setAgentFull}
      autofocus
    />
  )
}

type Choice = { value: string; name: string; description?: string }
const flatOptions = (o: ConfigOption): Choice[] => (o.options ?? []).flatMap((x: any) => (x.options ? x.options : [x]))
const nameOf = (o: ConfigOption) => flatOptions(o).find((x) => x.value === o.currentValue)?.name ?? o.currentValue

/** The tone of a mode, for its color: plan, automatic (edits accepted), bypass or manual. */
function modeTone(value = ''): 'plan' | 'auto' | 'bypass' | 'manual' {
  const v = value.toLowerCase()
  if (v.includes('plan')) return 'plan'
  if (/bypass|yolo|dontask|full/.test(v)) return 'bypass'
  if (/accept|auto/.test(v)) return 'auto'
  return 'manual'
}
const toneIcons = { plan: 'outline', auto: 'check', bypass: 'warning', manual: 'edit' } as const

/** The choices of an option in a popover, the current one checked. */
function ChoiceList(props: { id: string; option: ConfigOption; close: () => void }) {
  return (
    <div class="ai-model-list" role="listbox" data-testid={`agent-config-${props.option.id}-list`}>
      <For each={flatOptions(props.option)}>
        {(c) => (
          <button
            class="ai-model-item"
            classList={{ active: c.value === props.option.currentValue }}
            role="option"
            aria-selected={c.value === props.option.currentValue}
            data-value={c.value}
            onClick={() => (props.close(), void configAgent(props.id, props.option.id, c.value).catch(errorToast))}
          >
            <span class="ai-model-check">{c.value === props.option.currentValue ? '✓' : ''}</span>
            <span class="grow">
              <span class="ai-model-name">{c.name}</span>
              <Show when={c.description}>
                <span class="ai-model-meta">{c.description}</span>
              </Show>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

/** The mode of the agent, as the mode button of the assistant: its color and its choices (Shift+Tab: the next one). */
function ModePill(props: { id: string; option: ConfigOption }) {
  const tone = () => modeTone(props.option.currentValue)
  return (
    <Popover
      class="ai-options-pop"
      trigger={(toggle) => (
        <button class="ai-mode" title={`${props.option.name} (Shift+Tab)`} onClick={toggle} data-testid={`agent-config-${props.option.id}`} data-value={props.option.currentValue}>
          <Icon name={toneIcons[tone()]} size={13} />
          <span class="ai-mode-label">{nameOf(props.option)}</span>
        </button>
      )}
    >
      {(close) => <ChoiceList id={props.id} option={props.option} close={close} />}
    </Popover>
  )
}

/** The model of the agent, as the model button of the assistant. */
function ModelPill(props: { id: string; option: ConfigOption }) {
  return (
    <Popover
      align="right"
      class="ai-model-pop"
      trigger={(toggle, open) => (
        <button class="ai-pill" classList={{ open }} onClick={toggle} title={props.option.name} data-testid={`agent-config-${props.option.id}`} data-value={props.option.currentValue}>
          <span class="ai-loaded-dot" />
          <span class="ellipsis">{nameOf(props.option)}</span>
          <span class="ai-chev open-up">
            <Icon name="chevron" size={10} />
          </span>
        </button>
      )}
    >
      {(close) => <ChoiceList id={props.id} option={props.option} close={close} />}
    </Popover>
  )
}

/** The other settings of the agent (effort…), behind the options button. */
function AgentOptions(props: { id: string; options: ConfigOption[] }) {
  return (
    <Popover
      class="ai-options-pop"
      trigger={(toggle, open) => (
        <button class="ai-icon" classList={{ on: open }} onClick={toggle} title={t('Agent options')} data-testid="agent-options">
          <Icon name="sliders" size={16} />
        </button>
      )}
    >
      {() => (
        <>
          <For each={props.options}>
            {(o) => (
              <div class="ai-effort-row">
                <span>{o.name}</span>
                <div class="segmented" role="radiogroup" data-testid={`agent-config-${o.id}`}>
                  <For each={flatOptions(o)}>
                    {(c) => (
                      <button type="button" role="radio" aria-checked={c.value === o.currentValue} classList={{ on: c.value === o.currentValue }} title={c.description} onClick={() => void configAgent(props.id, o.id, c.value).catch(errorToast)}>
                        {c.name}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </>
      )}
    </Popover>
  )
}

/** The context the agent uses, as the ring of the assistant and its popover: the tokens, the
 * work time and cost of the session, and /compact when the agent offers it. */
function ContextPop(props: { id: string; used: number; size: number }) {
  const info = () => sessions().find((s) => s.id === props.id)
  const ratio = () => (props.size ? Math.min(1, props.used / props.size) : 0)
  const level = () => (ratio() > 0.9 ? 'danger' : ratio() > 0.75 ? 'warn' : '')
  const canCompact = () => !!info()?.commands?.some((c) => c.name === 'compact')
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <Popover
      align="right"
      class="ai-ctx-pop"
      trigger={(toggle, open) => (
        <button
          class={`ai-ring ${level()}`}
          classList={{ on: open }}
          onClick={toggle}
          title={t('Context: {used} / {size} tokens ({n} %)', { used: formatTokens(props.used), size: formatTokens(props.size), n: Math.round(ratio() * 100) })}
          data-testid="agent-usage"
        >
          <svg width="18" height="18" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r={r} class="ai-ring-bg" />
            <circle cx="9" cy="9" r={r} class="ai-ring-fg" stroke-dasharray={`${c * ratio()} ${c}`} transform="rotate(-90 9 9)" />
          </svg>
        </button>
      )}
    >
      {(close) => (
        <div class="ai-ctx" data-testid="agent-context">
          <div class="ai-ctx-title">{t('Context')}</div>
          <div class="ai-ctx-num">
            <strong>{formatTokens(props.used)}</strong> / {t('{n} tokens', { n: formatTokens(props.size) })} <span class="muted">· {Math.round(ratio() * 100)} %</span>
          </div>
          <div class={`ai-ctx-bar ${level()}`}>
            <span style={{ width: `${ratio() * 100}%` }} />
          </div>
          <Show when={canCompact()}>
            <div class="ai-pop-sep" />
            <button
              class="btn small primary ai-ctx-compact"
              disabled={info()?.state !== 'ready'}
              onClick={() => {
                close()
                void promptAgent(props.id, '/compact', []).catch(errorToast)
              }}
              data-testid="agent-compact"
            >
              <Icon name="history" size={13} /> {t('Compact now')}
            </button>
            <p class="muted small ai-ctx-tip">{t('Or type /compact followed by instructions for the summary.')}</p>
          </Show>
        </div>
      )}
    </Popover>
  )
}
