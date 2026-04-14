// Wraps @huggingface/transformers feature-extraction with jina-embeddings-v2-base-code.
// 768-dim, code-tuned, 8192-token context. Mean-pooled + L2-normalized.

import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = true;
env.allowRemoteModels = true;

const MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
const DIM = 768;
const BATCH_SIZE = 32;
// Cap at ~1500 chars (~375 tokens). Beyond this, embedding cost grows quadratically (attention)
// without proportional retrieval-quality gain — function signature + first statements carry
// most of the semantic signal. Stored chunk content (in LanceDB) is NOT truncated; this only
// affects what gets embedded.
const MAX_INPUT_CHARS = 1500;
// q8 uses model_quantized.onnx — ~3-4x faster on CPU vs fp32, negligible quality loss for embeddings
const DTYPE = process.env.EMBED_DTYPE || "q8";

let pipePromise = null;

export const EMBEDDING_DIM = DIM;

export async function getEmbedder() {
  if (!pipePromise) {
    pipePromise = pipeline("feature-extraction", MODEL_ID, { dtype: DTYPE });
  }
  return pipePromise;
}

export async function embedBatch(texts) {
  const embedder = await getEmbedder();
  const cleaned = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));
  const out = [];
  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    const tensor = await embedder(batch, { pooling: "mean", normalize: true });
    // tensor is [N, DIM]. tensor.tolist() returns nested array.
    const arr = tensor.tolist();
    for (const vec of arr) out.push(Float32Array.from(vec));
  }
  return out;
}

export async function embedQuery(query) {
  const [vec] = await embedBatch([query]);
  return vec;
}
