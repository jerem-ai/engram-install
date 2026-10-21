import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { factLinkKey } from './provenance.js';

/**
 * Per-claim review verdicts (extraction/claim_review.py, October 20). The write-time
 * support judge checks a memory as a whole; this sidecar holds one verdict per
 * typed claim, judged against that claim's own passages. Verdicts live outside the
 * vault, in `~/.local/share/engram/claim-verdicts.jsonl` (Jeremy, October 20: no new
 * review field in note frontmatter), and are keyed like fact links.
 *
 * Only a verdict from a qualified reviewer (`qualified: true`, written only when a
 * validation receipt for that reviewer passed) counts, and only while the claim's
 * passages are the ones that were judged. Anything else is ignored, so an unqualified
 * or stale verdict can never hold or retire a fact.
 */
export const CLAIM_VERDICT_SCHEMA = 'engram.claim-verdict.v1';

export interface ClaimVerdict {
  schema: string;
  key: string;
  source_node_id: string;
  subject: string;
  predicate: string;
  object: string;
  passages_sha256: string;
  verdict: 'supported' | 'unsupported';
  by: string;
  reviewer: string;
  qualified: boolean;
  reason?: string;
  at: string;
}

interface Triple { subject: string; predicate: string; object: string }

export function claimVerdictsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.ENGRAM_CLAIM_VERDICTS ?? join(home, '.local/share/engram/claim-verdicts.jsonl');
}

/** Same digest as claim_review.passages_sha256(): the passages joined by NUL. */
export function passagesDigest(passages: string[]): string {
  return createHash('sha256').update(passages.join('\0')).digest('hex').slice(0, 32);
}

export type ClaimVerdictLookup = (sourceNodeId: string, claim: Triple, passages: string[]) => ClaimVerdict | null;

/** The latest record per key; a later record replaces an earlier one. */
export function parseClaimVerdicts(text: string): Map<string, ClaimVerdict> {
  const out = new Map<string, ClaimVerdict>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ClaimVerdict;
      if (rec.schema === CLAIM_VERDICT_SCHEMA && typeof rec.key === 'string') out.set(rec.key, rec);
    } catch {}
  }
  return out;
}

export function lookupIn(verdicts: Map<string, ClaimVerdict>): ClaimVerdictLookup {
  return (sourceNodeId, claim, passages) => {
    const rec = verdicts.get(factLinkKey(sourceNodeId, claim));
    if (!rec || rec.qualified !== true || rec.passages_sha256 !== passagesDigest(passages)) return null;
    return rec;
  };
}

/** A lookup over the sidecar file, re-read when its size or mtime changes. No file: no verdicts. */
export function fileClaimVerdicts(path = claimVerdictsPath()): ClaimVerdictLookup {
  let stamp = '';
  let lookup: ClaimVerdictLookup = () => null;
  return (sourceNodeId, claim, passages) => {
    if (!existsSync(path)) return null;
    const s = statSync(path);
    const now = `${s.size}:${s.mtimeMs}`;
    if (now !== stamp) { lookup = lookupIn(parseClaimVerdicts(readFileSync(path, 'utf8'))); stamp = now; }
    return lookup(sourceNodeId, claim, passages);
  };
}

/** True when a qualified reviewer found this claim's own passages do not back it. */
export function claimUnsupported(lookup: ClaimVerdictLookup, sourceNodeId: string, claim: Triple, passages: string[]): boolean {
  return lookup(sourceNodeId, claim, passages)?.verdict === 'unsupported';
}
