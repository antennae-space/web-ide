// The external plugins of Settings > Plugins (docs/design/plugins.md, *Phase 3*): install one
// from its git repository and a version constraint, accept its permissions one by one, update
// it (a new permission is asked again), remove it. Pod-wide: the lock is the pod's.
import { createEffect, createSignal, For, on, Show } from 'solid-js'
import { request } from '../pod/rpc'
import { pluginStates, setPluginEnabled } from '../plugins/registry'
import type { PluginManifest, PluginState } from '../plugins/types'
import { Modal } from '../ui/overlay'
import { errorToast, toast } from '../ui/toast'
import { t } from '../i18n'

/** A version resolved by the pod, with the permissions to accept. */
type Resolved = { url: string; tag: string; version: string; manifest: PluginManifest; grants: string[] }

/** What a permission lets the plugin do, as the dialog says it. */
function grantText(g: string): string {
  if (g.startsWith('core:')) return t('Call {method} of the IDE', { method: g.slice(5) })
  if (g.startsWith('program:')) return t('Run {program} (a language server, confined)', { program: g.slice(8) })
  if (g.startsWith('exec:')) return t('Run {program} on the host of an SSH project (not confined there)', { program: g.slice(5) })
  if (g.startsWith('path:')) return t('Use the folder {name} of this machine', { name: g.slice(5) })
  return (
    {
      'files:read': t('Read the files of the project'),
      'files:write': t('Change the files of the project'),
      net: t('Reach the network'),
      exec: t('Run programs'),
      dial: t('Connect where you allow it, through the IDE'),
      ssh: t('Open SSH tunnels with your keys'),
      vault: t('Keep its secrets in the vault'),
      'socket:docker': t('Use Docker: as much as root on this machine (or the host of an SSH project)'),
      terminal: t('Open terminals in the IDE'),
      notify: t('Send you notifications'),
      git: t('Run git in the project with your keys (fetch, push; its hooks run)'),
      gh: t('Open pull requests with gh'),
      worktrees: t('Add and remove the worktrees of the project, and run their setup commands'),
      'use:assistant': t('Start and drive conversations of the assistant'),
      'use:agents': t('Show the sessions of the agents and give them tickets'),
      'use:terminal': t('Run commands in consoles of the IDE (as much as you)'),
    }[g] ?? g
  )
}

/** A button's text while the pod works: git and the downloads take seconds. */
function Working(props: { busy: boolean; label: string; text: string }) {
  return (
    <Show when={props.busy} fallback={props.label}>
      <span class="spinner" /> {props.text}
    </Show>
  )
}

/**
 * The grants dialog: each permission is a checkbox, none checked (Accept all ticks them at
 * once); the plugin gets the ones the user accepted.
 */
function GrantsDialog(props: { title: string; resolved: Resolved; action: string; working: string; onClose: () => void; onAccept: (grants: string[]) => Promise<void> }) {
  const [accepted, setAccepted] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)
  const toggle = (g: string, on: boolean) => setAccepted((l) => (on ? [...l, g] : l.filter((x) => x !== g)))
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      class="plugin-grants"
      footer={
        <>
          <button onClick={props.onClose}>{t('Cancel')}</button>
          <button
            class="primary"
            data-testid="plugin-grants-accept"
            disabled={busy()}
            onClick={() => {
              setBusy(true)
              props.onAccept(accepted()).then(props.onClose, (e) => (setBusy(false), errorToast(e)))
            }}>
            <Working busy={busy()} label={props.action} text={props.working} />
          </button>
        </>
      }>
      <p>
        <strong>{props.resolved.manifest.name}</strong> {props.resolved.version} <span class="muted small">{props.resolved.url}</span>
      </p>
      <Show when={props.resolved.grants.length} fallback={<p class="muted">{t('It asks no permission.')}</p>}>
        <p class="muted small">{t('It asks these permissions. Accept each one you grant it; it gets nothing else.')}</p>
        <Show when={props.resolved.grants.length > 1}>
          <label class="check">
            <input
              type="checkbox"
              data-testid="plugin-grants-all"
              checked={accepted().length === props.resolved.grants.length}
              onChange={(e) => setAccepted(e.currentTarget.checked ? [...props.resolved.grants] : [])}
            />
            <strong>{t('Accept all')}</strong>
          </label>
        </Show>
        <For each={props.resolved.grants}>
          {(g) => (
            <label class="check">
              <input type="checkbox" data-testid={`plugin-grant-${g}`} checked={accepted().includes(g)} onChange={(e) => toggle(g, e.currentTarget.checked)} />
              {grantText(g)} <code class="muted small">{g}</code>
            </label>
          )}
        </For>
      </Show>
    </Modal>
  )
}

// The Landlock ABI of the pod (plugins.host): 0, the backends of the external plugins cannot run.
const [landlock, setLandlock] = createSignal<number | undefined>()
let hostAsked = false
const askHost = () => {
  if (hostAsked) return
  hostAsked = true
  void request<{ landlock: number }>('plugins.host').then((r) => setLandlock(r.landlock), () => (hostAsked = false))
}

const [dialog, setDialog] = createSignal<{ title: string; resolved: Resolved; action: string; working: string; accept: (grants: string[]) => Promise<void> } | null>(null)

/** The dialog of an install or an update, when one is open. */
export function PluginDialogs() {
  return <Show when={dialog()}>{(d) => <GrantsDialog title={d().title} resolved={d().resolved} action={d().action} working={d().working} onAccept={d().accept} onClose={() => setDialog(null)} />}</Show>
}

/** Resolves a repository, then asks the grants of the version found, installs it and uses it in the project. */
async function askInstall(url: string, constraint: string) {
  const r = await request<Resolved>('plugins.resolve', { url, constraint })
  setDialog({
    title: t('Install a plugin'),
    resolved: r,
    action: t('Install'),
    working: t('Installing…'),
    accept: async (grants) => {
      await request('plugins.install', { url, constraint, version: r.version, grants })
      await setPluginEnabled(r.manifest.id, true)
      toast(t('{name} {version} installed', { name: r.manifest.name, version: r.version }))
    },
  })
}

/** The form that installs a plugin from its repository. */
export function InstallForm() {
  const [url, setUrl] = createSignal('')
  const [constraint, setConstraint] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  return (
    <form
      class="plugin-install"
      data-testid="plugin-install"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        askInstall(url().trim(), constraint().trim())
          .catch(errorToast)
          .finally(() => setBusy(false))
      }}>
      <h3>{t('Install a plugin')}</h3>
      <p class="muted small">{t('From its git repository (https, ssh or a folder of this machine). It is installed on this pod only.')}</p>
      <input placeholder={t('Repository address')} value={url()} onInput={(e) => setUrl(e.currentTarget.value)} data-testid="plugin-install-url" />
      <input placeholder={t('Version (latest)')} value={constraint()} onInput={(e) => setConstraint(e.currentTarget.value)} data-testid="plugin-install-constraint" />
      <button class="primary" type="submit" disabled={busy() || !url().trim()} data-testid="plugin-install-find">
        <Working busy={busy()} label={t('Find')} text={t('Searching…')} />
      </button>
    </form>
  )
}

/** The row of an external plugin: its source, version, Update and Remove, or Install. */
export function ExternalRow(props: { s: PluginState }) {
  askHost()
  const ext = () => props.s.external!
  // What the row waits for from the pod: its buttons say it.
  const [busy, setBusy] = createSignal<'' | 'install' | 'update' | 'remove'>('')
  const work = (what: 'install' | 'update' | 'remove', f: () => Promise<unknown>) => {
    setBusy(what)
    void f()
      .catch(errorToast)
      .finally(() => setBusy(''))
  }
  const update = async () => {
    const id = props.s.manifest.id
    const r = await request<Resolved & { upToDate?: boolean }>('plugins.update', { id })
    if (r.upToDate) return toast(t('{name} is up to date', { name: props.s.manifest.name }))
    if (r.manifest) {
      // A version asking a permission not granted yet.
      setDialog({
        title: t('Update {name}', { name: props.s.manifest.name }),
        resolved: r,
        action: t('Update'),
        working: t('Updating…'),
        accept: async (grants) => {
          await request('plugins.update', { id, grants })
          toast(t('{name} {version} installed', { name: r.manifest.name, version: r.version }))
        },
      })
      return
    }
    toast(t('{name} {version} installed', { name: props.s.manifest.name, version: r.version }))
  }
  return (
    <div class="plugin-external" data-testid={`plugin-external-${props.s.manifest.id}`}>
      <div>
        <span class="badge" classList={{ official: !!ext().official }}>{ext().official ? t('Official') : t('External')}</span> <span class="muted small">{ext().url}</span>
      </div>
      <Show
        when={ext().installed}
        fallback={
          <p class="err small">
            {t('Not installed on this pod.')}{' '}
            <button disabled={!!busy()} onClick={() => work('install', () => askInstall(ext().url, ''))}>
              <Working busy={busy() === 'install'} label={t('Install')} text={t('Searching…')} />
            </button>{' '}
            {/* The project stops naming it. */}
            <button disabled={!!busy()} onClick={() => work('remove', () => setPluginEnabled(props.s.manifest.id, false))} data-testid={`plugin-forget-${props.s.manifest.id}`}>
              {t('Forget')}
            </button>
          </p>
        }>
        <Show when={props.s.manifest.backend && landlock() === 0}>
          <p class="err small">{t('Its backend cannot run on this pod: its kernel has no Landlock.')}</p>
        </Show>
        {/* Each permission it asks, granted or not: revoked at once, for its views and its backend. */}
        <For each={props.s.manifest.permissions ?? []}>
          {(g) => (
            <label class="check small">
              <input
                type="checkbox"
                data-testid={`plugin-granted-${props.s.manifest.id}-${g}`}
                checked={ext().grants.includes(g)}
                onChange={(e) => {
                  const on = e.currentTarget.checked
                  const grants = on ? [...ext().grants, g] : ext().grants.filter((x) => x !== g)
                  void request('plugins.grants', { id: props.s.manifest.id, grants }).catch(errorToast)
                }}
              />
              {grantText(g)} <code class="muted small">{g}</code>
            </label>
          )}
        </For>
        {/* The destinations the user allowed: one taken out is asked again at its next connection. */}
        <Show when={ext().destinations?.length}>
          <div class="plugin-destinations small" data-testid={`plugin-destinations-${props.s.manifest.id}`}>
            <span class="muted">{t('Allowed connections:')}</span>
            <For each={ext().destinations}>
              {(d) => (
                <span class="badge">
                  {d}
                  <button class="icon-btn tiny" title={t('Ask again')}
                    onClick={() => void request('plugins.destinations', { id: props.s.manifest.id, destinations: ext().destinations!.filter((x) => x !== d) }).catch(errorToast)}>
                    ✕
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <div class="row">
          <button disabled={!!busy()} onClick={() => work('update', update)} data-testid={`plugin-update-${props.s.manifest.id}`}>
            <Working busy={busy() === 'update'} label={t('Update')} text={t('Updating…')} />
          </button>
          <button
            class="danger"
            data-testid={`plugin-remove-${props.s.manifest.id}`}
            disabled={!!busy()}
            onClick={() => {
              const id = props.s.manifest.id
              // Gone from the pod, and from this project's list, as when disabled. An official
              // plugin is not put back by the pod: Settings offers to install it again.
              if (!ext().official && confirm(t('Remove {name} from this pod?', { name: props.s.manifest.name })))
                work('remove', () => request('plugins.remove', { id }).then(() => setPluginEnabled(id, false)))
              else if (ext().official && confirm(t('Remove {name} from this pod? It is an official plugin: the IDE will not install it again by itself.', { name: props.s.manifest.name })))
                work('remove', () => request('plugins.remove', { id }))
            }}>
            <Working busy={busy() === 'remove'} label={t('Remove')} text={t('Removing…')} />
          </button>
        </div>
      </Show>
    </div>
  )
}

/** The official plugins the user removed from this pod: the pod leaves them out, they can be installed again. */
export function DeclinedOfficial() {
  const [list, setList] = createSignal<{ id: string; url: string; constraint: string }[]>([])
  const load = () => void request<{ id: string; url: string; constraint: string }[]>('plugins.declined').then(setList, () => setList([]))
  load()
  // The list changes with each install or removal.
  createEffect(on(pluginStates, load, { defer: true }))
  return (
    <Show when={list().length}>
      <div class="plugin-declined" data-testid="plugins-declined">
        <h3>{t('Official plugins removed')}</h3>
        <For each={list()}>
          {(d) => (
            <p class="small">
              {d.id} <span class="muted">{d.url}</span>{' '}
              <button onClick={() => void askInstall(d.url, d.constraint).catch(errorToast)} data-testid={`plugin-reinstall-${d.id}`}>
                {t('Install')}
              </button>
            </p>
          )}
        </For>
      </div>
    </Show>
  )
}
