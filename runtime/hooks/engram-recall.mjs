#!/opt/homebrew/bin/node
/**
 * engram-recall — Claude Code UserPromptSubmit hook.
 *
 * Gives Claude Code sessions (which do NOT route through the OpenClaw gateway)
 * the same Engram recall the rest of the agent stack gets. The selection path
 * lives in hooks/recall-core.mjs, shared with the Codex hook and the Hermes
 * provider; this file only adapts Claude's hook contract.
 *
 * Contract:
 *   stdin  = JSON { prompt, cwd, session_id, transcript_path, hook_event_name, ... }
 *   stdout = JSON { hookSpecificOutput: { hookEventName: "UserPromptSubmit",
 *                                         additionalContext: <block> } }
 *   exit 0 always (fail-open: never block a prompt on recall failure).
 *
 * Installed as a copy at ~/.claude/hooks/engram-recall.mjs. The core is loaded
 * from the runtime release first (ENGRAM_RUNTIME_DIR or
 * ~/Services/engram-runtime/current), then from this file's own directory.
 *
 * Kill-switch: create ~/.claude/.engram-recall-off to disable.
 * Receipts: ~/.claude/logs/engram-recall-events.jsonl (source "claude").
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
// Claude Code's own config dir: CLAUDE_CONFIG_DIR when the user moved it, else ~/.claude.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const LOG_FILE = path.join(CLAUDE_DIR, "logs/engram-recall.log");

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
  if (fs.existsSync(path.join(CLAUDE_DIR, ".engram-recall-off"))) return;
  const core = await loadCore(LOG_FILE);
  if (!core) return;
  const event = await core.readStdinJson();
  if (!event) return;
  const { block } = await core.recallTurn(event, {
    source: "claude",
    eventFile: path.join(CLAUDE_DIR, "logs/engram-recall-events.jsonl"),
    logFile: LOG_FILE,
    nodeCache: path.join(CLAUDE_DIR, `.engram-node-${os.hostname()}`),
    readThread: (gate) => gate.readThread(event?.transcript_path, event?.prompt),
  });
  if (block) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } }));
}

main().catch(() => {}).finally(() => process.exit(0));
