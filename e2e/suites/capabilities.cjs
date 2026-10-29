// Services between external plugins (#155): alpha provides the capability greeting, beta
// requires it, both official here. In the page, beta's frame calls alpha's background frame
// (ide.use), sees the values it publishes and its events, opens alpha's modal view; on the pod,
// beta's backend calls alpha's (service.call) and hears its events (service.on). Without
// requires, or out of alpha's namespace, refused. alpha disabled turns beta off. A link of a
// plugin (contributes.links) opens its view from the address.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { run, openProject, assert, installOfficial, mcp, WS } = require('../common.cjs')

const alphaJS = `
let count = 0
ide.register({
  services: {
    greeting: {
      hello: (name) => {
        count++
        ide.publish('greeting', 'count', count)
        ide.emit('greeting', 'said', name)
        return 'Hello ' + name + ' from the frame of alpha'
      },
    },
  },
  views: {
    pick: (el, ide) => {
      el.innerHTML = '<p id="asked">' + JSON.stringify(ide.view.state) + '</p><button id="choose">choose</button>'
      el.querySelector('#choose').onclick = () => ide.closeModal({ chosen: 'green' })
    },
    note: (el, ide) => {
      el.innerHTML = '<p id="note">' + JSON.stringify(ide.view.state) + '</p><button id="opened">opened</button><button id="ask">ask</button><button id="answer">answer</button><button id="notify">notify</button><button id="git">git</button><button id="worktree">worktree</button><button id="unworktree">unworktree</button><button id="md">md</button><button id="agents">agents</button><button id="close">close</button><p id="proj"></p><pre id="out"></pre><pre id="choice"></pre>'
      // #157: its status items, a choice of their menu back; the IDE's Markdown.
      ide.setStatus([{ id: 'alpha-mood', text: 'Mood: calm', title: 'The mood of alpha', menu: [{ id: 'calm', label: 'Calm', checked: true }, { id: 'busy', label: 'Busy' }] }])
      ide.onStatus((e) => (el.querySelector('#choice').textContent = e.item + '=' + e.choice))
      el.querySelector('#md').onclick = () => ide.markdown('**bold** <img src=x onerror=alert(1)>').then((h) => (el.querySelector('#out').textContent = h))
      // #158: its tab's title, its project, its tab closed by itself.
      ide.setTitle('Alpha note')
      el.querySelector('#proj').textContent = ide.project ? ide.project.id + ' ' + ide.project.name : 'none'
      el.querySelector('#close').onclick = () => ide.closeView()
      el.querySelector('#agents').onclick = () => ide.use('agents').call('catalog').then((r) => (el.querySelector('#out').textContent = JSON.stringify(r)), (e) => (el.querySelector('#out').textContent = 'error: ' + e.message))
      for (const b of ['opened', 'ask', 'answer', 'notify', 'git', 'worktree', 'unworktree'])
        el.querySelector('#' + b).onclick = () => ide.rpc('alpha.' + b).then((r) => (el.querySelector('#out').textContent = JSON.stringify(r)), (e) => (el.querySelector('#out').textContent = 'error: ' + e.message))
    },
  },
})
`

const betaJS = `
ide.register({
  views: {
    beta: (el, ide) => {
      el.innerHTML = '<button id="console">console</button><button id="chat">chat</button><pre id="chatid"></pre><button id="call">call</button><button id="modal">modal</button><button id="ask">ask</button><button id="listen">listen</button><button id="heard">heard</button><button id="foreign">foreign</button><button id="unrequired">unrequired</button><pre id="answer"></pre><pre id="count"></pre><pre id="said"></pre>'
      const $ = (s) => el.querySelector(s)
      const show = (p) => p.then((r) => ($('#answer').textContent = typeof r === 'string' ? r : JSON.stringify(r)), (e) => ($('#answer').textContent = 'error: ' + e.message))
      const greeting = ide.use('greeting')
      greeting.onValue('count', (n) => ($('#count').textContent = 'count ' + n))
      greeting.on('said', (name) => ($('#said').textContent = 'said ' + name))
      $('#call').onclick = () => show(greeting.call('hello', 'Ada'))
      $('#modal').onclick = () => show(ide.openModal('pick', { color: '?' }, { plugin: 'alpha', title: 'Pick a color', size: 'small' }))
      $('#ask').onclick = () => show(ide.rpc('beta.ask'))
      $('#listen').onclick = () => show(ide.rpc('beta.listen'))
      $('#heard').onclick = () => show(ide.rpc('beta.heard'))
      $('#foreign').onclick = () => show(ide.rpc('beta.foreign'))
      $('#unrequired').onclick = () => show(ide.use('other').call('x'))
      // #167: the bridges of the core, with their grants.
      const term = ide.use('terminal'), assistant = ide.use('assistant')
      $('#console').onclick = () => show(term.call('open', { command: ['sh', '-c', 'echo bridged-$((40+2)); sleep 60'], title: 'Bridged' }).then((id) => (term.call('show', id), 'opened')))
      assistant.onValue('chat', (c) => ($('#chatid').textContent = c && c.id ? 'chat ' + c.id : ''))
      $('#chat').onclick = () => show(assistant.call('newChat', { mode: 'build', title: 'Bridged chat' }).then(() => 'started'))
    },
  },
})
`

run(async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-services-'))
  const goBin = [process.env.GO, path.join(os.homedir(), 'sdk/go/bin/go'), 'go'].find((g) => g && (g === 'go' || fs.existsSync(g)))
  const backend = path.join(tmp, 'backend')
  execFileSync(goBin, ['build', '-o', backend, path.join(__dirname, '..', 'fixtures', 'capabilities-backend', 'main.go')], { env: { ...process.env, CGO_ENABLED: '0' } })
  const archive = (id, manifest, js) => {
    const dir = path.join(tmp, id)
    fs.mkdirSync(path.join(dir, 'web'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', apiVersion: 1, ide: '*', backend: 'bin/' + id, ...manifest }))
    fs.writeFileSync(path.join(dir, 'web', 'index.js'), js)
    fs.copyFileSync(backend, path.join(dir, 'bin', id))
    fs.chmodSync(path.join(dir, 'bin', id), 0o755)
    const file = path.join(tmp, id + '.tar.gz')
    execFileSync('tar', ['czf', file, '-C', dir, '.'])
    process.env['E2E_PLUGIN_' + id.toUpperCase()] = file
  }
  archive('alpha', {
    name: 'Alpha', provides: ['greeting'], requires: ['agents'], permissions: ['git', 'worktrees'],
    contributes: {
      modals: [{ id: 'pick', label: 'Pick' }], tabViews: [{ id: 'note', label: 'Note' }], links: [{ param: 'greet', view: 'note' }],
      mcpTools: ['alpha_where'], toolSchemas: { alpha_where: { description: 'Tells the scope of the call', properties: {} } },
      questions: true, hooks: ['project.open'],
    },
  }, alphaJS)
  archive('beta', { name: 'Beta', requires: ['greeting', 'terminal', 'assistant'], permissions: ['use:terminal', 'use:assistant'], contributes: { tools: [{ id: 'beta', label: 'Beta', icon: 'sparkle', zone: 'right' }] } }, betaJS)
  await installOfficial(['alpha', 'beta'])
  // The demo project a git repository, for the git of alpha (#157).
  const demo = path.join(WS, 'demo')
  const git = (...a) => execFileSync('git', a, { cwd: demo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'demo')

  await openProject(page)
  await page.waitForSelector('.rail-btn[data-id=beta]')
  if (!(await page.isVisible('iframe.plugin-frame[data-view=beta]'))) await page.click('.rail-btn[data-id=beta]')
  const beta = page.frameLocator('iframe.plugin-frame[data-view=beta]')
  await beta.locator('#call').waitFor()
  const answer = async (button) => {
    await beta.locator('#' + button).click()
    await beta.locator('#answer:not(:empty)').waitFor()
    const got = await beta.locator('#answer').textContent()
    await beta.locator('#answer').evaluate((e) => (e.textContent = ''))
    return got
  }

  // #167: beta opens a console through the bridge of terminal (its command runs), and starts a
  // conversation of the assistant, whose id it follows.
  let got = await answer('console')
  assert(got === 'opened', 'a console opened through the bridge: ' + got)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('bridged-42'), null, { timeout: 10000 })
  assert(true, 'its command ran in a console of the IDE')
  if (!(await page.isVisible('iframe.plugin-frame[data-view=beta]'))) await page.click('.rail-btn[data-id=beta]')
  const chatBefore = await beta.locator('#chatid').textContent()
  got = await answer('chat')
  assert(got === 'started', 'a conversation started through the bridge: ' + got)
  let chatNow = chatBefore
  for (let i = 0; i < 50 && (chatNow === chatBefore || !chatNow); i++) {
    await page.waitForTimeout(100)
    chatNow = await beta.locator('#chatid').textContent()
  }
  assert(chatNow.startsWith('chat ') && chatNow !== chatBefore, 'beta follows the conversation shown: ' + chatBefore + ' -> ' + chatNow)

  // In the page: alpha's background frame answers beta's call, its value and event reach beta.
  got = await answer('call')
  assert(got === 'Hello Ada from the frame of alpha', 'a call of a service in the page: ' + got)
  await beta.locator('#count:has-text("count 1")').waitFor()
  await beta.locator('#said:has-text("said Ada")').waitFor()
  assert(true, 'a value and an event of the service')
  got = await answer('unrequired')
  assert(got.startsWith('error:') && got.includes('does not require other'), 'a capability not required: ' + got)

  // alpha's modal view opened by beta, titled with alpha's name, its result back to beta.
  await beta.locator('#modal').click()
  await page.waitForSelector('.modal-plugin iframe[data-plugin=alpha][data-view=pick]')
  const title = await page.textContent('.modal-plugin .modal-head')
  assert(title.includes('Alpha · Pick a color'), 'the modal of the provider, titled with its name: ' + title)
  const pick = page.frameLocator('.modal-plugin iframe[data-view=pick]')
  assert((await pick.locator('#asked').textContent()) === '{"color":"?"}', 'its state')
  await pick.locator('#choose').click()
  await beta.locator('#answer:not(:empty)').waitFor()
  got = await beta.locator('#answer').textContent()
  await beta.locator('#answer').evaluate((e) => (e.textContent = ''))
  assert(got === '{"chosen":"green"}', 'the result of the modal to beta: ' + got)

  // On the pod: beta's backend calls alpha's, which knows who asked, and hears its event.
  got = await answer('listen')
  assert(got.includes('"provider":"alpha"'), 'listening to the service: ' + got)
  got = await answer('ask')
  assert(got === 'Hello beta from the backend of alpha, asked by beta', 'service.call: ' + got)
  for (let i = 0; i < 30 && !(got = await answer('heard')).includes('alpha.greeted'); i++) await page.waitForTimeout(100)
  assert(got === 'alpha.greeted "beta"', 'service.on: an event of alpha reaches beta: ' + got)
  got = await answer('foreign')
  assert(got.includes('beta.ask is not a method of Alpha'), 'a method out of the provider: ' + got)

  // A link of a plugin: ?greet= opens alpha's view with the value in its state.
  const url = new URL(page.url())
  await page.goto(url.origin + url.pathname + '?greet=hello')
  const note = page.frameLocator('iframe.plugin-frame[data-view=note]')
  await note.locator('#note').waitFor()
  assert((await note.locator('#note').textContent()) === '{"greet":"hello"}', 'the link opens the view')
  assert(!page.url().includes('greet='), 'the parameter is taken out of the address')

  // #156: the hook project.open reached alpha's backend; its MCP tool answers with the scope of
  // the call; its question shows in the Questions tool and the answer reaches it; notify needs
  // its grant, not given here.
  const alpha = async (button) => {
    await note.locator('#out').evaluate((e) => (e.textContent = ''))
    await note.locator('#' + button).click()
    await note.locator('#out:not(:empty)').waitFor()
    return note.locator('#out').textContent()
  }
  for (let i = 0; i < 30 && (got = await alpha('opened')) !== 'true'; i++) await page.waitForTimeout(100)
  assert(got === 'true', 'project.open reached the backend: ' + got)
  const where = await mcp('alpha_where', {})
  const text = where.result?.content?.[0]?.text ?? JSON.stringify(where)
  assert(/^alpha_where: project \S+, main \S+$/.test(text) && !where.result.isError, 'an MCP tool of an external plugin, with its scope: ' + text)
  assert((await alpha('ask')) === '"asked"', 'alpha asks')
  await page.click('.rail-btn[data-id=questions]')
  await page.waitForSelector('[data-testid=question-item][data-source=alpha], [data-testid=question-modal]')
  if (!(await page.$('[data-testid=question-modal]'))) await page.click('[data-testid=question-item][data-source=alpha]')
  assert((await page.textContent('[data-testid=question-modal]')).includes('Greet everyone?'), 'its question in the Questions tool')
  await page.click('[data-testid=question-modal] [data-testid=question-option-yes]')
  await page.waitForSelector('[data-testid=question-modal]', { state: 'detached' })
  got = await alpha('answer')
  assert(got === '"q1=yes"', 'the answer reaches its backend: ' + got)
  got = await alpha('notify')
  assert(got.includes('notify is not granted to Alpha'), 'notify without its grant: ' + got)

  // #157: git by the core, a setting that would run a program refused; a worktree made by git
  // and registered as a project of the pod, then unregistered.
  got = await alpha('git')
  assert(got.startsWith('"true\\n|') && got.includes('core.pager is refused'), 'git by the core: ' + got)
  got = await alpha('worktree')
  assert(got.includes('-t9'), 'a worktree registered: ' + got)
  const projects = () => JSON.parse(fs.readFileSync(path.join(process.env.E2E_DATA, 'projects.json'), 'utf8'))
  assert(JSON.stringify(projects()).includes('#9 Alpha'), 'its project in the registry')
  assert((await alpha('unworktree')) === '"unregistered"', 'unregistered')
  assert(!JSON.stringify(projects()).includes('#9 Alpha'), 'its project gone')

  // Its status item while its tab is in focus, a choice of its menu back to the frame.
  await note.locator('#note').click()
  await page.waitForSelector('[data-testid=status-alpha-mood]:has-text("Mood: calm")')
  await page.click('[data-testid=status-alpha-mood]')
  await page.click('.ctx-menu >> text=Busy')
  await note.locator('#choice:has-text("alpha-mood=busy")').waitFor()
  assert(true, 'a status item of a plugin tab and its menu')
  got = await alpha('md')
  assert(got.includes('<strong>bold</strong>') && !got.includes('onerror'), 'the IDE renders Markdown, sanitized: ' + got)

  // #158: the title it gave its tab, its project; it closes its tab.
  await page.waitForSelector('.tab:has-text("Alpha note")')
  const proj = await note.locator('#proj').textContent()
  assert(/^\S+ demo$/.test(proj), 'the frame knows its project: ' + proj)

  // #167: a capability of a built-in through the bridge of the core, refused without its grant.
  got = await alpha('agents')
  assert(got.includes('use:agents is not granted to Alpha'), 'a bridge without its grant: ' + got)
  await note.locator('#close').click()
  await page.waitForSelector('.tab:has-text("Alpha note")', { state: 'detached' })
  assert(true, 'a frame closes its own tab')

  // alpha disabled on the project: beta, which requires it, is off too; back with it.
  page.on('dialog', (d) => d.accept())
  await page.click('.menubar button[title^="Settings"]')
  await page.click('.settings-nav button:has-text("Plugins")')
  await page.uncheck('[data-testid=plugin-alpha]')
  await page.waitForFunction(() => !document.querySelector('.rail-btn[data-id=beta]'))
  const row = await page.textContent('.plugin-row[data-plugin=beta]')
  assert(row.includes('greeting'), 'beta tells what it misses: ' + row)
  await page.check('[data-testid=plugin-alpha]')
  await page.waitForSelector('.rail-btn[data-id=beta]')
  assert(true, 'beta on again with alpha')
})
