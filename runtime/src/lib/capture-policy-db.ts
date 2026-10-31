import type Database from 'better-sqlite3';
import { captureArtifactAllowed, captureDecision, canonicalCapturePath, readCapturePolicy, type CapturePolicySnapshot } from './capture-policy.js';

/**
 * Connection-local read filters. Persistent tenant views/tables stay unchanged,
 * including on read-only connections. Administrative writes use records_*.
 * All public modes, including historical/audit, use the filtered views.
 */
export function installCapturePolicyViews(db: Database.Database, file?: string, visible?: (id: string) => boolean): void {
  db.function('replay_record_visible', (id: unknown) => {
    if (!visible) return 1;
    try { return typeof id === 'string' && visible(id) === true ? 1 : 0; } catch { return 0; }
  });
  const visibility = visible ? 'replay_record_visible(id) = 1 AND ' : '';
  const unrestricted = visible ? '0' : "capture_policy_snapshot() = 'legacy'";
  const snapshots = new Map<string, CapturePolicySnapshot>();
  db.function('capture_policy_snapshot', { deterministic: true }, () => {
    const snapshot = readCapturePolicy(file);
    // Explicit unrestricted configuration preserves pending/unbound records as
    // the missing-policy path does. Restrictions still take effect per query.
    if (captureDecision(snapshot, null).allowed) return 'legacy';
    const encoded = JSON.stringify(snapshot);
    snapshots.set(encoded, snapshot);
    while (snapshots.size > 3) snapshots.delete(snapshots.keys().next().value!);
    return encoded;
  });
  db.function('capture_artifact_allowed', { deterministic: true }, (encoded: unknown, frontmatter: unknown, id: unknown) => {
    if (encoded === 'legacy') return 1;
    if (typeof encoded !== 'string' || typeof frontmatter !== 'string') return 0;
    try {
      const snapshot = snapshots.get(encoded) ?? JSON.parse(encoded) as CapturePolicySnapshot;
      if (!captureArtifactAllowed(snapshot, JSON.parse(frontmatter))) return 0;
      if (typeof id === 'string' && id.startsWith('/')) {
        const physical = canonicalCapturePath(id);
        if (snapshot.policy?.exclude_paths.some(root => root === '/' || physical === root || physical.startsWith(root + '/'))) return 0;
      }
      return 1;
    } catch { return 0; }
  });
  const exists = (name: string): boolean => !!db.prepare("SELECT 1 FROM main.sqlite_master WHERE name = ? AND type = 'view'").get(name);
  db.exec(`
    CREATE TEMP VIEW nodes AS SELECT * FROM main.nodes
    WHERE ${visibility}(capture_policy_snapshot() = 'legacy'
       OR capture_artifact_allowed(capture_policy_snapshot(), frontmatter, id) = 1);
    CREATE TEMP VIEW edges AS SELECT e.* FROM main.edges e
    WHERE ${unrestricted}
       OR (e.source_id IN (SELECT id FROM temp.nodes) AND e.target_id IN (SELECT id FROM temp.nodes));
    CREATE TEMP VIEW communities AS SELECT c.* FROM main.communities c
    WHERE ${unrestricted}
       OR CASE WHEN json_valid(c.node_ids) THEN
         json_array_length(c.node_ids) > 0 AND NOT EXISTS (
           SELECT 1 FROM json_each(c.node_ids) member
           WHERE member.value NOT IN (SELECT id FROM temp.nodes)
         ) ELSE 0 END;
  `);
  // Names are fixed here, never interpolated from request/configuration data.
  for (const name of ['engram_assertions', 'engram_episodes', 'engram_memory_candidates', 'engram_memory_sources']) {
    if (!exists(name)) continue;
    db.exec(`CREATE TEMP VIEW ${name} AS SELECT record.* FROM main.${name} record
      WHERE ${unrestricted}
         OR EXISTS (SELECT 1 FROM temp.nodes source WHERE source.id = record.source_node_id)`);
  }
  if (exists('engram_contradiction_cases')) db.exec(`
    CREATE TEMP VIEW engram_contradiction_cases AS SELECT c.* FROM main.engram_contradiction_cases c
    WHERE ${unrestricted} OR (
      c.assertion_a_id IN (SELECT id FROM temp.engram_assertions)
      AND c.assertion_b_id IN (SELECT id FROM temp.engram_assertions)
      AND (c.source_node_id IS NULL OR c.source_node_id IN (SELECT id FROM temp.nodes))
      AND (c.evidence_note IS NULL OR c.evidence_note IN (SELECT id FROM temp.nodes))
    );
  `);
}
