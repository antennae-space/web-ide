// The frame of a message box, shared by the Assistant (Composer) and an agent session
// (AgentComposer): the queue, the attachments, the dictation line, the editor (MessageBox), the
// full screen, the bar (mic, paperclip, the pills of the backend, queue / send / stop) and the
// keys. The draft is the one of its key (drafts.ts); the backend gives what it sends and how.
import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { Prepared } from './attachments'
import { canCapture, captureScreen } from './doodle/background'
import { addFiles, clearDraft, draftPending, draftPreparing, draftText, editDoodleOf, newDoodleFor, removePending, setDraftText, type DoodleTarget } from './drafts'
import { liveDictation, MessageBox, type CompletionItem } from './MessageBox'
import { cancelDictation, canRecord, modelById, speech, startDictation, stopDictation } from './transcribe'
import { AttachmentChip, formatSize } from './parts'
import { prefs } from './state'
import { contextMenu, errorToast, Icon, phone, registerAction, shortcutOf, t, tn, toast } from '../plugin'
import type { EditorView } from '../plugin'

/** A message waiting for the end of the turn. */
export interface QueuedItem {
  text: string
  attachments?: number
}

/** The test ids of a box: the Assistant and the agents keep their own. */
export interface ComposerIds {
  queue: string
  atts?: string
  input?: string
  full: string
  attach: string
  enqueue: string
  send: string
  stop: string
}

/** The editors of the boxes shown, by draft key, and the key of the box shown last. */
const views = new Map<string, EditorView>()
let lastKey = ''

/** Focuses a box: the one of a draft key, else the one shown last. */
export function focusComposer(key = lastKey) {
  queueMicrotask(() => views.get(key)?.focus())
}

/** Puts a suggestion in a box (not sent): the one of a draft key, else the one shown last. */
export function suggest(text: string, key = lastKey) {
  if (!key) return
  setDraftText(key, text)
  focusComposer(key)
}

export function ComposerShell(props: {
  /** The draft and the doodles of the box. */
  target: DoodleTarget
  class?: string
  classList?: Record<string, boolean>
  testid?: string
  ledTestid?: string
  ids: ComposerIds
  /** Above the box, inside its frame (the bar of the conversation). */
  head?: JSX.Element
  /** Between the dictation line and the editor (the help card of the Assistant). */
  above?: JSX.Element
  /** The pills at the start of the bar (the mode), after the paperclip (options) and before send (gauge, model). */
  barStart?: JSX.Element
  barTools?: JSX.Element
  barEnd?: JSX.Element
  busy: () => boolean
  queue: () => QueuedItem[]
  queueTitle: () => string
  queueHint: () => string
  /** Takes a message out of the queue; edit: the text to put back in the box. */
  unqueue: (i: number, edit: boolean) => Promise<string | void> | string | void
  stop: () => void
  /** Sends the text and the attachments; clear empties the box (before or after the sending). */
  submit: (text: string, atts: Prepared[], clear: () => void) => Promise<void>
  /** Before reading the draft to send (the doodle being drawn joins it). */
  beforeSend?: () => Promise<void>
  /** Sendable with an empty box (a doodle being drawn). */
  sendable?: () => boolean
  /** An extra condition to send (an agent in error cannot). */
  canSend?: () => boolean
  slashItems: () => CompletionItem[]
  placeholder: () => string
  /** The prompts sent, the oldest first: ↑ / ↓ in an empty box go through them. */
  history: () => string[]
  /** The keys of the backend (Shift+Tab: the mode), after the ones of the box; true when consumed. */
  onKey?: (e: KeyboardEvent) => boolean
  full: () => boolean
  setFull: (on: boolean) => void
  /** In the doodle modal: no full screen, no doodle from here. */
  inDoodle?: boolean
  /** The editor takes the focus once shown (not on a phone: the keyboard would open). */
  autofocus?: boolean
}) {
  let fileInput!: HTMLInputElement
  const [view, setView] = createSignal<EditorView>()
  const key = () => props.target.key
  const draft = () => draftText(key())
  const pending = () => draftPending(key())
  const preparing = () => draftPreparing(key())
  const setDraft = (text: string) => setDraftText(key(), text)

  const screenshot = async () => {
    try {
      newDoodleFor(props.target, await captureScreen())
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError' && (e as Error).name !== 'AbortError') errorToast(e)
    }
  }

  const dictate = async () => {
    try {
      const v = view()
      if (speech.phase === 'recording') await stopDictation()
      else if (speech.phase === 'idle' && v) await startDictation(liveDictation(v))
    } catch (e) {
      toast(t('Dictation: {message}', { message: (e as Error).message }), 'error')
    }
  }
  onCleanup(cancelDictation)

  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => speech.phase === 'recording' && setNow(Date.now()), 250)
  onCleanup(() => clearInterval(tick))
  const loadingLabel = () =>
    speech.total
      ? t('Downloading the model {name}: {pct} % ({done} / {total})', { name: modelById(prefs.whisperModel).repo.split('/')[1], pct: Math.round((speech.loaded / speech.total) * 100), done: formatSize(speech.loaded), total: formatSize(speech.total) })
      : t('Loading the transcription model…')
  const speechLabel = () => {
    switch (speech.phase) {
      case 'recording': {
        const s = Math.max(0, Math.floor((now() - speech.startedAt) / 1000))
        const rec = t('Recording {time} · click the microphone to finish', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })
        // Live dictation: the words wait for the model.
        return speech.modelLoading ? `${rec} · ${loadingLabel()}` : rec
      }
      case 'loading':
        return loadingLabel()
      case 'transcribing':
        return t('Local transcription…')
    }
    return ''
  }

  // ↑ / ↓ in an empty box (or one showing a prompt of the history) go through the prompts sent.
  let back = -1
  const browse = (dir: 1 | -1): boolean => {
    const list = props.history()
    if (draft() && (back < 0 || draft() !== list[list.length - 1 - back])) return false
    const next = back + dir
    if (next < -1 || next >= list.length) return !!list.length
    back = next
    setDraft(back < 0 ? '' : list[list.length - 1 - back])
    return true
  }

  const canSend = () => (!!draft().trim() || pending().length > 0 || !!props.sendable?.()) && !preparing() && (props.canSend?.() ?? true)
  const submit = async () => {
    if (!canSend()) return
    if (props.beforeSend) await props.beforeSend()
    if (!canSend()) return
    const k = key()
    back = -1
    // The attachments as plain objects: the backend keeps them in its own stores.
    await props.submit(draft().trim(), [...unwrap(pending())], () => clearDraft(k))
  }

  /** The keys of the box, after the completion and before the editor; true when consumed. */
  const onKey = (e: KeyboardEvent): boolean => {
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && plain && !view()?.hasCarets()) return browse(e.key === 'ArrowUp' ? 1 : -1)
    if (e.key === 'Escape' && props.full() && !props.inDoodle && !view()?.hasCarets()) {
      props.setFull(false)
      return true
    }
    if (e.key === 'Escape' && props.busy()) {
      props.stop()
      return true
    }
    if (e.key === ' ' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      void dictate()
      return true
    }
    return props.onKey?.(e) ?? false
  }

  const onView = (v: EditorView) => {
    setView(v)
    // The key read once: a box shows one draft (the composer of a session is made per session).
    const k = key()
    const prev = lastKey
    views.set(k, v)
    lastKey = k
    onCleanup(() => {
      if (views.get(k) === v) views.delete(k)
      if (lastKey === k) lastKey = views.has(prev) ? prev : ''
    })
    if (props.autofocus && !phone()) queueMicrotask(() => v.focus())
  }
  if (!props.inDoodle) {
    const off = registerAction('assistant.fullComposer', () => {
      if (!view()?.hasFocus()) return false
      props.setFull(!props.full())
    })
    onCleanup(off)
  }

  return (
    <div class={`ai-composer-wrap ${props.class ?? ''}`} classList={{ ...props.classList, full: props.full() && !props.inDoodle }} data-testid={props.testid}>
      <div class="ai-led" data-testid={props.ledTestid} />
      {props.head}
      <div class="ai-led" />
      <div class="ai-composer">
        <Show when={props.queue().length}>
          <div class="ai-queue" data-testid={props.ids.queue}>
            <div class="ai-queue-title">
              <Icon name="history" size={12} /> {props.queueTitle()}
            </div>
            <For each={props.queue()}>
              {(q, i) => (
                <div class="ai-queue-item">
                  <span class="ellipsis">{q.text}</span>
                  <Show when={q.attachments}>
                    <span class="muted small">+{tn(q.attachments!, '{n} attachment', '{n} attachments')}</span>
                  </Show>
                  <span class="grow" />
                  <button
                    class="ai-act"
                    title={t('Back to the message box')}
                    onClick={() =>
                      void Promise.resolve(props.unqueue(i(), true))
                        .then((text) => {
                          if (typeof text === 'string') setDraft(text)
                          view()?.focus()
                        })
                        .catch(errorToast)
                    }
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  <button class="ai-act" title={t('Remove from the queue')} onClick={() => void Promise.resolve(props.unqueue(i(), false)).catch(errorToast)}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={pending().length || preparing()}>
          <div class="ai-atts" data-testid={props.ids.atts}>
            <For each={pending()}>
              {(p, i) => <AttachmentChip a={p.attachment} onOpen={p.attachment.doodle && !props.inDoodle ? () => editDoodleOf(props.target, p) : undefined} onRemove={() => removePending(key(), i())} />}
            </For>
            <Show when={preparing()}>
              <span class="ai-att muted">
                <span class="spinner" /> {t('preparing…')}
              </span>
            </Show>
          </div>
        </Show>
        <Show when={speech.phase !== 'idle'}>
          <div class="ai-speech small" classList={{ rec: speech.phase === 'recording' }} data-testid="ai-speech">
            {speech.phase === 'recording' ? <span class="rec-dot" /> : <span class="spinner" />}
            <span class="ellipsis">{speechLabel()}</span>
          </div>
        </Show>
        {props.above}
        <MessageBox draft={draft} setDraft={setDraft} placeholder={props.placeholder} slashItems={props.slashItems} onSubmit={() => void submit()} onKey={onKey} onFiles={(f) => void addFiles(props.target, f)} onView={onView} testid={props.ids.input} />
        <Show when={!props.inDoodle}>
          <button
            class="ai-act ai-full-btn"
            title={props.full() ? t('Leave the full screen (Esc)') : `${t('Full screen')} (${shortcutOf('assistant.fullComposer')})`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (props.setFull(!props.full()), view()?.focus())}
            data-testid={props.ids.full}
          >
            <Icon name={props.full() ? 'minimize' : 'maximize'} size={13} />
          </button>
        </Show>
        <div class="ai-composer-bar">
          {props.barStart}
          <button
            class="ai-icon ai-mic"
            classList={{ rec: speech.phase === 'recording' }}
            title={canRecord() ? (speech.phase === 'recording' ? t('End the dictation (Ctrl+Space)') : t('Dictate: local transcription, the sound stays on this machine (Ctrl+Space)')) : t('Microphone unavailable (https or localhost required)')}
            disabled={!canRecord() || speech.phase === 'loading' || speech.phase === 'transcribing'}
            onClick={() => void dictate()}
          >
            <Icon name="mic" size={16} />
          </button>
          <button
            class="ai-icon"
            title={t('Attach a file or a doodle')}
            aria-haspopup="menu"
            data-testid={props.ids.attach}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              contextMenu(new MouseEvent('contextmenu', { clientX: r.left, clientY: r.top - 4 }), [
                { label: t('File…'), hint: t('image, video, audio, PDF, text'), action: () => fileInput.click() },
                ...(props.inDoodle ? [] : [{ label: t('Doodle…'), hint: shortcutOf('assistant.doodle'), action: () => newDoodleFor(props.target) }]),
                ...(props.inDoodle || !canCapture() ? [] : [{ label: t('Screenshot…'), hint: t('to annotate'), action: () => void screenshot() }]),
              ])
            }}
          >
            <Icon name="paperclip" size={16} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(props.target, [...(e.currentTarget.files ?? [])])
              e.currentTarget.value = ''
            }}
          />
          {props.barTools}
          <span class="grow" />
          {props.barEnd}
          <Show when={props.busy() && canSend()}>
            <button class="ai-send queue" onClick={() => void submit()} aria-label={t('Queue')} title={props.queueHint()} data-testid={props.ids.enqueue}>
              <Icon name="arrowUp" size={16} />
            </button>
          </Show>
          <Show
            when={props.busy()}
            fallback={
              <button class="ai-send" disabled={!canSend()} onClick={() => void submit()} aria-label={t('Send')} title={t('Send (Enter or Ctrl+S)')} data-testid={props.ids.send}>
                <Icon name="arrowUp" size={16} />
              </button>
            }
          >
            <button class="ai-send stop" onClick={() => props.stop()} aria-label={t('Stop')} title={t('Stop (Esc)')} data-testid={props.ids.stop}>
              <span class="ai-stop-square" />
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
