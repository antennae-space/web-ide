// The Debug plugin's door to the core: the api given at activation and the parts of it the
// components use by name. Nothing here imports the core itself.
import type { JSX } from 'solid-js'
import type { PluginApi } from '@ide/api'

export let api: PluginApi

export function bindApi(a: PluginApi) {
  api = a
}

export const t: PluginApi['t'] = (...a) => api.t(...a)
export const Icon = (p: Parameters<PluginApi['ui']['Icon']>[0]): JSX.Element => api.ui.Icon(p)
export const EmptyState = (p: Parameters<PluginApi['ui']['EmptyState']>[0]): JSX.Element => api.ui.EmptyState(p)
export const toast: PluginApi['ui']['toast'] = (...a) => api.ui.toast(...a)
export const errorToast: PluginApi['ui']['errorToast'] = (...a) => api.ui.errorToast(...a)

/** The values of the plugin's settings (plugin.json: show_on_stop, keep_open_at_end). */
export const setting = (key: 'show_on_stop' | 'keep_open_at_end'): boolean => !!api.settings.values()[key]

/** A path of the worktree shown as the pod names it (relative), or undefined outside of it. */
export function relOf(path: string): string | undefined {
  const root = api.project.root()
  if (!root) return undefined
  if (path.startsWith(root + '/')) return path.slice(root.length + 1)
  return path.startsWith('/') ? undefined : path
}

/** The absolute path of a path of the worktree. */
export const absOf = (rel: string) => (rel.startsWith('/') ? rel : `${api.project.root()}/${rel}`)
