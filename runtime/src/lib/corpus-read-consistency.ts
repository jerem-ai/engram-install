import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function identity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error('Corpus resource is not a file');
  return JSON.stringify([realpathSync(path), ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]);
}
function optionalIdentity(path: string): string | null {
  try { return identity(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function sourceIdentity(path: string): string {
  return JSON.stringify([identity(path), optionalIdentity(path + '-wal'), optionalIdentity(path + '-journal')]);
}
export async function corpusFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

/** Pins a connection for data_version checks; no transaction or writer lock is held. */
export class CorpusDatabaseSnapshot {
  readonly db: Database.Database;
  private readonly version: unknown;
  private readonly files: string;
  readonly size: number;
  readonly digestFormat: 'file-sha256' | 'sqlite-base-wal.v1';
  constructor(readonly path: string) {
    const before = identity(path);
    this.db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      this.db.pragma('query_only = ON');
      this.version = this.db.pragma('data_version', { simple: true });
      this.files = sourceIdentity(path);
      this.size = statSync(path).size;
      this.digestFormat = optionalIdentity(path + '-wal') !== null && statSync(path + '-wal').size > 0 ? 'sqlite-base-wal.v1' : 'file-sha256';
      if (before !== identity(path) || !this.current()) throw new Error('Corpus changed while opening');
    } catch (error) { this.db.close(); throw error; }
  }
  current(): boolean {
    try { return this.db.open && this.db.pragma('data_version', { simple: true }) === this.version && sourceIdentity(this.path) === this.files; }
    catch { return false; }
  }
  assertCurrent(): void {
    if (!this.current()) throw new Error('Corpus changed during read');
  }
  async digest(): Promise<string> {
    this.assertCurrent();
    const base = await corpusFileSha256(this.path);
    const wal = this.digestFormat === 'sqlite-base-wal.v1'
      ? await corpusFileSha256(this.path + '-wal') : null;
    this.assertCurrent();
    // Preserve existing base-file digests when no WAL frames are present.
    return wal === null ? base : createHash('sha256').update('engram.sqlite-base-wal.v1\0').update(base).update('\0').update(wal).digest('hex');
  }
  close(): void { if (this.db.open) this.db.close(); }
}

/** Per-read evidence checks. This scope grants no identity, authorization or tool authority. */
export class CorpusReadScope {
  private readonly databases = new Map<string, CorpusDatabaseSnapshot>();
  private readonly files: Array<() => boolean> = [];
  database(path: string): CorpusDatabaseSnapshot {
    const key = resolve(path);
    let snapshot = this.databases.get(key);
    if (!snapshot) { snapshot = new CorpusDatabaseSnapshot(path); this.databases.set(key, snapshot); }
    return snapshot;
  }
  text(path: string, maxBytes = 1024 * 1024): string {
    const read = () => {
      const before = identity(path);
      const size = statSync(path).size;
      if (size > maxBytes) throw new Error('Corpus configuration exceeds size limit');
      const buffer = Buffer.alloc(size + 1);
      const fd = openSync(path, 'r');
      let length = 0;
      try {
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (!count) break;
          length += count;
        }
      } finally { closeSync(fd); }
      if (length > size) throw new Error('Corpus configuration changed during read');
      const bytes = buffer.subarray(0, length);
      if (bytes.length > maxBytes || identity(path) !== before) throw new Error('Corpus configuration changed during read');
      return { text: bytes.toString('utf8'), version: before + createHash('sha256').update(bytes).digest('hex') };
    };
    const original = read();
    this.files.push(() => { try { return read().version === original.version; } catch { return false; } });
    return original.text;
  }
  current(): boolean { return this.files.every(check => check()) && [...this.databases.values()].every(snapshot => snapshot.current()); }
  assertCurrent(): void { if (!this.current()) throw new Error('Corpus read dependencies changed'); }
  close(): void { for (const snapshot of this.databases.values()) snapshot.close(); }
}
