import { createSignal, createUniqueId, Show, type JSX } from 'solid-js'
import { api, errorToast, Icon, t } from './plugin'

export function ServiceRow(props: {
  name: string; pod: string; shared?: boolean; checked: boolean; disabled: boolean
  reason: string; url?: string; canOpen: boolean; action: string
  testID: string; checkID: string; reasonID: string; expanded: boolean
  toggle: (on: boolean) => Promise<unknown>; expand: () => void; children: JSX.Element
}) {
  const description = createUniqueId()
  const [switching, setSwitching] = createSignal(false)
  const state = () => switching() ? 'checking' : !props.checked ? 'off' : 'ready'
  return (
    <div class="svc-row" classList={{ off: !props.checked, unavailable: !!props.reason }} data-testid={props.testID}>
      <div class="svc-line">
        <input class="svc-check" classList={{ 'svc-share': props.shared }} type="checkbox" checked={props.checked} disabled={props.disabled || switching()}
          data-state={state()} aria-label={props.name + ' · ' + props.action} aria-describedby={props.reason ? description : undefined} aria-busy={switching()}
          title={props.action} data-testid={props.checkID} onChange={(e) => {
            const on = e.currentTarget.checked
            const input = e.currentTarget
            setSwitching(true)
            void props.toggle(on).catch((error) => {
              input.checked = props.checked
              errorToast(error)
            }).finally(() => setSwitching(false))
          }} />
        <div class="svc-title">
          <strong>{props.name}</strong>
          <Show when={props.reason}>
            <details class="svc-health" data-testid={props.reasonID}>
              <summary aria-label={props.reason} title={props.reason}><Icon name="info" size={13} /></summary>
              <span>{props.reason}</span>
            </details>
            <span id={description} class="sr-only">{props.reason}</span>
          </Show>
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
