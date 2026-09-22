// End-to-end smoke test for every capability, straight against src/engine.js.
// Usage: node smoke.js [chat|vision|tts|asr|rag|image|music|all]
// Run with QVAC_CONFIG_PATH=./qvac.config.json so plugin/logging config applies.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as engine from './src/engine.js'
import { encodeWavFromSamples, encodeWavFromPcmBytes } from './src/wav.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'data', 'smoke')
fs.mkdirSync(OUT, { recursive: true })

const only = (process.argv[2] || 'all').toLowerCase()
const want = (name) => only === 'all' || only === name
const results = []

// Throttle progress so a multi-GB download does not flood the terminal.
const lastPct = new Map()
engine.bus.on('event', (e) => {
  if (e.type !== 'status' || e.status.state !== 'loading' || !e.status.percentage) return
  const pct = Math.floor(e.status.percentage / 5) * 5
  if (lastPct.get(e.capability) === pct) return
  lastPct.set(e.capability, pct)
  process.stderr.write(`\r    downloading ${e.capability} ${pct}%   `)
  if (pct >= 100) process.stderr.write('\n')
})

async function step (name, fn) {
  if (!want(name)) return
  const t0 = Date.now()
  process.stdout.write(`\n▸ ${name}\n`)
  try {
    const detail = await fn()
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`  ✓ ${name} (${secs}s) ${detail || ''}`)
    results.push([name, true, detail])
  } catch (err) {
    console.error(`  ✖ ${name}: ${err?.message || err}`)
    if (process.env.VERBOSE) console.error(err)
    results.push([name, false, err?.message || String(err)])
  }
}

/** A tiny valid PNG (8x8 checkerboard) so vision has something to look at. */
function makeTestImage () {
  const file = path.join(OUT, 'test-image.png')
  if (!fs.existsSync(file)) {
    // 1x1 is too degenerate for some preprocessors; build an 64x64 PNG via zlib.
    const { deflateSync } = require('node:zlib')
    const W = 64
    const raw = Buffer.alloc((W * 3 + 1) * W)
    let o = 0
    for (let y = 0; y < W; y++) {
      raw[o++] = 0
      for (let x = 0; x < W; x++) {
        const on = ((x >> 3) + (y >> 3)) % 2 === 0
        raw[o++] = on ? 220 : 30
        raw[o++] = on ? 60 : 40
        raw[o++] = on ? 60 : 200
      }
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
      const td = Buffer.concat([Buffer.from(type), data])
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(td) >>> 0)
      return Buffer.concat([len, td, crcBuf])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4)
    ihdr[8] = 8; ihdr[9] = 2
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0))
    ])
    fs.writeFileSync(file, png)
  }
  return file
}

let CRC_TABLE
function crc32 (buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

// ── Tests ───────────────────────────────────────────────────────────────────

await step('chat', async () => {
  let out = ''
  for await (const t of engine.chat({
    history: [{ role: 'user', content: 'Reply with exactly one short sentence about the ocean.' }]
  })) out += t
  if (!out.trim()) throw new Error('empty completion')
  console.log(`    → ${out.trim().slice(0, 120)}`)
  return `${out.length} chars`
})

await step('tts', async () => {
  const { samples, sampleRate } = await engine.speak({ text: 'Hello from QVAC, running fully on device.' })
  if (!samples?.length) throw new Error('no audio samples')
  const wav = encodeWavFromSamples(samples, { sampleRate, channels: 1, bitsPerSample: 16 })
  const file = path.join(OUT, 'tts.wav')
  fs.writeFileSync(file, wav)
  return `${samples.length} samples @ ${sampleRate}Hz → ${path.relative(__dirname, file)}`
})

await step('asr', async () => {
  // Transcribe the audio TTS just produced: a real round-trip, no fixtures needed.
  const file = path.join(OUT, 'tts.wav')
  if (!fs.existsSync(file)) {
    const { samples, sampleRate } = await engine.speak({ text: 'Hello from QVAC, running fully on device.' })
    fs.writeFileSync(file, encodeWavFromSamples(samples, { sampleRate, channels: 1, bitsPerSample: 16 }))
  }
  const text = await engine.transcribe({ audioPath: file })
  if (typeof text !== 'string') throw new Error('transcribe did not return a string')
  console.log(`    → ${JSON.stringify(text.trim().slice(0, 160))}`)
  if (!text.trim()) throw new Error('empty transcript')
  return `${text.trim().length} chars`
})

await step('rag', async () => {
  await engine.ragIngest({
    documents: [
      'The QVAC demo server listens on port 8787 by default and serves a single-page chat UI.',
      'Marzipan is a confection made primarily of sugar and almond meal, often shaped into fruit.',
      'The Tsiolkovsky rocket equation relates a rocket delta-v to its exhaust velocity and mass ratio.'
    ]
  })
  const hits = await engine.ragSearch({ query: 'What port does the demo server use?', topK: 2 })
  if (!hits.length) throw new Error('search returned no hits')
  console.log(`    → top hit (${Number(hits[0].score).toFixed(3)}): ${hits[0].content.slice(0, 90)}`)
  if (!/8787/.test(hits[0].content)) throw new Error(`unexpected top hit: ${hits[0].content.slice(0, 80)}`)

  // And the grounded-chat path that the UI actually uses.
  let out = ''
  for await (const t of engine.chat({
    history: [{ role: 'user', content: 'What port does the demo server use?' }],
    grounding: hits
  })) out += t
  console.log(`    → grounded answer: ${out.trim().slice(0, 120)}`)
  if (!out.trim()) throw new Error('grounded completion was empty')
  return `${hits.length} hits, grounded answer ok`
})

await step('vision', async () => {
  const img = makeTestImage()
  let out = ''
  for await (const t of engine.chat({
    history: [{ role: 'user', content: 'What colors and pattern do you see in this image?' }],
    attachments: [img]
  })) out += t
  if (!out.trim()) throw new Error('empty vision completion')
  console.log(`    → ${out.trim().slice(0, 160)}`)
  return `${out.length} chars`
})

await step('image', async () => {
  const png = await engine.generateImage({
    prompt: 'a single red apple on a white table, studio photo',
    width: 384, height: 384, steps: 8,
    onStep: (p) => process.stderr.write(`\r    step ${p.step}/${p.totalSteps}   `)
  })
  process.stderr.write('\n')
  const buf = Buffer.from(png)
  if (buf.length < 1000) throw new Error(`png too small: ${buf.length} bytes`)
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG')
  const file = path.join(OUT, 'image.png')
  fs.writeFileSync(file, buf)
  return `${(buf.length / 1024).toFixed(0)} KB → ${path.relative(__dirname, file)}`
})

await step('music', async () => {
  const { pcm, sampleRate, channels, bitsPerSample } = await engine.generateMusic({
    caption: 'gentle acoustic guitar loop, warm and simple',
    lyrics: '[Instrumental]',
    duration: 10,
    onStep: (p) => process.stderr.write(`\r    ${p.stage} ${p.step}/${p.total}   `)
  })
  process.stderr.write('\n')
  if (!pcm?.length) throw new Error('no PCM returned')
  const wav = encodeWavFromPcmBytes(pcm, { sampleRate, channels, bitsPerSample })
  const file = path.join(OUT, 'music.wav')
  fs.writeFileSync(file, wav)
  const secs = pcm.byteLength / (bitsPerSample / 8) / channels / sampleRate
  return `${secs.toFixed(1)}s @ ${sampleRate}Hz ×${channels} → ${path.relative(__dirname, file)}`
})

// ── Report ──────────────────────────────────────────────────────────────────

console.log('\n─────────── smoke summary ───────────')
for (const [name, ok, detail] of results) {
  console.log(`  ${ok ? '✓' : '✖'} ${name.padEnd(7)} ${detail || ''}`)
}
const failed = results.filter(([, ok]) => !ok)
console.log(`${results.length - failed.length}/${results.length} passed\n`)

await engine.shutdown()
process.exit(failed.length ? 1 : 0)
