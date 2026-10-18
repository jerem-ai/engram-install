import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { Store } from './store.js';

export interface DecayResult {
  decayed: number;
  belowThreshold: number;
}

export interface DeduplicateCandidate {
  nodeA: string;
  nodeB: string;
  titleA: string;
  titleB: string;
  similarity: number;
  type: string;
}

export interface InferredRelation {
  from: string;
  through: string;
  to: string;
  fromTitle: string;
  throughTitle: string;
  toTitle: string;
  relationAB: string;
  relationBC: string;
  confidence: number;
}

export interface PruneResult {
  prunedEdges: number;
}

export interface ContradictionCandidate {
  type: 'key_value_conflict' | 'inverse_relation' | 'confidence_divergence';
  nodeA: string;
  titleA: string;
  nodeB?: string;
  titleB?: string;
  description: string;
}

export interface EnrichmentStats {
  ts: string;
  decayed: number;
  dedupCandidates: number;
  inferredPaths: number;
  pruned: number;
  contradictions: number;
}

const DECAY_RATE = 0.02;
const CONFIDENCE_FLOOR = 0.1;
const PRUNE_THRESHOLD = 0.2;
const PRUNE_STREAK_DAYS = 7;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;
const DEDUP_MAX_PAIRS_PER_GROUP = 500;
const INFERENCE_LIMIT = 50;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class Enricher {
  constructor(private store: Store) {}

  applyDecay(): DecayResult {
    const now = new Date().toISOString();

    // Decay edge confidences and track streak
    const result = this.store.db.prepare(`
      UPDATE records_edges
      SET confidence = MAX(?, confidence - ?),
          confidence_last_updated = ?,
          low_confidence_streak = CASE
            WHEN (confidence - ?) < ? THEN low_confidence_streak + 1
            ELSE 0
          END
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND pruned = 0
    `).run(CONFIDENCE_FLOOR, DECAY_RATE, now, DECAY_RATE, PRUNE_THRESHOLD);

    const belowThreshold = (this.store.db.prepare(`
      SELECT COUNT(*) as cnt FROM records_edges
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND confidence < ? AND pruned = 0
    `).get(PRUNE_THRESHOLD) as { cnt: number }).cnt;

    return { decayed: result.changes, belowThreshold };
  }

  findDedupCandidates(): DeduplicateCandidate[] {
    const candidates: DeduplicateCandidate[] = [];

    // Get all non-pruned nodes grouped by type
    const nodes = this.store.db.prepare(`
      SELECT id, title, JSON_EXTRACT(frontmatter, '$.type') as type
      FROM nodes
      WHERE pruned = 0
    `).all() as Array<{ id: string; title: string; type: string | null }>;

    // Group by type
    const byType = new Map<string, Array<{ id: string; title: string }>>();
    for (const node of nodes) {
      const type = node.type ?? '__untyped__';
      const group = byType.get(type) ?? [];
      group.push({ id: node.id, title: node.title });
      byType.set(type, group);
    }

    // For each type group, compare pairs by cosine similarity
    for (const [type, group] of byType) {
      if (group.length < 2) continue;

      // Load embeddings for this group
      const embeddings = new Map<string, Float32Array>();
      for (const node of group) {
        const emb = this.store.getNodeEmbedding(node.id);
        if (emb) embeddings.set(node.id, emb);
      }

      const withEmbeddings = group.filter(n => embeddings.has(n.id));
      if (withEmbeddings.length < 2) continue;

      let pairs = 0;
      outer: for (let i = 0; i < withEmbeddings.length; i++) {
        for (let j = i + 1; j < withEmbeddings.length; j++) {
          if (++pairs > DEDUP_MAX_PAIRS_PER_GROUP) break outer;

          const a = withEmbeddings[i];
          const b = withEmbeddings[j];
          const sim = cosineSimilarity(embeddings.get(a.id)!, embeddings.get(b.id)!);
          if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
            candidates.push({
              nodeA: a.id,
              nodeB: b.id,
              titleA: a.title,
              titleB: b.title,
              similarity: Math.round(sim * 1000) / 1000,
              type,
            });
          }
        }
      }
    }

    return candidates;
  }

  findInferredRelations(): InferredRelation[] {
    const rows = this.store.db.prepare(`
      SELECT
        e1.source_id   AS from_id,
        n1.title       AS from_title,
        e1.target_id   AS through_id,
        n2.title       AS through_title,
        e2.target_id   AS to_id,
        n3.title       AS to_title,
        e1.relation_type AS rel_ab,
        e2.relation_type AS rel_bc,
        e1.confidence  AS conf_ab,
        e2.confidence  AS conf_bc
      FROM edges e1
      JOIN edges e2 ON e1.target_id = e2.source_id
      LEFT JOIN nodes n1 ON n1.id = e1.source_id
      LEFT JOIN nodes n2 ON n2.id = e1.target_id
      LEFT JOIN nodes n3 ON n3.id = e2.target_id
      WHERE e1.source_id != e2.target_id
        AND e1.pruned = 0 AND e2.pruned = 0
        AND e1.confidence > 0.5 AND e2.confidence > 0.5
        AND NOT EXISTS (
          SELECT 1 FROM edges e3
          WHERE e3.source_id = e1.source_id
            AND e3.target_id = e2.target_id
            AND e3.pruned = 0
        )
      LIMIT ?
    `).all(INFERENCE_LIMIT) as Array<{
      from_id: string; from_title: string | null;
      through_id: string; through_title: string | null;
      to_id: string; to_title: string | null;
      rel_ab: string; rel_bc: string;
      conf_ab: number; conf_bc: number;
    }>;

    return rows.map(r => ({
      from: r.from_id,
      through: r.through_id,
      to: r.to_id,
      fromTitle: r.from_title ?? r.from_id,
      throughTitle: r.through_title ?? r.through_id,
      toTitle: r.to_title ?? r.to_id,
      relationAB: r.rel_ab,
      relationBC: r.rel_bc,
      confidence: Math.round(Math.min(r.conf_ab, r.conf_bc) * 0.8 * 1000) / 1000,
    }));
  }

  applyPrune(): PruneResult {
    const result = this.store.db.prepare(`
      UPDATE records_edges
      SET pruned = 1
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND confidence < ? AND low_confidence_streak >= ? AND pruned = 0
    `).run(PRUNE_THRESHOLD, PRUNE_STREAK_DAYS);

    return { prunedEdges: result.changes };
  }

  findContradictions(): ContradictionCandidate[] {
    const candidates: ContradictionCandidate[] = [];

    // Pattern 1: inverse relation pairs on same node pair
    // e.g., A --blocks--> B and A --unblocks--> B (or B --blocks--> A)
    const inverseMap: Record<string, string> = {
      blocks: 'unblocks',
      unblocks: 'blocks',
      depends_on: 'replaces',
      replaces: 'depends_on',
    };

    const edgePairs = this.store.db.prepare(`
      SELECT
        e1.source_id AS src, n1.title AS src_title,
        e1.target_id AS tgt, n2.title AS tgt_title,
        e1.relation_type AS rel1,
        e2.relation_type AS rel2,
        e1.confidence AS conf1,
        e2.confidence AS conf2
      FROM edges e1
      JOIN edges e2 ON e1.source_id = e2.source_id AND e1.target_id = e2.target_id
        AND e1.id < e2.id
      LEFT JOIN nodes n1 ON n1.id = e1.source_id
      LEFT JOIN nodes n2 ON n2.id = e1.target_id
      WHERE e1.pruned = 0 AND e2.pruned = 0
        AND e1.confidence > 0.5 AND e2.confidence > 0.5
    `).all() as Array<{
      src: string; src_title: string | null;
      tgt: string; tgt_title: string | null;
      rel1: string; rel2: string;
      conf1: number; conf2: number;
    }>;

    for (const row of edgePairs) {
      const inverse = inverseMap[row.rel1];
      if (inverse && inverse === row.rel2) {
        candidates.push({
          type: 'inverse_relation',
          nodeA: row.src,
          titleA: row.src_title ?? row.src,
          nodeB: row.tgt,
          titleB: row.tgt_title ?? row.tgt,
          description: `"${row.src_title ?? row.src}" has both "${row.rel1}" and "${row.rel2}" to "${row.tgt_title ?? row.tgt}"`,
        });
      }
    }

    // Pattern 2: same frontmatter key, different values across nodes with same title prefix
    // Scan nodes for conflicting port/version/status frontmatter values
    const conflictKeys = ['port', 'status', 'version', 'phase'];
    for (const key of conflictKeys) {
      const nodes = this.store.db.prepare(`
        SELECT id, title, JSON_EXTRACT(frontmatter, ?) AS val
        FROM nodes
        WHERE pruned = 0
          AND JSON_EXTRACT(frontmatter, ?) IS NOT NULL
      `).all(`$.${key}`, `$.${key}`) as Array<{ id: string; title: string; val: unknown }>;

      // Group by value, detect any case where two nodes both assert different values
      // for the same conceptual entity (same title, different path depth)
      const byTitle = new Map<string, Array<{ id: string; val: unknown }>>();
      for (const node of nodes) {
        const base = node.title.toLowerCase().trim();
        const group = byTitle.get(base) ?? [];
        group.push({ id: node.id, val: node.val });
        byTitle.set(base, group);
      }

      for (const [title, group] of byTitle) {
        const uniqueVals = new Set(group.map(g => String(g.val)));
        if (uniqueVals.size > 1) {
          candidates.push({
            type: 'key_value_conflict',
            nodeA: group[0].id,
            titleA: title,
            description: `"${title}" has conflicting "${key}" values: ${[...uniqueVals].join(', ')}`,
          });
        }
      }
    }

    // Pattern 3: confidence divergence — same edge pair with >0.4 confidence gap
    const divergent = this.store.db.prepare(`
      SELECT
        e1.source_id AS src, n1.title AS src_title,
        e1.target_id AS tgt, n2.title AS tgt_title,
        e1.confidence AS conf1,
        e2.confidence AS conf2,
        ABS(e1.confidence - e2.confidence) AS gap
      FROM edges e1
      JOIN edges e2 ON e1.source_id = e2.source_id AND e1.target_id = e2.target_id
        AND e1.relation_type = e2.relation_type AND e1.id < e2.id
      LEFT JOIN nodes n1 ON n1.id = e1.source_id
      LEFT JOIN nodes n2 ON n2.id = e1.target_id
      WHERE e1.pruned = 0 AND e2.pruned = 0
        AND ABS(e1.confidence - e2.confidence) > 0.4
    `).all() as Array<{
      src: string; src_title: string | null;
      tgt: string; tgt_title: string | null;
      conf1: number; conf2: number; gap: number;
    }>;

    for (const row of divergent) {
      candidates.push({
        type: 'confidence_divergence',
        nodeA: row.src,
        titleA: row.src_title ?? row.src,
        nodeB: row.tgt,
        titleB: row.tgt_title ?? row.tgt,
        description: `Edge from "${row.src_title ?? row.src}" to "${row.tgt_title ?? row.tgt}" has confidence gap of ${row.gap.toFixed(2)} (${row.conf1.toFixed(2)} vs ${row.conf2.toFixed(2)})`,
      });
    }

    return candidates;
  }

  enrichAll(nightlyLogPath?: string): EnrichmentStats {
    const ts = new Date().toISOString();
    const logPath = nightlyLogPath
      ?? join(homedir(), 'claude-vault/vault/Reference/Nightly_Log.md');

    const decay = this.applyDecay();
    const dedup = this.findDedupCandidates();
    const inferred = this.findInferredRelations();
    const prune = this.applyPrune();
    const contradictions = this.findContradictions();

    const stats: EnrichmentStats = {
      ts,
      decayed: decay.decayed,
      dedupCandidates: dedup.length,
      inferredPaths: inferred.length,
      pruned: prune.prunedEdges,
      contradictions: contradictions.length,
    };

    const block = [
      '',
      '```yaml',
      'enrichment_run:',
      `  ts: ${ts}`,
      `  decayed: ${stats.decayed}`,
      `  dedup_candidates: ${stats.dedupCandidates}`,
      `  inferred_paths: ${stats.inferredPaths}`,
      `  pruned_nodes: ${stats.pruned}`,
      `  contradictions: ${stats.contradictions}`,
      '```',
      '',
    ].join('\n');

    try {
      if (logPath !== '/dev/null') {
        mkdirSync(dirname(logPath), { recursive: true });
      }
      appendFileSync(logPath, block, 'utf8');
    } catch {
      // Non-fatal: log path may not be writable in some environments
    }

    return stats;
  }
}
