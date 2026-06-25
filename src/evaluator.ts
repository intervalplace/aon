import type { AonObject } from "./object.js";
import { getObject, getInboundObjects } from "./store.js";

export type AuthorizationEvaluation = {
  authorization: AonObject;

  reserves: AonObject[];
  proofs: AonObject[];
  fills: AonObject[];
  receipts: AonObject[];
  revocations: AonObject[];
  orders: AonObject[];

  inbound: AonObject[];
};

export function evaluateAuthorization(
  authorizationHash: string
): AuthorizationEvaluation | null {

  const authorization = getObject(authorizationHash);

  if (!authorization) {
    return null;
  }

  const inbound = getInboundObjects(authorizationHash);

  const reserves: AonObject[] = [];
  const proofs: AonObject[] = [];
  const fills: AonObject[] = [];
  const receipts: AonObject[] = [];
  const revocations: AonObject[] = [];
  const orders: AonObject[] = [];

  for (const obj of inbound) {

    switch (obj.objectType) {

      case "reserve":
        reserves.push(obj);
        break;

      case "proof":
        proofs.push(obj);
        break;

      case "fill":
        fills.push(obj);
        break;

      case "receipt":
        receipts.push(obj);
        break;

      case "revocation":
        revocations.push(obj);
        break;

      case "order":
        orders.push(obj);
        break;

    }

  }

  return {

    authorization,

    reserves,
    proofs,
    fills,
    receipts,
    revocations,
    orders,

    inbound

  };

}
