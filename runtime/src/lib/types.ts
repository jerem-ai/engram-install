export interface ParsedNode {
  id: string;           // path relative to vault root, or absolute path for memory nodes
  title: string;        // from frontmatter or filename
  content: string;      // full markdown
  frontmatter: Record<string, unknown>;
  source?: string;      // 'vault' (default), 'memory', 'docs', or 'code'
}

export interface ParsedEdge {
  sourceId: string;
  targetId: string;     // resolved path
  context: string;      // enclosing paragraph
  relationType: string; // from RELATION_TYPES seed; default 'relates_to'
  confidence: number;   // 0.0–1.0; default 1.0
  since?: string;       // ISO date when this relation was established
  metadata?: Record<string, unknown>;
}

export interface StoredNode extends ParsedNode {
  embedding: Float32Array | null;
}

export interface StoredEdge extends ParsedEdge {
  id: number;
}

export interface Community {
  id: number;
  label: string;
  summary: string;
  nodeIds: string[];
}

export interface SearchResult {
  nodeId: string;
  title: string;
  score: number;
  /** Unfused retrieval signals. Missing means this retrieval arm did not return the node. */
  cosine?: number;
  bm25?: number;
  /** Best passage cosine when the node entered the vector arm through a passage (passage-rescore.ts). */
  passageCosine?: number;
  /** Age is a review signal for project/reference records, never proof of expiry. */
  currency?: { createdAt: string; ageDays: number };
  excerpt: string;
  frontmatter?: Record<string, unknown>;  // node frontmatter (incl. provenance: runtime/persona/model) for filtering/display
  /** Exact quote locations only; these pointers do not certify claim support. */
  evidence?: { status: 'linked' | 'partial'; support: 'unreviewed' | 'operator-supported' | 'operator-unsupported' | 'operator-uncertain';
    /** Explicit local review only; never an admission or write-authority grant. */
    supportReview?: { reviewedAt: string; receiptSha256: string };
    /** Historical source-folder attribution; never a semantic scope or authority grant. */
    sourceProject?: string;
    events: { eventId: string; transcriptId: string; rawHash: string; actor: string }[] };
  memoryAdmission?: {
    origin: 'user_authored' | 'tool_derived' | 'model_derived' | 'imported';
    trust_state: 'promoted';
    sensitivity: 'private' | 'security_sensitive';
    authority: 'informational_only';
  };
}

export interface PathResult {
  nodes: string[];       // ordered node IDs along the path
  edges: Array<{         // edge context for each hop
    sourceId: string;
    targetId: string;
    context: string;
    relationType: string;
  }>;
  length: number;
}

export interface SubgraphResult {
  nodes: Array<{ id: string; title: string; frontmatter: Record<string, unknown> }>;
  edges: Array<{ sourceId: string; targetId: string; context: string; relationType: string }>;
}

export interface NameMatch {
  nodeId: string;
  title: string;
  matchType: 'id' | 'exact' | 'case-insensitive' | 'alias' | 'substring';
}
