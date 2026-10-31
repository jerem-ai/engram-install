import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureArtifactAllowed, captureDecision, capturePathAllowed, canonicalCapturePath, readCapturePolicy, type CaptureSource } from './capture-policy.js';
import { observeRepository, resolveProjectIdentity } from './project-identity.js';
import { parseFrontmatterLoud } from './parser.js';

export function readCaptureIdentityConfig(): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(join(homedir(), '.config/engram/project-identity.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid?.() || (info.mode & 0o022)) return null;
    const bytes = Buffer.alloc(65537); let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    return size > 65536 ? null : JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Primary context-file evidence, subordinate to the existing resource allowlist. */
export function contextCaptureBinding(file: string): CaptureSource | null {
  const snapshot = readCapturePolicy();
  if (snapshot.state === 'legacy' || captureDecision(snapshot, null).allowed) return null;
  if (!capturePathAllowed(snapshot, file)) throw new Error('capture blocked: context_excluded');
  const physical = canonicalCapturePath(file);
  const identity = resolveProjectIdentity(observeRepository(dirname(physical)), readCaptureIdentityConfig());
  const source: CaptureSource = { source_id: 'context-file:' + createHash('sha256').update(physical).digest('hex'),
    revision: '0'.repeat(64), project_id: identity.project_id, worktree_id: identity.worktree_id,
    paths: [physical], complete: identity.status === 'verified', identity_fingerprint: identity.config_fingerprint };
  if (!captureDecision(snapshot, source).allowed) throw new Error('capture blocked: context_excluded');
  return source;
}

export function contextCaptureAllowed(file: string, source: CaptureSource | null, content?: Buffer): boolean {
  const snapshot = readCapturePolicy();
  if (!capturePathAllowed(snapshot, file) || !captureDecision(snapshot, source).allowed) return false;
  if (content !== undefined && snapshot.state !== 'legacy') {
    const { fm } = parseFrontmatterLoud(content.toString('utf8'), 'context');
    const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata as Record<string, unknown> : {};
    if (fm.type === 'agent_profile' || meta.capture_sources !== undefined || fm.capture_sources !== undefined
      || meta.capture_incomplete === true || fm.capture_incomplete === true) {
      if (!captureArtifactAllowed(snapshot, fm)) return false;
    }
  }
  return true;
}
