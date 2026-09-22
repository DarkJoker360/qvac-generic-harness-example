// Thin orchestration layer over @qvac/sdk.
//
// Responsibilities:
//  - lazily load a capability's model the first time it is used, and never twice
//  - broadcast download/load progress so the UI can show it
//  - expose one small function per capability that the HTTP layer can call
import { EventEmitter } from 'node:events'
import * as qvac from '@qvac/sdk'
import { CAPABILITIES } from './models.js'

export const bus = new EventEmitter()
bus.setMaxListeners(0)

/** @type {Map<string, {modelId: string}>} */
const loaded = new Map()
/** @type {Map<string, Promise<string>>} */
const loading = new Map()
/** @type {Map<string, object>} */
const status = new Map()

const emit = (event) => bus.emit('event', { ...event, at: Date.now() })

function setStatus (cap, patch) {
  const next = { ...(status.get(cap) || {}), ...patch }
  status.set(cap, next)
  emit({ type: 'status', capability: cap, status: next })
}

export function snapshot () {
  return Object.entries(CAPABILITIES).map(([key, cap]) => {
    // A shared capability has no state of its own: report its provider's.
    const owner = cap.sameAs || key
    const st = status.get(owner) || {}
    // What is actually in memory wins over the last status we recorded; a
    // stored 'error' survives only while nothing is loaded or loading.
    const state = loaded.has(owner)
      ? 'ready'
      : loading.has(owner)
        ? 'loading'
        : st.state === 'error' ? 'error' : 'idle'

    return {
      key,
      label: cap.label,
      blurb: cap.blurb,
      size: cap.size,
      resident: cap.resident,
      ...st,
      state
    }
  })
}

/**
 * Load a capability's model, or return the id if it is already resident.
 * Concurrent callers share one in-flight load rather than racing.
 */
export async function ensure (cap) {
  const def = CAPABILITIES[cap]
  if (!def) throw new Error(`unknown capability: ${cap}`)

  // A capability can be served by another one's weights (in the quality tier
  // vision is just the multimodal chat model). Load it once, use it twice.
  if (def.sameAs) return ensure(def.sameAs)

  const existing = loaded.get(cap)
  if (existing) return existing.modelId

  const inFlight = loading.get(cap)
  if (inFlight) return inFlight

  const task = (async () => {
    setStatus(cap, { state: 'loading', percentage: 0, error: null })
    emit({ type: 'log', message: `Loading ${def.label} (${def.size})…` })

    // A capability can pull several files (e.g. vision = weights + mmproj,
    // music = four GGUFs). Report one combined number instead of letting the
    // per-file streams fight over the progress bar.
    const files = new Map()

    const modelId = await qvac.loadModel({
      ...def.load(),
      onProgress: (p) => {
        // The SDK already aggregates when it knows the files belong together.
        const aggregate = p.fileSetInfo ?? p.shardInfo
        let percentage, downloaded, total

        if (aggregate) {
          percentage = aggregate.overallPercentage
          downloaded = aggregate.overallDownloaded
          total = aggregate.overallTotal
        } else {
          files.set(p.downloadKey ?? 'default', { downloaded: p.downloaded, total: p.total })
          downloaded = 0
          total = 0
          for (const f of files.values()) { downloaded += f.downloaded; total += f.total }
          percentage = total ? (downloaded / total) * 100 : 0
        }

        setStatus(cap, { state: 'loading', percentage, downloaded, total })
      }
    })

    loaded.set(cap, { modelId })
    setStatus(cap, { state: 'ready', percentage: 100 })
    emit({ type: 'log', message: `${def.label} ready.` })
    return modelId
  })()

  loading.set(cap, task)
  try {
    return await task
  } catch (err) {
    setStatus(cap, { state: 'error', error: err?.message || String(err) })
    emit({ type: 'log', level: 'error', message: `${def.label} failed: ${err?.message || err}` })
    throw err
  } finally {
    loading.delete(cap)
  }
}

export async function unload (cap) {
  const entry = loaded.get(cap)
  if (!entry) return false
  loaded.delete(cap)
  await qvac.unloadModel({ modelId: entry.modelId, clearStorage: false })
  setStatus(cap, { state: 'idle', percentage: 0 })
  emit({ type: 'log', message: `${CAPABILITIES[cap].label} unloaded.` })
  return true
}

/** Free every non-resident (heavy) model. */
export async function unloadHeavy () {
  const freed = []
  for (const [key, def] of Object.entries(CAPABILITIES)) {
    if (!def.resident && !def.sameAs && loaded.has(key)) {
      await unload(key)
      freed.push(key)
    }
  }
  return freed
}

export async function shutdown () {
  for (const key of [...loaded.keys()]) {
    try { await unload(key) } catch { /* best effort on the way out */ }
  }
}

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * Drop a leading `<think>` block so it never reaches the UI. Streaming-safe:
 * the opening tag arrives token by token, so buffer only until we know whether
 * one is there, then pass everything through untouched.
 */
async function * stripReasoning (tokens) {
  const OPEN = '<think>'
  const CLOSE = '</think>'
  let buffer = ''
  let inThink = false
  let passthrough = false
  let trimmingLead = false // swallow the blank lines that follow </think>

  for await (const token of tokens) {
    if (passthrough) {
      if (trimmingLead) {
        const t = token.replace(/^\s+/, '')
        if (!t) continue // whitespace-only token: still in the gap
        trimmingLead = false
        yield t
        continue
      }
      yield token
      continue
    }

    buffer += token

    if (!inThink) {
      const head = buffer.trimStart()
      if (head.startsWith(OPEN)) {
        inThink = true
      } else if (OPEN.startsWith(head)) {
        continue // still ambiguous — could become "<think>"
      } else {
        passthrough = true
        yield buffer
        buffer = ''
        continue
      }
    }

    const end = buffer.indexOf(CLOSE)
    if (end !== -1) {
      const rest = buffer.slice(end + CLOSE.length).replace(/^\s+/, '')
      passthrough = true
      buffer = ''
      if (rest) yield rest
      else trimmingLead = true // the gap after </think> spans later tokens
    }
  }

  // Stream ended mid-buffer. Emitting nothing would surface as a blank reply,
  // which is worse than showing slightly untidy text — the model does
  // occasionally run long and never close its think block. Salvage whatever
  // prose we can rather than dropping the turn.
  if (!passthrough && buffer) {
    const salvaged = buffer.replace(/<\/?think>/g, '').trim()
    if (salvaged) yield salvaged
  }
}

// Reasoning models leak in two ways: a `<think>` block (handled while
// streaming) and a plain-prose preamble like "Thinking Process:" that no tag
// marks. Prompting alone does not reliably stop either, so the finished answer
// is cleaned deterministically before anyone sees it.
// A reply can arrive with a leading narration heading, and with markdown
// emphasis the UI would render literally (it draws with textContent). Both are
// repaired conservatively; anything more aggressive risked discarding good
// answers.
const PREAMBLE_LINE = /^\s*\**\s*(?:thinking|thought|reasoning)\s*(?:process|steps?)?\s*\**\s*:[^\n]*\n+/i

/**
 * Remove `**`/`__` emphasis from a token stream without buffering the reply.
 * A lone trailing `*` is held back, because the next token may complete a pair.
 */
function createEmphasisStripper () {
  let carry = ''
  const strip = (t) => t.replace(/\*\*/g, '').replace(/__/g, '')
  return {
    push (chunk) {
      let text = carry + chunk
      carry = ''
      if (/[*_]$/.test(text)) { carry = text.slice(-1); text = text.slice(0, -1) }
      return strip(text)
    },
    flush () { const rest = carry; carry = ''; return strip(rest) }
  }
}

/**
 * Clean the answer as it streams. Only the first line can carry a narration
 * heading, so just that much is held back; everything after flows straight
 * through and reaches the browser token by token.
 */
async function * cleanStream (tokens) {
  const emphasis = createEmphasisStripper()
  let head = ''
  let headSettled = false

  for await (const token of tokens) {
    if (!headSettled) {
      head += token
      // Wait only until the first line break (or a short cap) before deciding.
      if (!head.includes('\n') && head.length < 160) continue
      headSettled = true
      const out = emphasis.push(head.replace(PREAMBLE_LINE, ''))
      if (out) yield out
      continue
    }
    const out = emphasis.push(token)
    if (out) yield out
  }

  if (!headSettled && head) {
    const out = emphasis.push(head.replace(PREAMBLE_LINE, ''))
    if (out) yield out
  }
  const tail = emphasis.flush()
  if (tail) yield tail
}

/** Non-streaming equivalent, kept for callers that already have a whole answer. */
export function cleanAnswer (text) {
  return String(text ?? '')
    .replace(PREAMBLE_LINE, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .trim()
}

const SYSTEM_PROMPT =
  'You are QVAC Assistant, an on-device AI assistant. Everything runs locally ' +
  'on this machine. Answer directly in plain prose.'

/**
 * Streaming chat. Yields text tokens.
 * Routes to the vision model when the turn carries an image attachment.
 */
export async function * chat ({ history, attachments = [], grounding = null, signal }) {
  const useVision = attachments.length > 0
  const modelId = await ensure(useVision ? 'vision' : 'chat')

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]

  if (grounding?.length) {
    const context = grounding
      .map((g, i) => `[${i + 1}]${g.file ? ` (${g.file})` : ''} ${g.content}`)
      .join('\n\n')
    messages.push({
      role: 'system',
      content:
        'Answer using only this context. Copy figures, names and dates exactly ' +
        'as the context writes them — do not reformat or expand them (write ' +
        '$19.8M, not 19.8 million). Give every figure the question asks for. ' +
        'Cite as [1]. If the context lacks the answer, say so.\n\n' + context
    })
  }

  for (const m of history) messages.push({ role: m.role, content: m.content })

  // Qwen-style reasoning switch, applied to the final user turn.
  if (CAPABILITIES[useVision ? 'vision' : 'chat'].noThink ||
      CAPABILITIES[CAPABILITIES[useVision ? 'vision' : 'chat'].sameAs ?? 'chat'].noThink) {
    const last = messages[messages.length - 1]
    if (last?.role === 'user' && !/\/no_think\s*$/.test(last.content)) {
      last.content = `${last.content} /no_think`
    }
  }

  // Attachments belong on the final user turn.
  if (useVision) {
    const last = messages[messages.length - 1]
    last.attachments = attachments.map((path) => ({ path }))
  }

  const run = qvac.completion({ modelId, history: messages, stream: true })

  const onAbort = () => { qvac.cancel({ requestId: run.requestId }).catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let emitted = 0
    for await (const piece of cleanStream(stripReasoning(run.tokenStream))) {
      emitted += piece.length
      yield piece
    }
    if (emitted === 0) {
      // A turn that renders blank is a bug from the user's side of the screen.
      yield '(The model returned no text for this turn. Try asking again.)'
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function transcribe ({ audioPath }) {
  const modelId = await ensure('transcription')
  return qvac.transcribe({ modelId, audioChunk: audioPath })
}

export async function speak ({ text }) {
  const modelId = await ensure('tts')
  const run = qvac.textToSpeech({ modelId, text, inputType: 'text', stream: false })
  const samples = await run.buffer
  // Supertonic's native rate is 44.1 kHz, but the engine is the source of truth.
  const sampleRate = (await run.sampleRate) ?? 44100
  return { samples, sampleRate }
}

export async function generateImage ({ prompt, width = 512, height = 512, steps, onStep }) {
  const modelId = await ensure('image')
  // FLUX.2 is a flow model (guidance ~3.5, cfg_scale pinned to 1); SD wants a
  // plain cfg_scale. Each tier supplies its own defaults.
  const defaults = CAPABILITIES.image.defaults || {}
  const run = qvac.diffusion({
    modelId,
    prompt,
    width,
    height,
    seed: -1,
    ...defaults,
    ...(steps ? { steps } : {})
  })

  if (onStep) {
    // Drain progress alongside the result; never let it reject the generation.
    ;(async () => {
      try {
        for await (const p of run.progressStream) onStep(p)
      } catch { /* progress is best-effort */ }
    })()
  }

  const buffers = await run.outputs
  return buffers[0]
}

export async function generateMusic ({ caption, lyrics, duration = 20, onStep }) {
  const modelId = await ensure('music')
  // No seed: ACE-Step randomises when it is omitted. Unlike diffusion, -1 is
  // not a documented "pick a random seed" sentinel here.
  const run = qvac.audioGen({
    modelId,
    caption,
    lyrics: lyrics?.trim() ? lyrics : '[Instrumental]',
    duration
  })

  if (onStep) {
    ;(async () => {
      try {
        for await (const p of run.progressStream) onStep(p)
      } catch { /* progress is best-effort */ }
    })()
  }

  return run.audio
}

// ── RAG ─────────────────────────────────────────────────────────────────────

// A RAG workspace is bound to the embedding model that built it — vectors from
// a 768-dim model are unusable by a 1024-dim one, and the store rejects the
// mismatch outright. Scoping the name by model means switching tiers (or
// QVAC_EMBED_MODEL) starts a clean workspace instead of erroring, and switching
// back finds the old one intact.
const embedModelName = () => {
  try {
    return CAPABILITIES.embeddings.load().modelSrc?.name || 'default'
  } catch {
    return 'default'
  }
}
export const RAG_WORKSPACE = `qvac-demo-${embedModelName().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

export async function ragIngest ({ documents }) {
  const modelId = await ensure('embeddings')
  const result = await qvac.ragIngest({
    modelId,
    workspace: RAG_WORKSPACE,
    documents,
    chunk: true
  })
  return result
}

/**
 * Split text into embeddable chunks, paragraph-first with a hard character cap.
 * Chunking happens here so the bound is guaranteed: an embedding model has a
 * fixed context, and an oversized chunk fails outright rather than degrading.
 */
// Embedding runs one job at a time, so every embed call in this process shares
// a serial lane. The lane survives a failed job.
let embedTail = Promise.resolve()
function embedSerial (params) {
  const job = embedTail.then(() => qvac.embed(params))
  embedTail = job.catch(() => {})
  return job
}

export function chunkText (text, maxChars = 700, overlapChars = 100) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const chunks = []
  let current = ''

  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = '' }

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // A single oversized block (a CSV body, a long table): hard-split it.
      flush()
      for (let i = 0; i < para.length; i += maxChars - overlapChars) {
        chunks.push(para.slice(i, i + maxChars))
      }
      continue
    }
    if (current && current.length + para.length + 2 > maxChars) flush()
    current = current ? `${current}\n\n${para}` : para
  }
  flush()
  return chunks.length ? chunks : [text.slice(0, maxChars)]
}

/**
 * Ingest named files so retrieved passages can be attributed to a source.
 *
 * Provenance rides in the document id as `<path>#<chunkIndex>` and is parsed
 * back out on search, which is what lets a passage name its source file.
 *
 * @param {{path: string, content: string}[]} files
 */
export async function ragIngestFiles ({ files, maxChars = 1200, onProgress }) {
  const modelId = await ensure('embeddings')
  let totalChunks = 0
  const skipped = []

  for (let f = 0; f < files.length; f++) {
    const file = files[f]
    if (!file.content?.trim()) continue

    let texts = chunkText(file.content, maxChars)

    let vectors
    try {
      const { embedding } = await embedSerial({ modelId, text: texts })
      vectors = Array.isArray(embedding[0]) ? embedding : [embedding]
    } catch (err) {
      // Safety net: character budgets are an approximation of the token limit,
      // so retry this file at half size before giving up on it.
      if (!/context overflow/i.test(err?.message || '')) throw err
      texts = chunkText(file.content, Math.floor(maxChars / 2))
      try {
        const { embedding } = await embedSerial({ modelId, text: texts })
        vectors = Array.isArray(embedding[0]) ? embedding : [embedding]
        emit({ type: 'log', message: `${file.path}: re-chunked smaller to fit the embedder.` })
      } catch (err2) {
        skipped.push({ file: file.path, error: err2?.message || String(err2) })
        emit({ type: 'log', level: 'error', message: `${file.path}: skipped — ${err2?.message}` })
        continue
      }
    }

    await qvac.ragSaveEmbeddings({
      modelId,
      workspace: RAG_WORKSPACE,
      documents: texts.map((content, i) => ({
        id: `${file.path}#${i}`,
        content,
        embedding: vectors[i],
        embeddingModelId: modelId,
        metadata: { file: file.path }
      }))
    })

    totalChunks += texts.length
    onProgress?.({ file: file.path, index: f + 1, total: files.length, chunks: texts.length })
  }

  return { files: files.length - skipped.length, chunks: totalChunks, skipped }
}

/**
 * True when the workspace exists on disk. Workspaces survive restarts, so this
 * is what decides whether retrieval is worth loading the embeddings model for —
 * checking `loaded` instead would silently skip RAG after every server restart.
 */
async function ragWorkspaceExists () {
  try {
    const workspaces = await qvac.ragListWorkspaces()
    return workspaces.some((w) => w.name === RAG_WORKSPACE)
  } catch {
    return false
  }
}

export async function ragSearch ({ query, topK = 4 }) {
  if (!loaded.has('embeddings') && !(await ragWorkspaceExists())) {
    // Nothing has ever been ingested: skip retrieval rather than paying for a
    // model load that can only return an empty result.
    return []
  }
  const modelId = await ensure('embeddings')
  try {
    const hits = await qvac.ragSearch({ modelId, workspace: RAG_WORKSPACE, query, topK })
    return hits.map((h) => ({
      ...h,
      // `<path>#<chunkIndex>` for file-ingested docs; plain text ingests have
      // no path, so `file` stays null and the UI just shows the passage.
      file: typeof h.id === 'string' && h.id.includes('#')
        ? h.id.slice(0, h.id.lastIndexOf('#'))
        : null
    }))
  } catch (err) {
    // Do not pretend an error is an empty knowledge base. The common cause is
    // `File descriptor could not be locked`: a RAG workspace is single-process,
    // so a second process (a stray eval run, a second server) locks it out.
    emit({ type: 'log', level: 'error', message: `RAG search failed: ${err?.message || err}` })
    console.error('✖ ragSearch:', err?.message || err)
    return []
  }
}

export async function ragClear () {
  try {
    await qvac.ragCloseWorkspace({ workspace: RAG_WORKSPACE, deleteOnClose: true })
    return true
  } catch {
    return false
  }
}
