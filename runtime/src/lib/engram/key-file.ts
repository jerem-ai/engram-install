import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

/**
 * Shared loader for persistent secret key files.
 *
 * Several callers derive stable HMAC material (candidate ids, replay digests)
 * from a key that lives on disk. That key MUST be stable across process
 * restarts — regenerating it silently changes every value derived from the
 * old one (duplicate quarantine rows, a replay guard that forgets what it
 * already consumed). A short or group/world-readable file therefore fails
 * closed here instead of being replaced with a fresh one.
 */
export const MIN_PERSISTENT_KEY_BYTES = 32;

export function loadPersistentKey(path: string, label: string): Uint8Array {
  if (!existsSync(path)) return createPersistentKey(path);

  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${label} has group or world permission (${mode.toString(8)}): ${path}`);
  }
  const key = readFileSync(path);
  if (key.byteLength < MIN_PERSISTENT_KEY_BYTES) {
    throw new Error(
      `${label} must be at least 32 bytes; ${path} holds ${key.byteLength}. ` +
      'Refusing to regenerate it, because a new key would silently change every value derived from the old one.',
    );
  }
  return key;
}

function createPersistentKey(path: string): Uint8Array {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(MIN_PERSISTENT_KEY_BYTES);
  // Write to a sibling temp file first so a crash mid-write cannot leave a
  // truncated key that the next run would reject.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return key;
}
