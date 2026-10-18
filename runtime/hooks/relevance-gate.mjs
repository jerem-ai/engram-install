/**
 * Relevance gate (plan section 10). Shared by the Claude recall hook and the
 * OpenClaw vault-context injector, loaded from the engram-runtime release.
 *
 * Deterministic and local. Rule v1 rejects a candidate only when all hold:
 *   - its source folder resolves to a project (T2 provenance),
 *   - its own text carries a distinctive term or alias of that project,
 *   - the conversation is not in that project (unknown counts as different),
 *   - no distinctive term or alias of that project appears in the turn or thread,
 *   - the turn shares at least one term with the memory, and every shared term
 *     is a corpus-spread word such as "noise" (collision),
 *   - it is not reviewed working-style feedback (which bypasses project mismatch).
 * Rule v2 also rejects when the turn shares no term at all with such a memory.
 * Rule v1 kept those as `no_lexical_overlap`; batch-001 review found them
 * irrelevant (C14-C16). Reviewed working-style feedback is still kept, and
 * memories without project terms never reach this check.
 * Rule v3 (replay only; failed sealed batch-003) also rejects when the conversation is in a known, different
 * project and the memory shares only one specific word with the turn and thread
 * (batch-002 C12, C16 and C18-C20 were all no). A shared two-word phrase, or two
 * specific words across turn and thread, still keeps it. With the project
 * unknown, one specific word in the turn still keeps the memory.
 * Rule v4 (October 7) keeps another project's memory on a shared specific word
 * only when that word is a name: not on config/common-words.json (ordinary
 * English words found in the memory corpus), or a project's distinctive term or
 * alias. Every reviewed cross-project keep on an ordinary word ("bridge",
 * "rack", "meal") was no; the reviewed yes keeps shared a name ("kipp") or a
 * phrase with one ("keychain mini"). A missing list makes it behave like v2.
 * Rule v4 failed its benchmark gate (15 positives lost: names such as "drake"
 * are dictionary words, and real questions share several ordinary words).
 * Rule v5 (October 7) rejects another project's memory only on thin overlap:
 * one shared specific term, a single ordinary word (on common-words.json and
 * not a project term), and at most two shared word stems in all. A name, a
 * shared phrase, or a third shared stem keeps it, as rule v2 does.
 * Everything else is kept. Callers fail open on any error.
 *
 * Label shadow (October 4): a memory whose folder resolves to no project may
 * carry one applied canonical-topic label (`metadata.labels`, engram.labels.v1).
 * Decisions still use folder provenance only. When a single known label would
 * give such a memory a project, the decision carries `label_shadow`, the
 * decision it would get with that label, so receipts measure the change before
 * anything acts on it. `decide(..., { labels: true })` replays it as primary.
 *
 * Tokenization must match eval/build_ontology.py.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Rule v5 passed its sealed gate on October 7 (docs/RELEVANCE_RULE_V5_GATE_2026-10-07.json).
// Rules v1-v4 stay replayable; v3 and v4 failed their gates.
export const GATE_VERSION = "rule-v5";
export const RULES = new Set(["rule-v1", "rule-v2", "rule-v3", "rule-v4", "rule-v5"]);
export const MODES = new Set(["off", "shadow", "enforce"]);

const STOP = new Set(("a an and the of to in on for with is are was were be been being do does did done yes yeah yep " +
  "no nope ok okay sure please thanks thank you your i me my we us our it its this that these those them they he she " +
  "his her now then here there what which who whom whose how why when where can could would should will shall may " +
  "might must just only also too very really actually basically maybe perhaps thing things stuff one last next more " +
  "most some any all both each either neither about above below over under again still even much many lot lots got " +
  "get go going gonna let lets ya yea oh hm hmm wow huh cool nice damn lol haha hey yo ah eh um uh").split(/\s+/));

export function tokens(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function eligible(t) {
  const hexlike = /^[0-9a-f]{6,}$/.test(t) && /\d/.test(t);
  return t.length >= 3 && t.length <= 24 && /[a-z]/.test(t) && !/\d{3,}/.test(t) && !hexlike;
}

/** Unigrams and adjacent bigrams of eligible tokens, as the ontology builder mines them. */
export function terms(text) {
  const toks = tokens(text).filter(eligible);
  const out = new Set(toks);
  for (let i = 0; i + 1 < toks.length; i += 1) if (toks[i] !== toks[i + 1]) out.add(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

/** Crude suffix stem, enough to match "interrupted" with "interrupt" and "leaking" with "leak". */
function stem(t) {
  for (const suffix of ["ing", "ed", "s"]) if (t.endsWith(suffix) && t.length - suffix.length >= 3) return t.slice(0, -suffix.length);
  return t;
}
const stems = (text) => new Set(tokens(text).filter(eligible).map(stem));

function hasAlias(text, alias) {
  const hay = ` ${tokens(text).join(" ")} `;
  const needle = tokens(alias).join(" ");
  return needle.length > 0 && hay.includes(` ${needle} `);
}

export function readMode(runtimeDir) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(runtimeDir, "config/recall.json"), "utf8"));
    return MODES.has(policy.relevanceGate) ? policy.relevanceGate : "off";
  } catch { return "off"; }
}

export function loadPolicy(runtimeDir) {
  const ontology = JSON.parse(fs.readFileSync(path.join(runtimeDir, "config/ontology.json"), "utf8"));
  const sourceMap = JSON.parse(fs.readFileSync(path.join(runtimeDir, "config/memory-projects.json"), "utf8")).source_slugs;
  const topics = new Map();
  const distinctive = new Set();
  for (const t of ontology.canonical_topics) {
    const entry = { terms: new Set(t.distinctive_terms), aliases: t.aliases ?? [], repoNames: new Set(t.repo_names ?? [t.slug]) };
    topics.set(t.slug, entry);
    for (const term of t.distinctive_terms) distinctive.add(term);
    for (const alias of entry.aliases) distinctive.add(tokens(alias).join(" "));
  }
  let common = null;
  try { common = new Set(JSON.parse(fs.readFileSync(path.join(runtimeDir, "config/common-words.json"), "utf8")).words); }
  catch { /* rule v4 falls back to v2 without the list */ }
  return { version: ontology.version, sourceMap, topics, distinctive, shared: new Set(ontology.shared_words ?? []), common,
    sourceKeys: Object.keys(sourceMap).sort((a, b) => b.length - a.length) };
}

/** Project for a working directory: exact source folder, longest folder prefix, then Conductor repo name. */
export function conversationProject(policy, cwd, home = os.homedir()) {
  if (typeof cwd !== "string" || !cwd) return null;
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (policy.sourceMap[slug]) return policy.sourceMap[slug];
  for (const key of policy.sourceKeys) {
    if (slug.startsWith(`${key}-`)) return policy.sourceMap[key];
  }
  const rel = path.relative(path.join(home, "conductor"), cwd).split(path.sep);
  if ((rel[0] === "workspaces" || rel[0] === "repos") && rel[1]) {
    const repo = rel[1].toLowerCase().replace(/[^a-z0-9]+/g, "-"); // "3D Print Queue" -> "3d-print-queue"
    for (const [project, t] of policy.topics) if (t.repoNames.has(repo)) return project;
  }
  return null;
}

function topicHits(policy, project, text) {
  const topic = policy.topics.get(project);
  if (!topic) return 0;
  let n = 0;
  for (const term of terms(text)) if (topic.terms.has(term)) n += 1;
  for (const alias of topic.aliases) if (hasAlias(text, alias)) n += 1;
  return n;
}

function memoryText(r) {
  const fm = r?.frontmatter ?? {};
  return [r?.title, fm.name, fm.description, r?.excerpt].filter((x) => typeof x === "string").join("\n");
}

function isReviewedWorkingStyle(fm) {
  const m = fm?.metadata ?? {};
  return m.feedback_kind === "working_style" && ["reviewed", "approved"].includes(m.scope_review);
}

/** The one known topic of an applied engram.labels.v1 label, else null (none, several, unknown or malformed). */
export function labelProject(policy, fm) {
  let labels = fm?.metadata?.labels;
  if (typeof labels === "string") { try { labels = JSON.parse(labels); } catch { return null; } }
  const topics = labels?.schema === "engram.labels.v1" ? labels.canonical_topics : null;
  return Array.isArray(topics) && topics.length === 1 && policy.topics.has(topics[0]) ? topics[0] : null;
}

/** One decision per candidate. `thread` holds prior user turns, newest last. `rule` replays an older rule. */
export function decide(policy, ctx, candidate, { rule = GATE_VERSION, labels = false } = {}) {
  if (!RULES.has(rule)) throw new Error(`unknown gate rule ${rule}`);
  const { query, thread = [], project = null } = ctx;
  const fm = candidate?.frontmatter ?? {};
  const folderProject = policy.sourceMap[fm.mirrored_from] ?? null;
  const labelled = folderProject ? null : labelProject(policy, fm);
  const memoryProject = folderProject ?? (labels ? labelled : null);
  const base = { memory_project: memoryProject, conversation_project: project,
    ...(memoryProject && !folderProject ? { memory_project_source: "label" } : {}) };
  if (!memoryProject) {
    const out = { ...base, decision: "keep", reason: "memory_project_unknown" };
    if (labelled) {
      const s = decide(policy, ctx, candidate, { rule, labels: true });
      out.label_shadow = { memory_project: labelled, decision: s.decision === "reject" ? "would_reject" : s.decision, reason: s.reason };
    }
    return out;
  }
  const text = memoryText(candidate);
  const memoryTopic = topicHits(policy, memoryProject, text);
  if (memoryTopic === 0) return { ...base, decision: "keep", reason: "not_domain_specific", memory_topic_terms: 0 };
  if (project === memoryProject) return { ...base, decision: "keep", reason: "same_project", memory_topic_terms: memoryTopic };
  const context = [query, ...thread].join("\n");
  const contextTopic = topicHits(policy, memoryProject, context);
  const memoryTerms = terms(text);
  const shared = [...terms(query)].filter((t) => memoryTerms.has(t));
  const isSpecific = (t) => t.includes(" ") || policy.distinctive.has(t) || !policy.shared.has(t);
  const specific = shared.filter(isSpecific).length;
  const counts = { memory_topic_terms: memoryTopic, context_topic_terms: contextTopic,
    shared_terms: shared.length, shared_specific: specific };
  if (contextTopic > 0) return { ...base, ...counts, decision: "keep", reason: "topic_in_context" };
  if (shared.length === 0 && rule === "rule-v1") return { ...base, ...counts, decision: "keep", reason: "no_lexical_overlap" };
  if (specific > 0 && rule === "rule-v5" && policy.common) {
    const spec = shared.filter(isSpecific);
    const ordinary = spec.length === 1 && !spec[0].includes(" ") && !policy.distinctive.has(spec[0]) && policy.common.has(spec[0]);
    const memoryStems = stems(text);
    counts.shared_stems = [...stems(query)].filter((t) => memoryStems.has(t)).length;
    if (!ordinary || counts.shared_stems > 2) return { ...base, ...counts, decision: "keep", reason: "specific_overlap" };
  } else if (specific > 0 && rule === "rule-v4" && policy.common) {
    const named = shared.filter(isSpecific).filter((t) => policy.distinctive.has(t) || t.split(" ").some((w) => !policy.common.has(w)));
    counts.shared_named = named.length;
    if (named.length > 0) return { ...base, ...counts, decision: "keep", reason: "specific_overlap" };
  } else if (specific > 0 && (rule !== "rule-v3" || project === null)) return { ...base, ...counts, decision: "keep", reason: "specific_overlap" };
  if (specific > 0 && rule === "rule-v3") {
    const support = new Set(shared.filter(isSpecific));
    for (const t of terms(thread.join("\n"))) if (memoryTerms.has(t) && isSpecific(t)) support.add(t);
    counts.supported_specific = support.size;
    if (support.size >= 2 || shared.some((t) => t.includes(" "))) return { ...base, ...counts, decision: "keep", reason: "specific_overlap" };
  }
  if (isReviewedWorkingStyle(fm)) return { ...base, ...counts, decision: "keep", reason: "applicability_unscored" };
  const reason = specific > 0 ? ({ "rule-v4": "project_mismatch_common_word", "rule-v5": "project_mismatch_thin_overlap" }[rule] ?? "project_mismatch_weak_overlap")
    : shared.length ? "project_mismatch_collision" : "project_mismatch_no_overlap";
  return { ...base, ...counts, decision: "reject", reason };
}

/** Last `maxTurns` user turns before the current prompt, from the tail of a Claude transcript. */
export function readThread(transcriptPath, currentPrompt, { maxBytes = 65536, maxTurns = 3, budgetMs = 20 } = {}) {
  const started = Date.now();
  const out = { turns: [], bytes: 0, truncated: false };
  if (typeof transcriptPath !== "string" || !transcriptPath) return out;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    out.bytes = length;
    const lines = buf.toString("utf8").split("\n");
    if (size > length) lines.shift();
    const turns = [];
    for (const line of lines) {
      if (Date.now() - started > budgetMs) { out.truncated = true; break; }
      if (!line.includes('"user"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type !== "user" || e?.isMeta) continue;
      const c = e?.message?.content;
      const text = typeof c === "string" ? c
        : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "";
      if (!text.trim() || text.trimStart().startsWith("<task-notification>")) continue;
      turns.push(text);
    }
    if (turns.length && typeof currentPrompt === "string" && turns[turns.length - 1].trim() === currentPrompt.trim()) turns.pop();
    out.turns = turns.slice(-maxTurns);
  } catch { /* fail open: empty thread */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  return out;
}

// Codex records harness context (AGENTS.md, environment, goal continuations,
// permissions) as user messages too. They are not the person's words.
const CODEX_INJECTED = /^(# AGENTS\.md|<(environment_context|codex_internal_context|user_instructions|permissions|system_instruction|turn_aborted|user_shell_command)[\s>])/;

/** Last `maxTurns` user turns before the current prompt, from the tail of a Codex rollout. */
export function readCodexThread(rolloutPath, currentPrompt, { maxBytes = 262144, maxTurns = 3, budgetMs = 20 } = {}) {
  const started = Date.now();
  const out = { turns: [], bytes: 0, truncated: false };
  if (typeof rolloutPath !== "string" || !rolloutPath) return out;
  let fd;
  try {
    fd = fs.openSync(rolloutPath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    out.bytes = length;
    const lines = buf.toString("utf8").split("\n");
    if (size > length) lines.shift();
    const turns = [];
    for (const line of lines) {
      if (Date.now() - started > budgetMs) { out.truncated = true; break; }
      if (!line.includes('"user"')) continue; // cheap prefilter; tolerant of `"role": "user"` spacing
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const p = e?.payload;
      if (e?.type !== "response_item" || p?.type !== "message" || p?.role !== "user" || !Array.isArray(p.content)) continue;
      const text = p.content.filter((c) => c?.type === "input_text").map((c) => c.text).join("\n");
      if (!text.trim() || CODEX_INJECTED.test(text.trimStart())) continue;
      turns.push(text);
    }
    if (turns.length && typeof currentPrompt === "string" && turns[turns.length - 1].trim() === currentPrompt.trim()) turns.pop();
    out.turns = turns.slice(-maxTurns);
  } catch { /* fail open: empty thread */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  return out;
}

/** User turns before the current one from OpenClaw `event.messages`. */
export function threadFromMessages(messages, currentPrompt, maxTurns = 3) {
  if (!Array.isArray(messages)) return [];
  const turns = messages.filter((m) => m?.role === "user").map((m) => typeof m.content === "string" ? m.content
    : Array.isArray(m.content) ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "")
    .filter((t) => t.trim());
  if (turns.length && typeof currentPrompt === "string" && currentPrompt.includes(turns[turns.length - 1].trim())) turns.pop();
  return turns.slice(-maxTurns);
}
