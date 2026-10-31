import { createHash } from 'node:crypto';
import type { ContextBootstrapResult } from './context-bootstrap.js';
import type { SnapshotSource } from './infra-registry/snapshots.js';

export type BootstrapDocument = SnapshotSource & { essential: boolean; bytes?: number; truncated?: boolean };
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Heading sections retain complete lines and fenced examples, including non-ASCII text. */
export function contextSections(content: string): Array<{ id: string; start_line: number; end_line: number; sha256: string; content: string }> {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const starts = [0]; let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
    } else if (!fence && i > 0 && /^#{1,6}\s+\S/.test(lines[i])) starts.push(i);
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length; const text = lines.slice(start, end).join('');
    return { id: `L${start + 1}-${end}`, start_line: start + 1, end_line: end, sha256: hash(text), content: text };
  });
}

/** Select complete quoted paragraphs. These are reference excerpts, never replacement instructions. */
function excerpts(document: BootstrapDocument, task: string | null): Array<{ source_id: string; section_id: string; content: string }> {
  if (document.essential || document.id.startsWith('global-') || document.status !== 'ok' || !document.content) return [];
  const memory = document.id === 'engram-agent-profile' || document.id === 'engram-recent-context';
  const tokens = [...new Set((task ?? '').toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])];
  const output: Array<{ source_id: string; section_id: string; content: string; score: number; order: number }> = [];
  for (const section of contextSections(document.content)) {
    let block: string[] = []; let fence = ''; let offset = section.start_line;
    const flush = (): void => {
      const text = block.join('').trim();
      if (text && (!memory || text.startsWith('- ')) && !/^#{1,6}[^\n]+$/.test(text) && Buffer.byteLength(text) <= 1400) {
        output.push({ source_id: document.id, section_id: `${section.id}:${offset}`, content: text,
          score: tokens.reduce((n, token) => n + Number(text.toLowerCase().includes(token)), 0), order: output.length });
      }
      offset += block.length; block = [];
    };
    for (const line of section.content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      // Rendered memory bullets are independently quoted, complete assertion records.
      if (memory && line.startsWith('- ')) flush();
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      }
      if (!fence && !line.trim()) { flush(); offset++; } else block.push(line);
    }
    flush();
  }
  return output.sort((a, b) => b.score - a.score || a.order - b.order).map(({ source_id, section_id, content }) => ({ source_id, section_id, content }));
}

export function packBootstrap(
  result: ContextBootstrapResult, documents: BootstrapDocument[], maxBytes: number, sourceId?: string,
): ContextBootstrapResult {
  documents = documents.map(source => ({ ...source }));
  const rankingTask = result.task;
  const required = documents.filter(source => source.essential);
  const manifest = required.map(source => ({ source_id: source.id, sha256: source.source_sha256 ?? source.sha256 ?? null, status: source.status,
    sections: source.content ? contextSections(source.content).map(({ content: _content, ...section }) => ({ ...section, required: true })) : [] }));
  const manifestText = JSON.stringify({ schema: 'engram.essential-context.v1', sources: manifest });
  const manifestDigest = hash(manifestText);
  const manifestDocument: BootstrapDocument = { id: 'essential-context-manifest', path: 'bootstrap:essential-context', status: 'ok',
    sha256: manifestDigest, content: manifestText, essential: false };
  const all = [...documents, manifestDocument];
  const matches = result.infrastructure.matches; const commands = result.verification_commands;
  result.infrastructure.matches = []; result.verification_commands = [];
  for (const source of [result.native_guidance, ...result.reference_guidance, ...result.project_context, result.engram_profile, result.recent_context]) {
    if (source) delete source.content;
  }
  result.sources = all.map(source => ({ id: source.id, status: source.status, sha256: source.sha256,
    ...(source.source_sha256 && source.source_sha256 !== source.sha256 ? { revision: source.source_sha256 } : {}),
    bytes: source.bytes ?? (source.content ? Buffer.byteLength(source.content) : undefined), essential: source.essential }));
  result.source_fetch = { tool: 'context_bootstrap', arguments: { agent: result.agent, max_bytes: 262144 },
    reuse_project_parameters: true, selector: 'source_id' };
  result.essential_context = { manifest_sha256: manifestDigest, manifest_source_id: manifestDocument.id };
  result.required_reads = required.map(source => source.id);
  result.status = 'incomplete_required_context';
  result.brief = { excerpts_are_partial_references: true, sections: [] };
  result.packing = { max_bytes: maxBytes, omitted_sources: all.length, omitted_infrastructure_matches: matches.length };
  const within = (): boolean => size(result) <= maxBytes;
  // Keep every source ID and revision discoverable even when optional diagnostics are large.
  if (!within()) { result.task = null; result.warnings = ['Optional diagnostics omitted to preserve the complete source index.']; }
  if (!within() || maxBytes <= 8192) {
    if (maxBytes <= 8192) { result.task = null; delete result.infrastructure.summary; }
    for (const source of [result.native_guidance, ...result.reference_guidance, result.engram_profile, result.recent_context, ...result.project_context]) {
      if (source) for (const key of Object.keys(source)) if (!['id', 'status', 'error'].includes(key)) delete (source as unknown as Record<string, unknown>)[key];
    }
  }
  if (!within()) { delete result.infrastructure.summary; delete result.infrastructure.error; }
  if (!within()) throw new Error('Bootstrap source index exceeds the requested budget; request a larger max_bytes.');
  const included = new Set<string>();
  const put = (document: BootstrapDocument): boolean => {
    if (document.status !== 'ok' || document.content === undefined || document.truncated) return false;
    const target = document.id === result.native_guidance?.id ? result.native_guidance
      : result.reference_guidance.find(s => s.id === document.id)
        ?? result.project_context.find(s => s.id === document.id)
        ?? (document.id === result.engram_profile?.id ? result.engram_profile : undefined)
        ?? (document.id === result.recent_context?.id ? result.recent_context : undefined);
    if (!target) return false;
    const duplicate = documents.find(source => included.has(source.id) && source.content === document.content);
    if (duplicate) {
      target.duplicate_of = duplicate.id;
      if (!within()) { delete target.duplicate_of; return false; }
      included.add(document.id); return true;
    }
    target.content = document.content;
    if (!within()) { delete target.content; return false; }
    included.add(document.id); return true;
  };
  if (sourceId) {
    const document = all.find(source => source.id === sourceId);
    result.detail = { source_id: sourceId, complete: false, ...(document ? { path: document.path } : {}) };
    if (document?.status === 'ok' && document.content !== undefined && !document.truncated) {
      result.detail.content = document.content;
      if (within()) { result.detail.complete = true; included.add(document.id); }
      else {
        delete result.detail.content;
        result.warnings.push('The complete source exceeds this packet budget. Read detail.path with the approved file reader.');
      }
    } else result.warnings.push('Requested source is missing, withheld, or unknown.');
  } else {
    // A small useful overview survives even when a long required document needs a separate read.
    const overviewBudget = Math.min(2200, Math.floor(maxBytes / 4)); const before = size(result);
    const overviewSources = [...documents].sort((a, b) => {
      const priority = (id: string): number => ['project-brief.md', 'project-project_soul.md', 'engram-agent-profile', 'engram-recent-context', 'project-readme.md'].indexOf(id);
      return (priority(a.id) < 0 ? 99 : priority(a.id)) - (priority(b.id) < 0 ? 99 : priority(b.id));
    });
    for (const document of overviewSources.filter(source => !source.essential)) {
      const excerpt = excerpts(document, rankingTask)[0]; if (!excerpt) continue;
      result.brief.sections.push(excerpt);
      if (!within() || size(result) - before > overviewBudget) result.brief.sections.pop();
    }
    for (const source of required) put(source);
    for (const source of documents.filter(source => !source.essential)) put(source);
    // Give sources that could not fit whole a chance to contribute a complete quoted paragraph.
    for (const document of documents.filter(source => !included.has(source.id))) {
      for (const excerpt of excerpts(document, rankingTask).slice(0, 2)) {
        if (result.brief.sections.some(s => s.source_id === excerpt.source_id && s.content === excerpt.content)) continue;
        result.brief.sections.push(excerpt); if (!within()) result.brief.sections.pop();
      }
    }
  }
  result.required_reads = required.filter(source => !included.has(source.id)).map(source => source.id);
  result.status = result.required_reads.length ? 'incomplete_required_context' : 'ready';
  result.packing.omitted_sources = all.filter(source => !included.has(source.id)).length;
  for (const match of matches) { result.infrastructure.matches.push(match); if (!within()) result.infrastructure.matches.pop(); }
  result.packing.omitted_infrastructure_matches = matches.length - result.infrastructure.matches.length;
  for (const command of commands) { result.verification_commands.push(command); if (!within()) result.verification_commands.pop(); }
  if (!within()) throw new Error('Unable to compose bootstrap within the requested byte budget.');
  return result;
}
