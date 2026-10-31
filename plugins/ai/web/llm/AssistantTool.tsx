// Tool "Assistant IA": chat with a model of a llama.cpp or Ollama server, which can read and
// change the project files, ask the language servers and run commands. Layout: history side
// bar (always shown in a wide detached window, else folding), conversation, message box.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { approval, chat, live, loadConfig, modelsError, prefs, resetChat, savePrefs, setPrefs } from './state'
import { SettingsModal } from './AssistantSettings'
import { restoreActive } from './assistant'
import { Thread } from './Thread'
import { addFiles, Composer, focusComposer, fullComposer, suggest } from './Composer'
import { Sidebar } from './Sidebar'
import { DoodleHost } from './doodle/DoodleModal'
import { Board } from './board/Board'
import { boardShown, fresh, pages, setBoardWide, setView, view } from './board/pages'
import { ViewSwitch } from './ViewSwitch'
import { Stats } from './Stats'
import { TopBar } from './TopBar'
import { stickToEnd } from './stick'
import './assistant.css'
import { detached, errorToast, Icon, showsQuestions, t } from '../plugin'

/** Width from which the side bar sits next to the conversation instead of over it. */
const WIDE = 720
/** Below this width, the parts of the bar collapse to an icon and a number. */
const NARROW = 420
/** Width from which the board is a column next to the conversation instead of in its place. */
const BOARD_WIDE = 1000

export function AssistantTool() {
  const isDetached = detached()
  // The questions of the conversation shown are in its thread: no modal for them.
  onCleanup(showsQuestions((q) => q.source === 'assistant' && q.session === chat.id))
  const [width, setWidth] = createSignal(0)
  const [settings, setSettings] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const wide = () => width() >= WIDE
  const narrow = () => width() < NARROW
  const boardWide = () => width() >= BOARD_WIDE
  createEffect(() => setBoardWide(boardWide()))
  const [splitting, setSplitting] = createSignal(false)
  const [scrolling, setScrolling] = createSignal(false)
  let mainEl!: HTMLDivElement
  let bodyEl!: HTMLDivElement
  // In a wide detached window the history is always there.
  const pinned = () => isDetached && wide()
  const sidebarShown = () => pinned() || prefs.sidebarOpen
  const setSidebar = (v: boolean) => {
    setPrefs('sidebarOpen', v)
    savePrefs()
  }
  let rootEl!: HTMLDivElement
  let list!: HTMLDivElement
  let thread: ReturnType<typeof stickToEnd> | undefined

  onMount(() => {
    const ro = new ResizeObserver(() => setWidth(rootEl.clientWidth))
    ro.observe(rootEl)
    onCleanup(() => ro.disconnect())
    setWidth(rootEl.clientWidth)
    loadConfig().catch(errorToast)
    // The conversation of the project, and the answer it was waiting for before a reload.
    restoreActive()
      .then(() => loadConfig())
      .catch(() => {})
    focusComposer()
    thread = stickToEnd(list)
    // The switch fades while the thread scrolls under it.
    let still: number | undefined
    const onScroll = () => {
      setScrolling(true)
      clearTimeout(still)
      still = window.setTimeout(() => setScrolling(false), 800)
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    onCleanup(() => (list.removeEventListener('scroll', onScroll), clearTimeout(still)))
  })

  // Follow the answer while the view is at the end (llm/stick.ts).
  createEffect(on(() => [chat.messages.length, live.content, live.reasoning, live.tool, approval()], () => thread?.follow()))
  createEffect(on(() => chat.id, () => thread?.reset()))

  const newChat = () => {
    resetChat()
    focusComposer()
  }

  return (
    <div class="panel ai-panel" ref={rootEl} classList={{ wide: wide(), detached: isDetached }}>
      <div class="panel-head ai-head">
        <Show when={!pinned()}>
          <button class="icon-btn" classList={{ on: prefs.sidebarOpen }} title={t('Conversations of the project')} onClick={() => setSidebar(!prefs.sidebarOpen)}>
            <Icon name="sidebar" size={15} />
          </button>
        </Show>
        <span class="ai-title ellipsis" title={chat.title}>
          {chat.title || t('New conversation')}
        </span>
        <span class="grow" />
        <button class="icon-btn" title={t('New conversation')} onClick={newChat}>
          <Icon name="plus" size={15} />
        </button>
        <button class="icon-btn" title={t('Settings (servers, prompt, compaction, transcription)')} onClick={() => setSettings(true)}>
          <Icon name="gear" size={15} />
        </button>
      </div>
      <Show when={modelsError()}>
        <div class="ai-banner">
          <Icon name="conflict" size={13} /> {modelsError()}
        </div>
      </Show>
      <div class="ai-body" ref={bodyEl}>
        <Show when={sidebarShown()}>
          <Show when={!wide()}>
            <div class="ai-scrim" onClick={() => setSidebar(false)} />
          </Show>
          <div class="ai-side-wrap" classList={{ overlay: !wide() }}>
            <Sidebar onPicked={() => !wide() && setSidebar(false)} onNew={() => (!wide() && setSidebar(false), focusComposer())} />
          </div>
        </Show>
        <div
          class="ai-main"
          classList={{ 'composer-full': fullComposer() }}
          ref={mainEl}
          style={{ display: boardShown() && !boardWide() ? 'none' : undefined, flex: boardShown() && boardWide() ? `${prefs.boardSplit} 1 0` : undefined }}
        >
          <div
            class="ai-messages"
            classList={{ dragging: dragging() }}
            ref={list}
            onDragOver={(e) => {
              if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault()
                setDragging(true)
              }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              setDragging(false)
              if (e.dataTransfer?.files.length) {
                e.preventDefault()
                addFiles(e.dataTransfer.files)
              }
            }}
          >
            <Thread onSuggest={suggest} onSettings={() => setSettings(true)} />
          </div>
          <Composer
            head={<TopBar narrow={narrow} />}
            onSettings={() => setSettings(true)}
            onSent={() => thread?.reset()}
          />
        </div>
        <Show when={boardShown()}>
          <Show when={boardWide()}>
            <div
              class="ai-split"
              classList={{ on: splitting() }}
              data-testid="ai-board-split"
              onPointerDown={(e) => {
                setSplitting(true)
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                if (!splitting()) return
                const left = mainEl.getBoundingClientRect().left
                const right = bodyEl.getBoundingClientRect().right
                setPrefs('boardSplit', Math.min(0.75, Math.max(0.25, (e.clientX - left) / (right - left))))
              }}
              onPointerUp={() => {
                setSplitting(false)
                savePrefs()
              }}
            />
          </Show>
          <div class="ai-board-col" style={{ flex: boardWide() ? `${1 - prefs.boardSplit} 1 0` : '1 1 0' }}>
            <Show when={prefs.sideView === 'stats'} fallback={<Board />}>
              <Stats />
            </Show>
          </div>
        </Show>
        <ViewSwitch view={view()} onView={setView} count={pages().length} fresh={fresh()} faded={scrolling()} />
      </div>
      <Show when={settings()}>
        <SettingsModal onClose={() => setSettings(false)} />
      </Show>
      <DoodleHost onSettings={() => setSettings(true)} />
    </div>
  )
}
