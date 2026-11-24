import { createUniqueId, Show, type JSX } from 'solid-js'
import { api, errorToast, Icon, t } from './plugin'

export function ServiceRow(props: {
  name: string; pod: string; checked: boolean; disabled: boolean; checking: boolean
  reason: string; url?: string; canOpen: boolean; action: string
  testID: string; checkID: string; reasonID: string; expanded: boolean
  toggle: (on: boolean) => Promise<unknown>; expand: () => void; children: JSX.Element
}) {
  const description = createUniqueId()
  const state = () => props.checking ? 'checking' : !props.checked ? 'off' : props.reason ? 'unavailable' : 'ready'
  const status = () => props.reason || (props.checked ? t('Available') : t('off'))
  return (
    <div class="svc-row" classList={{ off: !props.checked, unavailable: !!props.reason && !props.checking }} data-testid={props.testID}>
      <div class="svc-line">
        <input class="svc-check" type="checkbox" checked={props.checked} disabled={props.disabled}
          data-state={state()} aria-label={props.name + ' · ' + props.action} aria-describedby={description}
          title={props.action} data-testid={props.checkID} onChange={(e) => {
            const on = e.currentTarget.checked
            const input = e.currentTarget
            void props.toggle(on).catch((error) => {
              input.checked = props.checked
              errorToast(error)
            })
          }} />
        <div class="svc-title">
          <strong>{props.name}</strong>
          <span id={description} class={props.reason && !props.checking ? 'muted small' : 'sr-only'} role="status" data-testid={props.reason ? props.reasonID : undefined}>{status()}</span>
        </div>
        <span class="badge pod-badge">{props.pod}</span>
        <span class="svc-address-actions">
          <Show when={props.url && props.canOpen} fallback={
            <button class="icon-btn small" disabled aria-label={t('Open in new tab')} title={t('Open in new tab')} data-testid="service-open"><Icon name="external" size={13} /></button>
          }>
            <a class="icon-btn small" href={props.url} target="_blank" rel="noreferrer" aria-label={t('Open in new tab')} title={t('Open in new tab')} data-testid="service-open"><Icon name="external" size={13} /></a>
          </Show>
          <button class="icon-btn small" disabled={!props.url} aria-label={t('Copy URL')} title={t('Copy URL')} data-testid="service-copy-url"
            onClick={() => props.url && void api.ui.copyText(props.url).catch(errorToast)}><Icon name="copy" size={13} /></button>
          <button class="icon-btn small" aria-expanded={props.expanded} aria-label={t('Settings')} title={t('Settings')} data-testid="service-details" onClick={props.expand}><Icon name="more" size={13} /></button>
        </span>
      </div>
      <Show when={props.expanded}>{props.children}</Show>
    </div>
  )
}

export const localBrowser = () => api.podPath('/') === '/' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
