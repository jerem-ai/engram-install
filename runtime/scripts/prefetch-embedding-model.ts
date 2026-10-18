import { Embedder } from '../src/lib/embedder.js';
import { EMBEDDING_MODEL, getEmbeddingModelCacheDir } from '../src/lib/model-cache.js';
import { ANSWER_MODEL, warmAnswerScorer } from '../src/lib/answer-verify.js';

const embedder = new Embedder();

try {
  await embedder.init();
  const probe = await embedder.embed('Engram model cache readiness probe');
  if (probe.length !== 384) {
    throw new Error(`Unexpected embedding width: ${probe.length}`);
  }
  // Memory search's answer verification loads this model on first use.
  await warmAnswerScorer();
  console.log(JSON.stringify({
    cacheDir: getEmbeddingModelCacheDir(),
    dimensions: probe.length,
    model: EMBEDDING_MODEL,
    answerModel: ANSWER_MODEL,
    status: 'ready',
  }));
} finally {
  await embedder.dispose();
}
