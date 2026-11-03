import test from 'node:test'
import assert from 'node:assert/strict'
import { VOICE_SAMPLE_RATE, downmix, encodeRecording, encodeWavPcm16, resample, toBase64 } from '../client/src/voice.js'

const readAscii = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length))
const readUint32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)

test('wav header describes 16 kHz mono PCM16', () => {
  const bytes = encodeWavPcm16(new Float32Array([0, 0.5, -0.5]), VOICE_SAMPLE_RATE)
  assert.equal(bytes.length, 44 + 3 * 2)
  assert.equal(readAscii(bytes, 0, 4), 'RIFF')
  assert.equal(readAscii(bytes, 8, 4), 'WAVE')
  assert.equal(readAscii(bytes, 12, 4), 'fmt ')
  assert.equal(readAscii(bytes, 36, 4), 'data')
  assert.equal(readUint32(bytes, 4), bytes.length - 8, 'RIFF size covers the payload')
  assert.equal(readUint32(bytes, 24), 16000)
  assert.equal(readUint32(bytes, 28), 32000, 'byte rate is sampleRate * blockAlign')
  assert.equal(readUint32(bytes, 40), 6)
  const samples = new DataView(bytes.buffer).getInt16(44, true)
  assert.equal(samples, 0)
  assert.equal(new DataView(bytes.buffer).getInt16(46, true), Math.trunc(0.5 * 0x7fff))
})

test('wav encoding clamps out-of-range samples instead of wrapping', () => {
  const bytes = encodeWavPcm16(new Float32Array([2, -2]), VOICE_SAMPLE_RATE)
  const view = new DataView(bytes.buffer)
  assert.equal(view.getInt16(44, true), 0x7fff)
  assert.equal(view.getInt16(46, true), -0x8000)
})

test('resampling converts a device rate to the backend rate', () => {
  const input = new Float32Array(4800).fill(0.25)   // 48 kHz, 100 ms
  const output = resample(input, 48000)
  assert.equal(output.length, 1600, '100 ms stays 100 ms at 16 kHz')
  assert.ok(output.every(value => Math.abs(value - 0.25) < 1e-6))
  assert.equal(resample(input, 16000), input, 'an already-correct rate is returned unchanged')
})

test('downmix averages every channel', () => {
  assert.deepEqual([...downmix([new Float32Array([1, 0]), new Float32Array([0, 1])])], [0.5, 0.5])
  const mono = new Float32Array([0.3])
  assert.equal(downmix([mono]), mono)
  assert.equal(downmix([]).length, 0)
})

test('a recording encodes to a decodable base64 wav of the expected duration', () => {
  const chunks = [new Float32Array(800).fill(0.1), new Float32Array(800).fill(0.1)]  // 1600 samples @16k = 100 ms
  const base64 = encodeRecording({ chunks, sampleRate: 16000 })
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
  assert.equal(readAscii(bytes, 0, 4), 'RIFF')
  assert.equal(readUint32(bytes, 40), 3200, '1600 samples × 2 bytes')
  assert.equal(toBase64(bytes), base64, 'base64 round-trips')
})

test('invalid sample rates are rejected rather than producing a broken wav', () => {
  assert.throws(() => encodeWavPcm16(new Float32Array(1), 0), TypeError)
  assert.throws(() => resample(new Float32Array(1), 0), TypeError)
})
