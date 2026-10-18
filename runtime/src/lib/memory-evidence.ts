import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedNode, SearchResult } from './types.js';

type Link = { event_id: string; transcript_id: string; raw_hash: string; actor: string; timestamp: string };
type Row = { node_id: string; recall_binding_sha256: string; project: string | null; source_path?: string;
  complete_memory_binding_sha256?: string;
  evidence_status: string; support_status: string; passages: { passage_sha256?: string; matches: Link[] }[];
  support_review?: { binding_sha256: string; reviewed_at: string; receipt_sha256: string } };
let cache: { stamp: string; rows: Map<string, Row> } | undefined;

/** Producer and reader hash the same parsed memory, including every frontmatter field. */
export function completeMemoryBinding(node: ParsedNode): string {
  return createHash('sha256').update(JSON.stringify([node.id, node.title, node.content, node.frontmatter])).digest('hex');
}

/** Only precomputed provenance is read here. Recall never opens history. */
export function memoryEvidence(node: ParsedNode | undefined,
  file = process.env.ENGRAM_MEMORY_EVIDENCE_PATH ?? join(homedir(), '.local/share/engram/memory-evidence.json')): SearchResult['evidence'] {
  if (!node) return undefined;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (stat.mode & 0o077)) return undefined;
    const stamp = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (cache?.stamp !== stamp) {
      const report = JSON.parse(readFileSync(file, 'utf8'));
      if (report.schema !== 'engram.memory-evidence-report.v1' || !Array.isArray(report.memories)) return undefined;
      const rows = new Map<string, Row>();
      for (const row of report.memories) {
        if (rows.has(row.node_id)) return undefined;
        rows.set(row.node_id, row);
      }
      cache = { stamp, rows };
    }
    const row = cache.rows.get(node.id);
    if (!row) return undefined;
    const fm = node.frontmatter;
    const meta = (fm.metadata ?? {}) as Record<string, unknown>;
    const passages = meta.passages || fm.passages || [];
    const binding = createHash('sha256').update(JSON.stringify([node.id, node.title, node.content,
      fm.description ?? null, meta.source_session || fm.source_session || null, passages])).digest('hex');
    const expectedBinding = row.recall_binding_sha256.startsWith('components-v1:')
      ? `components-v1:${completeMemoryBinding(node)}` : binding;
    if (expectedBinding !== row.recall_binding_sha256) return undefined;
    const events = [...new Map(row.passages.flatMap(p => p.matches).map(e => [e.event_id, e])).values()];
    if (!events.length || !['linked', 'partial'].includes(row.evidence_status)) return undefined;
    if (events.some(e => !/^[a-zA-Z0-9:_-]{1,160}$/.test(e.event_id)
      || !/^[a-zA-Z0-9:_-]{1,160}$/.test(e.transcript_id)
      || !/^[a-f0-9]{64}$/.test(e.raw_hash)
      || !['user', 'assistant', 'tool', 'system'].includes(e.actor))) return undefined;
    let supportReview: NonNullable<SearchResult['evidence']>['supportReview'];
    if (row.support_status !== 'unreviewed') {
      if (!['operator-supported', 'operator-unsupported', 'operator-uncertain'].includes(row.support_status)) return undefined;
      const review = row.support_review;
      if (row.complete_memory_binding_sha256 !== completeMemoryBinding(node)) return undefined;
      const reviewBinding = createHash('sha256').update(JSON.stringify([row.node_id, row.recall_binding_sha256, row.complete_memory_binding_sha256,
        row.evidence_status, row.passages.map(p => [p.passage_sha256 ?? null,
          p.matches.map(e => [e.event_id, e.transcript_id, e.raw_hash, e.actor, e.timestamp ?? null])])])).digest('hex');
      if (!review || review.binding_sha256 !== reviewBinding || typeof review.receipt_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(review.receipt_sha256) || typeof review.reviewed_at !== 'string'
        || !Number.isFinite(Date.parse(review.reviewed_at))) return undefined;
      supportReview = { reviewedAt: review.reviewed_at, receiptSha256: review.receipt_sha256 };
    }
    const sourceProject = typeof row.source_path === 'string' && row.source_path === fm.source_path
      && typeof row.project === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(row.project) ? row.project : undefined;
    return { status: row.evidence_status as 'linked' | 'partial',
      support: row.support_status as NonNullable<SearchResult['evidence']>['support'],
      ...(supportReview ? { supportReview } : {}),
      ...(sourceProject ? { sourceProject } : {}),
      events: events.map(e => ({ eventId: e.event_id, transcriptId: e.transcript_id, rawHash: e.raw_hash, actor: e.actor })) };
  } catch { return undefined; } // Missing or stale provenance cannot disable recall.
}
