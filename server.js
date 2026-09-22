// QVAC Assistant — local demo server.
// Everything below runs on-device via @qvac/sdk; nothing leaves this machine.
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import * as engine from './src/engine.js'
import { ACTIVE_TIER } from './src/models.js'
import { encodeWavFromSamples, encodeWavFromPcmBytes } from './src/wav.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS = path.join(__dirname, 'data', 'uploads')
fs.mkdirSync(UPLOADS, { recursive: true })

const app = express()
// Generous limit: images and recorded audio arrive as base64 in JSON.
app.use(express.json({ limit: '80mb' }))
app.use(express.static(path.join(__dirname, 'public')))

const PORT = Number(process.env.PORT || 8787)
// Bind loopback by default: this demo has no auth, and the RAG store holds
// whatever documents you ingested. Set HOST=0.0.0.0 to expose it deliberately.
const HOST = process.env.HOST || '127.0.0.1'

/** Persist a base64 payload to disk; the SDK takes file paths for media. */
function saveDataUrl (dataUrl, fallbackExt) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  const b64 = match ? match[2] : dataUrl
  const mime = match?.[1] || ''
  const ext =
    mime.includes('png') ? 'png'
      : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
        : mime.includes('webp') ? 'webp'
          : mime.includes('wav') ? 'wav'
            : fallbackExt
  const file = path.join(UPLOADS, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  return file
}

const fail = (res, err) => {
  console.error('✖', err)
  if (!res.headersSent) res.status(500).json({ error: err?.message || String(err) })
  else res.end()
}

// ── Status ──────────────────────────────────────────────────────────────────

app.get('/api/capabilities', (_req, res) => {
  res.json({
    capabilities: engine.snapshot(),
    tier: ACTIVE_TIER,
    host: { platform: os.platform(), arch: os.arch(), memGB: +(os.totalmem() / 1e9).toFixed(1) }
  })
})

/** Server-sent events: model load progress and log lines. */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write(`data: ${JSON.stringify({ type: 'hello', capabilities: engine.snapshot() })}\n\n`)

  const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`)
  engine.bus.on('event', onEvent)

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000)
  req.on('close', () => {
    clearInterval(keepAlive)
    engine.bus.off('event', onEvent)
  })
})

app.post('/api/preload', async (req, res) => {
  try {
    await engine.ensure(req.body.capability)
    res.json({ ok: true, capabilities: engine.snapshot() })
  } catch (err) { fail(res, err) }
})

app.post('/api/unload', async (req, res) => {
  try {
    const freed = req.body?.capability
      ? [await engine.unload(req.body.capability) ? req.body.capability : null].filter(Boolean)
      : await engine.unloadHeavy()
    res.json({ ok: true, freed, capabilities: engine.snapshot() })
  } catch (err) { fail(res, err) }
})

// ── Chat (streaming, optional vision + RAG) ─────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { history = [], image = null, useRag = false } = req.body || {}
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)

  const attachments = []

  try {
    if (image) attachments.push(saveDataUrl(image, 'png'))

    let grounding = null
    if (useRag && !attachments.length) {
      const query = [...history].reverse().find((m) => m.role === 'user')?.content || ''
      const hits = await engine.ragSearch({ query, topK: 8 })
      if (hits.length) {
        grounding = hits
        send({
          type: 'sources',
          sources: hits.map((h) => ({ content: h.content, score: h.score, file: h.file }))
        })
      }
    }

    send({ type: 'start', mode: attachments.length ? 'vision' : 'chat' })

    for await (const token of engine.chat({
      history, attachments, grounding, signal: controller.signal
    })) {
      send({ type: 'token', token })
    }

    send({ type: 'done' })
    res.end()
  } catch (err) {
    console.error('✖ chat', err)
    send({ type: 'error', error: err?.message || String(err) })
    res.end()
  } finally {
    // The SDK reads attachments during inference, so they can only go once the
    // completion is finished. Without this they pile up in data/uploads.
    for (const file of attachments) fs.rm(file, { force: true }, () => {})
  }
})

// ── Transcription ───────────────────────────────────────────────────────────

app.post('/api/transcribe', async (req, res) => {
  let audioPath
  try {
    // The browser sends 16 kHz mono WAV it rendered itself (see public/app.js).
    audioPath = saveDataUrl(req.body.audio, 'wav')
    const text = await engine.transcribe({ audioPath })
    res.json({ text: (text || '').trim() })
  } catch (err) {
    fail(res, err)
  } finally {
    if (audioPath) fs.rm(audioPath, { force: true }, () => {})
  }
})

// ── Text to speech ──────────────────────────────────────────────────────────

app.post('/api/tts', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'text is required' })
    const { samples, sampleRate } = await engine.speak({ text: text.slice(0, 2000) })
    const wav = encodeWavFromSamples(samples, { sampleRate, channels: 1, bitsPerSample: 16 })
    res.json({ audio: `data:audio/wav;base64,${wav.toString('base64')}`, sampleRate })
  } catch (err) { fail(res, err) }
})

// ── Image generation (SSE: step progress, then the PNG) ─────────────────────

app.post('/api/image', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)

  try {
    const { prompt, width = 512, height = 512, steps = 20 } = req.body || {}
    if (!prompt?.trim()) throw new Error('prompt is required')

    const png = await engine.generateImage({
      prompt: prompt.trim(),
      width, height, steps,
      onStep: (p) => send({ type: 'progress', step: p.step, total: p.totalSteps })
    })

    send({ type: 'image', image: `data:image/png;base64,${Buffer.from(png).toString('base64')}` })
    send({ type: 'done' })
  } catch (err) {
    console.error('✖ image', err)
    send({ type: 'error', error: err?.message || String(err) })
  }
  res.end()
})

// ── Music generation (SSE: stage progress, then the WAV) ────────────────────

app.post('/api/music', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)

  try {
    const { caption, lyrics = '', duration = 20 } = req.body || {}
    if (!caption?.trim()) throw new Error('caption is required')

    const { pcm, sampleRate, channels, bitsPerSample } = await engine.generateMusic({
      caption: caption.trim(),
      lyrics,
      duration,
      onStep: (p) => send({ type: 'progress', stage: p.stage, step: p.step, total: p.total })
    })

    const wav = encodeWavFromPcmBytes(pcm, { sampleRate, channels, bitsPerSample })
    send({ type: 'audio', audio: `data:audio/wav;base64,${wav.toString('base64')}`, sampleRate })
    send({ type: 'done' })
  } catch (err) {
    console.error('✖ music', err)
    send({ type: 'error', error: err?.message || String(err) })
  }
  res.end()
})

// ── RAG ─────────────────────────────────────────────────────────────────────

app.post('/api/rag/ingest', async (req, res) => {
  try {
    const documents = (req.body?.documents || []).map((d) => String(d)).filter((d) => d.trim())
    if (!documents.length) return res.status(400).json({ error: 'no documents' })
    const result = await engine.ragIngest({ documents })
    res.json({ ok: true, ingested: result.processed?.length ?? documents.length })
  } catch (err) { fail(res, err) }
})

app.post('/api/rag/search', async (req, res) => {
  try {
    res.json({ results: await engine.ragSearch({ query: req.body?.query || '', topK: 5 }) })
  } catch (err) { fail(res, err) }
})

app.post('/api/rag/clear', async (req, res) => {
  try {
    res.json({ ok: await engine.ragClear() })
  } catch (err) { fail(res, err) }
})

// ── Boot ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  QVAC Assistant  →  http://localhost:${PORT}`)
  if (HOST !== '127.0.0.1') console.log(`  ⚠ bound to ${HOST} — no auth; anyone who can reach this port can use it`)
  console.log(`  model tier: ${ACTIVE_TIER}  (set QVAC_TIER=fast for the small models)\n`)
  console.log('  Models download on first use. The chat model is the smallest hop;')
  console.log('  image (~2.2 GB) and music (~3.3 GB) take the longest.\n')
})

let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(0) // second Ctrl-C: go now
    closing = true
    console.log('\n▸ Unloading models…')
    server.close()

    // Unloading is best-effort. A wedged native addon must not hold the
    // terminal hostage, so give it a bounded window and then exit anyway.
    const timeout = new Promise((resolve) => setTimeout(resolve, 5000).unref())
    await Promise.race([engine.shutdown(), timeout])
    process.exit(0)
  })
}
