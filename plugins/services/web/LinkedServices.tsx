// The services of the other pods of the account (docs/design/relay.md, *Services*), on the home
// page: each with a switch that links it to a port of this machine, the route it takes (the LAN
// first, else the relay), its state and what went through it.
import { createSignal, For, onCleanup, Show } from 'solid-js'
import { api, errorToast, t } from './plugin'
import { createInventory, healthReason, type Health } from './inventory'
import { ServiceRow, localBrowser } from './ServiceRow'
import { RouteBadge, type Route } from './RouteBadge'

type LinkView = {
  id: string
  pod: string
  podName: string
  service: string
  name: string
  port: number
  scope: 'local' | 'lan'
  on: boolean
  state: 'off' | 'on' | 'offline' | 'cut' | 'gone' | 'port-taken'
  listen?: number
  route: Route
  requests: number
  bytes: number
}
type RemoteService = { id: string; name: string; health?: Health; link?: LinkView; cached?: boolean; gone?: boolean }
type RemotePod = { key: string; name: string; online: boolean; route: Route; services: RemoteService[]; catalog?: boolean; pending?: boolean }

function stateText(l: LinkView): string {
  switch (l.state) {
    case 'offline':
      return t('{pod} offline, retrying', { pod: l.podName })
    case 'cut':
      return t('cut by {pod}', { pod: l.podName })
    case 'gone':
      return t('no longer shared by {pod}', { pod: l.podName })
    case 'port-taken':
      return t('port {port} taken on this machine', { port: l.port })
  }
  return ''
}

function ServiceLink(props: { pod: RemotePod; s: RemoteService; checking: boolean; unavailable: boolean; manage: boolean; expand: () => void }) {
  const reachability = () => {
    if (props.unavailable) return t('Service status unavailable.')
    if (props.checking || props.pod.pending) return t('Checking…')
    if (props.s.gone) return t('no longer shared by {pod}', { pod: props.pod.name })
    if (!props.pod.online) return t('{pod} offline, retrying', { pod: props.pod.name })
    return healthReason(props.s.cached ? 'checking' : props.s.health)
  }
  const l = () => props.s.link
  const [port, setPort] = createSignal(l()?.port ? String(l()!.port) : '')
  const [scope, setScope] = createSignal<'local' | 'lan'>(l()?.scope ?? 'local')
  const set = (on: boolean) =>
    api.rpc('services.link', { pod: props.pod.key, podName: props.pod.name, service: props.s.id, name: props.s.name, port: Number(port()) || 0, scope: scope(), on })
  const address = () => `http://${scope() === 'lan' ? location.hostname : '127.0.0.1'}:${l()?.listen}`
  const reason = () => {
    const link = l()
    // An existing listener tries its route again on the next request. Once the
    // pod is back online, a failure from an earlier request cannot block it.
    if (link && !(link.state === 'offline' && link.listen && props.pod.online)) {
      return stateText(link) || reachability()
    }
    return reachability()
  }
  const controlsReady = () => !props.checking && !props.unavailable && !props.pod.pending && !props.s.cached
  const url = () => l()?.on && l()?.listen ? address() : undefined
  return (
    <ServiceRow name={props.s.name} pod={props.pod.name} checked={!!l()?.on}
      disabled={!controlsReady() || (!l()?.on && !!reachability())}
      checking={reason() === t('Checking…')} reason={reason()} url={url()}
      canOpen={!reason() && (localBrowser() || (scope() === 'lan' && api.podPath('/') === '/'))}
      action={l()?.on ? t('Linked: turn off') : t('Link it to a port of this machine')}
      testID={`link-${props.pod.name}-${props.s.name}`} checkID="link-on" reasonID="link-state"
      expanded={props.manage} expand={props.expand} toggle={set}>
      <Show when={url()}>
        <div class="svc-head">
          <span class="mono muted" data-testid="link-address">{address()}</span>
          <RouteBadge route={l()!.route} />
          <span class="small muted">{api.tn(l()!.requests, '{n} request', '{n} requests')} · {api.fmtSize(l()!.bytes)}</span>
        </div>
      </Show>
      <div class="svc-opts">
        <label>
          {t('Local port')}
          <input class="input port" disabled={!controlsReady()} inputmode="numeric" placeholder={t('the service’s')} value={port()} onInput={(e) => setPort(e.currentTarget.value)} onChange={() => l()?.on && set(true).catch(errorToast)} data-testid="link-port" />
        </label>
        <label>
          {t('Reached from')}
          <select class="input" disabled={!controlsReady()} value={scope()} onChange={(e) => (setScope(e.currentTarget.value as 'local' | 'lan'), l()?.on && set(true).catch(errorToast))} data-testid="link-scope">
            <option value="local">{t('This machine')}</option>
            <option value="lan">{t('The local network')}</option>
          </select>
        </label>
        <Show when={scope() === 'lan'}>
          <span class="warn small">{t('Any machine of the local network reaches this service, without authentication.')}</span>
        </Show>
        <Show when={l() && !l()!.on}>
          <button class="btn small" disabled={!controlsReady()} onClick={() => api.rpc('services.forget', { id: l()!.id }).catch(errorToast)}>
            {t('Forget')}
          </button>
        </Show>
      </div>
    </ServiceRow>
  )
}

// The directory can answer before it has read an advertisement from a known pod.
function keepUndiscovered(received: RemotePod[], previous: RemotePod[]) {
  const pods = new Map(received.map((pod) => [pod.key, pod]))
  for (const old of previous) {
    const pod = pods.get(old.key)
    if (pod?.catalog) continue
    const missing = old.services
      .filter((s) => !pod?.services.some((known) => known.id === s.id))
      .map(({ id, name }) => ({ id, name, cached: true }))
    if (missing.length) {
      pods.set(old.key, pod ? { ...pod, services: [...pod.services, ...missing] } : { ...old, online: false, pending: true, services: missing })
    }
  }
  return [...pods.values()]
}

export function LinkedServices() {
  const [expanded, setExpanded] = createSignal('')
  const discoveryEnds = Date.now() + 15_000
  const inventory = createInventory<RemotePod>('services.remote', ({ key, name, services }) => ({
    key, name, services: services.map((s) => ({ id: s.id, name: s.name })),
  }), {
    params: { catalog: true },
    reconcile: (received, previous) => Date.now() < discoveryEnds ? keepUndiscovered(received, previous) : received,
  })
  const pods = () => inventory.entries()?.filter((pod) => pod.services.length)
  onCleanup(api.on('services.links', () => inventory.refetch()))
  onCleanup(api.on('pods.changed', () => inventory.refetch()))
  // The route moves by itself (the LAN link comes and goes, a tunnel goes idle).
  const timer = setInterval(inventory.refetch, 5000)
  onCleanup(() => clearInterval(timer))
  return (
    <div data-testid="home-linked-services" aria-busy={inventory.checking()}>
      <Show when={inventory.unavailable() && !pods()?.length}><p class="muted small">{t('Service status unavailable.')}</p></Show>
      <For each={pods()}>{(p) =>
        <For each={p.services}>{(s) => {
          const key = JSON.stringify([p.key, s.id])
          return <ServiceLink pod={p} s={s} checking={inventory.checking()} unavailable={inventory.unavailable()}
            manage={expanded() === key} expand={() => setExpanded(expanded() === key ? '' : key)} />
        }}</For>
      }</For>
    </div>
  )
}
