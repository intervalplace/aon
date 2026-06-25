//server.ts

import "./polyfills.js";
import { getAddress, verifyTypedData, type Hex } from "viem";
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadStore, putObject, getObject, listObjects } from "./store.js";
import { getInboundReferences, getGraph } from "./refs.js";
import { findExecutableGraphs } from "./executable.js";
import type { AonObject } from "./object.js";
import { findExecutableEvmSpotGraphs } from "./executableEvmSpot.js";
import { makeCsdPaymentProofObject } from "./proofs/csdFromTxid.js";
import {
  announceObject,
  dialPeer,
  getP2pInfo,
  requestObjectFromPeer,
  startP2p,
getPubsubInfo,
exchangePeersWith,
} from "./p2p.js";
import {
  lockCsdUsdcOnEvm,
  refundExpiredCsdUsdcLockOnEvm,
} from "./executors/evmCsdUsdcSettlement.js";
import {
  getNamespaceAdapter,
  listNamespaceAdapters,
} from "./namespaces/index.js";

import {
    getIndex,
} from "./index.js";

const app = Fastify({ logger: true });

function nowMs() {
  return Date.now();
}

function requireHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) {
    throw new Error(code);
  }
  return x as Hex;
}

function graphNamespace(graph: any) {
  return (
    graph.authorization?.namespace ??
    graph.makerAuthorization?.namespace ??
    graph.namespace
  );
}

function enrichExecutableGraph(graph: any) {
  const adapter = getNamespaceAdapter(graphNamespace(graph));

  return {
    ...graph,
    reward: adapter.reward(graph),
  };
}

function graphPrimaryAuthorization(graph: any) {
  return (
    graph.authorization ??
    graph.makerAuthorization ??
    graph.takerAuthorization
  );
}

function isAuthorizationTimeActive(auth: any) {
  const a = auth.payload?.authorization;
  if (!a) return false;

  const now = Math.floor(Date.now() / 1000);
  const validAfter = Number(a.validAfter ?? 0);
  const validBefore = Number(a.validBefore ?? 0);

  if (Number.isFinite(validAfter) && now < validAfter) return false;
  if (Number.isFinite(validBefore) && validBefore > 0 && now > validBefore) return false;

  return true;
}


function revocationsForTarget(targetHash: string) {
  const h = targetHash.toLowerCase();

  return listObjects({ objectType: "revocation" }).filter((r: any) => {
    const refs = objectRefsLower(r);
    return (
      refs.includes(h) ||
      r.payload?.targetHash?.toLowerCase?.() === h
    );
  });
}

function isLocallyRevoked(targetHash: string) {
  return revocationsForTarget(targetHash).length > 0;
}

function isAuthorizationActive(auth: any) {
  if (!auth?.objectHash) return false;
  if (!isAuthorizationTimeActive(auth)) return false;
  if (isLocallyRevoked(auth.objectHash)) return false;
  return true;
}

function receiptHasExistingReserve(receipt: any) {
  return objectRefsLower(receipt).some((h: string) => {
    const obj = getObject(h);
    return obj?.objectType === "reserve";
  });
}

function rewardAmount(graph: any) {
  return Number(graph.reward?.amount ?? 0);
}

function findExecutableByNamespace(namespace: string | undefined, includeCompleted = false) {
  if (namespace === "aon:evm-spot") {
    return findExecutableEvmSpotGraphs(listObjects(), { includeCompleted });
  }

  return findExecutableGraphs(listObjects(), {
    namespace,
    includeCompleted,
  });
}

function isGraphConsumable(graph: any) {
  const auth = graph.authorization;
  const reserve = graph.reserve;
  const proof = graph.proof;

  if (!auth?.objectHash || !reserve?.objectHash || !proof?.objectHash) return false;

  const existingReceipts = listObjects({
    objectType: "receipt",
    namespace: auth.namespace,
  });

  const reserveHash = reserve.objectHash.toLowerCase();
  const proofTxid = proof.payload?.txid ?? proof.payload?.proof?.txid;

  const reserveAlreadyReceipted = existingReceipts.some((r: any) =>
    objectRefsLower(r).includes(reserveHash)
  );

  if (reserveAlreadyReceipted) return false;

if (isLocallyRevoked(auth.objectHash)) return false;

  const txidAlreadyReceipted = existingReceipts.some((r: any) =>
    r.payload?.verification?.txid?.toLowerCase?.() === proofTxid?.toLowerCase?.()
  );

  if (proofTxid && txidAlreadyReceipted) return false;

  return true;
}

function normalizeCsdUsdcAuthorization(auth: any) {
  return {
    buyer: getAddress(auth.buyer),
    sellerUsdcRecipient: getAddress(auth.sellerUsdcRecipient),
    sellerCsdScriptHash: requireHex(auth.sellerCsdScriptHash, "INVALID_SELLER_CSD_SCRIPT_HASH"),
    csdGenesisHash: requireHex(auth.csdGenesisHash, "INVALID_CSD_GENESIS_HASH"),
    tradeIntentHash: requireHex(auth.tradeIntentHash, "INVALID_TRADE_INTENT_HASH"),
    csdAmount: String(auth.csdAmount),
    usdc: getAddress(auth.usdc),
    usdcAmount: String(auth.usdcAmount),
    minConfirmations: String(auth.minConfirmations),
    executorFeeAmount: String(auth.executorFeeAmount ?? "0"),
    validAfter: String(auth.validAfter),
    validBefore: String(auth.validBefore),
    nonce: requireHex(auth.nonce, "INVALID_NONCE"),
  };
}

function csdUsdcTypes() {
  return {
    CsdUsdcAuthorization: [
      { name: "buyer", type: "address" },
      { name: "sellerUsdcRecipient", type: "address" },
      { name: "sellerCsdScriptHash", type: "bytes32" },
      { name: "csdGenesisHash", type: "bytes32" },
      { name: "tradeIntentHash", type: "bytes32" },
      { name: "csdAmount", type: "uint256" },
      { name: "usdc", type: "address" },
      { name: "usdcAmount", type: "uint256" },
      { name: "minConfirmations", type: "uint256" },
      { name: "executorFeeAmount", type: "uint256" },
      { name: "validAfter", type: "uint64" },
      { name: "validBefore", type: "uint64" },
      { name: "nonce", type: "bytes32" },
    ],
  };
}

function evmSpotOrderTypes() {
  return {
    SignedOrder: [
      { name: "trader", type: "address" },
      { name: "marketId", type: "bytes32" },
      { name: "side", type: "uint8" },
      { name: "price", type: "uint256" },
      { name: "baseAmount", type: "uint256" },
      { name: "orderNonce", type: "bytes32" },
      { name: "sessionAuthHash", type: "bytes32" },
      { name: "validAfter", type: "uint64" },
      { name: "validBefore", type: "uint64" },
    ],
  };
}

function revocationTypes() {
  return {
    AonRevocation: [
      { name: "targetHash", type: "bytes32" },
      { name: "targetType", type: "string" },
      { name: "reason", type: "string" },
      { name: "nonce", type: "bytes32" },
    ],
  };
}

async function requireValidTypedSignature(args: {
  domain: any;
  types: any;
  primaryType: string;
  message: any;
  signature: any;
  expectedSigner: string;
  code: string;
}) {
  const signature = requireHex(args.signature, "INVALID_SIGNATURE");

  const ok = await verifyTypedData({
    address: getAddress(args.expectedSigner),
    domain: args.domain,
    types: args.types,
    primaryType: args.primaryType as any,
    message: args.message,
    signature,
  } as any);

  if (!ok) throw new Error(args.code);
}


function lowerHash(x: any, code: string) {
  if (typeof x !== "string" || !x.startsWith("0x")) {
    throw new Error(code);
  }
  return x.toLowerCase();
}

function objectRefsLower(obj: any) {
  return (obj.references ?? []).map((x: string) => x.toLowerCase());
}

function latestFirst(a: any, b: any) {
  return Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0);
}

function hasReceiptReferencing(hash: string) {
  const h = hash.toLowerCase();

  return listObjects({ objectType: "receipt" }).some((r: any) =>
    objectRefsLower(r).includes(h)
  );
}

function hasReserveForAuthorization(authHash: string) {
  const h = authHash.toLowerCase();

  return listObjects({ objectType: "reserve" }).some((r: any) =>
    objectRefsLower(r).includes(h)
  );
}

function hasProofForReserve(reserveHash: string) {
  const h = reserveHash.toLowerCase();

  return listObjects({ objectType: "proof" }).some((p: any) =>
    objectRefsLower(p).includes(h)
  );
}

function summarizeAuth(auth: any) {
  const adapter = getNamespaceAdapter(auth.namespace);
  return adapter.summarizeAuthorization(auth);
}

async function consumeGraph(
  graph: any,
  args?: {
    creator?: string;
    summary?: string | null;
    mode?: string;
  }
) {

  const namespace =
    graph.authorization?.namespace ??
    graph.makerAuthorization?.namespace ??
    graph.namespace;

  const adapter = getNamespaceAdapter(namespace);

  const verification =
    adapter.verify(graph);

  const action =
    await adapter.execute({
      ...graph,
      mode:
        args?.mode ??
        process.env.AON_EXECUTOR_MODE ??
        "simulate",
    });

  const refs =
    [
      graph.authorization?.objectHash,
      graph.reserve?.objectHash,
      graph.proof?.objectHash,

      graph.makerAuthorization?.objectHash,
      graph.takerAuthorization?.objectHash,
      graph.makerOrder?.objectHash,
      graph.takerOrder?.objectHash,
      graph.fill?.objectHash,
    ].filter(Boolean);

  const receipt: AonObject = {
    objectType: "receipt",
    schemaVersion: "1",
    namespace,
    createdAt: Date.now(),
    creator:
      args?.creator ??
      "aon-executor-v0",
    references: refs,
    payload: {
      receiptType:
        "authorized_state_transition_completed",
      result: action.result,
      executionTx:
        action.executionTx ?? null,
      summary:
        args?.summary ?? null,
      verification,
      executor: {
        mode: action.mode,
        executed: action.executed,
      },
    },
  };

  const saved =
    await putObject(receipt);

  await announceObject(saved);

  return {
    receipt: saved,
    verification,
    action,
  };
}

await app.register(cors, { origin: true });
await loadStore();

const { loadGraphState } = await import("./graphState.js");
await loadGraphState();

await startP2p();


app.get("/v1/health", async () => ({
  ok: true,
  service: "aon-node-v0",
}));

app.get("/v1/p2p/pubsub", async () => {
  return {
    ok: true,
    pubsub: getPubsubInfo(),
  };
});

app.post("/v1/objects", async (req, reply) => {
  try {
    const obj = await putObject(req.body as any);
    const objectHash = (obj as any).objectHash ?? (obj as any).hash;

    if (!objectHash) {
      return reply.code(500).send({
        ok: false,
        error: { code: "OBJECT_HASH_MISSING" },
        object: obj,
      });
    }

    await announceObject(obj);

    return {
      ok: true,
      objectHash,
      object: obj,
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: {
        code: err?.message ?? "OBJECT_REJECTED",
      },
    });
  }
});

app.get("/v1/objects/:hash", async (req, reply) => {
  const hash = (req.params as any).hash;
  const obj = getObject(hash);

  if (!obj) {
    return reply.code(404).send({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });
  }

  return { ok: true, object: obj };
});

app.get("/v1/objects", async (req) => {
  const q = req.query as any;

  return {
    ok: true,
    objects: listObjects({
      objectType: q.objectType,
      namespace: q.namespace,
      references: q.references,
    }),
  };
});

const port = Number(process.env.AON_PORT ?? 8787);

app.get("/v1/objects/:hash/references", async (req) => {
  const hash = (req.params as any).hash;
  const objects = listObjects();

  return {
    ok: true,
    target: hash,
    inbound: getInboundReferences(objects, hash),
  };
});

app.get("/v1/graphs/:hash", async (req) => {
  const hash = (req.params as any).hash;
  const objects = listObjects();

  return {
    ok: true,
    graph: getGraph(objects, hash),
  };
});

app.get("/v1/executable", async (req) => {
  const q = req.query as any;

  const executable = findExecutableByNamespace(
    q.namespace,
    q.includeCompleted === "true"
  )
    .filter((x: any) => {
      if (x.status !== "executable" && q.includeCompleted !== "true") return false;

      const auth = graphPrimaryAuthorization(x);
      return !auth?.objectHash || !isLocallyRevoked(auth.objectHash);
    })
    .map(enrichExecutableGraph);

  return {
    ok: true,
    executable,
  };
});


app.get("/v1/graph-state", async (req) => {
  const q = req.query as any;
  const { listAuthorizationGraphs } = await import("./graphState.js");

  return {
    ok: true,
    graphs: listAuthorizationGraphs({
      namespace: q.namespace,
      status: q.status,
    }),
  };
});

app.get("/v1/graph-state/:authorizationHash", async (req, reply) => {
  const { authorizationHash } = req.params as any;
  const { getAuthorizationGraph } = await import("./graphState.js");

  const graph = getAuthorizationGraph(authorizationHash);

  if (!graph) {
    return reply.code(404).send({
      ok: false,
      error: { code: "GRAPH_NOT_FOUND" },
    });
  }

  return {
    ok: true,
    graph,
  };
});

app.post("/v1/graph-state/evaluate", async (req) => {
  const q = req.query as any;

  const { listAuthorizationGraphs } = await import("./graphState.js");
  const { evaluateGraphs } = await import("./graphEvaluator.js");

  const graphs = listAuthorizationGraphs({
    namespace: q.namespace,
  });

  await evaluateGraphs(graphs);

  return {
    ok: true,
    evaluated: graphs.length,
  };
});

app.get("/v1/authorizations/open", async (req) => {

  const q = req.query as any;

  const authorizations = listObjects({
    objectType: "authorization",
    namespace: q.namespace,
  })
    .filter((a: any) => a.payload?.authorizationType === "csd_usdc_release")
    .filter((a: any) => !hasReserveForAuthorization(a.objectHash))
.filter((a: any) => isAuthorizationActive(a))
    .sort(latestFirst)
    .map(summarizeAuth);

  return {
    ok: true,
    count: authorizations.length,
    authorizations,
  };
});

app.get("/v1/reserves/open", async (req) => {
  const q = req.query as any;

  const reserves = listObjects({
    objectType: "reserve",
    namespace: q.namespace,
  })
    .filter((r: any) => !hasReceiptReferencing(r.objectHash))
    .sort(latestFirst);

  return {
    ok: true,
    count: reserves.length,
    reserves,
  };
});

app.get("/v1/executable/open", async (req) => {
  const q = req.query as any;

  const executable = findExecutableByNamespace(q.namespace, false)
    .filter((x: any) => x.status === "executable")
.filter((x: any) => {
  const auth = graphPrimaryAuthorization(x);
  return auth && !isLocallyRevoked(auth.objectHash);
})
    .map(enrichExecutableGraph)
    .sort((a: any, b: any) => rewardAmount(b) - rewardAmount(a));

  return {
    ok: true,
    count: executable.length,
    executable,
  };
});

app.get("/v1/receipts", async (req) => {
  const q = req.query as any;

  let receipts = listObjects({
    objectType: "receipt",
    namespace: q.namespace,
  }).sort(latestFirst);

  if (q.current === "true") {
    receipts = receipts.filter(receiptHasExistingReserve);
  }

  return {
    ok: true,
    count: receipts.length,
    receipts,
  };
});

app.get("/v1/receipts/by-reserve/:reserveHash", async (req) => {
  const reserveHash = ((req.params as any).reserveHash as string).toLowerCase();

  const receipts = listObjects({
    objectType: "receipt",
  }).filter((r: any) =>
    r.references?.map((x: string) => x.toLowerCase()).includes(reserveHash)
  );

  return {
    ok: true,
    reserveHash,
    receipts,
  };
});

app.get(
    "/v1/index",
    async () => {

        return {

            ok: true,

            index: getIndex(),

        };

    }
);

app.get("/v1/receipts/by-proof/:proofHash", async (req) => {
  const proofHash = ((req.params as any).proofHash as string).toLowerCase();

  const receipts = listObjects({
    objectType: "receipt",
  }).filter((r: any) =>
    r.references?.map((x: string) => x.toLowerCase()).includes(proofHash)
  );

  return {
    ok: true,
    proofHash,
    receipts,
  };
});

app.get("/v1/receipts/by-txid/:txid", async (req) => {
  const txid = ((req.params as any).txid as string).toLowerCase();

  const receipts = listObjects({
    objectType: "receipt",
  }).filter((r: any) =>
    r.payload?.verification?.txid?.toLowerCase?.() === txid
  );

  return {
    ok: true,
    txid,
    receipts,
  };
});


app.get("/v1/receipts/canonical/by-reserve/:reserveHash", async (req) => {
  const reserveHash = ((req.params as any).reserveHash as string).toLowerCase();

  const receipts = listObjects({
    objectType: "receipt",
  })
    .filter((r: any) =>
      r.references?.map((x: string) => x.toLowerCase()).includes(reserveHash)
    )
    .sort((a: any, b: any) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));

  return {
    ok: true,
    reserveHash,
    canonical: receipts[0] ?? null,
    duplicateCount: Math.max(0, receipts.length - 1),
    allReceiptHashes: receipts.map((r: any) => r.objectHash),
  };
});

app.get("/v1/receipts/canonical/by-txid/:txid", async (req) => {
  const txid = ((req.params as any).txid as string).toLowerCase();

  const receipts = listObjects({
    objectType: "receipt",
  })
    .filter((r: any) =>
      r.payload?.verification?.txid?.toLowerCase?.() === txid
    )
    .sort((a: any, b: any) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));

  return {
    ok: true,
    txid,
    canonical: receipts[0] ?? null,
    duplicateCount: Math.max(0, receipts.length - 1),
    allReceiptHashes: receipts.map((r: any) => r.objectHash),
  };
});

app.post("/v1/proofs/csd/from-txid", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.reserveHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_RESERVE_HASH" },
      });
    }

    if (!body.txid) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_TXID" },
      });
    }

    const obj = await makeCsdPaymentProofObject({
      reserveHash: body.reserveHash,
      txid: body.txid,
      expectedRecipientScriptPubKey: body.expectedRecipientScriptPubKey,
      expectedAmount: body.expectedAmount,
      minConfirmations: body.minConfirmations,
      expectedIntentHash: body.expectedIntentHash,
    });


const saved = await putObject(obj);
const objectHash = (saved as any).objectHash ?? (saved as any).hash;

if (!objectHash) {
  return reply.code(500).send({
    ok: false,
    error: { code: "PROOF_OBJECT_HASH_MISSING" },
    object: saved,
  });
}

await announceObject(saved);

return {
  ok: true,
  objectHash,
  object: saved,
};
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: {
        code: err?.message ?? "CSD_PROOF_FROM_TXID_FAILED",
      },
    });
  }
});

app.get("/v1/namespaces", async () => {
  const manifests = listObjects({
    objectType: "namespace_manifest",
  }).sort(latestFirst);

  return {
    ok: true,
    count: manifests.length,
    manifests,
    adapters: listNamespaceAdapters().map((a) => ({
      namespace: a.namespace,
      authorizationType: a.authorizationType,
      reserveType: a.reserveType,
      proofType: a.proofType,
    })),
  };
});


app.get("/v1/p2p/info", async () => {
  return {
    ok: true,
    p2p: getP2pInfo(),
  };
});

app.post("/v1/p2p/dial", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.addr) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_MULTIADDR" },
      });
    }

    const p2p = await dialPeer(body.addr);

    return {
      ok: true,
      p2p,
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "P2P_DIAL_FAILED" },
    });
  }
});


app.post("/v1/p2p/request-object", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.peerId) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_PEER_ID" },
      });
    }

    if (!body.objectHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_OBJECT_HASH" },
      });
    }

    const object = await requestObjectFromPeer(body.peerId, body.objectHash);

    return {
      ok: true,
      objectHash: object.objectHash,
      object,
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "P2P_REQUEST_OBJECT_FAILED" },
    });
  }
});

app.post("/v1/p2p/gossip/:objectHash", async (req, reply) => {
  try {
    const objectHash = (req.params as any).objectHash as string;
    const obj = getObject(objectHash);

    if (!obj) {
      return reply.code(404).send({
        ok: false,
        error: { code: "OBJECT_NOT_FOUND" },
      });
    }

    await announceObject(obj);

    return {
      ok: true,
      objectHash,
      status: "announced",
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "GOSSIP_FAILED" },
    });
  }
});

app.post("/v1/p2p/push/:objectHash", async (req, reply) => {
  try {
    const objectHash = (req.params as any).objectHash as string;
    const obj = getObject(objectHash);

    if (!obj) {
      return reply.code(404).send({
        ok: false,
        error: { code: "OBJECT_NOT_FOUND" },
      });
    }

    await announceObject(obj);

    return {
      ok: true,
      objectHash,
      status: "push_attempted",
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "PUSH_FAILED" },
    });
  }
});

app.post("/v1/authorizations/csd-usdc/from-signed-auth", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.authorization) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_AUTHORIZATION" },
      });
    }

    if (!body.signature) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_SIGNATURE" },
      });
    }

    if (!body.domain) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_EIP712_DOMAIN" },
      });
    }

    const authorization = normalizeCsdUsdcAuthorization(body.authorization);
    const signer = getAddress(body.signer ?? authorization.buyer);

    if (signer.toLowerCase() !== authorization.buyer.toLowerCase()) {
      
      return reply.code(400).send({
        ok: false,
        error: { code: "SIGNER_BUYER_MISMATCH" },
      });
    }

    await requireValidTypedSignature({
  domain: body.domain,
  types: body.types ?? csdUsdcTypes(),
  primaryType: body.primaryType ?? "CsdUsdcAuthorization",
  message: authorization,
  signature: body.signature,
  expectedSigner: signer,
  code: "BAD_AUTHORIZATION_SIGNATURE",
});

    const validBefore = Number(authorization.validBefore);
    if (Number.isFinite(validBefore) && validBefore <= Math.floor(Date.now() / 1000)) {
      return reply.code(400).send({
        ok: false,
        error: { code: "AUTHORIZATION_EXPIRED" },
      });
    }

    const obj: AonObject & { signature: any } = {
      objectType: "authorization",
      schemaVersion: "1",
      namespace: body.namespace ?? "aon:csd-usdc",
      createdAt: body.createdAt ?? nowMs(),
      creator: signer,
      references: body.references ?? [],
      payload: {
        authorizationType: "csd_usdc_release",
        authorization,
        summary: body.summary ?? null,
      },
      signature: {
        scheme: "eip712",
        signer,
        domain: body.domain,
        types: body.types ?? csdUsdcTypes(),
        primaryType: body.primaryType ?? "CsdUsdcAuthorization",
        message: authorization,
        signature: body.signature,
      },
    } as any;


    const saved = await putObject(obj);
    await announceObject(saved);

    return {
      ok: true,
      objectHash: saved.objectHash,
      object: saved,
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: {
        code: err?.message ?? "CSD_USDC_AUTHORIZATION_REJECTED",
      },
    });
  }
});

app.post("/v1/orders/evm-spot/from-signed-order", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.authorizationHash) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_AUTHORIZATION_HASH" } });
    }

    if (!body.order) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_ORDER" } });
    }

    if (!body.signature) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_SIGNATURE" } });
    }

    const authorizationHash = String(body.authorizationHash).toLowerCase();
    const auth = getObject(authorizationHash);

    if (!auth) {
      return reply.code(404).send({ ok: false, error: { code: "AUTHORIZATION_OBJECT_NOT_FOUND" } });
    }

    if (auth.namespace !== "aon:evm-spot") {
      return reply.code(400).send({ ok: false, error: { code: "INVALID_AUTHORIZATION_NAMESPACE" } });
    }

    const order = {
      trader: getAddress(body.order.trader),
      marketId: requireHex(body.order.marketId, "INVALID_MARKET_ID"),
      side: Number(body.order.side),
      price: String(body.order.price),
      baseAmount: String(body.order.baseAmount),
      orderNonce: requireHex(body.order.orderNonce, "INVALID_ORDER_NONCE"),
      sessionAuthHash: requireHex(body.order.sessionAuthHash, "INVALID_SESSION_AUTH_HASH"),
      validAfter: String(body.order.validAfter),
      validBefore: String(body.order.validBefore),
    };

    if (order.sessionAuthHash.toLowerCase() !== authorizationHash) {
      return reply.code(400).send({ ok: false, error: { code: "ORDER_AUTH_HASH_MISMATCH" } });
    }

    const signer = getAddress(body.signer ?? order.trader);

    if (signer.toLowerCase() !== order.trader.toLowerCase()) {
      return reply.code(400).send({ ok: false, error: { code: "SIGNER_TRADER_MISMATCH" } });
    }

    await requireValidTypedSignature({
  domain: body.domain,
  types: body.types ?? evmSpotOrderTypes(),
  primaryType: body.primaryType ?? "SignedOrder",
  message: order,
  signature: body.signature,
  expectedSigner: signer,
  code: "BAD_ORDER_SIGNATURE",
});

    const obj: AonObject & { signature: any } = {
      objectType: "order",
      schemaVersion: "1",
      namespace: "aon:evm-spot",
      createdAt: body.createdAt ?? nowMs(),
      creator: signer,
      references: [authorizationHash],
      payload: {
        orderType: "evm_spot_order",
        order,
        summary: body.summary ?? null,
      },
      signature: {
        scheme: "eip712",
        signer,
        domain: body.domain,
        types: body.types ?? evmSpotOrderTypes(),
        primaryType: body.primaryType ?? "SignedOrder",
        message: order,
        signature: body.signature,
      },
    } as any;

    const saved = await putObject(obj);
    await announceObject(saved);

    return { ok: true, objectHash: saved.objectHash, object: saved };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "EVM_SPOT_ORDER_REJECTED" },
    });
  }
});

app.post("/v1/fills/evm-spot", async (req, reply) => {
  try {
    const body = req.body as any;

    for (const k of ["makerAuthorizationHash", "takerAuthorizationHash", "makerOrderHash", "takerOrderHash"]) {
      if (!body[k]) {
        return reply.code(400).send({ ok: false, error: { code: `MISSING_${k.toUpperCase()}` } });
      }
    }

    if (!body.fill) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_FILL" } });
    }

    const makerAuthorizationHash = String(body.makerAuthorizationHash).toLowerCase();
    const takerAuthorizationHash = String(body.takerAuthorizationHash).toLowerCase();
    const makerOrderHash = String(body.makerOrderHash).toLowerCase();
    const takerOrderHash = String(body.takerOrderHash).toLowerCase();

    const makerAuth = getObject(makerAuthorizationHash);
    const takerAuth = getObject(takerAuthorizationHash);
    const makerOrder = getObject(makerOrderHash);
    const takerOrder = getObject(takerOrderHash);

    if (!makerAuth || !takerAuth) {
      return reply.code(404).send({ ok: false, error: { code: "AUTHORIZATION_OBJECT_NOT_FOUND" } });
    }

    if (!makerOrder || !takerOrder) {
      return reply.code(404).send({ ok: false, error: { code: "ORDER_OBJECT_NOT_FOUND" } });
    }

    const fill = {
      makerOrderHash: requireHex(body.fill.makerOrderHash ?? makerOrderHash, "INVALID_MAKER_ORDER_HASH"),
      takerOrderHash: requireHex(body.fill.takerOrderHash ?? takerOrderHash, "INVALID_TAKER_ORDER_HASH"),
      makerAuthHash: requireHex(body.fill.makerAuthHash ?? makerAuthorizationHash, "INVALID_MAKER_AUTH_HASH"),
      takerAuthHash: requireHex(body.fill.takerAuthHash ?? takerAuthorizationHash, "INVALID_TAKER_AUTH_HASH"),
      price: String(body.fill.price),
      baseAmount: String(body.fill.baseAmount),
      quoteAmount: String(body.fill.quoteAmount),
      executorFeeQuoteAmount: String(body.fill.executorFeeQuoteAmount ?? "0"),
      fillNonce: requireHex(body.fill.fillNonce, "INVALID_FILL_NONCE"),
      settlementContract: body.fill.settlementContract,
    };

    const obj: AonObject = {
      objectType: "fill",
      schemaVersion: "1",
      namespace: "aon:evm-spot",
      createdAt: body.createdAt ?? nowMs(),
      creator: body.creator ?? "aon-matcher-v0",
      references: [
        makerAuthorizationHash,
        takerAuthorizationHash,
        makerOrderHash,
        takerOrderHash,
      ],
      payload: {
        fillType: "evm_spot_fill",
        fill,
        summary: body.summary ?? null,
      },
    };

    const saved = await putObject(obj);
    await announceObject(saved);

    return { ok: true, objectHash: saved.objectHash, object: saved };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "EVM_SPOT_FILL_REJECTED" },
    });
  }
});

app.get("/v1/executable/next", async (req) => {
  const q = req.query as any;

  const executable = findExecutableByNamespace(
    q.namespace ?? "aon:csd-usdc",
    false
  );

  const next =
    executable.find((x: any) => {
      if (x.status !== "executable") return false;

      const auth = graphPrimaryAuthorization(x);
      return auth && !isLocallyRevoked(auth.objectHash);
    }) ?? null;

  return {
    ok: true,
    namespace: q.namespace ?? null,
    next: next ? enrichExecutableGraph(next) : null,
  };
});

app.post("/v1/executor/consume", async (req, reply) => {
  try {
    const body = req.body as any;

    const namespace =
      body.namespace ?? "aon:csd-usdc";

const executable =
  findExecutableByNamespace(
    namespace,
    false
  );

const graph =
  body.auto === true
    ? executable.find(
        (x: any) =>
          x.status === "executable"
      )
    : executable.find(
        (x: any) => {

          if (
            namespace ===
            "aon:evm-spot"
          ) {
            return (
              x.fill?.objectHash ===
              body.fillHash
            );
          }

          return (
            x.proof?.objectHash ===
            body.proofHash
          );
        }
      );

if (!graph) {
  return reply.code(404).send({
    ok: false,
    error: {
      code:
        "NO_EXECUTABLE_GRAPH_AVAILABLE",
    },
  });
}

const result =
  await consumeGraph(
    graph,
    {
      creator:
        body.creator ??
        "aon-executor-v0",

      summary:
        body.summary ??
        "Consumed by executor",

      mode:
        body.mode ??
        process.env
          .AON_EXECUTOR_MODE ??
        "simulate",
    }
  );

return {
  ok: true,
  status: "consumed",
  objectHash:
    result.receipt.objectHash,
  receipt:
    result.receipt,
  verification:
    result.verification,
};
  } catch (err: any) {
    const code = err?.message ?? "EXECUTOR_CONSUME_FAILED";
    const status =
      code === "RESERVE_ALREADY_CONSUMED" || code === "PROOF_TXID_ALREADY_CONSUMED"
        ? 409
        : code === "OBJECT_NOT_FOUND" || code === "NO_EXECUTABLE_GRAPH_AVAILABLE"
          ? 404
          : 400;

    return reply.code(status).send({
      ok: false,
      error: { code },
    });
  }
});



app.post("/v1/reserves/csd-usdc/lock", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.authorizationHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_AUTHORIZATION_HASH" },
      });
    }

    const authorizationHash = String(body.authorizationHash).toLowerCase();
    const auth = getObject(authorizationHash);

    if (!auth) {
      return reply.code(404).send({
        ok: false,
        error: { code: "AUTHORIZATION_OBJECT_NOT_FOUND" },
      });
    }

    if (auth.objectType !== "authorization") {
      return reply.code(400).send({
        ok: false,
        error: { code: "INVALID_AUTHORIZATION_OBJECT" },
      });
    }

    if (auth.payload?.authorizationType !== "csd_usdc_release") {
      return reply.code(400).send({
        ok: false,
        error: { code: "UNSUPPORTED_AUTHORIZATION_TYPE" },
      });
    }

    const lock = await lockCsdUsdcOnEvm({
      authorization: auth,
    });

const reserveObject: AonObject = {
  objectType: "reserve",
      schemaVersion: "1",
      namespace: auth.namespace ?? "aon:csd-usdc",
      createdAt: Date.now(),
      creator: body.creator ?? "aon-executor-v0",
      references: [authorizationHash],
      payload: {
        proofType: "evm_usdc_lock",
        authorizationType: auth.payload.authorizationType,
        settlementContract: lock.settlementContract,
        lockTx: lock.lockTx,
        executor: lock.executor,
        buyer: lock.buyer,
        usdc: lock.usdc,
        lockedAmount: lock.usdcAmount,
executorFeeAmount: lock.executorFeeAmount,
lockedUntil: lock.lockedUntil,
        status: "locked",
        summary: body.summary ?? "USDC locked for CSD/USDC settlement",
      },
    };

    const saved = await putObject(reserveObject);
    await announceObject(saved);

return {
  ok: true,
  objectHash: saved.objectHash,
  reserve: saved,
  lock,
};
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: {
        code: err?.message ?? "CSD_USDC_LOCK_FAILED",
      },
    });
  }
});


app.post("/v1/p2p/exchange", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.peerId) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_PEER_ID" },
      });
    }

    const result = await exchangePeersWith(body.peerId);

    return {
      ok: true,
      result,
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "P2P_EXCHANGE_FAILED" },
    });
  }
});

app.post("/v1/reserves/csd-usdc/refund-expired", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.reserveHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_RESERVE_HASH" },
      });
    }

    const reserveHash = String(body.reserveHash).toLowerCase();
    const reserve = getObject(reserveHash);

    if (!reserve) {
      return reply.code(404).send({
        ok: false,
        error: { code: "RESERVE_OBJECT_NOT_FOUND" },
      });
    }

    if (reserve.objectType !== "reserve") {
      return reply.code(400).send({
        ok: false,
        error: { code: "INVALID_RESERVE_OBJECT" },
      });
    }

    if (hasReceiptReferencing(reserveHash)) {
      return reply.code(409).send({
        ok: false,
        error: { code: "RESERVE_ALREADY_RECEIPTED" },
      });
    }

    const authHash = objectRefsLower(reserve)[0];
    const auth = getObject(authHash);

    if (!auth) {
      return reply.code(404).send({
        ok: false,
        error: { code: "AUTHORIZATION_OBJECT_NOT_FOUND" },
      });
    }

    const refund = await refundExpiredCsdUsdcLockOnEvm({
      authorization: auth,
    });

    const refundReceipt: AonObject = {
      objectType: "receipt",
      schemaVersion: "1",
      namespace: auth.namespace,
      createdAt: Date.now(),
      creator: body.creator ?? "aon-refund-v0",
      references: [authHash, reserveHash],
      payload: {
        receiptType: "expired_lock_refunded",
        result: "refunded",
        executionTx: refund.refundTx,
        summary: body.summary ?? "Expired CSD/USDC reserve refunded to buyer",
        refund,
      },
    };

    const saved = await putObject(refundReceipt);
    await announceObject(saved);

    return {
      ok: true,
      status: "refunded",
      objectHash: saved.objectHash,
      receipt: saved,
      refund,
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: {
        code: err?.message ?? "CSD_USDC_REFUND_FAILED",
      },
    });
  }
});

app.get("/v1/reserves/expired", async (req) => {
  const q = req.query as any;
  const now = Math.floor(Date.now() / 1000);

  const reserves = listObjects({
    objectType: "reserve",
    namespace: q.namespace,
  })
    .filter((r: any) => !hasReceiptReferencing(r.objectHash))
    .filter((r: any) => {
      const lockedUntil = Number(r.payload?.lockedUntil ?? 0);
      return Number.isFinite(lockedUntil) && lockedUntil > 0 && lockedUntil < now;
    })
    .sort(latestFirst);

  return {
    ok: true,
    count: reserves.length,
    reserves,
  };
});


app.post("/v1/authorizations/evm-spot/from-signed-auth", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.authorization) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_AUTHORIZATION" } });
    }

    if (!body.signature) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_SIGNATURE" } });
    }

    if (!body.domain) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_EIP712_DOMAIN" } });
    }

    const adapter = getNamespaceAdapter("aon:evm-spot");
    const authorization = adapter.normalizeAuthorization(body.authorization);
    const signer = getAddress(body.signer ?? authorization.grantor);

    if (signer.toLowerCase() !== authorization.grantor.toLowerCase()) {
      return reply.code(400).send({ ok: false, error: { code: "SIGNER_GRANTOR_MISMATCH" } });
    }

    await requireValidTypedSignature({
  domain: body.domain,
  types: body.types ?? adapter.types(),
  primaryType: body.primaryType ?? "TradingSessionAuthorization",
  message: authorization,
  signature: body.signature,
  expectedSigner: signer,
  code: "BAD_AUTHORIZATION_SIGNATURE",
});

    const obj: AonObject & { signature: any } = {
      objectType: "authorization",
      schemaVersion: "1",
      namespace: body.namespace ?? "aon:evm-spot",
      createdAt: body.createdAt ?? nowMs(),
      creator: signer,
      references: body.references ?? [],
      payload: {
        authorizationType: "evm_spot_session",
        authorization,
        summary: body.summary ?? null,
      },
      signature: {
        scheme: "eip712",
        signer,
        domain: body.domain,
        types: body.types ?? adapter.types(),
        primaryType: body.primaryType ?? "TradingSessionAuthorization",
        message: authorization,
        signature: body.signature,
      },
    } as any;

    const saved = await putObject(obj);
    await announceObject(saved);

    return { ok: true, objectHash: saved.objectHash, object: saved };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "EVM_SPOT_AUTHORIZATION_REJECTED" },
    });
  }
});


app.post("/v1/revocations", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.targetHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_TARGET_HASH" },
      });
    }

    const targetHash = String(body.targetHash).toLowerCase();
    const target = getObject(targetHash);

    if (!target) {
      return reply.code(404).send({
        ok: false,
        error: { code: "TARGET_OBJECT_NOT_FOUND" },
      });
    }

    if (isLocallyRevoked(targetHash)) {
      return reply.code(409).send({
        ok: false,
        error: { code: "TARGET_ALREADY_REVOKED" },
      });
    }

if (!body.signature?.signature) {
  return reply.code(400).send({
    ok: false,
    error: { code: "MISSING_REVOCATION_SIGNATURE" },
  });
}

    const signer =
      body.signer ??
      target.payload?.authorization?.buyer ??
      target.payload?.authorization?.grantor ??
      target.creator;

    const reason = body.reason ?? "user_revoked";
const nonce = requireHex(
  body.nonce ?? body.signature?.message?.nonce,
  "MISSING_REVOCATION_NONCE"
);

const revocationMessage = {
  targetHash,
  targetType: target.objectType,
  reason,
  nonce,
};

await requireValidTypedSignature({
  domain: body.signature.domain,
  types: body.signature.types ?? revocationTypes(),
  primaryType: body.signature.primaryType ?? "AonRevocation",
  message: revocationMessage,
  signature: body.signature.signature,
  expectedSigner: signer,
  code: "BAD_REVOCATION_SIGNATURE",
});

    const obj: AonObject & { signature?: any } = {
      objectType: "revocation",
      schemaVersion: "1",
      namespace: target.namespace,
      createdAt: body.createdAt ?? Date.now(),
      creator: signer,
      references: [targetHash],
      payload: {
        revocationType: body.revocationType ?? `${target.objectType}_revocation`,
        targetType: target.objectType,
        targetHash,
        reason,
        nonce,
      },
signature: {
  scheme: body.signature.scheme ?? "eip712",
  signer,
  domain: body.signature.domain,
  types: body.signature.types ?? revocationTypes(),
  primaryType:
    body.signature.primaryType ?? "AonRevocation",
  message: revocationMessage,
  signature: body.signature.signature,
},
    } as any;

    const saved = await putObject(obj);
    await announceObject(saved);

    return {
      ok: true,
      objectHash: saved.objectHash,
      revocation: saved,
    };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "REVOCATION_FAILED" },
    });
  }
});

app.get("/v1/revocations/by-target/:targetHash", async (req) => {
  const targetHash = String((req.params as any).targetHash).toLowerCase();

  return {
    ok: true,
    targetHash,
    revoked: isLocallyRevoked(targetHash),
    revocations: revocationsForTarget(targetHash).sort(latestFirst),
  };
});


await app.listen({ port, host: "0.0.0.0" });
