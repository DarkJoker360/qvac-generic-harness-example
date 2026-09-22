// Capability -> model wiring for the QVAC demo.
//
// Two profiles, selected with QVAC_TIER (default "quality"):
//
//   quality — Qwen3.5-4B (multimodal), EmbeddingGemma 300M, Parakeet TDT,
//             Supertonic 3, FLUX.2 [klein], ACE-Step Turbo. ~14 GB of weights.
//   fast    — the smallest usable variant of each. ~7 GB. Use on thin
//             hardware or when you want the demo up quickly.
//
// Any single model can still be overridden by env var; the value must be the
// name of a constant exported by @qvac/sdk.
import * as qvac from '@qvac/sdk'

const TIER = (process.env.QVAC_TIER || 'quality').toLowerCase()
if (!['quality', 'fast'].includes(TIER)) {
  throw new Error(`QVAC_TIER must be "quality" or "fast", got "${TIER}"`)
}
export const ACTIVE_TIER = TIER

/** Resolve an @qvac/sdk model constant, honouring an env override. */
const pick = (envVar, constName) => {
  const name = process.env[envVar] || constName
  if (!(name in qvac)) {
    throw new Error(
      `${envVar || 'model'}="${name}" is not an @qvac/sdk model constant`
    )
  }
  return qvac[name]
}

const tier = (quality, fast) => (TIER === 'quality' ? quality : fast)

// ── Chat / vision ───────────────────────────────────────────────────────────
// In the quality tier one multimodal model serves both, so `vision` reuses the
// chat model via `sameAs` instead of loading a second copy of the weights.

const CHAT = tier(
  {
    label: 'Chat + Vision',
    blurb: 'Qwen3.5 4B — text and images in one model',
    size: '~3.1 GB',
    resident: true,
    // Ask the model to answer directly rather than think out loud.
    noThink: true,
    load: () => ({
      modelSrc: pick('QVAC_CHAT_MODEL', 'QWEN3_5_4B_MULTIMODAL_Q4_K_M'),
      modelConfig: {
        ctx_size: 8192,
        projectionModelSrc: pick('QVAC_VISION_MMPROJ', 'MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0'),
        // Qwen3.5 is a reasoning model; keep it answering rather than musing.
        reasoning_budget: 0,
        // Greedy decoding, so the same question gives the same answer twice —
        // an audience notices otherwise.
        temp: Number(process.env.QVAC_TEMP || 0),
        // Bound the reply length; nothing in this demo needs more.
        predict: Number(process.env.QVAC_MAX_TOKENS || 768)
      }
    })
  },
  {
    label: 'Chat',
    blurb: 'Llama 3.2 1B — streaming text generation',
    size: '~0.8 GB',
    resident: true,
    load: () => ({
      modelSrc: pick('QVAC_CHAT_MODEL', 'LLAMA_3_2_1B_INST_Q4_0'),
      modelConfig: { ctx_size: 4096 }
    })
  }
)

const VISION = tier(
  // Same weights as chat — share the loaded instance.
  { label: 'Vision', blurb: 'Served by the chat model', size: 'shared', resident: true, sameAs: 'chat' },
  {
    label: 'Vision',
    blurb: 'SmolVLM2 500M — ask about an image',
    size: '~0.55 GB',
    resident: true,
    load: () => ({
      modelSrc: pick('QVAC_VISION_MODEL', 'SMOLVLM2_500M_MULTIMODAL_Q8_0'),
      modelConfig: {
        ctx_size: 4096,
        projectionModelSrc: pick('QVAC_VISION_MMPROJ', 'MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0')
      }
    })
  }
)

export const CAPABILITIES = {
  chat: CHAT,
  vision: VISION,

  embeddings: {
    label: 'RAG',
    blurb: tier('EmbeddingGemma 300M Q8', 'EmbeddingGemma 300M Q4'),
    size: tier('~0.33 GB', '~0.28 GB'),
    resident: true,
    // A larger embedding context lets us use bigger chunks, which keeps
    // related facts together in a single retrieved passage.
    load: () => ({
      modelSrc: pick('QVAC_EMBED_MODEL', tier('EMBEDDINGGEMMA_300M_Q8_0', 'EMBEDDINGGEMMA_300M_Q4_0')),
      modelType: 'llamacpp-embedding',
      modelConfig: { device: 'gpu', batchSize: 1024 }
    })
  },

  transcription: tier(
    {
      label: 'Transcription',
      blurb: 'Parakeet TDT 0.6B — multilingual, VAD built in',
      size: '~0.75 GB',
      resident: true,
      load: () => ({
        modelSrc: pick('QVAC_ASR_MODEL', 'PARAKEET_TDT_0_6B_V3_Q8_0'),
        modelType: 'parakeet-transcription',
        // Parakeet's config schema is its own — none of Whisper's keys apply.
        modelConfig: { useGPU: true, maxThreads: 6, timestampsEnabled: false }
      })
    },
    {
      label: 'Transcription',
      blurb: 'Whisper tiny — microphone to text',
      size: '~0.04 GB',
      resident: true,
      load: () => ({
        modelSrc: pick('QVAC_ASR_MODEL', 'WHISPER_TINY_Q8_0'),
        modelConfig: {
          audio_format: 'f32le',
          strategy: 'greedy',
          n_threads: 4,
          language: 'en',
          translate: false,
          no_timestamps: true,
          temperature: 0.0,
          suppress_blank: true,
          contextParams: { use_gpu: true, flash_attn: true, gpu_device: 0 }
        }
      })
    }
  ),

  tts: {
    label: 'Speech',
    blurb: tier('Supertonic 3 FP16 — multilingual', 'Supertonic 3 Q4'),
    size: tier('~0.21 GB', '~0.09 GB'),
    resident: true,
    load: () => ({
      modelSrc: pick('QVAC_TTS_MODEL', tier('TTS_MULTILINGUAL_SUPERTONIC3_FP16', 'TTS_MULTILINGUAL_SUPERTONIC3_Q4_0')),
      modelType: 'tts-ggml',
      modelConfig: {
        ttsEngine: 'supertonic',
        language: 'en',
        voice: process.env.QVAC_TTS_VOICE || 'F1',
        useGPU: true
      }
    })
  },

  image: tier(
    {
      label: 'Image',
      blurb: 'FLUX.2 [klein] 4B — split layout with Qwen3 text encoder',
      size: '~5.1 GB',
      resident: false,
      // FLUX.2 needs three files: diffusion weights + LLM text encoder + VAE.
      load: () => ({
        modelSrc: pick('QVAC_IMAGE_MODEL', 'FLUX_2_KLEIN_4B_Q4_0'),
        modelType: 'sdcpp-generation',
        modelConfig: {
          device: 'gpu',
          threads: 6,
          llmModelSrc: pick('QVAC_IMAGE_TEXTENC', 'QWEN3_4B_Q4_K_M'),
          vaeModelSrc: pick('QVAC_IMAGE_VAE', 'FLUX_2_KLEIN_4B_VAE')
        }
      }),
      // FLUX is a flow model: high guidance, cfg_scale pinned at 1.
      defaults: { steps: 20, guidance: 3.5, cfg_scale: 1 }
    },
    {
      label: 'Image',
      blurb: 'Stable Diffusion 2.1',
      size: '~2.2 GB',
      resident: false,
      load: () => ({
        modelSrc: pick('QVAC_IMAGE_MODEL', 'SD_V2_1_1B_Q4_0'),
        modelType: 'sdcpp-generation',
        modelConfig: { prediction: 'v', device: 'gpu', threads: 6 }
      }),
      defaults: { steps: 20, cfg_scale: 7 }
    }
  ),

  music: {
    label: 'Music',
    blurb: tier('ACE-Step 1.5 Turbo Q8 — higher precision', 'ACE-Step 1.5 Turbo Q4'),
    size: tier('~4.4 GB', '~3.3 GB'),
    resident: false,
    load: () => ({
      modelType: 'audiogen-ggml',
      modelConfig: {
        engine: 'acestep',
        textEncModelSrc: pick('QVAC_MUSIC_TEXTENC', 'AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0'),
        lmModelSrc: pick('QVAC_MUSIC_LM', 'AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0'),
        ditModelSrc: pick('QVAC_MUSIC_DIT', tier('AUDIOGEN_ACESTEP_V15_TURBO_Q8_0', 'AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M')),
        vaeModelSrc: pick('QVAC_MUSIC_VAE', 'AUDIOGEN_VAE_BF16'),
        useGPU: true
      }
    })
  }
}
