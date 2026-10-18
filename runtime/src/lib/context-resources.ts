import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

const DEFAULT_MAX_BYTES = 128 * 1024;
const HARD_MAX_BYTES = 1024 * 1024;
const DEFAULT_EXCLUDE_GLOBS = [
  '.git/**',
  '.claude/**',
  'node_modules/**',
  '**/.git/**',
  '**/.claude/**',
  '**/node_modules/**',
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*_rsa',
  '**/*_ed25519',
  '**/.DS_Store',
];

export interface ContextResourceConfig {
  id: string;
  title?: string;
  description?: string;
  owner: string;
  root: string;
  include?: string[];
  exclude?: string[];
  maxBytes?: number;
}

export interface ContextResource extends ContextResourceConfig {
  rootReal: string;
  include: string[];
  exclude: string[];
  maxBytes: number;
}

export interface ContextConfig {
  dataDir: string;
  deviceId: string;
  resourcesConfigPath: string;
  resources: ContextResource[];
}

export interface ContextConfigOverrides {
  dataDir?: string;
  resourcesConfigPath?: string;
  deviceId?: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  caseSensitive?: boolean;
  pathGlob?: string;
}

export interface SearchHit {
  resource_id: string;
  path: string;
  line: number;
  preview: string;
}

export interface ReadOptions {
  path: string;
  maxBytes?: number;
}

export interface ReadResult {
  resource_id: string;
  path: string;
  bytes: number;
  truncated: boolean;
  text: string;
}

export function resolveContextConfig(overrides: ContextConfigOverrides = {}): ContextConfig {
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dataDir = overrides.dataDir
    ?? process.env.KG_DATA_DIR
    ?? join(xdgData, 'knowledge-graph');
  const resourcesConfigPath = overrides.resourcesConfigPath
    ?? process.env.KG_RESOURCES_CONFIG
    ?? join(dataDir, 'kg-resources.json');
  const deviceId = overrides.deviceId
    ?? process.env.KG_CONTEXT_DEVICE_ID
    ?? hostname();

  return {
    dataDir,
    deviceId,
    resourcesConfigPath,
    resources: loadResources(resourcesConfigPath),
  };
}

export function loadResources(configPath: string): ContextResource[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`kg-context: could not read ${configPath}: ${(err as Error).message}`);
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`kg-context: malformed JSON in ${configPath}: ${(err as Error).message} -- ignoring`);
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { resources?: unknown })?.resources;
  if (!Array.isArray(list)) {
    console.warn(`kg-context: ${configPath} must be a JSON array or { resources: [...] } -- ignoring`);
    return [];
  }

  const resources: ContextResource[] = [];
  const seenIds = new Set<string>();
  for (const item of list) {
    const resource = normalizeResource(item);
    if (!resource) continue;
    if (resource.id === 'resources') {
      console.warn('kg-context: skipping reserved resource id "resources"');
      continue;
    }
    if (seenIds.has(resource.id)) {
      console.warn(`kg-context: skipping duplicate resource id "${resource.id}"`);
      continue;
    }
    seenIds.add(resource.id);
    resources.push(resource);
  }
  return resources;
}

export function listResources(config: ContextConfig): Record<string, unknown>[] {
  return config.resources.map(resource => ({
    id: resource.id,
    title: resource.title,
    description: resource.description,
    owner: resource.owner,
    root: resource.root,
    include: resource.include,
    max_bytes: resource.maxBytes,
    access: 'read_search',
  }));
}

export function findResource(config: ContextConfig, resourceId: string): ContextResource {
  const resource = config.resources.find(r => r.id === resourceId);
  if (!resource) {
    const known = config.resources.map(r => r.id).join(', ') || '(none configured)';
    throw new Error(`Unknown context resource "${resourceId}". Known resources: ${known}`);
  }
  return resource;
}

export function readContextFile(config: ContextConfig, resourceId: string, opts: ReadOptions): ReadResult {
  const resource = findResource(config, resourceId);
  const { absolutePath, relativePath } = resolveResourcePath(resource, opts.path);
  assertReadableFile(resource, absolutePath, relativePath);

  const size = statSync(absolutePath).size;
  const requestedMax = clampMaxBytes(opts.maxBytes ?? resource.maxBytes);
  const limit = Math.min(requestedMax, resource.maxBytes);
  if (size > resource.maxBytes) {
    throw new Error(`Refusing to read ${relativePath}: file is ${size} bytes, max for resource is ${resource.maxBytes}`);
  }

  const buffer = readFileSync(absolutePath);
  assertTextBuffer(relativePath, buffer);
  const slice = buffer.subarray(0, limit);
  return {
    resource_id: resource.id,
    path: relativePath,
    bytes: buffer.length,
    truncated: buffer.length > slice.length,
    text: slice.toString('utf-8'),
  };
}

export function searchContext(config: ContextConfig, resourceId: string, opts: SearchOptions): SearchHit[] {
  const resource = findResource(config, resourceId);
  const query = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
  if (query.length === 0) throw new Error('Search query must not be empty');

  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const hits: SearchHit[] = [];
  for (const relativePath of walkResourceFiles(resource)) {
    if (opts.pathGlob && !globMatches(opts.pathGlob, relativePath)) continue;
    const { absolutePath } = resolveResourcePath(resource, relativePath);
    const buffer = readFileSync(absolutePath);
    if (!isTextBuffer(buffer)) continue;
    const lines = buffer.toString('utf-8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const haystack = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (!haystack.includes(query)) continue;
      hits.push({
        resource_id: resource.id,
        path: relativePath,
        line: i + 1,
        preview: lines[i].trim().slice(0, 240),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

function normalizeResource(input: unknown): ContextResource | undefined {
  const item = input as Partial<ContextResourceConfig>;
  if (!item || typeof item !== 'object') return undefined;
  if (!item.id || !/^[a-zA-Z0-9_.-]+$/.test(item.id)) {
    console.warn('kg-context: skipping resource with missing/invalid id');
    return undefined;
  }
  if (!item.owner || typeof item.owner !== 'string') {
    console.warn(`kg-context: skipping ${item.id}: owner is required`);
    return undefined;
  }
  if (!item.root || typeof item.root !== 'string') {
    console.warn(`kg-context: skipping ${item.id}: root is required`);
    return undefined;
  }
  const include = requiredGlobList(item.include);
  if (!include) {
    console.warn(`kg-context: skipping ${item.id}: include must be a non-empty glob list`);
    return undefined;
  }

  let rootReal: string;
  try {
    rootReal = realpathSync.native(item.root);
  } catch (err) {
    console.warn(`kg-context: skipping ${item.id}: root not readable (${(err as Error).message})`);
    return undefined;
  }

  return {
    id: item.id,
    title: item.title,
    description: item.description,
    owner: item.owner,
    root: item.root,
    rootReal,
    include,
    exclude: [...DEFAULT_EXCLUDE_GLOBS, ...normalizeGlobList(item.exclude, [])],
    maxBytes: clampMaxBytes(item.maxBytes ?? DEFAULT_MAX_BYTES),
  };
}

function requiredGlobList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const globs = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return globs.length > 0 ? globs : undefined;
}

function normalizeGlobList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const globs = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return globs.length > 0 ? globs : fallback;
}

function clampMaxBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(value), HARD_MAX_BYTES);
}

function resolveResourcePath(resource: ContextResource, requestPath: string): { absolutePath: string; relativePath: string } {
  if (!requestPath || isAbsolute(requestPath)) {
    throw new Error('Context file path must be a non-empty relative path');
  }
  if (toPosix(requestPath).split('/').some(part => part === '..')) {
    throw new Error(`Context file path must not contain traversal segments: ${requestPath}`);
  }
  const candidate = join(resource.rootReal, requestPath);
  let absolutePath: string;
  try {
    absolutePath = realpathSync.native(candidate);
  } catch (err) {
    throw new Error(`Context file not found: ${requestPath} (${(err as Error).message})`, { cause: err });
  }
  const rel = toPosix(relative(resource.rootReal, absolutePath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes context resource root: ${requestPath}`);
  }
  return { absolutePath, relativePath: rel };
}

function assertReadableFile(resource: ContextResource, absolutePath: string, relativePath: string): void {
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Refusing to read non-file context path: ${relativePath}`);
  }
  if (!isPathAllowed(resource, relativePath)) {
    throw new Error(`Context path is not allowed by resource policy: ${relativePath}`);
  }
}

function isPathAllowed(resource: ContextResource, relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  if (normalized.split('/').some(part => part.startsWith('.'))) return false;
  if (!resource.include.some(pattern => globMatches(pattern, normalized))) return false;
  if (resource.exclude.some(pattern => globMatches(pattern, normalized))) return false;
  return true;
}

function* walkResourceFiles(resource: ContextResource): Generator<string> {
  const stack = [''];
  while (stack.length > 0) {
    const dirRel = stack.pop()!;
    const dirAbs = join(resource.rootReal, dirRel);
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const childRel = toPosix(join(dirRel, entry.name));
      if (entry.isDirectory()) {
        if (childRel.split('/').some(part => part.startsWith('.'))) continue;
        if (resource.exclude.some(pattern => globMatches(pattern, `${childRel}/`))) continue;
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isPathAllowed(resource, childRel)) continue;
      const childAbs = join(resource.rootReal, childRel);
      if (statSync(childAbs).size > resource.maxBytes) continue;
      yield childRel;
    }
  }
}

function assertTextBuffer(path: string, buffer: Buffer): void {
  if (!isTextBuffer(buffer)) {
    throw new Error(`Refusing to read binary or non-text context file: ${path}`);
  }
}

function isTextBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf-8');
  if (sample.length === 0) return true;
  const replacements = [...sample].filter(char => char === '\uFFFD').length;
  return replacements / sample.length < 0.02;
}

function globMatches(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(toPosix(value));
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*') {
      if (next === '*') {
        const after = pattern[i + 2];
        if (after === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExp(char);
    }
  }
  out += '$';
  return new RegExp(out);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}
