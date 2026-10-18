import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';

const CACHE_MARKER_SCHEMA = 1;
const CACHE_MARKER_NAME = '.engram-ready.json';
const REQUIRED_MODEL_FILES = [
  'config.json',
  'onnx/model_quantized.onnx',
  'tokenizer.json',
  'tokenizer_config.json',
] as const;

interface LockOptions {
  pollMs?: number;
  staleMs?: number;
  timeoutMs?: number;
}

interface LockOwner {
  hostname: string;
  nonce: string;
  pid: number;
  startedAt: string;
}

interface CacheMarker {
  schema: typeof CACHE_MARKER_SCHEMA;
  model: typeof EMBEDDING_MODEL;
  revision: typeof EMBEDDING_MODEL_REVISION;
  files: Array<{ path: string; sha256: string; size: number }>;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

export function getEmbeddingModelCacheDir(): string {
  const configured = process.env.ENGRAM_MODEL_CACHE_DIR;
  if (configured) {
    env.cacheDir = resolve(configured);
  }

  if (typeof env.cacheDir !== 'string' || env.cacheDir.length === 0) {
    throw new Error('Transformers.js did not provide a filesystem model cache directory.');
  }

  return resolve(env.cacheDir);
}

export async function loadEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  return withModelCachePopulationLock(async () => {
    const cacheDir = getEmbeddingModelCacheDir();
    await prepareEmbeddingModelCache(cacheDir);
    try {
      // Pinning the model revision gives recovery a separate, immutable cache
      // namespace instead of trusting mutable `main` artifacts.
      const extractor = await (pipeline as any)('feature-extraction', EMBEDDING_MODEL, {
        dtype: 'q8',
        revision: EMBEDDING_MODEL_REVISION,
      }) as FeatureExtractionPipeline;
      await sealEmbeddingModelCache(cacheDir);
      return extractor;
    } catch (error) {
      // A failed download or initialization cannot be allowed to poison the
      // next process. Only the pinned model subtree is removed.
      await removeEmbeddingModelCache(cacheDir);
      throw error;
    }
  });
}

/**
 * Validate a previously completed population before Transformers.js sees any
 * cached bytes. An unsealed or altered subtree is removed while holding the
 * inter-process lock, so a torn ONNX file cannot reach native Protobuf parsing.
 */
export async function prepareEmbeddingModelCache(cacheDir: string): Promise<'ready' | 'empty' | 'reset'> {
  const modelDir = embeddingModelCacheDir(cacheDir);
  try {
    await stat(modelDir);
  } catch (error) {
    if (isMissing(error)) return 'empty';
    throw error;
  }

  if (await hasValidCacheMarker(modelDir)) return 'ready';
  await removeEmbeddingModelCache(cacheDir);
  return 'reset';
}

export async function sealEmbeddingModelCache(cacheDir: string): Promise<void> {
  const modelDir = embeddingModelCacheDir(cacheDir);
  const files = await modelManifest(modelDir);
  if (files.length === 0) throw new Error(`Embedding model population produced no files: ${modelDir}`);
  assertRequiredModelFiles(files.map(file => file.path), modelDir);
  const marker: CacheMarker = {
    schema: CACHE_MARKER_SCHEMA,
    model: EMBEDDING_MODEL,
    revision: EMBEDDING_MODEL_REVISION,
    files,
  };
  const markerPath = join(modelDir, CACHE_MARKER_NAME);
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporaryPath, markerPath);
}

/**
 * Transformers.js writes downloads directly to their final cache paths. Guard
 * model construction with an inter-process lock and a validated completion
 * marker so parallel or interrupted cold starts cannot expose partial files.
 */
export async function withModelCachePopulationLock<T>(
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const cacheDir = getEmbeddingModelCacheDir();
  const lockDir = `${cacheDir}.engram-population.lock`;
  const ownerPath = `${lockDir}/owner.json`;
  const owner: LockOwner = {
    hostname: hostname(),
    nonce: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await recoverDeadLock(lockDir, ownerPath, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for model-cache population lock: ${lockDir}`, { cause: error });
      }
      await delay(pollMs);
    }
  }

  try {
    return await action();
  } finally {
    await releaseOwnedLock(lockDir, ownerPath, owner.nonce);
  }
}

async function recoverDeadLock(lockDir: string, ownerPath: string, staleMs: number): Promise<void> {
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(lockDir)).mtimeMs;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const owner = await readOwner(ownerPath);
  if (owner?.hostname === hostname()) {
    if (isProcessAlive(owner.pid)) return;
    await removeLockDirectory(lockDir);
    return;
  }
  // A missing/partial owner file may simply be the narrow mkdir-to-write race,
  // and a foreign PID cannot be checked safely. Recover either only by age.
  if (ageMs < staleMs) return;

  await removeLockDirectory(lockDir);
}

async function removeLockDirectory(lockDir: string): Promise<void> {

  try {
    await rm(lockDir, { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function embeddingModelCacheDir(cacheDir: string): string {
  return join(resolve(cacheDir), ...EMBEDDING_MODEL.split('/'), EMBEDDING_MODEL_REVISION);
}

async function removeEmbeddingModelCache(cacheDir: string): Promise<void> {
  const cacheRoot = resolve(cacheDir);
  const modelDir = embeddingModelCacheDir(cacheRoot);
  if (!modelDir.startsWith(`${cacheRoot}${sep}`)) {
    throw new Error('Refusing to remove an embedding cache outside the configured cache root');
  }
  try {
    await rm(modelDir, { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function hasValidCacheMarker(modelDir: string): Promise<boolean> {
  let marker: CacheMarker;
  try {
    marker = JSON.parse(await readFile(join(modelDir, CACHE_MARKER_NAME), 'utf8')) as CacheMarker;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return false;
    throw error;
  }
  if (marker.schema !== CACHE_MARKER_SCHEMA
    || marker.model !== EMBEDDING_MODEL
    || marker.revision !== EMBEDDING_MODEL_REVISION
    || !Array.isArray(marker.files)
    || marker.files.length === 0) return false;
  try {
    assertRequiredModelFiles(marker.files.map(file => file?.path), modelDir);
  } catch {
    return false;
  }

  for (const file of marker.files) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string'
      || !Number.isSafeInteger(file.size) || file.size < 0) return false;
    const path = resolve(modelDir, file.path);
    if (!path.startsWith(`${resolve(modelDir)}${sep}`)) return false;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size !== file.size) return false;
      if (await sha256(path) !== file.sha256) return false;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  return true;
}

function assertRequiredModelFiles(paths: unknown[], modelDir: string): void {
  for (const required of REQUIRED_MODEL_FILES) {
    if (!paths.includes(required)) {
      throw new Error(`Embedding model cache is incomplete (${required} missing): ${modelDir}`);
    }
  }
}

async function modelManifest(modelDir: string): Promise<CacheMarker['files']> {
  const paths = await regularFiles(modelDir);
  const files: CacheMarker['files'] = [];
  for (const path of paths) {
    const relativePath = relative(modelDir, path);
    if (relativePath === CACHE_MARKER_NAME || relativePath.includes(`${CACHE_MARKER_NAME}.`)) continue;
    const info = await stat(path);
    files.push({ path: relativePath, size: info.size, sha256: await sha256(path) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function regularFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function releaseOwnedLock(lockDir: string, ownerPath: string, nonce: string): Promise<void> {
  const currentOwner = await readOwner(ownerPath);
  if (currentOwner?.nonce !== nonce) return;

  try {
    await rm(lockDir, { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readOwner(ownerPath: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<LockOwner>;
    if (
      typeof value.hostname === 'string'
      && typeof value.nonce === 'string'
      && typeof value.pid === 'number'
      && typeof value.startedAt === 'string'
    ) {
      return value as LockOwner;
    }
    return null;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
