// The Language servers plugin's door to the core: the api given at activation, its state in the
// desk (the tab of the Problems tool, the choices and the folded symbols of Structure), and the
// parts of the api the components use by name. Nothing here imports the core itself.
import type { JSX } from 'solid-js'
import type { PluginApi } from '@ide/api'

export let api: PluginApi

export interface LanguagesDesk extends Record<string, unknown> {
  /** The tab of the Problems tool. */
  tab: 'problems' | 'output'
  /** Order of the Structure tree: the order of the file, alphabetical at every level, or exported first. */
  structureSort: 'file' | 'alpha' | 'export'
  /** Structure: the private symbols are shown (unchecked: they and their children are hidden). */
  showPrivate: boolean
  /** Structure: one click jumps to the symbol instead of only selecting it. */
  singleClick: boolean
  /** Structure: the row of the symbol around the caret stays selected (the opened element). */
  selectOpened: boolean
  /** Structure: the symbols of the whole package (the files of the folder of the active file). */
  showPackage: boolean
  /** Structure: the ids (symbolId) of the folded symbols of each file. */
  folded: Record<string, string[]>
}

export let desk: ReturnType<typeof deskOf>
const deskOf = (a: PluginApi) =>
  a.desk<LanguagesDesk>({ tab: 'problems', structureSort: 'file', showPrivate: true, singleClick: false, selectOpened: false, showPackage: false, folded: {} })

export function bindApi(a: PluginApi) {
  api = a
  desk = deskOf(a)
}

export const t: PluginApi['t'] = (...a) => api.t(...a)
export const Icon = (p: Parameters<PluginApi['ui']['Icon']>[0]): JSX.Element => api.ui.Icon(p)
export const EmptyState = (p: Parameters<PluginApi['ui']['EmptyState']>[0]): JSX.Element => api.ui.EmptyState(p)
export const toast: PluginApi['ui']['toast'] = (...a) => api.ui.toast(...a)
export const contextMenu: PluginApi['ui']['contextMenu'] = (...a) => api.ui.contextMenu(...a)
export const prompt: PluginApi['ui']['prompt'] = (...a) => api.ui.prompt(...a)
export const pick: PluginApi['ui']['pick'] = (...a) => api.ui.pick(...a)
export const fuzzy: PluginApi['ui']['fuzzy'] = (...a) => api.ui.fuzzy(...a)
