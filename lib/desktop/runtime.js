import { access, chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { download } from '@electron/get'
const exec = promisify(execFile)
const extract = (archive, { dir }) => exec('tar', ['-xf', archive, '-C', dir])

export function detectHostSupport({ versions = process.versions, platform = process.platform, env = process.env, hasParentIpc = typeof process.send === 'function' } = {}) {
  // Desktop starts its Electron Node host with an IPC channel; its CLI also embeds Electron
  // but has no such parent channel. Electron version alone would misclassify `dsh web`.
  if (env.MUCHE_DESKTOP_FORCE !== '1' && (!versions.electron || !hasParentIpc)) return { supported: false, code: 'DESKTOP_HOST_ONLY', text: '桌面悬浮窗需要 DSH Desktop' }
  if (env.MUCHE_DESKTOP_FORCE !== '1' && platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { supported: false, code: 'NO_DISPLAY', text: '当前环境没有图形桌面' }
  return { supported: true, code: '', text: '' }
}
const executable = (base, platform) => join(base, ...(platform === 'darwin' ? ['Electron.app', 'Contents', 'MacOS', 'Electron'] : [platform === 'win32' ? 'electron.exe' : 'electron']))
async function exists(path) { try { await access(path, constants.F_OK); return true } catch { return false } }

export function createElectronRuntime({ dshHome, config, env = process.env, platform = process.platform, onProgress = () => {}, downloadElectron = download, extractZip = extract }) {
  let flight
  async function ensure() {
    if (flight) return flight
    flight = (async () => {
      onProgress('正在检查桌面组件…')
      const version = env.MUCHE_DESKTOP_ELECTRON_VERSION || config.electronVersion
      const override = env.MUCHE_DESKTOP_ELECTRON_PATH
      if (override) {
        if (!await exists(override)) throw new Error('指定的 Electron 不存在')
        return { exePath: override, version, source: 'env' }
      }
      const cache = join(dshHome, 'muche-desktop', 'electron', version)
      const cachedExecutable = executable(cache, platform)
      if (await exists(cachedExecutable)) return { exePath: cachedExecutable, version, source: 'cache' }
      onProgress('正在下载桌面组件（约 100MB）…')
      const zip = await downloadElectron(version, { mirrorOptions: { mirror: env.MUCHE_DESKTOP_ELECTRON_MIRROR || config.mirror } })
      onProgress('正在解压桌面组件…')
      // Extraction uses a staging directory. Only a complete runtime is moved into the cache.
      const parent = join(dshHome, 'muche-desktop', 'electron')
      await mkdir(parent, { recursive: true })
      const staging = await mkdtemp(join(parent, '.staging-'))
      try {
        await extractZip(zip, { dir: staging })
        const exe = executable(staging, platform)
        if (!await exists(exe)) throw new Error('下载的桌面组件不完整')
        if (platform !== 'win32') await chmod(exe, 0o755)
        await rename(staging, cache)
        onProgress('桌面组件已就绪')
        return { exePath: cachedExecutable, version, source: 'download' }
      } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
    })().catch(error => { error.code = 'RUNTIME_DOWNLOAD_FAILED'; throw error }).finally(() => { flight = null })
    return flight
  }
  return { ensure }
}
