import { Show } from 'solid-js'
import { api, errorToast, Icon, t } from './plugin'

export function ServiceStatus(props: { state: 'ready' | 'checking' | 'unavailable'; label: string }) {
  return <span class="svc-status-dot" data-state={props.state} role="img" aria-label={props.label} title={props.label} />
}

export function ServiceActions(props: { url: string; canOpen: boolean }) {
  return (
    <span class="svc-address-actions">
      <Show when={props.canOpen}>
        <a class="icon-btn small" href={props.url} target="_blank" rel="noreferrer" aria-label={t('Open in new tab')} title={t('Open in new tab')} data-testid="service-open">
          <Icon name="external" size={13} />
        </a>
      </Show>
      <button type="button" class="icon-btn small" aria-label={t('Copy URL')} title={t('Copy URL')}
        onClick={() => void api.ui.copyText(props.url).catch(errorToast)} data-testid="service-copy-url">
        <Icon name="copy" size={13} />
      </button>
    </span>
  )
}
