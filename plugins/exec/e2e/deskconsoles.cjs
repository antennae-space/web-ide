// Consoles on desks (#197, #198): a console belongs to the desk it was opened on and only that desk
// lists it; it moves to another desk from its tab and keeps running; removing a desk lists its
// consoles in the confirmation and ends them.
const { run, openProject, assert, OUT } = require('../../../e2e/common.cjs')

const consoleTabs = (page) => page.$$eval('.console-tabs .tab .tab-title', (l) => l.map((e) => e.textContent).filter((x) => x !== 'New tab'))
const showConsole = async (page) => {
  if (!(await page.isVisible('.console-tabs'))) await page.keyboard.press('Alt+F12')
  await page.waitForSelector('.console-tabs')
}
const newTerminal = async (page, title) => {
  await page.click('[data-testid=console-new-tab-button]')
  await page.click('[data-testid=cmd-launcher] [data-testid=cmd-tile]:has-text("New terminal")')
  await page.waitForSelector('.console-tabs .tab.active .tab-title:text-is("Terminal")')
  await page.dblclick('.console-tabs .tab.active')
  await page.fill('.modal input', title)
  await page.keyboard.press('Enter')
  await page.waitForSelector(`.console-tabs .tab .tab-title:text-is("${title}")`)
}
const goDesk = async (page, n) => {
  await page.click(`[data-testid=desk-${n}]`)
  await page.waitForFunction((n) => (n === 1 ? !location.pathname.includes('/desk/') : location.pathname.endsWith('/desk/' + n)), n)
  await showConsole(page)
  await page.waitForTimeout(300)
}

run(async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await openProject(page)
  await showConsole(page)
  await newTerminal(page, 'One')

  // Desk 2: its Console does not list the console of desk 1; a console opened here stays here.
  await page.click('[data-testid=desk-add]')
  await page.waitForFunction(() => location.pathname.endsWith('/desk/2'))
  await showConsole(page)
  await page.waitForTimeout(300)
  assert((await consoleTabs(page)).length === 0, 'desk 2 lists no console of desk 1: ' + (await consoleTabs(page)))
  await newTerminal(page, 'Two')
  await goDesk(page, 1)
  assert((await consoleTabs(page)).join() === 'One', 'desk 1 lists its console only: ' + (await consoleTabs(page)))

  // A reload keeps each console on its desk.
  await goDesk(page, 2)
  await page.reload()
  await page.waitForSelector('.menubar')
  await showConsole(page)
  await page.waitForSelector('.console-tabs .tab .tab-title:text-is("Two")')
  assert((await consoleTabs(page)).join() === 'Two', 'desk 2 after a reload: ' + (await consoleTabs(page)))

  // Move to desk 1 from the tab menu: it leaves desk 2 and shows on desk 1, still running.
  await page.click('.console-tabs .tab:has-text("Two")', { button: 'right' })
  await page.click('.ctx-menu >> text=Move to desk 1')
  await page.waitForFunction(() => ![...document.querySelectorAll('.console-tabs .tab-title')].some((e) => e.textContent === 'Two'))
  await goDesk(page, 1)
  await page.waitForSelector('.console-tabs .tab .tab-title:text-is("Two")')
  assert((await consoleTabs(page)).sort().join() === 'One,Two', 'the console moved to desk 1: ' + (await consoleTabs(page)))
  assert(!(await page.$('.console-tabs .tab.exited:has-text("Two")')), 'the moved console still runs')

  // Removing desk 2 lists its console in the confirmation and ends it.
  await goDesk(page, 2)
  await newTerminal(page, 'Doomed')
  await page.click('[data-testid=desk-2]', { button: 'right' })
  await page.click('.ctx-menu >> text=Remove the desk')
  await page.waitForSelector('.modal .confirm-text')
  const text = await page.textContent('.modal .confirm-text')
  assert(text.includes('Console “Doomed”') && !text.includes('“One”'), 'the confirmation lists the consoles of the desk: ' + text)
  await page.screenshot({ path: OUT + '/deskconsoles-remove.png' })
  await page.click('[data-testid=confirm-ok]')
  await page.waitForFunction(() => !location.pathname.includes('/desk/') && !document.querySelector('[data-testid=desk-2]'))
  // A new desk takes number 2 again: the console ended with the old one, nothing comes back.
  await page.click('[data-testid=desk-add]')
  await page.waitForFunction(() => location.pathname.endsWith('/desk/2'))
  await showConsole(page)
  await page.waitForTimeout(500)
  assert((await consoleTabs(page)).length === 0, 'the consoles of the removed desk ended: ' + (await consoleTabs(page)))

  // A desk with nothing running is removed with the plain question (no list).
  await goDesk(page, 1)
  await page.click('[data-testid=desk-2]', { button: 'right' })
  await page.click('.ctx-menu >> text=Remove the desk')
  await page.waitForFunction(() => !document.querySelector('[data-testid=desk-2]'))
  assert(!(await page.$('.modal .confirm-text')), 'no list when nothing ends with the desk')
  assert((await consoleTabs(page)).sort().join() === 'One,Two', 'desk 1 keeps its consoles: ' + (await consoleTabs(page)))
})
