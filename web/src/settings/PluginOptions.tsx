// Settings > Plugins, under a plugin's row (#151): its own settings (contributes.settings), and
// what the AI may do with its actions that write, per target the plugin declared (read only by
// default). The plugin cannot set the AI's access: only this screen does.
import { createResource, For, Show } from 'solid-js'
import { request } from '../pod/rpc'
import { pluginSettingValues, setPluginSetting } from '../plugins/settings'
import type { PluginState } from '../plugins/types'
import { settings, updateSettings } from '../state/settings'
import { t } from '../i18n'

export function PluginSettingsForm(props: { s: PluginState }) {
  const m = () => props.s.manifest
  const entries = () => Object.entries(m().contributes.settings?.properties ?? {})
  return (
    <Show when={entries().length}>
      <div class="plugin-settings" data-testid={`plugin-settings-${m().id}`}>
        <For each={entries()}>
          {([key, p]) => {
            const value = () => pluginSettingValues(m())[key]
            const id = `plugin-setting-${m().id}-${key}`
            return (
              <label class="plugin-setting" title={p.description}>
                <Show
                  when={p.type === 'boolean'}
                  fallback={
                    <>
                      <span>{p.title}</span>
                      <Show
                        when={p.enum}
                        fallback={
                          <input
                            data-testid={id}
                            type={p.type === 'number' ? 'number' : 'text'}
                            value={String(value() ?? '')}
                            onChange={(e) => setPluginSetting(m(), key, p, e.currentTarget.value)}
                          />
                        }>
                        <select data-testid={id} value={String(value() ?? '')} onChange={(e) => setPluginSetting(m(), key, p, e.currentTarget.value)}>
                          <For each={p.enum}>{(o) => <option value={o}>{o}</option>}</For>
                        </select>
                      </Show>
                    </>
                  }>
                  <input data-testid={id} type="checkbox" checked={!!value()} onChange={(e) => setPluginSetting(m(), key, p, e.currentTarget.checked)} />
                  <span>{p.title}</span>
                </Show>
                <Show when={p.description}>
                  <span class="muted small">{p.description}</span>
                </Show>
              </label>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

const levels = () => [
  { id: 'read', label: t('Read only') },
  { id: 'ask', label: t('Ask me') },
  { id: 'write', label: t('Allowed') },
]

/** What the AI may change through the plugin, per target. */
export function PluginAIAccess(props: { s: PluginState }) {
  const m = () => props.s.manifest
  const writes = () => (m().contributes.actions ?? []).some((a) => a.access === 'write')
  // Asked again at each new state of the plugin (plugins.changed: its backend declared targets).
  const [targets] = createResource(
    () => (writes() && props.s.external?.installed ? props.s : undefined),
    (s) => request<{ id: string; label: string }[]>('plugins.aiTargets', { id: s.manifest.id }).catch(() => []),
  )
  const level = (target: string) => settings.pluginAI[m().id]?.[target] ?? 'read'
  const set = (target: string, v: string) =>
    updateSettings((s) => {
      s.pluginAI[m().id] = { ...(s.pluginAI[m().id] ?? {}), [target]: v as 'read' | 'ask' | 'write' }
    }, t('{name}: AI access', { name: m().name }))
  return (
    <Show when={writes()}>
      <div class="plugin-ai" data-testid={`plugin-ai-${m().id}`}>
        <span class="muted small">{t('AI access: what the assistant and the agents may change through {name}.', { name: m().name })}</span>
        <For each={targets() ?? []} fallback={<span class="muted small">{t('Nothing declared yet: read only.')}</span>}>
          {(target) => (
            <label class="plugin-setting">
              <span>{target.label || target.id}</span>
              <select data-testid={`plugin-ai-${m().id}-${target.id}`} value={level(target.id)} onChange={(e) => set(target.id, e.currentTarget.value)}>
                <For each={levels()}>{(l) => <option value={l.id}>{l.label}</option>}</For>
              </select>
            </label>
          )}
        </For>
      </div>
    </Show>
  )
}
