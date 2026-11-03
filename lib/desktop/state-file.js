import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** Owns only the local desktop preference; callers serialize their state transitions. */
export function createStateFile({ filePath, logger = console, delayMs = 250 }) {
  let pending = null
  let timer = null
  let warned = false
  let disposed = false
  const fallback = () => ({ visible: false, x: null, y: null })
  const valid = value => value && value.version === 1 && typeof value.visible === 'boolean'
    && ((value.x === null && value.y === null) || (Number.isFinite(value.x) && Number.isFinite(value.y)))
  const warn = error => {
    if (!warned) { warned = true; logger.warn('muche desktop: state file unavailable', error?.message || error) }
  }
  function read() {
    try {
      const value = JSON.parse(readFileSync(filePath, 'utf8'))
      if (!valid(value)) throw new Error('invalid desktop state')
      return { visible: value.visible, x: value.x, y: value.y }
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(error)
      return fallback()
    }
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    if (!pending) return true
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(`${filePath}.tmp`, JSON.stringify(pending), { encoding: 'utf8', mode: 0o600 })
      renameSync(`${filePath}.tmp`, filePath)
      pending = null
      return true
    } catch (error) { warn(error); return false }
  }
  function write(next) {
    if (disposed) return false
    const value = { version: 1, visible: next?.visible, x: next?.x ?? null, y: next?.y ?? null }
    if (!valid(value)) return false
    pending = value
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, delayMs)
    timer.unref?.()
    return true
  }
  return { read, write, flush, dispose() { if (!disposed) { flush(); disposed = true } } }
}
