import { Command } from 'commander';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { accessContextFromEnv } from '../lib/access-context.js';
import { Embedder } from '../lib/embedder.js';
import { IndexPipeline } from '../lib/index-pipeline.js';
import { KnowledgeGraph } from '../lib/graph.js';
import { Search } from '../lib/search.js';
import { resolveNodeName } from '../lib/resolve.js';
import { Enricher } from '../lib/enricher.js';
import { VaultWriter } from '../lib/writer.js';
import { searchMemoryHybrid } from '../lib/memory-search.js';
import { engramRecall } from '../lib/engram/recall.js';
import { createMemoryAdmissionService } from '../lib/engram/admission-key.js';
import { listMemoryCandidates, getMemoryCandidate, getMemoryCandidateEvidence, type MemoryTrustState } from '../lib/engram/admission.js';
import { engramForget } from '../lib/engram/verbs.js';
import { listRetiredSources, restoreSource, retireSource } from '../lib/engram/source-retirement.js';
import { createLocalOperatorIdentity } from '../lib/engram/local-identity.js';
import {
  factMaintainerDir, judgeRunsOn, listReceipts, revertMaintenanceRun, runDeterministicMaintenance,
} from '../lib/engram/fact-maintainer.js';
import { loadFactMaintainerConfig, runJudgeNight, runValidation } from '../lib/engram/fact-judge.js';
import { sshKippTransport } from '../lib/engram/kipp.js';
import { engramStatusReport, formatStatus } from './status.js';

const program = new Command();

program
  .name('kg')
  .description('Knowledge graph tools for Obsidian vaults')
  .version('0.1.0')
  .option('--vault-path <path>', 'Path to Obsidian vault')
  .option('--data-dir <path>', 'Path to data directory');

function getConfig() {
  const opts = program.opts();
  return resolveConfig({
    vaultPath: opts.vaultPath,
    dataDir: opts.dataDir,
  });
}

function getStore() {
  const config = getConfig();
  mkdirSync(config.dataDir, { recursive: true });
  return new Store(config.dbPath, accessContextFromEnv());
}

function output(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function requireSingleMatch(name: string, store: Store): string {
  const matches = resolveNodeName(name, store);
  if (matches.length === 0) {
    console.error(`No node found matching "${name}"`);
    process.exit(1);
  }
  if (matches.length > 1 && matches[0].matchType !== 'exact' && matches[0].matchType !== 'id') {
    output({ ambiguous: true, hint: 'Use the full node ID to disambiguate', candidates: matches });
    process.exit(1);
  }
  return matches[0].nodeId;
}

program
  .command('status')
  .description('One screen: is this install learning, indexing and recalling? Plain words, a fix line per red item')
  .option('--json', 'Print the report as JSON')
  .action(async (opts) => {
    const report = await engramStatusReport();
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatStatus(report));
    process.exitCode = report.status === 'fail' ? 1 : 0;
  });

program
  .command('index')
  .description('Parse vault and build/update the knowledge graph')
  .option('--resolution <number>', 'Louvain resolution parameter', '1.0')
  .option('--force', 'Force full re-index (ignore sync state)')
  .action(async (opts) => {
    const config = getConfig();
    mkdirSync(config.dataDir, { recursive: true });
    const store = new Store(config.dbPath, accessContextFromEnv());
    if (opts.force) {
      store.clearSync();
    }
    const embedder = new Embedder();
    await embedder.init();
    // Structured frontmatter is quarantined for review, never auto-promoted.
    // Without this service the pipeline drops every candidate silently.
    const pipeline = new IndexPipeline(store, embedder, createMemoryAdmissionService(config.dataDir));
    const vaultStats = await pipeline.index(config.vaultPath, parseFloat(opts.resolution));
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
    result.engram = await pipeline.deriveEngram();
    output(result);
    await embedder.dispose();
    store.close();
  });

program
  .command('node <name>')
  .description('Get a node with its content and connections')
  .option('--full', 'Return full content and edge context (default is brief)')
  .option('--max-content <n>', 'Truncate content to N chars in full mode', '2000')
  .action((name, opts) => {
    const store = getStore();
    const nodeId = requireSingleMatch(name, store);
    const node = store.getNode(nodeId);
    if (!node) { console.error(`Node not found`); process.exit(1); }

    function groupByRelationType<T extends { relationType: string }>(items: T[]): Record<string, T[]> {
      const groups: Record<string, T[]> = {};
      for (const item of items) { (groups[item.relationType] ??= []).push(item); }
      return groups;
    }

    if (opts.full) {
      const limit = parseInt(opts.maxContent);
      const truncatedContent = node.content.length > limit
        ? node.content.slice(0, limit) + `\n\n... [truncated, ${node.content.length} chars total]`
        : node.content;
      const outgoing = store.getEdgesFrom(nodeId).map(e => ({
        ...e, context: e.context.length > 200 ? e.context.slice(0, 200) + '...' : e.context,
      }));
      const incoming = store.getEdgesTo(nodeId).map(e => ({
        ...e, context: e.context.length > 200 ? e.context.slice(0, 200) + '...' : e.context,
      }));
      output({ ...node, content: truncatedContent, outgoing, incoming,
        outgoingByRelationType: groupByRelationType(outgoing),
        incomingByRelationType: groupByRelationType(incoming),
      });
    } else {
      const outgoing = store.getEdgeSummariesFrom(nodeId);
      const incoming = store.getEdgeSummariesTo(nodeId);
      output({
        id: node.id, title: node.title, frontmatter: node.frontmatter,
        outgoingCount: store.countEdgesFrom(nodeId),
        incomingCount: store.countEdgesTo(nodeId),
        outgoing, incoming,
        outgoingByRelationType: groupByRelationType(outgoing),
        incomingByRelationType: groupByRelationType(incoming),
      });
    }
    store.close();
  });

program
  .command('neighbors <name>')
  .description('Get connected nodes')
  .option('--depth <n>', 'Hop depth', '1')
  .option('--relation-type <type>', 'Filter to edges of this relation type')
  .action((name, opts) => {
    const store = getStore();
    const nodeId = requireSingleMatch(name, store);
    const kg = KnowledgeGraph.fromStore(store);
    const neighbors = kg.neighbors(nodeId, parseInt(opts.depth), opts.relationType);
    output(neighbors);
    store.close();
  });

program
  .command('search <query>')
  .description('Search the knowledge graph')
  .option('--fulltext', 'Use full-text search instead of semantic')
  .option('--limit <n>', 'Max results', '20')
  .action(async (query, opts) => {
    const store = getStore();
    if (opts.fulltext) {
      const results = store.searchFullText(query).slice(0, parseInt(opts.limit));
      output(results);
    } else {
      const embedder = new Embedder();
      await embedder.init();
      const search = new Search(store, embedder);
      const results = await search.semantic(query, parseInt(opts.limit));
      output(results);
      await embedder.dispose();
    }
    store.close();
  });

program
  .command('paths <from> <to>')
  .description('Find connecting paths between two nodes')
  .option('--max-depth <n>', 'Maximum path depth', '3')
  .option('--relation-type <type>', 'Constrain traversal to edges of this relation type')
  .action((from, to, opts) => {
    const store = getStore();
    const fromId = requireSingleMatch(from, store);
    const toId = requireSingleMatch(to, store);
    const kg = KnowledgeGraph.fromStore(store);
    const paths = kg.findPaths(fromId, toId, parseInt(opts.maxDepth), opts.relationType);
    output(paths);
    store.close();
  });

program
  .command('common <nodeA> <nodeB>')
  .description('Find shared connections between two nodes')
  .action((nodeA, nodeB) => {
    const store = getStore();
    const idA = requireSingleMatch(nodeA, store);
    const idB = requireSingleMatch(nodeB, store);
    const kg = KnowledgeGraph.fromStore(store);
    const common = kg.commonNeighbors(idA, idB);
    output(common);
    store.close();
  });

program
  .command('subgraph <name>')
  .description('Extract a local neighborhood')
  .option('--depth <n>', 'Hop depth', '1')
  .action((name, opts) => {
    const store = getStore();
    const nodeId = requireSingleMatch(name, store);
    const kg = KnowledgeGraph.fromStore(store);
    const sub = kg.subgraph(nodeId, parseInt(opts.depth));
    output(sub);
    store.close();
  });

program
  .command('communities')
  .description('List detected communities')
  .action(() => {
    const store = getStore();
    const communities = store.getAllCommunities();
    output(communities.map(c => ({
      id: c.id,
      label: c.label,
      summary: c.summary,
      memberCount: c.nodeIds.length,
    })));
    store.close();
  });

program
  .command('community <id>')
  .description('Get a specific community')
  .action((id) => {
    const store = getStore();
    const communities = store.getAllCommunities();
    const numId = /^\d+$/.test(id) ? parseInt(id) : NaN;
    const community = communities.find(c => c.id === numId || c.label === id);
    if (!community) {
      console.error(`Community "${id}" not found`);
      process.exit(1);
    }
    output(community);
    store.close();
  });

program
  .command('bridges')
  .description('Find bridge nodes (high betweenness centrality)')
  .option('--limit <n>', 'Max results', '20')
  .action((opts) => {
    const store = getStore();
    const kg = KnowledgeGraph.fromStore(store);
    const bridges = kg.bridges(parseInt(opts.limit));
    output(bridges);
    store.close();
  });

program
  .command('central')
  .description('Find central nodes (PageRank)')
  .option('--community <id>', 'Restrict to a community')
  .option('--limit <n>', 'Max results', '20')
  .action((opts) => {
    const store = getStore();
    const kg = KnowledgeGraph.fromStore(store);
    let communityNodeIds: string[] | undefined;
    if (opts.community) {
      const communities = store.getAllCommunities();
      const c = communities.find(c => c.id === parseInt(opts.community));
      communityNodeIds = c?.nodeIds;
    }
    const central = kg.centralNodes(parseInt(opts.limit), communityNodeIds);
    output(central);
    store.close();
  });

program
  .command('enrich')
  .description('Run nightly enrichment passes (decay, dedup, infer, prune)')
  .option('--decay', 'Apply confidence decay to edges')
  .option('--dedup', 'Scan for duplicate node candidates')
  .option('--infer', 'Scan for inferable transitive relations')
  .option('--prune', 'Flag sustained low-confidence edges as pruned')
  .option('--contradictions', 'Scan for contradictions and inverse-relation conflicts')
  .option('--all', 'Run all passes and append summary to Nightly_Log.md')
  .option('--nightly-log <path>', 'Override path to Nightly_Log.md')
  .action((opts) => {
    const store = getStore();
    const enricher = new Enricher(store);

    if (opts.all) {
      const stats = enricher.enrichAll(opts.nightlyLog);
      output(stats);
    } else {
      const result: Record<string, unknown> = {};
      if (opts.decay) result.decay = enricher.applyDecay();
      if (opts.dedup) result.dedup = enricher.findDedupCandidates();
      if (opts.infer) result.infer = enricher.findInferredRelations();
      if (opts.prune) result.prune = enricher.applyPrune();
      if (opts.contradictions) result.contradictions = enricher.findContradictions();
      if (Object.keys(result).length === 0) {
        console.error('Specify at least one of: --decay, --dedup, --infer, --prune, --contradictions, --all');
        process.exit(1);
      }
      output(result);
    }

    store.close();
  });

program
  .command('engram-recall [query]')
  .description('Recall informational evidence through the admission-aware Engram answer contract')
  .option('--query-stdin', 'Read the query from standard input instead of process arguments')
  .option('--max-results <n>', 'Maximum evidence results', '10')
  .option('--min-confidence <f>', 'Structured assertion confidence threshold', '0.5')
  .option('--promoted-only', 'Return only privately reviewed promoted memory sources')
  .option('--admitted', 'Return promoted sources plus memory files whose claims were admitted in place')
  .action((query: string | undefined, opts) => {
    if (query && opts.queryStdin) throw new Error('engram-recall accepts either a query argument or --query-stdin, not both');
    const effectiveQuery = opts.queryStdin ? readFileSync(0, 'utf8') : query;
    if (!effectiveQuery?.trim()) throw new Error('engram-recall requires a query argument or non-empty --query-stdin input');
    if (Buffer.byteLength(effectiveQuery, 'utf8') > 1200) throw new Error('engram-recall query exceeds 1200 UTF-8 bytes');
    const store = getStore();
    try {
      output(engramRecall(store.db, {
        query: effectiveQuery.trim(),
        maxResults: parseInt(opts.maxResults),
        minConfidence: parseFloat(opts.minConfidence),
        admission: opts.promotedOnly ? 'promoted_only' : opts.admitted ? 'admitted' : 'legacy',
      }));
    } finally {
      store.close();
    }
  });

program
  .command('memory-search [query]')
  .description('Hybrid semantic + full-text search over Memory/ nodes with provenance filtering')
  .option('--query-stdin', 'Read the query from standard input instead of process arguments')
  .option('--persona <persona>', 'Filter to this persona/identity (e.g. main, jeremy, alfred)')
  .option('--runtime <runtime>', 'Filter to memories written by this runtime (claude-code|hermes|openclaw)')
  .option('--limit <n>', 'Max results', '10')
  .option('--min-score <f>', 'Minimum RRF fused score (default 0)', '0')
  .option('--promoted-only', 'Return only privately reviewed promoted memory sources')
  .option('--admitted', 'Return promoted sources plus memory files whose claims were admitted in place')
  .action(async (query: string | undefined, opts) => {
    if (query && opts.queryStdin) throw new Error('memory-search accepts either a query argument or --query-stdin, not both');
    const effectiveQuery = opts.queryStdin ? readFileSync(0, 'utf8') : query;
    if (!effectiveQuery?.trim()) throw new Error('memory-search requires a query argument or non-empty --query-stdin input');
    if (Buffer.byteLength(effectiveQuery, 'utf8') > 1200) throw new Error('memory-search query exceeds 1200 UTF-8 bytes');
    const config = getConfig();
    mkdirSync(config.dataDir, { recursive: true });
    const store = new Store(config.dbPath, accessContextFromEnv());
    const embedder = new Embedder();
    await embedder.init();
    const results = await searchMemoryHybrid(store, embedder, effectiveQuery.trim(), {
      k: parseInt(opts.limit),
      persona: opts.persona,
      runtime: opts.runtime,
      minScore: parseFloat(opts.minScore),
      admission: opts.promotedOnly ? 'promoted_only' : opts.admitted ? 'admitted' : 'legacy',
    });
    output(results);
    await embedder.dispose();
    store.close();
  });

const MEMORY_TRUST_STATES: readonly MemoryTrustState[] = ['quarantined', 'promoted', 'rejected'];

program
  .command('engram-review-list')
  .description('List memory admission candidates for local review')
  .option('--state <state>', 'quarantined, promoted, or rejected', 'quarantined')
  .option('--limit <n>', 'Max results', '50')
  .action((opts) => {
    if (!MEMORY_TRUST_STATES.includes(opts.state)) {
      console.error(`--state must be one of: ${MEMORY_TRUST_STATES.join(', ')}`);
      process.exit(1);
    }
    // Listing candidates does not review or mutate anything, so it needs no
    // authorizer or identity — only promote/reject do.
    const store = getStore();
    try {
      const candidates = listMemoryCandidates(store.db, opts.state as MemoryTrustState);
      output(candidates.slice(0, parseInt(opts.limit)).map(candidate => {
        try { return { ...candidate, source_evidence: getMemoryCandidateEvidence(store.db, candidate) }; }
        catch (error) { return { ...candidate, source_evidence_error: (error as Error).message }; }
      }));
    } finally {
      store.close();
    }
  });

program
  .command('engram-review-promote <candidateId>')
  .description('Promote a quarantined memory candidate into a reviewed assertion')
  .requiredOption('--reason <text>', 'Review reason recorded on the promotion receipt')
  .option('--use-source-validity', 'Approve dates from the unchanged source assertion, using source creation time if its start is unstated')
  .option('--valid-from <timestamp>', 'Explicit reviewed start instant with timezone')
  .option('--valid-to <timestamp>', 'Explicit reviewed end instant with timezone')
  .action((candidateId, opts) => {
    const config = getConfig();
    mkdirSync(config.dataDir, { recursive: true });
    const store = new Store(config.dbPath, accessContextFromEnv());
    try {
      const writer = new VaultWriter(config.vaultPath, store);
      const service = createMemoryAdmissionService(config.dataDir);
      const identity = createLocalOperatorIdentity(accessContextFromEnv());
      const result = service.promote(store.db, candidateId, {
        identity, reviewReason: opts.reason, writer,
        useSourceValidity: opts.useSourceValidity, validFrom: opts.validFrom, validTo: opts.validTo,
      });
      output(result);
    } finally {
      store.close();
    }
  });

program
  .command('engram-self-admit')
  .description('Admit quarantined agent-written facts that pass the automatic checks (body-free counts)')
  .option('--limit <n>', 'Max candidates this run')
  .option('--revert', 'Return every self-admitted fact to quarantine and delete its reviewed notes')
  .action((opts) => {
    const config = getConfig();
    mkdirSync(config.dataDir, { recursive: true });
    const store = new Store(config.dbPath, accessContextFromEnv());
    try {
      const writer = new VaultWriter(config.vaultPath, store);
      const service = createMemoryAdmissionService(config.dataDir);
      if (opts.revert) {
        const r = service.revertSelfAdmissions(store.db);
        let notesDeleted = 0;
        for (const note of r.note_paths) if (writer.deleteSource(note) === 'deleted') notesDeleted += 1;
        output({ reverted: r.reverted, assertions_deleted: r.assertions_deleted, notes_deleted: notesDeleted });
      } else {
        output(service.selfAdmitAll(store.db, { writer, limit: opts.limit ? parseInt(opts.limit) : undefined }));
      }
    } finally {
      store.close();
    }
  });

program
  .command('engram-retract <id>')
  .description('Retract one admitted fact by assertion id or candidate id; it leaves recall and stays in the audit trail')
  .requiredOption('--reason <text>', 'Why the fact is wrong; appended to engram-retractions.jsonl')
  .action((id, opts) => {
    const config = getConfig();
    const store = new Store(config.dbPath, accessContextFromEnv());
    try {
      const assertionId = /^[a-f0-9]{64}$/.test(id) ? getMemoryCandidate(store.db, id)?.assertion_id : id;
      if (!assertionId) throw new Error(`No admitted fact for ${id}`);
      const result = engramForget(store.db, { assertionId, reason: opts.reason });
      if (result.status === 'retracted') {
        appendFileSync(join(config.dataDir, 'engram-retractions.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), id, assertion_id: assertionId, reason: opts.reason }) + '\n');
      }
      output(result);
    } finally {
      store.close();
    }
  });

program
  .command('engram-retire-source [sourceNodeId]')
  .description('Take a Memory/ note out of memory search and the recall hook; engram_recall treats its facts as historical (the note is not edited)')
  .option('--by <id>', 'Assertion or candidate id of the correction', 'operator')
  .option('--reason <text>', 'Why the note is retired', 'superseded')
  .option('--restore', 'Undo a retirement')
  .option('--list', 'List retirements, newest first')
  .action((sourceNodeId, opts) => {
    const config = getConfig();
    const store = new Store(config.dbPath, accessContextFromEnv());
    try {
      const writer = new VaultWriter(config.vaultPath, store);
      if (opts.list) output(listRetiredSources(store.db));
      else if (!sourceNodeId) throw new Error('Name the Memory/ note to retire or restore');
      else if (opts.restore) output(restoreSource(store, writer, sourceNodeId));
      else output(retireSource(store.db, writer, { sourceNodeId, retiredBy: opts.by, reason: opts.reason }));
    } finally {
      store.close();
    }
  });

program
  .command('engram-review-reject <candidateId>')
  .description('Reject a quarantined memory candidate')
  .requiredOption('--reason <text>', 'Review reason recorded on the rejection receipt')
  .action((candidateId, opts) => {
    const config = getConfig();
    mkdirSync(config.dataDir, { recursive: true });
    const store = new Store(config.dbPath, accessContextFromEnv());
    try {
      const service = createMemoryAdmissionService(config.dataDir);
      const identity = createLocalOperatorIdentity(accessContextFromEnv());
      const result = service.reject(store.db, candidateId, {
        identity, reviewReason: opts.reason,
      });
      output(result);
    } finally {
      store.close();
    }
  });

program
  .command('engram-maintain')
  .description('Fact maintainer: source-follow self-admitted facts and retire stale candidates (body-free receipts)')
  .option('--dry-run', 'Count what would change; write nothing')
  .option('--revert <runId>', 'Undo one maintenance or judge run')
  .option('--revert-night <date>', 'Undo every judge run started on this UTC date (YYYY-MM-DD)')
  .option('--list', 'List unreverted runs with their counts')
  .action((opts) => {
    const config = getConfig();
    const dir = factMaintainerDir();
    if (opts.list) {
      output(listReceipts(dir).map(r => ({ run_id: r.run_id, kind: r.kind, started_at: r.started_at, counts: r.counts })));
      return;
    }
    const store = new Store(config.dbPath, accessContextFromEnv());
    try {
      if (opts.revert) output(revertMaintenanceRun(store.db, dir, opts.revert));
      else if (opts.revertNight) output(judgeRunsOn(dir, opts.revertNight).map(id => revertMaintenanceRun(store.db, dir, id)));
      else output(runDeterministicMaintenance(store.db, { dir, dryRun: !!opts.dryRun }));
    } finally {
      store.close();
    }
  });

program
  .command('engram-fact-judge')
  .description('Nightly Kipp judge for current facts sharing subject and predicate (shadow until validated)')
  .option('--validate', 'Run the synthetic case set and write a validation receipt; touches no facts')
  .option('--shadow', 'Record decisions without applying any')
  .option('--budget-minutes <n>', 'Stop sending groups after this many minutes')
  .option('--limit-groups <n>', 'Judge at most this many groups')
  .option('--model <name>', 'Override the configured model')
  .option('--no-make-room', 'Skip the CI drain wait (tests and manual runs only)')
  .action((opts) => {
    const config = loadFactMaintainerConfig();
    if (opts.model) config.judge.model = opts.model;
    const transport = sshKippTransport(config.judge.ssh_host);
    const log = (line: string) => console.error(`[${new Date().toISOString()}] ${line}`);
    if (opts.validate) {
      const { receipt, path } = runValidation({ transport, config, log, skipMakeRoom: !opts.makeRoom });
      output({ path, model: receipt.model, score: receipt.score });
      return;
    }
    const store = new Store(getConfig().dbPath, accessContextFromEnv());
    try {
      output(runJudgeNight(store.db, {
        transport, config, log, shadow: !!opts.shadow, skipMakeRoom: !opts.makeRoom,
        budgetMinutes: opts.budgetMinutes ? parseInt(opts.budgetMinutes) : undefined,
        limitGroups: opts.limitGroups ? parseInt(opts.limitGroups) : undefined,
      }));
    } finally {
      store.close();
    }
  });

program.parse(process.argv, { from: 'node' });
