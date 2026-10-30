// The pack lang-go with its debugger, for the debug suites: a local build (E2E_PLUGIN_LANG_GO) or
// a manifest written here, installed as an official plugin. Also tells whether dlv is installed.
const fs = require('fs')
const os = require('os')
const path = require('path')
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

/** Installs lang-go: its lock (the grants) is answered. */
exports.installLangGo = async () => {
  if (!process.env.E2E_PLUGIN_LANG_GO) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lang-go-'))
    const manifest = JSON.stringify(
      {
        id: 'lang-go', name: 'Go', version: '1.2.0', apiVersion: 1, ide: '*',
        permissions: ['program:gopls', 'debugger:go'],
        contributes: {
          languages: [{ id: 'go', name: 'Go', extensions: ['.go'], markers: ['go.mod'] }],
          debuggers: [
            {
              type: 'go', label: 'Go (Delve)', languages: ['go'],
              argv: ['dlv', 'dap', '--listen', '127.0.0.1:{port}'], transport: 'tcp',
              install: { manager: 'go', packages: ['github.com/go-delve/delve/cmd/dlv@latest'] },
              templates: [
                { label: 'Launch the package', request: 'launch', config: { program: '${workspaceFolder}' } },
                { label: 'Attach to a process', request: 'attach', config: { processId: '${env:PID}' } },
              ],
            },
          ],
        },
      },
      null,
      2,
    )
    fs.writeFileSync(path.join(dir, 'plugin.json'), manifest)
    const arch = 'linux-' + (os.arch() === 'arm64' ? 'arm64' : 'amd64')
    // The archive lives outside the folder it packs (tar would read itself).
    const tar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lang-go-out-')), `lang-go-${arch}.tar.gz`)
    execFileSync('tar', ['czf', tar, '-C', dir, '.'])
    process.env.E2E_PLUGIN_LANG_GO = tar
  }
  return installOfficial('lang-go')
}
