import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';

/** Routing evidence only. Never use these IDs as tenant, principal or action authority. */
export interface ProjectIdentityConfig {
  schema: 'engram.project-identity.v1';
  projects: Array<{ id: string; stable_id?: string; aliases?: string[]; remotes?: string[]; roots?: string[]; legacy_stores?: string[] }>;
}
export interface RepositoryObservation {
  host_id: string;
  worktree: string;
  common_dir: string;
  remotes: string[];
}
export interface ProjectIdentity {
  schema: 'engram.project-identity.v1';
  status: 'verified' | 'unknown';
  reason: string;
  project_id: string | null;
  worktree_id: string | null;
  config_fingerprint: string;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const EMPTY: ProjectIdentityConfig = { schema: 'engram.project-identity.v1', projects: [] };

/** Deliberately narrow: reject credentials, local paths, URL escapes and ambiguous spellings. */
export function normalizeRepositoryRemote(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !/^[!-~]+$/.test(value)) return null;
  let scheme: string, host: string, port: string, repo: string;
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(value);
  if (scp) { scheme = 'ssh'; host = scp[1]; port = ''; repo = scp[2]; }
  else {
    const url = /^(https|ssh|git):\/\/(git@)?([A-Za-z0-9.-]+)(?::([0-9]+))?\/(.+)$/.exec(value);
    if (!url || (url[2] && url[1] !== 'ssh')) return null;
    [, scheme, , host, port = '', repo] = url;
  }
  host = host.toLowerCase();
  if (host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  if (port) {
    if (Number(port) < 1 || Number(port) > 65535) return null;
    port = String(Number(port));
    if (port === ({ https: '443', ssh: '22', git: '9418' } as Record<string, string>)[scheme]) port = '';
  }
  repo = repo.replace(/\/$/, '').replace(/\.git$/, '');
  if (!repo || !/^[A-Za-z0-9._/-]+$/.test(repo)
    || repo.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return `remote:${host}${port ? ':' + port : ''}/${repo}`;
}

function parseConfig(value: unknown): { config: ProjectIdentityConfig; remoteOwners: Map<string, string> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_config');
  const cfg = value as ProjectIdentityConfig;
  if (Object.keys(cfg).some(k => !['schema', 'projects'].includes(k))
    || cfg.schema !== EMPTY.schema || !Array.isArray(cfg.projects) || cfg.projects.length > 10000) throw new Error('invalid_config');
  const ids = new Set<string>(), stableIds = new Set<string>(), remoteOwners = new Map<string, string>(), rootOwners = new Map<string, string>(), storeOwners = new Set<string>();
  for (const item of cfg.projects) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(k => !['id', 'stable_id', 'aliases', 'remotes', 'roots', 'legacy_stores'].includes(k))
      || typeof item.id !== 'string' || !ID.test(item.id)) throw new Error('invalid_config');
    const stable = item.stable_id ?? `project:${digest('configured:' + item.id)}`;
    if (!/^project:[a-f0-9]{64}$/.test(stable) || stableIds.has(stable)) throw new Error('ambiguous_config');
    stableIds.add(stable);
    for (const key of ['aliases', 'remotes', 'roots', 'legacy_stores'] as const) {
      if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key]!.some(x => typeof x !== 'string'))) throw new Error('invalid_config');
    }
    for (const store of item.legacy_stores ?? []) {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(store) || storeOwners.has(store.toLowerCase())) throw new Error('ambiguous_config');
      storeOwners.add(store.toLowerCase());
    }
    for (const id of [item.id, ...item.aliases ?? []]) {
      if (!ID.test(id) || ids.has(id)) throw new Error('ambiguous_config');
      ids.add(id);
    }
    for (const remote of item.remotes ?? []) {
      const normal = normalizeRepositoryRemote(remote);
      if (!normal) throw new Error('invalid_config');
      if (remoteOwners.has(normal) && remoteOwners.get(normal) !== item.id) throw new Error('ambiguous_config');
      remoteOwners.set(normal, item.id);
    }
    for (const root of item.roots ?? []) {
      if (!isAbsolute(root) || root.includes('\0') || root.split('/').some(x => x === '.' || x === '..') || root.endsWith('/')) throw new Error('invalid_config');
      if (rootOwners.has(root) && rootOwners.get(root) !== item.id) throw new Error('ambiguous_config');
      rootOwners.set(root, item.id);
    }
  }
  return { config: cfg, remoteOwners };
}

/** Input must come from observeRepository, never transcript/marker/remote text supplied by a model. */
export function resolveProjectIdentity(observation: RepositoryObservation | null, value: unknown = EMPTY, explicitId?: string): ProjectIdentity {
  const result: ProjectIdentity = { schema: EMPTY.schema, status: 'unknown', reason: 'unverified_repository',
    project_id: null, worktree_id: null, config_fingerprint: digest(null) };
  try {
    const { config: cfg, remoteOwners } = parseConfig(value);
    result.config_fingerprint = digest(cfg);
    if (!observation || !observation.host_id || !isAbsolute(observation.worktree) || !isAbsolute(observation.common_dir)
      || !Array.isArray(observation.remotes)) return result;
    const candidates = new Set<string>();
    for (const project of cfg.projects) {
      if (project.roots?.includes(observation.common_dir)) candidates.add(`configured:${project.id}`);
    }
    if (explicitId !== undefined) {
      const matched = cfg.projects.find(p => p.id === explicitId || p.aliases?.includes(explicitId));
      if (!matched) return { ...result, reason: 'unknown_explicit_id' };
      candidates.add(`configured:${matched.id}`);
    }
    const remoteCandidates = new Set<string>();
    for (const raw of observation.remotes) {
      const remote = normalizeRepositoryRemote(raw);
      if (!remote) return { ...result, reason: 'invalid_remote' };
      const owner = remoteOwners.get(remote);
      remoteCandidates.add(owner === undefined ? remote : `configured:${owner}`);
    }
    if (remoteCandidates.size > 1) return { ...result, reason: 'ambiguous_repository' };
    for (const key of remoteCandidates) candidates.add(key);
    // Explicit root/ID assignment may name a repository without listing its current origin.
    // A conflicting configured remote is still an error; an unmapped remote remains evidence.
    const configured = [...candidates].filter(x => x.startsWith('configured:'));
    if (configured.length === 1) for (const key of candidates) if (key.startsWith('remote:')) candidates.delete(key);
    if (candidates.size > 1) return { ...result, reason: 'ambiguous_repository' };
    const key = [...candidates][0] ?? `local:${digest([observation.host_id, observation.common_dir])}`;
    const projectId = configured.length ? cfg.projects.find(p => `configured:${p.id}` === key)?.stable_id ?? `project:${digest(key)}` : `project:${digest(key)}`;
    return { ...result, status: 'verified', reason: configured.length ? 'configured' : observation.remotes.length ? 'remote' : 'local',
      project_id: projectId, worktree_id: `worktree:${digest([projectId, observation.host_id, observation.worktree])}` };
  } catch (error) {
    return { ...result, reason: error instanceof Error && error.message === 'ambiguous_config' ? 'ambiguous_config' : 'invalid_config' };
  }
}

/** Qualify the existing destination in shadow. This function never selects a new store. */
export function checkCaptureRouting(source: ProjectIdentity, storage: ProjectIdentity | null, routed: boolean): { allowed: boolean; reason: string } {
  if (['invalid_config', 'ambiguous_config', 'invalid_remote', 'ambiguous_repository', 'unknown_explicit_id'].includes(source.reason)) {
    return { allowed: false, reason: 'identity_invalid' };
  }
  if (!routed) return { allowed: true, reason: source.status === 'verified' ? 'isolated_verified' : 'isolated_unverified' };
  if (source.status !== 'verified' || storage?.status !== 'verified') return { allowed: false, reason: 'routing_unverified' };
  if (source.project_id !== storage.project_id) return { allowed: false, reason: 'routing_conflict' };
  return { allowed: true, reason: 'routing_verified' };
}

/** Read local Git metadata with bounded commands. Never contacts a remote or changes a repository. */
export function observeRepository(cwd: string, hostId = hostname()): RepositoryObservation | null {
  try {
    const directory = realpathSync(cwd);
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args: string[]): string => execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    }).trim();
    const worktree = realpathSync(git('rev-parse', '--show-toplevel'));
    const commonDir = realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
    let remotes: string[] = [];
    try { remotes = git('config', '--get-all', 'remote.origin.url').split('\n').filter(Boolean); }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    return { host_id: hostId, worktree, common_dir: commonDir, remotes };
  } catch { return null; }
}

/** Same evidence as the sync observer; an abort stops the current Git child and later reads. */
export async function observeRepositoryAsync(cwd: string, hostId = hostname(), signal?: AbortSignal): Promise<RepositoryObservation | null> {
  try {
    signal?.throwIfAborted();
    const directory = await realpath(cwd);
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args: string[]): Promise<string> => {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        execFile('git', ['-C', directory, ...args], {
          encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, signal,
          env: { ...gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
      });
    };
    const worktree = await realpath(await git('rev-parse', '--show-toplevel'));
    const commonDir = await realpath(await git('rev-parse', '--path-format=absolute', '--git-common-dir'));
    let remotes: string[] = [];
    try { remotes = (await git('config', '--get-all', 'remote.origin.url')).split('\n').filter(Boolean); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    signal?.throwIfAborted();
    return { host_id: hostId, worktree, common_dir: commonDir, remotes };
  } catch { return null; }
}
