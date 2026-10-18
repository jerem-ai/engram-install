import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// Contract: transcript-history staging and search
// - Stages allowlisted Codex and Claude user-visible messages into an isolated SQLite database.
// - Logical transcript identity is stable across capture revisions.
// - Unknown provider events, rewrites, truncations, and resource ceilings fail closed.
// - Search is deterministic, cursor-bound to one index revision, and always historical_untrusted.
// - Tombstones suppress owned derived rows across search-index rebuilds.

export interface HistorySource {
  provider: 'codex' | 'claude';
  runtime: string;
  path: string;
  receiptPath?: string;
  receiptMtimeMs?: number;
  receiptInventoryFingerprint?: string;
  sourceKind?: 'local' | 'nas_archive';
  project?: string;
  expectedSessionId?: string;
}

export interface HistoryLimits {
  maxInputBytes: number;
  maxSourceBytes: number;
  maxOutputBytes: number;
  maxRows: number;
  maxPayloadBytes: number;
  maxRuntimeMs: number;
  maxErrors: number;
  batchSize: number;
}

export interface StageOptions {
  dbPath: string;
  sources: HistorySource[];
  conductorDbPath?: string;
  limits: HistoryLimits;
  runId?: string;
}

export interface StageResult {
  status: 'completed' | 'stopped';
  stopReason: string | null;
  insertedTranscripts: number;
  insertedEvents: number;
  captureRevisions: number;
  unchangedSources: number;
  skippedSources: number;
  errorCount: number;
  lastCommittedSource: string | null;
  metrics: {
    durationMs: number;
    inputBytes: number;
    outputBytes: number;
    cpuUserMicros: number;
    cpuSystemMicros: number;
    peakRssBytes: number;
    peakSourceBufferBytes: number;
    maxRecordBytes: number;
    tempDiskBytes: number;
    indexReadLatencyMs: number;
    sourceCount: number;
  };
}

export interface HistorySearchInput {
  query: string;
  runtime?: string;
  project?: string;
  from?: string;
  to?: string;
  include_children?: boolean;
  limit?: number;
  cursor?: string;
}

export interface HistorySearchResult {
  results: Array<Record<string, unknown>>;
  next_cursor: string | null;
  authority: 'historical_untrusted';
}

export interface HistoryStats {
  transcripts: number;
  events: number;
  captures: number;
  tombstones: number;
  unmatched: number;
  runs: number;
}

export interface HistoryInventoryInput {
  codexRoots?: string[];
  claudeRoots?: string[];
  conductorDbPath?: string;
  archiveManifestPath?: string;
  projectionRoots?: string[];
  maxFilesPerProvider?: number;
}

export interface HistoryInventory {
  sources: HistorySource[];
  reconciliation: HistoryInventoryLedgerRow[];
  categories: Record<string, {
    status: 'available' | 'unavailable';
    count: number;
    bytes: number;
    detail?: string;
  }>;
  capturedAt: string;
}

export interface HistoryInventoryLedgerRow {
  sourcePath: string;
  provider: string;
  providerSessionId?: string;
  sourceKind: string;
  reason: string;
}

interface ParsedEvent {
  eventId: string;
  providerEventId: string | null;
  timestamp: string;
  actor: 'user' | 'assistant';
  contentClass: string;
  text: string;
  rawHash: string;
  redactionLabels: string[];
}

interface ParsedTranscript {
  transcriptId: string;
  providerSessionId: string;
  parentTranscriptId: string | null;
  project: string | null;
  startedAt: string | null;
  endedAt: string | null;
  events: ParsedEvent[];
  conflictingEventIds: number;
}

// 32 MiB admits the 17.7 MB and 19.3 MB Codex tool-output lines the 2026-09-23 survey found,
// with headroom. One record is the most the streaming reader ever buffers.
export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
// Stop reasons that leave a terminal blocked receipt and prior state unchanged. Runners record
// them and continue; every other stop is a failure.
export const BLOCKING_STOP_REASONS: ReadonlySet<string> = new Set([
  'rewrite', 'truncation', 'conflicting_event_id',
]);
export const WORKFLOW_JOURNAL_REASON = 'non_transcript_workflow_journal';

// Claude workflow journals (keys agentId, key, type; no sessionId) are orchestration ledgers.
// The agent transcripts beside them are ordinary sources.
export function isClaudeWorkflowJournal(path: string): boolean {
  return /(^|\/)subagents\/workflows\/[^/]+\/journal\.jsonl$/.test(path);
}

const CODEX_METADATA_TYPES = new Set([
  'session_meta', 'event_msg', 'world_state', 'turn_context',
  'inter_agent_communication_metadata', 'token_usage_record', 'compacted',
]);
const CODEX_IGNORED_BLOCKS = new Set(['input_image']);
const CLAUDE_METADATA_TYPES = new Set([
  'queue-operation', 'attachment', 'atis-latch', 'ai-title', 'bridge-session', 'custom-title',
  'agent-name', 'artifact-autoreact-ledger', 'artifact-comment-monitor',
  'cost-state', 'file-history-delta', 'file-history-snapshot', 'frame-link',
  'last-prompt', 'mode', 'permission-mode', 'pr-link', 'system',
]);
const CLAUDE_IGNORED_BLOCKS = new Set([
  'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'document',
  'server_tool_use', 'web_search_tool_result',
]);
const SOURCE_READ_CHUNK_BYTES = 64 * 1024;

export function loadArchiveManifest(path: string): HistorySource[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { records?: Array<Record<string, unknown>> };
  if (!Array.isArray(parsed.records)) throw new Error('Archive manifest must contain records[]');
  return parsed.records.map((record, index) => {
    const provider = record.provider;
    const runtime = record.runtime;
    const localPath = record.local_path;
    const providerSessionId = record.provider_session_id;
    const receiptPath = record.receipt_path;
    if ((provider !== 'codex' && provider !== 'claude')
      || typeof runtime !== 'string'
      || typeof localPath !== 'string'
      || (providerSessionId !== undefined && typeof providerSessionId !== 'string')
      || (receiptPath !== undefined && typeof receiptPath !== 'string')) {
      throw new Error(`Invalid archive record at index ${index}`);
    }
    return {
      provider,
      runtime,
      path: localPath,
      receiptPath,
      sourceKind: 'nas_archive',
      expectedSessionId: providerSessionId,
      project: typeof record.project === 'string' ? record.project : undefined,
    };
  });
}

export function inventoryHistorySources(input: HistoryInventoryInput): HistoryInventory {
  const maxFiles = input.maxFilesPerProvider ?? 25;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) {
    throw new Error('maxFilesPerProvider must be an integer from 1 to 10000');
  }
  const categories: HistoryInventory['categories'] = {};
  const reconciliation: HistoryInventoryLedgerRow[] = [];
  const localCodex = inventoryLocalRoots(input.codexRoots ?? [], 'codex', 'codex', maxFiles);
  const localClaude = inventoryLocalRoots(input.claudeRoots ?? [], 'claude', 'claude', maxFiles);
  categories.local_codex = localCodex.category;
  categories.local_claude = localClaude.category;
  categories.local_claude_non_transcript = {
    status: localClaude.category.status,
    count: localClaude.nonTranscript.length,
    bytes: localClaude.nonTranscript.reduce((sum, path) => sum + safeSize(path), 0),
    detail: WORKFLOW_JOURNAL_REASON,
  };
  reconciliation.push(...localClaude.nonTranscript.map(path => ({
    sourcePath: path,
    provider: 'claude',
    sourceKind: 'local',
    reason: WORKFLOW_JOURNAL_REASON,
  })));

  let archiveSources: HistorySource[] = [];
  if (input.archiveManifestPath && existsSync(input.archiveManifestPath)) {
    archiveSources = loadArchiveManifest(input.archiveManifestPath);
    categories.nas_archive = {
      status: 'available',
      count: archiveSources.length,
      bytes: archiveSources.reduce((sum, source) => sum + safeSize(source.path), 0),
      detail: input.archiveManifestPath,
    };
  } else {
    categories.nas_archive = {
      status: 'unavailable', count: 0, bytes: 0,
      detail: input.archiveManifestPath ?? 'archive manifest not configured',
    };
  }

  if (input.conductorDbPath && existsSync(input.conductorDbPath)) {
    const conductor = new Database(input.conductorDbPath, { readonly: true });
    try {
      const count = (conductor.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
      categories.conductor = {
        status: 'available', count, bytes: safeSize(input.conductorDbPath), detail: input.conductorDbPath,
      };
    } finally {
      conductor.close();
    }
  } else {
    categories.conductor = {
      status: 'unavailable', count: 0, bytes: 0,
      detail: input.conductorDbPath ?? 'Conductor database not configured',
    };
  }

  const projectionRoots = (input.projectionRoots ?? []).filter(existsSync);
  if (projectionRoots.length > 0) {
    const projectionFiles = projectionRoots.flatMap(root => listFiles(root, '.md'))
      .filter(path => /\/(Transcripts|Digests|Sessions|Conversations)\//.test(path))
      .sort((left, right) => left.localeCompare(right));
    reconciliation.push(...projectionFiles.map(path => ({
      sourcePath: path,
      provider: 'projection',
      sourceKind: 'projection',
      reason: 'projection_reconciliation_only',
    })));
    categories.projections = {
      status: 'available',
      count: projectionFiles.length,
      bytes: projectionFiles.reduce((sum, path) => sum + safeSize(path), 0),
      detail: projectionRoots.join(','),
    };
  } else {
    categories.projections = {
      status: 'unavailable', count: 0, bytes: 0,
      detail: (input.projectionRoots ?? []).join(',') || 'projection root not configured',
    };
  }

  return {
    sources: [...localCodex.sources, ...localClaude.sources, ...archiveSources],
    reconciliation,
    categories,
    capturedAt: new Date().toISOString(),
  };
}

export function writeHistoryRunArtifacts(
  outputDir: string,
  inventory: HistoryInventory,
  result: StageResult,
  limits: HistoryLimits,
): { capacityPath: string; runManifestPath: string } {
  mkdirSync(outputDir, { recursive: true });
  const capacityPath = join(outputDir, 'capacity.json');
  const runManifestPath = join(outputDir, 'run-manifest.json');
  writeFileSync(capacityPath, `${JSON.stringify({
    schema: 'engram-history-capacity.v1',
    measured_at: new Date().toISOString(),
    measured: {
      input_bytes: result.metrics.inputBytes,
      output_bytes: result.metrics.outputBytes,
      duration_ms: result.metrics.durationMs,
      cpu_user_micros: result.metrics.cpuUserMicros,
      cpu_system_micros: result.metrics.cpuSystemMicros,
      peak_rss_bytes: result.metrics.peakRssBytes,
      peak_source_buffer_bytes: result.metrics.peakSourceBufferBytes,
      temp_disk_bytes: result.metrics.tempDiskBytes,
      index_read_latency_ms: result.metrics.indexReadLatencyMs,
      throughput_bytes_per_second: Math.round(
        result.metrics.inputBytes / Math.max(result.metrics.durationMs / 1000, 0.001),
      ),
      source_count: result.metrics.sourceCount,
      inserted_transcripts: result.insertedTranscripts,
      inserted_events: result.insertedEvents,
    },
    enforced_ceilings: {
      max_input_bytes: limits.maxInputBytes,
      max_source_bytes: limits.maxSourceBytes,
      max_output_bytes: limits.maxOutputBytes,
      max_rows: limits.maxRows,
      max_payload_bytes: limits.maxPayloadBytes,
      max_runtime_ms: limits.maxRuntimeMs,
      max_errors: limits.maxErrors,
      batch_size: limits.batchSize,
    },
    derived_next_run_ceilings: {
      formula: 'measured_plus_25_percent_headroom',
      runtime_formula: 'measured_plus_50_percent_with_10_second_floor',
      max_input_bytes: withHeadroom(result.metrics.inputBytes),
      max_source_bytes: limits.maxSourceBytes,
      max_output_bytes: withHeadroom(result.metrics.outputBytes),
      max_rows: withHeadroom(result.insertedTranscripts + result.insertedEvents),
      max_runtime_ms: runtimeWithHeadroom(result.metrics.durationMs),
      max_payload_bytes: limits.maxPayloadBytes,
      max_errors: 0,
      batch_size: Math.max(1, Math.min(result.metrics.sourceCount, limits.batchSize)),
    },
  }, null, 2)}\n`);
  writeFileSync(runManifestPath, `${JSON.stringify({
    schema: 'engram-history-run.v1',
    status: result.status,
    stop_reason: result.stopReason,
    source_inventory: inventory.categories,
    source_count: inventory.sources.length,
    inserted_transcripts: result.insertedTranscripts,
    inserted_events: result.insertedEvents,
    capture_revisions: result.captureRevisions,
    unchanged_sources: result.unchangedSources,
    skipped_sources: result.skippedSources,
    error_count: result.errorCount,
    checkpoint: { last_committed_source: result.lastCommittedSource },
    digest_pipeline: {
      acceptance_dependency: 'decoupled',
      reason: 'Transcript staging reads provider logs and projection metadata directly; it does not call the Engram digest generator.',
    },
    authority: 'historical_untrusted',
    completed_at: new Date().toISOString(),
  }, null, 2)}\n`);
  return { capacityPath, runManifestPath };
}

export function stageTranscriptSources(options: StageOptions): StageResult {
  validateLimits(options.limits);
  const db = openHistoryDb(options.dbPath);
  const started = Date.now();
  const cpuStarted = process.cpuUsage();
  let inputBytes = 0;
  let insertedTranscripts = 0;
  let insertedEvents = 0;
  let captureRevisions = 0;
  let unchangedSources = 0;
  let skippedSources = 0;
  let errorCount = 0;
  let lastCommittedSource: string | null = null;
  let status: StageResult['status'] = 'completed';
  let stopReason: string | null = null;
  let changed = false;
  let processedSources = 0;
  let peakTempDiskBytes = 0;
  let peakSourceBufferBytes = 0;
  let maxRecordBytes = 0;

  try {
    for (const source of options.sources) {
      const sourceReceipt = source.receiptPath ?? source.path;
      if (processedSources >= options.limits.batchSize) {
        status = 'stopped';
        stopReason = 'batch_size';
        break;
      }
      processedSources += 1;
      if (Date.now() - started >= options.limits.maxRuntimeMs) {
        status = 'stopped';
        stopReason = 'max_runtime_ms';
        break;
      }
      if (!existsSync(source.path)) {
        ({ status, stopReason, errorCount } = recordStageError(
          db, source, 'missing_source', errorCount, options.limits.maxErrors,
        ));
        changed = true;
        if (status === 'stopped') break;
        continue;
      }
      const sourceBytes = safeSize(source.path);
      if (sourceBytes > options.limits.maxSourceBytes) {
        recordStageSkip(db, source, 'excluded_max_source_bytes');
        skippedSources += 1;
        changed = true;
        continue;
      }
      if (inputBytes + sourceBytes > options.limits.maxInputBytes) {
        status = 'stopped';
        stopReason = 'max_input_bytes';
        break;
      }
      inputBytes += sourceBytes;
      const sourceRead = tryParseSource(source, sourceBytes, options.limits.maxPayloadBytes);
      peakSourceBufferBytes = Math.max(peakSourceBufferBytes, sourceRead.peakBufferBytes);
      maxRecordBytes = Math.max(maxRecordBytes, sourceRead.maxRecordBytes);
      if ('error' in sourceRead) {
        ({ status, stopReason, errorCount } = recordStageError(
          db, source, sourceRead.error, errorCount, options.limits.maxErrors,
        ));
        changed = true;
        if (status === 'stopped') break;
        continue;
      }
      const { hash, parsed } = sourceRead;

      const previous = db.prepare(`
        SELECT source_hash, size_bytes, source_path
        FROM history_captures
        WHERE transcript_id = ? AND status = 'accepted'
        ORDER BY capture_revision DESC LIMIT 1
      `).get(parsed.transcriptId) as {
        source_hash: string; size_bytes: number; source_path: string;
      } | undefined;

      if (previous?.source_hash === hash) {
        if (previous.source_path !== sourceReceipt || source.receiptInventoryFingerprint !== undefined) {
          const joined = conductorJoin(options.conductorDbPath, parsed.providerSessionId, source.provider);
          db.transaction(() => {
            insertCapture(
              db, parsed.transcriptId, sourceReceipt, hash, sourceBytes,
              'duplicate', 'accepted', source.path, source.receiptMtimeMs, source.receiptInventoryFingerprint,
            );
            // A duplicate receipt is finished, so it must not keep a seeded pending label.
            upsertSourceLedger(
              db, sourceReceipt, source, parsed.providerSessionId,
              joined.matched, joined.matched ? null : joined.reason,
            );
            bumpRevision(db);
          })();
          peakTempDiskBytes = Math.max(peakTempDiskBytes, auxiliaryDatabaseBytes(options.dbPath));
          captureRevisions += 1;
          changed = true;
          lastCommittedSource = sourceReceipt;
          if (previous.source_path === sourceReceipt) unchangedSources += 1;
        } else {
          unchangedSources += 1;
        }
        continue;
      }

      let captureKind: 'initial' | 'append' | 'rewrite' | 'truncation' = 'initial';
      if (previous) {
        if (sourceBytes < previous.size_bytes) {
          captureKind = 'truncation';
        } else {
          const prefixHash = hashFilePrefix(source.path, previous.size_bytes);
          captureKind = prefixHash === previous.source_hash ? 'append' : 'rewrite';
        }
      }
      let blockKind: 'rewrite' | 'truncation' | 'conflicting_event_id' | null = (
        captureKind === 'rewrite' || captureKind === 'truncation'
      ) ? captureKind : null;
      const newEvents: ParsedEvent[] = [];
      if (!blockKind) {
        // A stored event whose content differs from the source's copy is a conflict, like a
        // repeated ID inside the source: the first accepted copy stays, the capture is blocked.
        const stored = db.prepare(`
          SELECT actor, timestamp, content_class, normalized_text FROM history_events WHERE event_id = ?
        `);
        let conflicting = parsed.conflictingEventIds > 0;
        for (const event of parsed.events) {
          const row = stored.get(event.eventId) as StoredEventContent | undefined;
          if (!row) newEvents.push(event);
          else if (!sameStoredContent(row, event)) conflicting = true;
        }
        if (conflicting) blockKind = 'conflicting_event_id';
      }
      if (blockKind) {
        const kind = blockKind;
        db.transaction(() => {
          insertCapture(
            db, parsed.transcriptId, sourceReceipt, hash, sourceBytes,
            kind, 'blocked', source.path, source.receiptMtimeMs, source.receiptInventoryFingerprint,
          );
          upsertSourceLedger(
            db, sourceReceipt, source, parsed.providerSessionId,
            false, `blocked_${kind}`,
          );
          bumpRevision(db);
        })();
        peakTempDiskBytes = Math.max(peakTempDiskBytes, auxiliaryDatabaseBytes(options.dbPath));
        captureRevisions += 1;
        changed = true;
        status = 'stopped';
        stopReason = kind;
        break;
      }

      const transcriptExists = !!db.prepare(
        'SELECT 1 FROM history_transcripts WHERE transcript_id = ?',
      ).get(parsed.transcriptId);
      const rowCost = (transcriptExists ? 0 : 1) + newEvents.length;
      const currentRows = countLogicalRows(db);
      if (currentRows + rowCost > options.limits.maxRows) {
        status = 'stopped';
        stopReason = 'max_rows';
        break;
      }

      const joined = conductorJoin(options.conductorDbPath, parsed.providerSessionId, source.provider);
      const project = joined.project ?? source.project ?? parsed.project;
      const transaction = db.transaction(() => {
        if (!transcriptExists) {
          db.prepare(`
            INSERT INTO history_transcripts (
              transcript_id, provider, runtime, provider_session_id,
              parent_transcript_id, branch_id, project, started_at, ended_at,
              source_kind, inclusion_decision, created_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'included', ?)
          `).run(
            parsed.transcriptId, source.provider, source.runtime, parsed.providerSessionId,
            parsed.parentTranscriptId, project, parsed.startedAt, parsed.endedAt,
            source.sourceKind ?? 'local', new Date().toISOString(),
          );
        } else if (project) {
          db.prepare('UPDATE history_transcripts SET project = COALESCE(project, ?) WHERE transcript_id = ?')
            .run(project, parsed.transcriptId);
        }
        for (const event of newEvents) insertEvent(db, parsed.transcriptId, event);
        insertCapture(
          db, parsed.transcriptId, sourceReceipt, hash, sourceBytes,
          captureKind, 'accepted', source.path, source.receiptMtimeMs, source.receiptInventoryFingerprint,
        );
        upsertSourceLedger(
          db, sourceReceipt, source, parsed.providerSessionId,
          joined.matched, joined.matched ? null : joined.reason,
        );
        bumpRevision(db);
        peakTempDiskBytes = Math.max(peakTempDiskBytes, auxiliaryDatabaseBytes(options.dbPath));
        const outputBytes = databaseBytes(db) + peakTempDiskBytes;
        if (outputBytes > options.limits.maxOutputBytes) throw new CeilingError('max_output_bytes');
      });

      try {
        transaction();
      } catch (error) {
        if (error instanceof CeilingError) {
          status = 'stopped';
          stopReason = error.message;
          break;
        }
        throw error;
      }
      insertedTranscripts += transcriptExists ? 0 : 1;
      insertedEvents += newEvents.length;
      captureRevisions += 1;
      changed = true;
      lastCommittedSource = sourceReceipt;
      peakTempDiskBytes = Math.max(peakTempDiskBytes, auxiliaryDatabaseBytes(options.dbPath));
    }

    if (changed) {
      db.prepare(`
        INSERT INTO history_runs (
          run_id, status, stop_reason, input_bytes, output_bytes,
          inserted_transcripts, inserted_events, capture_revisions,
          error_count, last_committed_source, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${options.runId ?? 'history-run'}:${randomUUID()}`,
        status, stopReason, inputBytes, databaseBytes(db),
        insertedTranscripts, insertedEvents, captureRevisions,
        errorCount, lastCommittedSource,
        new Date(started).toISOString(), new Date().toISOString(),
      );
    }
    const durationMs = Date.now() - started;
    const cpu = process.cpuUsage(cpuStarted);
    const indexReadStarted = performance.now();
    db.prepare('SELECT COUNT(*) AS count FROM history_fts').get();
    const indexReadLatencyMs = performance.now() - indexReadStarted;
    return {
      status, stopReason, insertedTranscripts, insertedEvents, captureRevisions,
      unchangedSources, skippedSources, errorCount, lastCommittedSource,
      metrics: {
        durationMs,
        inputBytes,
        outputBytes: databaseBytes(db) + auxiliaryDatabaseBytes(options.dbPath),
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        peakRssBytes: Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024),
        peakSourceBufferBytes,
        maxRecordBytes,
        tempDiskBytes: peakTempDiskBytes,
        indexReadLatencyMs,
        sourceCount: processedSources,
      },
    };
  } finally {
    db.close();
  }
}

export function searchTranscriptHistory(
  dbPath: string,
  input: HistorySearchInput,
): HistorySearchResult {
  if (!existsSync(dbPath)) throw new Error('Transcript history index is unavailable');
  const db = new Database(dbPath, { readonly: true });
  try {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be an integer from 1 to 100');
    }
    const query = ftsQuery(input.query);
    const revision = currentRevision(db);
    const cursorKey = sha256(JSON.stringify({
      query, runtime: input.runtime ?? null, project: input.project ?? null,
      from: input.from ?? null, to: input.to ?? null,
      include_children: input.include_children ?? false, limit,
    }));
    let offset = 0;
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor.revision !== revision) throw new Error('Stale cursor: history index revision changed');
      if (cursor.key !== cursorKey) throw new Error('Cursor does not match this query');
      offset = cursor.offset;
    }

    const clauses = [
      'history_fts MATCH ?',
      'ts.transcript_id IS NULL',
    ];
    const params: unknown[] = [query];
    if (!(input.include_children ?? false)) clauses.push('t.parent_transcript_id IS NULL');
    if (input.runtime) { clauses.push('t.runtime = ?'); params.push(input.runtime); }
    if (input.project) { clauses.push('t.project = ?'); params.push(input.project); }
    if (input.from) { clauses.push('e.timestamp >= ?'); params.push(input.from); }
    if (input.to) { clauses.push('e.timestamp <= ?'); params.push(input.to); }
    params.push(limit + 1, offset);

    const rows = db.prepare(`
      SELECT
        e.event_id, e.transcript_id, e.provider_event_id, e.timestamp,
        e.actor, e.normalized_text, e.redaction_labels,
        t.provider, t.runtime, t.provider_session_id, t.project,
        t.parent_transcript_id, t.branch_id, t.source_kind,
        (SELECT MAX(capture_revision) FROM history_captures c
          WHERE c.transcript_id = t.transcript_id AND c.status = 'accepted') AS source_revision,
        bm25(history_fts) AS rank
      FROM history_fts
      JOIN history_events e ON e.event_id = history_fts.event_id
      JOIN history_transcripts t ON t.transcript_id = e.transcript_id
      LEFT JOIN history_tombstones ts ON ts.transcript_id = t.transcript_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY rank ASC, e.timestamp DESC, e.event_id ASC
      LIMIT ? OFFSET ?
    `).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(row => ({
      transcript_id: row.transcript_id,
      event_id: row.event_id,
      provider: row.provider,
      provider_session_id: row.provider_session_id,
      timestamp: row.timestamp,
      snippet: boundedSnippet(String(row.normalized_text), input.query),
      project: row.project,
      runtime: row.runtime,
      parent_transcript_id: row.parent_transcript_id,
      branch_id: row.branch_id,
      delegated_child: row.parent_transcript_id !== null,
      source_revision: row.source_revision,
      source_kind: row.source_kind,
      redaction_labels: JSON.parse(String(row.redaction_labels)) as string[],
      authority: 'historical_untrusted' as const,
    }));
    return {
      results: page,
      next_cursor: hasMore ? encodeCursor({ revision, key: cursorKey, offset: offset + limit }) : null,
      authority: 'historical_untrusted',
    };
  } finally {
    db.close();
  }
}

export function historyStats(dbPath: string): HistoryStats {
  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return {
      transcripts: count('history_transcripts'),
      events: count('history_events'),
      captures: count('history_captures'),
      tombstones: count('history_tombstones'),
      unmatched: (db.prepare("SELECT COUNT(*) AS count FROM history_source_ledger WHERE reason = 'no_exact_conductor_join'").get() as { count: number }).count,
      runs: count('history_runs'),
    };
  } finally {
    db.close();
  }
}

export function getCaptureKinds(dbPath: string, transcriptId: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`
      SELECT capture_kind FROM history_captures
      WHERE transcript_id = ? ORDER BY capture_revision
    `).all(transcriptId) as Array<{ capture_kind: string }>).map(row => row.capture_kind);
  } finally {
    db.close();
  }
}

export function listUnmatchedSources(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT source_path, provider, provider_session_id, source_kind, reason
      FROM history_source_ledger WHERE reason = 'no_exact_conductor_join'
      ORDER BY provider, provider_session_id, source_path
    `).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

export function listSourceLedger(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT source_path, provider, provider_session_id, source_kind,
             conductor_matched, reason, updated_at
      FROM history_source_ledger
      ORDER BY provider, provider_session_id, source_path
    `).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

export function ensureHistoryInventoryLedger(
  dbPath: string,
  inventoryReceipt: string,
  rows: HistoryInventoryLedgerRow[],
  maxOutputBytes: number,
): number {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('maxOutputBytes must be a positive integer');
  }
  const db = openHistoryDb(dbPath);
  const marker = `inventory_receipt:${sha256(inventoryReceipt)}`;
  try {
    if (db.prepare('SELECT 1 FROM history_meta WHERE key = ?').get(marker)) return 0;
    let inserted = 0;
    db.transaction(() => {
      const statement = db.prepare(`
        INSERT OR IGNORE INTO history_source_ledger (
          source_path, provider, provider_session_id, source_kind,
          conductor_matched, reason, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
      `);
      for (const row of rows) {
        inserted += statement.run(
          row.sourcePath, row.provider, row.providerSessionId ?? null,
          row.sourceKind, row.reason, new Date().toISOString(),
        ).changes;
      }
      db.prepare('INSERT INTO history_meta (key, value) VALUES (?, ?)')
        .run(marker, new Date().toISOString());
      if (databaseBytes(db) + auxiliaryDatabaseBytes(dbPath) > maxOutputBytes) {
        throw new CeilingError('max_output_bytes');
      }
    })();
    return inserted;
  } finally {
    db.close();
  }
}

export function listAcceptedSourceReceipts(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`
      SELECT DISTINCT source_path FROM history_captures
      WHERE status = 'accepted'
      ORDER BY source_path
    `).all() as Array<{ source_path: string }>).map(row => row.source_path);
  } finally {
    db.close();
  }
}

export function listProcessedSourceReceipts(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`
      SELECT DISTINCT source_path FROM history_captures
      WHERE status IN ('accepted', 'blocked')
      ORDER BY source_path
    `).all() as Array<{ source_path: string }>).map(row => row.source_path);
  } finally {
    db.close();
  }
}

export function listBlockedSourceReceipts(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`
      SELECT DISTINCT source_path FROM history_captures
      WHERE status = 'blocked'
      ORDER BY source_path
    `).all() as Array<{ source_path: string }>).map(row => row.source_path);
  } finally {
    db.close();
  }
}

export interface SourceReceiptState {
  source_path: string;
  status: 'accepted' | 'blocked';
  size_bytes: number;
  mtime_ms: number | null;
  inventory_fingerprint: string | null;
}

export function listSourceReceiptStates(dbPath: string): SourceReceiptState[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT c.source_path, c.status, c.size_bytes, c.mtime_ms,
        m.value AS inventory_fingerprint
      FROM history_captures c
      LEFT JOIN history_meta m ON m.key = 'archive_inventory:' || c.id
      JOIN (
        SELECT source_path, MAX(id) AS id
        FROM history_captures
        WHERE status IN ('accepted', 'blocked')
        GROUP BY source_path
      ) latest ON latest.id = c.id
      ORDER BY c.source_path
    `).all() as SourceReceiptState[];
  } finally {
    db.close();
  }
}

// A NAS receipt whose storage moved (raw to .zst, or into a bundle) is pending again because its
// inventory fingerprint changed. When the materialized bytes equal the receipt's own latest
// accepted capture, this records the new evidence as a duplicate without parsing and returns true.
// A parse would compare the old copy against a transcript another receipt may have advanced since,
// and block it as a truncation. Returns false, writing nothing, when the bytes differ.
export function recordIdenticalArchiveReceipt(dbPath: string, input: {
  receiptPath: string;
  path: string;
  receiptMtimeMs: number;
  inventoryFingerprint: string;
}): boolean {
  if (!existsSync(dbPath)) return false;
  const db = openHistoryDb(dbPath);
  try {
    const latest = db.prepare(`
      SELECT transcript_id, source_hash, size_bytes, status FROM history_captures
      WHERE source_path = ? AND status IN ('accepted', 'blocked')
      ORDER BY id DESC LIMIT 1
    `).get(input.receiptPath) as {
      transcript_id: string; source_hash: string; size_bytes: number; status: string;
    } | undefined;
    const sizeBytes = safeSize(input.path);
    if (latest?.status !== 'accepted' || latest.size_bytes !== sizeBytes) return false;
    if (hashFilePrefix(input.path, sizeBytes) !== latest.source_hash) return false;
    db.transaction(() => {
      insertCapture(
        db, latest.transcript_id, input.receiptPath, latest.source_hash, sizeBytes,
        'duplicate', 'accepted', input.path, input.receiptMtimeMs, input.inventoryFingerprint,
      );
      bumpRevision(db);
    })();
    return true;
  } finally {
    db.close();
  }
}

// An archive source whose materialized bytes cross maxSourceBytes is never parsed. This records a
// terminal blocked capture under its own placeholder transcript id, with ledger reason
// blocked_oversized_source, so later runs skip it until its inventory fingerprint changes and one
// oversized file no longer stops every source after it. Nothing from the file is staged.
export const OVERSIZED_SOURCE_REASON = 'oversized_source';
export function recordOversizedSourceReceipt(dbPath: string, input: {
  receiptPath: string;
  provider: HistorySource['provider'];
  runtime: string;
  sizeBytes: number;
  receiptMtimeMs: number;
  inventoryFingerprint: string;
}): void {
  const db = openHistoryDb(dbPath);
  try {
    db.transaction(() => {
      insertCapture(
        db, `oversized:${input.receiptPath}`, input.receiptPath, OVERSIZED_SOURCE_REASON,
        input.sizeBytes, OVERSIZED_SOURCE_REASON, 'blocked', input.receiptPath,
        input.receiptMtimeMs, input.inventoryFingerprint,
      );
      upsertSourceLedger(db, input.receiptPath, {
        provider: input.provider, runtime: input.runtime, path: input.receiptPath, sourceKind: 'nas_archive',
      }, null, false, `blocked_${OVERSIZED_SOURCE_REASON}`);
      bumpRevision(db);
    })();
  } finally {
    db.close();
  }
}

export function tombstoneTranscript(dbPath: string, transcriptId: string, reason: string): void {
  const db = openHistoryDb(dbPath);
  try {
    db.transaction(() => {
      const inserted = db.prepare(`
        INSERT INTO history_tombstones (transcript_id, reason, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(transcript_id) DO NOTHING
      `).run(transcriptId, reason, new Date().toISOString()).changes;
      const removed = db.prepare('DELETE FROM history_fts WHERE transcript_id = ?')
        .run(transcriptId).changes;
      if (inserted || removed) bumpRevision(db);
    })();
  } finally {
    db.close();
  }
}

export function rebuildHistorySearch(dbPath: string): void {
  const db = openHistoryDb(dbPath);
  try {
    db.transaction(() => {
      db.exec('DELETE FROM history_fts');
      db.exec(`
        INSERT INTO history_fts (event_id, transcript_id, content)
        SELECT e.event_id, e.transcript_id, e.normalized_text
        FROM history_events e
        LEFT JOIN history_tombstones t ON t.transcript_id = e.transcript_id
        WHERE t.transcript_id IS NULL
      `);
    })();
  } finally {
    db.close();
  }
}

function openHistoryDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO history_meta (key, value) VALUES ('revision', '0');

    CREATE TABLE IF NOT EXISTS history_transcripts (
      transcript_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      runtime TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      parent_transcript_id TEXT,
      branch_id TEXT,
      project TEXT,
      started_at TEXT,
      ended_at TEXT,
      source_kind TEXT NOT NULL,
      inclusion_decision TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_events (
      event_id TEXT PRIMARY KEY,
      transcript_id TEXT NOT NULL REFERENCES history_transcripts(transcript_id),
      provider_event_id TEXT,
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      content_class TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      raw_hash TEXT NOT NULL,
      redaction_labels TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id TEXT NOT NULL,
      capture_revision INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms REAL,
      capture_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      UNIQUE(transcript_id, capture_revision)
    );
    CREATE INDEX IF NOT EXISTS history_captures_source_path_status_idx
      ON history_captures(source_path, status, id);
    CREATE TABLE IF NOT EXISTS history_source_ledger (
      source_path TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      source_kind TEXT NOT NULL,
      conductor_matched INTEGER NOT NULL,
      reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_tombstones (
      transcript_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      stop_reason TEXT,
      input_bytes INTEGER NOT NULL,
      output_bytes INTEGER NOT NULL,
      inserted_transcripts INTEGER NOT NULL,
      inserted_events INTEGER NOT NULL,
      capture_revisions INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      last_committed_source TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
      event_id UNINDEXED,
      transcript_id UNINDEXED,
      content,
      tokenize = 'unicode61'
    );
  `);
  return db;
}

function tryParseSource(
  source: HistorySource,
  expectedBytes: number,
  maxPayloadBytes: number,
): { parsed: ParsedTranscript; hash: string; peakBufferBytes: number; maxRecordBytes: number }
  | { error: string; peakBufferBytes: number; maxRecordBytes: number } {
  let peakBufferBytes = 0;
  let maxRecordBytes = 0;
  try {
    let codexMeta: Record<string, any> | undefined;
    let firstClaudeSession: Record<string, any> | undefined;
    let claudeSidechain = false;
    const claudeAgentIds = new Set<string>();
    const metadataScan = scanJsonl(source.path, maxPayloadBytes, row => {
      if (source.provider === 'codex') {
        if (!codexMeta && row.type === 'session_meta') codexMeta = row;
        return;
      }
      if (!firstClaudeSession && typeof row.sessionId === 'string') firstClaudeSession = row;
      if (row.isSidechain === true) claudeSidechain = true;
      if (typeof row.agentId === 'string' && row.agentId.length > 0) {
        claudeAgentIds.add(row.agentId);
      }
    });
    peakBufferBytes = metadataScan.peakBufferBytes;
    maxRecordBytes = metadataScan.maxRecordBytes;
    if (metadataScan.bytesRead !== expectedBytes) throw new Error('source_changed_during_read');

    let providerSessionId: string;
    let parentTranscriptId: string | null;
    let project: string | null;
    if (source.provider === 'codex') {
      providerSessionId = String(codexMeta?.payload?.id ?? codexMeta?.payload?.session_id ?? '');
      if (!providerSessionId) throw new Error('missing_provider_session_id');
      const parentId = typeof codexMeta?.payload?.parent_thread_id === 'string'
        ? String(codexMeta.payload.parent_thread_id) : null;
      parentTranscriptId = parentId
        ? logicalId(source.provider, source.runtime, parentId) : null;
      project = typeof codexMeta?.payload?.cwd === 'string'
        ? codexMeta.payload.cwd : source.project ?? null;
    } else {
      const parentSessionId = String(firstClaudeSession?.sessionId ?? '');
      if (!parentSessionId) throw new Error('missing_provider_session_id');
      if (claudeSidechain && claudeAgentIds.size !== 1) throw new Error('ambiguous_child_agent_id');
      providerSessionId = claudeSidechain ? [...claudeAgentIds][0] : parentSessionId;
      parentTranscriptId = claudeSidechain
        ? logicalId(source.provider, source.runtime, parentSessionId) : null;
      project = typeof firstClaudeSession?.cwd === 'string'
        ? firstClaudeSession.cwd : source.project ?? null;
    }

    const transcriptId = logicalId(source.provider, source.runtime, providerSessionId);
    const events: ParsedEvent[] = [];
    const seen = new Map<string, ParsedEvent>();
    let conflictingEventIds = 0;
    const eventScan = scanJsonl(source.path, maxPayloadBytes, row => {
      const event = source.provider === 'codex'
        ? parseCodexRow(row, transcriptId, parentTranscriptId !== null)
        : parseClaudeRow(row, transcriptId, claudeSidechain);
      if (!event) return;
      if (parentTranscriptId) {
        events[0] = event;
        return;
      }
      // Providers replay rows under the same ID. Identical stored content is kept once;
      // different content under one ID is a conflict the caller blocks.
      const first = seen.get(event.eventId);
      if (first) {
        if (!sameStoredContent(storedContentOf(first), event)) conflictingEventIds += 1;
        return;
      }
      seen.set(event.eventId, event);
      events.push(event);
    });
    peakBufferBytes = Math.max(peakBufferBytes, eventScan.peakBufferBytes);
    if (eventScan.bytesRead !== expectedBytes || eventScan.hash !== metadataScan.hash) {
      throw new Error('source_changed_during_read');
    }
    const parsed = finalizeParsed(
      transcriptId, providerSessionId, parentTranscriptId, project, events, conflictingEventIds,
    );
    if (source.expectedSessionId && source.expectedSessionId !== parsed.providerSessionId) {
      return { error: 'archive_session_id_mismatch', peakBufferBytes, maxRecordBytes };
    }
    return { parsed, hash: metadataScan.hash, peakBufferBytes, maxRecordBytes };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      peakBufferBytes,
      maxRecordBytes,
    };
  }
}

function parseCodexRow(
  row: Record<string, any>,
  transcriptId: string,
  child: boolean,
): ParsedEvent | null {
  if (CODEX_METADATA_TYPES.has(String(row.type))) return null;
  if (row.type !== 'response_item') throw new Error(`unknown_event_type:${String(row.type)}`);
  const payload = row.payload ?? {};
  if (payload.type !== 'message') return null;
  if (payload.role !== 'user' && payload.role !== 'assistant') return null;
  if (child && payload.role === 'user') return null;
  if (payload.role === 'assistant' && payload.phase && payload.phase !== 'final_answer') return null;
  if (!Array.isArray(payload.content)) throw new Error('unknown_message_content_shape');
  const texts: string[] = [];
  for (const block of payload.content) {
    if (block?.type === 'input_text' || block?.type === 'output_text') {
      if (typeof block.text === 'string') texts.push(block.text);
    } else if (!CODEX_IGNORED_BLOCKS.has(String(block?.type))) {
      throw new Error(`unknown_content_type:${String(block?.type)}`);
    }
  }
  const text = texts.join('\n').trim();
  if (!text) return null;
  return makeEvent(transcriptId, row, payload.id, payload.role, text, row.timestamp);
}

function parseClaudeRow(
  row: Record<string, any>,
  transcriptId: string,
  sidechain: boolean,
): ParsedEvent | null {
  if (CLAUDE_METADATA_TYPES.has(String(row.type))) return null;
  if (row.type !== 'user' && row.type !== 'assistant') {
    throw new Error(`unknown_event_type:${String(row.type)}`);
  }
  const actor = row.type as 'user' | 'assistant';
  if (sidechain && actor === 'user') return null;
  const content = row.message?.content;
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (CLAUDE_IGNORED_BLOCKS.has(String(block?.type))) continue;
      else throw new Error(`unknown_content_type:${String(block?.type)}`);
    }
  } else {
    throw new Error('unknown_message_content_shape');
  }
  const text = texts.join('\n').trim();
  if (!text) return null;
  return makeEvent(transcriptId, row, row.uuid, actor, text, row.timestamp);
}

function scanJsonl(
  path: string,
  maxPayloadBytes: number,
  visit: (row: Record<string, any>) => void,
): { bytesRead: number; hash: string; peakBufferBytes: number; maxRecordBytes: number } {
  const handle = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(SOURCE_READ_CHUNK_BYTES);
  const hasher = createHash('sha256');
  // A partial record is held as a list of copied chunks and joined once, when its newline
  // arrives. The held bytes never exceed one record plus one read chunk.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let bytesRead = 0;
  let lineNumber = 0;
  let rowCount = 0;
  let peakBufferBytes = 0;
  let maxRecordBytes = 0;

  const parseLine = (rawLine: Buffer) => {
    lineNumber += 1;
    const line = rawLine.at(-1) === 13 ? rawLine.subarray(0, -1) : rawLine;
    if (line.length === 0) return;
    if (line.length > maxPayloadBytes) throw new Error(`max_payload_bytes:line_${lineNumber}`);
    maxRecordBytes = Math.max(maxRecordBytes, line.length);
    let row: Record<string, any>;
    try { row = JSON.parse(line.toString('utf8')) as Record<string, any>; }
    catch { throw new Error(`malformed_jsonl:line_${lineNumber}`); }
    rowCount += 1;
    visit(row);
  };

  try {
    while (true) {
      const count = readSync(handle, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const bytes = chunk.subarray(0, count);
      bytesRead += count;
      hasher.update(bytes);
      peakBufferBytes = Math.max(peakBufferBytes, pendingBytes + count);
      let start = 0;
      let newline = bytes.indexOf(10, start);
      while (newline !== -1) {
        const piece = bytes.subarray(start, newline);
        if (pending.length > 0) {
          parseLine(Buffer.concat([...pending, piece], pendingBytes + piece.length));
          pending = [];
          pendingBytes = 0;
        } else {
          parseLine(piece);
        }
        start = newline + 1;
        newline = bytes.indexOf(10, start);
      }
      if (start < bytes.length) {
        pending.push(Buffer.from(bytes.subarray(start)));
        pendingBytes += bytes.length - start;
      }
      if (pendingBytes > maxPayloadBytes + 1) {
        throw new Error(`max_payload_bytes:line_${lineNumber + 1}`);
      }
    }
    if (pendingBytes > 0) parseLine(Buffer.concat(pending, pendingBytes));
    if (rowCount === 0) throw new Error('empty_source');
    return { bytesRead, hash: hasher.digest('hex'), peakBufferBytes, maxRecordBytes };
  } finally {
    closeSync(handle);
  }
}

function hashFilePrefix(path: string, length: number): string {
  const handle = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(Math.min(SOURCE_READ_CHUNK_BYTES, Math.max(length, 1)));
  const hasher = createHash('sha256');
  let remaining = length;
  try {
    while (remaining > 0) {
      const count = readSync(handle, chunk, 0, Math.min(chunk.length, remaining), null);
      if (count === 0) throw new Error('source_changed_during_read');
      hasher.update(chunk.subarray(0, count));
      remaining -= count;
    }
    return hasher.digest('hex');
  } finally {
    closeSync(handle);
  }
}

function finalizeParsed(
  transcriptId: string,
  providerSessionId: string,
  parentTranscriptId: string | null,
  project: string | null,
  events: ParsedEvent[],
  conflictingEventIds: number,
): ParsedTranscript {
  const timestamps = events.map(event => event.timestamp).filter(Boolean).sort();
  return {
    transcriptId, providerSessionId, parentTranscriptId, project,
    startedAt: timestamps[0] ?? null,
    endedAt: timestamps.at(-1) ?? null,
    events,
    conflictingEventIds,
  };
}

interface StoredEventContent {
  actor: string;
  timestamp: string;
  content_class: string;
  normalized_text: string;
}

function storedContentOf(event: ParsedEvent): StoredEventContent {
  return {
    actor: event.actor,
    timestamp: event.timestamp,
    content_class: event.contentClass,
    normalized_text: event.text,
  };
}

// Compares what the index would hold. Row metadata the index never stores (Claude's slug,
// parentUuid) does not make two copies different.
function sameStoredContent(stored: StoredEventContent, event: ParsedEvent): boolean {
  return stored.actor === event.actor
    && stored.timestamp === event.timestamp
    && stored.content_class === event.contentClass
    && stored.normalized_text === event.text;
}

function makeEvent(
  transcriptId: string,
  raw: Record<string, any>,
  providerEventId: unknown,
  actor: 'user' | 'assistant',
  text: string,
  timestamp: unknown,
): ParsedEvent {
  const redacted = redactSecrets(text);
  const rawHash = sha256(JSON.stringify(raw));
  const stableProviderId = typeof providerEventId === 'string' && providerEventId.length > 0
    ? providerEventId : rawHash;
  return {
    eventId: `${transcriptId}:${stableProviderId}`,
    providerEventId: typeof providerEventId === 'string' ? providerEventId : null,
    timestamp: typeof timestamp === 'string' ? timestamp : '0000-01-01T00:00:00Z',
    actor,
    contentClass: actor === 'user' ? 'user_visible' : 'assistant_final',
    text: redacted.text,
    rawHash,
    redactionLabels: redacted.labels,
  };
}

function redactSecrets(value: string): { text: string; labels: string[] } {
  let text = value;
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(api[_-]?key|access[_-]?token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi,
  ];
  let found = false;
  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      found = true;
      return '[REDACTED:secret]';
    });
  }
  return { text, labels: found ? ['secret'] : [] };
}

function insertEvent(db: Database.Database, transcriptId: string, event: ParsedEvent): void {
  db.prepare(`
    INSERT INTO history_events (
      event_id, transcript_id, provider_event_id, timestamp, actor,
      content_class, normalized_text, raw_hash, redaction_labels
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventId, transcriptId, event.providerEventId, event.timestamp, event.actor,
    event.contentClass, event.text, event.rawHash, JSON.stringify(event.redactionLabels),
  );
  db.prepare('INSERT INTO history_fts (event_id, transcript_id, content) VALUES (?, ?, ?)')
    .run(event.eventId, transcriptId, event.text);
}

function insertCapture(
  db: Database.Database,
  transcriptId: string,
  sourcePath: string,
  hash: string,
  size: number,
  kind: string,
  status: string,
  materializedPath = sourcePath,
  receiptMtimeMs?: number,
  receiptInventoryFingerprint?: string,
): void {
  // Evidence and its physical capture must commit or roll back together.
  db.transaction(() => {
    const revision = (db.prepare(`
      SELECT COALESCE(MAX(capture_revision), 0) + 1 AS revision
      FROM history_captures WHERE transcript_id = ?
    `).get(transcriptId) as { revision: number }).revision;
    const capture = db.prepare(`
      INSERT INTO history_captures (
        transcript_id, capture_revision, source_path, source_hash, size_bytes,
        mtime_ms, capture_kind, status, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transcriptId, revision, sourcePath, hash, size,
      receiptMtimeMs ?? (existsSync(materializedPath) ? statSync(materializedPath).mtimeMs : null),
      kind, status, new Date().toISOString(),
    );
    if (receiptInventoryFingerprint !== undefined) {
      db.prepare('INSERT INTO history_meta (key, value) VALUES (?, ?)').run(
        `archive_inventory:${capture.lastInsertRowid}`, receiptInventoryFingerprint,
      );
    }
  })();
}

function conductorJoin(
  dbPath: string | undefined,
  providerSessionId: string,
  provider: string,
): { matched: boolean; project: string | null; reason: string } {
  if (!dbPath || !existsSync(dbPath)) {
    return { matched: false, project: null, reason: 'conductor_not_configured' };
  }
  const conductor = new Database(dbPath, { readonly: true });
  try {
    for (const [table, required] of [
      ['sessions', ['id', 'claude_session_id', 'agent_type', 'workspace_id']],
      ['workspaces', ['local_id', 'workspace_name']],
    ] as const) {
      const columns = conductor.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (required.some(name => !columns.some(column => column.name === name))) {
        return { matched: false, project: null, reason: 'conductor_unsupported_schema' };
      }
    }
    const row = conductor.prepare(`
      SELECT w.workspace_name AS project
      FROM sessions s
      LEFT JOIN workspaces w ON w.local_id = s.workspace_id
      WHERE s.claude_session_id = ? AND lower(s.agent_type) = lower(?)
      ORDER BY s.id LIMIT 1
    `).get(providerSessionId, provider) as { project: string | null } | undefined;
    return row
      ? { matched: true, project: row.project, reason: '' }
      : { matched: false, project: null, reason: 'no_exact_conductor_join' };
  } finally {
    conductor.close();
  }
}

function recordStageSkip(db: Database.Database, source: HistorySource, reason: string): void {
  db.prepare(`
    INSERT INTO history_source_ledger (
      source_path, provider, provider_session_id, source_kind,
      conductor_matched, reason, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at
  `).run(
    source.receiptPath ?? source.path, source.provider, source.expectedSessionId ?? null,
    source.sourceKind ?? 'local', reason, new Date().toISOString(),
  );
}

function upsertSourceLedger(
  db: Database.Database,
  sourcePath: string,
  source: HistorySource,
  providerSessionId: string | null,
  conductorMatched: boolean,
  reason: string | null,
): void {
  db.prepare(`
    INSERT INTO history_source_ledger (
      source_path, provider, provider_session_id, source_kind,
      conductor_matched, reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      provider_session_id = excluded.provider_session_id,
      conductor_matched = excluded.conductor_matched,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `).run(
    sourcePath, source.provider, providerSessionId, source.sourceKind ?? 'local',
    conductorMatched ? 1 : 0, reason, new Date().toISOString(),
  );
}

function recordStageError(
  db: Database.Database,
  source: HistorySource,
  reason: string,
  currentErrors: number,
  maxErrors: number,
): { status: StageResult['status']; stopReason: string | null; errorCount: number } {
  db.prepare(`
    INSERT INTO history_source_ledger (
      source_path, provider, provider_session_id, source_kind,
      conductor_matched, reason, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at
  `).run(
    source.receiptPath ?? source.path, source.provider, source.expectedSessionId ?? null,
    source.sourceKind ?? 'local', reason, new Date().toISOString(),
  );
  const errorCount = currentErrors + 1;
  return errorCount > maxErrors
    ? { status: 'stopped', stopReason: reason, errorCount }
    : { status: 'completed', stopReason: null, errorCount };
}

function validateLimits(limits: HistoryLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid history limit ${key}`);
  }
  if (limits.batchSize < 1) throw new Error('batchSize must be positive');
}

function logicalId(provider: string, runtime: string, sessionId: string): string {
  return `${provider}:${runtime}:${sessionId}`;
}

function countLogicalRows(db: Database.Database): number {
  const transcripts = (db.prepare('SELECT COUNT(*) AS count FROM history_transcripts').get() as { count: number }).count;
  const events = (db.prepare('SELECT COUNT(*) AS count FROM history_events').get() as { count: number }).count;
  return transcripts + events;
}

function databaseBytes(db: Database.Database): number {
  const pages = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pages * pageSize;
}

function auxiliaryDatabaseBytes(path: string): number {
  return safeSize(`${path}-wal`) + safeSize(`${path}-shm`);
}

function currentRevision(db: Database.Database): number {
  return Number((db.prepare("SELECT value FROM history_meta WHERE key = 'revision'").get() as { value: string }).value);
}

function bumpRevision(db: Database.Database): void {
  db.prepare("UPDATE history_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
}

function ftsQuery(value: string): string {
  const tokens = value.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) throw new Error('query must contain searchable text');
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' ');
}

function boundedSnippet(text: string, query: string, maxLength = 480): string {
  if (text.length <= maxLength) return text;
  const firstToken = (query.normalize('NFKC').match(/[\p{L}\p{N}_]+/u) ?? [''])[0].toLowerCase();
  const position = text.toLowerCase().indexOf(firstToken);
  const start = Math.max(0, position < 0 ? 0 : position - Math.floor(maxLength / 2));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function encodeCursor(cursor: { revision: number; key: string; offset: number }): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string): { revision: number; key: string; offset: number } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!Number.isInteger(parsed.revision) || typeof parsed.key !== 'string'
      || !Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error('invalid fields');
    }
    return { revision: Number(parsed.revision), key: parsed.key, offset: Number(parsed.offset) };
  } catch {
    throw new Error('Invalid opaque cursor');
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

class CeilingError extends Error {}

function inventoryLocalRoots(
  roots: string[],
  provider: 'codex' | 'claude',
  runtime: string,
  maxFiles: number,
): { sources: HistorySource[]; nonTranscript: string[]; category: HistoryInventory['categories'][string] } {
  const availableRoots = roots.filter(existsSync);
  if (availableRoots.length === 0) {
    return {
      sources: [],
      nonTranscript: [],
      category: {
        status: 'unavailable', count: 0, bytes: 0,
        detail: roots.join(',') || `${provider} roots not configured`,
      },
    };
  }
  const all = availableRoots.flatMap(root => listFiles(root, '.jsonl'));
  const isJournal = (path: string) => provider === 'claude' && isClaudeWorkflowJournal(path);
  const paths = all.filter(path => !isJournal(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b))
    .slice(0, maxFiles);
  return {
    sources: paths.map(path => ({ provider, runtime, path, sourceKind: 'local' })),
    nonTranscript: all.filter(isJournal).sort((a, b) => a.localeCompare(b)),
    category: {
      status: 'available', count: paths.length,
      bytes: paths.reduce((sum, path) => sum + safeSize(path), 0),
      detail: availableRoots.join(','),
    },
  };
}

function listFiles(root: string, suffix: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && path.endsWith(suffix)) out.push(path);
    }
  }
  return out;
}

function safeSize(path: string): number {
  try { return statSync(path).size; }
  catch { return 0; }
}

function withHeadroom(value: number): number {
  return Math.max(1, Math.ceil(value * 1.25));
}

function runtimeWithHeadroom(value: number): number {
  return Math.max(1, Math.ceil(value * 1.5), value + 10_000);
}
