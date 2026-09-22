// QVAC Assistant — browser client.
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

// ── Shared: read a server-sent-event stream from a POST ─────────────────────

async function * sseStream (url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok && !res.body) throw new Error(`${res.status} ${res.statusText}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // Frames are separated by a blank line.
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try { yield JSON.parse(line.slice(6)) } catch { /* ignore keepalives */ }
      }
    }
  }
}

// ── Capability status + activity log ────────────────────────────────────────

const capsEl = $('caps')
const logEl = $('log')

function renderCaps (caps) {
  capsEl.replaceChildren()
  for (const c of caps) {
    const li = el('li', 'cap')
    const head = el('div', 'cap-head')
    head.append(
      el('span', `dot ${c.state}`),
      el('span', 'cap-name', c.label),
      el('span', 'cap-size', c.state === 'ready' ? 'ready' : c.size)
    )
    li.append(head)

    if (c.state === 'loading') {
      const bar = el('div', 'cap-bar')
      const fill = el('i')
      fill.style.width = `${c.percentage || 0}%`
      bar.append(fill)
      li.append(bar)
    }
    if (c.state === 'error') {
      const e = el('div', 'cap-size', c.error)
      e.style.color = 'var(--danger)'
      li.append(e)
    }
    capsEl.append(li)
  }
}

function log (message, level) {
  const line = el('div', level === 'error' ? 'err' : '', message)
  logEl.append(line)
  while (logEl.children.length > 60) logEl.firstChild.remove()
  logEl.scrollTop = logEl.scrollHeight
}

function connectEvents () {
  const es = new EventSource('/api/events')
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    if (ev.type === 'hello') renderCaps(ev.capabilities)
    else if (ev.type === 'status') refreshCaps()
    else if (ev.type === 'log') log(ev.message, ev.level)
  }
  es.onerror = () => { /* EventSource retries on its own */ }
}

let refreshTimer
function refreshCaps () {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(async () => {
    const r = await fetch('/api/capabilities').then((r) => r.json())
    renderCaps(r.capabilities)
    $('hostinfo').textContent =
      `${r.tier} tier · ${r.host.platform}/${r.host.arch} · ${r.host.memGB} GB RAM`

  }, 120)
}

// ── Mode switching ──────────────────────────────────────────────────────────

for (const btn of document.querySelectorAll('.mode')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b === btn))
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('active', v.dataset.view === btn.dataset.mode))
  })
}

$('freeMem').addEventListener('click', async () => {
  const r = await fetch('/api/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then((r) => r.json())
  log(r.freed.length ? `Freed: ${r.freed.join(', ')}` : 'Nothing heavy was loaded.')
  refreshCaps()
})

// ── Chat ────────────────────────────────────────────────────────────────────

const thread = $('thread')
const input = $('input')
const history = []
let attachedImage = null
let busy = false

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 190) + 'px'
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
$('send').addEventListener('click', send)

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => { input.value = chip.dataset.prompt; send() })
}

$('imageInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    attachedImage = reader.result
    $('attachmentPreview').src = attachedImage
    $('attachment').hidden = false
  }
  reader.readAsDataURL(file)
})

$('clearAttachment').addEventListener('click', () => {
  attachedImage = null
  $('attachment').hidden = true
  $('imageInput').value = ''
})

function addMessage (role, text, imageSrc) {
  thread.querySelector('.empty')?.remove()
  const msg = el('div', `msg ${role}`)
  msg.append(el('div', 'avatar', role === 'user' ? 'You' : 'Q'))
  const bubble = el('div', 'bubble')
  bubble.append(el('div', 'who', role === 'user' ? 'You' : 'QVAC Assistant'))
  const body = el('div', 'body', text)
  bubble.append(body)
  if (imageSrc) {
    const img = el('img')
    img.className = 'sent'
    img.src = imageSrc
    bubble.append(img)
  }
  msg.append(bubble)
  thread.append(msg)
  thread.scrollTop = thread.scrollHeight
  return { msg, bubble, body }
}

async function send () {
  const text = input.value.trim()
  if ((!text && !attachedImage) || busy) return

  busy = true
  $('send').disabled = true

  const image = attachedImage
  addMessage('user', text, image)
  history.push({ role: 'user', content: text || 'Describe this image.' })

  input.value = ''
  input.style.height = 'auto'
  attachedImage = null
  $('attachment').hidden = true
  $('imageInput').value = ''

  const { bubble, body } = addMessage('bot', '')
  const cursor = el('span', 'cursor')
  body.append(cursor)

  let answer = ''
  try {
    for await (const ev of sseStream('/api/chat', {
      history,
      image,
      useRag: $('useRag').checked
    })) {
      if (ev.type === 'sources' && ev.sources?.length) {
        const box = el('div', 'sources')
        box.append(el('b', null, 'Retrieved from your documents'))
        ev.sources.forEach((s, i) => {
          const snippet = s.content.length > 200 ? s.content.slice(0, 200) + '…' : s.content
          const line = el('div')
          line.append(el('span', null, `[${i + 1}] `))
          if (s.file) {
            const f = el('b', null, s.file)
            line.append(f, el('span', null, ' — '))
          }
          line.append(el('span', null, snippet))
          box.append(line)
        })
        bubble.append(box)
      } else if (ev.type === 'token') {
        answer += ev.token
        cursor.remove()
        body.textContent = answer
        body.append(cursor)
        thread.scrollTop = thread.scrollHeight
      } else if (ev.type === 'error') {
        cursor.remove()
        body.classList.add('err')
        body.textContent = `Error: ${ev.error}`
        answer = ''
      }
    }
  } catch (err) {
    cursor.remove()
    body.classList.add('err')
    body.textContent = `Error: ${err.message}`
  }

  cursor.remove()

  if (answer) {
    history.push({ role: 'assistant', content: answer })

    const speakBtn = el('button', 'speak', '🔊 Read aloud')
    speakBtn.addEventListener('click', () => speakText(answer, speakBtn))
    bubble.append(speakBtn)

    if ($('autoSpeak').checked) speakText(answer, speakBtn)
  }

  busy = false
  $('send').disabled = false
  input.focus()
}

async function speakText (text, btn) {
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = '⏳ Synthesising…'
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).then((r) => r.json())
    if (r.error) throw new Error(r.error)
    await new Audio(r.audio).play()
    btn.textContent = original
  } catch (err) {
    btn.textContent = `✖ ${err.message}`
  } finally {
    btn.disabled = false
  }
}

// ── Microphone → 16 kHz mono WAV → transcription ────────────────────────────
// Whisper wants 16 kHz mono. We decode whatever MediaRecorder produced with
// WebAudio and render the WAV in the browser, so the server needs no ffmpeg.

function encodeWav16k (float32, sampleRate) {
  const buf = new ArrayBuffer(44 + float32.length * 2)
  const view = new DataView(buf)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }

  str(0, 'RIFF')
  view.setUint32(4, 36 + float32.length * 2, true)
  str(8, 'WAVE'); str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, float32.length * 2, true)

  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

async function toWav16k (blob) {
  const raw = await blob.arrayBuffer()
  const decoded = await new AudioContext().decodeAudioData(raw)
  // Resample to 16 kHz mono offline.
  const frames = Math.ceil(decoded.duration * 16000)
  const offline = new OfflineAudioContext(1, frames, 16000)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return encodeWav16k(rendered.getChannelData(0), 16000)
}

const micBtn = $('micBtn')
let recorder = null
let chunks = []

micBtn.addEventListener('click', async () => {
  if (recorder?.state === 'recording') { recorder.stop(); return }

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    log('Microphone permission denied.', 'error')
    return
  }

  chunks = []
  recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }

  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop())
    micBtn.classList.remove('rec')
    micBtn.textContent = '⏳'
    try {
      const wav = await toWav16k(new Blob(chunks, { type: recorder.mimeType }))
      const dataUrl = await new Promise((resolve) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.readAsDataURL(wav)
      })
      const r = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: dataUrl })
      }).then((r) => r.json())
      if (r.error) throw new Error(r.error)
      if (r.text) {
        input.value = (input.value ? input.value + ' ' : '') + r.text
        input.dispatchEvent(new Event('input'))
        input.focus()
      } else {
        log('Transcription returned no speech.')
      }
    } catch (err) {
      log(`Transcription failed: ${err.message}`, 'error')
    }
    micBtn.textContent = '🎙️'
  }

  recorder.start()
  micBtn.classList.add('rec')
  micBtn.textContent = '⏹️'
})

// ── Image generation ────────────────────────────────────────────────────────

$('imgGo').addEventListener('click', async () => {
  const btn = $('imgGo')
  const prompt = $('imgPrompt').value.trim()
  if (!prompt) return

  const size = Number($('imgSize').value)
  const steps = Number($('imgSteps').value)
  const prog = $('imgProgress')
  const fill = prog.querySelector('i')
  const label = prog.querySelector('span')
  const out = $('imgResult')

  btn.disabled = true
  out.replaceChildren()
  prog.hidden = false
  fill.style.width = '0%'
  label.textContent = 'Loading model (first run downloads ~2.2 GB)…'

  try {
    for await (const ev of sseStream('/api/image', { prompt, width: size, height: size, steps })) {
      if (ev.type === 'progress') {
        fill.style.width = `${(ev.step / ev.total) * 100}%`
        label.textContent = `Denoising step ${ev.step} / ${ev.total}`
      } else if (ev.type === 'image') {
        const img = el('img')
        img.src = ev.image
        const dl = el('a', 'dl', '⬇ Download PNG')
        dl.href = ev.image
        dl.download = 'qvac-image.png'
        out.append(img, dl)
      } else if (ev.type === 'error') {
        out.append(el('div', 'err', ev.error))
      }
    }
  } catch (err) {
    out.append(el('div', 'err', err.message))
  }

  prog.hidden = true
  btn.disabled = false
})

// ── Music generation ────────────────────────────────────────────────────────

$('musicGo').addEventListener('click', async () => {
  const btn = $('musicGo')
  const caption = $('musicCaption').value.trim()
  if (!caption) return

  const prog = $('musicProgress')
  const fill = prog.querySelector('i')
  const label = prog.querySelector('span')
  const out = $('musicResult')

  btn.disabled = true
  out.replaceChildren()
  prog.hidden = false
  fill.style.width = '0%'
  label.textContent = 'Loading models (first run downloads ~3.3 GB)…'

  try {
    for await (const ev of sseStream('/api/music', {
      caption,
      lyrics: $('musicLyrics').value,
      duration: Number($('musicDuration').value)
    })) {
      if (ev.type === 'progress') {
        if (ev.total) fill.style.width = `${(ev.step / ev.total) * 100}%`
        label.textContent = `${ev.stage}: ${ev.step}${ev.total ? ` / ${ev.total}` : ''}`
      } else if (ev.type === 'audio') {
        const audio = el('audio')
        audio.controls = true
        audio.src = ev.audio
        const dl = el('a', 'dl', '⬇ Download WAV')
        dl.href = ev.audio
        dl.download = 'qvac-music.wav'
        out.append(audio, dl)
      } else if (ev.type === 'error') {
        out.append(el('div', 'err', ev.error))
      }
    }
  } catch (err) {
    out.append(el('div', 'err', err.message))
  }

  prog.hidden = true
  btn.disabled = false
})

// ── RAG ─────────────────────────────────────────────────────────────────────

$('ragFile').addEventListener('change', async (e) => {
  const texts = await Promise.all([...e.target.files].map((f) => f.text()))
  const box = $('ragText')
  box.value = (box.value ? box.value + '\n\n' : '') + texts.join('\n\n')
})

$('ragGo').addEventListener('click', async () => {
  const btn = $('ragGo')
  const out = $('ragResult')
  // A blank line separates documents.
  const documents = $('ragText').value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)

  if (!documents.length) {
    out.replaceChildren(el('div', 'err', 'Nothing to ingest.'))
    return
  }

  btn.disabled = true
  out.replaceChildren(el('div', null, 'Embedding on-device…'))
  try {
    const r = await fetch('/api/rag/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents })
    }).then((r) => r.json())
    if (r.error) throw new Error(r.error)
    out.replaceChildren(el('div', 'ok',
      `Ingested ${r.ingested} chunk${r.ingested === 1 ? '' : 's'}. Turn on “Ground answers in my documents” in Chat.`))
  } catch (err) {
    out.replaceChildren(el('div', 'err', err.message))
  }
  btn.disabled = false
})

$('ragClear').addEventListener('click', async () => {
  await fetch('/api/rag/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  $('ragResult').replaceChildren(el('div', 'ok', 'Knowledge base cleared.'))
})

$('ragSearchGo').addEventListener('click', async () => {
  const query = $('ragQuery').value.trim()
  const out = $('ragSearchResult')
  if (!query) return

  out.replaceChildren(el('div', null, 'Searching…'))
  try {
    const r = await fetch('/api/rag/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    }).then((r) => r.json())
    if (r.error) throw new Error(r.error)
    if (!r.results.length) {
      out.replaceChildren(el('div', null, 'No matches — ingest some documents first.'))
      return
    }
    out.replaceChildren()
    for (const hit of r.results) {
      const card = el('div', 'hit')
      card.append(el('div', 'score', `score ${Number(hit.score).toFixed(3)}`))
      card.append(el('div', null, hit.content))
      out.append(card)
    }
  } catch (err) {
    out.replaceChildren(el('div', 'err', err.message))
  }
})

// ── Boot ────────────────────────────────────────────────────────────────────

connectEvents()
refreshCaps()
