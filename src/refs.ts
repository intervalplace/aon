import { AonObject } from "./object.js";
import { getInboundObjects, getObject } from "./store.js";

export function getInboundReferences(_objects: AonObject[], targetHash: string) {
  return getInboundObjects(targetHash);
}

export function getGraph(
  rootHash: string,
  opts?: { maxObjects?: number }
) {
  const maxObjects = opts?.maxObjects ?? 1000;
  const seen = new Set<string>();
  const edgeSeen = new Set<string>();
  const nodes: AonObject[] = [];
  const edges: { from: string; to: string }[] = [];

  function addEdge(from: string, to: string) {
    const key = `${from.toLowerCase()}->${to.toLowerCase()}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to });
  }

  function visit(hash: string) {
    if (nodes.length >= maxObjects) return;
    const h = hash.toLowerCase();
    if (seen.has(h)) return;
    seen.add(h);

    const obj = getObject(h);
    if (!obj?.objectHash) return;

    nodes.push(obj);

    for (const ref of obj.references ?? []) {
      addEdge(obj.objectHash, ref);
      visit(ref);
    }

    for (const inbound of getInboundObjects(h)) {
      if (!inbound.objectHash) continue;
      addEdge(inbound.objectHash, obj.objectHash);
      visit(inbound.objectHash);
    }
  }

  visit(rootHash);

  return { rootHash, nodes, edges };
}
