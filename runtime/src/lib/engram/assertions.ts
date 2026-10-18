import type Database from 'better-sqlite3';
import { MissingTemporalProvenanceError, normalizeTemporalInstant } from './temporal.js';
import { isStale } from '../memory-currency.js';

/**
 * Engram Assertions: structured temporal facts derived from vault sources.
 *
 * An assertion is a subject-predicate-object triple with temporal validity,
 * confidence, and full provenance chain back to a vault source via episode_id.
 *
 * Contradiction cases are built alongside assertions (same migration pass)
 * because they share the same assertion table schema.
 */

export type AssertionStatus =
  | 'current'
  | 'historical'
  | 'contradicted'
  | 'retracted'
  | 'suspected_orphan'
  | 'orphaned';

export interface EngramAssertion {
  tenant_id: string;
  owner_principal_id: string;
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;           // 0.0–1.0
  status: AssertionStatus;
  valid_from: string | null;    // ISO timestamp
  valid_to: string | null;      // ISO timestamp — null = still current
  source_node_id: string;       // vault file path
  episode_id: string | null;    // provenance episode
  superseded_by: string | null; // assertion ID that replaced this one
  created_at: string;           // ISO timestamp
  updated_at: string;           // ISO timestamp
  currency_stale?: number;      // query-time diagnostic; never written to the assertion
}

export type ContradictionStatus = 'open' | 'resolved' | 'dismissed';

export interface EngramContradictionCase {
  tenant_id: string;
  owner_principal_id: string;
  id: string;
  subject: string;
  predicate: string;
  assertion_a_id: string;
  assertion_b_id: string;
  status: ContradictionStatus;
  detected_at: string;
  resolved_at: string | null;
  resolution_type: string | null;   // supersede | retract_old | merge | downgrade_confidence
  evidence_note: string | null;     // resolution rationale
  source_node_id: string | null;    // vault Decision note if resolved
}

export const ASSERTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS records_engram_assertions (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'current',
    valid_from TEXT,
    valid_to TEXT,
    source_node_id TEXT,
    episode_id TEXT,
    superseded_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_engram_assertions_subject
    ON records_engram_assertions(tenant_id, subject);
  CREATE INDEX IF NOT EXISTS idx_engram_assertions_predicate
    ON records_engram_assertions(tenant_id, predicate);
  CREATE INDEX IF NOT EXISTS idx_engram_assertions_status
    ON records_engram_assertions(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_engram_assertions_source
    ON records_engram_assertions(tenant_id, source_node_id);
  CREATE INDEX IF NOT EXISTS idx_engram_assertions_episode
    ON records_engram_assertions(tenant_id, episode_id);

  -- Schema backstop for the insertAssertion() cross-source dedup guard: at most
  -- one 'current' row per (subject, predicate, object) triple. Partial index —
  -- history/retracted/etc. rows stay unconstrained (a triple may have many past
  -- states, just one live one). Run scripts/dedupe-current-assertions.ts BEFORE
  -- this lands on any database with pre-existing violations — SQLite refuses to
  -- build a unique index over data that already violates it.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_engram_assertions_current_triple
    ON records_engram_assertions(tenant_id, subject, predicate, object)
    WHERE status = 'current';

  CREATE TABLE IF NOT EXISTS records_engram_contradiction_cases (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    assertion_a_id TEXT NOT NULL,
    assertion_b_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolution_type TEXT,
    evidence_note TEXT,
    source_node_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_engram_contradiction_status
    ON records_engram_contradiction_cases(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_engram_contradiction_subject
    ON records_engram_contradiction_cases(tenant_id, subject, predicate);

  CREATE VIEW IF NOT EXISTS engram_assertions AS
    SELECT tenant_id, owner_principal_id, id, subject, predicate, object,
           confidence, status, valid_from, valid_to, source_node_id, episode_id,
           superseded_by, created_at, updated_at
    FROM records_engram_assertions
    WHERE tenant_id = current_tenant_id();

  CREATE VIEW IF NOT EXISTS engram_contradiction_cases AS
    SELECT tenant_id, owner_principal_id, id, subject, predicate,
           assertion_a_id, assertion_b_id, status, detected_at, resolved_at,
           resolution_type, evidence_note, source_node_id
    FROM records_engram_contradiction_cases
    WHERE tenant_id = current_tenant_id();
`;

export function ensureAssertionTables(db: Database.Database): void {
  db.exec(ASSERTION_SCHEMA);
}

// --- Assertion CRUD ---

export function assertionId(assertion: {
  source_node_id?: string | null;
  subject: string;
  predicate: string;
  object: string;
}): string {
  const key = [
    assertion.source_node_id ?? '',
    assertion.subject,
    assertion.predicate,
    assertion.object,
  ].map(part => part.trim().toLowerCase()).join('\u001f');

  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `assert_${Math.abs(hash).toString(36)}`;
}

export function insertAssertion(
  db: Database.Database,
  assertion: {
    subject: string;
    predicate: string;
    object: string;
    confidence?: number;
    status?: AssertionStatus;
    valid_from?: string | null;
    valid_to?: string | null;
    source_node_id?: string | null;
    episode_id?: string | null;
    superseded_by?: string | null;
  }
): EngramAssertion {
  const id = assertionId(assertion);
  const now = new Date().toISOString();
  if (assertion.valid_from === undefined || assertion.valid_from === null) {
    throw new MissingTemporalProvenanceError();
  }
  const validFrom = normalizeTemporalInstant(assertion.valid_from);
  const validTo = assertion.valid_to === undefined || assertion.valid_to === null
    ? null
    : normalizeTemporalInstant(assertion.valid_to);
  if (validTo && validTo < validFrom) {
    throw new Error('valid_to must not be earlier than valid_from');
  }

  // Cross-source dedup guard: id is derived from (source_node_id, subject,
  // predicate, object), so two different sources asserting the identical
  // triple get two different ids and would otherwise both land as separate
  // 'current' rows (the ON CONFLICT(id) upsert below only catches same-id,
  // i.e. same-source, re-inserts). Coalesce provenance into the existing
  // current row instead of inserting a second one.
  if ((assertion.status ?? 'current') === 'current') {
    const existingCurrent = db.prepare(`
      SELECT * FROM engram_assertions
      WHERE owner_principal_id = current_principal_id()
        AND subject = ? AND predicate = ? AND object = ? AND status = 'current' AND id != ?
    `).get(assertion.subject, assertion.predicate, assertion.object, id) as EngramAssertion | undefined;

    if (existingCurrent) {
      db.prepare(`
        UPDATE records_engram_assertions SET
          confidence = ?,
          valid_from = CASE
            WHEN valid_from IS NULL OR ? < valid_from THEN ?
            ELSE valid_from
          END,
          valid_to = ?,
          episode_id = COALESCE(?, episode_id),
          superseded_by = COALESCE(superseded_by, ?),
          source_node_id = COALESCE(source_node_id, ?),
          updated_at = ?
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND id = ?
      `).run(
        assertion.confidence ?? existingCurrent.confidence,
        validFrom,
        validFrom,
        validTo,
        assertion.episode_id ?? null,
        assertion.superseded_by ?? null,
        assertion.source_node_id ?? null,
        now,
        existingCurrent.id,
      );
      return getAssertion(db, existingCurrent.id)!;
    }
  }

  db.prepare(`
    INSERT INTO records_engram_assertions
      (tenant_id, owner_principal_id, id, subject, predicate, object, confidence, status, valid_from, valid_to,
       source_node_id, episode_id, superseded_by, created_at, updated_at)
    VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      confidence = excluded.confidence,
      status = CASE
        WHEN records_engram_assertions.status IN ('historical', 'retracted', 'orphaned')
          AND excluded.status = 'current'
        THEN records_engram_assertions.status
        ELSE excluded.status
      END,
      valid_from = CASE
        WHEN records_engram_assertions.valid_from IS NULL
          OR excluded.valid_from < records_engram_assertions.valid_from
        THEN excluded.valid_from
        ELSE records_engram_assertions.valid_from
      END,
      valid_to = CASE
        WHEN records_engram_assertions.status IN ('historical', 'retracted', 'orphaned')
          AND excluded.status = 'current'
        THEN records_engram_assertions.valid_to
        ELSE excluded.valid_to
      END,
      episode_id = COALESCE(excluded.episode_id, records_engram_assertions.episode_id),
      superseded_by = COALESCE(records_engram_assertions.superseded_by, excluded.superseded_by),
      updated_at = excluded.updated_at
  `).run(
    id,
    assertion.subject,
    assertion.predicate,
    assertion.object,
    assertion.confidence ?? 1.0,
    assertion.status ?? 'current',
    validFrom,
    validTo,
    assertion.source_node_id ?? null,
    assertion.episode_id ?? null,
    assertion.superseded_by ?? null,
    now,
    now,
  );
  return getAssertion(db, id)!;
}

export function getAssertion(
  db: Database.Database,
  id: string
): EngramAssertion | undefined {
  return db.prepare('SELECT * FROM engram_assertions WHERE id = ?').get(id) as
    EngramAssertion | undefined;
}

export function queryAssertions(
  db: Database.Database,
  opts: {
    subject?: string;
    predicate?: string;
    status?: AssertionStatus | AssertionStatus[];
    minConfidence?: number;
    sourceNodeId?: string;
    limit?: number;
    offset?: number;
    mode?: 'current' | 'historical' | 'audit';
    /**
     * Lowercase [a-z0-9] query words. When given, only rows containing at least
     * one of them are returned, those matching the most words first. Without it
     * a recall saw only the newest rows, never a fact further down the table.
     */
    terms?: string[];
  } = {}
): EngramAssertion[] {
  const now = Date.now();
  db.function('engram_currency_stale', (validTo, supersededBy, rawFrontmatter) => {
    let frontmatter = {};
    try { frontmatter = JSON.parse(String(rawFrontmatter ?? '{}')); } catch { /* no source metadata */ }
    return Number(isStale({ valid_to: validTo, superseded_by: supersededBy }, now) || isStale(frontmatter, now));
  });
  const stale = `engram_currency_stale(valid_to, superseded_by,
    (SELECT n.frontmatter FROM nodes n WHERE n.id = engram_assertions.source_node_id))`;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.subject) {
    conditions.push('subject = ?');
    params.push(opts.subject);
  }
  if (opts.predicate) {
    conditions.push('predicate = ?');
    params.push(opts.predicate);
  }
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (opts.minConfidence !== undefined) {
    conditions.push('confidence >= ?');
    params.push(opts.minConfidence);
  }
  if (opts.sourceNodeId) {
    conditions.push('source_node_id = ?');
    params.push(opts.sourceNodeId);
  }
  if (opts.mode === 'current') {
    conditions.push("status IN ('current', 'contradicted')");
    conditions.push(`${stale} = 0`);
  } else if (opts.mode === 'historical') {
    conditions.push(`(status IN ('historical', 'contradicted', 'retracted') OR ${stale} = 1)`);
  }
  // 'audit' = no filter, include everything

  const terms = (opts.terms ?? []).filter(t => /^[a-z0-9]+$/.test(t)).slice(0, 24);
  const text = `(subject || ' ' || predicate || ' ' || object)`;
  const rank = terms.map(() => `(${text} LIKE ?)`).join(' + ');
  if (terms.length) {
    conditions.push(`(${terms.map(() => `${text} LIKE ?`).join(' OR ')})`);
    params.push(...terms.map(t => `%${t}%`));
  }
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = terms.length ? `ORDER BY (${rank}) DESC, created_at DESC` : 'ORDER BY created_at DESC';
  return db.prepare(
    `SELECT *, ${stale} AS currency_stale FROM engram_assertions ${where} ${order} LIMIT ? OFFSET ?`
  ).all(...params, ...terms.map(t => `%${t}%`), limit, offset) as EngramAssertion[];
}

export function updateAssertionStatus(
  db: Database.Database,
  id: string,
  status: AssertionStatus,
  supersededBy?: string
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE records_engram_assertions
    SET status = ?, updated_at = ?, superseded_by = COALESCE(?, superseded_by)
    WHERE tenant_id = current_tenant_id()
      AND owner_principal_id = current_principal_id()
      AND id = ?
  `).run(status, now, supersededBy ?? null, id);

  // If retracting, set valid_to
  if (status === 'retracted' || status === 'orphaned') {
    db.prepare(`
      UPDATE records_engram_assertions
      SET valid_to = COALESCE(valid_to, ?)
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND id = ? AND valid_to IS NULL
    `).run(now, id);
  }
}

export function updateAssertionConfidence(
  db: Database.Database,
  id: string,
  newConfidence: number,
  evidenceText?: string
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE records_engram_assertions
    SET confidence = ?, updated_at = ?
    WHERE tenant_id = current_tenant_id()
      AND owner_principal_id = current_principal_id()
      AND id = ?
  `).run(newConfidence, now, id);
}

export function countAssertions(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM engram_assertions').get() as { c: number };
  return row.c;
}

// --- Contradiction Case CRUD ---

export function detectContradictions(
  db: Database.Database,
  sourceAllowed: (sourceNodeId: string) => boolean = () => true,
): EngramContradictionCase[] {
  // Find pairs of current assertions with same subject+predicate but different objects
  const pairs = db.prepare(`
    SELECT a.id as aid, a.subject, a.predicate, a.object as a_object,
           a.source_node_id as a_source, b.id as bid, b.object as b_object,
           b.source_node_id as b_source
    FROM engram_assertions a
    JOIN engram_assertions b
      ON a.subject = b.subject
     AND a.predicate = b.predicate
     AND a.id < b.id
     AND a.status = 'current'
     AND b.status = 'current'
    WHERE a.object != b.object
      AND a.owner_principal_id = current_principal_id()
      AND b.owner_principal_id = current_principal_id()
      AND (a.valid_to IS NULL OR a.valid_to > datetime('now'))
      AND (b.valid_to IS NULL OR b.valid_to > datetime('now'))
  `).all() as Array<{
    aid: string; subject: string; predicate: string;
    a_object: string; a_source: string; bid: string; b_object: string; b_source: string;
  }>;

  const cases: EngramContradictionCase[] = [];
  const now = new Date().toISOString();

  for (const pair of pairs) {
    if (!sourceAllowed(pair.a_source) || !sourceAllowed(pair.b_source)) continue;
    // Check if case already exists for this pair
    const existing = db.prepare(`
      SELECT id FROM engram_contradiction_cases
      WHERE ((assertion_a_id = ? AND assertion_b_id = ?)
          OR (assertion_a_id = ? AND assertion_b_id = ?))
        AND owner_principal_id = current_principal_id()
        AND status = 'open'
    `).get(pair.aid, pair.bid, pair.bid, pair.aid);

    if (existing) continue; // Already detected, don't duplicate

    const id = `cc_${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`
      INSERT INTO records_engram_contradiction_cases
        (tenant_id, owner_principal_id, id, subject, predicate, assertion_a_id,
         assertion_b_id, status, detected_at)
      VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?, ?, 'open', ?)
    `).run(id, pair.subject, pair.predicate, pair.aid, pair.bid, now);

    cases.push({
      tenant_id: currentContextValue(db, 'current_tenant_id'),
      owner_principal_id: currentContextValue(db, 'current_principal_id'),
      id,
      subject: pair.subject,
      predicate: pair.predicate,
      assertion_a_id: pair.aid,
      assertion_b_id: pair.bid,
      status: 'open',
      detected_at: now,
      resolved_at: null,
      resolution_type: null,
      evidence_note: null,
      source_node_id: null,
    });
  }

  return cases;
}

export function resolveContradiction(
  db: Database.Database,
  caseId: string,
  resolution: {
    resolution_type: 'supersede' | 'retract_old' | 'merge' | 'downgrade_confidence';
    winning_assertion_id: string;    // the one that stays current
    losing_assertion_id: string;     // the one that gets retracted/superseded
    evidence_note: string;
    source_node_id?: string;
  }
): void {
  const now = new Date().toISOString();

  // Update the contradiction case
  db.prepare(`
    UPDATE records_engram_contradiction_cases
    SET status = 'resolved',
        resolved_at = ?,
        resolution_type = ?,
        evidence_note = ?,
        source_node_id = COALESCE(?, source_node_id)
    WHERE tenant_id = current_tenant_id()
      AND owner_principal_id = current_principal_id()
      AND id = ?
  `).run(
    now,
    resolution.resolution_type,
    resolution.evidence_note,
    resolution.source_node_id ?? null,
    caseId,
  );

  // Handle the losing assertion based on resolution type
  if (resolution.resolution_type === 'supersede') {
    updateAssertionStatus(db, resolution.losing_assertion_id, 'historical', resolution.winning_assertion_id);
  } else if (resolution.resolution_type === 'retract_old') {
    updateAssertionStatus(db, resolution.losing_assertion_id, 'retracted');
  } else if (resolution.resolution_type === 'downgrade_confidence') {
    updateAssertionConfidence(db, resolution.losing_assertion_id, 0.3);
  }
  // 'merge' — both remain current; no direct DB action needed
}

export function getOpenContradictions(
  db: Database.Database
): EngramContradictionCase[] {
  return db.prepare(
    "SELECT * FROM engram_contradiction_cases WHERE status = 'open' ORDER BY detected_at DESC"
  ).all() as EngramContradictionCase[];
}

export function countContradictions(
  db: Database.Database,
  status?: ContradictionStatus
): number {
  if (status) {
    const row = db.prepare(
      'SELECT COUNT(*) as c FROM engram_contradiction_cases WHERE status = ?'
    ).get(status) as { c: number };
    return row.c;
  }
  const row = db.prepare('SELECT COUNT(*) as c FROM engram_contradiction_cases').get() as { c: number };
  return row.c;
}

function currentContextValue(db: Database.Database, fn: string): string {
  return (db.prepare(`SELECT ${fn}() AS value`).get() as { value: string }).value;
}
