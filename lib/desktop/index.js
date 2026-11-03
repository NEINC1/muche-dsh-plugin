import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStateFile } from './state-file.js'
import { createElectronRuntime, detectHostSupport } from './runtime.js'
import { createHelperProcess } from './helper-process.js'
import { createDesktopManager } from './manager.js'

export function createDesktopFeature({ ctx, runtime, logger = console, env = process.env }) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const config = JSON.parse(readFileSync(new URL('./runtime.json', import.meta.url), 'utf8'))
  const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'))
  const helperAppDir = fileURLToPath(new URL('../../desktop-helper/', import.meta.url))
  const stateFile = createStateFile({ filePath: join(home, 'muche-desktop', 'state.json'), logger })
  let manager
  const electronRuntime = createElectronRuntime({ dshHome: home, config, env, onProgress: text => manager?.setProgress(text) })
  manager = createDesktopManager({ runtimeState: runtime, getChatUrl: () => ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()), stateFile, electronRuntime,
    hostSupport: detectHostSupport({ env }), protocol, runtimeConfig: config,
    assetPath: join(helperAppDir, 'assets', 'dsh-pet-idle.webm'), logger,
    helperFactory: options => createHelperProcess({ ...options, helperAppDir, dshHome: home, env, logger, protocol, timeouts: config.timeouts }) })
  return manager
}
