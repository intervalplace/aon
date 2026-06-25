import type { AonObject } from "./object.js";
import { walkInboundGraph, partitionGraphObjects, type ObjectGraph } from "./graph.js";

export type AuthorizationEvaluation = {
  authorization: AonObject;
  graph: ObjectGraph;

  authorizations: AonObject[];
  reserves: AonObject[];
  proofs: AonObject[];
  fills: AonObject[];
  receipts: AonObject[];
  revocations: AonObject[];
  orders: AonObject[];
};

export function evaluateAuthorization(
  authorizationHash: string
): AuthorizationEvaluation | null {
  const graph = walkInboundGraph(authorizationHash);

  if (!graph) return null;

  const authorization = graph.byHash[authorizationHash.toLowerCase()];

  if (!authorization || authorization.objectType !== "authorization") {
    return null;
  }

  const parts = partitionGraphObjects(graph.objects);

  return {
    authorization,
    graph,
    ...parts,
  };
}
