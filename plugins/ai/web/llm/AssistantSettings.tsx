// Settings of the assistant besides the servers: system prompt and instructions, and
// compaction of long conversations.
import { createResource, createSignal, For, Index, onMount, Show } from 'solid-js'
import { applyConfig, config, loadModels, prefs, savePrefs, select, setPrefs, type Mode, type Model, type ModelConf, type ServerView } from './state'
import { languages, probeGpu, speech, whisperModels } from './transcribe'
import { formatSize } from './parts'
import { aliases, aliasName, aliasText, saveAliases } from './aliases'
import { defaultTemplate, loadPromptContext, promptContext, storedTemplates, systemPrompt, templateOf } from './prompt'
import { errorToast, fmtSize, Icon, Modal, openTextTab, relPath, request, t, toast } from '../plugin'

const size = (n: number) => fmtSize(n)

export function PromptSettings() {
  const [scope, setScope] = createSignal<'project' | 'global'>('project')
  const [kind, setKind] = createSignal<Mode>('build')
  const stored = (c: ReturnType<typeof promptContext>, sc: 'project' | 'global', k: Mode) => storedTemplates(c, k)[sc] ?? ''
  const [text, setText] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  // Text typed before the context arrives is not replaced by it.
  let edited = false
  const load = async () => {
    const c = await loadPromptContext()
    if (!edited) setText(stored(c, scope(), kind()))
  }
  const edit = (v: string) => {
    edited = true
    setText(v)
  }
  onMount(load)
  const switchScope = (s: 'project' | 'global') => {
    edited = false
    setScope(s)
    setText(stored(promptContext(), s, kind()))
  }
  const switchKind = (k: Mode) => {
    edited = false
    setKind(k)
    setText(stored(promptContext(), scope(), k))
  }
  const defaultText = () => defaultTemplate(kind())
  const save = async (content: string) => {
    setBusy(true)
    try {
      await request('llm.prompt.save', { scope: scope(), kind: kind(), content })
      edited = false
      await load()
      toast(content.trim() ? t('Prompt saved') : t('Default prompt restored'), 'ok')
    } catch (e) {
      errorToast(e)
    } finally {
      setBusy(false)
    }
  }
  const source = () => templateOf(promptContext(), kind()).source
  return (
    <div class="form" data-testid="prompt-settings">
      <label class="field">
        <span>{t('Mode of a new conversation')}</span>
        <select
          value={prefs.defaultMode}
          onChange={(e) => {
            setPrefs('defaultMode', e.currentTarget.value as Mode)
            savePrefs()
          }}
          name="defaultMode"
          class="w-next"
        >
          <option value="orchestrator">{t('Orchestrator')}</option>
          <option value="build">{t('Build')}</option>
          <option value="plan">{t('Plan')}</option>
          <option value="briefing">{t('Briefing')}</option>
        </select>
      </label>
      <p class="muted small">
        {t('The system prompt starts with this template, followed by the instruction files and the list of skills, loaded like Claude Code. The project prompt ({build}, {plan} for the Plan mode, {briefing} for the Briefing mode) replaces the global one. Currently:', { build: '.ide/system-prompt.md', plan: '.ide/plan-prompt.md', briefing: '.ide/briefing-prompt.md' })}{' '}
        <strong>{source() === 'project' ? t('project prompt') : source() === 'global' ? t('global prompt') : t('default prompt')}</strong>.
      </p>
      <div class="field-row">
        <button type="button" class="toggle" classList={{ on: kind() === 'build' }} onClick={() => switchKind('build')} data-testid="prompt-build">
          build
        </button>
        <button type="button" class="toggle" classList={{ on: kind() === 'plan' }} onClick={() => switchKind('plan')} data-testid="prompt-plan">
          plan
        </button>
        <button type="button" class="toggle" classList={{ on: kind() === 'briefing' }} onClick={() => switchKind('briefing')} data-testid="prompt-briefing">
          briefing
        </button>
        <span class="sep" />
        <button type="button" class="toggle" classList={{ on: scope() === 'project' }} onClick={() => switchScope('project')}>
          {t('project')}
        </button>
        <button type="button" class="toggle" classList={{ on: scope() === 'global' }} onClick={() => switchScope('global')}>
          {t('global')}
        </button>
        <span class="grow" />
        <button type="button" class="btn small" onClick={() => edit(defaultText())}>
          {t('Start from the default prompt')}
        </button>
      </div>
      <textarea class="ai-prompt-edit mono" rows="12" value={text()} onInput={(e) => edit(e.currentTarget.value)} placeholder={`${scope() === 'project' ? t('Empty: global prompt, else default prompt.') : t('Empty: default prompt.')}\n\n${defaultText()}`} name="systemPrompt" />
      <p class="muted small">
        {t('Variables:')} <code>{'{{project}}'}</code> <code>{'{{root}}'}</code> <code>{'{{host}}'}</code> <code>{'{{tools}}'}</code> {t('(description of the tools, empty when they are off).')}
      </p>
      <div class="form-actions">
        <button type="button" class="btn" onClick={() =>
            systemPrompt(kind())
              .then((text) => openTextTab(kind() === 'plan' ? t('System prompt (Plan)') : kind() === 'briefing' ? t('System prompt (Briefing)') : t('System prompt'), text, 'markdown'))
              .catch(errorToast)
          }>
          {t('Preview of the full prompt')}
        </button>
        <span class="grow" />
        <button type="button" class="btn" disabled={busy()} onClick={() => save('')}>
          {t('Restore')}
        </button>
        <button type="button" class="btn primary" disabled={busy()} onClick={() => save(text())}>
          {t('Save')}
        </button>
      </div>
      <fieldset class="fieldset">
        <legend>{t('Instruction files')}</legend>
        <p class="muted small">
          {t('Global:')} <code>~/.claude/CLAUDE.md</code>, <code>~/.codex/AGENTS.md</code>. {t('Project:')} <code>CLAUDE.md</code>, <code>.claude/CLAUDE.md</code>, <code>CLAUDE.local.md</code>, <code>AGENTS.md</code>. {t('Imports with {at} are followed.', { at: '@path' })}
        </p>
        <For each={promptContext()?.files ?? []} fallback={<p class="muted small">{t('No file found.')}</p>}>
          {(f) => (
            <div class="ai-server-row small" data-testid="instruction-file">
              <span class="badge">{f.scope === 'global' ? t('global') : t('project')}</span>
              <span class="grow mono ellipsis">{f.scope === 'project' ? relPath(f.path) : f.path}</span>
              <span class="muted">{size(f.content.length)}</span>
            </div>
          )}
        </For>
      </fieldset>
      <fieldset class="fieldset">
        <legend>Skills</legend>
        <p class="muted small">
          <code>~/.claude/skills</code>, <code>~/.agents/skills</code> {t('and the same folders in the project (first). Only the name and the description go in the prompt; the assistant loads the rest with the {tool} tool.', { tool: 'load_skill' })}
        </p>
        <For each={promptContext()?.skills ?? []} fallback={<p class="muted small">{t('No skill found.')}</p>}>
          {(s) => (
            <div class="ai-server-row small" data-testid="skill">
              <span class="badge">{s.scope === 'global' ? t('global') : t('project')}</span>
              <div class="grow">
                <strong>{s.name}</strong>
                <div class="muted">{s.description}</div>
              </div>
            </div>
          )}
        </For>
      </fieldset>
    </div>
  )
}

// The models of a server come after the value of their select: each option says whether it
// is the chosen one, else the select shows "— choose —" when the settings open again.
export function PlanSettings() {
  const [list] = createResource(
    () => prefs.planServer,
    (server) => (server ? request<{ models: Model[] }>('llm.models', { server }).then((r) => r.models, () => []) : Promise.resolve([] as Model[])),
  )
  const set = (k: 'planServer' | 'planModel', v: string) => {
    setPrefs(k, v)
    savePrefs()
  }
  return (
    <div class="form" data-testid="plan-settings">
      <p class="muted small">
        {t('In Plan mode (Shift+Tab in the message box), the assistant explores and proposes a plan without changing the project: edit_file and write_file only write scratch files in /tmp, and a bash command that is not a reading, a build or test of the project, or confined to /tmp, asks for your approval. Its prompt is edited in the “Prompt and instructions” tab (plan button). When the plan is ready, “Execute this plan” switches to Build with the model of the conversation.')}
      </p>
      <div class="field-row">
        <label class="field grow">
          <span>{t('Model of the Plan mode')}</span>
          <select value={prefs.planServer} onChange={(e) => (set('planServer', e.currentTarget.value), set('planModel', ''))} name="planServer">
            <option value="">{t('The model of the conversation')}</option>
            <For each={config.servers}>{(s) => <option value={s.id}>{s.name}</option>}</For>
          </select>
        </label>
        <Show when={prefs.planServer}>
          <label class="field grow">
            <span>{t('Model')}</span>
            <select value={prefs.planModel} onChange={(e) => set('planModel', e.currentTarget.value)} name="planModel">
              <option value="">{t('— choose —')}</option>
              <For each={list() ?? []}>{(m) => <option value={m.id} selected={m.id === prefs.planModel}>{m.id}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
    </div>
  )
}

export function SubAgentSettings() {
  const [list] = createResource(
    () => config.childServer,
    (server) => (server ? request<{ models: Model[] }>('llm.models', { server }).then((r) => r.models, () => []) : Promise.resolve([] as Model[])),
  )
  const set = (server: string, model: string) => request('llm.children', { server, model }).then(applyConfig, errorToast)
  return (
    <div class="form" data-testid="subagent-settings">
      <p class="muted small">
        {t('The assistant can delegate a task to a sub-agent: a conversation with a fresh context that runs in the background and reports to it. It may run on another server, a cloud provider for instance: mark the servers “Available to sub-agents” in the Servers tab, with a note that tells the assistant when to use them.')}
      </p>
      <div class="field-row">
        <label class="field grow">
          <span>{t('Default server of the sub-agents')}</span>
          <select value={config.childServer ?? ''} onChange={(e) => set(e.currentTarget.value, '')} name="childServer">
            <option value="">{t('The model of the conversation')}</option>
            <For each={config.servers.filter((s) => s.children)}>{(s) => <option value={s.id}>{s.name}</option>}</For>
          </select>
        </label>
        <Show when={config.childServer}>
          <label class="field grow">
            <span>{t('Model')}</span>
            <select value={config.childModel ?? ''} onChange={(e) => set(config.childServer!, e.currentTarget.value)} name="childModel">
              <option value="">{t('— choose —')}</option>
              <For each={list() ?? []}>{(m) => <option value={m.id} selected={m.id === config.childModel}>{m.id}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
    </div>
  )
}

export function ImageSettings() {
  const [list] = createResource(
    () => config.imageServer,
    (server) => (server ? request<{ models: Model[] }>('llm.models', { server }).then((r) => r.models, () => []) : Promise.resolve([] as Model[])),
  )
  const set = (server: string, model: string) => request('llm.image', { server, model }).then(applyConfig, errorToast)
  return (
    <div class="form" data-testid="image-settings">
      <p class="muted small">
        {t('The assistant can make and change images (generate_image) with an image model of a server that speaks the OpenAI images API: stable-diffusion.cpp behind llama-swap, or a cloud provider. On one GPU, llama-swap unloads the model of the conversation for the image, then loads it again.')}
      </p>
      <div class="field-row">
        <label class="field grow">
          <span>{t('Server of the images')}</span>
          <select value={config.imageServer ?? ''} onChange={(e) => set(e.currentTarget.value, '')} name="imageServer">
            <option value="">{t('No image generation')}</option>
            <For each={config.servers}>{(s) => <option value={s.id}>{s.name}</option>}</For>
          </select>
        </label>
        <Show when={config.imageServer}>
          <label class="field grow">
            <span>{t('Model')}</span>
            <select value={config.imageModel ?? ''} onChange={(e) => set(config.imageServer!, e.currentTarget.value)} name="imageModel">
              <option value="">{t('— choose —')}</option>
              <For each={list() ?? []}>{(m) => <option value={m.id} selected={m.id === config.imageModel}>{m.id}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
    </div>
  )
}

export function WebSettings() {
  const web = () => config.web ?? {}
  const [searxng, setSearxng] = createSignal(web().searxng ?? '')
  const [key, setKey] = createSignal('')
  // The provider picked: saved once it has its key or its address.
  const [choice, setChoice] = createSignal<string>(web().search ?? '')
  const pick = (v: string) => {
    setChoice(v)
    if (v === '' || (v === 'brave' && web().hasBraveKey) || (v === 'searxng' && searxng())) set(v)
  }
  const set = (search: string) =>
    request('llm.web', { search, searxng: searxng(), braveKey: key() }).then((v) => {
      applyConfig(v)
      setKey('')
    }, errorToast)
  return (
    <div class="form" data-testid="web-settings">
      <p class="muted small">
        {t('The assistant can search the web (web_search) and read pages (web_fetch). A page can hold instructions written to mislead it: once web content is in a conversation, its commands, file changes and tools that change something ask you, and web_fetch reads only the URLs you wrote, of the search results and the links of pages read.')}
      </p>
      <label class="field">
        <span>{t('Web search')}</span>
        <select value={choice()} onChange={(e) => pick(e.currentTarget.value)} name="webSearch">
          <option value="">{t('No web access')}</option>
          <option value="brave">Brave Search</option>
          <option value="searxng">SearXNG</option>
        </select>
      </label>
      <Show when={choice() === 'brave'}>
        <div class="field-row">
          <label class="field grow">
            <span>{t('Brave Search API key')}</span>
            <input type="password" name="braveKey" value={key()} placeholder={web().hasBraveKey ? t('Key saved: type a new one to replace it') : ''} onInput={(e) => setKey(e.currentTarget.value)} />
          </label>
          <button class="btn" disabled={!key()} onClick={() => set('brave')}>
            {t('Save')}
          </button>
        </div>
      </Show>
      <Show when={choice() === 'searxng'}>
        <div class="field-row">
          <label class="field grow">
            <span>{t('Address of the SearXNG (its JSON format on)')}</span>
            <input name="searxng" value={searxng()} placeholder="http://127.0.0.1:8888" onInput={(e) => setSearxng(e.currentTarget.value)} />
          </label>
          <button class="btn" onClick={() => set('searxng')}>
            {t('Save')}
          </button>
        </div>
      </Show>
    </div>
  )
}

export function CompactionSettings() {
  const [list] = createResource(
    () => prefs.compactServer,
    (server) => (server ? request<{ models: Model[] }>('llm.models', { server }).then((r) => r.models, () => []) : Promise.resolve([] as Model[])),
  )
  const set = <K extends 'autoCompact' | 'compactAt' | 'compactServer' | 'compactModel'>(k: K, v: (typeof prefs)[K]) => {
    setPrefs(k, v)
    savePrefs()
  }
  return (
    <div class="form" data-testid="compaction-settings">
      <p class="muted small">
        {t('When a conversation nears the context size of the model, the oldest messages are replaced by a summary (they stay visible, folded). The recent messages, about a quarter of the context, are kept as they are. The “compact” button under the message box does it on demand.')}
      </p>
      <label class="check">
        <input type="checkbox" checked={prefs.autoCompact} onChange={(e) => set('autoCompact', e.currentTarget.checked)} />
        {t('Automatic compaction')}
      </label>
      <label class="field">
        <span>{t('Threshold: {n} % of the context', { n: prefs.compactAt })}</span>
        <input type="range" min="40" max="95" step="5" value={prefs.compactAt} onInput={(e) => set('compactAt', Number(e.currentTarget.value))} />
      </label>
      <div class="field-row">
        <label class="field grow">
          <span>{t('Summarizing model')}</span>
          <select value={prefs.compactServer} onChange={(e) => (set('compactServer', e.currentTarget.value), set('compactModel', ''))} name="compactServer">
            <option value="">{t('The model of the conversation')}</option>
            <For each={config.servers}>{(s) => <option value={s.id}>{s.name}</option>}</For>
          </select>
        </label>
        <Show when={prefs.compactServer}>
          <label class="field grow">
            <span>{t('Model')}</span>
            <select value={prefs.compactModel} onChange={(e) => set('compactModel', e.currentTarget.value)} name="compactModel">
              <option value="">{t('— choose —')}</option>
              <For each={list() ?? []}>{(m) => <option value={m.id} selected={m.id === prefs.compactModel}>{m.id}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
      <Show when={prefs.compactServer && !prefs.compactModel}>
        <p class="warn small">{t('Choose the summarizing model, otherwise the compaction will fail.')}</p>
      </Show>
    </div>
  )
}

function SpeechSettings() {
  const [cached, { refetch }] = createResource(() => request<{ repo: string; size: number }[]>('models.list').catch(() => []))
  onMount(probeGpu)
  const set = (k: 'whisperModel' | 'whisperLang', v: string) => {
    setPrefs(k, v)
    savePrefs()
  }
  return (
    <fieldset class="fieldset" data-testid="speech-settings">
      <legend>{t('Local transcription (Whisper)')}</legend>
      <p class="muted small">
        {t('Microphone dictation and audio files transcribed in the browser: the sound does not leave this machine. The model is downloaded once by the pod (folder {dir} of the data), then works offline.', { dir: 'models' })}
        {speech.device ? ` ${t('Engine: {engine}.', { engine: speech.device === 'webgpu' ? t('WebGPU (graphics card)') : t('WebAssembly (processor)') })}` : ''}
      </p>
      <div class="field-row">
        <label class="field grow">
          <span>{t('Model')}</span>
          <select value={prefs.whisperModel} onChange={(e) => set('whisperModel', e.currentTarget.value)} name="whisperModel">
            <For each={whisperModels}>
              {(m) => (
                <option value={m.id} disabled={m.webgpuOnly && !(speech.device === 'webgpu' && speech.f16)}>
                  {t(m.label)} · {t('{n} MB', { n: speech.device === 'webgpu' ? m.size.webgpu : m.size.wasm || m.size.webgpu })}
                </option>
              )}
            </For>
          </select>
        </label>
        <label class="field">
          <span>{t('Spoken language')}</span>
          <select value={prefs.whisperLang} onChange={(e) => set('whisperLang', e.currentTarget.value)} name="whisperLang">
            <For each={languages}>{([id, label]) => <option value={id}>{t(label)}</option>}</For>
          </select>
        </label>
      </div>
      <label class="check small">
        <input type="checkbox" name="whisperLive" checked={prefs.whisperLive} onChange={(e) => (setPrefs('whisperLive', e.currentTarget.checked), savePrefs())} />
        {t('Live dictation: the text appears in the box as you speak (otherwise: transcribed when you stop)')}
      </label>
      <label class="check small">
        <input type="checkbox" checked={prefs.audioToModel} onChange={(e) => (setPrefs('audioToModel', e.currentTarget.checked), savePrefs())} />
        {t('Send audio files as they are to the models that listen to audio (otherwise: local transcription)')}
      </label>
      <Show when={(cached() ?? []).length}>
        <div class="small">
          <For each={cached()}>
            {(c) => (
              <div class="ai-server-row">
                <span class="grow mono">{c.repo}</span>
                <span class="muted">{formatSize(c.size)}</span>
                <button
                  type="button"
                  class="btn small danger"
                  onClick={async () => {
                    await request('models.delete', { repo: c.repo }).catch(errorToast)
                    refetch()
                  }}
                >
                  {t('Delete')}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </fieldset>
  )
}

/** The aliases of the / list: Index keeps the focus in a row while the list is saved. */
function AliasSettings() {
  const edit = (i: number, patch: { name?: string; text?: string }) => {
    saveAliases(aliases().map((a, j) => (j !== i ? a : patch.text !== undefined ? { name: a.name, text: patch.text } : { ...a, ...patch })))
  }
  return (
    <div class="form" data-testid="alias-settings">
      <p class="muted small">{t('An alias is a text of yours, in every project. Pick it in the / list of the message box of the assistant or of an agent: its text goes in the box, and you can change it before you send. A command of the same name comes first: the alias does not show in that box.')}</p>
      <Index each={aliases()}>
        {(a, i) => (
          <div class="ai-alias-row" data-testid="alias-row">
            <input
              class="mono"
              value={a().name}
              aria-label={t('Name')}
              placeholder={t('Name')}
              onInput={(e) => {
                const name = aliasName(e.currentTarget.value)
                e.currentTarget.value = name
                edit(i, { name })
              }}
              data-testid="alias-name"
            />
            <textarea class="grow" rows="2" value={aliasText(a())} aria-label={t('Text')} placeholder={t('Text')} onInput={(e) => edit(i, { text: e.currentTarget.value })} data-testid="alias-text" />
            <button type="button" class="btn small danger" onClick={() => saveAliases(aliases().filter((_, j) => j !== i))} data-testid="alias-delete">
              {t('Delete')}
            </button>
          </div>
        )}
      </Index>
      <div class="form-actions">
        <button type="button" class="btn" onClick={() => saveAliases([...aliases(), { name: '', text: '' }])} data-testid="alias-add">
          {t('Add an alias')}
        </button>
      </div>
    </div>
  )
}

export function SettingsModal(props: { onClose: () => void }) {
  const blank = { id: '', name: '', kind: 'auto' as ServerView['kind'], url: '', apiKey: '', context: 0, parallel: 1, hasKey: false, clearKey: false, note: '', children: false, models: [] as ModelConf[] }
  const [form, setForm] = createSignal({ ...blank })
  const [busy, setBusy] = createSignal(false)
  const edit = (s: ServerView) => setForm({ ...blank, ...s, apiKey: '', context: s.context ?? 0, parallel: s.parallel || 1, note: s.note ?? '', children: !!s.children, models: (s.models ?? []).map((m) => ({ ...m })) })
  const field = (k: keyof ReturnType<typeof form>) => (e: Event) => setForm({ ...form(), [k]: (e.currentTarget as HTMLInputElement).value })
  const save = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      const f = form()
      const models = f.models.filter((m) => m.id.trim()).map((m) => ({ ...m, id: m.id.trim(), context: Number(m.context) || 0 }))
      const view = await request('llm.server.save', {
        id: f.id,
        name: f.name.trim(),
        kind: f.kind,
        url: f.url,
        apiKey: f.apiKey,
        context: Number(f.context) || 0,
        parallel: Math.max(1, Number(f.parallel) || 1),
        clearKey: f.clearKey,
        note: f.note.trim(),
        children: f.children,
        models,
      })
      applyConfig(view)
      const saved = f.id ? view.servers.find((s: ServerView) => s.id === f.id) : view.servers[view.servers.length - 1]
      setForm({ ...blank })
      if (saved && !config.server) await select(saved.id, '')
      else if (saved?.id === config.server) await loadModels()
      toast(t('Server saved'), 'ok')
    } catch (err) {
      errorToast(err)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (s: ServerView) => {
    if (!confirm(t('Delete the server “{name}”?', { name: s.name }))) return
    try {
      applyConfig(await request('llm.server.delete', { id: s.id }))
      if (config.server === s.id) await select('', '')
    } catch (err) {
      errorToast(err)
    }
  }
  const setModel = (i: number, patch: Partial<ModelConf>) => setForm({ ...form(), models: form().models.map((m, j) => (j === i ? { ...m, ...patch } : m)) })
  type Tab = 'servers' | 'prompt' | 'plan' | 'subagents' | 'images' | 'web' | 'compaction' | 'speech' | 'aliases'
  const [tab, setTab] = createSignal<Tab>('servers')
  const tabs: [Tab, string][] = [
    ['servers', 'Servers'],
    ['prompt', 'Prompt and instructions'],
    ['plan', 'Plan mode'],
    ['subagents', 'Sub-agents'],
    ['images', 'Image generation'],
    ['web', 'Web'],
    ['compaction', 'Compaction'],
    ['speech', 'Transcription'],
    ['aliases', 'Aliases'],
  ]
  return (
    <Modal title={t('Assistant settings')} onClose={props.onClose} class="ai-servers modal-wide">
      <div class="ai-tabs" role="tablist">
        <For each={tabs}>
          {([id, label]) => (
            <button type="button" role="tab" class="ai-tab" classList={{ active: tab() === id }} aria-selected={tab() === id} onClick={() => setTab(id)}>
              {t(label)}
            </button>
          )}
        </For>
      </div>
      <Show when={tab() === 'prompt'}>
        <PromptSettings />
      </Show>
      <Show when={tab() === 'plan'}>
        <PlanSettings />
      </Show>
      <Show when={tab() === 'subagents'}>
        <SubAgentSettings />
      </Show>
      <Show when={tab() === 'images'}>
        <ImageSettings />
      </Show>
      <Show when={tab() === 'web'}>
        <WebSettings />
      </Show>
      <Show when={tab() === 'compaction'}>
        <CompactionSettings />
      </Show>
      <Show when={tab() === 'speech'}>
        <SpeechSettings />
      </Show>
      <Show when={tab() === 'aliases'}>
        <AliasSettings />
      </Show>
      <div class="form" style={{ display: tab() === 'servers' ? undefined : 'none' }}>
        <For each={config.servers} fallback={<p class="muted">{t('No server. Add llama.cpp (llama-server) or Ollama below.')}</p>}>
          {(s) => (
            <div class="ai-server-row">
              <div class="grow">
                <strong>{s.name}</strong>
                <div class="muted small mono">
                  {s.url} · {s.kind === 'auto' ? t('auto-detect') : s.kind === 'ollama' ? 'Ollama' : s.kind === 'openai' ? t('OpenAI-compatible provider') : 'llama.cpp / OpenAI'}
                  {s.hasKey ? ` · ${t('API key')}` : ''}
                  {s.children ? ` · ${t('sub-agents')}` : ''}
                </div>
              </div>
              <button class="btn small" onClick={() => edit(s)}>
                {t('Edit')}
              </button>
              <button class="btn small danger" onClick={() => remove(s)}>
                {t('Delete')}
              </button>
            </div>
          )}
        </For>
        <form class="fieldset" onSubmit={save}>
          <legend>{form().id ? t('Edit the server') : t('Add a server')}</legend>
          <div class="field-row">
            <label class="field grow">
              <span>{t('Address (IP:port or URL)')}</span>
              <input value={form().url} onInput={field('url')} placeholder="127.0.0.1:8080" required name="url" />
            </label>
            <label class="field">
              <span>{t('Type')}</span>
              <select value={form().kind} onChange={field('kind')} name="kind">
                <option value="auto">{t('Auto-detect')}</option>
                <option value="llamacpp">llama.cpp / OpenAI</option>
                <option value="ollama">Ollama</option>
                <option value="openai">{t('OpenAI-compatible provider (OpenAI, OpenRouter…)')}</option>
              </select>
            </label>
          </div>
          <div class="field-row">
            <label class="field grow">
              <span>{t('Name (optional)')}</span>
              <input value={form().name} onInput={field('name')} name="name" />
            </label>
            <label class="field grow">
              <span>{t('API key (optional)')}</span>
              <input type="password" value={form().apiKey} onInput={field('apiKey')} placeholder={form().hasKey ? t('unchanged') : ''} autocomplete="off" name="apiKey" />
            </label>
          </div>
          <Show when={form().kind === 'openai'}>
            <p class="muted small">{t('The key stays on the pod: the page never receives it. Requests to a paid provider cost money.')}</p>
          </Show>
          <div class="field">
            <span>{t('Models typed by hand (when the server does not list them, or to set what they can do)')}</span>
            <For each={form().models}>
              {(m, i) => (
                <div class="ai-model-conf" data-testid="model-conf">
                  <input value={m.id} placeholder={t('model id')} onInput={(e) => setModel(i(), { id: e.currentTarget.value })} name="modelId" />
                  <input type="number" min="0" step="1024" value={m.context ?? 0} title={t('Context size (0: unknown)')} onInput={(e) => setModel(i(), { context: Number(e.currentTarget.value) })} class="w-next" />
                  <label class="check small">
                    <input type="checkbox" checked={m.tools} onChange={(e) => setModel(i(), { tools: e.currentTarget.checked })} />
                    {t('tools')}
                  </label>
                  <label class="check small">
                    <input type="checkbox" checked={m.vision} onChange={(e) => setModel(i(), { vision: e.currentTarget.checked })} />
                    {t('image')}
                  </label>
                  <label class="check small">
                    <input type="checkbox" checked={m.thinking} onChange={(e) => setModel(i(), { thinking: e.currentTarget.checked })} />
                    {t('reasoning')}
                  </label>
                  <button type="button" class="icon-btn small" title={t('Remove')} onClick={() => setForm({ ...form(), models: form().models.filter((_, j) => j !== i()) })}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              )}
            </For>
            <button type="button" class="btn small" onClick={() => setForm({ ...form(), models: [...form().models, { id: '', context: 0, tools: true, vision: false, thinking: false }] })} data-testid="model-conf-add">
              <Icon name="plus" size={12} /> {t('Type a model')}
            </button>
          </div>
          <label class="check">
            <input type="checkbox" checked={form().children} onChange={(e) => setForm({ ...form(), children: e.currentTarget.checked })} name="children" />
            {t('Available to sub-agents')}
          </label>
          <Show when={form().children}>
            <label class="field">
              <span>{t('Note for the assistant choosing it (strengths, cost…)')}</span>
              <input value={form().note} onInput={field('note')} placeholder={t('e.g. strong at code, paid')} name="note" />
            </label>
          </Show>
          <Show when={form().kind !== 'llamacpp' && form().kind !== 'openai'}>
            <label class="field">
              <span>{t('Context asked to Ollama (num_ctx, 0 = model default)')}</span>
              <input type="number" min="0" step="1024" value={form().context} onInput={field('context')} class="w-next" name="context" />
            </label>
          </Show>
          <label class="field">
            <span>{t('Conversations at once (the others wait their turn)')}</span>
            <input type="number" min="1" max="16" step="1" value={form().parallel} onInput={field('parallel')} class="w-next" name="parallel" />
          </label>
          <Show when={form().hasKey}>
            <label class="check small">
              <input type="checkbox" checked={form().clearKey} onChange={(e) => setForm({ ...form(), clearKey: e.currentTarget.checked })} />
              {t('Delete the saved key')}
            </label>
          </Show>
          <div class="form-actions">
            <Show when={form().id}>
              <button type="button" class="btn" onClick={() => setForm({ ...blank })}>
                {t('Cancel')}
              </button>
            </Show>
            <button class="btn primary" disabled={busy()}>
              {form().id ? t('Save') : t('Add')}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
