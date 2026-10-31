import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { canonicalCapturePath, captureDecision, capturePathAllowed, captureSourceValid,
  MAX_ARTIFACT_CAPTURE_SOURCES, readCapturePolicy, type CaptureSource } from '../capture-policy.js';

const META_LIMIT = 1024 * 1024;
const SOURCE_LIMIT = 2 * 1024 * 1024 * 1024;
const STORED_LIMIT = SOURCE_LIMIT + 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
type Json = Record<string, unknown>;
const plain = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const identity = (info: BigIntStats): string => [info.dev, info.ino, info.size,
  info.mtimeNs, info.ctimeNs, info.mode, info.uid].join(':');

export interface SelectedTranscript {
  host: 'local';
  root: string;
  logicalPath: string;
  storage: 'gzip-version';
  sourceSha256: string;
  storedSha256: string;
  receiptSha256: string;
  /** Current gzip bytes match the receipt that bound the verified native revision. */
  verification: 'stored_hash';
}

/** Same array encoding as extraction/scoped_archive.py locator_key(). */
export function selectedLocatorKey(source: CaptureSource): string {
  return createHash('sha256').update(JSON.stringify([
    source.source_id, source.revision, source.project_id, source.worktree_id,
  ])).digest('hex');
}

function sources(value: unknown): CaptureSource[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ARTIFACT_CAPTURE_SOURCES
    && value.every(captureSourceValid) ? value : null;
}

/** Read a private regular file through one descriptor with bounded memory. */
function checkedFile(path: string, limit: number, guard: () => void, metadata: boolean,
  checked?: (identity: string) => void): Buffer | string {
  guard();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid?.() ?? -1)
      || (before.mode & 0o077n) !== 0n || before.size > BigInt(limit)
      || (!metadata && before.size !== BigInt(limit))) throw new Error('archive file unavailable');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(META_LIMIT, limit + 1));
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      guard();
      const n = readSync(fd, buffer, 0, buffer.length, null);
      guard();
      if (!n) break;
      size += n;
      if (size > limit) throw new Error('archive file changed');
      digest.update(buffer.subarray(0, n));
      if (metadata) chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (size !== Number(before.size) || identity(before) !== identity(after) || !named.isFile()
      || identity(named) !== identity(after)) {
      throw new Error('archive file changed');
    }
    guard();
    checked?.(identity(after));
    return metadata ? Buffer.concat(chunks) : digest.digest('hex');
  } finally { closeSync(fd); }
}

function metadata(path: string, guard: () => void): { raw: Buffer; value: Json } {
  const raw = checkedFile(path, META_LIMIT, guard, true) as Buffer;
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (!plain(value)) throw new Error('archive metadata unavailable');
  return { raw, value };
}

/** Exact source version only. This never reads the global inventory or native store. */
export function findSelectedTranscript(session: string | null, dependencies: unknown, roots: string[]): SelectedTranscript | null {
  const expected = sources(dependencies);
  if (!session || !expected) return null;
  if (!session.includes(':')) {
    const aliases = [...new Set(expected.map(s => s.source_id).filter(id => id.endsWith(':' + session)))];
    if (aliases.length !== 1) return null;
    session = aliases[0];
  }
  session = session.replace(/^claude:/, 'claude-code:');
  const candidates = expected.filter(s => s.source_id === session);
  if (!candidates.length || candidates.some(s => !s.complete || !s.project_id || !s.worktree_id)
    || new Set(candidates.map(selectedLocatorKey)).size !== 1) return null;
  const source = candidates[0];
  const runtime = session.startsWith('claude-code:') ? 'claude-code' : session.startsWith('codex:') ? 'codex'
    : session.startsWith('openclaw:') ? 'openclaw' : session.startsWith('hermes:') ? 'hermes' : null;
  if (!runtime) return null;
  const policy = readCapturePolicy();
  const eligible = (values: CaptureSource[]) => values.every(s => captureDecision(policy, s).allowed
    && s.paths.every(path => capturePathAllowed(policy, path)));
  if (!eligible(expected)) return null;
  for (const root of [...new Set(roots)]) {
    if (!isAbsolute(root)) continue;
    const paths: string[] = [root];
    let archived: CaptureSource[] = [];
    const guard = () => {
      const current = readCapturePolicy();
      if (current.fingerprint !== policy.fingerprint || !eligible([...expected, ...archived])
        || paths.some(path => !capturePathAllowed(current, path))) throw new Error('archive capture deferred');
      const physicalRoot = canonicalCapturePath(root);
      if (paths.some(path => {
        const part = relative(physicalRoot, canonicalCapturePath(path));
        return part === '..' || part.startsWith('../') || isAbsolute(part);
      })) throw new Error('archive path unavailable');
    };
    try {
      const locator = join(root, '.source-locators', selectedLocatorKey(source) + '.json');
      paths.push(locator);
      const row = metadata(locator, guard);
      const index = row.value;
      if (index.schema !== 'engram.transcript-locator.v1' || index.source_id !== source.source_id
        || index.revision !== source.revision || index.project_id !== source.project_id
        || index.worktree_id !== source.worktree_id || typeof index.receipt !== 'string'
        || typeof index.receipt_sha256 !== 'string' || !SHA.test(index.receipt_sha256)
        || index.receipt.split('/').some(part => !part || part === '.' || part === '..')
        || index.receipt.includes('\\') || Array.from(index.receipt).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) continue;
      const receiptPath = join(root, index.receipt);
      paths.push(receiptPath);
      const record = metadata(receiptPath, guard);
      if (sha(record.raw) !== index.receipt_sha256) continue;
      const receipt = record.value;
      archived = sources(receipt.capture_sources) ?? [];
      if (receipt.schema !== 'engram.transcript-archive.v1' || receipt.runtime !== runtime
        || receipt.source_sha256 !== source.revision || !archived.length
        || typeof receipt.capture_policy !== 'string' || !SHA.test(receipt.capture_policy)
        || !archived.every(s => s.complete && s.source_id.startsWith(runtime + ':') && s.revision === source.revision
          && (runtime === 'hermes' ? !!s.project_id && !!s.worktree_id
            : s.project_id === source.project_id && s.worktree_id === source.worktree_id))
        || (runtime === 'hermes' && receipt.source_format !== 'engram.hermes-session.v1')
        || (runtime === 'hermes' && expected.some(s => s.source_id.startsWith('hermes:')
          && s.revision === source.revision && !archived.some(a => selectedLocatorKey(a) === selectedLocatorKey(s))))
        || !archived.some(s => selectedLocatorKey(s) === selectedLocatorKey(source))
        || typeof receipt.logical_path !== 'string'
        || !(runtime === 'claude-code' ? receipt.logical_path.startsWith('claude-projects/')
          : runtime === 'openclaw' ? receipt.logical_path.startsWith('openclaw-agents/')
          : runtime === 'hermes' ? /^hermes-sessions\/sqlite\/[a-f0-9]{64}\.jsonl$/.test(receipt.logical_path)
          : /^(codex-(sessions|archived)|openclaw-agents)\//.test(receipt.logical_path))
        || index.receipt !== `${receipt.logical_path}.versions/${source.revision}/receipt.json`
        || typeof receipt.stored_sha256 !== 'string' || !SHA.test(receipt.stored_sha256)
        || !Number.isSafeInteger(receipt.source_bytes) || Number(receipt.source_bytes) < 0 || Number(receipt.source_bytes) > SOURCE_LIMIT
        || !Number.isSafeInteger(receipt.stored_bytes) || Number(receipt.stored_bytes) <= 0 || Number(receipt.stored_bytes) > STORED_LIMIT) continue;
      const compressed = join(receiptPath, '..', 'transcript.jsonl.gz');
      paths.push(compressed);guard();
      let compressedIdentity = '';
      if (checkedFile(compressed, Number(receipt.stored_bytes), guard, false,
        value => { compressedIdentity = value; }) !== receipt.stored_sha256) continue;
      // Recheck metadata after the body read, including replacement at the same path.
      if (sha(metadata(locator, guard).raw) !== sha(row.raw)
        || sha(metadata(receiptPath, guard).raw) !== index.receipt_sha256
        || identity(lstatSync(compressed, { bigint: true })) !== compressedIdentity) continue;
      guard();
      return { host: 'local', root, logicalPath: relative(root, compressed), storage: 'gzip-version',
        sourceSha256: source.revision, storedSha256: receipt.stored_sha256,
        receiptSha256: index.receipt_sha256, verification: 'stored_hash' };
    } catch { /* Missing, changed, unbound and excluded copies all stay unavailable. */ }
  }
  return null;
}
