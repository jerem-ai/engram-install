#!/usr/bin/env node
/**
 * Register Engram recall as a Codex UserPromptSubmit hook and record its trust.
 *
 *   node install-codex-recall-hook.mjs [--status | --ensure-trust | --uninstall] [--codex <bin>] [--hooks <hooks.json>] [--runtime <dir>]
 *
 * 1. Adds one handler to ~/.codex/hooks.json (dated backup first; no change when
 *    present). Its command runs the runtime release's hooks/engram-recall-codex.mjs,
 *    so later releases need no new trust.
 * 2. Asks Codex's own app-server for the hook's current hash (`hooks/list`) and
 *    records it with `config/batchWrite`, the same two calls the /hooks screen
 *    makes when a person trusts a hook. Codex never runs an untrusted hook.
 * --status prints the hook's trust state and changes nothing.
 * --ensure-trust (nightly) never registers anything. Codex keys trust by the hook's position in hooks.json,
 * so a group inserted ahead of ours drops its trust; this re-trusts only the exact, enabled command and
 * reports `action` (none | re-trusted | absent | disabled) so the caller can alert.
 * --uninstall removes exactly the command this script writes (and any group it leaves
 * empty) from hooks.json, with a dated backup, and never starts Codex. Its trust entry
 * in config.toml is left behind; it names a hook that no longer exists.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  status: { type: "boolean", default: false },
  "ensure-trust": { type: "boolean", default: false },
  uninstall: { type: "boolean", default: false },
  codex: { type: "string", default: "codex" },
  hooks: { type: "string", default: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json") },
  runtime: { type: "string", default: path.join(os.homedir(), "Services/engram-runtime/current") },
  node: { type: "string", default: "/opt/homebrew/bin/node" },
} });

const ENTRY = "hooks/engram-recall-codex.mjs";
const COMMAND = `${values.node} ${path.join(values.runtime, ENTRY)}`;
const HANDLER = { type: "command", command: COMMAND, timeout: 10, statusMessage: "Recalling Engram memory" };

// Trust is granted only to the exact command this script writes. Any other command that names the
// entry file (edited, chained, pointed elsewhere) is refused, never registered or trusted.
function isOurs(command) { return command === COMMAND; }
function lookalikes(commands) { return commands.filter((c) => typeof c === "string" && c.includes(ENTRY) && c !== COMMAND); }

function register() {
  const file = values.hooks;
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { hooks: {} };
  config.hooks ??= {};
  const groups = (config.hooks.UserPromptSubmit ??= []);
  const odd = lookalikes(groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
  if (odd.length) throw new Error(`refusing: ${file} has a modified Engram recall command: ${JSON.stringify(odd)}`);
  if (groups.some((g) => (g.hooks ?? []).some((h) => isOurs(h.command)))) return { changed: false, file };
  if (fs.existsSync(file)) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    fs.copyFileSync(file, `${file}.bak-${stamp}-engram`, fs.constants.COPYFILE_EXCL);
  }
  groups.push({ hooks: [HANDLER] });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.renameSync(tmp, file);
  return { changed: true, file };
}

function appServer() {
  const child = spawn(values.codex, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(JSON.stringify(m.error)));
    else w.resolve(m.result);
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${method} timed out`)); }, 30000).unref();
  });
  return { request, notify: (method) => child.stdin.write(JSON.stringify({ method }) + "\n"), close: () => child.kill() };
}

async function ourHook(server, { allowAbsent = false } = {}) {
  const list = await server.request("hooks/list", { cwds: [os.homedir()] });
  const all = list.data.flatMap((e) => e.hooks);
  const odd = lookalikes(all.map((h) => h.command));
  if (odd.length) throw new Error(`refusing: Codex sees a modified Engram recall command: ${JSON.stringify(odd)}`);
  const hooks = all.filter((h) => isOurs(h.command));
  if (allowAbsent && hooks.length === 0) return null;
  if (hooks.length !== 1) throw new Error(`expected one Engram recall hook, found ${hooks.length}`);
  return hooks[0];
}

function unregister() {
  const file = values.hooks;
  if (!fs.existsSync(file)) return { action: "absent", file };
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const groups = config.hooks?.UserPromptSubmit ?? [];
  if (!groups.some((g) => (g.hooks ?? []).some((h) => isOurs(h.command)))) return { action: "absent", file };
  const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command)) }))
    .filter((g) => g.hooks.length > 0);
  if (kept.length) config.hooks.UserPromptSubmit = kept;
  else delete config.hooks.UserPromptSubmit;
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  if (!fs.existsSync(`${file}.bak-${stamp}-engram`)) fs.copyFileSync(file, `${file}.bak-${stamp}-engram`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.renameSync(tmp, file);
  return { action: "removed", file };
}

async function main() {
  if (values.uninstall) { console.log(JSON.stringify(unregister())); return; }
  const ensure = values["ensure-trust"];
  const registered = values.status || ensure ? null : register();
  const server = appServer();
  try {
    await server.request("initialize", { clientInfo: { name: "engram-install-codex-recall-hook", version: "1" } });
    server.notify("initialized");
    let hook = await ourHook(server, { allowAbsent: ensure });
    let action = "none";
    if (!hook) { console.log(JSON.stringify({ action: "absent" })); return; }
    if (ensure && hook.enabled === false) { console.log(JSON.stringify({ action: "disabled", key: hook.key })); return; }
    if (!values.status && hook.trustStatus !== "trusted") {
      action = "re-trusted";
      await server.request("config/batchWrite", { edits: [{ keyPath: "hooks.state", mergeStrategy: "upsert",
        value: { [hook.key]: { trusted_hash: hook.currentHash } } }], filePath: null, expectedVersion: null, reloadUserConfig: true });
      hook = await ourHook(server);
    }
    const out = { ...(ensure ? { action } : { registered }), key: hook.key, command: hook.command, trustStatus: hook.trustStatus, currentHash: hook.currentHash, enabled: hook.enabled };
    console.log(JSON.stringify(out, null, 1));
    if (!values.status && hook.trustStatus !== "trusted") process.exitCode = 1;
  } finally { server.close(); }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
