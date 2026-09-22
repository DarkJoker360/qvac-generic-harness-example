# QVAC Assistant

A multimodal AI assistant that runs **entirely on your machine** via
[`@qvac/sdk`](https://www.npmjs.com/package/@qvac/sdk). No API keys, no cloud,
no network at inference time — only the first model download touches the
internet.

Chat · Vision · RAG · Transcription · Text-to-speech · Image generation · Music generation

---

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:8787**.

That is the whole setup. Models download automatically the first time each
capability is used, and are cached in `~/.qvac` for every later run.

> **Before a live demo, pre-warm the models.** The first use of each capability
> blocks on a download — up to ~5 GB for image generation. Run `npm run smoke`
> once on the demo machine and everything afterwards is instant.

---

## Requirements

| | |
| --- | --- |
| Node.js | `>= 22.17` (tested on 24.19) |
| npm | `>= 10.9` |
| Disk | ~14 GB of models (quality tier) or ~7 GB (fast tier), plus 4.8 GB of native addons |
| RAM | 16 GB works; 32 GB+ comfortable with image and music loaded |
| GPU | Optional. Metal (Apple) and Vulkan are used when present, CPU otherwise |

Verified on macOS 15 / Apple M3 Max. `npm install` pulls ~4.8 GB of prebuilt
native engines (llama.cpp, whisper.cpp, stable-diffusion.cpp, ONNX TTS,
audiogen, Parakeet) and takes several minutes — that is expected, not a hang.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install the SDK and native engines |
| `npm start` | Run the server on http://localhost:8787 |
| `npm run dev` | Same, with auto-restart on file changes |
| `npm run smoke` | Exercise all 7 capabilities end to end; writes artifacts to `data/smoke/` |
| `npm run smoke:http` | Test the HTTP surface against a running server |

Run one capability at a time while debugging:

```bash
node smoke.js chat | vision | tts | asr | rag | image | music
```

---

## Model tiers

Pick with `QVAC_TIER` (default `quality`):

```bash
npm start                 # quality — better answers and images
QVAC_TIER=fast npm start  # fast — half the disk, quicker first run
```

| Capability | quality (default) | fast |
| --- | --- | --- |
| Chat | Qwen3.5 4B multimodal Q4_K_M — 2.7 GB | Llama 3.2 1B Q4_0 — 0.77 GB |
| Vision | *same model as chat* + mmproj 0.37 GB | SmolVLM2 500M Q8 — 0.55 GB |
| RAG | EmbeddingGemma 300M Q8 — 0.33 GB | EmbeddingGemma 300M Q4 — 0.28 GB |
| Transcription | Parakeet TDT 0.6B v3 Q8 — 0.75 GB | Whisper tiny Q8 — 0.04 GB |
| Speech | Supertonic 3 FP16 — 0.21 GB | Supertonic 3 Q4 — 0.09 GB |
| Image | FLUX.2 [klein] 4B + Qwen3 encoder + VAE — 5.1 GB | SD 2.1 Q4_0 — 2.2 GB |
| Music | ACE-Step 1.5 Turbo Q8 — 4.4 GB | ACE-Step Turbo Q4 — 3.3 GB |
| **Total** | **~14 GB** | **~7 GB** |

In the quality tier Qwen3.5 is multimodal, so chat and vision **share one
loaded model** rather than holding two sets of weights. The sidebar shows
Vision as `shared`.

Override any single model with an env var (the value must be a constant
exported by `@qvac/sdk`; an unknown name fails at startup with a clear error):

```bash
QVAC_CHAT_MODEL=QWEN3_5_9B_MULTIMODAL_Q4_K_M npm start
```

`QVAC_CHAT_MODEL` · `QVAC_VISION_MODEL` · `QVAC_VISION_MMPROJ` ·
`QVAC_EMBED_MODEL` · `QVAC_ASR_MODEL` · `QVAC_TTS_MODEL` · `QVAC_TTS_VOICE` ·
`QVAC_IMAGE_MODEL` · `QVAC_IMAGE_TEXTENC` · `QVAC_IMAGE_VAE` · `QVAC_MUSIC_*`

---

## Using the demo

The sidebar shows every model's state (`idle` / `loading` with a progress bar /
`ready`) and a live activity log, so an audience can see work actually
happening on the machine.

**Chat** — type and press Enter.
- 📎 attach an image to ask about it (switches the turn to the vision model)
- 🎙️ record from the microphone; audio is transcribed and dropped into the box
- *Read replies aloud* speaks every answer
- *Ground answers in my documents* turns on RAG

**Knowledge** — paste or upload `.txt` / `.md`, press **Ingest**. Then enable
grounding in Chat: retrieved passages appear above the answer with their
**source filename** and `[1]`-style citations. **Search** tests retrieval
directly and shows similarity scores.

**Image** — a prompt, a size and a step count. 20 steps at 512×512 is a good
default; fewer is faster and rougher.

**Music** — a caption, optional lyrics (leave blank for instrumental), and a
duration. Output is a playable, downloadable WAV.

**Free heavy models** releases image and music from memory (~9 GB) while
keeping chat, vision, RAG, transcription and speech resident.

---

## Verifying it works

```bash
npm run smoke
```

Runs every capability against the real engines and writes what it produced to
`data/smoke/` — a PNG, two WAVs, and transcripts — so you can look at the
output rather than trust a green tick. The `asr` test is a genuine round-trip:
it synthesises speech with the TTS model and transcribes it back, so both
engines must really run for it to pass.

```bash
npm start            # in one terminal
npm run smoke:http   # in another
```

Covers static assets, `/api/capabilities`, the SSE event stream, streaming
chat, TTS, RAG ingest/search, grounded chat with citations, and transcription.

## API

Everything the UI does is available over HTTP.

| Endpoint | |
| --- | --- |
| `GET /api/capabilities` | Model states, sizes, active tier, host info |
| `GET /api/events` | SSE: load progress and log lines |
| `POST /api/chat` | SSE: `{history, image?, useRag?}` → `sources`, `token`, `done` |
| `POST /api/transcribe` | `{audio: dataURL}` → `{text}` |
| `POST /api/tts` | `{text}` → `{audio: dataURL, sampleRate}` |
| `POST /api/image` | SSE: `{prompt, width, height, steps}` → `progress`, `image` |
| `POST /api/music` | SSE: `{caption, lyrics?, duration}` → `progress`, `audio` |
| `POST /api/rag/ingest` | `{documents: string[]}` |
| `POST /api/rag/search` | `{query}` → ranked hits with `file` and `score` |
| `POST /api/rag/clear` | Drop the knowledge base |
| `POST /api/unload` | Free heavy models (or one named `capability`) |

```bash
curl -N -X POST http://localhost:8787/api/chat \
  -H 'content-type: application/json' \
  -d '{"history":[{"role":"user","content":"Hello"}]}'
```

---

## Layout

```
server.js            Express + SSE endpoints
smoke.js             end-to-end capability tests
http-smoke.sh        HTTP surface tests against a running server
qvac.config.json     QVAC plugins, logging, download retry policy
src/models.js        capability -> model wiring (the file to edit)
src/engine.js        lazy model manager + one function per capability
src/wav.js           raw PCM -> .wav
public/              single-page UI (no build step, no framework)
```

---

## Troubleshooting

**`npm install` seems stuck.** It is downloading ~4.8 GB of native engines.
If it fails with `ECONNRESET`, npm rolls back the whole tree — rerun with
`npm install --fetch-retries=8 --fetch-timeout=900000`.

**First request hangs for minutes.** It is downloading a model. Watch the
sidebar progress bar or the server log.

**Out of memory.** Click **Free heavy models**, or use `QVAC_TIER=fast`.

**Reclaiming disk.** Models live in `~/.qvac`. Deleting it is safe; they
re-download on next use.

**RAG returns nothing.** Ingest documents first. Changing `QVAC_EMBED_MODEL` or
the tier starts a separate knowledge base, so re-ingest after switching —
switching back finds the earlier one intact.

---
