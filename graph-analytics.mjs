// CORTEX graph analytics — knowledge-graph structure analysis.
// Pure computation over getGraph() from ./db.mjs. No DB writes, no new tables.
// Edges are treated as UNDIRECTED for all connectivity/degree purposes.
//
// Export: graphMetrics() — see its doc comment for the returned shape.
import { getGraph } from './db.mjs';

// Connected components via union-find (disjoint-set) with path compression + union by rank.
// We build sets keyed by node id; every node starts in its own set, then each edge unions its
// two endpoints. The number of distinct roots = the number of connected components.
class UnionFind {
  constructor(ids) {
    this.parent = new Map();
    this.rank = new Map();
    for (const id of ids) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }
  // Ensure an id exists in the structure (defensive: an edge may reference an id missing from nodes).
  add(id) {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }
  find(id) {
    // Iterative find with path compression to avoid recursion limits on long chains.
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = id;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra);
    const rankB = this.rank.get(rb);
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

/**
 * Compute structural metrics for the knowledge graph.
 * Edges are undirected for connectivity and degree.
 *
 * @returns {{
 *   nodeCount: number,
 *   edgeCount: number,                                  // count of unique undirected edges (self-loops/dupes removed)
 *   density: number,                                    // edges / (n*(n-1)/2), 0 when n<2
 *   avgDegree: number,                                  // 2*edgeCount / nodeCount, 0 when n===0
 *   degrees: Object<string, number>,                    // id -> undirected degree
 *   hubs: Array<{id:string,title:string,degree:number}>,   // top 10 by degree (desc), then id asc
 *   orphans: Array<{id:string,title:string}>,           // degree-0 nodes, capped at 50
 *   orphanCount: number,                                // total degree-0 nodes (uncapped)
 *   components: { count:number, largest:number[] },     // component count + largest few sizes (desc)
 * }}
 */
export function graphMetrics() {
  const { nodes, edges } = getGraph();

  const nodeList = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];

  const nodeCount = nodeList.length;

  // title lookup for enriching hubs/orphans output.
  const titleById = new Map();
  for (const n of nodeList) titleById.set(n.id, n.title);

  // Degree map seeded at 0 for every known node so orphans are detectable.
  const degrees = new Map();
  for (const n of nodeList) degrees.set(n.id, 0);

  // Adjacency set per node — also serves to dedupe parallel edges and drop self-loops, so the
  // undirected edge count and degrees are not inflated by repeated or reflexive links.
  const adjacency = new Map();
  const ensureAdj = id => {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    return adjacency.get(id);
  };
  for (const n of nodeList) ensureAdj(n.id);

  const uf = new UnionFind(degrees.keys());

  let edgeCount = 0;
  for (const e of edgeList) {
    const a = e.source;
    const b = e.target;
    if (a == null || b == null) continue; // skip malformed edges
    if (a === b) continue;                // ignore self-loops for undirected structure

    // Defensive: an edge endpoint might not be present in nodes (shouldn't happen with FK on,
    // but keep the computation robust). Register it everywhere so it counts consistently.
    if (!degrees.has(a)) { degrees.set(a, 0); titleById.set(a, titleById.get(a) ?? null); }
    if (!degrees.has(b)) { degrees.set(b, 0); titleById.set(b, titleById.get(b) ?? null); }
    uf.add(a); uf.add(b);

    const adjA = ensureAdj(a);
    if (adjA.has(b)) continue; // duplicate undirected edge — count once
    adjA.add(b);
    ensureAdj(b).add(a);

    degrees.set(a, degrees.get(a) + 1);
    degrees.set(b, degrees.get(b) + 1);
    uf.union(a, b);
    edgeCount++;
  }

  // Effective node total includes any stray edge-only ids we had to register above.
  const effectiveNodeCount = degrees.size;

  // density = actual undirected edges / possible undirected edges (n choose 2).
  const possible = effectiveNodeCount > 1
    ? (effectiveNodeCount * (effectiveNodeCount - 1)) / 2
    : 0;
  const density = possible > 0 ? edgeCount / possible : 0;

  const avgDegree = effectiveNodeCount > 0 ? (2 * edgeCount) / effectiveNodeCount : 0;

  // degrees as a plain object (id -> degree).
  const degreesObj = {};
  for (const [id, d] of degrees) degreesObj[id] = d;

  // hubs: top 10 by degree, tie-broken by id for stable output.
  const hubs = [...degrees.entries()]
    .sort((x, y) => (y[1] - x[1]) || String(x[0]).localeCompare(String(y[0])))
    .slice(0, 10)
    .map(([id, degree]) => ({ id, title: titleById.get(id) ?? null, degree }));

  // orphans: degree 0, capped at 50; orphanCount is the uncapped total.
  const allOrphans = [...degrees.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const orphanCount = allOrphans.length;
  const orphans = allOrphans
    .slice(0, 50)
    .map(id => ({ id, title: titleById.get(id) ?? null }));

  // connected components from union-find: bucket every node under its root, then size each bucket.
  const compSizes = new Map();
  for (const id of degrees.keys()) {
    const root = uf.find(id);
    compSizes.set(root, (compSizes.get(root) || 0) + 1);
  }
  const sizesDesc = [...compSizes.values()].sort((a, b) => b - a);
  const components = {
    count: sizesDesc.length,
    largest: sizesDesc.slice(0, 5),
  };

  return {
    nodeCount,
    edgeCount,
    density,
    avgDegree,
    degrees: degreesObj,
    hubs,
    orphans,
    orphanCount,
    components,
  };
}
