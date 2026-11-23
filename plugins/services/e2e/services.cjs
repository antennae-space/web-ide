// Shared services (#78) on the home page: a service shared (services.json), a port shared twice
// refused, turned off and on, renamed, its route refused to the pod's own origin even with the
// token (the pods of the account only), removed; the section in French.
const fs = require('fs')
const http = require('http')
const path = require('path')
const { run, start, assert, WS } = require('../../../e2e/common.cjs')

const file = path.join(WS, '..', 'data', 'services.json')
const saved = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [])
const port = 39417

run(async ({ page, ctx }) => {
  await page.waitForSelector('[data-testid=home-services]')
  assert((await page.textContent('[data-testid=home-services]')).includes('Nothing shared'), 'nothing shared by default')

  // Shared: the row, the file.
  await page.click('[data-testid=service-add]')
  await page.fill('[data-testid=service-name]', 'Ollama')
  await page.fill('[data-testid=service-port]', String(port))
  await page.click('[data-testid=service-save]')
  await page.waitForSelector(`[data-testid=service-${port}]`)
  const row = `[data-testid=service-${port}]`
  assert((await page.textContent(row)).includes(`127.0.0.1:${port}`), 'the row shows the address')
  let list = saved()
  assert(list.length === 1 && list[0].name === 'Ollama' && list[0].port === port && list[0].enabled, 'services.json: ' + JSON.stringify(list))
  assert((fs.statSync(file).mode & 0o777) === 0o600, 'services.json is private')
  const id = list[0].id

  // The same port twice: refused.
  await page.click('[data-testid=service-add]')
  await page.fill('[data-testid=service-name]', 'Other')
  await page.fill('[data-testid=service-port]', String(port))
  await page.click('[data-testid=service-save]')
  await page.waitForSelector('.toast-error:has-text("is shared already, as Ollama")')
  await page.click('[data-testid=service-form] button:has-text("Cancel")')

  // Off, then on again.
  await page.uncheck(`[data-testid=service-on-${port}]`)
  await page.waitForSelector(`${row}.off`)
  assert(!saved()[0].enabled, 'off in services.json')
  await page.check(`[data-testid=service-on-${port}]`)
  await page.waitForSelector(`${row}:not(.off)`)

  // Renamed.
  await page.click(`[data-testid=service-edit-${port}]`)
  await page.fill('[data-testid=service-name]', 'Ollama GPU')
  await page.click('[data-testid=service-save]')
  await page.waitForSelector(`${row}:has-text("Ollama GPU")`)
  assert(saved()[0].name === 'Ollama GPU' && saved()[0].id === id, 'renamed, same id')

  // A configured service is still shown when its local listener is down.
  const statusLine = `${row} [data-testid=service-health]`
  await page.waitForSelector(`${statusLine}:has-text("The service did not respond.")`, { timeout: 15000 })
  assert(await page.isVisible(`${row}.unavailable`), 'an unavailable local service is muted and explains why')
  const service = http.createServer((_req, res) => res.end('OK'))
  await new Promise((done) => service.listen(port, '127.0.0.1', done))
  try {
    await page.waitForSelector(statusLine, { state: 'detached', timeout: 15000 })
    assert(!(await page.locator(`${row}.unavailable`).count()), 'the service recovers while home is open')
  } finally {
    await new Promise((done) => service.close(done))
  }

  // Control the directory reply. The second tab shows the last known inventory
  // before the first reply, then disables and restores the service address.
  const remote = '[data-testid="link-bravo-bravo-api"]'
  const remoteState = `${remote} [data-testid=link-state]`
  const homeURL = page.url()
  await page.goto('about:blank')
  const stub = (tab, getInventory) => tab.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage(async (message) => {
      const req = JSON.parse(String(message))
      if (req.method !== 'services.remote') {
        server.send(message)
        return
      }
      const result = await getInventory()
      ws.send(JSON.stringify({ id: req.id, result }))
    })
  })
  const remoteInventory = (online) => [{
    key: 'bravo', name: 'bravo', online, catalog: online, route: { name: 'lan' },
    services: [{ id: 'svc', name: 'bravo-api', health: 'ready', link: {
      id: 'link', pod: 'bravo', podName: 'bravo', service: 'svc', name: 'bravo-api',
      scope: 'local', on: true, state: 'on', listen: 39418, route: { name: 'lan' }, requests: 0, bytes: 0,
    } }],
  }]
  const seed = await ctx.newPage()
  await stub(seed, () => remoteInventory(true))
  await seed.goto(homeURL)
  await seed.waitForSelector(`${remote} a[data-testid=link-address]`)
  await seed.close()

  const delayed = await ctx.newPage()
  let resume
  const first = new Promise((done) => { resume = done })
  let inventory = []
  await stub(delayed, async () => { await first; return inventory })
  try {
    await delayed.goto(homeURL)
    await delayed.waitForSelector(`${remoteState}:has-text("Checking…")`)
    assert(!(await delayed.locator(`${remote} a[data-testid=link-address]`).count()), 'cached service shown in a new tab with no active link')
    resume()
    await delayed.waitForSelector('[data-testid=home-linked-services][aria-busy=false]')
    assert(await delayed.isVisible(`${remoteState}:has-text("Checking…")`), 'an empty reply during directory discovery keeps known services visible')
    inventory = remoteInventory(false)
    await delayed.waitForSelector(`${remoteState}:has-text("bravo offline")`)
    assert(await delayed.isVisible(`${remote}.off [aria-disabled=true]`), 'offline service is disabled and says why')
    inventory = remoteInventory(true)
    await delayed.waitForSelector(`${remote} a[data-testid=link-address]`, { timeout: 15000 })
    assert(!(await delayed.locator(`${remote}.off`).count()), 'service opens again when its pod comes back')
    inventory = [{ ...inventory[0], services: [] }]
    await delayed.waitForSelector(remote, { state: 'detached', timeout: 15000 })
    assert(!(await delayed.locator(remote).count()), 'the reachable pod confirms that the service is no longer shared')
  } finally {
    resume()
    await delayed.close()
  }

  await page.goto(homeURL)

  // The route of the pods refuses a window of the pod, token and all.
  const status = (await fetch(`${process.env.E2E_URL}/_peer/services/${id}/`, { headers: { Cookie: `webide_token=${process.env.E2E_TOKEN}` } })).status
  assert(status === 403, 'the own origin is refused: ' + status)

  // French.
  const fr = await start({ locale: 'fr-FR' })
  await fr.page.waitForSelector(row)
  const text = await fr.page.textContent('[data-testid=home-services]')
  assert(text.includes('Services partagés') && text.includes('Ollama GPU'), 'in French: ' + text)
  await fr.browser.close()

  // Removed.
  page.once('dialog', (d) => d.accept())
  await page.click(`[data-testid=service-delete-${port}]`)
  await page.waitForSelector(row, { state: 'detached' })
  assert(saved().length === 0, 'removed from services.json')
})
