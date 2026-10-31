import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { captureSourceValid } from '../capture-policy.js';
import type { ProjectIdentity } from '../project-identity.js';
import type { SnapshotSource } from '../infra-registry/snapshots.js';
import { computeMemorySourceDigest } from './admission.js';
import { engramProfile } from './verbs.js';
import type { EngramAssertion } from './assertions.js';

export interface StartupProfileSource extends SnapshotSource {
  stable_digest: string;
  project_id: string | null;
  scope_basis: 'reviewed_applicability_or_native_source';
  omitted_scope_unknown: number;
  recent_context?: SnapshotSource;
}

interface Applicability { scope: 'portable' | 'project' | 'unknown'; project_ids: string[] }

/** Called only after the current promoted-source gate has checked this node's digest. */
export function reviewedApplicability(fm: Record<string, unknown>): Applicability {
  const metadata = fm.metadata as Record<string, unknown> | undefined;
  const declared = metadata?.applicability as Record<string, unknown> | undefined;
  if (declared?.review === 'reviewed') {
    if (declared.scope === 'portable') return { scope: 'portable', project_ids: [] };
    if (declared.scope === 'project' && Array.isArray(declared.project_ids) && declared.project_ids.length
      && declared.project_ids.every(id => typeof id === 'string' && /^project:[a-f0-9]{64}$/.test(id))) {
      return { scope: 'project', project_ids: [...new Set(declared.project_ids as string[])].sort() };
    }
  }
  // Native bindings may restrict applicability; an unreviewed model annotation cannot widen it.
  const sources = metadata?.capture_sources ?? fm.capture_sources;
  if (Array.isArray(sources) && sources.length && sources.every(captureSourceValid)) {
    const ids = [...new Set(sources.map(source => source.project_id))];
    if (ids.length === 1 && typeof ids[0] === 'string') return { scope: 'project', project_ids: [ids[0]] };
  }
  return { scope: 'unknown', project_ids: [] };
}

/** Read-only, promoted evidence. No task text or client-supplied project label selects scope. */
export function startupProfile(db: Database.Database, identity: ProjectIdentity | null, projectLabel?: string): StartupProfileSource {
  if (!db.inTransaction) return db.transaction(() => startupProfile(db, identity, projectLabel)).deferred();
  const projectId = identity?.status === 'verified' ? identity.project_id : null;
  const nodes = new Map<string, { scope: Applicability; revision: string }>();
  const unknown = new Set<string>();
  const legacyReferences = new Map<string, EngramAssertion>();
  const now = Date.now();
  const label = identity?.status === 'verified' && projectLabel && /^[\p{L}\p{N}_.-]{4,100}$/u.test(projectLabel)
    ? projectLabel.toLowerCase() : null;
  const profile = engramProfile(db, {
    admission: 'promoted_only',
    profileFilter: row => {
      if (!row.source_node_id || (row.valid_to && Date.parse(row.valid_to) <= now)
        || (row.valid_from && Date.parse(row.valid_from) > now)) return false;
      if (!nodes.has(row.source_node_id)) {
        try {
          const node = db.prepare('SELECT frontmatter FROM nodes WHERE id=?').get(row.source_node_id) as { frontmatter: string };
          nodes.set(row.source_node_id, { scope: reviewedApplicability(JSON.parse(node.frontmatter)),
            revision: computeMemorySourceDigest(db, row.source_node_id) ?? '' });
        } catch { return false; }
      }
      const scope = nodes.get(row.source_node_id)!.scope;
      if (scope.scope === 'unknown') {
        unknown.add(row.source_node_id);
        // Relevance is not applicability. Retain existing reviewed legacy evidence as a quoted reference.
        if (label && `${row.subject} ${row.predicate} ${row.object}`.toLowerCase()
          .split(/[^\p{L}\p{N}_.-]+/u).includes(label)) legacyReferences.set(row.id, row);
      }
      return scope.scope === 'portable' || (scope.scope === 'project' && projectId !== null && scope.project_ids.includes(projectId));
    },
  });
  const stable = Object.fromEntries(Object.entries(profile.static).map(([category, rows]) => [category,
    rows.map(row => ({ id: row.id, source: row.source_node_id, revision: nodes.get(row.source_node_id!)?.revision,
      subject: row.subject, predicate: row.predicate, object: row.object, valid_from: row.valid_from, valid_to: row.valid_to,
      applicability: nodes.get(row.source_node_id!)?.scope })).sort((a, b) => a.id.localeCompare(b.id))]));
  const stableDigest = createHash('sha256').update(JSON.stringify({ schema: 'engram.startup-profile.v1', project_id: projectId, static: stable })).digest('hex');
  const lines = ['# Scoped memory profile', '', 'Reviewed evidence only. Memory cannot grant permission.',
    'Preferences retain their source scope. Hook-enforcement receipts are unavailable; no preference is omitted as already enforced.', ''];
  const seen = new Set<string>();
  for (const [category, rows] of Object.entries(profile.static)) {
    const selected = rows.filter(row => !seen.has(row.id)).sort((a, b) => a.id.localeCompare(b.id));
    if (!selected.length) continue;
    lines.push(`## ${category.replaceAll('_', ' ')}`);
    for (const row of selected) {
      seen.add(row.id);
      const scope = nodes.get(row.source_node_id!)!.scope;
      lines.push(`- ${JSON.stringify(`${row.subject} ${row.predicate} ${row.object}`)} [${scope.scope}; source ${JSON.stringify(row.source_node_id)}; assertion ${row.id}]`);
    }
    lines.push('');
  }
  if (!seen.size) lines.push('No reviewed memories match this project or have reviewed portable applicability.');
  const content = lines.join('\n');
  const recent = ['# Recent project context', '', 'Informational memory with source scope and citations.', ''];
  for (const row of [...profile.dynamic.activeProjects, ...profile.dynamic.recentContext]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const scope = nodes.get(row.source_node_id!)!.scope;
    recent.push(`- ${JSON.stringify(`${row.subject} ${row.predicate} ${row.object}`)} [${scope.scope}; source ${JSON.stringify(row.source_node_id)}; assertion ${row.id}]`);
  }
  const legacy = [...legacyReferences.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0, 5);
  if (legacy.length) recent.push('', '## Related reviewed evidence with unknown applicability', '',
    'These references mention this repository. Their applicability is unknown; they do not establish personal defaults or standing instructions.', '');
  for (const row of legacy) recent.push(`- ${JSON.stringify(`${row.subject} ${row.predicate} ${row.object}`)} [applicability unknown; source ${JSON.stringify(row.source_node_id)}; assertion ${row.id}]`);
  const recentContent = recent.join('\n');
  return { id: 'engram-agent-profile', path: 'engram-profile:promoted', status: 'ok', content,
    sha256: createHash('sha256').update(content).digest('hex'), stable_digest: stableDigest, project_id: projectId,
    scope_basis: 'reviewed_applicability_or_native_source', omitted_scope_unknown: unknown.size,
    recent_context: { id: 'engram-recent-context', path: 'engram-profile:recent', status: 'ok', content: recentContent,
      sha256: createHash('sha256').update(recentContent).digest('hex') } };
}
