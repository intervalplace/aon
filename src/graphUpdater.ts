import type { AonObject } from "./object.js";
import { getObject, getInboundObjects } from "./store.js";
import {
  ensureAuthorizationGraph,
  setGraphReserve,
  addProofCandidate,
  addFillCandidate,
  addReceiptCandidate,
  markGraphRevoked,
  saveGraphState,
} from "./graphState.js";

function lower(x: string) {
  return x.toLowerCase();
}

function firstRef(obj: AonObject) {
  return obj.references?.[0]?.toLowerCase();
}

function namespaceOf(obj: AonObject) {
  return obj.namespace;
}

function authHashFromReserve(reserve: AonObject) {
  return firstRef(reserve);
}

function authHashFromProof(proof: AonObject) {
  const reserveHash = firstRef(proof);
  if (!reserveHash) return null;

  const reserve = getObject(reserveHash);
  if (!reserve || reserve.objectType !== "reserve") return null;

  return authHashFromReserve(reserve);
}

function authHashesFromFill(fill: AonObject) {
  const refs = fill.references ?? [];

  return {
    makerAuthorizationHash: refs[0]?.toLowerCase() ?? null,
    takerAuthorizationHash: refs[1]?.toLowerCase() ?? null,
  };
}

function authHashesFromReceipt(receipt: AonObject) {
  const refs = receipt.references ?? [];

  return refs
    .map((h) => getObject(h))
    .filter(Boolean)
    .flatMap((obj: any) => {
      if (obj.objectType === "authorization") return [obj.objectHash];

      if (obj.objectType === "reserve") {
        const h = authHashFromReserve(obj);
        return h ? [h] : [];
      }

      if (obj.objectType === "proof") {
        const h = authHashFromProof(obj);
        return h ? [h] : [];
      }

      if (obj.objectType === "fill") {
        const hashes = authHashesFromFill(obj);
        return [
          hashes.makerAuthorizationHash,
          hashes.takerAuthorizationHash,
        ].filter(Boolean);
      }

      return [];
    })
    .map((h: string) => lower(h));
}

async function updateAuthorization(obj: AonObject) {
  if (!obj.objectHash) return;

  ensureAuthorizationGraph({
    authorizationHash: obj.objectHash,
    namespace: namespaceOf(obj),
  });
}

async function updateReserve(obj: AonObject) {
  if (!obj.objectHash) return;

  const authorizationHash = authHashFromReserve(obj);
  if (!authorizationHash) return;

  setGraphReserve({
    authorizationHash,
    namespace: namespaceOf(obj),
    reserveHash: obj.objectHash,
  });
}

async function updateProof(obj: AonObject) {
  if (!obj.objectHash) return;

  const authorizationHash = authHashFromProof(obj);
  if (!authorizationHash) return;

  addProofCandidate({
    authorizationHash,
    namespace: namespaceOf(obj),
    proofHash: obj.objectHash,
    status: "candidate",
  });
}

async function updateFill(obj: AonObject) {
  if (!obj.objectHash) return;

  const hashes = authHashesFromFill(obj);

  if (hashes.makerAuthorizationHash) {
    addFillCandidate({
      authorizationHash: hashes.makerAuthorizationHash,
      namespace: namespaceOf(obj),
      fillHash: obj.objectHash,
      status: "candidate",
      reason: "MAKER_SIDE",
    });
  }

  if (hashes.takerAuthorizationHash) {
    addFillCandidate({
      authorizationHash: hashes.takerAuthorizationHash,
      namespace: namespaceOf(obj),
      fillHash: obj.objectHash,
      status: "candidate",
      reason: "TAKER_SIDE",
    });
  }
}

async function updateReceipt(obj: AonObject) {
  if (!obj.objectHash) return;

  const authHashes = [...new Set(authHashesFromReceipt(obj))];

  for (const authorizationHash of authHashes) {
    addReceiptCandidate({
      authorizationHash,
      namespace: namespaceOf(obj),
      receiptHash: obj.objectHash,
      status: "consumed",
    });
  }
}

async function updateRevocation(obj: AonObject) {
  const targetHash =
    obj.payload?.targetHash?.toLowerCase?.() ??
    firstRef(obj);

  if (!targetHash) return;

  const target = getObject(targetHash);
  if (!target) return;

  if (target.objectType === "authorization") {
    markGraphRevoked(targetHash);
  }
}

export async function updateGraph(obj: AonObject) {
  switch (obj.objectType) {
    case "authorization":
      await updateAuthorization(obj);
      break;

    case "reserve":
      await updateReserve(obj);
      break;

    case "proof":
      await updateProof(obj);
      break;

    case "fill":
      await updateFill(obj);
      break;

    case "receipt":
      await updateReceipt(obj);
      break;

    case "revocation":
      await updateRevocation(obj);
      break;

    default:
      break;
  }

  await saveGraphState();
}
