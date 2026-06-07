import { AonObject } from "./object.js";

export function getInboundReferences(objects: AonObject[], targetHash: string) {
  const t = targetHash.toLowerCase();

  return objects.filter((obj) =>
    obj.references.map((r) => r.toLowerCase()).includes(t)
  );
}

export function getGraph(objects: AonObject[], rootHash: string) {
  const byHash = new Map(
    objects
      .filter((o) => o.objectHash)
      .map((o) => [o.objectHash!.toLowerCase(), o])
  );

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
    const h = hash.toLowerCase();
    if (seen.has(h)) return;
    seen.add(h);

    const obj = byHash.get(h);
    if (!obj?.objectHash) return;

    nodes.push(obj);

    for (const ref of obj.references ?? []) {
      addEdge(obj.objectHash, ref);
      visit(ref);
    }

    for (const inbound of objects) {
      if (!inbound.objectHash) continue;

      if ((inbound.references ?? []).map((r) => r.toLowerCase()).includes(h)) {
        addEdge(inbound.objectHash, obj.objectHash);
        visit(inbound.objectHash);
      }
    }
  }

  visit(rootHash);

  return { rootHash, nodes, edges };
}
