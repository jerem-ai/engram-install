/**
 * Type declarations to fix graphology + moduleResolution:"NodeNext" issues.
 *
 * The graphology package's .d.ts uses `export default class Graph` which
 * NodeNext resolves as a namespace rather than a constructable class.
 * These declarations override that behavior.
 */

declare module 'graphology' {
  import { AbstractGraph, Attributes } from 'graphology-types';

  class Graph<
    NodeAttributes extends Attributes = Attributes,
    EdgeAttributes extends Attributes = Attributes,
    GraphAttributes extends Attributes = Attributes,
  > extends AbstractGraph<NodeAttributes, EdgeAttributes, GraphAttributes> {
    constructor(options?: {
      multi?: boolean;
      type?: 'directed' | 'undirected' | 'mixed';
      allowSelfLoops?: boolean;
    });
  }

  export default Graph;
}

declare module 'graphology-metrics/centrality/pagerank.js' {
  import type { AbstractGraph, Attributes } from 'graphology-types';

  interface PagerankOptions {
    nodePagerankAttribute?: string;
    getEdgeWeight?: string | ((edge: string, attrs: Attributes) => number) | null;
    alpha?: number;
    maxIterations?: number;
    tolerance?: number;
  }

  function pagerank(
    graph: AbstractGraph,
    options?: PagerankOptions,
  ): Record<string, number>;

  export default pagerank;
}

declare module 'graphology-metrics/centrality/betweenness.js' {
  import type { AbstractGraph, Attributes } from 'graphology-types';

  interface BetweennessCentralityOptions {
    nodeCentralityAttribute?: string;
    getEdgeWeight?: string | ((edge: string, attrs: Attributes) => number) | null;
    normalized?: boolean;
  }

  function betweennessCentrality(
    graph: AbstractGraph,
    options?: BetweennessCentralityOptions,
  ): Record<string, number>;

  export default betweennessCentrality;
}

declare module 'graphology-communities-louvain' {
  import type { AbstractGraph } from 'graphology-types';

  interface LouvainOptions {
    resolution?: number;
    getEdgeWeight?: string | null;
    randomWalk?: boolean;
  }

  function louvain(
    graph: AbstractGraph,
    options?: LouvainOptions,
  ): Record<string, number>;

  export default louvain;
}
