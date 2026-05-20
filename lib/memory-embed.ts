import 'server-only';
import path from 'node:path';

let pipelinePromise: Promise<any> | null = null;

async function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Stable cache location inside the project
      env.cacheDir = path.join(process.cwd(), 'data', 'hf-cache');
      env.allowRemoteModels = true;
      env.allowLocalModels = true;
      // 384-dim feature extractor, mean-pooled normalized vector
      return await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
    })();
  }
  return pipelinePromise;
}

/** Returns a Float32Array of length 384 (mean-pooled, L2-normalized). */
export async function embedText(text: string): Promise<Float32Array> {
  if (!text?.trim()) return new Float32Array(384);
  const pipe = await getPipeline();
  // Truncate input to ~512 tokens worth of chars to avoid the model's hard cap
  const trimmed = text.length > 2000 ? text.slice(0, 2000) : text;
  const out = await pipe(trimmed, { pooling: 'mean', normalize: true });
  // out.data is Float32Array of length 384
  return new Float32Array(out.data);
}

/** Pack a Float32Array into a Buffer for SQLite BLOB storage. */
export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a SQLite BLOB into a Float32Array. */
export function bufferToVector(buf: Buffer): Float32Array {
  // Buffer may not be aligned; copy into fresh Float32Array to be safe.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** Cosine similarity for L2-normalized vectors = dot product. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Eager warm-up — call once after schema migration to download the model. Safe to no-op. */
export async function warmUpEmbedder(): Promise<void> {
  try {
    await embedText('warmup');
  } catch (e) {
    console.error('[Memory embed] warmup failed:', e);
  }
}
