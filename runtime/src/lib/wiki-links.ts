export interface RawLink {
  raw: string;       // the part to resolve (path or bare name)
  display: string | null;  // pipe alias or relation type hint, if any
}

/**
 * Extract wiki links from markdown, ignoring code blocks and embedded images.
 */
export function extractWikiLinks(markdown: string): RawLink[] {
  const links: RawLink[] = [];

  // Remove code blocks first
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '');

  // Match [[...]] but not ![[...]]
  const matches = [...withoutCode.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)];
  for (const match of matches) {
    const inner = match[1];
    const pipeIndex = inner.indexOf('|');
    if (pipeIndex !== -1) {
      links.push({
        raw: inner.substring(0, pipeIndex),
        display: inner.substring(pipeIndex + 1),
      });
    } else {
      links.push({ raw: inner, display: null });
    }
  }

  return links;
}

/**
 * Build a lookup table mapping filename stems to their full paths.
 */
export function buildStemLookup(allPaths: string[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const p of allPaths) {
    const stem = p.replace(/\.md$/, '').split('/').pop()!;
    const existing = lookup.get(stem) ?? [];
    existing.push(p);
    lookup.set(stem, existing);
  }
  return lookup;
}

/**
 * Resolve a wiki link reference to a vault-relative path.
 * Returns null for unresolvable links (these become stub nodes).
 */
export function resolveLink(
  raw: string,
  stemLookup: Map<string, string[]>,
  allPathsSet?: Set<string>,
): string | null {
  raw = wikiLinkDocumentTarget(raw);
  if (!raw) return null;
  // Path-qualified: try direct match first
  const withMd = raw.endsWith('.md') ? raw : raw + '.md';
  const pathSet = allPathsSet ?? new Set([...stemLookup.values()].flat());
  if (pathSet.has(withMd)) {
    return withMd;
  }

  // Bare name: look up stem
  const stem = raw.split('/').pop()!;
  const candidates = stemLookup.get(stem);
  if (!candidates || candidates.length === 0) {
    return null;  // stub node
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  // Ambiguous — prefer path-qualified match if the raw includes a directory
  if (raw.includes('/')) {
    const match = candidates.find(c => c.startsWith(raw.replace(/\.md$/, '')));
    if (match) return match;
  }

  // Fall back to first match and log warning
  console.warn(`Ambiguous wiki link [[${raw}]]: ${candidates.join(', ')}. Using first match.`);
  return candidates[0];
}

/** Strip Obsidian heading/block fragments before resolving document identity. */
export function wikiLinkDocumentTarget(raw: string): string {
  const fragmentIndex = raw.search(/[#^]/);
  return (fragmentIndex >= 0 ? raw.slice(0, fragmentIndex) : raw).trim();
}
