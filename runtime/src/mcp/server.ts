import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { accessContextFromEnv } from '../lib/access-context.js';
import { Embedder } from '../lib/embedder.js';
import { EMBEDDING_MODEL, EMBEDDING_MODEL_REVISION } from '../lib/model-cache.js';
import { IndexPipeline } from '../lib/index-pipeline.js';
import { KnowledgeGraph } from '../lib/graph.js';
import { Search } from '../lib/search.js';
import { resolveNodeName } from '../lib/resolve.js';
import { VaultWriter } from '../lib/writer.js';
import { searchMemoryHybrid, type MemorySearchOpts } from '../lib/memory-search.js';
import { passageVectorsFor } from '../lib/passage-rescore.js';
import type { SearchResult } from '../lib/types.js';
import { mkdirSync } from 'fs';
import { join, posix } from 'node:path';
import { engramRecall, engramExplain } from '../lib/engram/recall.js';
import {
  engramForget,
  engramImprove,
  engramProfile,
} from '../lib/engram/verbs.js';
import {
  getMemorySourceAdmission,
  isPromotedMemorySource,
  type MemoryAdmissionService,
} from '../lib/engram/admission.js';
import {
  detectContradictions,
  resolveContradiction,
  getOpenContradictions,
} from '../lib/engram/assertions.js';
import { engramStatus } from '../lib/engram/status.js';
import { registerBootstrapTools } from './bootstrap-tools.js';
import { LOCAL_MEMORY_ADMISSION } from './local-admission.js';
import { GX460_CORPUS, recallGx460Evidence } from '../lib/gx460-recall.js';
import { corpusRegistryPath, listCorpora, recallRegisteredCorpus, recallX1cEvidence } from '../lib/corpus-registry.js';
import {
  corpusRoutingFlag,
  createCorpusRoutingRuntime,
  defaultCorpusRoutingPaths,
} from '../lib/corpus-routing-runtime.js';
import { registerCorpusRoutingTool } from './corpus-routing-tool.js';
import { registerHistorySearchTool } from './history-search-tool.js';

const accessContext = accessContextFromEnv();
const config = resolveConfig({});

mkdirSync(config.dataDir, { recursive: true });

const store = new Store(config.dbPath, accessContext);
const embedder = new Embedder();
const search = new Search(store, embedder);
const writer = new VaultWriter(config.vaultPath, store);
let embedderReady = false;
let embedderInit: Promise<void> | undefined;

const corpusRoutingPaths = defaultCorpusRoutingPaths();
const corpusRoutingRuntime = createCorpusRoutingRuntime({
  registryPath: corpusRegistryPath(),
  ...corpusRoutingPaths,
  provider: {
    model: EMBEDDING_MODEL,
    revision: EMBEDDING_MODEL_REVISION,
    dimension: 384,
    embed: async text => {
      await ensureEmbedder();
      return embedder.embed(text);
    },
  },
  autoRoutingEnabled: corpusRoutingFlag('CORPUS_ROUTING_AUTOMATIC', true),
  forceLexical: corpusRoutingFlag('CORPUS_ROUTING_FORCE_LEXICAL', false),
});

// One model load per process, shared by every MCP session and the REST
// /memory/search route. Concurrent first calls await the same init promise.
async function ensureEmbedder(): Promise<void> {
  if (embedderReady) return;
  embedderInit ??= embedder.init().then(() => { embedderReady = true; });
  try {
    await embedderInit;
  } catch (err) {
    embedderInit = undefined;
    throw err;
  }
}

/**
 * Memory search over the process-wide store + embedder with the local
 * (legacy) admission mode. Used by the HTTP entry point's GET /memory/search
 * route so the recall hook reuses the resident model instead of spawning a
 * CLI process per prompt.
 */
/**
 * Fill the passage cache for every memory note in the background, so the
 * first queries after a restart do not pay for passage embedding inside the
 * recall hook's HTTP budget. Called by the HTTP entry point only; stdio
 * servers fill the cache lazily. Returns the number of notes cached.
 */
export async function warmPassageCache(): Promise<number> {
  await ensureEmbedder();
  const rows = store.db.prepare(
    `SELECT id, title, content FROM nodes WHERE source = 'vault' AND id LIKE 'Memory/%'`,
  ).all() as Array<{ id: string; title: string | null; content: string | null }>;
  const passages = passageVectorsFor(embedder);
  for (const r of rows) {
    await passages.ensure([{ id: r.id, title: r.title ?? '', content: r.content ?? '' }]);
    await new Promise(resolve => setImmediate(resolve)); // let queries interleave
  }
  return rows.length;
}

export async function searchLocalMemory(
  query: string,
  opts: Omit<MemorySearchOpts, 'admission'> = {},
): Promise<SearchResult[]> {
  await ensureEmbedder();
  return searchMemoryHybrid(store, embedder, query, { ...opts, admission: LOCAL_MEMORY_ADMISSION });
}

function groupByRelationType<T extends { relationType: string }>(items: T[]): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const rt = item.relationType;
    (groups[rt] ??= []).push(item);
  }
  return groups;
}

function sessionExcerpt(content: string, maxLen = 160): string {
  const para = (content ?? '')
    .split(/\n\n+/)
    .find(p => p.trim().length > 0 && !p.startsWith('#') && !p.startsWith('---'));
  const t = (para ?? '').trim();
  return t.length > maxLen ? t.slice(0, maxLen) + '...' : t;
}

// Provenance filter for memory/search results. Matches runtime/persona/model against
// frontmatter (top-level or nested under `metadata`). Empty filter = pass-through.
function matchesProvenance(
  fm: Record<string, unknown> | undefined,
  filt: { runtime?: string; persona?: string; model?: string },
): boolean {
  const want = Object.entries(filt).filter(([, v]) => !!v);
  if (want.length === 0) return true;
  const meta = (fm?.metadata && typeof fm.metadata === 'object' ? fm.metadata : {}) as Record<string, unknown>;
  const get = (k: string) => String(meta[k] ?? fm?.[k] ?? '').toLowerCase();
  return want.every(([k, v]) => get(k) === String(v).toLowerCase());
}

export interface KgServerOptions {
  readOnly?: boolean;
  memoryAdmission?: MemoryAdmissionService;
}

export function createKgServer(options: KgServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'knowledge-graph',
    version: '0.1.0',
  });
  registerHistorySearchTool(
    server,
    process.env.ENGRAM_HISTORY_DB_PATH ?? join(config.dataDir, 'history.db'),
  );
  const isMemoryNode = (nodeId: string): boolean => {
    const row = store.db.prepare('SELECT source FROM nodes WHERE id = ?').get(nodeId) as {
      source: string;
    } | undefined;
    const normalizedId = nodeId.toLowerCase();
    return ['memory/', 'sessions/', 'decisions/', 'conversations/']
      .some(prefix => normalizedId.startsWith(prefix))
      || row?.source.toLowerCase() === 'memory';
  };
  const isReservedMemoryPath = (value: string | undefined): boolean => {
    const normalized = posix.normalize(`/${(value ?? '').replaceAll('\\', '/')}`).slice(1);
    const first = normalized.split('/')[0]?.toLowerCase();
    return ['memory', 'sessions', 'decisions', 'conversations'].includes(first);
  };
  const canExposeNode = (nodeId: string): boolean =>
    !isMemoryNode(nodeId) || isPromotedMemorySource(store.db, nodeId);
  const isGenericGraphNode = (nodeId: string): boolean => !isMemoryNode(nodeId);
  const requireSafeMatch = (name: string): string => {
    const matches = resolveNodeName(name, store).filter(match => canExposeNode(match.nodeId));
    if (matches.length === 0) throw new Error('Node not found');
    if (matches.length > 1 && matches[0].matchType !== 'exact' && matches[0].matchType !== 'id') {
      const candidates = matches.map(match => `"${match.title}" (${match.nodeId})`).join(', ');
      throw new Error(`Ambiguous name. Candidates: ${candidates}. Use the full node ID to disambiguate.`);
    }
    return matches[0].nodeId;
  };
  const memoryBoundary = (nodeId: string): Record<string, unknown> => {
    if (!isMemoryNode(nodeId)) return {};
    const admission = getMemorySourceAdmission(store.db, nodeId)!;
    return {
      memoryAdmission: {
        origin: admission.origin,
        trust_state: admission.trust_state,
        sensitivity: admission.sensitivity,
        authority: admission.authority,
      },
    };
  };
  const safeGraph = (): KnowledgeGraph => KnowledgeGraph.fromStore(store, isGenericGraphNode);
  const admittedContradictions = () => getOpenContradictions(store.db).filter(c => {
    const sources = store.db.prepare(`
      SELECT a.source_node_id AS source_a, b.source_node_id AS source_b
      FROM engram_assertions a JOIN engram_assertions b
        ON a.id = ? AND b.id = ?
    `).get(c.assertion_a_id, c.assertion_b_id) as {
      source_a: string; source_b: string;
    } | undefined;
    return !!sources
      && isPromotedMemorySource(store.db, sources.source_a)
      && isPromotedMemorySource(store.db, sources.source_b);
  });

if (!options.readOnly) server.tool(
  'kg_index',
  'Parse vault and build/update the knowledge graph. Also indexes Claude Code memory files if KG_MEMORY_BASE is set, project docs (PROJECT_SOUL/SPEC/ROADMAP/STATE/DECISIONS.md etc.) if KG_DOCS_CONFIG or <dataDir>/kg-docs.json is present, and graphify code graphs (file-level, FTS-only, no embeddings) if KG_GRAPHS_CONFIG or <dataDir>/kg-graphs.json is present.',
  { resolution: z.number().optional().describe('Louvain resolution parameter (default 1.0)') },
  async ({ resolution }) => {
    await ensureEmbedder();
    const pipeline = new IndexPipeline(store, embedder, options.memoryAdmission);
    const vaultStats = await pipeline.index(config.vaultPath, resolution ?? 1.0);
    const result: Record<string, unknown> = { vault: vaultStats };
    if (config.memoryBasePath) {
      result.memory = await pipeline.indexMemoryBase(config.memoryBasePath);
    }
    if (config.docRoots?.length) {
      result.docs = await pipeline.indexDocs(config.docRoots);
    }
    if (config.graphRoots?.length) {
      result.code = await pipeline.indexGraphifyGraph(config.graphRoots);
    }
    // Cross-layer linker runs last — connects docs/memory → code (no-op if no code).
    result.crossLayer = await pipeline.linkCrossLayer();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'kg_memory_search',
  'Semantic search over Engram memory (user prefs, feedback, project context, decisions). Searches the vault-mirrored Memory nodes. Optionally filter by provenance: runtime (claude-code|hermes|openclaw), persona (e.g. jeremy, alfred), model. Returns ranked matches with excerpts + provenance.',
  {
    query: z.string().describe('Natural language query, e.g. "Jeremy preference about testing" or "Rehoboam math assumptions"'),
    limit: z.number().optional().describe('Max results (default 10)'),
    runtime: z.string().optional().describe('Filter to memories written by this runtime (claude-code|hermes|openclaw)'),
    persona: z.string().optional().describe('Filter to this persona/identity (e.g. jeremy, alfred)'),
    model: z.string().optional().describe('Filter to memories generated by this model'),
    diversityEnabled: z.boolean().optional().describe('Enable/disable diversity cap (default: true). Set false to disable near-duplicate filtering.'),
    diversityThreshold: z.number().optional().describe('Cosine-similarity threshold above which two results are considered "similar" (default 0.92, range 0–1). Lower = more aggressive filtering.'),
    diversityMaxSimilar: z.number().optional().describe('Max number of already-selected results allowed to be similar to a new candidate before it is skipped (default 2). Set to 1 for stricter de-dup.'),
  },
  async ({ query, limit, runtime, persona, model, diversityEnabled, diversityThreshold, diversityMaxSimilar }) => {
    await ensureEmbedder();
    const n = limit ?? 10;
    const diversity = (diversityEnabled !== undefined || diversityThreshold !== undefined || diversityMaxSimilar !== undefined)
      ? { enabled: diversityEnabled, threshold: diversityThreshold, maxSimilar: diversityMaxSimilar }
      : undefined;
    const results = await searchMemoryHybrid(store, embedder, query, {
      k: n, runtime, persona, model, diversity, admission: LOCAL_MEMORY_ADMISSION,
    });
    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No matching memory found.' }] };
    }
    const formatted = results.map(r => {
      const meta = (r.frontmatter?.metadata ?? {}) as Record<string, unknown>;
      const prov = [meta.runtime ?? r.frontmatter?.runtime, meta.persona ?? r.frontmatter?.persona, meta.model ?? r.frontmatter?.model]
        .filter(Boolean).join(' · ');
      return `**${r.title}** [informational_only] (score: ${r.score.toFixed(3)}${prov ? `, ${prov}` : ''})\n${r.excerpt}`;
    }).join('\n\n---\n\n');
    return { content: [{ type: 'text', text: formatted }] };
  }
);

server.tool(
  'kg_timeline_search',
  'Episodic / temporal search over WORK-SESSION history. Use for "what was I working on", "when did I do X", and timeline questions answered by *when* things happened. Returns real work sessions (automation like briefings, health-crons, and digests filtered out by default), newest first, optionally ranked by topic relevance. Complements kg_memory_search, which answers "what is our decision / preference about X" (durable facts, not when-things-happened). Pick this tool for WHEN/timeline; pick kg_memory_search for WHAT/durable.',
  {
    topic: z.string().optional().describe('Optional topic to rank sessions by relevance, e.g. "Rehoboam math" or "auth refactor". Omit for a plain chronological list.'),
    start_date: z.string().optional().describe('Range start, YYYY-MM-DD (inclusive). Omit for all-time.'),
    end_date: z.string().optional().describe('Range end, YYYY-MM-DD (inclusive). Omit for all-time.'),
    include_automated: z.boolean().optional().describe('Include automated sessions (briefings, health-crons, digests). Default false.'),
    limit: z.number().optional().describe('Max results (default 15)'),
  },
  async ({ topic, start_date, end_date, include_automated, limit }) => {
    const includeAuto = include_automated ?? false;
    const lo = start_date ?? '0000-01-01';
    const hi = end_date ?? '9999-12-31';
    const max = limit ?? 15;
    type S = { id: string; title: string; startedAt: string; content: string; automated: boolean; score?: number };

    let rows: S[];
    if (topic) {
      // topic given: ANN-rank session nodes by relevance, then apply date + automation filters
      await ensureEmbedder();
      const q = await embedder.embed(topic);
      rows = [];
      for (const hit of store.searchVector(q, 400)) {
        if (!hit.nodeId.startsWith('Sessions/')) continue;
        if (!canExposeNode(hit.nodeId)) continue;
        const node = store.getNode(hit.nodeId);
        const fm = (node?.frontmatter ?? {}) as Record<string, unknown>;
        const startedAt = typeof fm.started_at === 'string' ? fm.started_at : undefined;
        if (!startedAt) continue;
        rows.push({
          id: hit.nodeId, title: node!.title, startedAt,
          content: node!.content ?? '', automated: fm.automated === true, score: hit.score,
        });
      }
    } else {
      // no topic: plain chronological list within the range
      rows = store.getSessionsByTimeRange(lo, hi, includeAuto)
        .filter(row => canExposeNode(row.id));
    }

    const out = rows
      .filter(r => (includeAuto || !r.automated) && r.startedAt.slice(0, 10) >= lo && r.startedAt.slice(0, 10) <= hi)
      .slice(0, max)
      .map(r => ({
        session: r.id.replace(/^Sessions\//, ''),
        date: r.startedAt.slice(0, 10),
        title: r.title,
        authority: 'informational_only',
        ...(r.score !== undefined ? { relevance: Number(r.score.toFixed(3)) } : {}),
        excerpt: sessionExcerpt(r.content),
      }));

    if (out.length === 0) {
      return { content: [{ type: 'text', text: `No work sessions found${topic ? ` about "${topic}"` : ''} in ${lo}..${hi}. (Automation is excluded unless include_automated=true.)` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  'kg_node',
  'Get a node. Brief mode (default) returns metadata + connection titles grouped by relation type. Full mode returns content + edge context.',
  {
    name: z.string().describe('Node name (fuzzy matched)'),
    brief: z.boolean().optional().describe('Brief mode: metadata + connection titles only (default true)'),
    maxContentLength: z.number().optional().describe('Truncate content to N chars in full mode (default 2000)'),
  },
  async ({ name, brief, maxContentLength }) => {
    const nodeId = requireSafeMatch(name);
    const node = store.getNode(nodeId);
    if (!node) throw new Error(`Node "${name}" not found`);
    const useBrief = brief ?? true;

    if (useBrief) {
      const outgoing = store.getEdgeSummariesFrom(nodeId).filter(edge => isGenericGraphNode(edge.nodeId));
      const incoming = store.getEdgeSummariesTo(nodeId).filter(edge => isGenericGraphNode(edge.nodeId));
      const result = {
        id: node.id,
        title: node.title,
        frontmatter: node.frontmatter,
        outgoingCount: store.countEdgesFrom(nodeId),
        incomingCount: store.countEdgesTo(nodeId),
        outgoing,
        incoming,
        ...memoryBoundary(nodeId),
        outgoingByRelationType: groupByRelationType(outgoing),
        incomingByRelationType: groupByRelationType(incoming),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    const limit = maxContentLength ?? 2000;
    const truncatedContent = node.content.length > limit
      ? node.content.slice(0, limit) + `\n\n... [truncated, ${node.content.length} chars total]`
      : node.content;
    const outgoing = store.getEdgesFrom(nodeId).filter(e => isGenericGraphNode(e.targetId)).map(e => ({
      ...e,
      context: e.context.length > 200 ? e.context.slice(0, 200) + '...' : e.context,
    }));
    const incoming = store.getEdgesTo(nodeId).filter(e => isGenericGraphNode(e.sourceId)).map(e => ({
      ...e,
      context: e.context.length > 200 ? e.context.slice(0, 200) + '...' : e.context,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({
      ...node,
      content: truncatedContent,
      outgoing,
      incoming,
      ...memoryBoundary(nodeId),
      outgoingByRelationType: groupByRelationType(outgoing),
      incomingByRelationType: groupByRelationType(incoming),
    }, null, 2) }] };
  }
);

server.tool(
  'kg_neighbors',
  'Get connected nodes at N-hop depth',
  {
    name: z.string().describe('Node name (fuzzy matched)'),
    depth: z.number().optional().describe('Hop depth (default 1)'),
    relation: z.string().optional().describe('Filter to edges of this relation type (e.g. depends_on, uses, mentions)'),
  },
  async ({ name, depth, relation }) => {
    const nodeId = requireSafeMatch(name);
    const kg = safeGraph();
    const neighbors = kg.neighbors(nodeId, depth ?? 1, relation);
    return { content: [{ type: 'text', text: JSON.stringify(neighbors, null, 2) }] };
  }
);

server.tool(
  'kg_search',
  'Semantic or full-text search over the graph',
  {
    query: z.string().describe('Search query'),
    fulltext: z.boolean().optional().describe('Use full-text search instead of semantic'),
    limit: z.number().optional().describe('Max results (default 20)'),
    relation: z.string().optional().describe('Filter: only return nodes that have at least one outgoing edge of this relation type'),
    runtime: z.string().optional().describe('Provenance filter: runtime (claude-code|hermes|openclaw)'),
    persona: z.string().optional().describe('Provenance filter: persona/identity (e.g. jeremy, alfred)'),
    model: z.string().optional().describe('Provenance filter: generating model'),
  },
  async ({ query, fulltext, limit, relation, runtime, persona, model }) => {
    const n = limit ?? 20;
    const hasProvenance = !!(runtime || persona || model);
    const fetch = hasProvenance ? n * 5 : n;  // widen the window so provenance filtering still fills `limit`
    let results;
    if (fulltext) {
      results = store.searchFullText(query).slice(0, fetch);
    } else {
      await ensureEmbedder();
      results = await search.semantic(query, fetch);
    }

    if (hasProvenance) {
      results = results.filter(r => matchesProvenance(r.frontmatter, { runtime, persona, model }));
    }

    results = results.filter(r => canExposeNode(r.nodeId));

    if (relation) {
      const nodeIdsWithRelation = new Set(
        store.allNodeIds().filter(id => store.getEdgesFromByRelationType(id, relation).length > 0)
      );
      results = results.filter(r => nodeIdsWithRelation.has(r.nodeId));
    }

    const safeResults = results.slice(0, n).map(result => ({
      ...result,
      ...memoryBoundary(result.nodeId),
    }));
    return { content: [{ type: 'text', text: JSON.stringify(safeResults, null, 2) }] };
  }
);

server.tool(
  'kg_paths',
  'Find connecting paths between two nodes',
  {
    from: z.string().describe('Source node name'),
    to: z.string().describe('Target node name'),
    maxDepth: z.number().optional().describe('Maximum path depth (default 3)'),
    relationshipType: z.string().optional().describe('Constrain traversal to edges of this relation type'),
  },
  async ({ from, to, maxDepth, relationshipType }) => {
    const fromId = requireSafeMatch(from);
    const toId = requireSafeMatch(to);
    const kg = safeGraph();
    const paths = kg.findPaths(fromId, toId, maxDepth ?? 3, relationshipType);
    return { content: [{ type: 'text', text: JSON.stringify(paths, null, 2) }] };
  }
);

server.tool(
  'kg_common',
  'Find shared connections between two nodes',
  {
    nodeA: z.string().describe('First node name'),
    nodeB: z.string().describe('Second node name'),
  },
  async ({ nodeA, nodeB }) => {
    const idA = requireSafeMatch(nodeA);
    const idB = requireSafeMatch(nodeB);
    const kg = safeGraph();
    const common = kg.commonNeighbors(idA, idB);
    return { content: [{ type: 'text', text: JSON.stringify(common, null, 2) }] };
  }
);

server.tool(
  'kg_subgraph',
  'Extract a local neighborhood as a self-contained graph',
  {
    name: z.string().describe('Center node name'),
    depth: z.number().optional().describe('Hop depth (default 1)'),
  },
  async ({ name, depth }) => {
    const nodeId = requireSafeMatch(name);
    const kg = safeGraph();
    const sub = kg.subgraph(nodeId, depth ?? 1);
    return { content: [{ type: 'text', text: JSON.stringify(sub, null, 2) }] };
  }
);

server.tool(
  'kg_communities',
  'List detected communities',
  {},
  async () => {
    const communities = store.getAllCommunities();
    const summary = communities.map(c => {
      const visible = c.nodeIds.filter(isGenericGraphNode);
      const first = visible.length > 0 ? store.getNode(visible[0]) : undefined;
      return {
        id: c.id,
        label: first?.title ?? `Community ${c.id}`,
        summary: `${visible.length} visible nodes`,
        memberCount: visible.length,
      };
    });
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  'kg_community',
  'Get a specific community',
  { id: z.string().describe('Community ID or label') },
  async ({ id }) => {
    const communities = store.getAllCommunities();
    const numId = /^\d+$/.test(id) ? parseInt(id) : NaN;
    const community = communities.find(c => c.id === numId || c.label === id);
    if (!community) throw new Error(`Community "${id}" not found`);
    const visible = community.nodeIds.filter(isGenericGraphNode);
    const first = visible.length > 0 ? store.getNode(visible[0]) : undefined;
    return { content: [{ type: 'text', text: JSON.stringify({
      id: community.id,
      label: first?.title ?? `Community ${community.id}`,
      summary: `${visible.length} visible nodes`,
      nodeIds: visible,
    }, null, 2) }] };
  }
);

server.tool(
  'kg_bridges',
  'Find bridge nodes with highest betweenness centrality',
  { limit: z.number().optional().describe('Max results (default 20)') },
  async ({ limit }) => {
    const kg = safeGraph();
    const bridges = kg.bridges(limit ?? 20);
    return { content: [{ type: 'text', text: JSON.stringify(bridges, null, 2) }] };
  }
);

server.tool(
  'kg_central',
  'Find central nodes by PageRank',
  {
    community: z.string().optional().describe('Restrict to community ID'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ community, limit }) => {
    const kg = safeGraph();
    let communityNodeIds: string[] | undefined;
    if (community) {
      const communities = store.getAllCommunities();
      const c = communities.find(c => c.id === parseInt(community));
      communityNodeIds = c?.nodeIds.filter(isGenericGraphNode);
    }
    const central = kg.centralNodes(limit ?? 20, communityNodeIds);
    return { content: [{ type: 'text', text: JSON.stringify(central, null, 2) }] };
  }
);

if (!options.readOnly) server.tool(
  'kg_create_node',
  'Create a new node in the vault. Writes a markdown file with frontmatter and indexes it.',
  {
    title: z.string().describe('Node title (becomes the filename)'),
    directory: z.string().optional().describe('Directory within vault (e.g., "Concepts", "People", "Ideas"). Omit for vault root.'),
    content: z.string().describe('Markdown content for the node body'),
    frontmatter: z.record(z.string(), z.unknown()).optional().describe('YAML frontmatter fields (type, tags, status, related, etc.)'),
  },
  async ({ title, directory, content, frontmatter }) => {
    if (isReservedMemoryPath(directory)) {
      throw new Error('Memory and episode namespaces require the admission workflow');
    }
    const relPath = writer.createNode({
      title,
      directory,
      frontmatter: frontmatter ?? {},
      content,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ created: relPath }, null, 2) }] };
  }
);

if (!options.readOnly) server.tool(
  'kg_annotate_node',
  'Append content to an existing node. Use for agent notes, observations, or additional context.',
  {
    name: z.string().describe('Node name or ID (fuzzy matched)'),
    content: z.string().describe('Markdown content to append'),
  },
  async ({ name, content }) => {
    const nodeId = requireSafeMatch(name);
    if (isMemoryNode(nodeId)) {
      throw new Error('Memory and episode nodes require the admission workflow');
    }
    writer.annotateNode(nodeId, content);
    return { content: [{ type: 'text', text: JSON.stringify({ annotated: nodeId }, null, 2) }] };
  }
);

if (!options.readOnly) server.tool(
  'kg_add_link',
  'Add a wiki link from one node to another with context. Appends to the source file and creates an edge.',
  {
    source: z.string().describe('Source node name or ID'),
    target: z.string().describe('Target node reference (e.g., "People/Alice Smith" or "Widget Theory")'),
    context: z.string().describe('Why this link exists — the sentence or note explaining the connection'),
  },
  async ({ source, target, context }) => {
    const sourceId = requireSafeMatch(source);
    if (isMemoryNode(sourceId) || isReservedMemoryPath(target)) {
      throw new Error('Memory and episode nodes require the admission workflow');
    }
    writer.addLink(sourceId, target, context);
    return { content: [{ type: 'text', text: JSON.stringify({ linked: { from: sourceId, to: target } }, null, 2) }] };
  }
);  // closes kg_add_link

// --- Engram MCP tools (behind feature flags) ---

const engramEnabled = process.env.ENGRAM_ENABLE_EPISODES === '1'
  || process.env.ENGRAM_ENABLE_ASSERTIONS === '1'
  || process.env.ENGRAM_ENABLE_RECALL === '1';

if (engramEnabled) {

server.registerTool('engram_corpora', {
  title: 'List Shared Collections',
  description: 'List reusable evidence collections and their freshness before researching a procurement or project question.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => ({ content: [{ type: 'text', text: JSON.stringify(listCorpora()) }] }));

registerCorpusRoutingTool(server, corpusRoutingRuntime);

server.registerTool('engram_x1c_recall', {
  title: 'Recall Jeremy’s X1 Carbon Printer and Reference',
  description: 'Use before answering about Jeremy’s 3D printer, Replicator, Bambu X1C/X1 Carbon capabilities, compatible filament, AMS, calibration, maintenance, repairs, or printing setup. Returns dated equipment context alongside cited manufacturer documentation. A printer profile or downloaded 3MF does not prove installed hardware.',
  inputSchema: {
    query: z.string().trim().min(1).max(1000),
    limit: z.number().int().min(1).max(12).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ query, limit }) => ({
  content: [{ type: 'text', text: JSON.stringify(recallX1cEvidence(query, limit)) }],
}));

server.registerTool('engram_corpus_recall', {
  title: 'Search a Shared Collection',
  description: 'Search a collection listed by engram_corpora for cited domain knowledge, parts, specifications, or supplier evidence. Results are informational only. Check freshness before using prices or availability.',
  inputSchema: {
    collection_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    query: z.string().trim().min(1).max(1000),
    limit: z.number().int().min(1).max(12).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ collection_id, query, limit }) => ({
  content: [{ type: 'text', text: JSON.stringify(recallRegisteredCorpus(collection_id, query, limit)) }],
}));

server.registerTool(
  GX460_CORPUS.tool.name,
  {
    title: GX460_CORPUS.tool.title,
    description: GX460_CORPUS.tool.description,
    inputSchema: {
      query: z.string().trim().min(1).describe(`Natural-language GX460 topic or question, e.g. "${GX460_CORPUS.tool.queryExample}"`),
      limit: z.number().int().min(1).max(12).optional().describe('Maximum evidence excerpts (default 6, max 12)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ query, limit }) => {
    const databasePath = process.env[GX460_CORPUS.database.envVar]
      ?? join(config.dataDir, GX460_CORPUS.database.defaultFilename);
    const result = recallGx460Evidence(databasePath, query, limit);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'engram_recall',
  'Recall cited evidence from promoted structured Engram assertions. Returns evidence status (evidence_found, low_confidence_evidence, contradicted_evidence, historical_only, no_reliable_evidence, needs_review) with confidence and provenance. Unstructured prose may be retrieved for review but cannot satisfy the answer contract. Use this instead of raw graph search for questions about decisions, preferences, facts, and durable knowledge.',
  {
    query: z.string().describe('Natural language query, e.g. "What does Jeremy prefer for code review?"'),
    min_confidence: z.number().optional().describe('Minimum confidence threshold (default 0.5). Lower to surface weaker signals.'),
    mode: z.enum(['current', 'historical', 'audit']).optional().describe('Recall mode: current (active facts only, default), historical (include superseded/retracted), audit (include pruned)'),
    limit: z.number().optional().describe('Max evidence results (default 10)'),
  },
  async ({ query, min_confidence, mode, limit }) => {
    const result = engramRecall(store.db, {
      query,
      minConfidence: min_confidence ?? 0.5,
      mode: mode ?? 'current',
      maxResults: limit ?? 10,
      admission: LOCAL_MEMORY_ADMISSION,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'engram_explain',
  'Explain why Engram returned a specific assertion in recall results. Shows evidence chain, confidence reasons, source citation excerpt, and alternative candidates. Use this for debugging recall quality or understanding a disagreement between engram_recall and kg_memory_search.',
  {
    assertion_id: z.string().describe('The assertion_id from engram_recall evidence to explain'),
  },
  async ({ assertion_id }) => {
    const result = engramExplain(store.db, assertion_id, { admission: LOCAL_MEMORY_ADMISSION });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);  // closes engram_explain

// --- Contradiction tools ---

if (!options.readOnly) server.tool(
  'engram_detect_contradictions',
  'Scan assertions for new contradictions. Finds pairs of current assertions with the same subject+predicate but different objects. Returns any newly detected cases. Duplicates (already-open cases) are skipped.',
  {},
  async () => {
    const cases = detectContradictions(store.db, sourceNodeId =>
      isPromotedMemorySource(store.db, sourceNodeId));
    const totalOpen = admittedContradictions().length;
    return {
      content: [{ type: 'text', text: JSON.stringify({
        new_cases: cases.length,
        total_open: totalOpen,
        cases: cases,
      }, null, 2) }],
    };
  }
);

server.tool(
  'engram_contradiction_queue',
  'List unresolved contradiction cases for review. Returns all open cases with subject, predicate, conflicting assertions, and detection time.',
  {},
  async () => {
    const cases = admittedContradictions();
    const total = cases.length;
    return {
      content: [{ type: 'text', text: JSON.stringify({
        total_open: total,
        cases,
      }, null, 2) }],
    };
  }
);

if (!options.readOnly) server.tool(
  'engram_resolve_contradiction',
  'Resolve a contradiction case. Updates assertion statuses (losing assertion gets superseded/retracted/downgraded) and writes a Decision note to the vault with the resolution rationale.',
  {
    case_id: z.string().describe('The contradiction case ID from engram_contradiction_queue'),
    winning_assertion_id: z.string().describe('The assertion that remains current'),
    losing_assertion_id: z.string().describe('The assertion that gets superseded or retracted'),
    resolution_type: z.enum(['supersede', 'retract_old', 'merge', 'downgrade_confidence']).describe('How to resolve: supersede (newer wins), retract_old (explicit retraction), merge (both kept), downgrade_confidence (lower confidence on loser)'),
    evidence_note: z.string().describe('Human-readable rationale for the resolution'),
  },
  async ({ case_id, winning_assertion_id, losing_assertion_id, resolution_type, evidence_note }) => {
    const contradiction = admittedContradictions().find(c => c.id === case_id);
    if (!contradiction) throw new Error('Contradiction case not found');
    const expectedAssertions = new Set([
      contradiction.assertion_a_id, contradiction.assertion_b_id,
    ]);
    if (!expectedAssertions.has(winning_assertion_id)
      || !expectedAssertions.has(losing_assertion_id)
      || winning_assertion_id === losing_assertion_id) {
      throw new Error('Resolution assertions do not match contradiction case');
    }
    // Write vault Decision note first
    const vaultPath = config.vaultPath;
    const resolutionDoc = [
      `# Contradiction Resolution: ${case_id}`,
      '',
      `**Resolution type:** ${resolution_type}`,
      `**Winning assertion:** ${winning_assertion_id}`,
      `**Losing assertion:** ${losing_assertion_id}`,
      '',
      `**Rationale:** ${evidence_note}`,
      '',
      `**Resolved at:** ${new Date().toISOString()}`,
      '',
      '---',
      'This note was auto-generated by Engram contradiction resolution.',
    ].join('\n');

    const decisionDir = 'Decisions';
    const decisionTitle = `contradiction-resolve-${case_id.slice(0, 8)}`;
    let sourceNodeId = '';
    try {
      const relPath = writer.createNode({
        title: decisionTitle,
        directory: decisionDir,
        frontmatter: {
          type: 'contradiction_resolution',
          case_id,
          resolution_type,
          resolved_at: new Date().toISOString(),
        },
        content: resolutionDoc,
      });
      sourceNodeId = relPath;
    } catch (e) {
      // File may already exist if re-resolving — non-critical
      sourceNodeId = `${decisionDir}/${decisionTitle}.md`;
    }

    // Update DB state
    resolveContradiction(store.db, case_id, {
      resolution_type: resolution_type as any,
      winning_assertion_id,
      losing_assertion_id,
      evidence_note,
      source_node_id: sourceNodeId,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify({
        resolved: case_id,
        source_node_id: sourceNodeId,
        resolution_type,
      }, null, 2) }],
    };
  }
);  // closes engram_resolve_contradiction

// --- Memory verbs ---

if (!options.readOnly && options.memoryAdmission) server.tool(
  'engram_remember',
  'Submit one fact you learned. It enters quarantine and is admitted by the sweep after the next index when automatic checks pass: no credential-shaped text, and source_node_id names an indexed vault note. Without a source it stays quarantined.',
  {
    subject: z.string().trim().min(1).describe('The subject of the fact (e.g. "Jeremy", "Engram", "Alfred")'),
    predicate: z.string().trim().min(1).describe('The predicate (e.g. "prefers", "uses", "runs_on", "requires")'),
    object: z.string().trim().min(1).describe('The object of the fact (e.g. "concise responses", "RRF fusion")'),
    source_node_id: z.string().optional().describe('Vault-relative path of the indexed note that supports the fact, such as Sessions/2026-10-04-alfred-topic-laptop.md. Required for admission.'),
    confidence: z.number().min(0).max(1).optional().describe('Confidence in this fact, 0.0–1.0 (default 1.0)'),
  },
  async ({ subject, predicate, object, source_node_id, confidence }) => {
    const result = options.memoryAdmission!.submit(store.db, {
      origin: 'model_derived',
      subject,
      predicate,
      object,
      confidence: confidence ?? 1.0,
      sourceNodeId: source_node_id,
      sourceHash: 'mcp-candidate',
    });
    return { content: [{ type: 'text', text: JSON.stringify({
      status: result.status,
      candidate_id: result.status === 'quarantined' ? result.candidate.id : undefined,
      rejection_reason: result.status === 'rejected' ? result.reason : undefined,
      recallable: false,
      authority: 'none',
    }, null, 2) }] };
  }
);

if (!options.readOnly) server.tool(
  'engram_forget',
  'Retract or delete a fact from Engram. Default: soft retract (sets status=retracted, preserves audit trail). Hard delete with --force removes from DB entirely (use only for test data cleanup).',
  {
    assertion_id: z.string().describe('The assertion ID to forget'),
    reason: z.string().describe('Why this fact is being forgotten'),
    hard: z.boolean().optional().describe('Hard delete from DB instead of soft retract (default false)'),
  },
  async ({ assertion_id, reason, hard }) => {
    const result = engramForget(store.db, { assertionId: assertion_id, reason, hard: hard ?? false }, writer);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

if (!options.readOnly) server.tool(
  'engram_improve',
  'Update the confidence of an existing assertion. Use when new evidence confirms or weakens a fact.',
  {
    assertion_id: z.string().describe('The assertion ID to update'),
    new_confidence: z.number().describe('New confidence value, 0.0–1.0'),
    evidence_text: z.string().optional().describe('Optional rationale for the confidence change'),
  },
  async ({ assertion_id, new_confidence, evidence_text }) => {
    const result = engramImprove(store.db, { assertionId: assertion_id, newConfidence: new_confidence, evidenceText: evidence_text });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'engram_profile',
  'Generate the current Engram agent profile. Returns static (preferences, identity, constraints, environment) and dynamic (active projects, recent context, open contradictions) sections. Inject this into agent system context at session start.',
  {},
  async () => {
    const profile = engramProfile(store.db, { admission: LOCAL_MEMORY_ADMISSION });
    return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
  }
);

server.registerTool(
  'engram_status',
  {
    title: 'Check Engram Connection',
    description: 'Report the Engram instance, corpus revision, index freshness, corpus counts, and database maintenance status.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(engramStatus(store.db), null, 2) }],
  }),
);

}  // end if (engramEnabled)

  registerBootstrapTools(server);

  return server;
} // end createKgServer
