// Shared helpers of the browser tests. run.sh sets E2E_URL, E2E_TOKEN, E2E_WS, E2E_OUT.
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { chromium } = require('playwright-core')

function chrome() {
  if (process.env.CHROME) return process.env.CHROME
  const cache = path.join(process.env.HOME, '.cache/ms-playwright')
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : []
  for (const d of dirs) {
    const p = path.join(cache, d, 'chrome-linux64/chrome')
    if (fs.existsSync(p)) return p
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p
  throw new Error('Chromium not found: set CHROME=/path/to/chrome')
}

exports.WS = process.env.E2E_WS
exports.OUT = process.env.E2E_OUT

exports.start = async (opts = {}) => {
  const browser = await chromium.launch({ executablePath: chrome(), headless: true, args: opts.args ?? [] })
  // English interface unless E2E_LOCALE says otherwise (the browser follows the system language).
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile, permissions: opts.permissions ?? [], locale: opts.locale ?? process.env.E2E_LOCALE ?? 'en-US' })
  // The suites written for the Build mode start new conversations in it (the default of the
  // page is the Orchestrator).
  if (!opts.orchestrator)
    await ctx.addInitScript(() => {
      try {
        const p = JSON.parse(localStorage.getItem('webide.llm.prefs') || '{}')
        if (!('defaultMode' in p)) localStorage.setItem('webide.llm.prefs', JSON.stringify({ ...p, defaultMode: 'build' }))
      } catch {}
    })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()))
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  // The relay suite opens the bootstrap page of the relay (its own url); the others the pod.
  await page.goto(opts.url ?? `${process.env.E2E_URL}/?token=${process.env.E2E_TOKEN}`)
  return { browser, ctx, page, errors }
}

/** Opens the demo project from the home page. */
exports.openProject = async (page) => {
  await page.waitForSelector('.home .home-bar')
  await page.waitForFunction(() => document.querySelector('.project-list .project-card, .ws-dir'))
  // Fresh data: the project is added from the folders of the projects folder.
  if (await page.$('.project-open:has-text("demo")')) await page.click('.project-open:has-text("demo")')
  else await page.click('.ws-dir:has-text("demo")')
  await page.waitForSelector('.menubar')
  await page.waitForTimeout(400)
}

/** Opens a file with "go to file". */
/** Text of the message box of the assistant (an editor: its last block ends with a newline). */
exports.composerText = (page, scope = '') => page.$eval((scope + ' .ai-composer .ed-content').trim(), (e) => e.textContent.replace(/\n$/, ''))

exports.open = async (page, name) => {
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.pick-input')
  await page.keyboard.type(name)
  await page.waitForFunction((n) => document.querySelector('.pick-item.selected')?.textContent.includes(n), name)
  await page.keyboard.press('Enter')
  await page.waitForFunction((n) => document.querySelector('.pane.active .tab.active')?.textContent.includes(n), name)
  await page.waitForSelector('.pane.active .ed-content')
  await page.waitForTimeout(300)
}

let failed = 0
exports.assert = (cond, msg) => {
  if (cond) console.log('  ok   ' + msg)
  else {
    console.log('  FAIL ' + msg)
    failed++
    process.exitCode = 1
  }
}

/** Runs a test body, closes the browser, reports page errors as failures. */
exports.run = (body, opts) =>
  (async () => {
    const t = await exports.start(opts)
    try {
      await body(t)
    } catch (e) {
      // A screenshot of the page at the failure helps more than the selector alone.
      await t.page.screenshot({ path: path.join(exports.OUT, 'failure.png') }).catch(() => {})
      throw e
    } finally {
      if (t.errors.length) exports.assert(false, 'page errors:\n    ' + t.errors.join('\n    '))
      await t.browser.close()
    }
  })().then(
    // The suite is over: a fake server still holding a request of the pod (close() waits for
    // it) must not keep node alive, the pod being stopped only after node exits.
    () => process.exit(process.exitCode ?? 0),
    (e) => {
      console.log('  FAIL ' + e.message.split('\n').slice(0, 3).join(' | '))
      process.exit(1)
    },
  )

/** Text of the active editor (without the trailing sentinel newline). */
exports.text = (page) => page.evaluate(() => document.querySelector('.pane.active .ed-content').textContent.slice(0, -1))

/** Calls a tool of the MCP endpoint of the pod, as Claude Code does (in the demo project by default). */
exports.mcp = (name, args = {}) =>
  fetch(process.env.E2E_URL + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.E2E_TOKEN },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cwd: exports.WS + '/demo', ...args } } }),
  }).then((r) => r.json())

/** Opens a folded section of the ticket view by its title. */
exports.unfold = (page, title) => exports.inFrames(page).click(`.tk-section.folded .tk-section-toggle:has-text("${title}")`)

/** Dispatches a two-finger pinch on an element and tells whether the page refused it (the
 * guards of the phone layout). A Touch cannot be built with new Touch() in Chromium. */
exports.pinchRefused = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const touch = (id, x, y) => new Touch({ identifier: id, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y })
    const fire = (type, touches) => {
      const e = new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches })
      el.dispatchEvent(e)
      return e.defaultPrevented
    }
    const a = touch(1, 60, 60)
    const b = touch(2, 160, 60)
    fire('touchstart', [a, b])
    return fire('touchmove', [touch(1, 60, 90), touch(2, 160, 30)])
  }, sel)

const b64u = (b) => Buffer.from(b).toString('base64url')

/** The VAPID token (ES256) verifies with the key the relay sends with it. */
function vapidOK(authz) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authz || '')
  if (!m) return false
  const [head, claims, sig] = m[1].split('.')
  const k = Buffer.from(m[2], 'base64url')
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(k.subarray(1, 33)), y: b64u(k.subarray(33)) }, format: 'jwk' })
  return crypto.verify('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))
}

/** RFC 8291 decryption, the side of the browser. */
function decryptPush(buf, ua, auth) {
  const salt = buf.subarray(0, 16)
  const idlen = buf[20]
  const asPub = buf.subarray(21, 21 + idlen)
  const body = buf.subarray(21 + idlen)
  const secret = ua.computeSecret(asPub)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, info, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(body.subarray(-16))
  const plain = Buffer.concat([d.update(body.subarray(0, -16)), d.final()])
  return plain.subarray(0, plain.lastIndexOf(2)).toString()
}

/** The fake push service of the suites (headless Chromium cannot reach a real one): it listens on
 * the port run.sh gives, records every POST it gets and decrypts its body with the keys of the
 * subscription it made — a suite replaces the subscription of the browser with that one (an
 * endpoint the relay lets through with -push-test-endpoint). */
exports.pushService = () => {
  const port = Number(process.env.E2E_PUSH_PORT)
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const auth = crypto.randomBytes(16)
  const endpoint = `http://127.0.0.1:${port}/push/${crypto.randomBytes(8).toString('hex')}`
  const received = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    let payload = null
    try {
      payload = JSON.parse(decryptPush(body, ua, auth))
    } catch {}
    received.push({ path: req.url, vapid: vapidOK(req.headers.authorization), encoding: req.headers['content-encoding'], topic: req.headers.topic, raw: body, payload })
    res.writeHead(201).end()
  })
  return {
    server,
    received,
    endpoint,
    keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) },
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(port))),
  }
}

/**
 * Installs official plugins (an id or a list) at the next start of the pod: each its release
 * archive (the version of pod/plugins/official/official.json, downloaded once to
 * ~/.cache/web-ide-e2e/plugins, its sha256 checked; or E2E_PLUGIN_<ID>: a local build, a file
 * or the dist folder of its repo), as the only official plugins of the pod. before runs before
 * the restart (the data a migration reads). Answers the lock entry (an object of them by id for
 * a list).
 */
exports.installOfficial = async (ids, before) => {
  const os = require('os')
  const { execFileSync } = require('child_process')
  const DATA = process.env.E2E_DATA
  const arch = 'linux-' + (os.arch() === 'arm64' ? 'arm64' : 'amd64')
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pod/plugins/official/official.json'), 'utf8'))
  const off = path.join(DATA, '..', 'official')
  fs.mkdirSync(path.join(off, 'archives', 'current'), { recursive: true })
  const entries = []
  for (const id of [].concat(ids)) {
    const listed = list.find((e) => e.id === id)
    const entry = listed ? { ...listed } : { id, url: `https://github.com/antennae-space/${id.startsWith('lang-') ? id : 'plugin-' + id}`, constraint: '^1', version: '1.0.0', sha256: {} }
    const local = process.env['E2E_PLUGIN_' + id.toUpperCase().replace(/-/g, '_')]
    let data
    if (local) {
      data = fs.readFileSync(fs.statSync(local).isDirectory() ? path.join(local, `${id}-${arch}.tar.gz`) : local)
      entry.version = JSON.parse(execFileSync('tar', ['xzOf', '-', './plugin.json'], { input: data })).version
    } else {
      const cache = path.join(os.homedir(), '.cache', 'web-ide-e2e', 'plugins', `${id}-${entry.version}-${arch}.tar.gz`)
      if (!fs.existsSync(cache)) {
        const url = `${entry.url}/releases/download/v${entry.version}/${id}-${arch}.tar.gz`
        const r = await fetch(url)
        if (!r.ok) throw new Error(`${url}: ${r.status}`)
        fs.mkdirSync(path.dirname(cache), { recursive: true })
        fs.writeFileSync(cache, Buffer.from(await r.arrayBuffer()))
      }
      data = fs.readFileSync(cache)
    }
    entry.sha256 = { [arch]: crypto.createHash('sha256').update(data).digest('hex') }
    if (!local && listed && listed.sha256[arch] !== entry.sha256[arch]) throw new Error(`the cached archive of ${id} is not the official one`)
    fs.writeFileSync(path.join(off, 'archives', 'current', `${id}-${entry.version}.tar.gz`), data)
    entries.push(entry)
  }
  fs.writeFileSync(path.join(off, 'official.json'), JSON.stringify(entries))
  if (before) await before()
  execFileSync('bash', [process.env.E2E_RESTART_POD])
  const lockFile = path.join(DATA, 'plugins.lock')
  const locked = (id) => fs.existsSync(lockFile) && JSON.parse(fs.readFileSync(lockFile, 'utf8')).plugins[id]
  const all = () => entries.every((e) => locked(e.id))
  for (let i = 0; i < 100 && !all(); i++) await new Promise((r) => setTimeout(r, 100))
  return typeof ids === 'string' ? locked(ids) : Object.fromEntries(entries.map((e) => [e.id, locked(e.id)]))
}

/**
 * The page and its frames as one (#158): a selector is looked for in the page, then in every
 * frame of it (the views of an external plugin, each a frame), the first that has it answering.
 * For the suites of a plugin that moved out of the IDE: page.click(sel) becomes
 * inFrames(page).click(sel); the keyboard, the mouse, goto and reload stay the page's.
 */
exports.inFrames = (page) => {
  const visible = async (h) => h && (await h.isVisible().catch(() => false))
  // A frame just made runs in a process of its own (an opaque origin): the input routed to it
  // a moment after it appears may be lost, so an action waits until the frame is 600 ms old.
  const born = (page.__framesBorn ??= new WeakMap())
  if (!page.__framesWatched) {
    page.__framesWatched = true
    page.on('frameattached', (f) => born.set(f, Date.now()))
  }
  const settle = async (f) => {
    const age = Date.now() - (born.get(f) ?? 0)
    if (age < 600) await page.waitForTimeout(600 - age)
  }
  // The frames shown: a tab switched to is a new frame, and the one of the tab left goes a moment
  // later; a frame whose <iframe> left the page, or is hidden, is not looked into.
  const frames = async () => {
    const out = [page.mainFrame()]
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.isDetached()) continue
      const el = await f.frameElement().catch(() => null)
      if (el && (await el.isVisible().catch(() => false))) out.push(f)
    }
    return out
  }
  // The frame showing the selector (visible unless asked otherwise), waited for.
  async function frameOf(sel, opts = {}) {
    const until = Date.now() + (opts.timeout ?? 30000)
    for (;;) {
      for (const f of await frames()) {
        const h = await f.$(sel).catch(() => null)
        if (h && (opts.state === 'attached' || (await visible(h)))) return f
      }
      if (Date.now() > until) throw new Error(`inFrames: no frame shows ${sel}`)
      await page.waitForTimeout(100)
    }
  }
  const first = async (sel) => {
    for (const f of await frames()) if (await f.$(sel).catch(() => null)) return f
    return null
  }
  // What reads an element, or sets the files of a hidden input, needs it present, not shown.
  const present = ['textContent', 'innerHTML', 'getAttribute', 'isChecked', 'isDisabled', 'isEnabled', 'setInputFiles', 'dispatchEvent', 'inputValue']
  const delegate = (name) => async (sel, ...args) => {
    const f = await frameOf(sel, present.includes(name) ? { state: 'attached' } : {})
    if (!present.includes(name)) await settle(f)
    // A plain click in a plugin's frame: by the DOM, after the focus (which the IDE checks for
    // its dialogs): the mouse's may not reach a frame of another process in time.
    if (name === 'click' && f !== page.mainFrame() && !args.length) {
      await f.focus(sel).catch(() => {})
      return f.$eval(sel, (el) => el.click())
    }
    // A choice in a select of a plugin's frame: focused first, as the user's.
    if (name === 'selectOption' && f !== page.mainFrame()) await f.focus(sel).catch(() => {})
    return f[name](sel, ...args)
  }
  const api = {
    waitForSelector: async (sel, opts = {}) => {
      const state = opts.state ?? 'visible'
      const until = Date.now() + (opts.timeout ?? 30000)
      for (;;) {
        let found = null
        for (const f of await frames()) {
          const h = await f.$(sel).catch(() => null)
          if (h && (state === 'attached' || state === 'detached' || (await visible(h)))) found = h
          if (found) break
        }
        if (state === 'detached' || state === 'hidden') {
          if (!found || (state === 'hidden' && !(await visible(found)))) return null
        } else if (found) return found
        if (Date.now() > until) throw new Error(`inFrames: ${sel} not ${state} in time`)
        await page.waitForTimeout(100)
      }
    },
    $: async (sel) => {
      const f = await first(sel)
      return f ? f.$(sel) : null
    },
    $$: async (sel) => (await Promise.all((await frames()).map((f) => f.$$(sel).catch(() => [])))).flat(),
    $eval: async (sel, fn, arg) => {
      const f = await first(sel)
      if (!f) throw new Error(`inFrames: no element ${sel}`)
      return f.$eval(sel, fn, arg)
    },
    // Over the frames having the selector: arrays put together, numbers added, else the first.
    $$eval: async (sel, fn, arg) => {
      const results = []
      for (const f of await frames()) if (await f.$(sel).catch(() => null)) results.push(await f.$$eval(sel, fn, arg))
      if (!results.length) return page.$$eval(sel, fn, arg)
      if (results.every(Array.isArray)) return results.flat()
      if (results.every((r) => typeof r === 'number')) return results.reduce((a, b) => a + b, 0)
      return results[0]
    },
    // A condition true in one of the frames shown (the page's included), waited for.
    waitForFunction: async (fn, arg, opts = {}) => {
      const until = Date.now() + (opts.timeout ?? 30000)
      for (;;) {
        for (const f of await frames()) if (await f.evaluate(fn, arg).catch(() => false)) return true
        if (Date.now() > until) throw new Error('inFrames: waitForFunction timed out')
        await page.waitForTimeout(100)
      }
    },
    isVisible: async (sel) => {
      for (const f of await frames()) if (await visible(await f.$(sel).catch(() => null))) return true
      return false
    },
    locator: (sel) => ({
      waitFor: (opts) => api.waitForSelector(sel, opts),
      click: (o) => api.click(sel, o),
      textContent: () => api.textContent(sel),
      count: async () => (await api.$$(sel)).length,
    }),
    frameOf,
  }
  for (const m of ['click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'hover', 'textContent', 'innerText', 'innerHTML', 'getAttribute', 'isChecked', 'isDisabled', 'isEnabled', 'selectOption', 'inputValue', 'focus', 'dispatchEvent', 'setInputFiles', 'tap'])
    api[m] = delegate(m)
  return api
}

/**
 * Accepts every confirm of the IDE while the page lives (#158): the dialogs of a plugin's frame
 * are the IDE's (ide.confirm), not the browser's, which page.on('dialog') accepted.
 */
exports.acceptConfirms = (page) => {
  const timer = setInterval(() => void page.evaluate(() => document.querySelector('[data-testid=confirm-ok]')?.click()).catch(() => {}), 300)
  page.on('close', () => clearInterval(timer))
  return () => clearInterval(timer)
}
