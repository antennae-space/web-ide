// External plugins (#128, #129, #130): installed from a git repository (a local one made here,
// its release archive served by the suite) in Settings > Plugins, with the permissions accepted
// one by one; used by the project, its tool, tab view and command run in sandboxed frames: no
// storage, no network, no page; a method of the core only with its grant; the shortcuts of the
// IDE work from the frame. Its backend (a Go program built here) runs confined: it answers its
// frame and emits to it, its assistant tool answers through the MCP, it cannot read the pod's
// key nor reach the network, it reads the project (files:read), the core refuses it fs.list. Updated to a version asking new permissions (asked again); a
// version for another IDE refused; removed, then installed again with the grant.
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const net = require('net')
const { execFileSync } = require('child_process')
const { run, openProject, assert, mcp, WS } = require('../common.cjs')

const lockFile = path.join(WS, '..', 'data', 'plugins.lock')
const readLock = () => (fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')).plugins : {})
const row = '.plugin-row[data-plugin=greet]'
const frame = (page, view) => page.frameLocator(`iframe.plugin-frame[data-view=${view}]`)

// The page module of the plugin: its tool checks what the frame reaches, its tab view shows its
// state, its command toasts.
const bundle = (base) => `
ide.register({
  views: {
    greet: async (el, ide) => {
      const out = {}
      try { localStorage.getItem('x'); out.localStorage = 'open' } catch { out.localStorage = 'blocked' }
      try { await new Promise((ok, ko) => { const r = indexedDB.open('x'); r.onsuccess = ok; r.onerror = () => ko(r.error) }); out.indexedDB = 'open' } catch { out.indexedDB = 'blocked' }
      try { await fetch('${base}/1.0.0/x'); out.fetch = 'open' } catch { out.fetch = 'blocked' }
      try { void parent.document.title; out.parent = 'open' } catch { out.parent = 'blocked' }
      try { await ide.rpc('fs.list', { path: '' }); out.rpc = 'answered' } catch (e) { out.rpc = 'refused: ' + e.message }
      el.innerHTML = '<p id="hello">' + ide.t('Hello from the frame') + '</p><pre id="checks">' + JSON.stringify(out) + '</pre><button id="open">open</button><button id="view">view</button>'
      el.innerHTML += '<button id="backend">backend</button><button id="probe">probe</button><button id="core">core</button><button id="list">list</button><button id="dial">dial</button><button id="secret">secret</button><button id="targets">targets</button><button id="settings">settings</button><button id="console">console</button><button id="docker">docker</button><button id="terminal">terminal</button><button id="size">size</button><button id="confirm">confirm</button><button id="prompt">prompt</button><button id="pick">pick</button><button id="later">later</button><button id="modal">modal</button><pre id="answer"></pre><pre id="event"></pre><pre id="menu-choice"></pre>'
      // The items this frame adds to the ⋮ menu of its tool (#175), and the choice it gets back.
      ide.setToolMenu([{ id: 'louder', label: ide.t('Greet from the menu'), hint: 'Ctrl+G' }, { id: 'quiet', label: ide.t('Quietly'), checked: true }])
      ide.onToolMenu((e) => (el.querySelector('#menu-choice').textContent = e.item))
      const show = (p) => p.then((r) => (el.querySelector('#answer').textContent = typeof r === 'string' ? r : JSON.stringify(r)), (e) => (el.querySelector('#answer').textContent = 'error: ' + e.message))
      ide.on('greet.said', (d) => (el.querySelector('#event').textContent = d))
      el.querySelector('#backend').onclick = () => show(ide.rpc('greet.hello'))
      el.querySelector('#probe').onclick = () => show(ide.rpc('greet.probe', { key: ${JSON.stringify(path.join(WS, '..', 'data', 'device.key'))} }))
      el.querySelector('#core').onclick = () => show(ide.rpc('greet.core'))
      el.querySelector('#dial').onclick = () => show(ide.rpc('greet.dial', { port: ${echoPort} }))
      el.querySelector('#secret').onclick = () => show(ide.rpc('greet.secret', { value: 's3cret' }))
      el.querySelector('#targets').onclick = () => show(ide.rpc('greet.targets'))
      el.querySelector('#settings').onclick = () => show(ide.rpc('greet.settings'))
      el.querySelector('#console').onclick = () => ide.openView('console', {}, 'Console')
      el.querySelector('#docker').onclick = () => show(ide.rpc('greet.docker'))
      el.querySelector('#size').onclick = () => show(ide.rpc('greet.size'))
      el.querySelector('#terminal').onclick = () => show(ide.rpc('greet.terminal').then((id) => (ide.showConsole(id), id)))
      // The dialogs of the core and a modal view (#154).
      el.querySelector('#confirm').onclick = () => show(ide.confirm({ title: 'Delete?', text: 'Delete the greeting?', danger: true }).then(String))
      el.querySelector('#prompt').onclick = () => show(ide.prompt({ title: 'Name', label: 'Your name' }).then(String))
      el.querySelector('#pick').onclick = () => show(ide.pick({ title: 'Pick one', items: [{ label: 'first' }, { label: 'second' }] }).then(String))
      el.querySelector('#later').onclick = () => setTimeout(() => show(ide.confirm({ title: 'Later', text: 'asked later' }).then(String)), 3000)
      el.querySelector('#modal').onclick = () => show(ide.openModal('form', { name: 'Ada' }, { size: 'small' }).then((r) => JSON.stringify(r)))
      el.querySelector('#list').onclick = () => show(ide.rpc('fs.list', { path: '' }).then(() => 'answered'))
      el.querySelector('#open').onclick = () => ide.openFile('notes.txt')
      el.querySelector('#view').onclick = () => ide.openView('note', { text: 'kept' }, 'Note')
    },
    // A modal view: its state, a result for its opener; a second modal refused.
    form: (el, ide) => {
      el.innerHTML = '<p id="where">' + (ide.modal ? 'in a modal' : 'not a modal') + '</p><input id="name"><button id="submit">submit</button><button id="nested">nested</button><pre id="out"></pre>'
      el.querySelector('#name').value = (ide.view.state && ide.view.state.name) || ''
      el.querySelector('#submit').onclick = () => ide.closeModal({ name: el.querySelector('#name').value })
      el.querySelector('#nested').onclick = () => ide.openModal('form').then(() => (el.querySelector('#out').textContent = 'opened'), (e) => (el.querySelector('#out').textContent = e.message))
    },
    note: (el, ide) => { el.innerHTML = '<p id="note">' + ((ide.view.state && ide.view.state.text) || '') + '</p>' },
    // A tab with the core's editor above (#151): its text, a key of the manifest, the settings.
    console: (el, ide) => {
      el.innerHTML = '<pre id="ed"></pre><pre id="key"></pre><pre id="set"></pre><button id="fill">fill</button>'
      const ed = ide.editor
      el.querySelector('#ed').textContent = ed.text()
      ed.onChange((t) => (el.querySelector('#ed').textContent = t))
      ed.setWords(['greet_table'])
      ed.onKey('run', () => { el.querySelector('#key').textContent = 'run:' + ed.selection().text + '|' + ed.text(); ed.mark([0, ed.text().length]) })
      const set = (v) => (el.querySelector('#set').textContent = JSON.stringify(v))
      set(ide.settings)
      ide.onSettings(set)
      el.querySelector('#fill').onclick = () => ed.setText('select 1')
    },
  },
  commands: { hello: (ide) => ide.toast('Command of Greet') },
})
`

// The echo server the backend reaches through a connection the pod opens for it (#143).
let echoPort = 0

run(async ({ page, errors }) => {
  const echo = net.createServer((sock) => sock.on('data', (d) => sock.write(d)))
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  echoPort = echo.address().port
  // The release archives, by version (any architecture).
  const assets = {}
  const server = http.createServer((req, res) => {
    const v = req.url.split('/')[1]
    if (!assets[v]) return res.writeHead(404).end()
    res.writeHead(200).end(assets[v])
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-externals-'))
  const repo = path.join(tmp, 'greet')
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null' } })
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  const contributes = {
    tools: [{ id: 'greet', label: 'Greet', icon: 'sparkle', zone: 'right' }],
    tabViews: [{ id: 'note', label: 'Note' }],
    commands: [{ id: 'hello', label: 'Say hello from Greet' }],
    assistantTools: ['greet_hello'],
    toolSchemas: { greet_hello: { description: 'Says hello from the backend of Greet', properties: {} } },
  }
  // Its backend, a static Go program.
  const goBin = [process.env.GO, path.join(os.homedir(), 'sdk/go/bin/go'), 'go'].find((g) => g && (g === 'go' || fs.existsSync(g)))
  const backendBin = path.join(tmp, 'greet-backend')
  execFileSync(goBin, ['build', '-o', backendBin, path.join(__dirname, '..', 'fixtures', 'greet-backend', 'main.go')], { env: { ...process.env, CGO_ENABLED: '0' } })
  const release = (version, extra) => {
    const manifest = JSON.stringify({ id: 'greet', name: 'Greet', version, apiVersion: 1, assets: base + '/{version}/greet-{arch}.tar.gz', backend: 'bin/greet', contributes, ...extra }, null, 2)
    fs.writeFileSync(path.join(repo, 'plugin.json'), manifest)
    git('add', '-A')
    git('commit', '-q', '-m', version)
    git('tag', 'v' + version)
    const dir = path.join(tmp, 'build-' + version)
    fs.mkdirSync(path.join(dir, 'web'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'i18n'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.json'), manifest)
    fs.writeFileSync(path.join(dir, 'web', 'index.js'), bundle(base))
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.copyFileSync(backendBin, path.join(dir, 'bin', 'greet'))
    fs.chmodSync(path.join(dir, 'bin', 'greet'), 0o755)
    fs.writeFileSync(path.join(dir, 'i18n', 'fr.json'), JSON.stringify({ 'Hello from the frame': 'Bonjour depuis le cadre', 'Greet from the menu': 'Saluer depuis le menu', 'Quietly': 'En silence' }))
    execFileSync('tar', ['czf', path.join(tmp, version + '.tar.gz'), '-C', dir, '.'])
    assets[version] = fs.readFileSync(path.join(tmp, version + '.tar.gz'))
  }
  release('1.0.0', { ide: '^1.0', permissions: ['files:read'] })

  await openProject(page)
  page.on('dialog', (d) => d.accept())
  const openSettings = async () => {
    await page.click('.menubar button[title^="Settings"]')
    await page.click('.settings-nav button:has-text("Plugins")')
  }
  // By its button when it is open: Escape is lost while the focus is still in a frame (a slow machine).
  const closeSettings = async () => {
    if (await page.$('.modal-settings')) await page.click('.modal-settings .modal-head .icon-btn')
    await page.waitForSelector('.modal-settings', { state: 'detached' })
  }
  // Its tool shown (a desk restored after a reload may show it already: a click would hide it).
  const showGreet = async () => {
    await page.waitForSelector('.rail-btn[data-id=greet]')
    // After an update its frame is drawn again: a click while it is gone would close the tool.
    const shown = await page.waitForSelector('iframe.plugin-frame[data-view=greet]', { state: 'visible', timeout: 10000 }).then(() => true, () => false)
    if (!shown) await page.click('.rail-btn[data-id=greet]')
  }
  await openSettings()

  // Find: the dialog shows the version and its permission, unchecked; installed with it.
  await page.fill('[data-testid=plugin-install-url]', repo)
  await page.click('[data-testid=plugin-install-find]')
  await page.waitForSelector('.plugin-grants')
  const dialog = await page.textContent('.plugin-grants')
  assert(dialog.includes('Greet') && dialog.includes('1.0.0') && dialog.includes('Read the files of the project'), 'the grants dialog: ' + dialog)
  assert(!(await page.isChecked('[data-testid="plugin-grant-files:read"]')), 'a permission is not accepted by default')
  await page.check('[data-testid="plugin-grant-files:read"]')
  await page.click('[data-testid=plugin-grants-accept]')
  await page.waitForSelector('[data-testid=plugin-external-greet]')
  const text = await page.textContent(row)
  assert(text.includes('External') && text.includes('files:read') && text.includes(repo), 'the external row: ' + text)
  let lock = readLock()
  assert(lock.greet?.version === '1.0.0' && lock.greet.grants.join() === 'files:read' && lock.greet.sha256.length === 64 && lock.greet.url === repo, 'the lock: ' + JSON.stringify(lock))
  assert(fs.existsSync(path.join(WS, '..', 'data', 'plugins', 'greet', '1.0.0', 'web', 'index.js')), 'extracted')

  // Used by the project once installed: listed in .ide/plugins.json with its repository; its tool comes.
  await page.waitForFunction(() => document.querySelector('[data-testid=plugin-greet]')?.checked)
  const choices = JSON.parse(fs.readFileSync(WS + '/demo/.ide/plugins.json', 'utf8'))
  assert(choices.external?.greet === repo, 'used by the project: ' + JSON.stringify(choices))
  await closeSettings()
  await page.waitForSelector('.rail-btn[data-id=greet]')

  // Its tool, in a sandboxed frame: an opaque origin, no network, no page; no core method
  // without its grant.
  await page.click('.rail-btn[data-id=greet]')
  const sandbox = await page.getAttribute('iframe.plugin-frame[data-view=greet]', 'sandbox')
  assert(sandbox === 'allow-scripts', 'sandboxed, no allow-same-origin: ' + sandbox)
  await frame(page, 'greet').locator('#checks').waitFor()
  // The room of the ⋮ of the zone over the frame's corner, for its header (#141, #176).
  const inset = await frame(page, 'greet').locator('html').evaluate((h) => h.style.getPropertyValue('--ide-head-inset'))
  assert(parseInt(inset) >= 30, 'the frame knows the room of the corner buttons: ' + inset)
  let checks = JSON.parse(await frame(page, 'greet').locator('#checks').textContent())
  assert(checks.localStorage === 'blocked' && checks.indexedDB === 'blocked', 'no storage of the origin: ' + JSON.stringify(checks))
  assert(checks.fetch === 'blocked', 'no network (CSP): ' + JSON.stringify(checks))
  assert(checks.parent === 'blocked', 'no access to the page: ' + JSON.stringify(checks))
  assert(checks.rpc.startsWith('refused') && checks.rpc.includes('fs.list is not granted to Greet'), 'a core method without its grant: ' + checks.rpc)
  assert((await frame(page, 'greet').locator('#hello').textContent()) === 'Hello from the frame', 'its texts')

  // Its backend, confined: it answers its frame and emits to it; it reads the project
  // (files:read), not the pod's key nor the network; the core refuses it fs.list.
  const answer = async (button, want) => {
    await frame(page, 'greet').locator('#' + button).click()
    await frame(page, 'greet').locator('#answer:not(:empty)').waitFor()
    const got = await frame(page, 'greet').locator('#answer').textContent()
    await frame(page, 'greet').locator('#answer').evaluate((e) => (e.textContent = ''))
    return got
  }
  let got = await answer('backend')
  assert(got === 'Hello from the backend', 'the backend answers its frame: ' + got)
  await frame(page, 'greet').locator('#event:has-text("said by the backend")').waitFor()
  got = JSON.parse(await answer('probe'))
  assert(got.key === 'blocked' && got.net === 'blocked' && got.project === 'ok', 'the backend is confined: ' + JSON.stringify(got))
  got = await answer('core')
  assert(got.startsWith('refused') && got.includes('fs.list is not granted to Greet'), 'a core call of the backend without its grant: ' + got)
  const tool = await mcp('greet_hello', {})
  assert(!tool.result?.isError && tool.result?.content?.[0]?.text === 'Hello from the tool of the backend', 'its assistant tool through the MCP: ' + JSON.stringify(tool))

  // What the sandbox API does: a file opened, a tab view with its state (kept after a reload).
  await frame(page, 'greet').locator('#open').click()
  await page.waitForSelector('.tab:has-text("notes.txt")')
  await frame(page, 'greet').locator('#view').click()
  await frame(page, 'note').locator('#note:has-text("kept")').waitFor()
  await page.reload()
  await frame(page, 'note').locator('#note:has-text("kept")').waitFor()

  // The shortcuts of the IDE from the frame: Search Everywhere, then its command.
  await showGreet()
  await frame(page, 'greet').locator('#checks').click()
  await page.keyboard.press('Control+Shift+a')
  await page.waitForSelector('.pick.se')
  await page.keyboard.type('Say hello from Greet')
  await page.waitForSelector('.pick-item.selected:has-text("Say hello from Greet")')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.toast:has-text("Command of Greet")')

  // A new version asks the network and fs.list: the update asks only those.
  release('1.1.0', { ide: '^1.0', permissions: ['files:read', 'net', 'core:fs.list'] })
  await openSettings()
  await page.click('[data-testid=plugin-update-greet]')
  await page.waitForSelector('.plugin-grants')
  const asked = await page.textContent('.plugin-grants')
  assert(asked.includes('1.1.0') && asked.includes('Reach the network') && asked.includes('Call fs.list of the IDE') && !asked.includes('Read the files'), 'only the new permissions are asked: ' + asked)
  await page.check('[data-testid=plugin-grant-net]')
  await page.click('[data-testid=plugin-grants-accept]')
  await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin=greet]')?.textContent.includes('1.1.0'))
  lock = readLock()
  assert(lock.greet.version === '1.1.0' && lock.greet.grants.join() === 'files:read,net', 'updated in the lock, fs.list not granted: ' + JSON.stringify(lock.greet))
  assert(!fs.existsSync(path.join(WS, '..', 'data', 'plugins', 'greet', '1.0.0')), 'the old version removed')

  // Up to date now; a version for another IDE is refused with its reason.
  await page.click('[data-testid=plugin-update-greet]')
  await page.waitForSelector('.toast:has-text("Greet is up to date")')
  release('2.0.0', { ide: '^99' })
  await page.fill('[data-testid=plugin-install-url]', repo)
  await page.fill('[data-testid=plugin-install-constraint]', '^2')
  await page.click('[data-testid=plugin-install-find]')
  await page.waitForSelector('.toast-error:has-text("needs the IDE ^99")')

  // Removed: the row, the lock entry and the folder go, and the project stops naming it.
  await page.click('[data-testid=plugin-remove-greet]')
  await page.waitForSelector('.plugin-row[data-plugin=greet]', { state: 'detached' })
  assert(!readLock().greet && !fs.existsSync(path.join(WS, '..', 'data', 'plugins', 'greet')), 'removed from the pod')
  assert(!JSON.parse(fs.readFileSync(WS + '/demo/.ide/plugins.json', 'utf8')).external?.greet, 'removed from the project')
  assert(!(await page.$('.rail-btn[data-id=greet]')), 'its tool gone')

  // Installed again, fs.list granted, used again: the frame gets its answer.
  await page.fill('[data-testid=plugin-install-constraint]', '')
  await page.click('[data-testid=plugin-install-find]')
  await page.waitForSelector('.plugin-grants')
  await page.check('[data-testid=plugin-grants-all]')
  const all = await page.$$eval('.plugin-grants input[data-testid^="plugin-grant-"]', (l) => l.map((i) => i.checked))
  assert(all.length === 3 && all.every(Boolean), 'Accept all ticks each permission: ' + all)
  await page.click('[data-testid=plugin-grants-accept]')
  await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin=greet]')?.textContent.includes('core:fs.list'))
  assert(readLock().greet.grants.length === 3, 'all granted: ' + readLock().greet.grants)
  await page.waitForFunction(() => document.querySelector('[data-testid=plugin-greet]')?.checked)
  await closeSettings()
  await page.reload()
  await showGreet()
  await frame(page, 'greet').locator('#checks').waitFor()
  checks = JSON.parse(await frame(page, 'greet').locator('#checks').textContent())
  assert(checks.rpc === 'answered', 'a core method with its grant: ' + checks.rpc)
  got = await answer('core')
  assert(got === 'answered', 'the core call of the backend with its grant: ' + got)

  // A grant revoked in Settings: refused at once, by the frame and the backend; given again.
  await openSettings()
  await page.uncheck('[data-testid="plugin-granted-greet-core:fs.list"]')
  await page.waitForFunction(() => !document.querySelector('.plugin-row[data-plugin=greet] [data-testid="plugin-granted-greet-core:fs.list"]')?.checked)
  await page.waitForTimeout(300)
  assert(readLock().greet.grants.join() === 'files:read,net', 'revoked in the lock: ' + readLock().greet.grants)
  await closeSettings()
  got = await answer('list')
  assert(got.includes('fs.list is not granted to Greet'), 'the frame, once revoked: ' + got)
  got = await answer('core')
  assert(got.includes('fs.list is not granted to Greet'), 'the backend, once revoked: ' + got)
  await openSettings()
  await page.check('[data-testid="plugin-granted-greet-core:fs.list"]')
  await page.waitForTimeout(300)
  await closeSettings()
  got = await answer('list')
  assert(got === 'answered', 'granted again: ' + got)

  // The pod dials for the backend (#143): a version asking dial and vault; the first connection
  // to a destination asks the user, Allow is remembered; the socket comes on fd 3.
  release('1.2.0', { ide: '^1.0', permissions: ['files:read', 'net', 'core:fs.list', 'dial', 'vault'] })
  await openSettings()
  await page.click('[data-testid=plugin-update-greet]')
  await page.waitForSelector('.plugin-grants')
  await page.check('[data-testid=plugin-grant-dial]')
  await page.check('[data-testid=plugin-grant-vault]')
  await page.click('[data-testid=plugin-grants-accept]')
  await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin=greet]')?.textContent.includes('1.2.0'))
  await closeSettings()
  await showGreet()
  await frame(page, 'greet').locator('#dial').click()
  const modal = '[data-testid=question-modal]'
  await page.waitForSelector(`${modal}[data-kind=permission]`, { timeout: 15000 })
  const q = await page.textContent(modal)
  assert(q.includes(`Greet wants to connect to 127.0.0.1:${echoPort}`), 'the destination is asked: ' + q)
  await page.click(`${modal} [data-testid=question-option-allow_always]`)
  await frame(page, 'greet').locator('#answer:not(:empty)').waitFor()
  got = await frame(page, 'greet').locator('#answer').textContent()
  await frame(page, 'greet').locator('#answer').evaluate((e) => (e.textContent = ''))
  assert(got === 'echo: ping', 'the socket opened by the pod: ' + got)
  assert(readLock().greet.destinations?.includes(`127.0.0.1:${echoPort}`), 'allowed and remembered: ' + JSON.stringify(readLock().greet))
  got = await answer('dial')
  assert(got === 'echo: ping' && !(await page.$(modal)), 'not asked again: ' + got)
  got = await answer('secret')
  const secrets = JSON.parse(fs.readFileSync(path.join(WS, '..', 'data', 'secrets.json'), 'utf8'))
  assert(got === 's3cret' && secrets['plugin:greet/token'] === 's3cret', 'its vault entry: ' + got)

  // The view side (#151): a tab with the core's editor, settings, actions and the AI policy.
  release('1.3.0', {
    ide: '^1.0',
    permissions: ['files:read', 'net', 'core:fs.list', 'dial', 'vault'],
    contributes: {
      ...contributes,
      tabViews: [...contributes.tabViews, { id: 'console', label: 'Console', editor: { lang: 'sql', keys: { 'Ctrl+Enter': 'run' } } }],
      settings: { properties: { greeting: { type: 'string', title: 'Greeting', default: 'Hi' }, loud: { type: 'boolean', title: 'Loud' } } },
      actions: [
        { id: 'count', label: 'Count', description: 'Counts the things of Greet.', properties: {}, access: 'read' },
        { id: 'write', label: 'Write a note', description: 'Writes a note in a connection.', properties: { conn: { type: 'string', description: 'The connection' } }, required: ['conn'], access: 'write', target: 'conn' },
      ],
    },
  })
  await openSettings()
  await page.click('[data-testid=plugin-update-greet]')
  await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin=greet]')?.textContent.includes('1.3.0'))
  // Its settings, rendered and changed: the backend reads them.
  await page.waitForSelector('[data-testid=plugin-setting-greet-greeting]')
  assert((await page.inputValue('[data-testid=plugin-setting-greet-greeting]')) === 'Hi', 'the default of a setting')
  await page.fill('[data-testid=plugin-setting-greet-greeting]', 'Hello')
  await page.press('[data-testid=plugin-setting-greet-greeting]', 'Tab')
  await page.waitForTimeout(900) // the settings are saved a moment after a change
  await closeSettings()
  await showGreet()
  got = await answer('settings')
  assert(JSON.parse(got).greeting === 'Hello', 'the backend reads its settings: ' + got)

  // The console tab: the core's editor above the frame.
  await frame(page, 'greet').locator('#console').click()
  const con = frame(page, 'console')
  await page.waitForSelector('[data-testid=plugin-editor] .ed-content')
  await con.locator('#set').waitFor()
  assert(JSON.parse(await con.locator('#set').textContent()).greeting === 'Hello', 'the frame reads its settings')
  await page.click('[data-testid=plugin-editor] .ed-content')
  await page.keyboard.type('select 42 from greet_')
  await con.locator('#ed:has-text("select 42 from greet_")').waitFor()
  await page.keyboard.press('Control+Space')
  await page.waitForSelector('.completion :text("greet_table")')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Enter')
  await con.locator('#key:not(:empty)').waitFor()
  assert((await con.locator('#key').textContent()) === 'run:|select 42 from greet_', 'a key of the editor reaches the frame: ' + (await con.locator('#key').textContent()))
  await con.locator('#fill').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=plugin-editor] .ed-content')?.textContent.startsWith('select 1'))
  await page.waitForTimeout(600)
  await page.reload()
  await page.waitForSelector('[data-testid=plugin-editor] .ed-content')
  await frame(page, 'console').locator('#ed:has-text("select 1")').waitFor()
  assert(true, 'the text of the editor kept with the tab')

  // Actions: a read one runs for the AI; a write one is read only by default, then asked, then allowed.
  let r = await mcp('greet_count', {})
  assert(r.result?.content?.[0]?.text === '3', 'an action that reads: ' + JSON.stringify(r))
  r = await mcp('greet_write', { conn: 'main' })
  assert(r.result?.isError && r.result.content[0].text.includes('read only'), 'a write is read only by default: ' + JSON.stringify(r))
  await showGreet()
  got = await answer('targets')
  assert(got === 'declared', 'its targets declared: ' + got)
  await openSettings()
  await page.selectOption('[data-testid=plugin-ai-greet-main]', 'ask')
  await page.waitForTimeout(900)
  await closeSettings()
  const pendingWrite = mcp('greet_write', { conn: 'main' })
  await page.waitForSelector(`${modal}[data-kind=permission]`, { timeout: 15000 })
  const wording = await page.textContent(modal)
  assert(wording.includes('The AI wants to run “Write a note” of Greet on main'), 'the user is asked: ' + wording)
  await page.click(`${modal} [data-testid=question-option-allow_once]`)
  r = await pendingWrite
  assert(r.result?.content?.[0]?.text === '"written main"', 'allowed once: ' + JSON.stringify(r))
  await openSettings()
  await page.selectOption('[data-testid=plugin-ai-greet-main]', 'write')
  await page.waitForTimeout(900)
  await closeSettings()
  r = await mcp('greet_write', { conn: 'main' })
  assert(r.result?.content?.[0]?.text === '"written main"' && !(await page.$(modal)), 'allowed: ' + JSON.stringify(r))

  // The bricks of Docker (#147): the Docker socket opened by the pod (as much as root, said so);
  // a console of the core fed by the backend.
  release('1.4.0', {
    ide: '^1.0',
    permissions: ['files:read', 'net', 'core:fs.list', 'dial', 'vault', 'socket:docker', 'terminal'],
    contributes: { ...contributes, tabViews: [...contributes.tabViews, { id: 'console', label: 'Console', editor: { lang: 'sql', keys: { 'Ctrl+Enter': 'run' } } }] },
  })
  await openSettings()
  await page.click('[data-testid=plugin-update-greet]')
  await page.waitForSelector('.plugin-grants')
  const docker = await page.textContent('.plugin-grants')
  assert(docker.includes('as much as root'), 'the Docker grant says what it is worth: ' + docker)
  await page.check('[data-testid="plugin-grant-socket:docker"]')
  await page.check('[data-testid=plugin-grant-terminal]')
  await page.click('[data-testid=plugin-grants-accept]')
  await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin=greet]')?.textContent.includes('1.4.0'))
  await closeSettings()
  await showGreet()
  let dockerUp = true
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.APIVersion}}'], { stdio: 'ignore' })
  } catch {
    dockerUp = false
  }
  got = await answer('docker')
  if (dockerUp) assert(got.startsWith('docker api '), 'the engine answers through the socket the pod opened: ' + got)
  else assert(got.includes('Docker does not answer'), 'no Docker here: ' + got)
  got = await answer('terminal')
  assert(/^[0-9a-f]+$/.test(got), 'a console opened: ' + got)
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows')].some((r) => r.textContent.includes('greet>')), null, { timeout: 15000 })
  await page.click('.xterm:has-text("greet>")')
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows')].some((r) => r.textContent.includes('HELLO')))
  assert(true, 'the console of the core shows what the backend writes, and gives it what is typed')
  await showGreet()
  got = await answer('size')
  assert(/^\d+x\d+$/.test(got), 'its size reached the backend: ' + got)

  // Modals drawn by the core (#154): its dialogs, centered, titled with the plugin; a modal view.
  release('1.5.0', {
    ide: '^1.0',
    permissions: ['files:read', 'net', 'core:fs.list', 'dial', 'vault', 'socket:docker', 'terminal'],
    contributes: { ...contributes, modals: [{ id: 'form', label: 'Form' }], tabViews: [...contributes.tabViews, { id: 'console', label: 'Console', editor: { lang: 'sql', keys: { 'Ctrl+Enter': 'run' } } }] },
  })
  await openSettings()
  await page.click('[data-testid=plugin-update-greet]')
  await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin=greet]')?.textContent.includes('1.5.0'))
  await page.click('.modal-settings .modal-head button')
  await page.waitForSelector('.modal-settings', { state: 'detached' })
  await showGreet()
  const g = frame(page, 'greet')
  const result = async () => {
    await g.locator('#answer:not(:empty)').waitFor()
    const r = await g.locator('#answer').textContent()
    await g.locator('#answer').evaluate((e) => (e.textContent = ''))
    return r
  }
  await g.locator('#confirm').click()
  await page.waitForSelector('.modal-backdrop .modal:has-text("Delete the greeting?")')
  assert((await page.textContent('.modal .modal-head h2')) === 'Greet · Delete?', 'a confirm of the core, titled with the plugin')
  await page.click('[data-testid=confirm-ok]')
  assert((await result()) === 'true', 'confirmed')
  await g.locator('#prompt').click()
  await page.waitForSelector('.modal .modal-head h2:has-text("Greet · Name")')
  await page.fill('.modal input', 'Ada')
  await page.keyboard.press('Enter')
  assert((await result()) === 'Ada', 'a prompt of the core')
  await g.locator('#pick').click()
  await page.click('.pick-item:has-text("second")')
  assert((await result()) === '1', 'a pick of the core: the index')
  await g.locator('#later').click()
  await page.click('[data-testid=plugin-editor] .ed-content')
  got = await result()
  assert(got.includes('only while you use the plugin'), 'no dialog when the user is not in the frame: ' + got)

  await g.locator('#modal').click()
  await page.waitForSelector('.modal-plugin iframe.plugin-frame[data-view=form]')
  assert((await page.textContent('.modal-plugin .modal-head h2')) === 'Greet · Form', 'its modal view in a modal of the core, titled with the plugin')
  const form = frame(page, 'form')
  assert((await form.locator('#where').textContent()) === 'in a modal' && (await form.locator('#name').inputValue()) === 'Ada', 'the view knows it is a modal, with its state')
  await form.locator('#nested').click()
  await form.locator('#out:not(:empty)').waitFor()
  assert((await form.locator('#out').textContent()).includes('already open'), 'one plugin modal at a time')
  await form.locator('#name').fill('Grace')
  await form.locator('#submit').click()
  assert((await result()) === '{"name":"Grace"}' && !(await page.$('.modal-plugin')), 'closed with its result for its opener')
  await g.locator('#modal').click()
  await page.waitForSelector('.modal-plugin')
  await page.click('.modal-plugin .modal-head button')
  assert((await result()) === 'null', 'closed by the user: null')

  // The options menu of a tool (#175, #176): the core items, then those its plugin contributes.
  const menuLabels = () => page.$$eval('.ctx-menu .ctx-item .ctx-label', (els) => els.map((e) => e.textContent.trim()))
  await page.click('[data-tool=explorer] [data-testid=zone-menu]')
  await page.waitForSelector('.ctx-menu')
  assert(
    JSON.stringify(await menuLabels()) === JSON.stringify(['Open in a window', 'Close', 'New file…', 'New folder…', 'Show the hidden files', 'Show the excluded folders', 'Open files with a single click', 'Always select the opened file', 'Row tints', 'Refresh all']),
    'the items of the Explorer, after the core ones: ' + JSON.stringify(await menuLabels()),
  )
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ctx-menu', { state: 'detached' })

  // Its frame pushes items, in its own language, and gets the choice the user makes. A frame
  // keeps the items it pushed: it pushes them again when its language changes (here, a reload).
  await page.click('.menubar button[title^="Settings"]')
  await page.click('.settings-nav button:has-text("Language")')
  await page.selectOption('[data-testid=settings-language]', 'fr')
  await page.waitForFunction(() => document.querySelector('.menubar .menus')?.textContent.includes('Fichier'))
  await closeSettings()
  await page.waitForTimeout(900) // the language is kept by the pod a moment after a change
  await page.reload()
  await page.waitForSelector('.menubar')
  await showGreet()
  await page.click('[data-tool=greet] [data-testid=zone-menu]')
  await page.waitForSelector('.ctx-menu')
  const greetMenu = await menuLabels()
  assert(greetMenu.slice(0, 2).join() === 'Ouvrir dans une fenêtre,Fermer', 'the core items first: ' + JSON.stringify(greetMenu))
  assert(greetMenu.slice(2).join() === 'Saluer depuis le menu,En silence', 'the items of the frame, translated: ' + JSON.stringify(greetMenu))
  await page.click('.ctx-menu >> text=Saluer depuis le menu')
  await g.locator('#menu-choice:not(:empty)').waitFor()
  assert((await g.locator('#menu-choice').textContent()) === 'louder', 'the choice reaches the frame')
  await page.keyboard.press('Escape')

  echo.close()
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  // The fetch of the frame refused by its CSP is what was asked.
  errors.splice(0, errors.length, ...errors.filter((e) => !/Content Security Policy/.test(e)))
})
