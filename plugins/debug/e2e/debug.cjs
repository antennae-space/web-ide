// The debug host (#188) with Go: the official pack lang-go declares dlv as its adapter (its
// release archive, or E2E_PLUGIN_LANG_GO for a local build), the pod runs it on its grant
// debugger:go, a Go program stops on a line breakpoint, and the stack and a local variable are
// read through the debug.* methods. Skipped when dlv is not installed.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { run, openProject, assert, installOfficial, WS } = require('../../../e2e/common.cjs')

try {
  execFileSync('sh', ['-c', 'command -v dlv'], { env: { ...process.env, PATH: `${process.env.HOME}/go/bin:${process.env.PATH}` }, stdio: 'ignore' })
} catch {
  console.log('  (dlv not installed: suite skipped)')
  process.exit(0)
}

// The lines of the fixture program (a local variable read after the stop).
const FIXTURE = `package main

import "fmt"

func greet(name string) string {
	greeting := "hello " + name
	return greeting
}

func main() {
	fmt.Println(greet("monde"))
}
`
const BREAK_LINE = 7 // return greeting

run(async ({ page }) => {
  // The pack, with its debuggers: the release archive of official.json, or a local build.
  const lock = await installOfficial('lang-go')
  assert(lock?.grants.includes('debugger:go'), 'lang-go installed with its adapter granted: ' + JSON.stringify(lock?.grants))

  // The project: a Go package of its own, its configuration in .ide/debug.json.
  const demo = path.join(WS, 'demo')
  fs.mkdirSync(path.join(demo, 'debug'), { recursive: true })
  fs.writeFileSync(path.join(demo, 'debug', 'main.go'), FIXTURE)
  fs.mkdirSync(path.join(demo, '.ide'), { recursive: true })
  fs.writeFileSync(
    path.join(demo, '.ide', 'debug.json'),
    JSON.stringify({ configurations: [{ name: 'Launch the package', type: 'go', request: 'launch', program: '${workspaceFolder}/debug' }] }, null, 2),
  )
  await openProject(page)

  // The pod answered to the window: a socket of its own, on the project opened.
  await page.evaluate(async () => {
    const ws = new WebSocket(`ws://${location.host}/ws`)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('the pod refused the socket'))
    })
    window.__d = { ws, seq: 0, waiters: {}, events: [] }
    window.__call = (method, params) =>
      new Promise((res) => {
        const id = ++window.__d.seq
        window.__d.waiters[id] = res
        ws.send(JSON.stringify({ id, method, params }))
      })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && window.__d.waiters[m.id]) {
        window.__d.waiters[m.id](m)
        delete window.__d.waiters[m.id]
      } else if (m.event) window.__d.events.push(m)
    }
    const list = await window.__call('projects.list', {})
    const id = list.result.find((p) => p.name === 'demo')?.id
    await window.__call('project.open', { id })
  })
  const call = async (method, params = {}) => {
    const res = await page.evaluate(
      async ([method, params]) => {
        const s = window.__d
        const id = ++s.seq
        s.ws.send(JSON.stringify({ id, method, params }))
        return await new Promise((res) => s.waiters[id] = res)
      },
      [method, params],
    )
    if (res.error) throw new Error(`${method}: ${res.error.message}`)
    return res.result
  }
  const events = () => page.evaluate(() => window.__d.events.map((e) => ({ event: e.event, data: e.data })))
  // An adapter writes a string with its quotes: the value as the editor shows it.
  const unquote = (v) => String(v ?? '').replace(/^"|"$/g, '')
  const waitEvent = async (name, timeout = 40000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const hit = (await events()).find((e) => e.event === name)
      if (hit) return hit.data
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`no ${name} event`)
  }

  // The configurations of .ide/debug.json and the templates of the pack.
  const cfgs = await call('debug.configurations')
  assert(cfgs.configurations?.[0]?.name === 'Launch the package', 'debug.configurations reads .ide/debug.json: ' + JSON.stringify(cfgs.configurations))
  assert((cfgs.templates || []).some((t) => t.label === 'Attach to a process'), 'the templates of the pack are offered: ' + JSON.stringify(cfgs.templates?.map((t) => t.label)))
  const adapters = await call('debug.debuggers')
  assert(adapters?.[0]?.program === 'dlv' && adapters[0].path, 'the adapter of the pack is found: ' + JSON.stringify(adapters))

  // A line breakpoint, saved in .ide/breakpoints.json of the worktree.
  const saved = await call('debug.setBreakpoints', { file: 'debug/main.go', breakpoints: [{ line: BREAK_LINE, condition: 'name == "monde"', enabled: true }] })
  assert(saved.breakpoints?.[0]?.line === BREAK_LINE, 'debug.setBreakpoints saves the breakpoint: ' + JSON.stringify(saved.breakpoints))
  const stored = JSON.parse(fs.readFileSync(path.join(demo, '.ide', 'breakpoints.json'), 'utf8'))
  assert(stored.files['debug/main.go']?.[0]?.condition === 'name == "monde"', '.ide/breakpoints.json holds it')

  // The session: dlv dap starts, the program runs, it stops on the line.
  let session
  try {
    session = await call('debug.start', { name: 'Launch the package', file: 'debug/main.go' })
  } catch (e) {
    const out = (await events()).filter((x) => x.event === 'debug.output').map((x) => x.data.output).join('')
    throw new Error(`${e.message} | adapter output: ${out}`)
  }
  assert(session.id && session.state === 'running', 'debug.start runs the program: ' + JSON.stringify(session))
  const stopped = await waitEvent('debug.stopped')
  assert(stopped.session === session.id && stopped.line === BREAK_LINE, `debug.stopped at debug/main.go:${BREAK_LINE}: ${JSON.stringify(stopped)}`)
  assert(path.basename(stopped.file) === 'main.go', 'the stop names its file: ' + stopped.file)
  const sessions = await call('debug.sessions')
  assert(sessions.some((s) => s.id === session.id && s.state === 'stopped'), 'the session is paused: ' + JSON.stringify(sessions.map((s) => s.state)))

  // The threads, the frames, the scopes and a local variable.
  const threads = await call('debug.threads', { session: session.id })
  assert(threads.threads?.length > 0, 'debug.threads: ' + JSON.stringify(threads.threads?.map((t) => t.name)))
  const stack = await call('debug.stack', { session: session.id })
  const frames = stack.stackFrames || []
  assert(frames.some((f) => f.name.endsWith('.greet')) && frames.some((f) => f.name === 'main.main'),
    'debug.stack reads the frames: ' + JSON.stringify(frames.map((f) => f.name)))
  const frame = frames.find((f) => f.name.endsWith('.greet'))
  assert(frame.line === BREAK_LINE, 'the frame is at the line: ' + JSON.stringify(frame))
  const scopes = await call('debug.scopes', { session: session.id, frame: frame.id })
  const scope = (scopes.scopes || []).find((s) => s.name === 'Locals') || scopes.scopes?.[0]
  assert(scope, 'debug.scopes: ' + JSON.stringify(scopes.scopes))
  const vars = await call('debug.variables', { session: session.id, reference: scope.variablesReference })
  const greeting = (vars.variables || []).find((v) => v.name === 'greeting')
  assert(greeting && unquote(greeting.value) === 'hello monde', 'debug.variables reads a local: ' + JSON.stringify(vars.variables))
  assert(greeting.type === 'string', 'a variable carries its type: ' + JSON.stringify(greeting))

  // The output of the program reaches the windows, and stopping the session ends it.
  const out = await call('debug.evaluate', { session: session.id, expression: 'greeting', frame: frame.id })
  assert(unquote(out.result) === 'hello monde', 'debug.evaluate in the paused frame: ' + JSON.stringify(out))
  await call('debug.stop', { session: session.id })
  const after = await call('debug.sessions')
  assert(!after.some((s) => s.id === session.id), 'debug.stop ends the session: ' + JSON.stringify(after))
  assert(fs.existsSync(path.join(demo, '.ide', 'debug.json')), '.ide/debug.json is still there')
})
