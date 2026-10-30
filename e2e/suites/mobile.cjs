// Phone layout (375×812, touch): one row of bar (home, project, pod state, grid button); the
// menus, the two icon rails and the desks float over the view while the grid button is pressed;
// one view at a time, full screen: a tool shown from its icon or from the Tools menu, the editor
// back when a file is opened or when the icon of the tool shown is tapped again; the line of the
// caret stays visible when the keyboard shrinks the visible area; the page does not zoom.
const fs = require('fs')
const { run, openProject, assert, pinchRefused, phoneShow, phoneView, OUT, WS } = require('../common.cjs')

fs.writeFileSync(WS + '/demo/long.txt', Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')

const visible = (page, sel) => page.isVisible(sel)
const view = (page) =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('.phone-body > .center, .phone-body > .zone')].filter((e) => e.offsetWidth > 0)
    return shown.map((e) => (e.classList.contains('center') ? 'editor' : e.getAttribute('data-tool'))).join(',')
  })
const active = (page) => phoneView(page)
// The menus mode open: the floating overlays.
const overlays = (page) => visible(page, '[data-testid=phone-overlays]')
const openMode = async (page) => {
  if (!(await overlays(page))) await page.tap('[data-testid=menus-toggle]')
  await page.waitForSelector('[data-testid=phone-overlays]')
}

run(
  async ({ page }) => {
    await openProject(page)
    const meta = await page.getAttribute('meta[name=viewport]', 'content')
    assert(meta.includes('maximum-scale=1'), 'the viewport does not zoom: ' + meta)
    const touchAction = await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)
    assert(touchAction === 'manipulation', 'the document itself refuses pinch and double-tap zoom: touch-action ' + touchAction)
    assert((await pinchRefused(page, 'body')) === true, 'a two-finger pinch started on the page is refused')
    assert((await pinchRefused(page, '.menubar.phone')) === true, 'a pinch started on the bar is refused')
    // iOS still zooms on its own sometimes (a field it focuses, an autofill): the page is
    // brought back to scale 1 by re-applying the viewport meta.
    const zoom = await page.evaluate(() => {
      const vv = window.visualViewport, m = document.querySelector('meta[name=viewport]')
      const before = m.content
      Object.defineProperty(vv, 'scale', { get: () => 2, configurable: true })
      vv.dispatchEvent(new Event('scalechange'))
      const after = m.content
      Object.defineProperty(vv, 'scale', { get: () => 1, configurable: true })
      return { before, after }
    })
    assert(zoom.after !== zoom.before && zoom.after.includes('maximum-scale=1'), 'a zoom put by the system is undone: ' + zoom.after)
    assert(await visible(page, '[data-testid=phone-bar] .menubar-row'), 'one row: home, project, pod state, grid button')
    assert(!(await visible(page, '[data-testid=phone-bar] .menus')), 'no menus row while the mode is closed')
    assert(!(await page.$('[data-testid=mobile-rail]')), 'no row of view icons any more')
    const bar = await page.$eval('[data-testid=phone-bar]', (e) => {
      const row = e.querySelector('.menubar-row').getBoundingClientRect()
      const block = e.querySelector('.mb-project').getBoundingClientRect()
      return {
        rows: [...e.children].filter((c) => c.offsetHeight > 0).length,
        centred: Math.abs((block.left + block.right) / 2 - (row.left + row.right) / 2) < 40,
        icon: !!e.querySelector('[data-testid=menubar-icon]') && !!e.querySelector('.mb-title'),
        branch: !!e.querySelector('[data-testid=branch-selector]'),
        dot: !!e.querySelector('.pod-status .dot') && !e.querySelector('.pod-status .rate'),
        grid: !!e.querySelector('[data-testid=menus-toggle]'),
      }
    })
    assert(bar.rows === 1 && bar.centred && bar.icon && bar.grid && bar.dot && !bar.branch, 'one row, the project centred, the pod dot only: ' + JSON.stringify(bar))
    assert(!(await page.$('.rail')) && !(await page.$('.resizer')), 'no side rails nor resizers')
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    assert(width <= 375, 'nothing wider than the screen: ' + width)
    assert((await view(page)) === 'editor' && (await active(page)) === 'editor', 'the editor first')
    // The bar stays under the editor pane (not a row of the window, as on the desktop), without the desks.
    assert(await visible(page, '.phone-body > .center [data-testid=status-bar]'), 'the status bar stays under the editor pane')
    assert(!(await page.$('[data-testid=status-bar] [data-testid=desks]')), 'the desks are not in the bar of the editor')
    assert(!(await page.$('.app > [data-testid=status-bar]')), 'no window-level bar on a phone')
    await page.screenshot({ path: OUT + '/mobile-editor.png' })

    // The grid button: the menus, the two rails and the desks float over the view.
    await page.tap('[data-testid=menus-toggle]')
    await page.waitForSelector('[data-testid=phone-overlays]')
    assert(await visible(page, '[data-testid=phone-overlays] .menus .menu-btn'), 'the menus float over the view')
    assert(await visible(page, '[data-testid=phone-overlays] .rail-left .rail-btn'), 'the left rail on the left edge')
    assert(await visible(page, '[data-testid=phone-overlays] .rail-right .rail-btn'), 'the right rail on the right edge')
    assert(await visible(page, '[data-testid=phone-overlays] [data-testid=desks]'), 'the desks in the floating bar below')
    const scrim = await page.$eval('[data-testid=phone-scrim]', (e) => {
      const s = getComputedStyle(e)
      return { filter: s.backdropFilter || s.webkitBackdropFilter, events: s.pointerEvents }
    })
    assert(scrim.filter.includes('grayscale') && scrim.events === 'none', 'the view under the mode is dimmed and grey, a tap still reaches it: ' + JSON.stringify(scrim))
    const mode = await page.$eval('[data-testid=phone-bar]', (e) => ({
        pressed: e.querySelector('[data-testid=menus-toggle]').getAttribute('aria-pressed'),
        gridTitle: e.querySelector('[data-testid=menus-toggle]').title,
        gear: e.querySelector('[data-testid=home-btn]').title,
        branch: !!e.querySelector('[data-testid=branch-selector]'),
        project: !!e.querySelector('.mb-title'),
      }))
    assert(mode.pressed === 'true' && mode.gridTitle.startsWith('Menus') && mode.gear.startsWith('Settings') && mode.branch && !mode.project, 'the gear takes the place of the home button, the grid stays pressed, the worktree selector replaces the project: ' + JSON.stringify(mode))
    // The rails come under the menus row, they do not cover it.
    const boxes = await page.evaluate(() => {
      const m = document.querySelector('[data-testid=phone-overlays] .menus').getBoundingClientRect()
      const l = document.querySelector('[data-testid=phone-overlays] .rail-left').getBoundingClientRect()
      const r = document.querySelector('[data-testid=phone-overlays] .rail-right').getBoundingClientRect()
      return { menusLeft: m.left, menusTop: m.top, leftTop: l.top, rightTop: r.top, menusRight: m.right, rightLeft: r.left, w: innerWidth }
    })
    assert(boxes.menusLeft === 0 && boxes.menusRight === boxes.w, 'the menus row spans the whole width, edge to edge: ' + JSON.stringify(boxes))
    assert(boxes.leftTop >= boxes.menusTop && boxes.rightTop >= boxes.menusTop && boxes.menusRight > boxes.rightLeft, 'the rails start under the menus row: ' + JSON.stringify(boxes))
    // The overlays are anchored to the body of the view, not to the viewport: no view shows
    // through between the bar and the menus row, even when the page moves (a safe area, a scroll).
    const glued = () =>
      page.evaluate(() => {
        const bar = document.querySelector('[data-testid=phone-bar]').getBoundingClientRect()
        const body = document.querySelector('.phone-body').getBoundingClientRect()
        const m = document.querySelector('[data-testid=phone-overlays] .menus').getBoundingClientRect()
        const d = document.querySelector('.phone-overlays .phone-desks').getBoundingClientRect()
        return { gap: Math.round(m.top - bar.bottom), body: Math.round(m.top - body.top), desksAboveBody: Math.round(body.bottom - d.bottom), y: Math.round(scrollY) }
      })
    const g0 = await glued()
    assert(g0.gap === 0 && g0.body === 0 && g0.desksAboveBody === 0, 'the menus row is glued under the bar, the desks bar at the bottom: ' + JSON.stringify(g0))
    // A page that scrolls (what a safe area or the keyboard does to the bar): the bar and the
    // overlays move together.
    await page.evaluate(() => {
      const d = document.createElement('div')
      d.id = 'e2e-scroll-spacer'
      d.style.cssText = 'height:400px'
      document.body.appendChild(d)
      window.scrollTo(0, 120)
    })
    await page.waitForTimeout(200)
    const g1 = await glued('scrolled')
    assert(g1.y > 60 && g1.gap === 0 && g1.body === 0, 'scrolled, the menus row stays glued under the bar: ' + JSON.stringify(g1))
    await page.evaluate(() => {
      window.scrollTo(0, 0)
      document.getElementById('e2e-scroll-spacer')?.remove()
    })
    await page.waitForTimeout(200)
    await page.screenshot({ path: OUT + '/mobile-mode.png' })
    // The gear: the settings open, the mode stays open.
    await page.tap('[data-testid=home-btn]')
    await page.waitForSelector('.modal-settings')
    assert(await overlays(page), 'the settings open with the mode kept')
    await page.tap('.modal-settings .modal-head button')
    await page.waitForSelector('.modal-settings', { state: 'detached' })
    assert(!(await overlays(page)), 'a tap on the settings, outside the overlays, closes the mode too')
    // The grid button again: back to the compact bar.
    await page.tap('[data-testid=menus-toggle]')
    await page.waitForSelector('[data-testid=phone-overlays]')
    await page.tap('[data-testid=menus-toggle]')
    await page.waitForSelector('[data-testid=phone-overlays]', { state: 'detached' })
    assert(true, 'a second tap on the grid button closes the mode')
    // A tap on the view, between the overlays, closes the mode.
    await page.tap('[data-testid=menus-toggle]')
    await page.waitForSelector('[data-testid=phone-overlays]')
    await page.tap('.phone-body > .center')
    await page.waitForSelector('[data-testid=phone-overlays]', { state: 'detached' })
    assert(true, 'a tap outside the overlays closes the mode')

    // The menus open from the floating row and fit the screen.
    await openMode(page)
    await page.click('[data-testid=phone-overlays] .menu-btn:has-text("File")')
    await page.waitForSelector('.ctx-menu')
    const box = await page.$eval('.ctx-menu', (e) => e.getBoundingClientRect().right)
    assert(box <= 375, 'the File menu opens and fits the screen')
    // The overlays are mounted outside .app (a Portal): the page refuses the pinch there too.
    assert(!(await page.$eval('.ctx-menu', (e) => !!e.closest('.app'))), 'the menu is a portal outside .app')
    assert((await pinchRefused(page, '.ctx-menu')) === true, 'a pinch started on a portal is refused')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.ctx-menu, [data-testid=phone-overlays]'))
    assert(true, 'Escape closes the menu and the mode')

    // A tool full screen; a file opened brings the editor back.
    await phoneShow(page, 'explorer')
    await page.waitForSelector('.phone-body > .zone[data-tool=explorer]')
    assert((await view(page)) === 'explorer' && (await active(page)) === 'explorer', 'the explorer full screen, alone, the mode closed')
    assert(!(await visible(page, '[data-testid=status-bar]')), 'the bar is hidden with the editor when a tool view is shown')
    await page.screenshot({ path: OUT + '/mobile-explorer.png' })
    await page.click('.tree-row:has-text("long.txt")')
    await page.waitForFunction(() => document.querySelector('.phone-body > .center:not(.hidden) .tab.active')?.textContent.includes('long.txt'))
    assert((await view(page)) === 'editor' && (await active(page)) === 'editor', 'opening a file brings the editor to the front')
    // iOS zooms on a focused field showing text under 16 px: on a phone the editing text is
    // never smaller, and the gutter keeps the size of the lines.
    await page.waitForSelector('.pane.active .ed-content')
    const sizes = await page.evaluate(() => {
      const f = (s) => { const e = document.querySelector(s); return e ? parseFloat(getComputedStyle(e).fontSize) : null }
      return { code: f('.pane.active .ed-content'), gutter: f('.pane.active .ed-gutter-nums') }
    })
    assert(sizes.code >= 16 && sizes.gutter === sizes.code, 'the editor text is 16 px or more, gutter aligned: ' + JSON.stringify(sizes))

    // The Tools menu shows a tool the same way and closes the mode.
    await openMode(page)
    await page.click('[data-testid=phone-overlays] .menu-btn:has-text("Tools")')
    await page.click('.ctx-menu .ctx-item:has-text("Console")')
    await page.waitForSelector('.phone-body > .zone[data-tool=console]')
    assert((await view(page)) === 'console' && (await active(page)) === 'console', 'a tool shown from the menu is full screen')
    assert(!(await overlays(page)), 'the menu entry closes the mode')
    await phoneShow(page, 'assistant')
    await page.waitForSelector('.phone-body > .zone[data-tool=assistant]')
    assert((await view(page)) === 'assistant', 'the assistant full screen')
    const composer = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.ai-composer .ed-content')).fontSize))
    assert(composer >= 16, 'the message box is 16 px or more, iOS does not zoom on it: ' + composer)
    await page.screenshot({ path: OUT + '/mobile-assistant.png' })

    // No field takes the focus by itself (the keyboard would open): the user touches it.
    const typing = () => page.evaluate(() => !!document.activeElement?.matches('input, textarea, .ai-editor .ed-content'))
    await phoneShow(page, 'search')
    await page.waitForSelector('.phone-body > .zone[data-tool=search]')
    await page.waitForTimeout(300)
    assert(!(await typing()), 'the search tool opens without focusing its field')
    await page.tap('.zone[data-tool=search] input')
    assert(await typing(), 'a touch on the search field focuses it')
    await phoneShow(page, 'assistant')
    await page.waitForSelector('.phone-body > .zone[data-tool=assistant] .ai-composer .ed-content')
    await page.waitForTimeout(300)
    assert(!(await typing()), 'the assistant opens without focusing its message box')
    await page.tap('.ai-composer .ed-content')
    assert(await typing(), 'a touch on the message box focuses it')

    // An agent session: its message box (the one of the assistant) in full screen, not focused.
    await phoneShow(page, 'agents')
    await page.tap('[data-testid=agent-card-claude] button:has-text("Open")')
    await page.waitForSelector('.phone-body > .zone[data-tool=agents] [data-testid=agent-tab][data-state=ready]')
    await page.waitForTimeout(300)
    assert(!(await typing()), 'an agent session opens without focusing its message box')
    await page.tap('[data-testid=agent-input] .ed-content')
    assert(await typing(), 'a touch on the box of the agent focuses it')
    await page.keyboard.type('hello')
    await page.tap('[data-testid=agent-send]')
    await page.waitForSelector('.zone[data-tool=agents] [data-testid=agent-message]:has-text("Hello from the")')
    await page.screenshot({ path: OUT + '/mobile-agent.png' })
    await page.tap('[data-testid=agent-tab] .tab-close')
    await page.waitForSelector('[data-testid=agents-launcher]')

    // The icon of a view gives it the focus; the icon of the tool shown brings the editor back.
    await phoneShow(page, 'explorer')
    await page.waitForFunction(() => document.activeElement?.closest('.zone[data-tool=explorer]'))
    assert(true, 'the icon of a tool gives it the focus')
    await phoneShow(page, 'explorer')
    await page.waitForFunction(() => document.activeElement?.classList.contains('ed-content'))
    const editable = () => page.$eval('.pane.active .ed-content', (e) => e.contentEditable !== 'false')
    assert((await active(page)) === 'editor', 'the tool shown tapped again brings the editor back')
    assert(!(await editable()), 'the editor comes back without the keyboard (locked)')
    // Locked: a tap shows the hint; a double tap unlocks with the caret under the finger.
    await page.tap('.pane.active .ed-content')
    await page.waitForSelector('[data-testid=ed-lock-hint]')
    await page.screenshot({ path: OUT + '/mobile-hint.png' })
    assert(!(await editable()), 'a tap shows "Double-tap to edit", the editor stays locked')
    await page.waitForTimeout(600)
    const line = await page.$eval('.pane.active .ed-block, .pane.active .ed-content', (e) => {
      const r = e.getBoundingClientRect()
      return { x: r.left + 30, y: r.top + 8 }
    })
    await page.touchscreen.tap(line.x, line.y)
    await page.touchscreen.tap(line.x, line.y)
    await page.waitForSelector('[data-testid=ed-lock]')
    const state = await page.$eval('.pane.active .ed-content', (e) => [e.contentEditable, document.activeElement === e])
    assert(state[0] !== 'false' && state[1], 'a double tap unlocks the editor and focuses it (keyboard): ' + state)
    await page.keyboard.type('X')
    assert((await page.textContent('.pane.active .ed-content')).split('\n')[0].includes('X'), 'typing edits at the caret, on the line touched')
    await page.tap('[data-testid=ed-lock]')
    assert(!(await editable()) && !(await page.$('[data-testid=ed-lock]')), 'the padlock locks the editing again')
    await page.touchscreen.tap(line.x, line.y)
    await page.touchscreen.tap(line.x, line.y)
    await page.waitForSelector('[data-testid=ed-lock]')
    await phoneShow(page, 'explorer')
    await phoneShow(page, 'explorer')
    assert(!(await editable()), 'another view locks the editor again')

    // The keyboard shrinks the visible area: the line of the caret stays in sight.
    await page.touchscreen.tap(line.x, line.y)
    await page.touchscreen.tap(line.x, line.y)
    await page.waitForSelector('[data-testid=ed-lock]')
    await page.keyboard.press('Control+End')
    await page.screenshot({ path: OUT + '/mobile-unlocked.png' })
    await page.setViewportSize({ width: 375, height: 420 })
    await page.waitForTimeout(400)
    const caret = await page.$eval('.pane.active .ed-curline', (e) => {
      const r = e.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, h: window.visualViewport.height }
    })
    assert(caret.top >= 0 && caret.bottom <= caret.h, `the caret line stays visible above the keyboard: ${JSON.stringify(caret)}`)
    const appH = await page.$eval('.app', (e) => e.getBoundingClientRect().height)
    assert(Math.abs(appH - 420) < 2, 'the page takes the visible height: ' + appH)
    await page.screenshot({ path: OUT + '/mobile-keyboard.png' })
  },
  { mobile: true, viewport: { width: 375, height: 812 } },
)
