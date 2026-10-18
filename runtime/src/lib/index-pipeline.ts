import { stat, readdir, readFile, access } from 'fs/promises';
import { join, basename } from 'path';
import { hostname } from 'os';
import { parseFrontmatterLoud } from './parser.js';
import { parseVault } from './parser.js';
import type { Store } from './store.js';
import { Embedder } from './embedder.js';
import { KnowledgeGraph } from './graph.js';
import type { DocRoot, GraphRoot } from './config.js';
import type { MemoryAdmissionService } from './engram/admission.js';

export interface IndexStats {
  nodesIndexed: number;
  nodesSkipped: number;
  edgesIndexed: number;
  communitiesDetected: number;
  stubNodesCreated: number;
}

export interface MemoryIndexStats {
  memoriesIndexed: number;
  memoriesSkipped: number;
  memoriesDeleted: number;
}

export interface DocsIndexStats {
  docsIndexed: number;
  docsSkipped: number;
  docsDeleted: number;
}

export interface CodeIndexStats {
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  edgesIndexed: number;
}

export interface CrossLayerStats {
  docEdges: number;
  memoryEdges: number;
  docDriftEdges: number;
  skipped: number;
}

export class IndexPipeline {
  constructor(
    private store: Store,
    private embedder: Embedder,
    private memoryAdmission?: MemoryAdmissionService,
    private allowLegacyImmediateAssertionsForTests = false,
  ) {}

  async index(vaultPath: string, resolution = 1.0): Promise<IndexStats> {
    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
    };

    const { nodes, edges, stubIds, skippedPaths } = await parseVault(vaultPath, {
      includeFile: relativePath => !this.store.isSourceErased(relativePath),
      suppressUnresolvedLink: linkTarget => this.store.isUnresolvedLinkTargetErased(linkTarget),
    });
    stats.nodesSkipped += skippedPaths.length;
    const previousPaths = this.store.getAllSyncPaths();

    // Detect deleted files — only consider vault paths (relative).
    // Memory paths are absolute (start with '/') and managed by indexMemoryBase().
    const currentPaths = new Set(nodes.map(n => n.id));
    for (const oldPath of previousPaths) {
      if (!oldPath.startsWith('/') && !currentPaths.has(oldPath)) {
        this.store.deleteNode(oldPath);
      }
    }

    // Index nodes (incremental)
    for (const node of nodes) {
      if (this.store.isSourceErased(node.id)) {
        this.store.deleteNode(node.id);
        stats.nodesSkipped++;
        continue;
      }
      const fileStat = await stat(join(vaultPath, node.id));
      const mtime = fileStat.mtimeMs;
      const prevMtime = this.store.getSyncMtime(node.id);

      if (prevMtime !== undefined && prevMtime >= mtime) {
        stats.nodesSkipped++;
        continue;
      }

      this.store.upsertNode(node);

      // Compute and store embedding
      const tags = Array.isArray(node.frontmatter.tags) ? node.frontmatter.tags : [];
      const aliases = Array.isArray(node.frontmatter.aliases) && (node.frontmatter.aliases as unknown[]).every(a => typeof a === 'string')
        ? node.frontmatter.aliases as string[]
        : undefined;
      const text = Embedder.buildEmbeddingText(node.title, tags as string[], node.content, aliases);
      const embedding = await this.embedder.embed(text);
      this.store.upsertEmbedding(node.id, embedding);

      // Re-index edges from this node
      this.store.deleteAllEdgesFrom(node.id);
      for (const edge of edges.filter(e => e.sourceId === node.id)) {
        if (this.store.isSourceErased(edge.sourceId) || this.store.isSourceErased(edge.targetId)) {
          continue;
        }
        this.store.insertEdge(edge);
        stats.edgesIndexed++;
      }

      this.store.upsertSync(node.id, mtime);
      stats.nodesIndexed++;
    }

    // Create stub nodes
    for (const stubId of stubIds) {
      if (this.store.isSourceErased(stubId)) continue;
      if (!this.store.getNode(stubId)) {
        this.store.upsertNode({
          id: stubId,
          title: stubId.replace('_stub/', '').replace('.md', ''),
          content: '',
          frontmatter: { _stub: true },
        });
        stats.stubNodesCreated++;
      }
    }

    // If any nodes were indexed, re-run community detection
    if (stats.nodesIndexed > 0 || stats.stubNodesCreated > 0) {
      const kg = KnowledgeGraph.fromStore(this.store);
      const communities = kg.detectCommunities(resolution);
      this.store.clearCommunities();
      for (const c of communities) {
        this.store.upsertCommunity(c);
      }
      stats.communitiesDetected = communities.length;
    }

    return stats;
  }

  async indexMemoryBase(basePath: string): Promise<MemoryIndexStats> {
    const stats: MemoryIndexStats = { memoriesIndexed: 0, memoriesSkipped: 0, memoriesDeleted: 0 };

    // Discover all memory files: <basePath>/*/memory/*.md
    let projectDirs: string[] = [];
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      projectDirs = entries.filter(e => e.isDirectory()).map(e => join(basePath, e.name));
    } catch {
      return stats;
    }

    const currentMemoryPaths = new Set<string>();

    for (const projectDir of projectDirs) {
      const memoryDir = join(projectDir, 'memory');
      let files: string[];
      try {
        const entries = await readdir(memoryDir, { withFileTypes: true });
        files = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(memoryDir, file);
        currentMemoryPaths.add(filePath);

        if (this.store.isSourceErased(filePath)) {
          this.store.deleteNode(filePath);
          stats.memoriesSkipped++;
          continue;
        }

        const fileStat = await stat(filePath);
        const mtime = fileStat.mtimeMs;
        const prevMtime = this.store.getSyncMtime(filePath);

        if (prevMtime !== undefined && prevMtime >= mtime) {
          stats.memoriesSkipped++;
          continue;
        }

        const raw = await readFile(filePath, 'utf-8');
        const { fm, content, warning, threw } = parseFrontmatterLoud(raw, filePath);
        if (warning) console.warn(`WARN: ${warning}`);
        if (threw) {
          // unparseable frontmatter — keep the historical skip (don't index),
          // but no longer silently: the warning above names the file
          stats.memoriesSkipped++;
          continue;
        }

        const title = typeof fm.name === 'string' ? fm.name : basename(file, '.md');
        const node = {
          id: filePath,
          title,
          content: content.trim(),
          frontmatter: fm as Record<string, unknown>,
          source: 'memory' as const,
        };

        this.store.upsertNode(node);
        const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];
        const aliases = Array.isArray(fm.aliases) && (fm.aliases as unknown[]).every(a => typeof a === 'string')
          ? fm.aliases as string[]
          : undefined;
        const embeddingText = Embedder.buildEmbeddingText(title, tags, node.content, aliases);
        const embedding = await this.embedder.embed(embeddingText);
        this.store.upsertEmbedding(filePath, embedding);
        this.store.upsertSync(filePath, mtime);
        stats.memoriesIndexed++;
      }
    }

    // Remove stale memory nodes (files under basePath that no longer exist)
    const allSyncPaths = this.store.getAllSyncPaths();
    for (const path of allSyncPaths) {
      if (path.startsWith(basePath) && !currentMemoryPaths.has(path)) {
        this.store.deleteNode(path);
        stats.memoriesDeleted++;
      }
    }

    return stats;
  }

  /**
   * Index project docs (PROJECT_SOUL/SPEC/ROADMAP/STATE/DECISIONS.md etc.)
   * as source='docs' nodes with ABSOLUTE path ids. Absolute ids guarantee the
   * vault index() reaper (which only deletes relative paths) never touches them.
   *
   * Only docRoots whose `host` field matches os.hostname() are processed.
   * Missing or unreadable root dirs are silently skipped.
   */
  async indexDocs(docRoots: DocRoot[]): Promise<DocsIndexStats> {
    const stats: DocsIndexStats = { docsIndexed: 0, docsSkipped: 0, docsDeleted: 0 };

    const currentDocPaths = new Set<string>();
    const currentHost = hostname();

    for (const docRoot of docRoots) {
      // Skip roots intended for a different machine
      if (docRoot.host !== currentHost) continue;

      // Skip missing/unreadable root dirs silently
      try {
        await access(docRoot.root);
      } catch {
        continue;
      }

      // Find files matching the globs. We support two patterns:
      //   - literal filenames (e.g. "DECISIONS.md")
      //   - a single trailing * wildcard (e.g. "*.md")
      // No external dep is added; package.json has no glob library.
      const matchingFiles = await findMatchingFiles(docRoot.root, docRoot.globs);

      for (const filePath of matchingFiles) {
        // HARD INVARIANT: id must be an absolute path so the vault reaper skips it
        const id = filePath; // already absolute from findMatchingFiles

        currentDocPaths.add(id);

        if (this.store.isSourceErased(id)) {
          this.store.deleteNode(id);
          stats.docsSkipped++;
          continue;
        }

        const fileStat = await stat(filePath);
        const mtime = fileStat.mtimeMs;
        const prevMtime = this.store.getSyncMtime(id);

        if (prevMtime !== undefined && prevMtime >= mtime) {
          stats.docsSkipped++;
          continue;
        }

        const raw = await readFile(filePath, 'utf-8');
        const { fm, content, warning, threw } = parseFrontmatterLoud(raw, filePath);
        if (warning) console.warn(`WARN: ${warning}`);
        if (threw) {
          stats.docsSkipped++;
          continue;
        }

        const title = typeof fm.title === 'string'
          ? fm.title
          : basename(filePath, '.md').replace(/_/g, ' ');

        // Stamp mtime-derived fields into frontmatter
        const mtimeIso = new Date(mtime).toISOString();
        const frontmatter: Record<string, unknown> = {
          ...fm,
          source_mtime: mtimeIso,
          since: fm.since ?? mtimeIso,
          project: docRoot.project,
        };

        const node = {
          id,
          title,
          content: content.trim(),
          frontmatter,
          source: 'docs' as const,
        };

        this.store.upsertNode(node);

        const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [];
        const aliases = Array.isArray(frontmatter.aliases) && (frontmatter.aliases as unknown[]).every(a => typeof a === 'string')
          ? frontmatter.aliases as string[]
          : undefined;
        const embeddingText = Embedder.buildEmbeddingText(title, tags, node.content, aliases);
        const embedding = await this.embedder.embed(embeddingText);
        this.store.upsertEmbedding(id, embedding);
        this.store.upsertSync(id, mtime);
        stats.docsIndexed++;
      }
    }

    // Reaper: delete previously-synced docs paths that no longer exist.
    // Scoped to source='docs' nodes only (identified by their absolute paths
    // under the configured doc roots), mirroring indexMemoryBase's scoped reaper.
    const allSyncPaths = this.store.getAllSyncPaths();
    const docRootPaths = docRoots
      .filter(r => r.host === currentHost)
      .map(r => r.root);

    for (const path of allSyncPaths) {
      if (!path.startsWith('/')) continue; // skip vault relative paths
      if (!docRootPaths.some(root => path.startsWith(root))) continue; // not under any doc root
      if (currentDocPaths.has(path)) continue; // still exists
      // Check it's actually a docs node (not a memory node that happens to be under this path)
      const nodeRow = this.store.db.prepare(
        "SELECT source FROM nodes WHERE id = ?"
      ).get(path) as { source: string } | undefined;
      if (nodeRow?.source !== 'docs') continue;
      this.store.deleteNode(path);
      stats.docsDeleted++;
    }

    return stats;
  }

  /**
   * Index graphify graph.json files as source='code' nodes at file-level granularity.
   *
   * Design:
   * - One KG node per distinct source_file in the graph.json (rolls up symbol-level nodes).
   * - Node id = ABSOLUTE path (<repoRoot>/<source_file>). Absolute ids guarantee the
   *   vault index() reaper (which only deletes relative paths) never reaps them.
   * - NO embeddings: code nodes are FTS-indexed only (nodes_fts) and never enter nodes_vec.
   *   This keeps searchMemory / searchVectorBySource cost unchanged.
   * - Edges = rolled-up file→file cross-file only; intra-file self-edges are dropped.
   *   Duplicate file-pair+relation combos are deduplicated (keep max confidence_score).
   * - Only graphRoots whose `host` matches os.hostname() are processed.
   * - Missing graph.json files are silently skipped.
   * - Mtime-based skip: re-imports only if graph.json has changed.
   * - Reaper: deletes code nodes under the repoRoot that are no longer present in graph.json.
   */
  async indexGraphifyGraph(graphRoots: GraphRoot[]): Promise<CodeIndexStats> {
    const stats: CodeIndexStats = { filesIndexed: 0, filesSkipped: 0, filesDeleted: 0, edgesIndexed: 0 };
    const currentHost = hostname();

    for (const graphRoot of graphRoots) {
      // Skip roots intended for a different machine
      if (graphRoot.host !== currentHost) continue;

      // Skip missing graph.json silently
      try {
        await access(graphRoot.graphJsonPath);
      } catch {
        continue;
      }

      // Mtime-skip: re-import only if graph.json has changed
      const fileStat = await stat(graphRoot.graphJsonPath);
      const graphMtime = fileStat.mtimeMs;
      const prevMtime = this.store.getSyncMtime(graphRoot.graphJsonPath);

      // Track current file-level node ids for this root (for reaper)
      const currentCodePaths = new Set<string>();

      if (prevMtime !== undefined && prevMtime >= graphMtime) {
        // Still collect current paths so the reaper works correctly even on skip
        try {
          const raw = await readFile(graphRoot.graphJsonPath, 'utf-8');
          const graph = JSON.parse(raw) as GraphifyGraph;
          const sourceFiles = new Set(
            (graph.nodes ?? []).map(n => n.source_file).filter((sf): sf is string => typeof sf === 'string')
          );
          for (const sf of sourceFiles) {
            const absPath = join(graphRoot.repoRoot, sf);
            if (this.store.isSourceErased(absPath)) {
              this.store.deleteNode(absPath);
              continue;
            }
            currentCodePaths.add(absPath);
          }
        } catch {
          // Unreadable / malformed — skip
        }
        // Count skipped files
        stats.filesSkipped += currentCodePaths.size;
        // Still run reaper below
      } else {
        // Parse graph.json
        let graph: GraphifyGraph;
        try {
          const raw = await readFile(graphRoot.graphJsonPath, 'utf-8');
          graph = JSON.parse(raw) as GraphifyGraph;
        } catch (err) {
          console.warn(`kg-code: could not parse ${graphRoot.graphJsonPath}: ${(err as Error)?.message}`);
          continue;
        }

        const graphNodes = graph.nodes ?? [];
        const graphLinks = graph.links ?? [];

        // Build nodeId → source_file map
        const nodeToSourceFile = new Map<string, string>();
        for (const n of graphNodes) {
          if (typeof n.id === 'string' && typeof n.source_file === 'string') {
            nodeToSourceFile.set(n.id, n.source_file);
          }
        }

        // Group symbols by source_file
        type SymbolEntry = { label: string; norm_label: string; community: number | undefined; file_type: string | undefined };
        const fileSymbols = new Map<string, SymbolEntry[]>();
        for (const n of graphNodes) {
          if (typeof n.source_file !== 'string') continue;
          const absPath = join(graphRoot.repoRoot, n.source_file);
          if (!fileSymbols.has(absPath)) fileSymbols.set(absPath, []);
          fileSymbols.get(absPath)!.push({
            label: typeof n.label === 'string' ? n.label : '',
            norm_label: typeof n.norm_label === 'string' ? n.norm_label : '',
            community: typeof n.community === 'number' ? n.community : undefined,
            file_type: typeof n.file_type === 'string' ? n.file_type : undefined,
          });
        }

        // Determine since: use built_at_commit as a timestamp marker if available, else graph.json mtime
        const since = typeof graph.built_at_commit === 'string' && graph.built_at_commit.length > 0
          ? `commit:${graph.built_at_commit}`
          : new Date(graphMtime).toISOString();
        const sourceMtime = new Date(graphMtime).toISOString();

        // Upsert one file-level node per distinct source_file
        for (const [absPath, symbols] of fileSymbols) {
          if (this.store.isSourceErased(absPath)) {
            this.store.deleteNode(absPath);
            stats.filesSkipped++;
            continue;
          }
          currentCodePaths.add(absPath);

          // Modal community: most frequent among symbols that have one
          const commCounts = new Map<number, number>();
          for (const s of symbols) {
            if (s.community !== undefined) {
              commCounts.set(s.community, (commCounts.get(s.community) ?? 0) + 1);
            }
          }
          let modalCommunity: number | undefined;
          let maxCount = 0;
          for (const [comm, cnt] of commCounts) {
            if (cnt > maxCount) { maxCount = cnt; modalCommunity = comm; }
          }

          // Modal file_type
          const ftCounts = new Map<string, number>();
          for (const s of symbols) {
            if (s.file_type) ftCounts.set(s.file_type, (ftCounts.get(s.file_type) ?? 0) + 1);
          }
          let modalFileType: string | undefined;
          let maxFtCount = 0;
          for (const [ft, cnt] of ftCounts) {
            if (cnt > maxFtCount) { maxFtCount = cnt; modalFileType = ft; }
          }

          // FTS content: file path + all symbol labels + norm_labels (space-joined for discoverability)
          const symbolTerms = symbols.flatMap(s => [s.label, s.norm_label].filter(t => t.length > 0));
          const content = [absPath, ...new Set(symbolTerms)].join(' ');

          const frontmatter: Record<string, unknown> = {
            project: graphRoot.project,
            source_mtime: sourceMtime,
            since,
            symbol_count: symbols.length,
            ...(modalCommunity !== undefined ? { community: modalCommunity } : {}),
            ...(modalFileType !== undefined ? { file_type: modalFileType } : {}),
          };

          // HARD INVARIANT: id is absolute path — vault reaper skips it
          this.store.upsertNode({
            id: absPath,
            title: basename(absPath),
            content,
            frontmatter,
            source: 'code',
          });
          // HARD INVARIANT: NO upsertEmbedding — code nodes must not enter nodes_vec

          this.store.upsertSync(absPath, graphMtime);
          stats.filesIndexed++;
        }

        // Build rolled-up file→file edges (dedup: keep max confidence_score per file-pair+relation)
        type EdgeKey = string; // `${sourceFile}|${targetFile}|${relation}`
        const edgeMap = new Map<EdgeKey, { sourceFile: string; targetFile: string; relation: string; maxConfidence: number }>();

        for (const lnk of graphLinks) {
          const srcFile = nodeToSourceFile.get(lnk.source);
          const tgtFile = nodeToSourceFile.get(lnk.target);
          if (!srcFile || !tgtFile) continue;
          // Drop intra-file self-edges
          if (srcFile === tgtFile) continue;

          const srcAbs = join(graphRoot.repoRoot, srcFile);
          const tgtAbs = join(graphRoot.repoRoot, tgtFile);
          if (this.store.isSourceErased(srcAbs) || this.store.isSourceErased(tgtAbs)) continue;
          const relation = typeof lnk.relation === 'string' ? lnk.relation : 'relates_to';
          const confidence = typeof lnk.confidence_score === 'number' ? lnk.confidence_score : 1.0;

          const key: EdgeKey = `${srcAbs}|${tgtAbs}|${relation}`;
          const existing = edgeMap.get(key);
          if (!existing || confidence > existing.maxConfidence) {
            edgeMap.set(key, { sourceFile: srcAbs, targetFile: tgtAbs, relation, maxConfidence: confidence });
          }
        }

        // Delete old code edges from this root's nodes before reinserting
        for (const absPath of currentCodePaths) {
          this.store.deleteAllEdgesFrom(absPath);
        }

        // Insert deduplicated edges
        for (const { sourceFile, targetFile, relation, maxConfidence } of edgeMap.values()) {
          this.store.insertEdge({
            sourceId: sourceFile,
            targetId: targetFile,
            context: '',
            relationType: relation,
            confidence: maxConfidence,
          });
          stats.edgesIndexed++;
        }

        // Update mtime for the graph.json sentinel
        this.store.upsertSync(graphRoot.graphJsonPath, graphMtime);
      }

      // Reaper: delete previously-synced code nodes under this repoRoot that are no longer in graph.json
      const allSyncPaths = this.store.getAllSyncPaths();
      for (const path of allSyncPaths) {
        if (!path.startsWith('/')) continue; // skip vault relative paths
        if (!path.startsWith(graphRoot.repoRoot)) continue; // not under this repo root
        if (currentCodePaths.has(path)) continue; // still exists
        // Only reap source='code' nodes — never touch vault/memory/docs nodes
        const nodeRow = this.store.db.prepare(
          'SELECT source FROM nodes WHERE id = ?'
        ).get(path) as { source: string } | undefined;
        if (nodeRow?.source !== 'code') continue;
        this.store.deleteNode(path);
        stats.filesDeleted++;
      }
    }

    return stats;
  }

  /**
   * Cross-layer linker: connect doc/memory nodes to the code-file nodes they
   * mention, so kg_paths can traverse spec→code (doc_describes_code) and
   * decision→code (memory_references_code). It also records doc references to
   * missing code as doc_unresolved_code_reference edges for drift queries.
   * Same-project scoped. EDGES ONLY — never touches nodes/embeddings/FTS, so it
   * adds zero injection-path cost. Idempotent: owns its relation types and
   * clears them before re-linking.
   */
  async linkCrossLayer(): Promise<CrossLayerStats> {
    const stats: CrossLayerStats = { docEdges: 0, memoryEdges: 0, docDriftEdges: 0, skipped: 0 };
    const db = this.store.db;

    // Idempotency: the linker EXCLUSIVELY owns these relation types (graphify
    // uses 'references' for code→code, so we never reuse that bare name).
    db.prepare(
      "DELETE FROM records_edges WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id() AND relation_type IN ('doc_describes_code','memory_references_code','doc_unresolved_code_reference')"
    ).run();

    // Generic basenames collide across files — only link these on a PATH match.
    const GENERIC = new Set([
      'index.ts', 'index.js', 'index.mjs', 'main.py', '__init__.py', '__main__.py',
      'types.ts', 'utils.ts', 'config.ts', 'config.py', 'app.py', 'cli.py',
    ]);

    // Per-project code lookup: basename + path tails (last 2–3 segments).
    type CodeRef = { id: string; basename: string; tails: string[] };
    const codeByProject = new Map<string, CodeRef[]>();
    const codeRows = db.prepare(
      "SELECT id, frontmatter FROM nodes WHERE source='code'"
    ).all() as Array<{ id: string; frontmatter: string }>;
    for (const row of codeRows) {
      let project = '';
      try { project = String(JSON.parse(row.frontmatter || '{}').project ?? ''); } catch { /* skip */ }
      if (!project) continue;
      const segs = row.id.split('/').filter(Boolean);
      const base = segs[segs.length - 1] ?? '';
      const tails: string[] = [];
      for (const n of [2, 3]) if (segs.length >= n) tails.push(segs.slice(-n).join('/'));
      if (!codeByProject.has(project)) codeByProject.set(project, []);
      codeByProject.get(project)!.push({ id: row.id, basename: base, tails });
    }
    if (codeByProject.size === 0) return stats;
    const allProjects = [...codeByProject.keys()];

    // Link one scanning node against its project's code; returns edges made.
    const linkNode = (text: string, project: string, sourceId: string, relation: string): number => {
      const codes = codeByProject.get(project);
      if (!codes) return 0;
      let made = 0;
      for (const c of codes) {
        if (c.id === sourceId) continue;
        let conf = 0; let kind = '';
        if (c.tails.some(t => t.length >= 5 && text.includes(t))) { conf = 1.0; kind = 'path'; }
        else if (c.basename.length >= 4 && !GENERIC.has(c.basename)) {
          const re = new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegExp(c.basename)}([^A-Za-z0-9_]|$)`);
          if (re.test(text)) { conf = 0.6; kind = 'basename'; }
        }
        if (conf === 0) continue;
        this.store.insertEdge({
          sourceId, targetId: c.id, context: 'cross-layer mention',
          relationType: relation, confidence: conf, metadata: { match: kind },
        });
        made++;
      }
      return made;
    };

    const resolvesCodeReference = (ref: string, project: string): boolean => {
      const codes = codeByProject.get(project);
      if (!codes) return false;
      return codes.some(c => c.basename === ref || c.tails.some(t => t === ref || t.endsWith(`/${ref}`)));
    };

    const linkUnresolvedDocReferences = (text: string, project: string, sourceId: string): number => {
      const refs = extractCodeReferences(text).filter(ref => !resolvesCodeReference(ref, project));
      let made = 0;
      for (const ref of refs) {
        this.store.insertEdge({
          sourceId,
          targetId: `missing-code:${project}:${ref}`,
          context: 'unresolved code reference',
          relationType: 'doc_unresolved_code_reference',
          confidence: 0.4,
          metadata: { ref, reason: 'no matching code node' },
        });
        made++;
      }
      return made;
    };

    // Docs → code
    const docRows = db.prepare(
      "SELECT id, title, content, frontmatter FROM nodes WHERE source='docs'"
    ).all() as Array<{ id: string; title: string; content: string; frontmatter: string }>;
    for (const d of docRows) {
      let project = '';
      try { project = String(JSON.parse(d.frontmatter || '{}').project ?? ''); } catch { /* */ }
      if (!project || !codeByProject.has(project)) { stats.skipped++; continue; }
      const text = `${d.title}\n${d.content}`;
      stats.docEdges += linkNode(text, project, d.id, 'doc_describes_code');
      stats.docDriftEdges += linkUnresolvedDocReferences(text, project, d.id);
    }

    // Memory → code: derive project from the memory id (the encoded path embeds
    // the project name). Skip if no project or ambiguous (≠ exactly one match).
    const memRows = db.prepare(
      "SELECT id, title, content FROM nodes WHERE source='vault' AND id LIKE 'Memory/%'"
    ).all() as Array<{ id: string; title: string; content: string }>;
    for (const m of memRows) {
      const matched = allProjects.filter(p => m.id.includes(p));
      if (matched.length !== 1) { stats.skipped++; continue; }
      stats.memoryEdges += linkNode(`${m.title}\n${m.content}`, matched[0], m.id, 'memory_references_code');
    }

    return stats;
  }

  /**
   * Derive Engram episodes and assertions from vault nodes.
   * Runs after all indexing is complete. Only operates when ENGRAM_ENABLE_* flags are set.
   */
  async deriveEngram(): Promise<EngramDeriveStats> {
    const stats: EngramDeriveStats = {
      episodes: 0, assertions: 0, candidates: 0, selfAdmitted: 0, rejected: 0, skipped: 0,
      relationsSkipped: 0, assertionsSeen: 0,
    };
    const enabled = process.env.ENGRAM_ENABLE_EPISODES === '1'
      || process.env.ENGRAM_ENABLE_ASSERTIONS === '1'
      || process.env.ENGRAM_ENABLE_RECALL === '1';
    if (!enabled) return stats;

    const db = this.store.db;

    // Verify Engram tables exist
    const hasTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE name='engram_episodes'"
    ).get();
    if (!hasTables) return stats;

    // Pull imports inside the method to keep pipeline.ts imports clean
    const { insertEpisode, episodeId } = await import('./engram/episodes.js');
    const { insertAssertion } = await import('./engram/assertions.js');
    const { computeMemorySourceDigest } = await import('./engram/admission.js');
    const { deriveAssertionValidFrom } = await import('./engram/temporal.js');

    // Derive episodes from vault nodes with these folder prefixes
    const episodeFolders = ['Sessions/', 'Memory/', 'Decisions/', 'Conversations/'];

    for (const prefix of episodeFolders) {
      const nodes = db.prepare(`
        SELECT id, title, frontmatter, content FROM nodes
        WHERE id LIKE ? AND source = 'vault'
      `).all(`${prefix}%`) as Array<{ id: string; title: string; frontmatter: string; content: string }>;

      for (const node of nodes) {
        // Skip stubs
        if (node.id.startsWith('_stub/')) continue;

        const fm = tryParseJson(node.frontmatter);
        const episodeType = prefix.replace('/', '').replace(/s$/, '').toLowerCase(); // sessions→session, memory→memory

        try {
          const sourceTemporal = deriveAssertionValidFrom({ sourceFrontmatter: fm });
          const observedAt = sourceTemporal.valid_from ?? new Date().toISOString();
          insertEpisode(db, {
            source_node_id: node.id,
            episode_type: episodeType,
            title: node.title || String(fm?.title ?? '') || node.id.split('/').pop()?.replace('.md', '') || '',
            observed_at: observedAt,
            source_hash: simpleHash(node.content || ''),
            provenance: JSON.stringify({
              source: 'vault',
              folder: prefix,
              tags: fm?.tags,
              temporal: sourceTemporal.classification === 'derived'
                ? {
                    kind: 'source_field',
                    field: sourceTemporal.provenance[0].field,
                    raw: sourceTemporal.provenance[0].raw,
                  }
                : {
                    kind: 'index_observed_at',
                    reason_code: sourceTemporal.reason_code,
                  },
            }),
          });
          stats.episodes++;
        } catch {
          stats.skipped++;
        }
      }
    }

    // Derive assertions from structured frontmatter fields
    // Look for nodes with relation-type frontmatter or explicit structured fields
    const structuredNodes = db.prepare(`
      SELECT id, title, frontmatter, content FROM nodes
      WHERE source = 'vault'
        AND id NOT LIKE '_stub/%'
        AND (frontmatter LIKE '%"relations"%'
          OR frontmatter LIKE '%"prefers"%'
          OR frontmatter LIKE '%"uses"%'
          OR frontmatter LIKE '%"depends_on"%'
          OR frontmatter LIKE '%"engram_candidate"%'
          OR frontmatter LIKE '%"assertions"%')
    `).all() as Array<{ id: string; title: string; frontmatter: string; content: string }>;

    for (const node of structuredNodes) {
      const fm = tryParseJson(node.frontmatter);
      if (!fm) { stats.skipped++; continue; }
      const sourceHash = simpleHash(`${node.frontmatter}\n${node.content ?? ''}`);

      const durableCandidate = parseDurableCandidate(fm.engram_candidate);
      if (durableCandidate) {
        if (!this.memoryAdmission) {
          stats.skipped++;
        } else {
          try {
            const result = db.transaction(() => {
              const submitted = this.memoryAdmission!.submit(db, {
                origin: 'model_derived',
                subject: durableCandidate.subject,
                predicate: durableCandidate.predicate,
                object: durableCandidate.object,
                confidence: durableCandidate.confidence,
                sourceNodeId: durableCandidate.sourceNodeId ?? node.id,
                sourceHash: durableCandidate.sourceHash,
              });
              if (submitted.status === 'quarantined'
                && submitted.candidate.id !== durableCandidate.candidateId) {
                throw new Error('Durable candidate receipt does not match admission result');
              }
              return submitted;
            })();
            if (result.status === 'quarantined') stats.candidates++;
            else stats.rejected++;
          } catch {
            stats.skipped++;
          }
        }
      }

      const deriveAssertion = (assertion: {
        subject: string; predicate: string; object: string; confidence: number; status: string;
        explicitValidFrom?: unknown[]; sourceBinding?: string;
      }): void => {
        if (this.memoryAdmission) {
          const result = this.memoryAdmission.submit(db, {
            origin: 'imported',
            subject: assertion.subject,
            predicate: assertion.predicate,
            object: assertion.object,
            confidence: assertion.confidence,
            sourceNodeId: node.id,
            sourceHash: assertion.sourceBinding ?? sourceHash,
          });
          if (result.status === 'quarantined') stats.candidates++;
          else stats.rejected++;
          return;
        }
        if (!this.allowLegacyImmediateAssertionsForTests) {
          stats.skipped++;
          return;
        }
        const episode = db.prepare(`
          SELECT id, observed_at, provenance FROM engram_episodes WHERE id = ?
        `).get(episodeId(node.id)) as { id: string; observed_at: string; provenance: string } | undefined;
        const temporal = deriveAssertionValidFrom({
          explicitValidFrom: assertion.explicitValidFrom,
          episode: episode ? { observedAt: episode.observed_at, provenance: episode.provenance } : null,
          sourceFrontmatter: fm,
        });
        if (temporal.classification !== 'derived' || !temporal.valid_from) {
          stats.skipped++;
          return;
        }
        const { explicitValidFrom: _explicitValidFrom, sourceBinding: _sourceBinding, ...assertionFields } = assertion;
        insertAssertion(db, {
          ...assertionFields,
          status: assertion.status as Parameters<typeof insertAssertion>[1]['status'],
          source_node_id: node.id,
          episode_id: episode?.id ?? null,
          valid_from: temporal.valid_from,
        });
        stats.assertions++;
      };

      // fm.relations is graph topology, not a memory claim: it is already materialized
      // as edges via the separate parseVault path (see index() around line 110). It must
      // NOT be submitted to the memory admission queue, which exists for memory claims
      // per ENGRAM.md:369. Count entries seen but do not call deriveAssertion on them.
      const relations = Array.isArray(fm.relations) ? fm.relations : [];
      for (const rel of relations) {
        if (rel?.type && rel?.target) {
          stats.relationsSkipped++;
        }
      }

      // Extract explicit assertion blocks
      const assertions = Array.isArray(fm.assertions) ? fm.assertions : [];
      for (const a of assertions) {
        if (a?.subject && a?.predicate && a?.object) {
          stats.assertionsSeen++;
          try {
            deriveAssertion({
              subject: String(a.subject),
              predicate: String(a.predicate),
              object: String(a.object),
              confidence: typeof a.confidence === 'number' ? a.confidence : 1.0,
              status: a.status || 'current',
              explicitValidFrom: a.valid_from === undefined ? [] : [a.valid_from],
              ...(fm.reviewed_evidence ? { sourceBinding: `extracted-v1:${computeMemorySourceDigest(db, node.id)}` } : {}),
            });
          } catch { stats.skipped++; }
        }
      }
      // New extracted claims carry full source bindings. Keep the legacy source
      // hash for existing authored assertions so this does not requeue them all.
      const metadata = fm.metadata as Record<string, unknown> | undefined;
      const extracted = Array.isArray(metadata?.assertions) ? metadata.assertions : [];
      for (const a of extracted) {
        stats.assertionsSeen++;
        if (!this.memoryAdmission) { stats.skipped++; continue; }
        try {
          const result = this.memoryAdmission.submit(db, {
            origin: 'model_derived', subject: a.subject, predicate: a.predicate, object: a.object,
            sourceNodeId: node.id, sourceHash: `extracted-v1:${computeMemorySourceDigest(db, node.id)}`,
          });
          if (result.status === 'quarantined') {
            stats.candidates++;
            // Extracted claims self-admit in place against this memory file (2026-10-04).
            if (this.memoryAdmission.selfAdmission
                && this.memoryAdmission.selfAdmit(db, result.candidate.id).status === 'admitted') stats.selfAdmitted++;
          } else stats.rejected++;
        } catch { stats.skipped++; }
      }
    }

    return stats;
  }
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text); } catch { return null; }
}

interface DurableCandidateBlock {
  candidateId: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceNodeId?: string;
  sourceHash: string;
}

function parseDurableCandidate(value: unknown): DurableCandidateBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1
    || row.origin !== 'model_derived'
    || row.trust_state !== 'quarantined'
    || row.recallable !== false
    || row.authority !== 'none'
    || typeof row.candidate_id !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.candidate_id)
    || typeof row.subject !== 'string'
    || typeof row.predicate !== 'string'
    || typeof row.object !== 'string'
    || typeof row.confidence !== 'number'
    || row.confidence < 0
    || row.confidence > 1
    || typeof row.source_hash !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.source_hash)
    || (row.source_node_id !== null && typeof row.source_node_id !== 'string')) {
    return null;
  }
  return {
    candidateId: row.candidate_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence,
    ...(typeof row.source_node_id === 'string' && row.source_node_id.trim()
      ? { sourceNodeId: row.source_node_id }
      : {}),
    sourceHash: row.source_hash,
  };
}

function simpleHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < Math.min(text.length, 1000); i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash).toString(36);
}

export interface EngramDeriveStats {
  episodes: number;
  assertions: number;
  candidates: number;
  /** Extracted candidates admitted in place this run. */
  selfAdmitted: number;
  rejected: number;
  skipped: number;
  /** fm.relations entries seen and deliberately excluded from admission (topology, already edges). */
  relationsSkipped: number;
  /** Well-formed fm.assertions entries encountered (submitted to admission, or the legacy immediate path). */
  assertionsSeen: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCodeReferences(text: string): string[] {
  const codeExt = String.raw`(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|php|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|zsh|fish)`;
  const pathRe = new RegExp(String.raw`\b(?:[A-Za-z0-9_.@-]+/)+[A-Za-z0-9_.@-]+\.${codeExt}\b`, 'g');
  const refs = new Set<string>();

  for (const match of text.matchAll(pathRe)) {
    refs.add(match[0]);
  }

  return [...refs];
}

// Internal type for graphify graph.json shape
interface GraphifyNode {
  id?: string;
  label?: string;
  norm_label?: string;
  source_file?: string;
  file_type?: string;
  community?: number;
}

interface GraphifyLink {
  source: string;
  target: string;
  relation?: string;
  confidence_score?: number;
}

interface GraphifyGraph {
  nodes?: GraphifyNode[];
  links?: GraphifyLink[];
  built_at_commit?: string;
}

/**
 * Find all files under rootDir matching any of the given globs.
 * Supports literal filenames and patterns with a single trailing * wildcard.
 * Returns absolute paths.
 */
async function findMatchingFiles(rootDir: string, globs: string[]): Promise<string[]> {
  const results: string[] = [];

  // Build matchers for each glob
  const matchers = globs.map(glob => {
    if (!glob.includes('*')) {
      // Literal filename match
      return (name: string) => name === glob;
    }
    // Simple wildcard: only support patterns like "*.md" or "PROJECT_*.md"
    // Split on * and match prefix/suffix
    const parts = glob.split('*');
    const prefix = parts[0];
    const suffix = parts[parts.length - 1];
    return (name: string) => name.startsWith(prefix) && name.endsWith(suffix);
  });

  const matches = (name: string): boolean => matchers.some(m => m(name));

  // Scan rootDir non-recursively (doc roots are project dirs, not trees)
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isFile() && matches(entry.name)) {
      results.push(join(rootDir, entry.name));
    }
  }

  return results;
}
