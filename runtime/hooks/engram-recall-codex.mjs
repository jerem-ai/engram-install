#!/opt/homebrew/bin/node
/**
 * engram-recall-codex — Codex CLI UserPromptSubmit hook (Codex 0.159.3 contract,
 * verified October 10 with a dry hook against the real binary).
 *
 *   stdin  = JSON { session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, prompt }
 *   stdout = JSON { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: <block> } }
 *            (Codex adds it as a developer message for this turn)
 *   exit 0 always (fail-open: never block a prompt on recall failure).
 *
 * Same selection path as the Claude hook (hooks/recall-core.mjs). Run it from the
 * runtime release path so releases update it without changing the hook's trust hash:
 *   /opt/homebrew/bin/node ~/Services/engram-runtime/current/hooks/engram-recall-codex.mjs
 *
 * Kill-switch: create ~/.codex/.engram-recall-off to disable.
 * Receipts: ~/.codex/logs/engram-recall-events.jsonl (source "codex").
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const LOG_FILE = path.join(CODEX_HOME, "logs/engram-recall.log");

// Per-install settings from ~/.config/engram/engram.env, read by the module beside this
// file. Absent file or module: no settings, so the defaults below apply.
async function installSettings() {
  try { return (await import(new URL("./engram-env.mjs", import.meta.url).href)).readEngramEnv(); } catch { return {}; }
}

// Release core first, then the copy beside this file. A release core that exists but fails to
// import is logged (not mistaken for "missing") before the fallback is used.
async function loadCore(logFile) {
  const runtime = process.env.ENGRAM_RUNTIME_DIR || (await installSettings()).ENGRAM_RUNTIME_DIR
    || path.join(HOME, "Services/engram-runtime/current");
  const why = (e) => String(e?.code ?? e?.name ?? "error").slice(0, 40);
  const note = (msg) => { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} | ${msg}\n`); } catch { /* non-fatal */ } };
  let release;
  try { return await import(pathToFileURL(path.join(runtime, "hooks/recall-core.mjs")).href); } catch (e) { release = why(e); }
  if (release !== "ERR_MODULE_NOT_FOUND") note(`startup | WARN=core-release-import:${release}`);
  try { return await import(new URL("./recall-core.mjs", import.meta.url).href); } catch (e) {
    note(`query=<error> | hits=0 | injected=false | err=core-missing release=${release} sibling=${why(e)}`);
    return null;
  }
}

async function main() {
  if (fs.existsSync(path.join(CODEX_HOME, ".engram-recall-off"))) return;
  const core = await loadCore(LOG_FILE);
  if (!core) return;
  const event = await core.readStdinJson();
  if (!event) return;
  const { block } = await core.recallTurn(event, {
    source: "codex",
    eventFile: path.join(CODEX_HOME, "logs/engram-recall-events.jsonl"),
    logFile: LOG_FILE,
    nodeCache: path.join(CODEX_HOME, `.engram-node-${os.hostname()}`),
    readThread: (gate) => gate.readCodexThread(event?.transcript_path, event?.prompt),
  });
  if (block) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } }));
}

main().catch(() => {}).finally(() => process.exit(0));
