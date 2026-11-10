// Message box of the assistant: the shared frame (ComposerShell: the editor, attachments,
// dictation, send / stop) with the pills of the Assistant: mode, options, context gauge, model
// picker; the /commands and the help card. The draft survives panel switches and reloads.
import { createEffect, createSignal, For, onMount, Show, type JSX } from 'solid-js'
import { loadPromptContext, promptContext } from './prompt'
import {
  chat,
  config,
  contextSize,
  contextUsed,
  currentModel,
  incomingDraft,
  live,
  loadModels,
  models,
  modelsLoading,
  prefs,
  savePrefs,
  select,
  serverKind,
  resetChat,
  setChat,
  setIncomingDraft,
  setPrefs,
  type Attachment,
  type Effort,
  type Model,
} from './state'
import { compactNow, currentMode, nextMode, send, setMode, stop, unqueue } from './assistant'
import type { Prepared } from './attachments'
import type { Picture } from './doodle/background'
import { aliasItems } from './aliases'
import type { CompletionItem } from './MessageBox'
import { ComposerShell, focusComposer, suggest } from './ComposerShell'
import { addFiles as addDraftFiles, newDoodleFor, reuseDoodleFor, setDraftText, type DoodleTarget } from './drafts'
import { formatSize, formatTokens, Popover, Switch } from './parts'
import { errorToast, home, Icon, t, toast } from '../plugin'

const modeIcons = { build: 'edit', plan: 'outline', briefing: 'kanban', orchestrator: 'locate' } as const
const modeLabels = { build: () => t('Build'), plan: () => t('Plan'), briefing: () => t('Briefing'), orchestrator: () => t('Orchestrator') }
const modeTitles = {
  orchestrator: () => t('Orchestrator mode: tells what to do next and what was done, proposes actions and opens the right conversation, without changing files (Shift+Tab for Briefing)'),
  build: () => t('Build mode: acts on the project (Shift+Tab for Orchestrator)'),
  plan: () => t('Plan mode: explores and proposes a plan, without changing files (Shift+Tab for Build)'),
  briefing: () => t('Briefing mode: questions you to clarify an idea and writes it in kanban tickets, without changing files (Shift+Tab for Plan)'),
}

// The draft of the Assistant: one per project (its home), shared by the panel and the doodle modal.
const target: DoodleTarget = {
  get key() {
    return 'llm.draft.' + (home()?.id ?? '')
  },
  caps: () => currentModel()?.caps,
}

/** Converts files (picked, pasted or dropped) into attachments of the next message. */
export const addFiles = (files: Iterable<File>) => addDraftFiles(target, files)

/** Opens a new doodle; Attach joins it to the draft. */
export const newDoodle = (background?: Picture) => newDoodleFor(target, background)

/** Opens an editable copy of a doodle sent earlier: Attach joins it as a new one. */
export const reuseDoodle = (a: Attachment) => reuseDoodleFor(target, a)

export { focusComposer, suggest }

// ---------- commands and mentions ----------

export const commands: { name: string; args?: string; hint: string }[] = [
  { name: 'compact', args: '[instructions]', hint: 'Summarizes the older messages, with optional instructions' },
  { name: 'clear', hint: 'New conversation' },
  { name: 'model', args: '[name]', hint: 'Changes the model' },
  { name: 'help', hint: 'Lists the commands and the skills' },
]

/** Runs a /command; returns false when the text is not a command to run here. */
export async function runCommand(text: string, onSettings: () => void): Promise<boolean> {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
  if (!m) return false
  const [, name, args] = m
  if (live.busy && name === 'compact') {
    toast(t('/{command}: available once the answer is finished', { command: name }), 'warn')
    return true
  }
  switch (name) {
    case 'clear':
    case 'new':
      resetChat()
      return true
    case 'compact':
      await compactNow(args.trim())
      return true
    case 'help':
      setHelp(true)
      return true
    case 'model': {
      const q = args.trim().toLowerCase()
      if (!q) {
        toast(t('Models: {list}', { list: models().map((x) => x.id).join(', ') || t('none') }), 'info', undefined, 8000)
        return true
      }
      const found = models().find((x) => x.id.toLowerCase() === q) ?? models().find((x) => x.id.toLowerCase().includes(q))
      if (!found) {
        toast(t('No model “{name}”', { name: args.trim() }), 'warn')
        return true
      }
      await select(config.server, found.id)
      toast(t('Model: {name}', { name: found.id }), 'ok')
      return true
    }
  }
  const skill = promptContext()?.skills.find((x) => x.name === name)
  if (skill) {
    if (!config.server || !config.model) {
      onSettings()
      return true
    }
    const ask = `Use the skill "${skill.name}": load its instructions with load_skill, then apply them.${args.trim() ? `\n\n${args.trim()}` : ''}`
    await send(ask, [], [], text.trim())
    return true
  }
  toast(t('Unknown command: /{command} (see /help)', { command: name }), 'warn')
  return true
}

/** The commands and the skills of the / list. */
const commandItems = (): CompletionItem[] => [
  ...commands.map((c) => ({ kind: 'command' as const, label: `/${c.name}`, detail: t(c.hint), insert: `/${c.name} ` })),
  ...(promptContext()?.skills ?? []).map((sk) => ({ kind: 'skill' as const, label: `/${sk.name}`, detail: sk.description, insert: `/${sk.name} ` })),
]

const [help, setHelp] = createSignal(false)
/** The message box takes the whole assistant tool (the thread hidden) to write a long message. */
export const [fullComposer, setFullComposer] = createSignal(false)

function HelpCard() {
  return (
    <div class="ai-help" data-testid="ai-help">
      <div class="ai-help-head">
        <strong>{t('Commands')}</strong>
        <span class="grow" />
        <button class="icon-btn small" title={t('Close')} onClick={() => setHelp(false)}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <For each={commands}>
        {(c) => (
          <div class="ai-help-row">
            <code>
              /{c.name}
              {c.args ? ` ${c.args}` : ''}
            </code>
            <span>{t(c.hint)}</span>
          </div>
        )}
      </For>
      <Show when={promptContext()?.skills.length}>
        <strong class="ai-help-sub">Skills</strong>
        <For each={promptContext()!.skills}>
          {(sk) => (
            <div class="ai-help-row">
              <code>/{sk.name} [{t('request')}]</code>
              <span>{sk.description}</span>
            </div>
          )}
        </For>
      </Show>
      <Show when={aliasItems(commandItems()).length}>
        <strong class="ai-help-sub">{t('Aliases')}</strong>
        <For each={aliasItems(commandItems())}>
          {(a) => (
            <div class="ai-help-row">
              <code>{a.label}</code>
              <span>{a.detail}</span>
            </div>
          )}
        </For>
      </Show>
      <div class="ai-help-foot muted">{t('@path designates a file or folder of the project (completion when typing @).')}</div>
      <div class="ai-help-foot muted">{t('Enter (or Ctrl+S) sends; Shift+Enter adds a line and continues the lists.')}</div>
    </div>
  )
}

function capsText(m: Model) {
  const c: string[] = []
  if (m.caps.vision) c.push(t('image'))
  if (m.caps.video) c.push(t('video'))
  if (m.caps.audio) c.push(t('audio'))
  if (m.caps.tools) c.push(t('tools'))
  if (m.caps.thinking) c.push(t('thinking'))
  return c
}

function ModelPicker(props: { onSettings: () => void }) {
  const [filter, setFilter] = createSignal('')
  const shown = () => {
    const q = filter().toLowerCase()
    return models().filter((m) => !q || m.id.toLowerCase().includes(q))
  }
  const label = () => config.model || (config.servers.length ? t('Choose a model') : t('No server'))
  return (
    <Popover
      align="right"
      class="ai-model-pop"
      trigger={(toggle, open) => (
        <button class="ai-pill" classList={{ open }} onClick={toggle} title={t('Model')} data-testid="model-pill">
          <Show when={currentModel()?.state === 'loaded'}>
            <span class="ai-loaded-dot" />
          </Show>
          <span class="ellipsis">{label()}</span>
          <span class="ai-chev open-up">
            <Icon name="chevron" size={10} />
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div class="ai-pop-head">
            <select
              class="small grow"
              value={config.server}
              title={t('Server')}
              onChange={(e) => {
                const v = e.currentTarget.value
                if (v === '+') {
                  close()
                  props.onSettings()
                  return
                }
                select(v, '').catch(errorToast)
              }}
            >
              <Show when={!config.server}>
                <option value="">{t('— server —')}</option>
              </Show>
              <For each={config.servers}>{(s) => <option value={s.id}>{s.name}</option>}</For>
              <option value="+">{t('Manage the servers…')}</option>
            </select>
            <button class="icon-btn small" title={`${t('Reload the list')}${serverKind() ? ` (${serverKind() === 'ollama' ? 'Ollama' : 'llama.cpp'})` : ''}`} onClick={() => loadModels()}>
              <Icon name="refresh" size={13} />
            </button>
          </div>
          <Show when={models().length > 8}>
            <input class="ai-pop-filter" placeholder={t('Filter the models…')} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
          </Show>
          <div class="ai-model-list">
            <Show when={shown().length} fallback={<div class="muted small pad">{modelsLoading() ? t('Loading…') : t('No model')}</div>}>
              <For each={shown()}>
                {(m) => (
                  <button
                    class="ai-model-item"
                    classList={{ active: m.id === config.model }}
                    onClick={() => {
                      select(config.server, m.id).catch(errorToast)
                      close()
                    }}
                  >
                    <span class="ai-model-check">{m.id === config.model ? '✓' : ''}</span>
                    <span class="grow">
                      <span class="ai-model-name">
                        {m.id}
                        <Show when={m.state === 'loaded'}>
                          <span class="ai-loaded-dot" title={t('Loaded')} />
                        </Show>
                      </span>
                      <span class="ai-model-meta">
                        {[m.details, m.context ? t('{n} context', { n: formatTokens(m.context) }) : '', m.size ? formatSize(m.size) : ''].filter(Boolean).join(' · ')}
                      </span>
                      <span class="ai-model-caps">
                        <For each={capsText(m)}>{(c) => <span class="badge">{c}</span>}</For>
                        <Show when={!m.caps.known}>
                          <span class="badge" title={t('Capabilities known once the model is loaded')}>?</span>
                        </Show>
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </>
      )}
    </Popover>
  )
}

function ContextMenu() {
  const ctx = () => contextSize()
  const used = () => contextUsed()
  const ratio = () => (ctx() ? Math.min(1, used() / ctx()) : 0)
  const level = () => (ratio() > prefs.compactAt / 100 ? 'danger' : ratio() > (prefs.compactAt / 100) * 0.85 ? 'warn' : '')
  const active = () => chat.messages.filter((m) => !m.compacted).length
  const compacted = () => chat.messages.filter((m) => m.compacted).length
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
          title={ctx() ? `Contexte : ${used().toLocaleString()} / ${ctx().toLocaleString()} jetons (${Math.round(ratio() * 100)} %)` : 'Contexte : taille inconnue'}
          data-testid="ai-gauge"
        >
          <svg width="18" height="18" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r={r} class="ai-ring-bg" />
            <circle cx="9" cy="9" r={r} class="ai-ring-fg" stroke-dasharray={`${c * ratio()} ${c}`} transform="rotate(-90 9 9)" />
          </svg>
        </button>
      )}
    >
      {(close) => (
        <div class="ai-ctx" data-testid="ai-context-menu">
          <div class="ai-ctx-title">{t('Context')}</div>
          <Show when={ctx()} fallback={<p class="muted small">{t('Unknown context size: it is known once the model is loaded. About {n} tokens used.', { n: formatTokens(used()) })}</p>}>
            <div class="ai-ctx-num">
              <strong>{formatTokens(used())}</strong> / {t('{n} tokens', { n: formatTokens(ctx()) })} <span class="muted">· {Math.round(ratio() * 100)} %</span>
            </div>
            <div class={`ai-ctx-bar ${level()}`}>
              <span style={{ width: `${ratio() * 100}%` }} />
              <i style={{ left: `${prefs.compactAt}%` }} title={t('Compaction threshold: {n} %', { n: prefs.compactAt })} />
            </div>
          </Show>
          <div class="ai-ctx-rows small">
            <span>{t('Messages sent to the model')}</span>
            <span>{active()}</span>
            <Show when={compacted()}>
              <span>{t('Compacted messages')}</span>
              <span>{compacted()}</span>
            </Show>
          </div>
          <Show when={chat.nested?.length}>
            <div class="ai-ctx-files small" data-testid="ai-nested">
              <span>{t('Instructions of the folders read')}</span>
              <For each={chat.nested}>{(n) => <code class="ellipsis" data-testid="ai-nested-file" title={n.path}>{n.path}</code>}</For>
            </div>
          </Show>
          <div class="ai-pop-sep" />
          <Switch label={t('Automatic compaction')} hint={t('Beyond {n} % of the context', { n: prefs.compactAt })} checked={prefs.autoCompact} onChange={(v) => (setPrefs('autoCompact', v), savePrefs())} />
          <label class="ai-ctx-range small">
            <span>{t('Threshold')}</span>
            <input type="range" min="40" max="95" step="5" value={prefs.compactAt} onInput={(e) => (setPrefs('compactAt', Number(e.currentTarget.value)), savePrefs())} />
            <span>{prefs.compactAt} %</span>
          </label>
          <button
            class="btn small primary ai-ctx-compact"
            disabled={live.busy || chat.messages.length < 2}
            onClick={() => {
              close()
              compactNow().catch(errorToast)
            }}
          >
            <Icon name="history" size={13} /> {t('Compact now')}
          </button>
          <p class="muted small ai-ctx-tip">{t('Or type /compact followed by instructions for the summary.')}</p>
        </div>
      )}
    </Popover>
  )
}

const efforts = [
  { id: 'auto', label: () => t('Dynamic'), hint: () => t('Maximum after your message, medium between the tools, low after simple edits, maximum again after a failure') },
  { id: 'xhigh', label: () => t('Max'), hint: () => t('Maximum effort at every step') },
  { id: 'medium', label: () => t('Medium'), hint: () => t('Medium effort at every step') },
  { id: 'low', label: () => t('Low'), hint: () => t('Low effort at every step') },
] as const

function Options() {
  // A ticket session has its own effort (from the complexity), else the one of the options.
  const effort = () => chat.ticket?.effort ?? prefs.effort
  const setEffort = (e: 'auto' | Effort) => {
    if (chat.ticket?.effort) setChat('ticket', 'effort', e)
    else (setPrefs('effort', e), savePrefs())
  }
  const set = (k: 'tools' | 'autoApply' | 'think' | 'effortTool', v: boolean) => {
    setPrefs(k, v)
    savePrefs()
  }
  return (
    <Popover
      class="ai-options-pop"
      align="right"
      trigger={(toggle, open) => (
        <button class="ai-icon" classList={{ on: open }} onClick={toggle} title={t('Assistant options')} data-testid="ai-options">
          <Icon name="sliders" size={16} />
        </button>
      )}
    >
      {() => (
        <>
          <Switch label={t('Tools')} hint={t('Files, search, language servers, consoles')} checked={prefs.tools} onChange={(v) => set('tools', v)} testid="opt-tools" />
          <Switch label={t('Apply without asking')} hint={t('Changes outside the project and /tmp without confirmation')} checked={prefs.autoApply} onChange={(v) => set('autoApply', v)} testid="opt-auto" />
          <Show when={currentModel()?.caps.thinking}>
            <Switch label={t('Thinking')} hint={t('The model thinks before answering')} checked={prefs.think} onChange={(v) => set('think', v)} testid="opt-think" />
            <Show when={prefs.think}>
              <div class="ai-effort-row">
                <span>
                  <span>{t('Effort')}</span>
                  <span class="ai-switch-hint">
                    {effort() === 'auto' ? t('The most after your message, less between the tools') : t('The same at every step')}
                    {chat.ticket?.effort ? ` · ${t('chosen for this ticket session')}` : ''}
                  </span>
                </span>
                <div class="segmented" role="radiogroup" data-testid="opt-effort">
                  <For each={efforts}>
                    {(e) => (
                      <button type="button" role="radio" aria-checked={effort() === e.id} classList={{ on: effort() === e.id }} title={e.hint()} onClick={() => setEffort(e.id)}>
                        {e.label()}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <Show when={effort() === 'auto'}>
                <Switch label={t('Effort tool')} hint={t('The model can change its effort itself')} checked={prefs.effortTool} onChange={(v) => set('effortTool', v)} testid="opt-effort-tool" />
              </Show>
            </Show>
          </Show>
        </>
      )}
    </Popover>
  )
}

export function Composer(props: {
  onSettings: () => void
  onSent: () => void
  /** In the doodle modal: no new doodle from here, the doodle being drawn can be sent. */
  inDoodle?: boolean
  sendable?: () => boolean
  beforeSend?: () => Promise<void>
  /** Above the box, inside its frame (the bar of the conversation). */
  head?: JSX.Element
}) {
  // A message prepared by the Orchestrator for the conversation it opened.
  createEffect(() => {
    const text = incomingDraft()
    if (!text) return
    setDraftText(target.key, text)
    setIncomingDraft('')
    focusComposer()
  })

  onMount(() => {
    if (!promptContext()) loadPromptContext().catch(() => {})
  })
  const slashItems = (): CompletionItem[] => [...commandItems(), ...aliasItems(commandItems())]

  const submit = async (text: string, atts: Prepared[], clear: () => void) => {
    if (text.startsWith('/') && !atts.length) {
      setDraftText(target.key, '')
      setHelp(false)
      try {
        if (await runCommand(text, props.onSettings)) {
          props.onSent()
          return
        }
      } catch (e) {
        errorToast(e)
        return
      }
    }
    if (!config.server || !config.model) {
      props.onSettings()
      return
    }
    setHelp(false)
    clear()
    setFullComposer(false)
    props.onSent()
    try {
      await send(
        text,
        atts.flatMap((a) => a.parts),
        atts.map((a) => a.attachment),
      )
    } catch (e) {
      errorToast(e)
    }
  }

  /** Shift+Tab cycles through the modes. */
  const onKey = (e: KeyboardEvent): boolean => {
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      setMode(nextMode())
      return true
    }
    return false
  }

  const placeholder = () => (!config.model ? t('Choose a model…') : live.busy ? t('Queued message…') : t('Message…'))
  // The messages typed in this conversation, for ↑ / ↓.
  const sent = () => chat.messages.flatMap((m) => (m.role !== 'user' ? [] : [m.display ?? (typeof m.content === 'string' ? m.content : '')])).filter(Boolean)

  return (
    <ComposerShell
      target={target}
      classList={{ [currentMode()]: true, busy: live.busy && live.state !== 'waiting_user', compacting: live.compacting }}
      ledTestid="ai-led"
      ids={{ queue: 'ai-queue', full: 'ai-full', attach: 'ai-attach', enqueue: 'enqueue', send: 'send', stop: 'stop' }}
      head={props.head}
      above={
        <Show when={help()}>
          <HelpCard />
        </Show>
      }
      barStart={
        <button
          class="ai-mode"
          classList={{ plan: currentMode() === 'plan', briefing: currentMode() === 'briefing', orchestrator: currentMode() === 'orchestrator' }}
          title={modeTitles[currentMode()]()}
          onClick={() => setMode(nextMode())}
          data-testid="ai-mode"
        >
          <Icon name={modeIcons[currentMode()]} size={13} />
          <span class="ai-mode-label">{modeLabels[currentMode()]()}</span>
          <Show when={currentMode() === 'plan' && prefs.planServer && prefs.planModel}>
            <span class="ai-mode-model ellipsis">· {prefs.planModel}</span>
          </Show>
        </button>
      }
      barTools={<Options />}
      barEnd={
        <>
          <Show when={chat.messages.length}>
            <ContextMenu />
          </Show>
          <ModelPicker onSettings={props.onSettings} />
        </>
      }
      busy={() => live.busy}
      queue={() => (chat.queue ?? []).map((q) => ({ text: q.display ?? q.text, attachments: q.attachments?.length }))}
      queueTitle={() => (live.busy ? t('Queued: sent at the next step of the answer') : t('Queued: sent with the next message'))}
      queueHint={() => t('Queue (Enter or Ctrl+S): sent at the next step')}
      unqueue={(i, edit) => {
        const q = chat.queue![i]
        unqueue(q.id)
        if (edit) return q.display ?? q.text
      }}
      stop={stop}
      submit={submit}
      beforeSend={props.beforeSend}
      sendable={props.sendable}
      slashItems={slashItems}
      placeholder={placeholder}
      history={sent}
      onKey={onKey}
      full={fullComposer}
      setFull={setFullComposer}
      inDoodle={props.inDoodle}
    />
  )
}
