// The pack lang-go with its debugger, for the debug suites: installed as an official plugin. Also
// tells whether dlv is installed.
const { execFileSync } = require('child_process')
const { installOfficial } = require('../../../../e2e/common.cjs')

/** dlv is on the PATH the pod gets (its own, or ~/go/bin where go install puts it). */
exports.hasDlv = () => {
  try {
    execFileSync('sh', ['-c', 'command -v dlv'], { env: { ...process.env, PATH: `${process.env.HOME}/go/bin:${process.env.PATH}` }, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Installs the official lang-go (the release archive of official.json, or E2E_PLUGIN_LANG_GO
 *  for a local build): its lock (the grants) is answered. */
exports.installLangGo = () => installOfficial('lang-go')
