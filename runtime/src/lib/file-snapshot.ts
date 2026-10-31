import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, statSync, type BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';

export interface FileReadRevision { stamp: string; sha256: string; mtime: number }
export class SourceFileChangedError extends Error {
  constructor() { super('Index source changed during its read'); this.name = 'SourceFileChangedError'; }
}
function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Parse and watermark the same regular-file bytes, preserving existing symlink behavior. */
export async function readFileSnapshot(path: string): Promise<{ raw: string; revision: FileReadRevision }> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile()) throw new SourceFileChangedError();
    const times = await fd.stat();
    const bytes = Buffer.allocUnsafe(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await fd.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw new SourceFileChangedError();
      offset += bytesRead;
    }
    const after = await fd.stat({ bigint: true });
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(await stat(path, { bigint: true }))) throw new SourceFileChangedError();
    return { raw: bytes.toString('utf8'), revision: {
      stamp: stamp(after), mtime: times.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex'),
    } };
  } finally { await fd.close(); }
}

/** Re-read with bounded hash buffers; metadata alone cannot establish equal bytes. */
export function fileRevisionCurrent(path: string, revision: FileReadRevision): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || stamp(before) !== revision.stamp) return false;
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, Number(before.size))));
    let remaining = Number(before.size);
    while (remaining > 0) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!count) return false;
      digest.update(buffer.subarray(0, count));
      remaining -= count;
    }
    if (readSync(fd, buffer, 0, 1, null) !== 0) return false;
    return stamp(fstatSync(fd, { bigint: true })) === revision.stamp
      && stamp(statSync(path, { bigint: true })) === revision.stamp && digest.digest('hex') === revision.sha256;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
