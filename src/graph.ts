import type { AonObject } from "./object.js";
import { getObject, getInboundObjects } from "./store.js";

export type ObjectGraph = {
  rootHash: string;
  objects: AonObject[];
  byHash: Record<string, AonObject>;
};

function lowerHash(hash: string) {
  return hash.toLowerCase();
}

export function walkInboundGraph(
  rootHash: string,
  opts?: {
    maxDepth?: number;
    maxObjects?: number;
  }
): ObjectGraph | null {
  const root = getObject(rootHash);
  if (!root) return null;

  const maxDepth = opts?.maxDepth ?? 8;
  const maxObjects = opts?.maxObjects ?? 1000;

  const seen = new Set<string>();
  const queue: Array<{ hash: string; depth: number }> = [
    { hash: lowerHash(rootHash), depth: 0 },
  ];

  const objects: AonObject[] = [];
  const byHash: Record<string, AonObject> = {};

  while (queue.length > 0) {
    if (objects.length >= maxObjects) {
      throw new Error("GRAPH_OBJECT_LIMIT_EXCEEDED");
    }

    const item = queue.shift()!;
    const h = lowerHash(item.hash);

    if (seen.has(h)) continue;
    seen.add(h);

    const obj = getObject(h);
    if (!obj) continue;

    objects.push(obj);
    byHash[h] = obj;

    if (item.depth >= maxDepth) continue;

    for (const child of getInboundObjects(h)) {
      if (!child.objectHash) continue;

      queue.push({
        hash: lowerHash(child.objectHash),
        depth: item.depth + 1,
      });
    }
  }

  return {
    rootHash: lowerHash(rootHash),
    objects,
    byHash,
  };
}
