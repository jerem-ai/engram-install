/**
 * Deterministic rules for deciding when two current assertions disagree.
 *
 * A contradiction needs one slot that can hold only one value at a time. Most
 * memory predicates hold many values ("prefers", "forbids", "owns"), so only a
 * predicate carrying a single-value cue ("default", "status", "version") is
 * compared. Predicates that differ by stopwords or a short qualifier ("default
 * printer is" and "default 3D printer") share a slot. Values that differ only in
 * case, punctuation, a shared leading value, or most of their words are the
 * same value. Validation pairs live in test/contradiction-slots.test.ts.
 */

const STOPWORDS = new Set([
  'is', 'are', 'was', 'were', 'be', 'the', 'a', 'an', 'of', 'to', 'for', 'as',
  'his', 'her', 'my', 'their', 'its', 'has', 'have', 'currently', 'now',
]);

const NEGATION = new Set(['not', 'no', 'never', 'non', 'without']);

const MULTI_VALUE_CUES = new Set([
  'prefers', 'prefer', 'wants', 'want', 'likes', 'like', 'dislikes', 'avoids', 'forbids',
  'refuses', 'requires', 'requests', 'requested', 'rejects', 'rejected', 'approved',
  'decided', 'uses', 'includes', 'contains', 'owns', 'lacks', 'needs', 'supports',
  'relates', 'depends', 'reports', 'proposes', 'suggests', 'observed', 'instructed',
  'prioritizes', 'exposes', 'serves', 'hosts', 'indexed', 'defect', 'excluded', 'runs',
  'scope', 'tags', 'tagged', 'knows', 'mentions', 'reads', 'follows', 'learned', 'tried',
  'tested', 'bought', 'ordered', 'plans', 'planned', 'considered', 'compared',
  'recommended', 'recommends', 'asked', 'said', 'noted', 'wrote', 'built', 'fixed',
  'added', 'removed', 'changed', 'visited', 'met', 'tracks', 'monitors', 'watches',
  'member', 'alias', 'aka',
]);

const SINGLE_VALUE_CUES = new Set([
  'default', 'primary', 'current', 'main', 'status', 'version', 'named', 'name', 'model',
  'location', 'located', 'lives', 'birthday', 'born', 'age', 'email', 'phone', 'address',
  'timezone', 'id', 'ip', 'port', 'hostname', 'owner', 'title', 'spouse', 'partner',
  'girlfriend', 'nickname', 'color', 'size', 'diameter', 'firmware', 'os', 'price', 'cost',
  'deadline', 'due', 'date', 'start', 'end', 'capacity', 'height', 'width', 'weight', 'count',
]);

const ZERO_VALUES = new Set(['0', 'none', 'zero', 'no']);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function normalizeSubject(subject: string): string {
  return subject.toLowerCase().replace(/['’]s\b/g, '').replace(/\s+/g, ' ').trim();
}

export function predicateTokens(predicate: string): string[] {
  return words(predicate).filter(token => !STOPWORDS.has(token));
}

export function normalizeValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.;,!]+$/u, '').trim();
}

/** True only for predicates that name a slot holding one value at a time. */
export function isSingleValued(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  if (tokens.some(token => MULTI_VALUE_CUES.has(token) || NEGATION.has(token))) return false;
  return tokens.some(token => SINGLE_VALUE_CUES.has(token));
}

export function sameSlot(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  const [small, big] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (!big.has(token)) return false;
  if (small.size === big.size) return true;
  // Only a short qualifier such as "3d" or "usb" may differ. A numbered slot
  // ("fallback_2") or a real modifier ("labeled count") is a different slot.
  if (small.size < 2) return false;
  for (const token of big) {
    if (!small.has(token) && (token.length > 3 || /^\d+$/.test(token))) return false;
  }
  return true;
}

function leadingValue(value: string): string {
  const tokens = words(value);
  if (tokens.length === 0) return '';
  if (ZERO_VALUES.has(tokens[0])) return '0';
  return tokens.length > 1 && /^\d+$/.test(tokens[1]) && !/^\d+$/.test(tokens[0])
    ? `${tokens[0]} ${tokens[1]}` : tokens[0];
}

export function sameValue(a: string, b: string): boolean {
  const left = normalizeValue(a);
  const right = normalizeValue(b);
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const head = leadingValue(left);
  if (head && head === leadingValue(right)) return true;
  const leftWords = new Set(words(left).filter(token => !STOPWORDS.has(token)));
  const rightWords = new Set(words(right).filter(token => !STOPWORDS.has(token)));
  if (leftWords.size === 0 || rightWords.size === 0) return false;
  let shared = 0;
  for (const token of leftWords) if (rightWords.has(token)) shared += 1;
  return shared / (leftWords.size + rightWords.size - shared) >= 0.6;
}

// PLAN_TRUTH_MAINTENANCE Loop B: legacy Hermes/OpenClaw stores and the
// ~/.claude/projects/-/ junk store (Memory/root__/) hold known-stale content and
// stay out of the contradiction queue until the legacy bulk-stale pass handles them.
const LEGACY_MEMORY_SOURCE = /^memory\/(?:hermes-|openclaw-|workspace__users-[^/]*--openclaw-workspace\/|root__\/)/i;

export function isLegacyMemorySource(sourceNodeId: string | null | undefined): boolean {
  return !!sourceNodeId && LEGACY_MEMORY_SOURCE.test(sourceNodeId);
}

/** Nightly cap on new queue rows (Loop B FM-B1); the rest wait for the next run. */
export const CONTRADICTION_EMISSION_CAP = 20;
/** Open cases above this page through the health check (same limit as the recall review queue). */
export const CONTRADICTION_QUEUE_LIMIT = 50;

/** True when two assertions give different values for one single-value slot. */
export function assertionsConflict(
  a: { subject: string; predicate: string; object: string },
  b: { subject: string; predicate: string; object: string },
): boolean {
  if (normalizeSubject(a.subject) !== normalizeSubject(b.subject)) return false;
  const left = predicateTokens(a.predicate);
  const right = predicateTokens(b.predicate);
  return isSingleValued(left) && isSingleValued(right) && sameSlot(left, right) && !sameValue(a.object, b.object);
}

export interface SlotAssertion {
  id: string;
  subject: string;
  predicate: string;
  object: string;
}

/** Pairs of assertions that give different values for the same single-value slot. */
export function conflictingPairs<T extends SlotAssertion>(assertions: readonly T[]): Array<[T, T]> {
  const bySubject = new Map<string, Array<{ tokens: string[]; row: T }>>();
  for (const row of assertions) {
    const tokens = predicateTokens(row.predicate);
    if (!isSingleValued(tokens)) continue;
    const key = normalizeSubject(row.subject);
    const group = bySubject.get(key) ?? [];
    group.push({ tokens, row });
    bySubject.set(key, group);
  }
  const pairs: Array<[T, T]> = [];
  for (const group of bySubject.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (!sameSlot(a.tokens, b.tokens) || sameValue(a.row.object, b.row.object)) continue;
        pairs.push(a.row.id < b.row.id ? [a.row, b.row] : [b.row, a.row]);
      }
    }
  }
  return pairs;
}
