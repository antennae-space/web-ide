// The Search plugin's door to the core: the api given at activation, and t() by name.
import type { JSX } from 'solid-js'
import type { PluginApi } from '@ide/api'

export let api: PluginApi

export function bindApi(a: PluginApi) {
  api = a
}

export const t: PluginApi['t'] = (...a) => api.t(...a)
export const FileRow = (p: Parameters<PluginApi['ui']['FileRow']>[0]): JSX.Element => api.ui.FileRow(p)
