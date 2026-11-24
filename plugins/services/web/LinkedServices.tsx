// The services of the other pods of the account (docs/design/relay.md, *Services*), on the home
// page: each with a switch that links it to a port of this machine, the route it takes (the LAN
// first, else the relay), its state and what went through it.
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
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
type RemoteService = { id: string; name: string; health?: Health; link?: LinkView; lastOn?: boolean; lastLink?: Pick<LinkView, 'on' | 'port' | 'listen' | 'scope' | 'state'>; cached?: boolean; gone?: boolean }
type RemotePod = { key: string; name: string; online: boolean; route: Route; services: RemoteService[]; catalog?: boolean; pending?: boolean }

function stateText(state: LinkView['state'] | undefined, pod: string, port?: number): string {
  switch (state) {
    case 'offline':
      return t('{pod} offline, retrying', { pod })
    case 'cut':
      return t('cut by {pod}', { pod })
    case 'gone':
      return t('no longer shared by {pod}', { pod })
    case 'port-taken':
      return t('port {port} taken on this machine', { port: port ?? 0 })
  }
  return ''
}

function ServiceLink(props: { pod: RemotePod; s: RemoteService; checking: boolean; unavailable: boolean; manage: boolean; expand: () => void }) {
  const reachability = () => {
    if (props.s.gone) return t('no longer shared by {pod}', { pod: props.pod.name })
    if (!props.pod.pending && props.pod.online === false) return t('{pod} offline, retrying', { pod: props.pod.name })
    return props.s.health === 'unreachable' ? healthReason(props.s.health) : ''
  }
  const l = () => props.s.link
  const listener = () => l() ?? props.s.lastLink
  const checked = () => listener()?.on ?? props.s.lastOn ?? false
  const [port, setPort] = createSignal(listener()?.port ? String(listener()!.port) : '')
  const [scope, setScope] = createSignal<'local' | 'lan'>(listener()?.scope ?? 'local')
  const set = (on: boolean) =>
    api.rpc('services.link', { pod: props.pod.key, podName: props.pod.name, service: props.s.id, name: props.s.name, port: Number(port()) || 0, scope: scope(), on })
  const url = () => {
    const link = listener()
    if (!link?.on || !link.listen || !Number.isInteger(link.listen) || link.listen < 1 || link.listen > 65535) return
    return `http://${link.scope === 'lan' ? location.hostname : '127.0.0.1'}:${link.listen}`
  }
  const failure = () => {
    const link = listener()
    // An existing listener tries its route again on the next request. Once the
    // pod is back online, a failure from an earlier request cannot block it.
    const state = link?.state
    if (state === 'offline' && link?.listen && props.pod.online) return reachability()
    return stateText(state, props.pod.name, link?.port) || reachability()
  }
  const controlsReady = () => !props.checking && !props.unavailable && !props.pod.pending && !props.s.cached
  return (
    <ServiceRow name={props.s.name} pod={props.pod.name} checked={checked()}
      disabled={!controlsReady() || (!checked() && (!props.pod.online || props.s.gone === true))}
      failed={!!failure()} reason={failure() || healthReason(props.s.health)} url={url()}
      canOpen={localBrowser() || (listener()?.scope === 'lan' && api.podPath('/') === '/')}
      action={checked() ? t('Forward to {pod} · Turn off forwarding', { pod: props.pod.name }) : t('Turn on forwarding to {pod}', { pod: props.pod.name })}
      testID={`link-${props.pod.name}-${props.s.name}`} checkID="link-on" reasonID="link-state"
      expanded={props.manage} expand={props.expand} toggle={set}>
      <Show when={url() && l()}>
        <div class="svc-head">
          <span class="mono muted" data-testid="link-address">{url()}</span>
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

function serviceSnapshot(s: RemoteService) {
  const link = s.link ?? s.lastLink
  const lastLink = link && { on: link.on, port: link.port, listen: link.listen, scope: link.scope, state: link.state }
  return { id: s.id, name: s.name, health: s.health, gone: s.gone, lastLink }
}

// The directory can answer before it has read an advertisement from a known pod.
function keepUndiscovered(received: RemotePod[], previous: RemotePod[]) {
  const pods = new Map(received.map((pod) => [pod.key, pod]))
  for (const old of previous) {
    const pod = pods.get(old.key)
    if (pod?.catalog) continue
    const missing = old.services
      .filter((s) => !pod?.services.some((known) => known.id === s.id))
      .map((s) => ({ id: s.id, name: s.name, health: s.health, cached: true }))
    if (missing.length) {
      pods.set(old.key, pod ? { ...pod, services: [...pod.services, ...missing] } : { ...old, online: false, pending: true, services: missing })
    }
  }
  return [...pods.values()]
}

export function LinkedServices(props: { onLoading: (loading: boolean) => void }) {
  const [expanded, setExpanded] = createSignal('')
  const discoveryEnds = Date.now() + 15_000
  const inventory = createInventory<RemotePod>('services.remote', ({ key, name, online, services }) => ({
    key, name, online, services: services.map(serviceSnapshot),
  }), {
    params: { catalog: true },
    reconcile: (received, previous) => Date.now() < discoveryEnds ? keepUndiscovered(received, previous) : received,
  })
  const pods = () => inventory.entries()?.filter((pod) => pod.services.length)
  createEffect(() => props.onLoading(inventory.loading() || !!pods()?.some((p) => p.pending || p.services.some((s) => s.cached))))
  // A slow directory reply still counts. Coalesce changes that arrive while it is in flight.
  let changedWhileLoading = false
  const changed = () => {
    if (inventory.loading()) changedWhileLoading = true
    else inventory.refetch()
  }
  createEffect(() => {
    if (!inventory.loading() && changedWhileLoading) {
      changedWhileLoading = false
      inventory.refetch()
    }
  })
  onCleanup(api.on('services.links', changed))
  onCleanup(api.on('pods.changed', changed))
  const timer = setInterval(() => { if (!inventory.loading()) inventory.refetch() }, 5000)
  onCleanup(() => clearInterval(timer))
  return (
    <div class="linked-services" data-testid="home-linked-services" aria-busy={inventory.checking()}>
      <Show when={inventory.unavailable()}><p class="muted small">{t('Service status unavailable.')}</p></Show>
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
