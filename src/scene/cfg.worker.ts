// Sugiyama layout for control-flow graphs, off the main thread.
import dagre from '@dagrejs/dagre';

export interface LayoutReq {
  nodes: { id: string; w: number; h: number }[];
  edges: { v: string; w: string; name: string; weight: number }[];
}
export interface LayoutRes {
  nodes: Record<string, { x: number; y: number }>;
  edges: Record<string, { x: number; y: number }[]>;
  width: number;
  height: number;
  ms: number;
}

self.onmessage = (ev: MessageEvent<LayoutReq>) => {
  const t0 = performance.now();
  const { nodes, edges } = ev.data;
  const g = new dagre.graphlib.Graph({ multigraph: true, directed: true });
  g.setGraph({ rankdir: 'TB', nodesep: 3.2, ranksep: 5.5, edgesep: 1.2, marginx: 2, marginy: 2, ranker: nodes.length > 400 ? 'tight-tree' : 'network-simplex' });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.w, height: n.h });
  for (const e of edges) g.setEdge(e.v, e.w, { weight: e.weight, minlen: 1 }, e.name);
  dagre.layout(g);
  const res: LayoutRes = { nodes: {}, edges: {}, width: g.graph().width ?? 0, height: g.graph().height ?? 0, ms: 0 };
  for (const id of g.nodes()) {
    const n = g.node(id);
    res.nodes[id] = { x: n.x, y: n.y };
  }
  for (const e of g.edges()) {
    const d = g.edge(e);
    if (e.name) res.edges[e.name] = (d.points ?? []).map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }));
  }
  res.ms = performance.now() - t0;
  (self as unknown as Worker).postMessage(res);
};
