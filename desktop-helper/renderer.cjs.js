const stage = document.getElementById('stage')
const video = document.getElementById('pet-video')
const fallback = document.getElementById('pet-fallback')
const canvas = document.createElement('canvas')
const context = canvas.getContext('2d', { willReadFrequently: true })
let media = null, dragging = false, lastInside = false
video.addEventListener('loadeddata', () => window.muche.mediaReady(), { once: true })
fallback.addEventListener('load', () => window.muche.mediaReady(), { once: true })
video.addEventListener('error', () => window.muche.mediaError(), { once: true })
fallback.addEventListener('error', () => window.muche.mediaError(), { once: true })
window.muche.asset().then(asset => {
  stage.style.inset = `${asset.padding}px`
  if (asset.kind === 'video') {
    const { crop, videoWidth, videoHeight } = asset
    fallback.hidden = true
    video.style.width = `${videoWidth / crop.width * 100}%`
    video.style.height = `${videoHeight / crop.height * 100}%`
    video.style.left = `${-crop.x / crop.width * 100}%`
    video.style.top = `${-crop.y / crop.height * 100}%`
    video.src = asset.url
    media = video
    video.play().catch(error => console.warn('desktop animation failed', error?.name || 'Error'))
  } else {
    video.hidden = true; fallback.src = asset.url; media = fallback
  }
}).catch(error => console.warn('desktop asset failed', error?.name || 'Error'))

window.addEventListener('mousemove', event => {
  if (dragging) {
    if (event.buttons === 0) { dragging = false; window.muche.pointer('cancel') }
    return
  }
  if (!media || (media === video && video.readyState < 2) || (media === fallback && !fallback.complete)) return
  const width = media === video ? video.videoWidth : fallback.naturalWidth
  const height = media === video ? video.videoHeight : fallback.naturalHeight
  if (!width || !height) return
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  const rect = media.getBoundingClientRect(), clip = stage.getBoundingClientRect()
  const x = Math.floor((event.clientX - rect.left) * width / rect.width)
  const y = Math.floor((event.clientY - rect.top) * height / rect.height)
  let inside = false
  if (event.clientX >= clip.left && event.clientX < clip.right && event.clientY >= clip.top && event.clientY < clip.bottom && x >= 0 && x < width && y >= 0 && y < height) {
    context.clearRect(0, 0, width, height)
    context.drawImage(media, 0, 0, width, height)
    inside = context.getImageData(x, y, 1, 1).data[3] > 48
  }
  if (inside !== lastInside) { lastInside = inside; window.muche.interactive(inside) }
})
stage.addEventListener('pointerdown', event => { if (event.button !== 0) return; dragging = true; stage.setPointerCapture(event.pointerId); window.muche.pointer('down') })
stage.addEventListener('pointermove', () => { if (dragging) window.muche.pointer('move') })
stage.addEventListener('pointerup', () => { if (dragging) { dragging = false; window.muche.pointer('up') } })
stage.addEventListener('pointercancel', () => { if (dragging) { dragging = false; window.muche.pointer('cancel') } })
stage.addEventListener('lostpointercapture', () => { if (dragging) { dragging = false; window.muche.pointer('cancel') } })
// 立绘没有右键菜单：右键既不该拖拽，也不该弹出系统/默认菜单。
document.addEventListener('contextmenu', event => event.preventDefault())

// 语音状态直接画在立绘身上：按 Alt+Q 之后必须一眼看得出麦克风开着。
const voiceBadge = document.getElementById('voice-badge')
const voiceText = voiceBadge.querySelector('.text')
window.muche.onVoiceState(state => {
  const next = state === 'recording' || state === 'sending' ? state : 'idle'
  voiceBadge.dataset.state = next
  voiceText.textContent = next === 'recording' ? '正在听…' : next === 'sending' ? '发送中…' : ''
})
