import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { isAbsolute, basename, relative, resolve, dirname, normalize as normalizePath } from 'path';
import matter from 'gray-matter';
import { parseFrontmatterLoud } from './parser.js';
import type { Store } from './store.js';

export interface CreateNodeOptions {
  title: string;
  directory?: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface DurableNodeResult {
  sourceNodeId: string;
  disposition: 'created' | 'reused';
}

export interface AssertionSourceFrontmatter {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  status?: string;
  valid_from: string;
}

export interface AssertionSourceResult {
  sourceNodeId: string;
  disposition: 'created' | 'updated' | 'reused';
}

export class VaultWriter {
  constructor(
    private vaultPath: string,
    private store: Store,
  ) {}

  createNode(opts: CreateNodeOptions): string {
    if (!isSafeTitle(opts.title)) {
      throw new Error(`Unsafe node title: ${opts.title}`);
    }

    const filename = `${opts.title}.md`;
    const relPath = opts.directory ? `${opts.directory}/${filename}` : filename;
    this.store.assertSourceNotErased(relPath);
    const absPath = this.safePath(relPath, false);
    const dir = dirname(absPath);
    mkdirSync(dir, { recursive: true });
    this.safePath(relPath, false);

    const fileContent = serializeNode(opts);
    try {
      writeFileSync(absPath, fileContent, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`File already exists: ${relPath}`, { cause: error });
      }
      throw error;
    }

    try {
      // Index in store. If indexing fails, remove the file so callers never
      // observe a vault-only half write.
      this.indexFile(relPath);
    } catch (error) {
      unlinkSync(absPath);
      throw error;
    }

    return relPath;
  }

  createOrReuseNode(opts: CreateNodeOptions): DurableNodeResult {
    if (!isSafeTitle(opts.title)) {
      throw new Error(`Unsafe node title: ${opts.title}`);
    }
    const relPath = opts.directory ? `${opts.directory}/${opts.title}.md` : `${opts.title}.md`;
    const expected = serializeNode(opts);
    const existing = this.resolveExistingNodeId(relPath);
    if (existing) {
      if (!sameDurableNode(readFileSync(this.safePath(existing, true), 'utf-8'), expected)) {
        throw new Error(`Durable node content mismatch: ${relPath}`);
      }
      return { sourceNodeId: existing, disposition: 'reused' };
    }

    try {
      return { sourceNodeId: this.createNode(opts), disposition: 'created' };
    } catch (error) {
      // A concurrent identical writer may win the exclusive create. Re-read
      // the file and accept it only when every byte matches.
      if ((error as Error).message === `File already exists: ${relPath}`
        && sameDurableNode(readFileSync(this.safePath(relPath, true), 'utf-8'), expected)) {
        return { sourceNodeId: relPath, disposition: 'reused' };
      }
      throw error;
    }
  }

  annotateNode(nodeId: string, content: string): void {
    this.store.assertSourceNotErased(nodeId);
    const absPath = this.safePath(nodeId, true);

    appendFileSync(absPath, content, 'utf-8');

    // Re-index
    this.indexFile(nodeId);
  }

  resolveExistingNodeId(nodeId: string): string | undefined {
    if (!nodeId.trim()) return undefined;

    const direct = nodeId.trim();
    if (!isSafeRelativePath(direct)) return undefined;

    if (this.isInsideVault(direct) && existsSync(this.safePath(direct, false))) return direct;

    if (!direct.endsWith('.md')) {
      const withExtension = `${direct}.md`;
      if (this.isInsideVault(withExtension) && existsSync(this.safePath(withExtension, false))) {
        return withExtension;
      }
    }

    return undefined;
  }

  upsertAssertionSource(
    nodeId: string,
    assertion: AssertionSourceFrontmatter,
  ): AssertionSourceResult {
    return this.upsertAssertionInNode(nodeId, assertion);
  }

  createOrUpdateAssertionSource(
    title: string,
    directory: string,
    assertion: AssertionSourceFrontmatter,
  ): AssertionSourceResult {
    const nodeId = `${directory}/${title}.md`;
    if (!this.isInsideVault(nodeId)) {
      throw new Error(`Unsafe vault path: ${nodeId}`);
    }
    if (existsSync(this.safePath(nodeId, false))) {
      return this.upsertAssertionInNode(nodeId, assertion);
    }

    const relPath = this.createNode({
      title,
      directory,
      frontmatter: {
        type: 'engram_assertion_source',
        assertions: [assertion],
        created: assertion.valid_from,
      },
      content: 'Structured Engram assertion source.',
    });
    return { sourceNodeId: relPath, disposition: 'created' };
  }

  updateAssertionStatus(
    nodeId: string,
    assertion: Pick<AssertionSourceFrontmatter, 'subject' | 'predicate' | 'object'>,
    status: string,
  ): boolean {
    this.store.assertSourceNotErased(nodeId);
    const existingNodeId = this.resolveExistingNodeId(nodeId);
    if (!existingNodeId) return false;

    const absPath = this.safePath(existingNodeId, true);
    const raw = readFileSync(absPath, 'utf-8');
    const { fm, content, warning, threw } = parseFrontmatterLoud(raw, existingNodeId);
    if (warning) console.warn(`WARN: ${warning}`);
    if (threw) {
      throw new Error(`Cannot update malformed frontmatter in ${existingNodeId}`);
    }

    const existing = Array.isArray(fm.assertions) ? fm.assertions : [];
    const idx = existing.findIndex(a => sameAssertion(a, assertion));
    if (idx < 0) return false;

    const nextAssertions = [...existing];
    const current = nextAssertions[idx] as Record<string, unknown>;
    nextAssertions[idx] = { ...current, status };
    writeFileSync(absPath, matter.stringify(content, { ...fm, assertions: nextAssertions }), 'utf-8');
    this.indexFile(existingNodeId);
    return true;
  }

  addLink(sourceId: string, targetRef: string, context: string): void {
    this.store.assertSourceNotErased(sourceId);
    const targetId = targetRef.endsWith('.md') ? targetRef : targetRef + '.md';
    this.store.assertSourceNotErased(targetId);
    const absPath = this.safePath(sourceId, true);

    const line = `\n${context} [[${targetRef}]]`;
    appendFileSync(absPath, line, 'utf-8');

    // Re-index source node
    this.indexFile(sourceId);

    // Add edge to store
    this.store.insertEdge({
      sourceId,
      targetId,
      context,
      relationType: 'relates_to',
      confidence: 1.0,
    });
  }

  deleteSource(nodeId: string): 'deleted' | 'missing' {
    if (!isSafeRelativePath(nodeId)) throw new Error('Unsafe vault source path');
    const absPath = this.safePath(nodeId, false);
    if (!existsSync(absPath)) return 'missing';
    const file = lstatSync(absPath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error('Vault source is not a regular file');
    }
    // safePath() resolves the existing target and refuses ancestors outside the
    // vault. The writer never follows or recursively removes a deletion target.
    this.safePath(nodeId, true);
    unlinkSync(absPath);
    return 'deleted';
  }

  private indexFile(relPath: string): void {
    this.store.assertSourceNotErased(relPath);
    const absPath = this.safePath(relPath, true);
    const raw = readFileSync(absPath, 'utf-8');

    const { fm, content, warning } = parseFrontmatterLoud(raw, relPath);
    if (warning) console.warn(`WARN: ${warning}`);

    const title = (fm.title as string) ?? basename(relPath, '.md');

    this.store.upsertNode({
      id: relPath,
      title,
      content,
      frontmatter: fm,
    });
  }

  private upsertAssertionInNode(
    nodeId: string,
    assertion: AssertionSourceFrontmatter,
  ): AssertionSourceResult {
    this.store.assertSourceNotErased(nodeId);
    if (!this.isInsideVault(nodeId)) {
      throw new Error(`Unsafe vault path: ${nodeId}`);
    }
    const absPath = this.safePath(nodeId, true);

    const raw = readFileSync(absPath, 'utf-8');
    const { fm, content, warning, threw } = parseFrontmatterLoud(raw, nodeId);
    if (warning) console.warn(`WARN: ${warning}`);
    if (threw) {
      throw new Error(`Cannot update malformed frontmatter in ${nodeId}`);
    }

    const existing = Array.isArray(fm.assertions) ? fm.assertions : [];
    const idx = existing.findIndex(a => sameAssertion(a, assertion));
    let disposition: 'updated' | 'reused' = 'updated';
    const nextAssertions = [...existing];

    if (idx >= 0) {
      const current = nextAssertions[idx] as Record<string, unknown>;
      const stableAssertion = {
        ...assertion,
        valid_from: typeof current.valid_from === 'string' ? current.valid_from : assertion.valid_from,
      };
      if (JSON.stringify(current) === JSON.stringify(stableAssertion)) {
        disposition = 'reused';
      }
      nextAssertions[idx] = stableAssertion;
    } else {
      nextAssertions.push(assertion);
    }

    const nextFrontmatter = { ...fm, assertions: nextAssertions };
    writeFileSync(absPath, matter.stringify(content, nextFrontmatter), 'utf-8');
    this.indexFile(nodeId);
    return { sourceNodeId: nodeId, disposition };
  }

  private isInsideVault(nodeId: string): boolean {
    try {
      this.safePath(nodeId, false);
      return true;
    } catch {
      return false;
    }
  }

  private safePath(nodeId: string, requireExisting: boolean): string {
    if (!isSafeRelativePath(nodeId)) {
      throw new Error(`Unsafe vault path: ${nodeId}`);
    }

    const vaultRoot = realpathSync(this.vaultPath);
    const target = resolve(vaultRoot, nodeId);
    if (!isInside(vaultRoot, target)) {
      throw new Error(`Unsafe vault path: ${nodeId}`);
    }

    if (requireExisting && !existsSync(target)) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    let existingAncestor = target;
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error(`Unsafe vault path: ${nodeId}`);
      }
      existingAncestor = parent;
    }

    const ancestorRealPath = realpathSync(existingAncestor);
    if (!isInside(vaultRoot, ancestorRealPath)) {
      throw new Error(`Unsafe vault path: ${nodeId}`);
    }
    const canonicalTarget = resolve(ancestorRealPath, relative(existingAncestor, target));
    if (relative(vaultRoot, canonicalTarget) !== nodeId) {
      throw new Error(`Noncanonical vault path: ${nodeId}`);
    }

    return target;
  }
}

function serializeNode(opts: CreateNodeOptions): string {
  return matter.stringify(opts.content, { title: opts.title, ...opts.frontmatter });
}

/**
 * A durable node still matches when its frontmatter is the same data and its
 * body starts with the written body. Vault tools append footers (topic-linker's
 * See Also block on 2026-10-04) and reformat YAML quoting; neither changes the
 * fact, but a byte comparison made every retry fail. A changed field, or an
 * edit inside the written body, still mismatches.
 */
function sameDurableNode(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  let have: matter.GrayMatterFile<string>;
  let want: matter.GrayMatterFile<string>;
  try {
    have = matter(actual, {});
    want = matter(expected, {});
  } catch {
    return false;
  }
  return canonicalJson(have.data) === canonicalJson(want.data)
    && have.content.startsWith(want.content.trimEnd());
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function sameAssertion(
  a: unknown,
  b: Pick<AssertionSourceFrontmatter, 'subject' | 'predicate' | 'object'>,
): boolean {
  if (!a || typeof a !== 'object') return false;
  const row = a as Record<string, unknown>;
  return normalize(row.subject) === normalize(b.subject)
    && normalize(row.predicate) === normalize(b.predicate)
    && normalize(row.object) === normalize(b.object);
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isSafeRelativePath(path: string): boolean {
  return path.trim().length > 0
    && normalizePath(path) === path
    && !path.includes('\\')
    && !path.includes('\0')
    && !isAbsolute(path)
    && !path.split('/').some(part => part === '..' || part === '.');
}

function isSafeTitle(title: string): boolean {
  return title.trim().length > 0
    && title === basename(title)
    && title !== '.'
    && title !== '..'
    && !title.includes('/')
    && !title.includes('\\')
    && !title.includes('\0');
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
