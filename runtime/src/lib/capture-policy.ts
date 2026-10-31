import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readEngramEnv } from './install-config.js';

/** Consent/eligibility evidence only; never tenant, principal or human-action authority. */
export interface CapturePolicy {
  schema: 'engram.capture-policy.v1';
  default: 'allow' | 'deny';
  projects: Record<string, 'allow' | 'deny'>;
  exclude_paths: string[];
  exclude_sources: string[];
}
export interface CaptureSource {
  source_id: string;
  revision: string;
  project_id: string | null;
  worktree_id: string | null;
  paths: string[];
  complete: boolean;
  identity_fingerprint?: string;
  /** Algorithm revision evidence, without granting identity or tool authority. */
  binding_revision?: number;
}
export interface CapturePolicySnapshot {
  state: 'legacy' | 'valid' | 'invalid';
  fingerprint: string;
  policy?: CapturePolicy;
}
export interface CaptureDecision { allowed: boolean; reason: string; policy_fingerprint: string }
const SCHEMA = 'engram.capture-policy.v1';
export const MAX_CAPTURE_POLICY_BYTES = 64 * 1024;
export const MAX_ARTIFACT_CAPTURE_SOURCES = 4096;
export const OPENCLAW_BINDING_REVISION = 5;
export const HERMES_BINDING_REVISION = 1;
const PROJECT = /^project:[a-f0-9]{64}$/;
const WORKTREE = /^worktree:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const utf8 = (v: string): boolean => Buffer.from(v, 'utf8').toString('utf8') === v;
const hasControl = (v: string): boolean => Array.from(v).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const token = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && utf8(v) && Buffer.byteLength(v) <= 512 && !hasControl(v);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function validCapturePath(v: unknown): v is string {
  return typeof v === 'string' && utf8(v) && Buffer.byteLength(v) <= 4096 && isAbsolute(v) && !hasControl(v) && !v.includes('\\')
    && (v === '/' || (!v.endsWith('/') && !v.includes('//') && !v.split('/').some(x => x === '.' || x === '..')));
}
export function canonicalCapturePath(v: string): string {
  let current = resolve(v);
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(current.slice(parent === '/' ? 1 : parent.length + 1));
      current = parent;
    }
  }
}
export function capturePathAllowed(snapshot: CapturePolicySnapshot, sourcePath: string): boolean {
  if (snapshot.state === 'legacy') return true;
  if (snapshot.state !== 'valid') return false;
  try {
    const physical = canonicalCapturePath(sourcePath);
    return !snapshot.policy!.exclude_paths.some(root => root === '/' || physical === root || physical.startsWith(root + '/'));
  } catch { return false; }
}
export function capturePolicySnapshot(value: unknown): CapturePolicySnapshot {
  const invalid: CapturePolicySnapshot = { state: 'invalid', fingerprint: digest('invalid') };
  if (!plain(value) || Object.keys(value).some(k => !['schema', 'default', 'projects', 'exclude_paths', 'exclude_sources'].includes(k))
    || value.schema !== SCHEMA || !['allow', 'deny'].includes(value.default as string)) return invalid;
  const projects = value.projects ?? {};
  const paths = value.exclude_paths ?? [];
  const sources = value.exclude_sources ?? [];
  if (!plain(projects) || Object.keys(projects).length > 10000
    || Object.entries(projects).some(([k, v]) => !PROJECT.test(k) || !['allow', 'deny'].includes(v as string))
    || !Array.isArray(paths) || paths.length > 10000 || !paths.every(validCapturePath)
    || !Array.isArray(sources) || sources.length > 10000 || !sources.every(token)) return invalid;
  const policy: CapturePolicy = { schema: SCHEMA, default: value.default as CapturePolicy['default'],
    projects: projects as CapturePolicy['projects'], exclude_paths: paths, exclude_sources: sources };
  return { state: 'valid', fingerprint: digest(policy), policy };
}
export const LEGACY_CAPTURE_POLICY: CapturePolicySnapshot = Object.freeze({ state: 'legacy', fingerprint: digest('legacy') });

export function capturePolicyPath(): string {
  return process.env.ENGRAM_CAPTURE_POLICY || readEngramEnv().ENGRAM_CAPTURE_POLICY || join(homedir(), '.config/engram/capture-policy.json');
}
/** No cached allow: every operation reads current configuration. Error messages contain no path or content. */
export function readCapturePolicy(file?: string): CapturePolicySnapshot {
  const configured = process.env.ENGRAM_CAPTURE_POLICY || readEngramEnv().ENGRAM_CAPTURE_POLICY;
  const required = file !== undefined || !!configured;
  file = file ?? configured ?? join(homedir(), '.config/engram/capture-policy.json');
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CAPTURE_POLICY_BYTES || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) return capturePolicySnapshot(null);
    const bytes = Buffer.alloc(MAX_CAPTURE_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > MAX_CAPTURE_POLICY_BYTES) return capturePolicySnapshot(null);
    const parsed = capturePolicySnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length))));
    if (parsed.policy) {
      parsed.policy.exclude_paths = parsed.policy.exclude_paths.map(canonicalCapturePath);
      parsed.fingerprint = digest(parsed.policy);
    }
    return parsed;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !required ? LEGACY_CAPTURE_POLICY : capturePolicySnapshot(null);
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function captureSourceValid(source: unknown): source is CaptureSource {
  if (!plain(source) || Object.keys(source).some(k => !['source_id', 'revision', 'project_id', 'worktree_id', 'paths', 'complete', 'identity_fingerprint', 'binding_revision'].includes(k))) return false;
  return token(source.source_id) && typeof source.revision === 'string' && SHA.test(source.revision)
    && (source.project_id === null || (typeof source.project_id === 'string' && PROJECT.test(source.project_id)))
    && (source.worktree_id === null || (typeof source.worktree_id === 'string' && WORKTREE.test(source.worktree_id)))
    && Array.isArray(source.paths) && source.paths.length > 0 && source.paths.length <= 4096 && source.paths.every(validCapturePath)
    && typeof source.complete === 'boolean'
    && (source.identity_fingerprint === undefined || (typeof source.identity_fingerprint === 'string' && SHA.test(source.identity_fingerprint)))
    && (source.binding_revision === undefined || (typeof source.binding_revision === 'number'
      && Number.isSafeInteger(source.binding_revision) && source.binding_revision > 0));
}
export function captureDecision(snapshot: CapturePolicySnapshot, source: CaptureSource | null): CaptureDecision {
  const result = (allowed: boolean, reason: string): CaptureDecision => ({ allowed, reason, policy_fingerprint: snapshot.fingerprint });
  if (snapshot.state === 'legacy') return result(true, 'legacy');
  if (snapshot.state !== 'valid' || !snapshot.policy) return result(false, 'invalid_policy');
  const p = snapshot.policy;
  const restricted = p.default === 'deny' || Object.keys(p.projects).length > 0 || p.exclude_paths.length > 0 || p.exclude_sources.length > 0;
  if (!source || !captureSourceValid(source)) return result(!restricted, restricted ? 'source_context_unknown' : 'unrestricted');
  if (p.exclude_sources.includes(source.source_id)) return result(false, 'source_excluded');
  if (source.paths.some(path => p.exclude_paths.some(root => root === '/' || path === root || path.startsWith(root + '/')))) return result(false, 'path_excluded');
  if (!source.complete && restricted) return result(false, 'source_context_unknown');
  if (restricted && source.source_id.startsWith('openclaw:') && (source.binding_revision ?? 0) < OPENCLAW_BINDING_REVISION) {
    return result(false, 'source_binding_outdated');
  }
  if (restricted && source.source_id.startsWith('hermes:') && (source.binding_revision ?? 0) < HERMES_BINDING_REVISION) {
    return result(false, 'source_binding_outdated');
  }
  if (!source.project_id && (p.default === 'deny' || Object.keys(p.projects).length > 0)) return result(false, 'project_unknown');
  const selected = source.project_id ? p.projects[source.project_id] ?? p.default : p.default;
  return result(selected === 'allow', selected === 'allow' ? 'allowed' : 'project_excluded');
}
/** Every dependency must remain allowed. A surviving source cannot support an entire aggregate by itself. */
export function captureSourcesAllowed(snapshot: CapturePolicySnapshot, sources: unknown): boolean {
  if (snapshot.state === 'legacy') return true;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_ARTIFACT_CAPTURE_SOURCES) return captureDecision(snapshot, null).allowed;
  return sources.every(source => captureSourceValid(source) && captureDecision(snapshot, source).allowed);
}
export function captureArtifactAllowed(snapshot: CapturePolicySnapshot, frontmatter: unknown): boolean {
  if (snapshot.state === 'legacy') return true;
  if (!plain(frontmatter)) return captureDecision(snapshot, null).allowed;
  const metadata = plain(frontmatter.metadata) ? frontmatter.metadata : {};
  if (metadata.capture_incomplete === true || frontmatter.capture_incomplete === true) return captureDecision(snapshot, null).allowed;
  return captureSourcesAllowed(snapshot, metadata.capture_sources ?? frontmatter.capture_sources);
}

/** Native MCP writes have no verified turn manifest. Unknown input must defer. */
export function requireUnboundCaptureAllowed(): void {
  if (!captureDecision(readCapturePolicy(), null).allowed) throw new Error('capture deferred: source_context_unknown');
}
