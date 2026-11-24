// The services this pod shares (docs/design/relay.md, *Services*), on the home page: an HTTP
// service of this machine (127.0.0.1:<port>) the other pods of the account reach, with its switch,
// and the pods attached to it, each with Cut.
import { createResource, createSignal, For, onCleanup, Show } from 'solid-js'
import { api, errorToast, Icon, t } from './plugin'
import { createInventory, healthReason, type Health } from './inventory'
import { ServiceRow, localBrowser } from './ServiceRow'
import { RouteBadge, type Route } from './RouteBadge'
import { LinkedServices } from './LinkedServices'
import './services.css'

type Attached = { key: string; name: string; since: number; last?: number; requests: number; bytes: number; route?: Route }
type Service = { id: string; name: string; port: number; enabled: boolean; health?: Health; attached: Attached[] }

/** The form of a new service, or of one edited. */
function ServiceForm(props: { s?: Service; onDone: () => void }) {
  const [name, setName] = createSignal(props.s?.name ?? '')
  const [port, setPort] = createSignal(props.s ? String(props.s.port) : '')
  const save = (e: Event) => {
    e.preventDefault()
    const s = { id: props.s?.id ?? '', name: name(), port: Number(port()), enabled: props.s?.enabled ?? true }
    api.rpc('services.save', s).then(props.onDone, errorToast)
  }
  return (
    <form class="svc-form" data-testid="service-form" onSubmit={save}>
      <label>
        {t('Name')}
        <input class="input" value={name()} placeholder="Ollama" onInput={(e) => setName(e.currentTarget.value)} data-testid="service-name" />
      </label>
      <label>
        {t('Port of this machine')}
        <input class="input port" inputmode="numeric" value={port()} placeholder="11434" onInput={(e) => setPort(e.currentTarget.value)} data-testid="service-port" />
      </label>
      <button class="btn small primary" type="submit" disabled={!name().trim() || !port()} data-testid="service-save">
        {props.s ? t('Save') : t('Share')}
      </button>
      <button class="btn small" type="button" onClick={props.onDone}>
        {t('Cancel')}
      </button>
    </form>
  )
}

export function SharedServices() {
  const inventory = createInventory<Service>('services.list', ({ id, name, enabled, port, health }) => ({ id, name, enabled, port, health, attached: [] }))
  onCleanup(api.on('services.changed', (l: Service[]) => inventory.accept(l)))
  const reason = (s: Service) => s.enabled ? healthReason(s.health) : ''
  const [self] = createResource(() => api.rpc<{ name: string }>('workspace.get'))
  const podName = () => self()?.name || t('this pod')
  const controlsReady = () => !inventory.checking() && !inventory.unavailable()
  const [linksLoading, setLinksLoading] = createSignal(true)
  const [expanded, setExpanded] = createSignal('')
  const [adding, setAdding] = createSignal(false)
  const [editing, setEditing] = createSignal('')
  const toggle = (s: Service, on: boolean) => api.rpc('services.save', { ...s, enabled: on })
  const remove = (s: Service) => {
    if (confirm(t('Stop sharing {name}? The pods using it lose it.', { name: s.name }))) api.rpc('services.delete', { id: s.id }).catch(errorToast)
  }
  const cut = (s: Service, a: Attached) => api.rpc('services.cut', { id: s.id, pod: a.key }).catch(errorToast)
  return (
    <div class="home-services" data-testid="home-services">
      <div class="home-bar">
        <h3 class="home-sub">{t('Services')}</h3>
        <Show when={inventory.loading() || linksLoading()}><span class="spinner svc-loading" role="status" aria-label={t('Loading services…')} title={t('Loading services…')} /></Show>
        <span class="grow" />
        <Show when={!adding()}>
          <button class="btn primary" onClick={() => setAdding(true)} data-testid="service-add">
            <Icon name="plus" size={14} /> {t('Share a service')}
          </button>
        </Show>
      </div>
      <Show when={adding()}>
        <ServiceForm onDone={() => setAdding(false)} />
      </Show>
      <Show when={inventory.unavailable()}>
        <p class="muted small" role="status">{t('Service status unavailable.')}</p>
      </Show>
      <For each={inventory.entries()}>
        {(s) => (
          <Show when={editing() !== s.id} fallback={<ServiceForm s={s} onDone={() => setEditing('')} />}>
            <ServiceRow shared name={s.name} pod={podName()} checked={s.enabled} disabled={!controlsReady()}
              failed={s.health === 'unreachable'} reason={reason(s)} action={s.enabled ? t('Shared from {pod} · Turn off sharing', { pod: podName() }) : t('Share from {pod}', { pod: podName() })}
              url={Number.isInteger(s.port) && s.port > 0 && s.port <= 65535 ? `http://127.0.0.1:${s.port}` : undefined} canOpen={localBrowser() && s.enabled && !reason(s)}
              testID={`service-${s.port || s.id}`} checkID={`service-on-${s.port}`} reasonID="service-health"
              expanded={expanded() === s.id} expand={() => setExpanded(expanded() === s.id ? '' : s.id)} toggle={(on) => toggle(s, on)}>
              <div class="svc-head">
                <span class="mono muted">127.0.0.1:{s.port}</span>
                <button class="icon-btn small" title={t('Edit')} disabled={!controlsReady()} onClick={() => setEditing(s.id)} data-testid={`service-edit-${s.port}`}>
                  <Icon name="edit" size={12} />
                </button>
                <button class="icon-btn small" title={t('Stop sharing')} disabled={!controlsReady()} onClick={() => remove(s)} data-testid={`service-delete-${s.port}`}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              <Show when={s.attached.length}>
                <div class="svc-pods">
                  <For each={s.attached}>
                    {(a) => (
                      <div class="svc-pod" data-testid={`service-pod-${a.name}`}>
                        <span>{a.name}</span>
                        <RouteBadge route={a.route} />
                        <span class="muted small">
                          {t('attached {when}', { when: api.fmtAgo(a.since) })} · {api.tn(a.requests, '{n} request', '{n} requests')} · {api.fmtSize(a.bytes)}
                          <Show when={a.last}> · {t('last request {when}', { when: api.fmtAgo(a.last!) })}</Show>
                        </span>
                        <span class="grow" />
                        <button class="btn small" disabled={!controlsReady()} title={t('Detach this pod: its next request is refused')} onClick={() => cut(s, a)}>
                          {t('Cut')}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </ServiceRow>
          </Show>
        )}
      </For>
      <LinkedServices onLoading={setLinksLoading} />
    </div>
  )
}
