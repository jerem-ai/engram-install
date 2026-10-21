import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Note claims (extraction/note_claims.py, October 20, OBSERVE.md 15g). Session logs,
 * topics, ideas and conversation notes take appended footers only, so their typed
 * claims live in a sidecar, `~/.local/share/engram/note-claims.jsonl`, one record per
 * note (a later record replaces an earlier one). Each claim quotes the note's own
 * text. The indexer submits a claim bound to the note's digest
 * (`note-claims-v1:<digest>`) and it is admitted in place, like an extracted claim,
 * only while every quoted passage is still in the note.
 */
export const NOTE_CLAIMS_SCHEMA = 'engram.note-claims.v1';
export const NOTE_CLAIMS_PREFIX = 'note-claims-v1:';

export interface NoteClaim {
  subject: string;
  predicate: string;
  object: string;
  passages: string[];
  valid_from: string | null;
  valid_to: string | null;
}

export interface NoteClaimsRecord {
  schema: string;
  node_id: string;
  evidence_sha256: string;
  session_id: string | null;
  claims: NoteClaim[];
  model: string;
  at: string;
}

interface Triple { subject: string; predicate: string; object: string }

export type NoteClaimsLookup = (nodeId: string) => NoteClaimsRecord | null;

export function noteClaimsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.ENGRAM_NOTE_CLAIMS ?? join(home, '.local/share/engram/note-claims.jsonl');
}

export function parseNoteClaims(text: string): Map<string, NoteClaimsRecord> {
  const out = new Map<string, NoteClaimsRecord>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as NoteClaimsRecord;
      if (rec.schema === NOTE_CLAIMS_SCHEMA && typeof rec.node_id === 'string' && Array.isArray(rec.claims)) out.set(rec.node_id, rec);
    } catch {}
  }
  return out;
}

export function lookupNoteClaims(records: Map<string, NoteClaimsRecord>): NoteClaimsLookup {
  return (nodeId) => records.get(nodeId) ?? null;
}

/** A lookup over the sidecar file, re-read when its size or mtime changes. No file: no claims. */
export function fileNoteClaims(path = noteClaimsPath()): NoteClaimsLookup {
  let stamp = '';
  let lookup: NoteClaimsLookup = () => null;
  return (nodeId) => {
    if (!existsSync(path)) return null;
    const s = statSync(path);
    const now = `${s.size}:${s.mtimeMs}`;
    if (now !== stamp) { lookup = lookupNoteClaims(parseNoteClaims(readFileSync(path, 'utf8'))); stamp = now; }
    return lookup(nodeId);
  };
}

function wellFormed(c: unknown): c is NoteClaim {
  const x = c as Record<string, unknown>;
  return !!x && typeof x.subject === 'string' && !!x.subject.trim() && typeof x.predicate === 'string' && !!x.predicate.trim()
    && typeof x.object === 'string' && !!x.object.trim() && Array.isArray(x.passages) && x.passages.length > 0
    && x.passages.every(p => typeof p === 'string' && p.trim().length > 0);
}

/** The note's claims whose every quoted passage is still in its content. */
export function standingNoteClaims(lookup: NoteClaimsLookup, nodeId: string, content: string): NoteClaim[] {
  const rec = lookup(nodeId);
  if (!rec) return [];
  return rec.claims.filter(c => wellFormed(c) && c.passages.every(p => content.includes(p)));
}

/** The standing claim with this exact (trimmed) triple, or null. */
export function findNoteClaim(lookup: NoteClaimsLookup, nodeId: string, t: Triple, content: string): NoteClaim | null {
  return standingNoteClaims(lookup, nodeId, content).find(c => c.subject.trim() === t.subject
    && c.predicate.trim() === t.predicate && c.object.trim() === t.object) ?? null;
}
