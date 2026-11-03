import { readFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import semver from 'semver'

const exec = promisify(execFile)
const targets = ['0.2.1-rc.5', '0.2.2-alpha.2']
const rejected = ['0.2.0-rc.2', '0.2.1-rc.4', '0.2.1', '0.2.2-alpha.1', '0.2.2-alpha.3', '0.2.2']
const checks = {
  'dsh-llm': ['createUserMessage'],
  'dsh-tools': ['validateJsonSchemaValue'],
  'dsh-api-session-controller': ['sessionController'],
  'dsh-agent': ['agent/inbox/claimed', 'steer'],
  'dsh-settings': ['SettingsForms', 'update(ns'],
  'dsh-host-webserver': ['webServer'],
  'dsh-client-connection': ['requestRejection'],
  'dsh-user-questions': ['userQuestions'],
  'dsh-user-approval': ['approval/request'],
  'dsh-workspace': ['workspaceRegistry'],
  'dsh-session-query': ['sessionQuery'],
  'dsh-client-ui-renderer': ['slots: SlotRegistry', 'inject('],
  'dsh-client-ui-slots': ['register(', 'label'],
  'dsh-client-ui-settings': ['configForms', 'settings.section'],
  'dsh-client-ui-sidebar': ['sidebar.footer.action'],
  'dsh-client-ui-layout': ['shell.overlay', 'pointer-events:auto'],
  'dsh-client-shortcuts': ['catalog'],
  'dsh-client-ui-settings-general': ['settings.open', 'openSettings', 'settings.launcher', 'data-shortcut-modal'],
  'dsh-app-boot': ['engines.dsh', 'evaluatePluginCompatibility'],
}

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const parts = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return collect(path)
    return /\.(?:js|mjs|cjs|ts)$/.test(entry.name) ? readFile(path, 'utf8') : ''
  }))
  return parts.join('\n')
}

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
let failures = 0
for (const version of [...targets, ...rejected]) {
  const actual = semver.satisfies(version, pkg.engines.dsh, { includePrerelease: true })
  if (actual !== targets.includes(version)) { console.error(`FAIL engines.dsh ${version}`); failures++ }
}
const releases = pkg.dsh?.compatibility?.dshReleases || {}
if (Object.keys(releases).sort().join() !== [...targets].sort().join() || targets.some(v => releases[v] !== 'compatible')) {
  console.error('FAIL dsh.compatibility.dshReleases'); failures++
}
const root = await mkdtemp(join(tmpdir(), 'muche-cohort-'))
let networkFailure = false
try {
  for (const version of targets) {
    for (const [name, required] of Object.entries(checks)) {
      let response
      try { response = await fetch(`https://registry.npmjs.org/@deepseek-ai/${name}/-/${name}-${version}.tgz`, { signal: AbortSignal.timeout(30000) }) }
      catch (error) { console.error(`NETWORK ${version} ${name}: ${error.message}`); networkFailure = true; continue }
      if (!response.ok) { console.error(`FAIL ${version} ${name}: HTTP ${response.status}`); failures++; continue }
      const dir = join(root, version, name)
      await mkdir(dir, { recursive: true })
      const archive = join(dir, 'package.tgz')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(archive, Buffer.from(await response.arrayBuffer()))
      try {
        await exec('tar', ['-xzf', archive, '-C', dir])
        const content = await collect(join(dir, 'package'))
        for (const symbol of required) if (!content.includes(symbol)) { console.error(`FAIL ${version} ${name}: ${symbol}`); failures++ }
      } catch (error) { console.error(`FAIL ${version} ${name}: ${error.message}`); failures++ }
    }
    console.log(`Checked ${version}`)
  }
} finally { await rm(root, { recursive: true, force: true }) }
process.exitCode = failures ? 1 : networkFailure ? 2 : 0
