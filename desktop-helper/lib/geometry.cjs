// Geometry is owned by the helper, which alone sees Electron display work areas.
function windowSizeFor({ imageWidth, imageHeight, bodyHeight, padding }) {
  if (![imageWidth, imageHeight, bodyHeight, padding].every(Number.isFinite) || imageWidth <= 0 || imageHeight <= 0 || bodyHeight <= 0 || padding < 0) throw new TypeError('invalid image geometry')
  return { width: Math.max(64, Math.round(imageWidth * bodyHeight / imageHeight) + padding * 2), height: Math.max(64, bodyHeight + padding * 2) }
}
function clampToWorkArea({ x, y, width, height, areas }) {
  if (!Array.isArray(areas) || !areas.length) throw new TypeError('display work area required')
  const valid = areas.filter(a => a && [a.x, a.y, a.width, a.height].every(Number.isFinite) && a.width > 0 && a.height > 0)
  if (!valid.length) throw new TypeError('valid display work area required')
  const first = valid[0]
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: Math.round(first.x + Math.max(0, first.width - width - 16)), y: Math.round(first.y + Math.max(0, first.height - height - 16)) }
  const center = { x: x + width / 2, y: y + height / 2 }
  const dist = a => {
    const dx = Math.max(a.x - center.x, 0, center.x - (a.x + a.width))
    const dy = Math.max(a.y - center.y, 0, center.y - (a.y + a.height))
    return dx * dx + dy * dy
  }
  const area = valid.reduce((best, a) => dist(a) < dist(best) ? a : best)
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + Math.max(0, area.width - width)))), y: Math.round(Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - height)))) }
}
module.exports = { windowSizeFor, clampToWorkArea }
