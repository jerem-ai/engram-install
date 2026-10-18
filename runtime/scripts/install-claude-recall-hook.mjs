#!/usr/bin/env node
/**
 * Register (or remove) Engram recall as a Claude Code UserPromptSubmit hook.
 *
 *   node install-claude-recall-hook.mjs [--status | --uninstall] [--settings <settings.json>] [--runtime <dir>] [--node <bin>]
 *
 * The handler runs the runtime release's hooks/engram-recall.mjs, so a new release
 * needs no settings change. settings.json defaults to $CLAUDE_CONFIG_DIR/settings.json,
 * else ~/.claude/settings.json. Registering is idempotent and backs the file up once
 * per day first; a command that names the hook file but differs from ours is refused,
 * never rewritten. --uninstall removes exactly our command and any group it leaves
 * empty. Used by scripts/install-local.sh; Jeremy's own hook is a copied file that
 * this script never touches.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const { values } = parseArgs({ options: {
  status: { type: "boolean", default: false },
  uninstall: { type: "boolean", default: false },
  settings: { type: "string", default: path.join(claudeDir, "settings.json") },
  runtime: { type: "string", default: path.join(os.homedir(), "Engram/current/runtime") },
  node: { type: "string", default: process.execPath },
} });

const ENTRY = "hooks/engram-recall.mjs";
const COMMAND = `${values.node} ${path.join(values.runtime, ENTRY)}`;
const HANDLER = { type: "command", command: COMMAND, timeout: 10 };

function load(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function save(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const backup = `${file}.bak-${stamp}-engram`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.renameSync(tmp, file);
}

const commands = (groups) => groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));

function main() {
  const file = values.settings;
  const config = load(file);
  const groups = config.hooks?.UserPromptSubmit ?? [];
  const ours = commands(groups).filter((c) => c === COMMAND).length;
  const odd = commands(groups).filter((c) => typeof c === "string" && c.includes(ENTRY) && c !== COMMAND);
  if (values.status) {
    console.log(JSON.stringify({ settings: file, registered: ours > 0, command: COMMAND, lookalikes: odd }));
    return;
  }
  if (values.uninstall) {
    if (!ours) { console.log(JSON.stringify({ action: "absent", settings: file })); return; }
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.command !== COMMAND) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) config.hooks.UserPromptSubmit = kept;
    else delete config.hooks.UserPromptSubmit;
    if (config.hooks && Object.keys(config.hooks).length === 0) delete config.hooks;
    save(file, config);
    console.log(JSON.stringify({ action: "removed", settings: file }));
    return;
  }
  if (odd.length) throw new Error(`refusing: ${file} has a modified Engram recall command: ${JSON.stringify(odd)}`);
  if (ours) { console.log(JSON.stringify({ action: "none", settings: file, command: COMMAND })); return; }
  config.hooks ??= {};
  (config.hooks.UserPromptSubmit ??= []).push({ hooks: [HANDLER] });
  save(file, config);
  console.log(JSON.stringify({ action: "registered", settings: file, command: COMMAND }));
}

try { main(); } catch (e) { console.error(String(e?.message ?? e)); process.exit(1); }
