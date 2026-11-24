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
  // Shared: the row, the file.
  await page.click('[data-testid=service-add]')
  await page.fill('[data-testid=service-name]', 'Ollama')
  await page.fill('[data-testid=service-port]', String(port))
  await page.click('[data-testid=service-save]')
  await page.waitForSelector(`[data-testid=service-${port}]`)
  const row = `[data-testid=service-${port}]`
  assert(await page.locator(row).evaluate((el) => getComputedStyle(el).borderBottomColor === 'rgba(0, 0, 0, 0)'), 'the final local service has a transparent divider')
  await page.click(`${row} [data-testid=service-details]`)
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
  const checkbox = page.locator(`${row} input[type=checkbox]`)
  assert(await checkbox.isChecked() && await checkbox.getAttribute('data-state') === 'ready', 'a failed service keeps its share checked independently of health')
  assert(await page.locator(`${row} [data-testid=service-open]`).isDisabled() && await page.locator(`${row} [data-testid=service-copy-url]`).isEnabled(), 'an unavailable address can still be copied')
  const service = http.createServer((_req, res) => res.end('OK'))
  await new Promise((done) => service.listen(port, '127.0.0.1', done))
  try {
    await page.waitForSelector(statusLine, { state: 'detached', timeout: 15000 })
    assert(!(await page.locator(`${row}.unavailable`).count()), 'the service recovers while home is open')
    const open = page.locator(`${row} [data-testid=service-open]`)
    assert(await open.getAttribute('target') === '_blank', 'a healthy local service opens in a new tab')
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.locator(`${row} [data-testid=service-copy-url]`).click()
    await page.waitForFunction(async (url) => (await navigator.clipboard.readText()) === url, `http://127.0.0.1:${port}`)
  } finally {
    await new Promise((done) => service.close(done))
  }

  // Control the directory reply. The second tab shows the last known inventory
  // before the first reply, then disables and restores the service address.
  const remote = '[data-testid="link-bravo-bravo-api"]'
  const remoteState = `${remote} [data-testid=link-state]`
  const homeURL = page.url()
  await page.goto('about:blank')
  const stub = (tab, getInventory, beforeLink) => tab.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage(async (message) => {
      const req = JSON.parse(String(message))
      if (req.method === 'services.link' && beforeLink) {
        await beforeLink()
        ws.send(JSON.stringify({ id: req.id, error: { code: -32000, message: 'link failed' } }))
        return
      }
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
    services: [{ id: 'svc', name: 'bravo-api', health: 'unreachable', link: {
      id: 'link', pod: 'bravo', podName: 'bravo', service: 'svc', name: 'bravo-api',
      scope: 'local', on: true, state: 'on', listen: 39418, route: { name: 'lan' }, requests: 0, bytes: 0,
    } }, { id: 'other', name: 'other-api', health: 'ready' }],
  }]
  const seed = await ctx.newPage()
  let finishLink
  const linkRequest = new Promise((done) => { finishLink = done })
  await stub(seed, () => remoteInventory(true), () => linkRequest)
  await seed.goto(homeURL)
  await seed.waitForSelector(`${remote} [data-testid=service-open]`)
  const dividers = await seed.locator('.svc-row').evaluateAll((rows) => rows.map((row) => getComputedStyle(row).borderBottomColor))
  assert(dividers.length >= 2 && dividers.at(-1) === 'rgba(0, 0, 0, 0)' && dividers.slice(0, -1).every((color) => color !== dividers.at(-1)), 'only the last service has a transparent divider: ' + dividers.join(', '))
  const other = seed.getByTestId('link-bravo-other-api')
  assert(await other.getByRole('checkbox').isVisible(), 'unlinked service shows its checkbox')
  assert(await other.getByTestId('service-open').isDisabled() && await other.getByTestId('service-copy-url').isDisabled(), 'address actions stay visible without a link')
  const toggle = other.getByRole('checkbox')
  await toggle.click()
  assert(await toggle.getAttribute('aria-busy') === 'true' && await toggle.evaluate((el) => getComputedStyle(el).animationName === 'svc-check-pulse'), 'only the requested switch pulses')
  await seed.emulateMedia({ reducedMotion: 'reduce' })
  assert(await toggle.evaluate((el) => getComputedStyle(el).animationName === 'none'), 'reduced motion keeps the pending switch still')
  finishLink()
  await seed.waitForSelector('[data-testid="link-bravo-other-api"] input[data-state=off]:not(:checked)')
  await seed.close()

  const delayed = await ctx.newPage()
  let resume
  const first = new Promise((done) => { resume = done })
  let inventory = []
  let requests = 0
  await stub(delayed, async () => { requests++; await first; return inventory })
  try {
    await delayed.goto(homeURL)
    const open = delayed.locator(`${remote} a[data-testid=service-open]`)
    await open.click({ trial: true })
    const elapsed = await delayed.evaluate(() => Math.round(performance.now()))
    assert(elapsed < 1000, 'cached forward is actionable ' + elapsed + ' ms after navigation')
    assert(await open.getAttribute('href') === 'http://127.0.0.1:39418', 'open uses the cached listener')
    assert(await delayed.locator(`${remote} input[data-state=ready]`).isChecked(), 'the active forward stays checked')
    assert(await delayed.getByTestId('link-bravo-other-api').locator('input[data-state=off]').isVisible(), 'the inactive forward stays grey')
    assert(await delayed.locator('.home-bar .svc-loading').isVisible(), 'the heading shows the refresh')
    await delayed.locator(`${remoteState} summary`).click()
    assert(await delayed.locator(`${remoteState} > span`).isVisible() && await delayed.locator(`${remoteState} > span`).textContent() === 'The service did not respond.', 'the cached health detail opens')
    await delayed.locator(`${remote} [data-testid=service-copy-url]`).click()
    await delayed.waitForFunction(() => navigator.clipboard.readText().then((url) => url === 'http://127.0.0.1:39418'))
    await delayed.waitForTimeout(10000)
    assert(requests === 1, 'a slow inventory request finishes before another starts')
    inventory = remoteInventory(false)
    inventory[0].services[0].link.listen = 39419
    resume()
    await delayed.waitForSelector(`${remote} a[href="http://127.0.0.1:39419"]`)
    assert(await delayed.isVisible(`${remoteState}:has-text("bravo offline")`), 'the live reply updates the warning and listener independently')
    inventory = remoteInventory(true)
    delete inventory[0].services[0].link
    await delayed.waitForSelector(`${remote} button[data-testid=service-open]:disabled`, { timeout: 15000 })
    assert(await delayed.locator(`${remote} [data-testid=service-copy-url]`).isDisabled(), 'removing the link clears the cached address')
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
  assert(text.includes('Services') && text.includes('Ollama GPU'), 'in French: ' + text)
  await fr.browser.close()

  // The service stays visible when management is closed.
  assert(!(await page.isVisible(`[data-testid=service-edit-${port}]`)), 'service settings are closed after navigation')
  await page.waitForSelector(row)
  await page.click(`${row} [data-testid=service-details]`)

  // Removed.
  page.once('dialog', (d) => d.accept())
  await page.click(`[data-testid=service-delete-${port}]`)
  await page.waitForSelector(row, { state: 'detached' })
  assert(saved().length === 0, 'removed from services.json')
})
