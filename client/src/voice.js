// 语音上行的纯计算：单声道混音、重采样到 16 kHz、PCM16 WAV 编码、base64。
//
// 后端 `POST /chat` 的 `audio` 只接受 WAV base64（MiMo ASR 按 wav 解析，静音由后端 peak 判定），
// 所以浏览器采到的任意采样率 Float32 必须先在这里收敛成「16 kHz 单声道 PCM16」这一种形状。
// 本文件不碰 DOM、不碰音频设备，可直接用 node:test 覆盖。

export const VOICE_SAMPLE_RATE = 16000
const HEADER_BYTES = 44

/** 多声道交错数据按声道取平均成单声道。 */
export function downmix(channels) {
  const list = (channels || []).filter(channel => channel && channel.length)
  if (!list.length) return new Float32Array(0)
  if (list.length === 1) return list[0]
  const length = Math.min(...list.map(channel => channel.length))
  const mixed = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    let sum = 0
    for (const channel of list) sum += channel[i]
    mixed[i] = sum / list.length
  }
  return mixed
}

/** 线性插值重采样；输入已是目标采样率时原样返回。 */
export function resample(samples, inputRate, targetRate = VOICE_SAMPLE_RATE) {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new TypeError('invalid input sample rate')
  if (!Number.isFinite(targetRate) || targetRate <= 0) throw new TypeError('invalid target sample rate')
  if (inputRate === targetRate || samples.length === 0) return samples
  const ratio = inputRate / targetRate
  const length = Math.max(1, Math.round(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const current = samples[index] ?? 0
    const next = samples[index + 1] ?? current
    out[i] = current + (next - current) * fraction
  }
  return out
}

/** Float32 [-1,1] → 16 kHz 单声道 PCM16 WAV（44 字节头 + 小端样本）。 */
export function encodeWavPcm16(samples, sampleRate = VOICE_SAMPLE_RATE) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('invalid sample rate')
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)) }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)          // fmt 块长度
  view.setUint16(20, 1, true)           // PCM
  view.setUint16(22, 1, true)           // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // 字节率
  view.setUint16(32, 2, true)           // 块对齐
  view.setUint16(34, 16, true)          // 位深
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(HEADER_BYTES + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

/** 字节 → base64（分块，避免超长参数把调用栈打爆）。 */
export function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** 采集缓冲（Float32 分片 + 采样率）→ 后端要的 WAV base64。 */
export function encodeRecording({ chunks, sampleRate }) {
  const merged = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
  return toBase64(encodeWavPcm16(resample(merged, sampleRate)))
}
