import { homedir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { readEngramEnv } from './install-config.js';

export interface DocRoot {
  project: string;
  root: string;
  globs: string[];
  host: string;
}

export interface GraphRoot {
  project: string;
  graphJsonPath: string;
  repoRoot: string;
  host: string;
}

export interface KGConfig {
  vaultPath: string;
  dataDir: string;
  dbPath: string;
  memoryBasePath?: string;
  docRoots?: DocRoot[];
  graphRoots?: GraphRoot[];
}

export interface ConfigOverrides {
  vaultPath?: string;
  dataDir?: string;
}

export function resolveConfig(overrides: ConfigOverrides): KGConfig {
  // Per-install settings (~/.config/engram/engram.env) come after flags and the
  // environment, so a machine without that file resolves exactly as before.
  const install = readEngramEnv();
  const vaultPath = overrides.vaultPath
    ?? process.env.KG_VAULT_PATH
    ?? install.KG_VAULT_PATH;

  if (!vaultPath) {
    throw new Error(
      'Vault path not configured. Set KG_VAULT_PATH or pass --vault-path.'
    );
  }

  const xdgData = process.env.XDG_DATA_HOME
    ?? join(homedir(), '.local', 'share');

  const dataDir = overrides.dataDir
    ?? process.env.KG_DATA_DIR
    ?? install.KG_DATA_DIR
    ?? join(xdgData, 'knowledge-graph');

  const memoryBasePath = process.env.KG_MEMORY_BASE;

  const docRoots = loadDocRoots(dataDir);
  const graphRoots = loadGraphRoots(dataDir);

  return {
    vaultPath,
    dataDir,
    dbPath: join(dataDir, 'kg.db'),
    memoryBasePath,
    docRoots,
    graphRoots,
  };
}

/**
 * Load graphRoots from KG_GRAPHS_CONFIG (a JSON file path) or <dataDir>/kg-graphs.json.
 * Accepts both a bare array and { graphRoots: [...] } object shape.
 * Defensive: malformed JSON or missing file → console.warn + return undefined.
 */
function loadGraphRoots(dataDir: string): GraphRoot[] | undefined {
  const configPath = process.env.KG_GRAPHS_CONFIG ?? join(dataDir, 'kg-graphs.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`kg-graphs: could not read ${configPath}: ${(err as Error)?.message}`);
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    // Accept both a bare array and { graphRoots: [...] }, mirroring the docRoots pattern.
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { graphRoots?: unknown })?.graphRoots;
    if (!Array.isArray(list)) {
      console.warn(`kg-graphs: ${configPath} must be a JSON array or { graphRoots: [...] } — ignoring`);
      return undefined;
    }
    return list as GraphRoot[];
  } catch (err) {
    console.warn(`kg-graphs: malformed JSON in ${configPath}: ${(err as Error)?.message} — ignoring`);
    return undefined;
  }
}

/**
 * Load docRoots from KG_DOCS_CONFIG (a JSON file path) or <dataDir>/kg-docs.json.
 * Defensive: malformed JSON or missing file → console.warn + return undefined.
 * Mirrors the tolerance of loadCorpusRelationTypes in parser.ts.
 */
function loadDocRoots(dataDir: string): DocRoot[] | undefined {
  const configPath = process.env.KG_DOCS_CONFIG ?? join(dataDir, 'kg-docs.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`kg-docs: could not read ${configPath}: ${(err as Error)?.message}`);
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    // Accept both a bare array and { docRoots: [...] }, mirroring how
    // loadCorpusRelationTypes accepts an array or { relationTypes: [...] }.
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { docRoots?: unknown })?.docRoots;
    if (!Array.isArray(list)) {
      console.warn(`kg-docs: ${configPath} must be a JSON array or { docRoots: [...] } — ignoring`);
      return undefined;
    }
    return list as DocRoot[];
  } catch (err) {
    console.warn(`kg-docs: malformed JSON in ${configPath}: ${(err as Error)?.message} — ignoring`);
    return undefined;
  }
}
