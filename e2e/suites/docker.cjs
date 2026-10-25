// The Docker tool, an official external plugin (#148), against the local Docker: its release
// archive installed at start (installOfficial: the version of official.json, or
// E2E_PLUGIN_DOCKER: a local build), its backend reaching Docker through the socket the pod opens
// and running Compose as a library. The Compose stack of the project (start, stop, details,
// statistics, logs with filter, a shell and the long actions in consoles of the core, down with
// volumes), the Host and Disk tabs, docker_ps and docker_logs for the assistant. Needs docker with
// Compose (to clean up) and the postgres:17-alpine image (no download); it never prunes.
const fs = require('fs')
const http = require('http')
const { execSync } = require('child_process')
const { run, openProject, assert, installOfficial, WS, OUT } = require('../common.cjs')

try {
  execSync('docker compose version && docker image inspect postgres:17-alpine', { stdio: 'ignore' })
} catch {
  console.log('  skip docker: needs docker, Compose and the postgres:17-alpine image')
  process.exit(0)
}

const dir = WS + '/demo'
const name = 'webide-e2e-' + process.pid
const compose = (cmd) => execSync(`docker compose ${cmd}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
fs.writeFileSync(
  dir + '/compose.yaml',
  `name: ${name}
services:
  app:
    image: postgres:17-alpine
    tmpfs: ["/var/lib/postgresql/data"]
    entrypoint: ["sh", "-c", "i=0; while true; do printf '\\\\033[32mtick %d\\\\033[0m\\\\n' $$i; echo warn$$i >&2; i=$$((i+1)); sleep 0.5; done"]
    ports: ["127.0.0.1::80"]
    volumes: ["data:/data", "./:/src:ro"]
  db:
    image: postgres:17-alpine
    tmpfs: ["/var/lib/postgresql/data"]
    entrypoint: ["sleep", "infinity"]
  extra:
    image: postgres:17-alpine
    tmpfs: ["/var/lib/postgresql/data"]
    entrypoint: ["sleep", "infinity"]
    profiles: ["debug"]
volumes:
  data:
`,
)
const cleanup = () => {
  try {
    compose('--profile debug down -v -t 0')
    execSync(`docker volume rm -f ${name}-spare`, { stdio: 'ignore' })
  } catch {
    /* already down */
  }
}
process.on('exit', cleanup)
// An interrupted run (run.sh stops its workers by SIGTERM) removes the stack too.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

// Scripted model server: calls docker_ps and docker_logs, then answers.
const requests = []
const sse = (res, delta) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
const end = (res, reason) => res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`)
const fake = http.createServer(async (req, res) => {
  if (req.url === '/api/version') return res.writeHead(404).end()
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake-model', status: { value: 'loaded' } }] }))
  if (req.url === '/props') return res.end(JSON.stringify({ role: 'router' }))
  if (req.url.startsWith('/props?')) return res.end(JSON.stringify({ chat_template_caps: { supports_tools: true }, default_generation_settings: { n_ctx: 8192 } }))
  let body = ''
  for await (const c of req) body += c
  const r = JSON.parse(body)
  requests.push(r)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (r.messages[r.messages.length - 1].role === 'user') {
    const call = (index, id, name, args) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    sse(res, { tool_calls: [call(0, 'd1', 'docker_ps', {}), call(1, 'd2', 'docker_logs', { service: 'app', lines: 20, filter: 'warn' })] })
    return end(res, 'tool_calls')
  }
  sse(res, { content: 'Docker checked.' })
  end(res, 'stop')
})

const row = (svc) => `[data-testid=docker-service-${svc}]`
const dot = (page, svc) => page.$eval(`${row(svc)} .dk-dot`, (e) => e.className.replace('dk-dot', '').trim()).catch(() => 'none')
const waitDot = (page, svc, want, timeout = 30000) =>
  page.waitForFunction(([sel, want]) => document.querySelector(sel)?.className.includes(want), [`${row(svc)} .dk-dot`, want], { timeout }).then(() => true, () => false)
const menu = async (f, sel, label) => {
  await f.click(sel, { button: 'right' })
  await f.waitForSelector('.ide-menu')
  if (!(await f.$(`.ide-menu .ide-menu-item:has-text("${label}")`))) throw new Error(`no ${label} in the menu: ${await f.textContent('.ide-menu')}`)
  await f.click(`.ide-menu .ide-menu-item:has-text("${label}")`)
}
/** Answers the modal of the frame: OK, or Cancel when refused. */
const answer = async (f, ok = true) => {
  await f.waitForSelector('.ide-modal')
  const text = await f.textContent('.ide-modal-body')
  await f.click(`.ide-modal-foot button:has-text("${ok ? 'OK' : 'Cancel'}")`)
  return text
}

run(async ({ page }) => {
  await openProject(page)
  const lock = await installOfficial('docker')
  assert(lock?.official && lock.grants.includes('socket:docker') && lock.grants.includes('terminal'), 'installed, official, its permissions granted: ' + JSON.stringify(lock))
  await page.reload()
  await page.waitForSelector('.rail-btn[data-id=docker]')
  if (!(await page.isVisible('iframe.plugin-frame[data-view=docker]'))) await page.click('.rail-btn[data-id=docker]')
  const f = await (await page.waitForSelector('iframe.plugin-frame[data-view=docker]')).contentFrame()
  await f.waitForSelector('[data-testid=docker-stack]', { timeout: 15000 })
  assert((await f.textContent('[data-testid=docker-stack]')).includes(name), 'stack row named after the Compose project')
  assert((await f.isVisible(row('app'))) && (await f.isVisible(row('db'))), 'declared services listed')
  assert(!(await f.$(row('extra'))), 'service of an inactive profile hidden')
  assert((await f.textContent(row('db'))).includes('not created'), 'service without container: not created')

  // Profiles chosen in a menu.
  await f.click('[data-testid=docker-profiles]')
  await f.click('.ide-menu .ide-menu-item:has-text("debug")')
  await f.waitForSelector(row('extra'))
  assert(true, 'profile debug shows its service')
  await f.click('[data-testid=docker-profiles]')
  await f.click('.ide-menu .ide-menu-item:has-text("debug")')
  await f.waitForSelector(row('extra'), { state: 'detached' })

  // Start the stack from its row.
  await f.click('[data-testid=docker-stack] [data-action=start]')
  assert((await waitDot(f, 'app', 'up')) && (await waitDot(f, 'db', 'up')), 'stack started: services running')
  assert(/127\.0\.0\.1:\d+→80/.test(await f.textContent(`${row('app')} .dk-ports`)), 'published port in the row')

  // Details: inspect and live statistics.
  await f.click(row('app'))
  await f.waitForSelector('[data-testid=docker-detail] .dk-kv')
  await f.waitForFunction(() => document.querySelector('[data-testid=docker-mounts]')?.textContent.includes('/src'))
  const mounts = await f.textContent('[data-testid=docker-mounts]')
  // (the tmpfs replaces the anonymous volume of the image: the test leaves no volume behind)
  assert(mounts.includes(`${name}_data`) && mounts.includes('→ /data') && mounts.includes('ro'), 'mounts: named volume and read-only bind: ' + mounts)
  assert((await f.textContent('[data-testid=docker-networks]')).includes(`${name}_default`), 'network listed')
  assert(/→80/.test(await f.textContent('[data-testid=docker-ports]')), 'ports listed')
  await f.waitForSelector('[data-testid=docker-cpu]', { timeout: 15000 })
  assert(/%/.test(await f.textContent('[data-testid=docker-cpu]')) && /B/.test(await f.textContent('[data-testid=docker-mem]')), 'CPU and memory shown')
  await page.screenshot({ path: OUT + '/docker-infos.png' })

  // Logs: followed live, stderr included, ANSI colors kept, filter.
  await f.click('[data-testid=docker-detail-logs]')
  await f.waitForFunction(() => (document.querySelector('[data-testid=docker-logs]')?.textContent.match(/tick \d+/g) ?? []).length >= 3, null, { timeout: 15000 })
  const before = await f.$$eval('.dk-log-line', (l) => l.length)
  await page.waitForTimeout(1500)
  assert((await f.$$eval('.dk-log-line', (l) => l.length)) > before, 'logs followed live')
  assert((await f.textContent('[data-testid=docker-logs]')).includes('warn'), 'stderr in the logs')
  assert(await f.$('.dk-log-line span[style*="color"]'), 'ANSI color rendered')
  assert(!(await f.textContent('[data-testid=docker-logs]')).includes('[32m'), 'escape sequences not shown')
  await f.fill('[data-testid=docker-log-filter]', 'warn')
  await page.waitForTimeout(200)
  const filtered = await f.$$eval('.dk-log-line', (l) => l.map((x) => x.textContent))
  assert(filtered.length > 0 && filtered.every((l) => l.includes('warn')), 'filter keeps the matching lines')
  await f.fill('[data-testid=docker-log-filter]', '')
  await f.click('[data-testid=docker-log-times]')
  assert(await f.isVisible('.dk-log-time'), 'timestamps shown on demand')
  await page.screenshot({ path: OUT + '/docker-logs.png' })

  // Logs of the stack: every service, with a service filter.
  await f.click('[data-testid=docker-stack]')
  await f.waitForFunction(() => document.querySelector('.dk-log-svc')?.textContent.startsWith('app'), null, { timeout: 15000 })
  assert(await f.isVisible('[data-testid=docker-log-service]'), 'stack logs: service filter')

  // The assistant reads the state of the services and their logs.
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  await page.click('.rail-right .rail-btn[title="Assistant"]')
  await page.click('.ai-empty button:has-text("Add a model server")')
  await page.fill('.ai-servers input[name=url]', `127.0.0.1:${fake.address().port}`)
  await page.click('.ai-servers button:has-text("Add")')
  await page.waitForSelector('.ai-server-row:has-text("127.0.0.1")')
  await page.click('.ai-servers .modal-head button')
  await page.fill('.ai-composer .ed-content', 'How is docker?')
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('.ai-msg.assistant .md:has-text("Docker checked.")', { timeout: 30000 })
  const results = requests[requests.length - 1].messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert(requests[0].tools.some((t) => t.function.name === 'docker_ps'), 'docker tools offered to the model')
  assert(results[0]?.includes(`Compose project "${name}"`) && /app \(.*app-1\): Up/.test(results[0]), 'docker_ps: state of the services: ' + results[0])
  const logLines = (results[1] ?? '').split('\n').slice(1)
  assert(logLines.length > 0 && logLines.every((l) => l.includes('warn')), 'docker_logs: filtered logs of a service: ' + results[1]?.slice(0, 200))
  fake.close()

  // Stop one service from its row.
  await f.click(`${row('db')} [data-action=stop]`)
  assert(await waitDot(f, 'db', 'down'), 'service stopped')

  // Shell in a container: a console of the core fed by the backend (docker exec), with its size.
  await f.click(row('app'))
  await f.click('[data-testid=docker-shell]')
  await page.waitForSelector('.console-tabs .tab.active:has-text("app")', { timeout: 10000 })
  await page.waitForSelector('.xterm')
  await page.waitForTimeout(1500)
  await page.keyboard.type('echo in-$((40+2)) && stty size && cat /etc/os-release | head -1\n')
  // The text of the console shown.
  const term = () => page.evaluate(() => (document.querySelector('.term-slot:not([style*=none]) .xterm-rows') ?? document.querySelector('.xterm-rows'))?.textContent ?? '')
  const waitTerm = (re, timeout) => page.waitForFunction((re) => new RegExp(re).test((document.querySelector('.term-slot:not([style*=none]) .xterm-rows') ?? document.querySelector('.xterm-rows'))?.textContent ?? ''), re.source, { timeout })
  await waitTerm(/in-42[\s\S]*Alpine/, 10000).then(
    () => assert(true, 'shell runs in the container'),
    () => assert(false, 'shell runs in the container'),
  )
  const size = /in-42\s*(\d+) (\d+)/.exec(await term())
  assert(size && +size[1] > 0 && +size[2] > 20, 'the shell has the size of the console: ' + size?.[0])

  // Longer actions run in a console showing the progress of Compose.
  await menu(f, row('app'), 'Recreate')
  await page.waitForSelector('.console-tabs .tab.active:has-text("--force-recreate app")', { timeout: 10000 })
  await waitTerm(/Started[\s\S]*Done\./, 30000).then(
    () => assert(true, 'recreate runs in a console, its progress shown'),
    async () => assert(false, 'recreate runs in a console, its progress shown: ' + (await term())),
  )

  // Host tab: every container, grouped by Compose project.
  await f.click('[data-testid=docker-tab-host]')
  await f.waitForSelector(`.dk-group:has-text("${name}")`, { timeout: 15000 })
  assert(await f.isVisible(`[data-testid=docker-container-${name}-app-1]`), 'host tab lists the containers of the project')

  // Disk tab: usage, images and volumes; an unused volume removed from its menu.
  execSync(`docker volume create ${name}-spare`, { stdio: 'ignore' })
  await f.click('[data-testid=docker-tab-disk]')
  await f.waitForSelector('[data-testid=docker-usage-Images]', { timeout: 30000 })
  assert(/\d/.test(await f.textContent('[data-testid=docker-usage-Images]')), 'disk usage of the images')
  assert((await f.textContent('[data-testid="docker-image-postgres:17-alpine"]')).includes('in use'), 'image in use')
  assert((await f.textContent(`[data-testid=docker-volume-${name}_data]`)).includes('in use'), 'volume of the stack in use')
  assert((await f.textContent(`[data-testid=docker-volume-${name}-spare]`)).includes('unused'), 'spare volume unused')
  await menu(f, `[data-testid=docker-volume-${name}-spare]`, 'Remove')
  await answer(f)
  await f.waitForSelector(`[data-testid=docker-volume-${name}-spare]`, { state: 'detached', timeout: 15000 })
  assert(execSync(`docker volume ls -q --filter name=${name}-spare`, { encoding: 'utf8' }).trim() === '', 'unused volume removed')
  await f.click('[data-prune=volumes]')
  const asked = await answer(f, false)
  await page.waitForTimeout(300)
  assert(asked.includes('EVERY volume') && (await f.isVisible(`[data-testid=docker-volume-${name}_data]`)), 'pruning every volume asks first; refused, nothing happens')
  await page.screenshot({ path: OUT + '/docker-disk.png' })
  await f.click('[data-testid=docker-tab-project]')

  // Down with volumes: the project name typed to confirm.
  await f.waitForSelector('[data-testid=docker-stack]')
  await menu(f, '[data-testid=docker-stack]', 'Down with volumes')
  await f.waitForSelector('[data-testid=docker-prompt]')
  await f.fill('[data-testid=docker-prompt]', name)
  await f.press('[data-testid=docker-prompt]', 'Enter')
  await page.waitForSelector('.console-tabs .tab.active:has-text("down -v")', { timeout: 10000 })
  assert(await waitDot(f, 'app', 'none', 40000), 'down -v: containers removed')
  const volume = () => execSync(`docker volume ls -q --filter name=${name}_data`, { encoding: 'utf8' }).trim()
  for (let i = 0; i < 50 && volume(); i++) await page.waitForTimeout(200)
  assert(volume() === '', 'down -v: volume removed')
  await page.screenshot({ path: OUT + '/docker-down.png' })
})
