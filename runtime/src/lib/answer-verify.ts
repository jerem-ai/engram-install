import { AutoModelForSequenceClassification, AutoTokenizer } from '@huggingface/transformers';
import { getEmbeddingModelCacheDir, withModelCachePopulationLock } from './model-cache.js';
import { splitPassages, type PassageSource } from './passage-rescore.js';

/**
 * Answer verification for memory search. A cross-encoder reads the query and
 * one passage together and scores whether the passage answers the query. The
 * embedding lists cannot tell a note that holds the answer from a note about
 * the same subject; this can (docs/RECALL_MISS_GROUPS_2026-10-07.md).
 */
export const ANSWER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const ANSWER_MODEL_REVISION = 'a09144355adeed5f58c8ed011d209bf8ee5a1fec';
const MAX_TOKENS = 256;

export interface AnswerScorer {
  /** Best passage logit per note for the query. */
  best(query: string, notes: PassageSource[]): Promise<Map<string, number>>;
}

class CrossEncoderScorer implements AnswerScorer {
  private loaded?: Promise<{ tokenizer: any; model: any }>;

  private load() {
    this.loaded ??= withModelCachePopulationLock(async () => {
      getEmbeddingModelCacheDir();
      const options = { revision: ANSWER_MODEL_REVISION };
      return {
        tokenizer: await AutoTokenizer.from_pretrained(ANSWER_MODEL, options),
        model: await AutoModelForSequenceClassification.from_pretrained(ANSWER_MODEL, { ...options, dtype: 'q8' }),
      };
    }).catch(error => { this.loaded = undefined; throw error; });
    return this.loaded;
  }

  async best(query: string, notes: PassageSource[]): Promise<Map<string, number>> {
    const { tokenizer, model } = await this.load();
    const out = new Map<string, number>();
    for (const note of notes) {
      const passages = splitPassages(note.title, note.content);
      if (passages.length === 0) continue;
      const inputs = tokenizer(new Array(passages.length).fill(query), {
        text_pair: passages, padding: true, truncation: true, max_length: MAX_TOKENS,
      });
      const { logits } = await model(inputs);
      out.set(note.id, Math.max(...(logits.data as Float32Array)));
    }
    return out;
  }
}

let shared: AnswerScorer | undefined;

/** One cross-encoder per process, loaded on first use. */
export function answerScorer(): AnswerScorer {
  shared ??= new CrossEncoderScorer();
  return shared;
}

/** KG_ANSWER_VERIFY=0|false turns verification off for every caller. */
export function answerVerifyEnabled(): boolean {
  const flag = process.env.KG_ANSWER_VERIFY;
  return flag === undefined || !(flag === '0' || flag.toLowerCase() === 'false');
}

/** Load the model and score one pair, so the first real query does not pay for it. */
export async function warmAnswerScorer(): Promise<number> {
  const scores = await answerScorer().best('What does the probe check?', [
    { id: 'probe', title: 'probe', content: 'The probe checks that the answer model loads.' },
  ]);
  const logit = scores.get('probe');
  if (logit === undefined || !Number.isFinite(logit)) throw new Error('answer model returned no score');
  return logit;
}
