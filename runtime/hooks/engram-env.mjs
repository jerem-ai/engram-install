/**
 * engram-env — reader for ~/.config/engram/engram.env, the per-install settings file.
 *
 * One of four readers of the same format, held equal by test/install-config-parity.test.ts:
 * this file (hooks), src/lib/install-config.ts, extraction/install_config.py and
 * scripts/engram-env.sh. Format: KEY=VALUE lines, # comments, optional matching quotes,
 * and a leading ~ or $HOME expands to the home directory. Only ENGRAM_ENV_KEYS are
 * read; tenant identity never comes from this file (it stays in tenant.env).
 *
 * A missing file means no settings, so every consumer keeps its built-in default.
 * Jeremy's machines have no engram.env.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENGRAM_ENV_KEYS = Object.freeze([
  "ENGRAM_HOME", "KG_VAULT_PATH", "KG_DATA_DIR", "ENGRAM_RUNTIME_DIR", "ENGRAM_NODE",
  "ENGRAM_HTTP_URL", "ENGRAM_EXTRACT_BACKEND", "ENGRAM_CLI_DRIVER", "ENGRAM_MEMORY_ROOT",
  "ENGRAM_LABEL_PREFIX", "ENGRAM_USER_NAME", "ENGRAM_PERSONA", "ENGRAM_MEMORY_PROJECTS",
  "ENGRAM_STATE_DIR", "ENGRAM_NOTIFY", "ENGRAM_TENANT_ENV_FILE", "CODEX_HOME",
  "ENGRAM_MIN_SCORE", "ENGRAM_MCP_ADMISSION", "ENGRAM_SINCE_DAYS",
]);
const KEYS = new Set(ENGRAM_ENV_KEYS);

export function engramEnvPath(home = os.homedir()) {
  return path.join(home, ".config/engram/engram.env");
}

export function parseEngramEnv(text, home = os.homedir()) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || !KEYS.has(m[1])) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (value === "~" || value === "$HOME") value = home;
    else if (value.startsWith("~/")) value = home + value.slice(1);
    else if (value.startsWith("$HOME/")) value = home + value.slice(5);
    if (value) out[m[1]] = value;
  }
  return out;
}

/** Settings from the file, or {} when it is absent or unreadable. */
export function readEngramEnv(home = os.homedir()) {
  try { return parseEngramEnv(fs.readFileSync(engramEnvPath(home), "utf8"), home); } catch { return {}; }
}
