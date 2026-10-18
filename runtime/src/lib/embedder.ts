import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { loadEmbeddingPipeline } from './model-cache.js';

export class Embedder {
  private extractor: FeatureExtractionPipeline | null = null;

  async init(): Promise<void> {
    this.extractor = await loadEmbeddingPipeline();
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) throw new Error('Embedder not initialized. Call init() first.');
    const output = await this.extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    return new Float32Array(output.tolist()[0] as number[]);
  }

  async dispose(): Promise<void> {
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = null;
    }
  }

  static buildEmbeddingText(
    title: string,
    tags: string[],
    content: string,
    aliases?: string[],
  ): string {
    const firstParagraph = content.split(/\n\n+/)[0] ?? '';
    const parts = [title];
    if (aliases && aliases.length > 0) {
      parts.push(aliases.join(', '));
    }
    if (tags.length > 0) {
      parts.push(tags.join(', '));
    }
    if (firstParagraph) {
      parts.push(firstParagraph);
    }
    return parts.join('\n');
  }
}
