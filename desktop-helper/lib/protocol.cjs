// A bounded JSONL decoder; after an oversized line, ignore bytes until its newline.
function createDecoder({ maxLineBytes = 65536, onMessage, onError = () => {} }) {
  let chunks = []
  let size = 0
  let dropping = false
  function write(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    for (let i = 0; i <= input.length; i++) {
      if (i !== input.length && input[i] !== 10) continue
      const part = input.subarray(start, i)
      start = i + 1
      if (!dropping) {
        size += part.length
        if (size > maxLineBytes) { chunks = []; size = 0; dropping = true; onError('line too long') }
        else if (part.length) chunks.push(part)
      }
      if (i === input.length) break
      if (dropping) { dropping = false; continue }
      const line = Buffer.concat(chunks, size).toString('utf8').trim()
      chunks = []; size = 0
      if (!line) continue
      try { onMessage(JSON.parse(line)) } catch (error) { onError('invalid JSON or message handler error', error) }
    }
  }
  return { write }
}
function encode(message) { return `${JSON.stringify(message)}\n` }
module.exports = { createDecoder, encode }
