// Official plugins (#142): the pod installs them at start from the archives of its build (here
// WEBIDE_OFFICIAL_DIR, written by the suite before a restart), with their permissions granted,
// and every project uses them unless it disables one. Removed by the user, an official plugin
// is not put back at the next start; Settings offers to install it again.
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { run, openProject, assert, mcp, WS } = require('../common.cjs')

const DATA = process.env.E2E_DATA
const lockFile = path.join(DATA, 'plugins.lock')
const readLock = () => (fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : { plugins: {} })
const row = '.plugin-row[data-plugin=greet]'
const restart = () => execFileSync('bash', [process.env.E2E_RESTART_POD])

run(async ({ page }) => {
  // The release archive of the plugin, also served for an install from Settings.
  let archive
  const server = http.createServer((req, res) => res.writeHead(archive ? 200 : 404).end(archive))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-official-'))
  const repo = path.join(tmp, 'greet')
  const git = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null' } })
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  const manifest = JSON.stringify({
    id: 'greet', name: 'Greet', version: '1.0.0', apiVersion: 1, ide: '*', assets: base + '/{version}/greet-{arch}.tar.gz', backend: 'bin/greet', permissions: ['files:read'],
    contributes: { tools: [{ id: 'greet', label: 'Greet', icon: 'sparkle', zone: 'right' }], assistantTools: ['greet_hello'], toolSchemas: { greet_hello: { description: 'Says hello from the backend of Greet', properties: {} } } },
  }, null, 2)
  fs.writeFileSync(path.join(repo, 'plugin.json'), manifest)
  git('add', '-A'); git('commit', '-q', '-m', '1.0.0'); git('tag', 'v1.0.0')
  const dir = path.join(tmp, 'build')
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'plugin.json'), manifest)
  fs.writeFileSync(path.join(dir, 'web', 'index.js'), `ide.register({ views: { greet: (el, ide) => { el.innerHTML = '<p id="hello">Official Greet</p>' } } })`)
  const goBin = [process.env.GO, path.join(os.homedir(), 'sdk/go/bin/go'), 'go'].find((g) => g && (g === 'go' || fs.existsSync(g)))
  execFileSync(goBin, ['build', '-o', path.join(dir, 'bin', 'greet'), path.join(__dirname, '..', 'fixtures', 'greet-backend', 'main.go')], { env: { ...process.env, CGO_ENABLED: '0' } })
  execFileSync('tar', ['czf', path.join(tmp, 'a.tar.gz'), '-C', dir, '.'])
  archive = fs.readFileSync(path.join(tmp, 'a.tar.gz'))
  const sha = crypto.createHash('sha256').update(archive).digest('hex')

  // The official list of the build, with its archive, then the pod starts again.
  const off = path.join(DATA, '..', 'official')
  fs.mkdirSync(path.join(off, 'archives', 'current'), { recursive: true })
  const arch = 'linux-' + (os.arch() === 'arm64' ? 'arm64' : 'amd64')
  fs.writeFileSync(path.join(off, 'official.json'), JSON.stringify([{ id: 'greet', url: repo, constraint: '*', version: '1.0.0', sha256: { [arch]: sha } }]))
  fs.writeFileSync(path.join(off, 'archives', 'current', 'greet-1.0.0.tar.gz'), archive)
  // Offline: the archive of the build, not the server.
  const served = archive
  archive = undefined
  restart()

  // Installed at start, its permission granted, used by the project without being named.
  for (let i = 0; i < 50 && !readLock().plugins.greet; i++) await new Promise((r) => setTimeout(r, 100))
  let lock = readLock()
  assert(lock.plugins.greet?.official && lock.plugins.greet.version === '1.0.0' && lock.plugins.greet.grants.join() === 'files:read' && lock.plugins.greet.sha256 === sha, 'installed at start from the archive of the build: ' + JSON.stringify(lock))
  await openProject(page)
  await page.waitForSelector('.rail-btn[data-id=greet]')
  if (!(await page.isVisible('iframe.plugin-frame[data-view=greet]'))) await page.click('.rail-btn[data-id=greet]')
  await page.frameLocator('iframe.plugin-frame[data-view=greet]').locator('#hello').waitFor()
  const choices = fs.existsSync(WS + '/demo/.ide/plugins.json') ? fs.readFileSync(WS + '/demo/.ide/plugins.json', 'utf8') : ''
  assert(!choices.includes('greet'), 'the project does not name it: ' + choices)
  const tool = await mcp('greet_hello', {})
  assert(tool.result?.content?.[0]?.text === 'Hello from the tool of the backend', 'its assistant tool: ' + JSON.stringify(tool))

  // Settings: an official plugin, disabled on the project, then on again.
  page.on('dialog', (d) => d.accept())
  await page.click('.menubar button[title^="Settings"]')
  await page.click('.settings-nav button:has-text("Plugins")')
  await page.waitForSelector(`${row} .badge.official`)
  assert((await page.textContent(`${row} .badge`)) === 'Official', 'its badge')
  await page.uncheck('[data-testid=plugin-greet]')
  await page.waitForFunction(() => !document.querySelector('.rail-btn[data-id=greet]'))
  const disabled = JSON.parse(fs.readFileSync(WS + '/demo/.ide/plugins.json', 'utf8'))
  assert(disabled.disabled.includes('greet'), 'disabled on the project: ' + JSON.stringify(disabled))
  await page.check('[data-testid=plugin-greet]')
  await page.waitForSelector('.rail-btn[data-id=greet]')
  assert(true, 'on again')

  // Removed: declined, not put back at the next start.
  await page.click('[data-testid=plugin-remove-greet]')
  await page.waitForSelector('[data-testid=plugin-reinstall-greet]')
  lock = readLock()
  assert(!lock.plugins.greet && lock.declined?.includes('greet'), 'removed and declined: ' + JSON.stringify(lock))
  restart()
  await new Promise((r) => setTimeout(r, 1500))
  lock = readLock()
  assert(!lock.plugins.greet, 'not put back at start: ' + JSON.stringify(lock))

  // Installed again from Settings, from its repository: official, out of the declined ones.
  archive = served
  await page.reload()
  await page.click('.menubar button[title^="Settings"]')
  await page.click('.settings-nav button:has-text("Plugins")')
  await page.click('[data-testid=plugin-reinstall-greet]')
  await page.waitForSelector('.plugin-grants')
  await page.check('[data-testid="plugin-grant-files:read"]')
  await page.click('[data-testid=plugin-grants-accept]')
  await page.waitForSelector(`${row} .badge.official`)
  await page.waitForFunction(() => !document.querySelector('[data-testid=plugins-declined]'))
  lock = readLock()
  assert(lock.plugins.greet?.official && !(lock.declined ?? []).includes('greet'), 'installed again, official: ' + JSON.stringify(lock))
  server.close()
})
