import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reader for ~/.config/engram/engram.env, the per-install settings file written by
 * scripts/install-local.sh. Same format and key list as hooks/engram-env.mjs,
 * extraction/install_config.py and scripts/engram-env.sh; the four are held equal by
 * test/install-config-parity.test.ts.
 *
 * Settings from this file only fill gaps: an explicit flag or an environment
 * variable a consumer already honored keeps priority, and a missing file leaves
 * every built-in default in place. Tenant identity never comes from here.
 */
export const ENGRAM_ENV_KEYS = Object.freeze([
  'ENGRAM_HOME', 'KG_VAULT_PATH', 'KG_DATA_DIR', 'ENGRAM_RUNTIME_DIR', 'ENGRAM_NODE',
  'ENGRAM_HTTP_URL', 'ENGRAM_EXTRACT_BACKEND', 'ENGRAM_CLI_DRIVER', 'ENGRAM_MEMORY_ROOT',
  'ENGRAM_LABEL_PREFIX', 'ENGRAM_USER_NAME', 'ENGRAM_PERSONA', 'ENGRAM_MEMORY_PROJECTS',
  'ENGRAM_STATE_DIR', 'ENGRAM_NOTIFY', 'ENGRAM_TENANT_ENV_FILE', 'CODEX_HOME',
  'ENGRAM_MIN_SCORE', 'ENGRAM_MCP_ADMISSION', 'ENGRAM_SINCE_DAYS',
] as const);

export type EngramEnvKey = typeof ENGRAM_ENV_KEYS[number];
export type EngramEnv = Partial<Record<EngramEnvKey, string>>;

const KEYS = new Set<string>(ENGRAM_ENV_KEYS);

export function engramEnvPath(home: string = homedir()): string {
  return join(home, '.config/engram/engram.env');
}

export function parseEngramEnv(text: string, home: string = homedir()): EngramEnv {
  const out: EngramEnv = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || !KEYS.has(m[1])) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (value === '~' || value === '$HOME') value = home;
    else if (value.startsWith('~/')) value = home + value.slice(1);
    else if (value.startsWith('$HOME/')) value = home + value.slice(5);
    if (value) out[m[1] as EngramEnvKey] = value;
  }
  return out;
}

/** Settings from the file, or {} when it is absent or unreadable. */
export function readEngramEnv(home: string = homedir()): EngramEnv {
  let text: string;
  try {
    text = readFileSync(engramEnvPath(home), 'utf8');
  } catch {
    return {};
  }
  return parseEngramEnv(text, home);
}
