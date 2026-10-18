/**
 * recall-core — per-prompt Engram recall shared by every injector entrypoint.
 *
 * One selection path for Claude Code (hooks/engram-recall.mjs), Codex
 * (hooks/engram-recall-codex.mjs) and Hermes (hooks/engram-recall-hermes.mjs):
 * query filter, kg-http /memory/search with a CLI fallback, the released floor,
 * the relevance gate, dedupe and out-of-force/verify_live drops, the top-3 cut, the
 * <engram_recall> block, and one body-free receipt per prompt. Entrypoints only
 * adapt their agent's input and output and choose where receipts go.
 *
 * Never throws for a recall problem: every failure ends as "no block".
 */
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SOURCES = new Set(["claude", "codex", "hermes"]);
const TOP_K = 3;
// 3, not 8: an 8-char floor drops legit short queries ("fix kg", "redo p2")
// purely on length. The content-token gate (isLowSignal) is the real signal
// filter; let it decide, don't override it with a blunt char count. (Adopted
// from Hermes's mini-side tuning.)
const MIN_QUERY_LEN = 3;
const LOG_MAX_BYTES = 512 * 1024;   // one generation, then recycle

// Per-install settings (~/.config/engram/engram.env). They only fill gaps: an env
// override that worked before still wins, and with no file (Jeremy's machines)
// every default below is unchanged. A missing reader module means no settings.
let readEngramEnv = () => ({});
try { ({ readEngramEnv } = await import("./engram-env.mjs")); } catch { /* older layout: defaults */ }
export function installSettings() { return readEngramEnv(); }

export function runtimeDir(env = process.env, conf = installSettings()) {
  // The runtime is a release, never a dev checkout (2026-09-25 cutover). ENGRAM_RUNTIME_DIR overrides it.
  return env.ENGRAM_RUNTIME_DIR || conf.ENGRAM_RUNTIME_DIR || path.join(os.homedir(), "Services/engram-runtime/current");
}

/** Where the CLI fallback reads the index: engram.env, else Jeremy's layout. */
export function cliPaths(conf = installSettings()) {
  return {
    dataDir: conf.KG_DATA_DIR || path.join(os.homedir(), ".local/share/knowledge-graph"),
    vaultPath: conf.KG_VAULT_PATH || path.join(os.homedir(), "claude-vault/vault"),
  };
}

/** kg-http search endpoint: ENGRAM_SEARCH_URL, then engram.env's base URL, then the default. */
export function searchUrl(env = process.env, conf = installSettings()) {
  if (env.ENGRAM_SEARCH_URL !== undefined) return env.ENGRAM_SEARCH_URL;
  if (conf.ENGRAM_HTTP_URL) return conf.ENGRAM_HTTP_URL.replace(/\/+$/, "") + "/memory/search";
  return "http://127.0.0.1:3737/memory/search";
}

// The kg CLI links a native better-sqlite3 (.node) that loads only under a
// matching NODE_MODULE_VERSION. The right runtime varies by machine and rebuild
// (laptop's build loads only under modver 127; the mini's loads under 127 and
// 141), so matching a hardcoded modver is wrong. Instead pick the first
// candidate node that can ACTUALLY load better-sqlite3 — the definitive,
// self-calibrating test. ENGRAM_KG_NODE forces an explicit binary.
// Cache the resolved node per-machine (~/.claude may sync across hosts) and key it
// to the native module and node binary mtimes, so either replacement invalidates it.
// Steady state: statSync + readFileSync, ZERO probe execs. The full probe runs
// only on first use or after a better-sqlite3 rebuild (mtime change), then re-caches.
function resolveNodeBin(runtime, cacheFile, conf) {
  const sqlite = path.join(runtime, "node_modules/better-sqlite3");
  const candidates = [process.env.ENGRAM_KG_NODE, conf.ENGRAM_NODE, path.join(os.homedir(), ".local/bin/node"),
    "/opt/homebrew/bin/node", "/usr/local/bin/node", "node"].filter(Boolean);
  let stamp = "";
  try { stamp = String(fs.statSync(path.join(sqlite, "build/Release/better_sqlite3.node")).mtimeMs); } catch { /* none */ }
  try {
    const { bin, mtime, binMtime, probe } = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (probe === "open-memory-v1" && mtime === stamp && bin && fs.statSync(bin).mtimeMs === binMtime) return { bin, ok: true };
  } catch { /* miss */ }
  for (const cand of candidates) {
    try {
      execFileSync(cand, ["-e", `new (require(${JSON.stringify(sqlite)}))(":memory:").close()`], { timeout: 2500, stdio: "ignore" });
      try { fs.writeFileSync(cacheFile, JSON.stringify({ bin: cand, mtime: stamp, binMtime: fs.statSync(cand).mtimeMs, probe: "open-memory-v1" })); } catch { /* non-fatal */ }
      return { bin: cand, ok: true }; // this node can load the kg's native module → correct runtime
    } catch { /* candidate missing or can't load the native module — try next */ }
  }
  return { bin: candidates[0], ok: false }; // none loaded: spawn will fail; flagged in the log
}

// Tenant identity: the CLI refuses every DB connection without these (PR #10).
// Single source of truth is ~/.config/engram/tenant.env (plain KEY=VALUE lines); an
// install may name another file in engram.env.
function tenantEnv(conf) {
  const out = {};
  try {
    const text = fs.readFileSync(conf.ENGRAM_TENANT_ENV_FILE || path.join(os.homedir(), ".config/engram/tenant.env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^(ENGRAM_TENANT_ID|ENGRAM_PRINCIPAL_ID)=(.+)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* fail-open: CLI will exit nonzero and the hook logs err=exit */ }
  return out;
}

function readPolicy(runtime, conf) {
  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(path.join(runtime, "config/recall.json"), "utf8")); } catch { /* below */ }
  // The runtime release owns the floor for every injector. A missing or invalid
  // policy disables injection without blocking the prompt; an explicit override
  // remains supported (including zero). An install may set its own floor in engram.env.
  const override = process.env.ENGRAM_MIN_SCORE ?? conf.ENGRAM_MIN_SCORE;
  const score = override === undefined ? policy?.minScore : Number(override);
  const minScore = policy && typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
  // Relevance gate mode from the same released policy: off | shadow | enforce.
  // Shadow records the gate decision in each receipt and injects as before.
  // Anything unreadable means off. The gate itself fails open.
  const gateMode = ["off", "shadow", "enforce"].includes(policy?.relevanceGate) ? policy.relevanceGate : "off";
  return { minScore, gateMode };
}

// Never log raw prompt text. Until 2026-08-05 this log stored the first 60 chars
// of every real prompt, world-readable (0644) and unrotated at 217KB. A length plus
// a short digest keeps the diagnostic value (spot empty/huge queries, correlate
// repeats) without putting the user's actual words on disk.
export function qtag(q) {
  const s = typeof q === "string" ? q : "";
  const h = createHash("sha256").update(s).digest("hex").slice(0, 8);
  return `q=len${s.length}/${h}`;
}

function stripBracketPrefixes(text) {
  return text.replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim();
}

// Stopwords + low-info tokens. Anaphoric/conversational turns ("yeah do both",
// "what about now", "what are your recs for those last 2 things") carry no
// standalone retrievable intent — recall against them returns only noise. If
// fewer than 2 content tokens remain, skip recall entirely (saves the kg spawn;
// the score floor would drop the results anyway).
const STOP = new Set(("a an and the of to in on for with is are was were be been being do does did done yes yeah yep " +
  "no nope ok okay sure please thanks thank you your i me my we us our it its this that these those them they he she " +
  "his her now then here there what which who whom whose how why when where can could would should will shall may " +
  "might must just only also too very really actually basically maybe perhaps thing things stuff one last next more " +
  "most some any all both each either neither about above below over under again still even much many lot lots got " +
  "get go going gonna let lets ya yea oh hm hmm wow huh cool nice damn lol haha hey yo ah eh um uh").split(/\s+/));

// length >= 2 (not 3): short identifiers like kg/p2/db/ci/qr are the highest-
// signal tokens here, not noise. Interjections of that length live in STOP.
function contentTokens(q) {
  return q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2 && !STOP.has(t));
}
function isLowSignal(q) { return contentTokens(q).length < 2; }

/**
 * Prompts that are automation, not a person's turn: completed Claude background
 * jobs (whole <task-notification> envelopes, so a question quoting one still
 * reaches recall) and Codex goal continuations (<codex_internal_context>).
 */
export function isAutomationPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return false;
  let rest = prompt.trim();
  if (rest.startsWith("<codex_internal_context")) return true;
  while (rest.startsWith("<task-notification>")) {
    const end = rest.indexOf("</task-notification>");
    if (end < 0) return false;
    rest = rest.slice(end + "</task-notification>".length).trim();
  }
  return rest.length === 0;
}

// Harness envelopes are not the user's words: Conductor opens every workspace with
// a <system_instruction> block, and reminders arrive as <system-reminder>. Only
// whole blocks starting on their own line are removed, so a question that names
// the tag inline is still searched (adjudication batch-001 C04).
const ENVELOPE = /^[ \t]*<(system_instruction|system-reminder)>[\s\S]*?<\/\1>[ \t]*$/gm;
function stripEnvelopes(text) { return text.replace(ENVELOPE, " "); }

export function extractQuery(prompt) {
  let p = typeof prompt === "string" ? prompt : "";
  p = stripBracketPrefixes(stripEnvelopes(p).trim());
  // Skip slash-command invocations — they're tool routing, not recall queries.
  if (p.startsWith("/")) return null;
  if (p.length < MIN_QUERY_LEN) return null;
  if (isLowSignal(p)) return null;
  return p.slice(0, 300);
}

function fmtDate(created) {
  if (!created) return null;
  try { return new Date(created).toISOString().slice(0, 10); } catch { return null; }
}

const coerce = (v) => v === true || (typeof v === "string" && v.toLowerCase() === "true");
function isCanonicalHit(r) {
  const component = r?.frontmatter?.component_of ?? r?.frontmatter?.metadata?.component_of;
  if (typeof component === "string" && component.trim()) return false;
  return coerce(r?.frontmatter?.canonical);
}
// Currency rule, a copy of src/lib/memory-currency.ts (isStale, memoryAge) for
// injectors that run without the compiled runtime. test/memory-currency-parity.test.ts
// holds every copy to the TypeScript rule. A memory is out of force when it is
// marked stale, names a non-empty superseded_by, or has a valid_to at or before
// now (top level or metadata). Unparseable dates never expire anything, and age
// alone never makes a memory stale.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;
function instantMs(value) {
  if (typeof value !== "string") return NaN;
  const m = ISO_INSTANT.exec(value.trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, , zone] = m;
  if (+mo < 1 || +mo > 12 || +h > 23 || +mi > 59 || +s > 59) return NaN;
  if (+d < 1 || +d > new Date(Date.UTC(+y, +mo, 0)).getUTCDate()) return NaN;
  if (zone !== "Z") {
    const zh = +zone.slice(1, 3), zm = +(zone.includes(":") ? zone.slice(4, 6) : zone.slice(3, 5));
    if (zh > 14 || zm > 59 || (zh === 14 && zm !== 0)) return NaN;
  }
  return Date.parse(value.trim());
}
export function isOutOfForce(fm, now = Date.now()) {
  if (!fm || typeof fm !== "object") return false;
  const coerce = (v) => v === true || (typeof v === "string" && v.toLowerCase() === "true");
  const marked = (o) => coerce(o.stale) || (typeof o.superseded_by === "string" && o.superseded_by.trim().length > 0)
    || (Boolean(o.valid_to) && instantMs(o.valid_to) <= now);
  const meta = fm.metadata && typeof fm.metadata === "object" ? fm.metadata : null;
  return marked(fm) || Boolean(meta && marked(meta));
}
/** Whole days since created, for project and reference memories only; null otherwise. */
export function memoryAgeDays(fm, now = Date.now()) {
  const meta = fm?.metadata && typeof fm.metadata === "object" ? fm.metadata : undefined;
  const type = fm?.type ?? meta?.type;
  if (type !== "project" && type !== "reference") return null;
  const created = instantMs(fm?.created ?? meta?.created);
  return Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 86_400_000)) : null;
}
function isStaleHit(r)      { return isOutOfForce(r?.frontmatter); }
function isVerifyLiveHit(r) { return coerce(r?.frontmatter?.verify_live) || coerce(r?.frontmatter?.metadata?.verify_live); }

function appendLog(file, parts) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Rotate before appending so the file cannot grow without bound.
    try { if (fs.statSync(file).size >= LOG_MAX_BYTES) fs.renameSync(file, file + ".1"); } catch { /* no log yet */ }
    fs.appendFileSync(file, [new Date().toISOString(), ...parts].join(" | ") + "\n", "utf8");
    // Owner-only. Cheap next to the node spawn this hook already does.
    try { fs.chmodSync(file, 0o600); } catch { /* non-fatal */ }
  } catch { /* non-fatal */ }
}

/**
 * One turn of recall.
 *   event:   { prompt, session_id, cwd } from the agent.
 *   options: { source, eventFile, logFile, nodeCache, readThread(gateModule) -> { turns, bytes, truncated } }
 * Returns { block, outcome, injected } where block is the <engram_recall> text or null.
 */
export async function recallTurn(event, { source, eventFile, logFile, nodeCache, readThread }) {
  if (!SOURCES.has(source)) throw new Error(`unknown recall source ${source}`);
  const conf = installSettings();
  const runtime = runtimeDir(process.env, conf);
  const { minScore: MIN_SCORE, gateMode: GATE_MODE } = readPolicy(runtime, conf);
  const log = (parts) => appendLog(logFile, parts);
  const HTTP_URL = searchUrl(process.env, conf);
  const { dataDir: CLI_DATA_DIR, vaultPath: CLI_VAULT_PATH } = cliPaths(conf);
  const HTTP_TIMEOUT_MS = Number(process.env.ENGRAM_HTTP_TIMEOUT ?? 1500);
  const TIMEOUT_MS = Number(process.env.ENGRAM_SEARCH_TIMEOUT ?? 6000); // ~2s headroom under the 8s hook cap
  let gate = null; // { mod, policy, ctx } once loaded for this turn
  const gateDecisions = new Map();
  // Completed background jobs are not conversation turns: no search, no receipt.
  if (isAutomationPrompt(event?.prompt)) {
    log(["query=<automation>", "hits=0", "injected=false", "reason=automation_skip"]);
    return { block: null, outcome: "automation", injected: 0 };
  }
  const node = resolveNodeBin(runtime, nodeCache, conf);
  let receipt = { schema: 1, source, turn_id: randomUUID(), started_ms: Date.now(),
    timestamp: new Date().toISOString(), session_hash: createHash("sha256").update(String(event?.session_id ?? "")).digest("hex"),
    query_tag: qtag(event?.prompt), candidates: [] };
  // An overridden floor is recorded, so a run under ENGRAM_MIN_SCORE (env or engram.env)
  // shows the floor it actually used. With no override the receipt is unchanged.
  const floorSource = process.env.ENGRAM_MIN_SCORE !== undefined ? "env" : conf.ENGRAM_MIN_SCORE !== undefined ? "engram.env" : null;
  if (floorSource) Object.assign(receipt, { floor: MIN_SCORE, floor_source: floorSource });

  function finish(injected, outcome) {
    if (!receipt) return;
    try {
      fs.mkdirSync(path.dirname(eventFile), { recursive: true });
      try { if (fs.statSync(eventFile).size >= 8 * 1024 * 1024) fs.renameSync(eventFile, eventFile + ".1"); } catch { /* first event */ }
      fs.appendFileSync(eventFile, JSON.stringify({ ...receipt, injected, outcome,
        ms: Date.now() - receipt.started_ms, usage: "unreviewed" }) + "\n", { mode: 0o600 });
      fs.chmodSync(eventFile, 0o600);
    } catch { /* Observability cannot block a prompt. */ }
    receipt = null;
  }

  async function loadGate(query) {
    if (GATE_MODE === "off") return;
    const t0 = Date.now();
    const g = { mode: GATE_MODE, version: null, ontology_version: null, conversation_project: null,
      thread_turns: 0, thread_bytes: 0, thread_truncated: false, ms: 0, error: null };
    try {
      const mod = await import(pathToFileURL(path.join(runtime, "hooks/relevance-gate.mjs")).href);
      const policy = mod.loadPolicy(runtime);
      const thread = readThread(mod);
      const project = mod.conversationProject(policy, event?.cwd);
      gate = { mod, policy, ctx: { query, thread: thread.turns, project } };
      Object.assign(g, { version: mod.GATE_VERSION, ontology_version: policy.version, conversation_project: project,
        thread_turns: thread.turns.length, thread_bytes: thread.bytes, thread_truncated: thread.truncated });
    } catch (e) {
      gate = null;
      g.error = String(e?.code ?? e?.name ?? "error").slice(0, 40);
    }
    g.ms = Date.now() - t0;
    if (receipt) receipt.gate = g;
  }

  function gateDecision(r) {
    if (!gate) return null;
    try { return gate.mod.decide(gate.policy, gate.ctx, r); } catch { return { decision: "keep", reason: "gate_error" }; }
  }

  function recordCandidates(candidates, selected = []) {
    if (!receipt) return;
    const seen = new Set();
    receipt.candidates = candidates.map((r) => {
      let reason;
      if (typeof r.score === "number" && r.score < MIN_SCORE) reason = "floor";
      else if (seen.has(r.nodeId)) reason = "duplicate";
      else {
        seen.add(r.nodeId);
        reason = isStaleHit(r) ? "stale" : isVerifyLiveHit(r) ? "verify-live"
          : selected.includes(r) ? "injected" : gateDecisions.get(r)?.decision === "reject" && GATE_MODE === "enforce" ? "gate" : "capacity";
      }
      const g = gateDecisions.get(r);
      return { node_id: r.nodeId, score: r.score, cosine: r.cosine, bm25: r.bm25, reason,
        age_days: memoryAgeDays(r?.frontmatter),
        evidence_event: r.frontmatter?.metadata?.history_event_id ?? null,
        evidence: r.evidence ?? null,
        source_session: r.frontmatter?.metadata?.source_session ?? null,
        ...(g ? { gate: { ...g, decision: g.decision === "reject" && GATE_MODE === "shadow" ? "would_reject" : g.decision } } : {}) };
    });
  }

  // Resident-server path (2026-09-12): kg-http keeps the embedding model loaded and
  // answers in ~50 ms; from the laptop it is the same address through the ssh tunnel.
  // One GET, no MCP session. Any failure (tunnel down, old server without the route,
  // timeout) falls back to the CLI spawn below, which is the pre-existing path.
  async function httpSearch(query) {
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
    try {
      const u = new URL(HTTP_URL);
      u.searchParams.set("q", query); u.searchParams.set("limit", String(TOP_K));
      const res = await fetch(u, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) return null;
      const results = await res.json();
      if (!Array.isArray(results)) return null;
      return { results, ms: Date.now() - t0 };
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  function composeAndLog(query, results, src) {
    const candidates = Array.isArray(results) ? results : [];
    for (const r of candidates) { const d = gateDecision(r); if (d) gateDecisions.set(r, d); }
    recordCandidates(candidates);
    if (!Array.isArray(results) || results.length === 0) {
      log([qtag(query), src, "hits=0", "injected=false"]);
      return null;
    }

    // Relevance floor: drop sub-threshold hits before anything else. Nothing
    // clears it → inject nothing (no low-score noise on contextless turns).
    const belowFloor = results.length;
    results = results.filter((r) => typeof r.score !== "number" || r.score >= MIN_SCORE);
    if (results.length === 0) {
      log([qtag(query), src, "hits=0", "injected=false", `floor=${MIN_SCORE}`, `dropped=${belowFloor}`]);
      return null;
    }

    // Dedup by nodeId, drop stale + volatile (verify_live) hits — same rules as the plugin.
    const seen = new Set();
    let droppedStale = 0, droppedVolatile = 0;
    const unique = results.filter((r) => {
      if (seen.has(r.nodeId)) return false;
      seen.add(r.nodeId);
      if (isStaleHit(r))      { droppedStale += 1;    return false; }
      if (isVerifyLiveHit(r)) { droppedVolatile += 1; return false; }
      if (GATE_MODE === "enforce" && gateDecisions.get(r)?.decision === "reject") return false;
      return true;
    }).slice(0, TOP_K);

    if (unique.length === 0) {
      log([qtag(query), src, "hits=0", "injected=false",
        ...(droppedStale ? [`stale=${droppedStale}`] : []),
        ...(droppedVolatile ? [`volatile=${droppedVolatile}`] : [])]);
      return null;
    }

    try {
      // Canonical-aware composition: canonical hits lead, carry their
      // frontmatter.description ahead of the excerpt; same-dir sibling
      // crumbs capped at 1 so components can't crowd the canonical record.
      const canonicals = unique.filter(isCanonicalHit);
      let ordered = unique;
      if (canonicals.length > 0) {
        const canonicalDirs = new Set(canonicals.map((r) => path.dirname(String(r.nodeId))));
        const siblingsKept = new Map();
        const others = [];
        for (const r of unique) {
          if (isCanonicalHit(r)) continue;
          const dir = path.dirname(String(r.nodeId));
          if (canonicalDirs.has(dir)) {
            const kept = siblingsKept.get(dir) ?? 0;
            if (kept >= 1) continue;
            siblingsKept.set(dir, kept + 1);
          }
          others.push(r);
        }
        ordered = [...canonicals, ...others];
      }

      const verifyLives = ordered.filter(isVerifyLiveHit);
      const lines = ordered.map((r) => {
        const date = fmtDate(r.frontmatter?.created);
        const age = memoryAgeDays(r.frontmatter);
        const prefix = date ? `[${date}${age === null ? "" : `, ${age}d old`}] ` : "";
        const excerpt = (r.excerpt ?? "").trim().slice(0, 200);
        const source = path.basename(String(r.nodeId));
        const vl = isVerifyLiveHit(r) ? "VERIFY-LIVE " : "";
        if (isCanonicalHit(r)) {
          const desc = typeof r.frontmatter?.description === "string"
            ? r.frontmatter.description.trim().slice(0, 300) : "";
          const body = desc && excerpt ? `${desc} — ${excerpt}` : (desc || excerpt);
          return `- CANONICAL ${vl}${prefix}${body} (source: ${source})`;
        }
        return `- ${vl}${prefix}${excerpt} (source: ${source})`;
      }).join("\n");

      const canonicalNote = canonicals.length > 0
        ? ` Entries marked CANONICAL are the authoritative consolidated record for their topic: answer from them directly, and do NOT recompute totals or values from other recalled fragments.`
        : "";
      const ageNote = ordered.some((r) => memoryAgeDays(r.frontmatter) !== null)
        ? ` Project and reference entries show their age: the older one is, the likelier its state has moved on. User and feedback entries do not go out of date with age.`
        : "";
      const verifyLiveNote = verifyLives.length > 0
        ? ` Entries marked VERIFY-LIVE record volatile system state as of their date: treat them as last-known state and verify against the live system before asserting current state.`
        : "";

      const block =
        `<engram_recall>\n` +
        `Recalled from Engram (shared memory across Claude Code, Codex, Hermes, Aegis). Dates shown — these are recorded facts, useful for recall; for anything time-sensitive (current status, schedules, live state), verify a live source rather than relying on a dated memory.${ageNote}${canonicalNote}${verifyLiveNote}\n` +
        `${lines}\n` +
        `</engram_recall>`;

      const dropped = unique.length - ordered.length;
      recordCandidates(candidates, ordered);
      const logParts = [qtag(query), src, `hits=${ordered.length}`, "injected=true", `canonical=${canonicals.length}`];
      if (dropped > 0)         logParts.push(`capped=${dropped}`);
      if (droppedStale > 0)    logParts.push(`stale=${droppedStale}`);
      if (droppedVolatile > 0) logParts.push(`volatile=${droppedVolatile}`);
      log(logParts);
      return { block, count: ordered.length };
    } catch (e) {
      log([qtag(query), src, "hits=0", "injected=false", `err=compose:${e?.message}`]);
      return null;
    }
  }

  function cliRecall(query) {
    return new Promise((resolve) => {
      let stdout = "";
      let timedOut = false;
      const child = spawn(node.bin, [
        path.join(runtime, "dist/cli/index.js"),
        "--data-dir", CLI_DATA_DIR,
        "--vault-path", CLI_VAULT_PATH,
        "memory-search", query,
        "--limit", String(TOP_K),
      ], { env: { ...process.env, ...tenantEnv(conf) } });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        log([qtag(query), "hits=0", "injected=false", "err=timeout"]);
        resolve(null);
      }, TIMEOUT_MS);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0) {
          log([qtag(query), "hits=0", "injected=false", `err=exit(${code})`]);
          return resolve(null);
        }
        let results;
        try { results = JSON.parse(stdout); }
        catch { log([qtag(query), "hits=0", "injected=false", "err=json-parse"]); return resolve(null); }
        resolve(composeAndLog(query, results, "src=cli"));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        if (timedOut) return;
        log([qtag(query), "hits=0", "injected=false", `err=${err.message}`]);
        resolve(null);
      });
    });
  }

  try {
    if (!node.ok) log(["startup", "WARN=node-unresolved-fallback", `node=${node.bin}`]);
    const query = extractQuery(event?.prompt);
    if (!query) {
      log(["query=<none>", "hits=0", "injected=false", "reason=no-query"]);
      finish(false, "no-query");
      return { block: null, outcome: "no-query", injected: 0 };
    }
    await loadGate(query);
    let out = null;
    if (MIN_SCORE === null) log(["hits=0", "injected=false", "err=recall-policy"]);
    else {
      const viaHttp = await httpSearch(query);
      out = viaHttp ? composeAndLog(query, viaHttp.results, `src=http ms=${viaHttp.ms}`) : await cliRecall(query);
    }
    const outcome = out ? "injected" : "empty-or-error";
    finish(Boolean(out), outcome);
    return { block: out?.block ?? null, outcome, injected: out?.count ?? 0 };
  } catch (e) {
    log(["query=<error>", "hits=0", "injected=false", `err=main:${e?.message}`]);
    finish(false, "error");
    return { block: null, outcome: "error", injected: 0 };
  }
}

/** Read one JSON event from stdin; null when it is not JSON. */
export async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try { return JSON.parse(raw); } catch { return null; }
}
