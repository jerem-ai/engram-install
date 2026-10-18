import { chmodSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { ReplayGuard } from './authorization.js';

/** Persistent, atomic one-time grant consumption for write/destructive requests. */
export class SqliteReplayGuard implements ReplayGuard {
  private readonly db: Database.Database;

  constructor(path: string) {
    const absolute = resolve(path);
    assertExistingParent(dirname(absolute));
    assertNotSymlink(absolute);
    this.db = new Database(absolute);
    chmodSync(absolute, 0o600);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS used_authorization_grants (
        key_digest TEXT PRIMARY KEY,
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_used_authorization_grants_expiry
        ON used_authorization_grants(expires_at_ms);
    `);
  }

  consume(key: string, expiresAtMs: number, nowMs: number): boolean {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Replay key must be a SHA-256 digest');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM used_authorization_grants WHERE expires_at_ms <= ?').run(nowMs);
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO used_authorization_grants
          (key_digest, expires_at_ms, consumed_at_ms)
        VALUES (?, ?, ?)
      `).run(key, Math.floor(expiresAtMs), Math.floor(nowMs));
      return result.changes === 1;
    })();
  }

  close(): void {
    this.db.close();
  }
}

function assertExistingParent(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Replay database parent must be an existing real directory');
  }
}

function assertNotSymlink(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Replay database must be a regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
