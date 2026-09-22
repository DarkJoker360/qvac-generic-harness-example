// Minimal, dependency-free WAV writers.
//
// QVAC's audio engines return raw PCM with no container, but in two different
// shapes, so there are two entry points:
//
//   textToSpeech() -> `number[]` of int16 SAMPLES      -> encodeWavFromSamples
//   audioGen()     -> `Uint8Array` of encoded BYTES    -> encodeWavFromPcmBytes
//
// Passing a byte buffer to the sample encoder silently produces near-silent
// audio of double the correct duration, because every byte becomes a sample.

/** Build the 44-byte RIFF/WAVE header for a PCM payload of `dataLength` bytes. */
function header (dataLength, { sampleRate, channels, bitsPerSample }) {
  const bytesPerSample = bitsPerSample / 8
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataLength, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)  // fmt chunk size
  h.writeUInt16LE(1, 20)   // format: PCM
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * bytesPerSample, 28) // byte rate
  h.writeUInt16LE(channels * bytesPerSample, 32)              // block align
  h.writeUInt16LE(bitsPerSample, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataLength, 40)
  return h
}

/**
 * Wrap PCM that is already a byte buffer (audioGen).
 * @param {Uint8Array} bytes interleaved PCM, already at `bitsPerSample`
 */
export function encodeWavFromPcmBytes (bytes, { sampleRate, channels = 1, bitsPerSample = 16 }) {
  const data = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)
  return Buffer.concat([header(data.length, { sampleRate, channels, bitsPerSample }), data])
}

/**
 * Wrap PCM given as numeric samples (textToSpeech).
 * @param {ArrayLike<number>} samples interleaved samples
 */
export function encodeWavFromSamples (samples, { sampleRate, channels = 1, bitsPerSample = 16 }) {
  const bytesPerSample = bitsPerSample / 8
  const data = Buffer.alloc(samples.length * bytesPerSample)

  for (let i = 0; i < samples.length; i++) {
    // Clamp: the engines can emit values a hair outside range.
    const v = Math.round(samples[i])
    if (bitsPerSample === 16) data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2)
    else if (bitsPerSample === 32) data.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, v)), i * 4)
    else throw new Error(`unsupported bitsPerSample: ${bitsPerSample}`)
  }

  return Buffer.concat([header(data.length, { sampleRate, channels, bitsPerSample }), data])
}
