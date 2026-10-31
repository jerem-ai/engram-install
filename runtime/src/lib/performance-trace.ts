/** Body-free, per-request spans. Overlapping spans must not be summed as wall time. */
export type PerformanceStage = 'model_load' | 'embedding' | 'vector' | 'lexical'
  | 'eligibility' | 'passages' | 'fusion' | 'verification' | 'reranking'
  | 'selection' | 'evidence' | 'serialization' | 'transport';

export interface PerformanceSpan {
  stage: PerformanceStage;
  start_ms: number;
  duration_ms: number;
  outcome: 'ok' | 'error';
}

export interface PerformanceReport {
  schema: 'engram.performance.v1';
  total_ms: number;
  outcome: 'ok' | 'error';
  spans: PerformanceSpan[];
  spans_dropped: number;
}

export class PerformanceTrace {
  private readonly origin: number;
  private readonly spans: PerformanceSpan[] = [];
  private readonly active = new Set<(outcome?: 'ok' | 'error') => void>();
  private dropped = 0;
  private finished = false;

  constructor(
    private readonly publish: (report: PerformanceReport) => void,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.origin = clock();
  }

  start(stage: PerformanceStage): (outcome?: 'ok' | 'error') => void {
    const start = this.clock();
    let ended = false;
    const end = (outcome: 'ok' | 'error' = 'ok') => {
      if (ended || this.finished) return;
      ended = true;
      this.active.delete(end);
      if (this.spans.length >= 64) { this.dropped++; return; }
      this.spans.push({ stage, start_ms: start - this.origin,
        duration_ms: Math.max(0, this.clock() - start), outcome });
    };
    this.active.add(end);
    return end;
  }

  sync<T>(stage: PerformanceStage, action: () => T): T {
    const end = this.start(stage);
    try { const value = action(); end(); return value; }
    catch (error) { end('error'); throw error; }
  }

  async async<T>(stage: PerformanceStage, action: () => Promise<T>): Promise<T> {
    const end = this.start(stage);
    try { const value = await action(); end(); return value; }
    catch (error) { end('error'); throw error; }
  }

  finish(outcome: 'ok' | 'error'): void {
    if (this.finished) return;
    for (const end of this.active) end(outcome);
    this.finished = true;
    const report: PerformanceReport = { schema: 'engram.performance.v1',
      total_ms: Math.max(0, this.clock() - this.origin), outcome,
      spans: this.spans.map(span => ({ ...span })), spans_dropped: this.dropped };
    // A diagnostic observer must never change the search result or its error.
    try { this.publish(report); } catch { /* private observer unavailable */ }
  }
}

export function timed<T>(trace: PerformanceTrace | undefined, stage: PerformanceStage, action: () => T): T {
  return trace ? trace.sync(stage, action) : action();
}

export function timedAsync<T>(trace: PerformanceTrace | undefined, stage: PerformanceStage, action: () => Promise<T>): Promise<T> {
  return trace ? trace.async(stage, action) : action();
}
