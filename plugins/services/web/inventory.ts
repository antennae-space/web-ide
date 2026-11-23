import { createResource } from 'solid-js'
import { api, t } from './plugin'

export type Health = 'checking' | 'ready' | 'unreachable'

function cacheKey(method: string) {
  // Local storage already scopes to the origin. On the relay or LAN gateway the
  // path also identifies the entry pod.
  return `web-ide:inventory:${api.podPath('/')}:${method}`
}

function cached<T>(key: string): T[] | undefined {
  try {
    const snapshot: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return Array.isArray(snapshot) ? snapshot : undefined
  } catch {
    return undefined
  }
}

export function createInventory<T>(method: string, snapshot: (entry: T) => unknown, options?: {
  params?: Record<string, unknown>
  reconcile?: (received: T[], previous: T[]) => T[]
}) {
  const key = cacheKey(method)
  const initial = cached<T>(key)
  const remember = (entries: T[]) => {
    try {
      const next = JSON.stringify(entries.map(snapshot))
      if (localStorage.getItem(key) !== next) localStorage.setItem(key, next)
    } catch {
      // The browser can disable storage.
    }
    return entries
  }
  type State = { entries?: T[]; unavailable: boolean }
  const [resource, { mutate, refetch }] = createResource<State>(async (_, { value }) => {
    try {
      const received = await api.rpc<T[]>(method, options?.params)
      const entries = options?.reconcile?.(received, value?.entries ?? initial ?? []) ?? received
      return { entries: remember(entries), unavailable: false }
    } catch {
      return { entries: value?.entries ?? initial, unavailable: true }
    }
  })
  return {
    entries: (): T[] | undefined => resource.latest?.entries ?? initial,
    checking: () => !resource.latest,
    unavailable: () => !!resource.latest?.unavailable,
    accept: (entries: T[]) => mutate({ entries: remember(entries), unavailable: false }),
    refetch,
  }
}

export function healthReason(health?: Health) {
  if (health === 'checking') return t('Checking…')
  if (health === 'unreachable') return t('The service did not respond.')
  return ''
}
