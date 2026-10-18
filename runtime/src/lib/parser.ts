import { readdir, readFile } from 'fs/promises';
import { join, basename, normalize as normalizePath } from 'path';
import matter from 'gray-matter';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
  wikiLinkDocumentTarget,
} from './wiki-links.js';
import type { ParsedNode, ParsedEdge } from './types.js';
import { isKnownRelationType, DEFAULT_RELATION } from '../types/relations.js';

const EXCLUDED_DIRS = new Set([
  '.obsidian',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.claude',
  '_FileOrganizer2000',
  'attachments',
  'node_modules',
  'dist',
  'build',
  '.output',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'Transcripts',
  // Phase 7 cold storage: memories nothing recalled or cited for 60 days. Kept in the
  // vault (sync, backup, exact restore) but out of the index.
  'ColdMemory',
]);

export interface FrontmatterParse {
  fm: Record<string, unknown>;
  content: string;
  /** Human-readable anomaly description, or null when the parse looks healthy. */
  warning: string | null;
  /** True when gray-matter threw (fm is {} and content is the raw file). */
  threw: boolean;
}

/**
 * Parse frontmatter and surface anomalies instead of swallowing them.
 * A silent `{}` hid sync-conflict frontmatter corruption on 2026-06-10
 * (duplicated keys / stacked blocks in vault mirror copies), so every
 * suspicious shape now carries a warning the caller is expected to log:
 *  - parse throws (duplicate keys, malformed YAML)
 *  - file starts with a '---' block but yields zero frontmatter keys
 *  - parsed content still begins with '---' (stacked/duplicated blocks)
 */
export function parseFrontmatterLoud(raw: string, sourcePath: string): FrontmatterParse {
  try {
    const parsed = matter(raw);
    const fm = (parsed.data ?? {}) as Record<string, unknown>;
    let warning: string | null = null;
    if (Object.keys(fm).length === 0 && /^\uFEFF?\s*---/.test(raw)) {
      warning = `frontmatter parsed EMPTY in ${sourcePath} despite a leading '---' block — possible corruption (e.g. sync conflict-merge)`;
    } else if (/^---\n(?:[^\n]+\n)+?---(?:\n|$)/.test(parsed.content)) {
      // a COMPLETE second frontmatter block at content start (---, non-empty
      // lines, closing ---). A thematic-break '---' is followed by a blank
      // line and does not match — verified against both shapes.
      warning = `content of ${sourcePath} still begins with a complete '---' block — stacked/duplicated frontmatter`;
    }
    return { fm, content: parsed.content, warning, threw: false };
  } catch (e) {
    return {
      fm: {},
      content: raw,
      warning: `malformed frontmatter in ${sourcePath}: ${(e as Error).message.split('\n')[0]} — treating as plain markdown`,
      threw: true,
    };
  }
}

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  stubIds: Set<string>;
  skippedPaths: string[];
}

export interface ParseVaultOptions {
  includeFile?: (relativePath: string) => boolean;
  suppressUnresolvedLink?: (linkTarget: string) => boolean;
  /**
   * Drop generated link blocks (topic-linker footers, kg-enrich `## Related`
   * blocks) before content, FTS, embeddings, inline tags and wiki-link edges.
   * Vault files are untouched. Defaults to KG_STRIP_MANAGED_BLOCKS=1 (Phase R).
   */
  stripManagedBlocks?: boolean;
}

// An unterminated block runs to end of file: both writers append it last.
const MANAGED_BLOCK = /<!-- (topic-linker|kg-related):start -->[\s\S]*?(?:<!-- \1:end -->|$)/g;

export function stripManagedBlocks(content: string): string {
  const stripped = content.replace(MANAGED_BLOCK, '');
  return stripped === content ? content : stripped.replace(/\s+$/, '\n');
}

interface FrontmatterRelation {
  target: string;
  type?: string;
  since?: string;
  confidence?: number;
}

// Per-corpus relation vocabulary. A corpus may declare extra valid relation
// types in `.kg-relations.json` at its root, so domain graphs (game content,
// project deliverables, ...) get typed edges without polluting the core
// software/memory vocabulary in relations.ts. Shape: a JSON array of strings,
// or { "relationTypes": ["has_domain", "grants_card", ...] }. Missing file =
// core vocabulary only (behavior unchanged).
export async function loadCorpusRelationTypes(vaultPath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(vaultPath, '.kg-relations.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed as { relationTypes?: unknown })?.relationTypes;
    if (!Array.isArray(list)) {
      console.warn('.kg-relations.json: expected an array or { relationTypes: [...] } - ignoring');
      return new Set();
    }
    return new Set(list.filter((t): t is string => typeof t === 'string' && t.length > 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`.kg-relations.json: could not read (${(err as Error)?.message}) - ignoring`);
    }
    return new Set();
  }
}

/**
 * Build a canonical stub node id for an unresolved link target, guaranteed
 * to stay inside the `_stub/` namespace.
 *
 * Two hazards have to be neutralized before `documentTarget` gets
 * interpolated into `_stub/${documentTarget}.md`:
 *
 *  - Leading slash: an absolute-path target like `/etc/passwd` would
 *    otherwise produce `_stub//etc/passwd.md` (a double slash), which
 *    `canonicalSourceId` rejects outright because it isn't
 *    `path.normalize`-stable — this is the live production crash.
 *  - Parent traversal: a target like `../secrets` would otherwise produce
 *    `_stub/../secrets.md`. Calling `path.normalize()` on THAT would make
 *    things worse, not better — it collapses to `secrets.md`, escaping the
 *    `_stub/` namespace entirely and potentially colliding with a real node
 *    id. So traversal segments are rejected up front; normalize() is only
 *    ever used to *verify* canonicality afterward, never to *produce* the id.
 *
 * Returns null when no safe id can be constructed. Callers must skip the
 * edge (and not add anything to `stubIds`) rather than emit a poisoned id.
 */
function makeStubId(documentTarget: string): string | null {
  const withoutLeadingSlashes = documentTarget.replace(/^\/+/, '');
  const segments = withoutLeadingSlashes.split('/');
  if (segments.some(seg => seg === '..' || seg === '.')) return null;

  const candidate = `_stub/${withoutLeadingSlashes}.md`;
  if (
    typeof candidate !== 'string'
    || candidate.length < 1
    || candidate.length > 4096
    || /[\0\r\n]/.test(candidate)
    || normalizePath(candidate) !== candidate
    || !candidate.startsWith('_stub/')
  ) {
    return null;
  }
  return candidate;
}

export async function parseVault(
  vaultPath: string,
  options: ParseVaultOptions = {},
): Promise<ParseResult> {
  const discoveredPaths = await collectMarkdownFiles(vaultPath);
  const mdPaths = options.includeFile
    ? discoveredPaths.filter(path => options.includeFile!(path))
    : discoveredPaths;
  const includedPaths = new Set(mdPaths);
  const skippedPaths = discoveredPaths.filter(path => !includedPaths.has(path));
  const corpusRelationTypes = await loadCorpusRelationTypes(vaultPath);
  if (corpusRelationTypes.size > 0) {
    console.warn(`Loaded ${corpusRelationTypes.size} corpus relation type(s) from .kg-relations.json: ${[...corpusRelationTypes].join(', ')}`);
  }
  // Resolution must still know excluded/tombstoned paths. Otherwise a live
  // link to a suppressed source is misclassified as a new private stub.
  const stemLookup = buildStemLookup(discoveredPaths);
  const allPathsSet = new Set(discoveredPaths);
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  const stubIds = new Set<string>();
  const strip = options.stripManagedBlocks ?? process.env.KG_STRIP_MANAGED_BLOCKS === '1';

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);
    const raw = await readFile(absPath, 'utf-8');

    const parsed = parseFrontmatterLoud(raw, relPath);
    const { fm, warning } = parsed;
    const content = strip ? stripManagedBlocks(parsed.content) : parsed.content;
    if (warning) console.warn(`WARN: ${warning}`);

    const title = (fm.title as string)
      ?? basename(relPath, '.md');

    const inlineTags = extractInlineTags(content);
    const frontmatter = { ...fm };
    if (inlineTags.length > 0) {
      frontmatter.inline_tags = inlineTags;
    }

    nodes.push({ id: relPath, title, content, frontmatter });

    // Frontmatter relations array: explicit typed links with optional confidence/since
    const fmRelations = parseFrontmatterRelations(fm, corpusRelationTypes);
    for (const rel of fmRelations) {
      const documentTarget = wikiLinkDocumentTarget(rel.target);
      if (!documentTarget) continue;
      const targetId = resolveLink(documentTarget, stemLookup, allPathsSet);
      if (!targetId && options.suppressUnresolvedLink?.(documentTarget)) continue;
      let resolvedTarget: string;
      if (targetId) {
        resolvedTarget = targetId;
      } else {
        const stubId = makeStubId(documentTarget);
        if (!stubId) continue; // target cannot be made a safe stub id — skip the edge
        resolvedTarget = stubId;
        stubIds.add(resolvedTarget);
      }
      edges.push({
        sourceId: relPath,
        targetId: resolvedTarget,
        context: `[frontmatter relation: ${rel.type}]`,
        relationType: rel.type ?? DEFAULT_RELATION,
        confidence: rel.confidence ?? 1.0,
        since: rel.since,
      });
    }

    // Inline wiki links from content
    const links = extractWikiLinks(content);
    const paragraphs = content.split(/\n\n+/);

    for (const link of links) {
      const documentTarget = wikiLinkDocumentTarget(link.raw);
      if (!documentTarget) continue;
      const targetId = resolveLink(documentTarget, stemLookup, allPathsSet);
      if (!targetId && options.suppressUnresolvedLink?.(documentTarget)) continue;
      let resolvedTarget: string;
      if (targetId) {
        resolvedTarget = targetId;
      } else {
        const stubId = makeStubId(documentTarget);
        if (!stubId) continue; // target cannot be made a safe stub id — skip the edge
        resolvedTarget = stubId;
        stubIds.add(resolvedTarget);
      }

      const context = paragraphs.find(p => p.includes(`[[${link.raw}`))
        ?? paragraphs.find(p => p.includes(link.display ?? link.raw))
        ?? '';

      // If the display text matches a known relation type, use it as the relation_type
      const relationType = (link.display && isKnownRelationType(link.display, corpusRelationTypes))
        ? link.display
        : DEFAULT_RELATION;

      edges.push({
        sourceId: relPath,
        targetId: resolvedTarget,
        context: context.trim(),
        relationType,
        confidence: 1.0,
      });
    }
  }

  return { nodes, edges, stubIds, skippedPaths };
}

function parseFrontmatterRelations(fm: Record<string, unknown>, extra?: ReadonlySet<string>): FrontmatterRelation[] {
  const raw = fm.relations;
  if (!Array.isArray(raw)) return [];
  const result: FrontmatterRelation[] = [];
  for (const item of raw) {
    if (typeof item === 'object' && item !== null && 'target' in item && typeof (item as any).target === 'string') {
      const rel = item as Record<string, unknown>;
      const rawType = typeof rel.type === 'string' ? rel.type : DEFAULT_RELATION;
      const since = typeof rel.since === 'string' ? rel.since : undefined;
      const confidence = typeof rel.confidence === 'number' ? rel.confidence : 1.0;
      if (!isKnownRelationType(rawType, extra)) {
        console.warn(`Unknown relation type "${rawType}" in frontmatter — using '${DEFAULT_RELATION}'`);
      }
      result.push({
        target: rel.target as string,
        type: isKnownRelationType(rawType, extra) ? rawType : DEFAULT_RELATION,
        since,
        confidence,
      });
    }
  }
  return result;
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const matches = [...content.matchAll(/(?<!\w)#([a-zA-Z][\w-/]*)/g)];
  for (const m of matches) {
    tags.add(m[1]);
  }
  return [...tags];
}

async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // Syncthing writes the losing side of a conflict as
    // `<stem>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<DEVICEID><ext>` next to the
    // winner. It is never a note in its own right, and indexing it produced
    // 112 duplicate nodes on the mini during the 2026-09-11 vault re-share.
    // Match the full marker, not the words, so a note legitimately titled
    // about sync conflicts still indexes.
    if (entry.name.includes('.sync-conflict-')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(vaultPath, relPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(relPath);
    }
  }

  return results;
}
