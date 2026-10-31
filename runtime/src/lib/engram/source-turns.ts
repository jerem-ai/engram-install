import { createHash } from 'node:crypto';
import { captureDecision, captureSourceValid, MAX_ARTIFACT_CAPTURE_SOURCES, readCapturePolicy } from '../capture-policy.js';

type Json = Record<string, unknown>;
const plain = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const SHA = /^[a-f0-9]{64}$/;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export interface SourceTurns {
  authority: 'historical_untrusted';
  /** Anchors are stamped by the producer; the reader has not re-read each native row. */
  verification: 'producer_binding';
  quotesComplete: boolean;
  references: Array<{
    quoteSha256: string;
    sourceId: string;
    revision: string;
    recordFormat: 'engram.hermes-message.v1' | 'engram.jsonl-record.v1';
    database?: 'state';
    table?: 'messages';
    nativeId?: { kind: 'integer' | 'text'; value: string };
    /** Physical 1-based JSONL record, including blank lines in the count. */
    recordOrdinal?: string;
    messagePath?: '/message' | '/payload' | '/data/prompt' | '/data/assistantTexts';
    nativeRole: 'user' | 'assistant';
    recordSha256: string;
  }>;
}

function nativeId(value: unknown): value is ['integer' | 'text', string] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== 'string'
    || Buffer.byteLength(value[1]) > 512) return false;
  if (value[0] === 'text') return value[1].length > 0 && !/[\uD800-\uDFFF]/u.test(value[1]);
  if (value[0] !== 'integer' || !/^(0|-?[1-9][0-9]*)$/.test(value[1])) return false;
  const integer = BigInt(value[1]);
  return integer >= -(2n ** 63n) && integer < 2n ** 63n;
}

/** Quote and exact-version anchors are evidence; a native role never proves human authority. */
export function sourceTurns(value: unknown, passages: string[], dependencies: unknown): SourceTurns | undefined {
  if (!plain(value) || value.schema !== 'engram.source-turns.v1' || value.authority !== 'historical_untrusted'
    || typeof value.quotes_complete !== 'boolean' || !Array.isArray(value.references) || value.references.length > 256
    || !Array.isArray(dependencies) || !dependencies.length || dependencies.length > MAX_ARTIFACT_CAPTURE_SOURCES
    || !dependencies.every(captureSourceValid)) return;
  const policy = readCapturePolicy();
  if (!dependencies.every(source => captureDecision(policy, source).allowed)) return;
  const quotes = new Set(passages.map(hash));
  const references: SourceTurns['references'] = [];
  for (const ref of value.references) {
    if (!plain(ref)
      || typeof ref.quote_sha256 !== 'string' || !SHA.test(ref.quote_sha256)
      || typeof ref.record_sha256 !== 'string' || !SHA.test(ref.record_sha256)
      || !['user', 'assistant'].includes(String(ref.native_role))
      || typeof ref.source_id !== 'string'
      || !dependencies.some(source => source.source_id === ref.source_id && source.revision === ref.revision)) return;
    const record: Partial<SourceTurns['references'][number]> = {};
    if (ref.record_format === 'engram.hermes-message.v1') {
      if (!ref.source_id.startsWith('hermes:') || ref.database !== 'state' || ref.table !== 'messages' || !nativeId(ref.native_id)) return;
      Object.assign(record, { database: 'state', table: 'messages', nativeId: { kind: ref.native_id[0], value: ref.native_id[1] } });
    } else if (ref.record_format === 'engram.jsonl-record.v1') {
      const runtime = ref.source_id.split(':')[0];
      const paths = runtime === 'claude-code' ? ['/message'] : runtime === 'codex' ? ['/payload']
        : runtime === 'openclaw' ? ['/message', '/data/prompt', '/data/assistantTexts'] : [];
      if (typeof ref.record_ordinal !== 'string' || !/^[1-9][0-9]{0,6}$/.test(ref.record_ordinal)
        || Number(ref.record_ordinal) > 1_000_000 || !paths.includes(String(ref.message_path))
        || ref.database !== undefined || ref.table !== undefined
        || ref.native_id !== undefined && (!nativeId(ref.native_id) || ref.native_id[0] !== 'text')) return;
      Object.assign(record, { recordOrdinal: ref.record_ordinal, messagePath: ref.message_path });
      if (nativeId(ref.native_id)) record.nativeId = { kind: ref.native_id[0], value: ref.native_id[1] };
    } else return;
    if (quotes.has(ref.quote_sha256)) references.push({ quoteSha256: ref.quote_sha256,
      sourceId: ref.source_id, revision: ref.revision as string, recordFormat: ref.record_format,
      nativeRole: ref.native_role as 'user' | 'assistant', recordSha256: ref.record_sha256, ...record });
  }
  return { authority: 'historical_untrusted', verification: 'producer_binding',
    quotesComplete: value.quotes_complete && quotes.size > 0 && [...quotes].every(q => references.some(r => r.quoteSha256 === q)),
    references };
}
