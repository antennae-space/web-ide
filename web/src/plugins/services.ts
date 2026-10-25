// The services of the external plugins (docs/design/plugins.md, *Services between external
// plugins*, #155): a capability an external plugin provides is served by its background frame
// (external.tsx) to the frames of the external plugins requiring it (ide.use), as calls, values
// it publishes and events it emits; and to the core through an adapter (registerAdapter), which
// makes it capability(name). An external plugin never reaches a built-in's service this way.
import { createMutable } from 'solid-js/store'
import { t } from '../i18n'
import { pluginEnabled, provide, type Capabilities } from './capabilities'
import type { SandboxModalSize } from './sandbox-api'
import { bridgeFor } from './bridges'

/** A capability served by an external plugin, as its consumers see it. */
export interface ExternalService {
  provider: string
  call(method: string, args: unknown[]): Promise<unknown>
  /** A value it published (reactive). */
  value(key: string): unknown
  values(): Record<string, unknown>
  on(f: (event: string, data: unknown) => void): () => void
  onValue(f: (key: string, value: unknown) => void): () => void
}

// A capability's channel: its provider ("" until one serves it), and who listens to it (a
// frame may watch it before its provider's background frame is up).
type Channel = {
  provider: string
  call?: (method: string, args: unknown[]) => Promise<unknown>
  events: Set<(event: string, data: unknown) => void>
  watchers: Set<(key: string, value: unknown) => void>
}

const channels: Record<string, Channel> = {}
// The values published, by capability: a store, so the core's adapters are reactive.
const values = createMutable<Record<string, Record<string, unknown>>>({})
const adapters: Partial<{ [K in keyof Capabilities]: (svc: ExternalService) => Capabilities[K] }> = {}

const channel = (name: string) => (channels[name] ??= { provider: '', events: new Set(), watchers: new Set() })

/** The core's adapter of a capability an external plugin may provide (tickets, #158). */
export function registerAdapter<K extends keyof Capabilities>(name: K, make: (svc: ExternalService) => Capabilities[K]) {
  adapters[name] = make as never
}

const missing = (name: string) => new Error(t('nothing provides {name} on this project', { name }))

function service(name: string): ExternalService {
  const c = channel(name)
  return {
    get provider() {
      return c.provider
    },
    call: (method, args) => (c.call && pluginEnabled(c.provider) ? c.call(method, args) : Promise.reject(missing(name))),
    value: (key) => values[name]?.[key],
    values: () => values[name] ?? {},
    on: (f) => (c.events.add(f), () => c.events.delete(f)),
    onValue: (f) => (c.watchers.add(f), () => c.watchers.delete(f)),
  }
}

/** The background frame of an external plugin serves a capability of its manifest. */
export function serve(name: string, provider: string, call: (method: string, args: unknown[]) => Promise<unknown>) {
  const c = channel(name)
  c.provider = provider
  c.call = call
  values[name] ??= {}
  const make = adapters[name as keyof Capabilities]
  if (make) provide(provider, name as keyof Capabilities, make(service(name)) as never)
}

/** What a frame of provider publishes of a capability it serves. */
export function publish(provider: string, name: string, key: string, value: unknown) {
  const c = channels[name]
  if (!c || c.provider !== provider) return
  values[name][key] = value
  c.watchers.forEach((f) => f(key, value))
}

/** An event of a capability, emitted by a frame of its provider. */
export function emit(provider: string, name: string, event: string, data: unknown) {
  const c = channels[name]
  if (c?.provider === provider) c.events.forEach((f) => f(event, data))
}

/**
 * The service a frame of a plugin may use: a capability its manifest requires (an error text
 * otherwise). Its calls fail while no enabled external plugin serves it.
 */
export function use(plugin: { name: string; requires: string[]; grants: string[] }, name: string): ExternalService | string {
  if (!plugin.requires.includes(name)) return t('{plugin} does not require {name}', { plugin: plugin.name, name })
  // A capability of a built-in: its bridge, with its grant (#167).
  if (!servedBy(name)) {
    const b = bridgeFor(name)
    if (b) return plugin.grants.includes('use:' + name) ? b : t('{method} is not granted to {name}', { method: 'use:' + name, name: plugin.name })
  }
  return service(name)
}

/** Who serves a capability now ("" for nobody), an enabled external plugin. */
export function servedBy(name: string): string {
  const p = channels[name]?.provider ?? ''
  return p && pluginEnabled(p) ? p : ''
}

type ModalOpener = (view: string, state: unknown, title: string, size: SandboxModalSize) => Promise<unknown>
const modalOpeners: Record<string, ModalOpener> = {}

/** The modal views of an external plugin, opened for another (setModalOpener at its load). */
export function setModalOpener(plugin: string, open: ModalOpener) {
  modalOpeners[plugin] = open
}

/**
 * A modal view of another plugin, which provides a capability the caller requires (the doodle
 * drawn for the assistant).
 */
export function openModalOf(requires: string[], plugin: string, view: string, state: unknown, title: string, size: SandboxModalSize): Promise<unknown> {
  const provides = requires.some((name) => channels[name]?.provider === plugin)
  const open = modalOpeners[plugin]
  if (!provides || !open || !pluginEnabled(plugin)) return Promise.reject(new Error(t('{name} has no such modal view', { name: plugin })))
  return open(view, state, title, size)
}
