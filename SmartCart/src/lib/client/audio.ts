// Audio conversions for Gemini Live: microphone input is 16-bit PCM at 16 kHz,
// spoken output is 16-bit PCM at 24 kHz. Both little-endian, mono.

/** Downsample by averaging the input samples that fall into each output sample. */
export function downsample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (outputRate >= inputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let position = start; position < end; position++) sum += input[position]!;
    output[index] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index++) {
    const sample = Math.max(-1, Math.min(1, input[index]!));
    output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return output;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index++) output[index] = input[index]! / 0x8000;
  return output;
}

export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

export function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length - (binary.length % 2)));
  for (let index = 0; index < view.byteLength; index++) view.setUint8(index, binary.charCodeAt(index));
  const samples = new Int16Array(view.byteLength / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true);
  return samples;
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
