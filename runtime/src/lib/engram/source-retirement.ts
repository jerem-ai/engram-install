import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VaultWriter } from '../writer.js';
import type { Store } from '../store.js';

/**
 * Retiring a source (2026-10-04). An admitted correction can name the memory
 * note it replaces. Engram never edits that note (the memory mirror would
 * rewrite it from its origin). It writes a small retirement note under
 * EngramRetirements/ instead, so the record lives in the vault, is backed up
 * with it, and survives a rebuild. Readers apply it at read time: memory search
 * drops the retired note the way it drops a `stale: true` one (which keeps it
 * out of the Claude recall hook and kg_memory_search), and engram_recall treats
 * facts from that note as historical. Deleting the retirement note restores both.
 */
export const RETIREMENT_DIR = 'EngramRetirements';

export interface SourceRetirement {
  retirement_node_id: string;
  retires: string;
  retired_by: string;
  reason: string;
  created: string;
}

export type RetireResult =
  | { status: 'retired'; source_node_id: string; retirement_node_id: string }
  | { status: 'held'; source_node_id: string;
      reason: 'not_a_memory_note' | 'source_missing' | 'already_retired' | 'same_as_correction' };

export function retirementNodeId(sourceNodeId: string): string {
  return `${RETIREMENT_DIR}/${retirementTitle(sourceNodeId)}.md`;
}

function retirementTitle(sourceNodeId: string): string {
  return `retire-${createHash('sha256').update(sourceNodeId).digest('hex').slice(0, 32)}`;
}

/** Only agent memory notes under Memory/ can be retired; sessions, docs and Jeremy's notes cannot. */
export function retireSource(
  db: Database.Database,
  writer: VaultWriter,
  input: { sourceNodeId: string; retiredBy: string; reason: string; correctionSourceNodeId?: string; now?: string },
): RetireResult {
  const id = input.sourceNodeId.trim();
  const held = (reason: Extract<RetireResult, { status: 'held' }>['reason']): RetireResult =>
    ({ status: 'held', source_node_id: id, reason });
  if (!id.startsWith('Memory/')) return held('not_a_memory_note');
  if (id === input.correctionSourceNodeId) return held('same_as_correction');
  if (!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id)) return held('source_missing');
  if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(retirementNodeId(id))) return held('already_retired');
  const created = input.now ?? new Date().toISOString();
  const node = writer.createNode({
    title: retirementTitle(id),
    directory: RETIREMENT_DIR,
    frontmatter: { type: 'engram_source_retirement', retires: id, retired_by: input.retiredBy, reason: input.reason, created },
    content: `Retired ${id}: ${input.reason}`,
  });
  return { status: 'retired', source_node_id: id, retirement_node_id: node };
}

/** Undo a retirement by deleting its note from the vault and the index. */
export function restoreSource(store: Store, writer: VaultWriter, sourceNodeId: string): { status: 'restored' | 'not_retired' } {
  const node = retirementNodeId(sourceNodeId);
  if (!store.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(node)) return { status: 'not_retired' };
  writer.deleteSource(node);
  store.deleteNode(node);
  return { status: 'restored' };
}

export function listRetiredSources(db: Database.Database): SourceRetirement[] {
  const rows = db.prepare(`SELECT id, frontmatter FROM nodes WHERE id LIKE ? ORDER BY id`)
    .all(`${RETIREMENT_DIR}/%`) as Array<{ id: string; frontmatter: string | null }>;
  const out: SourceRetirement[] = [];
  for (const row of rows) {
    let fm: Record<string, unknown>;
    try { fm = JSON.parse(row.frontmatter ?? '{}'); } catch { continue; }
    // Only a note whose name matches what it retires counts; a hand-made note cannot retire another path.
    if (fm.type !== 'engram_source_retirement' || typeof fm.retires !== 'string' || retirementNodeId(fm.retires) !== row.id) continue;
    out.push({ retirement_node_id: row.id, retires: fm.retires, retired_by: String(fm.retired_by ?? ''),
      reason: String(fm.reason ?? ''), created: String(fm.created ?? '') });
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

/** Every retired source path. */
export function retiredSources(db: Database.Database): Set<string> {
  return new Set(listRetiredSources(db).map(r => r.retires));
}
