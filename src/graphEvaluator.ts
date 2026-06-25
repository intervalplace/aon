import { getObject } from "./store.js";
import {
  type AuthorizationGraph,
  markCandidateStatus,
  saveGraphState,
} from "./graphState.js";

function lower(x: string) {
  return x.toLowerCase();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isTimeActive(obj: any) {
  const a =
    obj.payload?.authorization ??
    obj.payload?.order ??
    {};

  const validAfter = Number(a.validAfter ?? 0);
  const validBefore = Number(a.validBefore ?? 0);
  const now = nowSec();

  if (Number.isFinite(validAfter) && validAfter > 0 && now < validAfter) {
    return { ok: false, reason: "NOT_YET_ACTIVE" };
  }

  if (Number.isFinite(validBefore) && validBefore > 0 && now > validBefore) {
    return { ok: false, reason: "EXPIRED" };
  }

  return { ok: true };
}

function hasReceiptForCandidate(graph: AuthorizationGraph, candidateHash: string) {
  const h = lower(candidateHash);

  return graph.receiptCandidates.some((r) => {
    const receipt = getObject(r.objectHash);
    if (!receipt) return false;

    return receipt.references
      .map((x) => x.toLowerCase())
      .includes(h);
  });
}

function evaluateEvmSpotFill(graph: AuthorizationGraph, fillHash: string) {
  const fill = getObject(fillHash);
  if (!fill) return { status: "invalid" as const, reason: "FILL_NOT_FOUND" };

  const refs = fill.references.map((x) => x.toLowerCase());

  const makerAuth = getObject(refs[0]);
  const takerAuth = getObject(refs[1]);
  const makerOrder = getObject(refs[2]);
  const takerOrder = getObject(refs[3]);

  if (!makerAuth || !takerAuth) {
    return { status: "waiting" as const, reason: "AUTHORIZATION_MISSING" };
  }

  if (!makerOrder || !takerOrder) {
    return { status: "waiting" as const, reason: "ORDER_MISSING" };
  }

  if (makerAuth.objectType !== "authorization") {
    return { status: "invalid" as const, reason: "INVALID_MAKER_AUTH_OBJECT" };
  }

  if (takerAuth.objectType !== "authorization") {
    return { status: "invalid" as const, reason: "INVALID_TAKER_AUTH_OBJECT" };
  }

  if (makerOrder.objectType !== "order") {
    return { status: "invalid" as const, reason: "INVALID_MAKER_ORDER_OBJECT" };
  }

  if (takerOrder.objectType !== "order") {
    return { status: "invalid" as const, reason: "INVALID_TAKER_ORDER_OBJECT" };
  }

  for (const obj of [makerAuth, takerAuth, makerOrder, takerOrder]) {
    const active = isTimeActive(obj);
    if (!active.ok) return { status: "expired" as const, reason: active.reason };
  }

  if (hasReceiptForCandidate(graph, fillHash)) {
    return { status: "consumed" as const, reason: "RECEIPT_EXISTS" };
  }

  const maker = makerOrder.payload?.order;
  const taker = takerOrder.payload?.order;
  const f = fill.payload?.fill;

  if (!maker || !taker || !f) {
    return { status: "invalid" as const, reason: "MISSING_ORDER_OR_FILL_PAYLOAD" };
  }

  if (maker.marketId?.toLowerCase?.() !== taker.marketId?.toLowerCase?.()) {
    return { status: "invalid" as const, reason: "MARKET_MISMATCH" };
  }

  if (maker.marketId?.toLowerCase?.() !== f.makerOrderHash && false) {
    // reserved for stricter future checks
  }

  if (Number(maker.side) === Number(taker.side)) {
    return { status: "invalid" as const, reason: "SAME_SIDE" };
  }

  const fillBase = BigInt(f.baseAmount ?? "0");
  const makerBase = BigInt(maker.baseAmount ?? "0");
  const takerBase = BigInt(taker.baseAmount ?? "0");

  if (fillBase <= 0n) {
    return { status: "invalid" as const, reason: "ZERO_FILL" };
  }

  if (fillBase > makerBase || fillBase > takerBase) {
    return { status: "invalid" as const, reason: "FILL_EXCEEDS_ORDER" };
  }

  return { status: "executable" as const, reason: "EVM_SPOT_FILL_EXECUTABLE" };
}

function evaluateCsdProof(graph: AuthorizationGraph, proofHash: string) {
  const proof = getObject(proofHash);
  if (!proof) return { status: "invalid" as const, reason: "PROOF_NOT_FOUND" };

  if (hasReceiptForCandidate(graph, proofHash)) {
    return { status: "consumed" as const, reason: "RECEIPT_EXISTS" };
  }

  if (!graph.reserve) {
    return { status: "waiting" as const, reason: "RESERVE_MISSING" };
  }

  const auth = getObject(graph.authorization);
  const reserve = getObject(graph.reserve);

  if (!auth) return { status: "waiting" as const, reason: "AUTHORIZATION_MISSING" };
  if (!reserve) return { status: "waiting" as const, reason: "RESERVE_MISSING" };

  const active = isTimeActive(auth);
  if (!active.ok) return { status: "expired" as const, reason: active.reason };

  return { status: "candidate" as const, reason: "CSD_PROOF_AWAITS_NAMESPACE_EVALUATION" };
}

export async function evaluateAuthorizationGraph(graph: AuthorizationGraph) {
  for (const candidate of graph.proofCandidates) {
    const result = evaluateCsdProof(graph, candidate.objectHash);

    markCandidateStatus({
      authorizationHash: graph.authorization,
      candidateHash: candidate.objectHash,
      status: result.status,
      reason: result.reason,
    });
  }

  for (const candidate of graph.fillCandidates) {
    const result =
      graph.namespace === "aon:evm-spot"
        ? evaluateEvmSpotFill(graph, candidate.objectHash)
        : { status: "candidate" as const, reason: "NO_FILL_EVALUATOR_FOR_NAMESPACE" };

    markCandidateStatus({
      authorizationHash: graph.authorization,
      candidateHash: candidate.objectHash,
      status: result.status,
      reason: result.reason,
    });
  }

  await saveGraphState();
}

export async function evaluateGraphs(graphs: AuthorizationGraph[]) {
  for (const graph of graphs) {
    await evaluateAuthorizationGraph(graph);
  }
}
