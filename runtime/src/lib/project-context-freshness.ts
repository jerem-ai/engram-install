import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContextResource } from './context-resources.js';

export interface ProjectContextFreshness {
  status: 'current' | 'stale' | 'unavailable';
  source_revision?: string;
  checked_at?: string;
}

/** Read only trusted refresh metadata. Source text and arbitrary error strings are excluded. */
export function projectContextFreshness(resource: ContextResource): ProjectContextFreshness | undefined {
  if (!resource.refreshStatusPath) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(resource.refreshStatusPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 16384) throw new Error('Unsafe refresh metadata');
    const buffer = Buffer.alloc(16385); const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes !== info.size || bytes > 16384) throw new Error('Refresh metadata changed during read');
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
    if (state.schema !== 'engram.project-context-refresh.v1' || !['current', 'stale'].includes(state.status)
      || !/^[a-f0-9]{40,64}$/.test(state.source_revision) || typeof state.checked_at !== 'string'
      || !Number.isFinite(Date.parse(state.checked_at))) throw new Error('Invalid refresh metadata');
    // The status and selected immutable checkout must describe the same publication.
    const expected = join(realpathSync(dirname(resource.refreshStatusPath)), 'snapshots', state.source_revision);
    if (resource.rootReal !== expected || realpathSync(resource.root) !== resource.rootReal) throw new Error('Publication changed');
    const age = Date.now() - Date.parse(state.checked_at);
    return { status: state.status === 'current' && age >= -60000 && age <= 1800000 ? 'current' : 'stale',
      source_revision: state.source_revision, checked_at: state.checked_at };
  } catch { return { status: 'unavailable' }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
