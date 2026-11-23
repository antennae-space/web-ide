// The services of the other pods of the account (docs/design/relay.md, *Services*), on the home
// page: each with a switch that links it to a port of this machine, the route it takes (the LAN
// first, else the relay), its state and what went through it.
import { createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'
import { api, errorToast, t } from './plugin'
import { createInventory, healthReason, type Health } from './inventory'
import { ServiceActions, ServiceStatus } from './ServiceActions'
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

function ServiceLink(props: { pod: RemotePod; s: RemoteService; checking: boolean; unavailable: boolean; manage: boolean }) {
  const reasonID = createUniqueId()
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
    api.rpc('services.link', { pod: props.pod.key, podName: props.pod.name, service: props.s.id, name: props.s.name, port: Number(port()) || 0, scope: scope(), on }).catch(errorToast)
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
  const addressLabel = () => props.manage ? `${scope() === 'lan' ? '0.0.0.0' : '127.0.0.1'}:${l()?.listen}` : t('Open')
  const canOpen = () => !reason()
  const controlsReady = () => !props.checking && !props.unavailable && !props.pod.pending && !props.s.cached
  return (
    <div class="svc-link" classList={{ on: !!l()?.on, off: !!reason() }} data-testid={`link-${props.pod.name}-${props.s.name}`}>
      <div class="svc-head">
        <Show when={props.manage}><input type="checkbox" class="ai-switch" checked={!!l()?.on} disabled={!controlsReady() || (!l()?.on && !!reachability())} aria-describedby={reason() ? reasonID : undefined} onChange={(e) => set(e.currentTarget.checked)} title={l()?.on ? t('Linked: turn off') : t('Link it to a port of this machine')} data-testid="link-on" /></Show>
        <ServiceStatus state={props.checking || props.s.cached || props.s.health === 'checking' ? 'checking' : canOpen() ? 'ready' : 'unavailable'}
          label={reason() || t('Available')} />
        <strong class="svc-name">{props.s.name}</strong>
        <Show when={l()?.on && l()?.listen}>
          <Show when={props.manage || !canOpen()}>
            <Show when={canOpen()} fallback={<span class="mono muted" aria-disabled="true" aria-describedby={reasonID} data-testid="link-address">{addressLabel()}</span>}>
              <a class="mono" href={address()} target="_blank" rel="noreferrer" data-testid="link-address">{addressLabel()}</a>
            </Show>
          </Show>
          <RouteBadge route={l()!.route} />
          <ServiceActions url={address()} canOpen={canOpen()} />
        </Show>
        <Show when={reason()}>
          <span id={reasonID} class="muted small" role="status" data-testid="link-state">{reason()}</span>
        </Show>
        <span class="grow" />
        <Show when={l()?.on && l()!.requests}>
          <span class="muted small">
            {api.tn(l()!.requests, '{n} request', '{n} requests')} · {api.fmtSize(l()!.bytes)}
          </span>
        </Show>
      </div>
      <Show when={props.manage}>
        <div class="svc-opts">
          <label>
            {t('Local port')}
            <input class="input port" disabled={!controlsReady()} inputmode="numeric" placeholder={t('the service’s')} value={port()} onInput={(e) => setPort(e.currentTarget.value)} onChange={() => l()?.on && set(true)} data-testid="link-port" />
          </label>
          <label>
            {t('Reached from')}
            <select class="input" disabled={!controlsReady()} value={scope()} onChange={(e) => (setScope(e.currentTarget.value as 'local' | 'lan'), l()?.on && set(true))} data-testid="link-scope">
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
      </Show>
    </div>
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
  const [managing, setManaging] = createSignal(false)
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
    <div class="home-services" data-testid="home-linked-services" aria-busy={inventory.checking()}>
      <div class="home-bar">
        <h3 class="home-sub">{t('Services of your other pods')}</h3>
        <Show when={pods()?.length}>
          <button class="btn small" aria-expanded={managing()} onClick={() => setManaging(!managing())} data-testid="link-manage">{t('Manage links')}</button>
        </Show>
      </div>
      <Show when={!pods()?.length}>
        <p class="muted small" role="status">{inventory.checking() ? t('Loading services…') : inventory.unavailable() ? t('Service status unavailable.') : t('No shared service from another pod.')}</p>
      </Show>
      <For each={pods()}>
        {(p) => (
          <div class="svc-row" classList={{ off: !p.online }} data-testid={`remote-pod-${p.name}`}>
            <div class="svc-head">
              <span class="pod-dot" classList={{ on: p.online }} />
              <strong>{p.name}</strong>
              <Show when={!inventory.checking() && !inventory.unavailable() && !p.online && !p.pending}>
                <span class="muted small">{t('offline')}</span>
              </Show>
            </div>
            <div class="svc-pods">
              <Show when={!managing() && !inventory.unavailable() && p.services.length > 1 && p.services.every((s) =>
                !s.gone && !s.link?.on && (inventory.checking() || p.pending || (p.online && (s.cached || s.health === 'checking'))))}
                fallback={<For each={p.services}>{(s) => <ServiceLink pod={p} s={s} checking={inventory.checking()} unavailable={inventory.unavailable()} manage={managing()} />}</For>}>
                <span class="muted small" role="status">{t('Checking {n} services…', { n: p.services.length })}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
