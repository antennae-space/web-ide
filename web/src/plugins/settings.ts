// The settings of a plugin (contributes.settings of its manifest, #151): kept in the synced
// settings under pluginSettings.<id>, read with their defaults.
import { settings, updateSettings } from '../state/settings'
import type { PluginManifest, PluginSetting } from './types'

/** Its values: the user's, the defaults elsewhere (only the keys its manifest declares). */
export function pluginSettingValues(m: PluginManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const own = settings.pluginSettings[m.id] ?? {}
  for (const [k, p] of Object.entries(m.contributes.settings?.properties ?? {})) {
    if (k in own) out[k] = own[k]
    else if (p.default !== undefined) out[k] = p.default
  }
  return out
}

/** A value the plugin edits on its own page (a list, what contributes.settings cannot hold). */
export const pluginStored = (id: string, key: string): unknown => settings.pluginSettings[id]?.[key]

export function setPluginStored(id: string, key: string, value: unknown, label = '') {
  updateSettings((s) => {
    s.pluginSettings[id] = { ...(s.pluginSettings[id] ?? {}), [key]: value }
  }, label)
}

/** Sets one value, checked against its declaration. */
export function setPluginSetting(m: PluginManifest, key: string, p: PluginSetting, value: unknown) {
  if (p.type === 'boolean') value = !!value
  else if (p.type === 'number') value = Number(value)
  else value = String(value)
  if (p.enum && !p.enum.includes(value as string)) return
  updateSettings((s) => {
    s.pluginSettings[m.id] = { ...(s.pluginSettings[m.id] ?? {}), [key]: value }
  }, `${m.name}: ${p.title}`)
}
