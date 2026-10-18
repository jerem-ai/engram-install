import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  FACT_MAINTAINER_POLICY_VERSION, MAINTENANCE_RECEIPT_SCHEMA, applyAction, countActions, factMaintainerDir, runId,
  writeJsonFile, writeReceipt, type MaintenanceAction, type MaintenanceReceipt,
} from './fact-maintainer.js';
import { makeRoom, realClock, type Clock, type KippChatReply, type KippTransport } from './kipp.js';

/**
 * The overnight judge ("memory dream machine"). For current facts that share a
 * subject and predicate, Kipp decides which pairs conflict (cannot both be
 * true now), which are near-duplicates, and which both stand. The model only
 * classifies pairs; which fact loses is decided here: in a conflict the newer
 * fact wins, in a duplicate the fuller wording wins. A loser becomes
 * historical with `superseded_by` set to the kept fact. Nothing is deleted.
 *
 * Nothing acts live until a validation receipt for the exact model, prompt and
 * case set passes the gate: the synthetic cases carry hand-written gold, and
 * model output never becomes gold. Without that receipt a night runs in shadow.
 */
export const FACT_JUDGE_PROMPT_VERSION = 'fact-judge-v2';
export const VALIDATION_SCHEMA = 'engram.fact-judge-validation.v1';

export const FACT_JUDGE_SYSTEM = `You check a personal memory store for facts that cannot all be true now. Each request lists facts that share one subject and one predicate. Compare every pair of facts and sort it into one of three kinds.

CONFLICT: the two cannot both be true at the same time, because one replaces or corrects the other. Typical cases: a different value for something that has one value at a time (a version, a date, a count, a host, a port, a setting, a status, a location, the single owner of one thing), or a later statement that reverses an earlier one.
DUPLICATE: the two say the same thing in different words. Keeping only one of them would lose nothing that matters; one may add a small detail.
BOTH STAND: the two can be true together. A subject can have many preferences, rules, tools, approvals, requests, items or parts; the same idea can apply at different scopes or for different purposes; one fact can add a separate fact. Facts with different numbers, names, versions or dates are never duplicates.

Before calling a pair a CONFLICT, check that both facts fill the same single slot. Two facts about different machines, hosts, places or copies both stand. Two facts about different aspects of the subject both stand: hardware and operating system, a model and the device it runs on, one schedule here and another there. A subject that serves, runs, installs or hosts several things at once has several values, so those both stand.

If you are unsure, choose BOTH STAND. Judge only from the facts.

Reply with JSON only: {"conflicts": [[a, b], ...], "duplicates": [[a, b], ...]} using the fact numbers. Leave out every pair that both stands. Use empty lists when nothing conflicts or repeats.`;

export const FACT_JUDGE_FORMAT = {
  type: 'object',
  properties: {
    conflicts: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
    duplicates: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  },
  required: ['conflicts', 'duplicates'],
};

export const FACT_JUDGE_PROMPT_DIGEST = createHash('sha256')
  .update(FACT_JUDGE_PROMPT_VERSION).update('\0').update(FACT_JUDGE_SYSTEM).update('\0')
  .update(JSON.stringify(FACT_JUDGE_FORMAT)).digest('hex');

export interface JudgeConfig {
  model: string;
  /**
   * A second model that must name the same pair before a conflict counts. Both
   * single-model prompts failed the false-conflict gate (3/75, 4/70), each time
   * on facts about different hosts or aspects; the two models are asked
   * separately and only their shared conflict pairs stand. Duplicates come from
   * the primary model alone.
   */
  confirm_model?: string | null;
  ssh_host: string;
  budget_minutes: number;
  max_group_size: number;
  max_object_chars: number;
  max_output_tokens: number;
  request_timeout_s: number;
  /** Graph-link predicates: their objects are note names, so they hold many values by design. */
  link_predicates: string[];
  fixture: string;
}

export interface GateConfig {
  min_gold_pairs: number;
  min_both_stand_pairs: number;
  min_recall: number;
  max_false_rate: number;
  max_false_wilson_upper: number;
  max_error_rate: number;
}

export interface FactMaintainerConfig {
  judge: JudgeConfig;
  gate: GateConfig;
}

const RUNTIME_DIR = fileURLToPath(new URL('../../../', import.meta.url));

export function loadFactMaintainerConfig(path = join(RUNTIME_DIR, 'config/fact-maintainer.json')): FactMaintainerConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as FactMaintainerConfig;
}

/** The model identity a validation receipt binds: the primary, plus the confirming model when there is one. */
export function judgeModelId(judge: Pick<JudgeConfig, 'model' | 'confirm_model'>): string {
  return judge.confirm_model ? `${judge.model}+confirm:${judge.confirm_model}` : judge.model;
}

export function fixturePath(config: FactMaintainerConfig): string {
  return join(RUNTIME_DIR, config.judge.fixture);
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const norm = (s: string) => s.trim().toLowerCase();
const linkKey = (s: string) => norm(s).replace(/[\s-]+/g, '_');

export interface JudgeFact {
  id: string; subject: string; predicate: string; object: string; status: string;
  valid_from: string | null; valid_to: string | null; superseded_by: string | null; created_at: string; updated_at: string;
}

export interface JudgeGroup {
  /** Body-free group id: a hash of the normalized subject and predicate. */
  key: string;
  subject: string;
  predicate: string;
  /** Newest first. */
  facts: JudgeFact[];
  digest: string;
  truncated: boolean;
}

export interface JudgeState {
  /** `mode` records which verdicts could act when the group was judged; a night with a different mode re-judges it. */
  groups: Record<string, { digest: string; judged_at: string; run_id: string; mode: string }>;
}

export function groupDigest(facts: Array<Pick<JudgeFact, 'id' | 'object' | 'valid_from'>>): string {
  return sha([...facts].sort((a, b) => a.id.localeCompare(b.id))
    .map(f => `${f.id}\u001f${f.object}\u001f${f.valid_from ?? ''}`).join('\n'));
}

function newestFirst(a: JudgeFact, b: JudgeFact): number {
  return (b.valid_from ?? '').localeCompare(a.valid_from ?? '')
    || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
}

/** Current facts that share subject and predicate, excluding graph links, grouped. */
export function currentGroups(db: Database.Database, config: JudgeConfig): JudgeGroup[] {
  const rows = db.prepare(`
    SELECT id, subject, predicate, object, status, valid_from, valid_to, superseded_by, created_at, updated_at
    FROM engram_assertions WHERE owner_principal_id = current_principal_id() AND status = 'current'
  `).all() as JudgeFact[];
  const links = new Set(config.link_predicates.map(linkKey));
  const byKey = new Map<string, JudgeFact[]>();
  for (const r of rows) {
    if (links.has(linkKey(r.predicate))) continue;
    const key = sha(`${norm(r.subject)}\u001f${norm(r.predicate)}`).slice(0, 16);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }
  const groups: JudgeGroup[] = [];
  for (const [key, all] of byKey) {
    if (all.length < 2) continue;
    const facts = [...all].sort(newestFirst);
    groups.push({ key, subject: facts[0].subject, predicate: facts[0].predicate,
      facts: facts.slice(0, config.max_group_size), digest: groupDigest(all), truncated: facts.length > config.max_group_size });
  }
  return groups.sort((a, b) => newestFirst(a.facts[0], b.facts[0]));
}

/** Groups whose members changed since they were last judged, or that were judged under another mode. */
export function changedGroups(groups: JudgeGroup[], state: JudgeState, mode: string): JudgeGroup[] {
  return groups.filter(g => state.groups[g.key]?.digest !== g.digest || state.groups[g.key]?.mode !== mode);
}

export function judgeMode(live: { conflicts: boolean; duplicates: boolean }): string {
  return live.conflicts && live.duplicates ? 'live' : live.conflicts ? 'conflicts' : live.duplicates ? 'duplicates' : 'shadow';
}

export function buildUserPrompt(subject: string, predicate: string, objects: string[], maxChars: number): string {
  const clip = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars)}…` : s).replace(/\s+/g, ' ');
  return `Subject: ${clip(subject)}\nPredicate: ${clip(predicate)}\n\nFacts:\n${objects.map((o, i) => `${i + 1}. ${clip(o)}`).join('\n')}`;
}

export interface Verdict {
  /** Zero-based index pairs, smaller index first. */
  conflicts: Array<[number, number]>;
  duplicates: Array<[number, number]>;
}

/**
 * Parse the judge's JSON. Pairs are 1-based in the prompt; out-of-range,
 * self and repeated pairs are dropped, and a pair named as both a conflict and
 * a duplicate both stands (the judge contradicted itself).
 */
export function parseVerdict(text: string, n: number): Verdict {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const raw = JSON.parse(body) as { conflicts?: unknown; duplicates?: unknown };
  const pairs = (v: unknown): Array<[number, number]> => {
    if (!Array.isArray(v)) throw new Error('verdict lists missing');
    const out = new Map<string, [number, number]>();
    for (const p of v) {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(x => Number.isInteger(x))) continue;
      const [a, b] = (p as number[]).map(x => x - 1).sort((x, y) => x - y);
      if (a < 0 || b >= n || a === b) continue;
      out.set(`${a},${b}`, [a, b]);
    }
    return [...out.values()];
  };
  const conflicts = pairs(raw.conflicts);
  const duplicates = pairs(raw.duplicates);
  const both = new Set(conflicts.map(p => p.join(',')).filter(k => duplicates.some(d => d.join(',') === k)));
  return { conflicts: conflicts.filter(p => !both.has(p.join(','))), duplicates: duplicates.filter(p => !both.has(p.join(','))) };
}

/** Conflicts both models named; duplicates from the primary alone. */
export function combineVerdicts(primary: Verdict, confirm: Verdict | null): Verdict {
  if (!confirm) return { conflicts: [], duplicates: primary.duplicates };
  const keys = new Set(confirm.conflicts.map(p => p.join(',')));
  return { conflicts: primary.conflicts.filter(p => keys.has(p.join(','))), duplicates: primary.duplicates };
}

export interface Decision {
  loser: number;
  winner: number;
  verdict: 'conflict' | 'duplicate';
}

/**
 * Who loses, given facts newest first. A fact loses a conflict only to a newer
 * fact that itself survives, so an old fact compatible with today's value
 * stays. Among survivors, each duplicate cluster keeps its fullest wording
 * (newer on a tie).
 */
export function decideGroup(facts: Array<Pick<JudgeFact, 'object'>>, verdict: Verdict): Decision[] {
  const has = (list: Array<[number, number]>, a: number, b: number) =>
    list.some(([x, y]) => (x === Math.min(a, b) && y === Math.max(a, b)));
  const decisions: Decision[] = [];
  const kept: number[] = [];
  for (let i = 0; i < facts.length; i++) {
    const winner = kept.find(k => has(verdict.conflicts, i, k));
    if (winner === undefined) kept.push(i);
    else decisions.push({ loser: i, winner, verdict: 'conflict' });
  }
  const parent = new Map<number, number>(kept.map(k => [k, k]));
  const find = (x: number): number => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const [a, b] of verdict.duplicates) {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  }
  const clusters = new Map<number, number[]>();
  for (const k of kept) (clusters.get(find(k)) ?? clusters.set(find(k), []).get(find(k))!).push(k);
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const keep = [...members].sort((a, b) => facts[b].object.trim().length - facts[a].object.trim().length || a - b)[0];
    for (const m of members) if (m !== keep) decisions.push({ loser: m, winner: keep, verdict: 'duplicate' });
  }
  return decisions;
}

// --- Validation ----------------------------------------------------------

export interface JudgeCase {
  id: string;
  kind: string;
  subject: string;
  predicate: string;
  facts: string[];
  /** 1-based pairs, hand-written gold. Pairs not listed both stand. */
  conflicts: Array<[number, number]>;
  duplicates: Array<[number, number]>;
}

export interface JudgeCaseFile {
  schema: string;
  cases: JudgeCase[];
}

export interface RateReport {
  gold_pairs: number;
  caught: number;
  recall: number;
  /** Pairs that must not get this verdict. */
  negative_pairs: number;
  false_positives: number;
  false_rate: number;
  false_wilson_upper: number;
  passed: boolean;
  missed: string[];
  false_cases: string[];
}

export interface ValidationScore {
  cases: number;
  errors: number;
  error_rate: number;
  conflict: RateReport;
  duplicate: RateReport;
}

/** Upper bound of the 95% Wilson interval for k of n. */
export function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n === 0) return 1;
  const p = k / n;
  const d = 1 + (z * z) / n;
  return Math.min(1, (p + (z * z) / (2 * n) + z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d);
}

/**
 * Score judge output against gold. A failed request counts as "both stand"
 * for every pair: it misses gold, it never counts as a false verdict, and the
 * error rate has its own limit. Conflict false positives are counted on
 * both-stand pairs; duplicate false positives on both-stand and conflict pairs,
 * since merging a real conflict could keep the old value.
 */
export function scoreValidation(cases: JudgeCase[], predictions: Map<string, Verdict | null>, gate: GateConfig): ValidationScore {
  const tally = () => ({ gold: 0, caught: 0, neg: 0, fp: 0, missed: [] as string[], fcases: [] as string[] });
  const c = tally();
  const d = tally();
  let errors = 0;
  for (const kase of cases) {
    const pred = predictions.get(kase.id) ?? null;
    if (!pred) errors += 1;
    const key = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;
    const goldC = new Set(kase.conflicts.map(([a, b]) => key(a - 1, b - 1)));
    const goldD = new Set(kase.duplicates.map(([a, b]) => key(a - 1, b - 1)));
    const pC = new Set((pred?.conflicts ?? []).map(([a, b]) => key(a, b)));
    const pD = new Set((pred?.duplicates ?? []).map(([a, b]) => key(a, b)));
    for (let i = 0; i < kase.facts.length; i++) {
      for (let j = i + 1; j < kase.facts.length; j++) {
        const k = key(i, j);
        const tag = `${kase.id}:${i + 1}-${j + 1}`;
        if (goldC.has(k)) { c.gold += 1; if (pC.has(k)) c.caught += 1; else c.missed.push(tag); }
        else if (!goldD.has(k)) { c.neg += 1; if (pC.has(k)) { c.fp += 1; c.fcases.push(tag); } }
        if (goldD.has(k)) { d.gold += 1; if (pD.has(k)) d.caught += 1; else d.missed.push(tag); }
        else { d.neg += 1; if (pD.has(k)) { d.fp += 1; d.fcases.push(tag); } }
      }
    }
  }
  const errorRate = cases.length ? errors / cases.length : 1;
  const rate = (t: ReturnType<typeof tally>, minNeg: number): RateReport => {
    const recall = t.gold ? t.caught / t.gold : 0;
    const falseRate = t.neg ? t.fp / t.neg : 1;
    const upper = wilsonUpper(t.fp, t.neg);
    return {
      gold_pairs: t.gold, caught: t.caught, recall, negative_pairs: t.neg, false_positives: t.fp, false_rate: falseRate,
      false_wilson_upper: upper,
      passed: t.gold >= gate.min_gold_pairs && t.neg >= minNeg && recall >= gate.min_recall
        && falseRate <= gate.max_false_rate && upper <= gate.max_false_wilson_upper && errorRate <= gate.max_error_rate,
      missed: t.missed, false_cases: t.fcases,
    };
  };
  return { cases: cases.length, errors, error_rate: errorRate,
    conflict: rate(c, gate.min_both_stand_pairs), duplicate: rate(d, gate.min_both_stand_pairs) };
}

export interface ValidationReceipt {
  schema: typeof VALIDATION_SCHEMA;
  at: string;
  model: string;
  prompt_version: string;
  prompt_digest: string;
  fixture_digest: string;
  score: ValidationScore;
  per_case: Array<{ id: string; kind: string; seconds: number | null; conflicts: Array<[number, number]> | null;
    duplicates: Array<[number, number]> | null; error: string | null;
    primary_conflicts?: Array<[number, number]> | null; confirm_error?: string | null }>;
}

function validationDir(dir: string): string {
  return join(dir, 'judge', 'validation');
}

/** Run every synthetic case through the judge and write a validation receipt. */
export function runValidation(opts: {
  transport: KippTransport; config: FactMaintainerConfig; dir?: string; log?: (l: string) => void;
  clock?: Clock; skipMakeRoom?: boolean; now?: () => string; cases?: JudgeCaseFile; fixtureDigest?: string;
}): { receipt: ValidationReceipt; path: string } {
  const { transport, config } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const dir = opts.dir ?? factMaintainerDir();
  const raw = opts.cases ? null : readFileSync(fixturePath(config));
  const file = opts.cases ?? JSON.parse(raw!.toString('utf8')) as JudgeCaseFile;
  const fixtureDigest = opts.fixtureDigest ?? sha(raw!);
  const ask = (model: string, kase: JudgeCase) => {
    const reply = transport.chat({
      model, system: FACT_JUDGE_SYSTEM, format: FACT_JUDGE_FORMAT,
      user: buildUserPrompt(kase.subject, kase.predicate, kase.facts, config.judge.max_object_chars),
      maxOutputTokens: config.judge.max_output_tokens, timeoutS: config.judge.request_timeout_s,
    });
    return { reply, verdict: parseVerdict(reply.content, kase.facts.length) };
  };
  const one = (p: Array<[number, number]>) => p.map(([a, b]) => [a + 1, b + 1] as [number, number]);
  if (!opts.skipMakeRoom) makeRoom(transport, config.judge.model, log, opts.clock ?? realClock);
  const primary = new Map<string, { verdict: Verdict; seconds: number } | { error: string }>();
  for (const kase of file.cases) {
    try {
      const { reply, verdict } = ask(config.judge.model, kase);
      primary.set(kase.id, { verdict, seconds: reply.seconds });
      log(`case ${kase.id} (${kase.kind}) ${reply.seconds}s conflicts=${JSON.stringify(one(verdict.conflicts))} duplicates=${JSON.stringify(one(verdict.duplicates))}`);
    } catch (error) {
      primary.set(kase.id, { error: (error as Error).message.slice(0, 200) });
      log(`case ${kase.id} FAILED: ${(error as Error).message.slice(0, 200)}`);
    }
  }
  const confirm = new Map<string, Verdict | { error: string }>();
  const confirmModel = config.judge.confirm_model;
  if (confirmModel) {
    const toConfirm = file.cases.filter(k => { const r = primary.get(k.id); return r && 'verdict' in r && r.verdict.conflicts.length; });
    if (toConfirm.length && !opts.skipMakeRoom) makeRoom(transport, confirmModel, log, opts.clock ?? realClock);
    for (const kase of toConfirm) {
      try {
        const { reply, verdict } = ask(confirmModel, kase);
        confirm.set(kase.id, verdict);
        log(`confirm ${kase.id} ${reply.seconds}s conflicts=${JSON.stringify(one(verdict.conflicts))}`);
      } catch (error) {
        confirm.set(kase.id, { error: (error as Error).message.slice(0, 200) });
        log(`confirm ${kase.id} FAILED: ${(error as Error).message.slice(0, 200)}`);
      }
    }
  }
  const predictions = new Map<string, Verdict | null>();
  const perCase: ValidationReceipt['per_case'] = [];
  for (const kase of file.cases) {
    const p = primary.get(kase.id)!;
    if ('error' in p) {
      predictions.set(kase.id, null);
      perCase.push({ id: kase.id, kind: kase.kind, seconds: null, conflicts: null, duplicates: null, error: p.error });
      continue;
    }
    const c = confirm.get(kase.id);
    // A failed confirmation drops the case's conflicts and counts as an error.
    const v = confirmModel ? combineVerdicts(p.verdict, c && !('error' in c) ? c : { conflicts: [], duplicates: [] }) : p.verdict;
    const confirmError = c && 'error' in c ? c.error : null;
    predictions.set(kase.id, confirmError ? null : v);
    perCase.push({ id: kase.id, kind: kase.kind, seconds: p.seconds, conflicts: one(v.conflicts), duplicates: one(v.duplicates),
      error: null, ...(confirmModel ? { primary_conflicts: one(p.verdict.conflicts), confirm_error: confirmError } : {}) });
  }
  const receipt: ValidationReceipt = {
    schema: VALIDATION_SCHEMA, at: now(), model: judgeModelId(config.judge), prompt_version: FACT_JUDGE_PROMPT_VERSION,
    prompt_digest: FACT_JUDGE_PROMPT_DIGEST, fixture_digest: fixtureDigest,
    score: scoreValidation(file.cases, predictions, config.gate), per_case: perCase,
  };
  mkdirSync(validationDir(dir), { recursive: true, mode: 0o700 });
  const path = join(validationDir(dir), `${receipt.at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`);
  writeJsonFile(path, receipt);
  return { receipt, path };
}

/** Which verdicts may act live: only those a matching validation receipt passed. */
export function liveGate(dir: string, config: FactMaintainerConfig, fixtureDigest: string): {
  conflicts: boolean; duplicates: boolean; receipt: string | null;
} {
  const vdir = validationDir(dir);
  if (!existsSync(vdir)) return { conflicts: false, duplicates: false, receipt: null };
  for (const f of readdirSync(vdir).filter(x => x.endsWith('.json')).sort().reverse()) {
    const r = JSON.parse(readFileSync(join(vdir, f), 'utf8')) as ValidationReceipt;
    if (r.schema !== VALIDATION_SCHEMA || r.model !== judgeModelId(config.judge) || r.prompt_digest !== FACT_JUDGE_PROMPT_DIGEST
      || r.fixture_digest !== fixtureDigest) continue;
    // Re-score against today's gate: a loosened config must not pass an old run.
    return { conflicts: gatePasses(r.score.conflict, config.gate, r.score.error_rate),
      duplicates: gatePasses(r.score.duplicate, config.gate, r.score.error_rate), receipt: f };
  }
  return { conflicts: false, duplicates: false, receipt: null };
}

function gatePasses(r: RateReport, gate: GateConfig, errorRate: number): boolean {
  return r.gold_pairs >= gate.min_gold_pairs && r.negative_pairs >= gate.min_both_stand_pairs && r.recall >= gate.min_recall
    && r.false_rate <= gate.max_false_rate && r.false_wilson_upper <= gate.max_false_wilson_upper && errorRate <= gate.max_error_rate;
}

// --- The night -------------------------------------------------------------

function statePath(dir: string): string {
  return join(dir, 'judge', 'state.json');
}

export function loadJudgeState(dir: string): JudgeState {
  try { return JSON.parse(readFileSync(statePath(dir), 'utf8')) as JudgeState; } catch { return { groups: {} }; }
}

export interface JudgeNightResult {
  run_id: string;
  shadow: boolean;
  live: { conflicts: boolean; duplicates: boolean; receipt: string | null };
  eligible_groups: number;
  changed_groups: number;
  judged: number;
  errors: number;
  out_of_budget: number;
  counts: Record<string, number>;
  receipt: string;
}

/**
 * One night. Groups that changed since they were last judged go to Kipp one at
 * a time, newest first, until the budget runs out; the rest wait for the next
 * night. Each group's changes and the receipt are committed together, so a
 * crash mid-night leaves a receipt that covers everything applied.
 */
export function runJudgeNight(db: Database.Database, opts: {
  transport: KippTransport; config: FactMaintainerConfig; dir?: string; log?: (l: string) => void; clock?: Clock;
  shadow?: boolean; budgetMinutes?: number; limitGroups?: number; skipMakeRoom?: boolean; now?: () => string;
  fixtureDigest?: string;
}): JudgeNightResult {
  const { transport, config } = opts;
  const dir = opts.dir ?? factMaintainerDir();
  const log = opts.log ?? (() => {});
  const clock = opts.clock ?? realClock;
  const now = opts.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const id = runId('judge', startedAt);
  const fixtureDigest = opts.fixtureDigest ?? sha(readFileSync(fixturePath(config)));
  const gate = liveGate(dir, config, fixtureDigest);
  const live = opts.shadow ? { conflicts: false, duplicates: false, receipt: gate.receipt } : gate;
  const shadow = !live.conflicts && !live.duplicates;
  const state = loadJudgeState(dir);
  const all = currentGroups(db, config.judge);
  const mode = judgeMode(live);
  const todo = changedGroups(all, state, mode).slice(0, opts.limitGroups ?? Infinity);
  const deadline = clock.now() + (opts.budgetMinutes ?? config.judge.budget_minutes) * 60_000;
  log(`${id}: ${all.length} eligible groups, ${todo.length} changed; ${shadow ? 'shadow' : `live (conflicts=${live.conflicts}, duplicates=${live.duplicates})`}`);

  const receipt: MaintenanceReceipt = {
    schema: MAINTENANCE_RECEIPT_SCHEMA, run_id: id, kind: 'judge', policy_version: FACT_MAINTAINER_POLICY_VERSION,
    started_at: startedAt, finished_at: null, counts: {}, actions: [],
    meta: { shadow, live, model: judgeModelId(config.judge), prompt_digest: FACT_JUDGE_PROMPT_DIGEST, fixture_digest: fixtureDigest,
      eligible_groups: all.length, changed_groups: todo.length, groups: [] as unknown[] },
  };
  const groupsMeta = receipt.meta!.groups as unknown[];
  const save = () => { receipt.counts = countActions(receipt.actions); writeReceipt(dir, receipt); };
  save();

  let judged = 0;
  let errors = 0;
  let outOfBudget = 0;
  const ask = (model: string, group: JudgeGroup) => {
    const reply = transport.chat({
      model, system: FACT_JUDGE_SYSTEM, format: FACT_JUDGE_FORMAT,
      user: buildUserPrompt(group.subject, group.predicate, group.facts.map(f => f.object), config.judge.max_object_chars),
      maxOutputTokens: config.judge.max_output_tokens, timeoutS: config.judge.request_timeout_s,
    });
    return { reply, verdict: parseVerdict(reply.content, group.facts.length) };
  };
  const fail = (group: JudgeGroup, stage: string, error: unknown) => {
    errors += 1;
    groupsMeta.push({ group: group.key, facts: group.facts.length, stage, error: (error as Error).message.slice(0, 200) });
    log(`group ${group.key} ${stage} FAILED: ${(error as Error).message.slice(0, 200)}`);
    save();
  };

  // Phase 1: the primary model judges every changed group.
  const judgedGroups: Array<{ group: JudgeGroup; reply: KippChatReply; primary: Verdict }> = [];
  let roomMade = !!opts.skipMakeRoom;
  for (const group of todo) {
    if (clock.now() >= deadline) { outOfBudget += 1; continue; }
    if (!roomMade) { makeRoom(transport, config.judge.model, log, clock); roomMade = true; }
    try {
      const { reply, verdict } = ask(config.judge.model, group);
      judgedGroups.push({ group, reply, primary: verdict });
    } catch (error) { fail(group, 'primary', error); }
  }

  // Phase 2: the confirming model re-judges groups where the primary found a conflict.
  const confirmModel = config.judge.confirm_model;
  const confirmed = new Map<string, Verdict>();
  const unconfirmed = new Set<string>();
  if (confirmModel) {
    let confirmRoom = !!opts.skipMakeRoom;
    for (const j of judgedGroups.filter(x => x.primary.conflicts.length)) {
      if (clock.now() >= deadline) { unconfirmed.add(j.group.key); outOfBudget += 1; continue; }
      if (!confirmRoom) { makeRoom(transport, confirmModel, log, clock); confirmRoom = true; }
      try { confirmed.set(j.group.key, ask(confirmModel, j.group).verdict); }
      catch (error) { unconfirmed.add(j.group.key); fail(j.group, 'confirm', error); }
    }
  }

  // Phase 3: decide and apply. A group whose conflicts could not be confirmed waits for the next night.
  for (const { group, reply, primary } of judgedGroups) {
    if (unconfirmed.has(group.key)) continue;
    judged += 1;
    const verdict = confirmModel ? combineVerdicts(primary, confirmed.get(group.key) ?? { conflicts: [], duplicates: [] }) : primary;
    const decisions = decideGroup(group.facts, verdict).map(d => ({
      group: group.key, verdict: d.verdict, loser_id: group.facts[d.loser].id, winner_id: group.facts[d.winner].id,
      applied: false,
    }));
    const at = now();
    const actions: MaintenanceAction[] = [];
    db.transaction(() => {
      for (const d of decisions) {
        if (!(d.verdict === 'conflict' ? live.conflicts : live.duplicates)) continue;
        const loser = group.facts.find(f => f.id === d.loser_id)!;
        const prior = { status: loser.status, valid_to: loser.valid_to, superseded_by: loser.superseded_by, updated_at: loser.updated_at };
        const action: MaintenanceAction = { kind: 'judge_supersede', assertion_id: loser.id, winner_id: d.winner_id,
          verdict: d.verdict, group: group.key, prior,
          after: { status: 'historical', valid_to: loser.valid_from && loser.valid_from > at ? loser.valid_from : at,
            superseded_by: d.winner_id, updated_at: at } };
        if (applyAction(db, action)) { actions.push(action); d.applied = true; }
      }
      receipt.actions.push(...actions);
      groupsMeta.push({ group: group.key, facts: group.facts.length, truncated: group.truncated, seconds: reply.seconds,
        prompt_tokens: reply.prompt_tokens, output_tokens: reply.output_tokens,
        primary_conflicts: primary.conflicts.length, conflicts: verdict.conflicts.length, duplicates: verdict.duplicates.length,
        decisions });
      save();
    })();
    const survivors = group.facts.filter(f => !actions.some(a => a.kind === 'judge_supersede' && a.assertion_id === f.id));
    // Untouched members keep their digest; a group with a loser re-keys to what remains.
    state.groups[group.key] = { digest: actions.length ? groupDigest(survivors) : group.digest, judged_at: at, run_id: id, mode };
    mkdirSync(join(dir, 'judge'), { recursive: true, mode: 0o700 });
    writeJsonFile(statePath(dir), state);
    log(`group ${group.key}: ${group.facts.length} facts, ${reply.seconds}s, ${decisions.length} decisions, ${actions.length} applied`);
  }
  receipt.finished_at = now();
  Object.assign(receipt.meta!, { judged, errors, out_of_budget: outOfBudget });
  save();
  return { run_id: id, shadow, live, eligible_groups: all.length, changed_groups: todo.length, judged, errors,
    out_of_budget: outOfBudget, counts: receipt.counts, receipt: join(dir, 'receipts', `${id}.json`) };
}
