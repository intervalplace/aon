//server.ts

import "./polyfills.js";
import { getAddress, type Hex } from "viem";
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadStore, putObject, getObject, listObjects } from "./store.js";
import { getInboundReferences, getGraph } from "./refs.js";
import { findExecutableGraphs } from "./executable.js";
import type { AonObject } from "./object.js";
import { makeCsdPaymentProofObject } from "./proofs/csdFromTxid.js";
import { verifyCsdProofObject } from "./verifiers/csd.js";
import {
  announceObject,
  dialPeer,
  getP2pInfo,
  requestObjectFromPeer,
  startP2p,
getPubsubInfo,
} from "./p2p.js";
import { executeCsdUsdcSettlementOnEvm } from "./executors/evmCsdUsdcSettlement.js";


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

function isGraphConsumable(graph: any) {
  const auth = graph.authorization;
  const condition = graph.condition;
  const proof = graph.proof;

  if (!auth?.objectHash || !condition?.objectHash || !proof?.objectHash) return false;

  const existingReceipts = listObjects({
    objectType: "receipt",
    namespace: auth.namespace,
  });

  const conditionHash = condition.objectHash.toLowerCase();
  const proofTxid = proof.payload?.txid ?? proof.payload?.proof?.txid;

  const conditionAlreadyReceipted = existingReceipts.some((r: any) =>
    objectRefsLower(r).includes(conditionHash)
  );

  if (conditionAlreadyReceipted) return false;

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
      { name: "validAfter", type: "uint64" },
      { name: "validBefore", type: "uint64" },
      { name: "nonce", type: "bytes32" },
    ],
  };
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

async function executeGraphAction(args: {
  authorization: any;
  condition: any;
  proof: any;
  mode?: string;
}) {
  const mode = args.mode ?? process.env.AON_EXECUTOR_MODE ?? "simulate";

  if (mode === "off") {
    return {
      executed: false,
      mode,
      executionTx: null,
      result: "verified_only",
    };
  }

  if (mode === "simulate") {
    const txid = args.proof.payload?.txid ?? args.proof.payload?.proof?.txid;

    return {
      executed: true,
      mode,
      executionTx: `simulated:aon:${txid}`,
      result: "simulated_settlement",
    };
  }

if (mode === "contract") {
  return await executeCsdUsdcSettlementOnEvm({
    authorization: args.authorization,
    condition: args.condition,
    proof: args.proof,
  });
}

  throw new Error("UNKNOWN_EXECUTOR_MODE");
}

async function consumeExecutableGraph(args: {
  authorizationHash: string;
  conditionHash: string;
  proofHash: string;
  creator?: string;
  executionTx?: string | null;
summary?: string | null;
mode?: string;
}) {
  const authorizationHash = lowerHash(args.authorizationHash, "INVALID_AUTHORIZATION_HASH");
  const conditionHash = lowerHash(args.conditionHash, "INVALID_CONDITION_HASH");
  const proofHash = lowerHash(args.proofHash, "INVALID_PROOF_HASH");

  const auth = getObject(authorizationHash);
  const condition = getObject(conditionHash);
  const proof = getObject(proofHash);

  if (!auth || !condition || !proof) throw new Error("OBJECT_NOT_FOUND");

  if (auth.objectType !== "authorization") throw new Error("INVALID_AUTHORIZATION_OBJECT");
  if (condition.objectType !== "condition") throw new Error("INVALID_CONDITION_OBJECT");
  if (proof.objectType !== "proof") throw new Error("INVALID_PROOF_OBJECT");

  if (!objectRefsLower(condition).includes(authorizationHash)) {
    throw new Error("CONDITION_DOES_NOT_REFERENCE_AUTHORIZATION");
  }

  if (!objectRefsLower(proof).includes(conditionHash)) {
    throw new Error("PROOF_DOES_NOT_REFERENCE_CONDITION");
  }

  const existingReceipts = listObjects({
    objectType: "receipt",
    namespace: auth.namespace,
  });

  const conditionAlreadyReceipted = existingReceipts.some((r: any) =>
    objectRefsLower(r).includes(conditionHash)
  );

  if (conditionAlreadyReceipted) {
    throw new Error("CONDITION_ALREADY_CONSUMED");
  }

  const proofTxid = proof.payload?.txid ?? proof.payload?.proof?.txid;

  const txidAlreadyReceipted = existingReceipts.some((r: any) =>
    r.payload?.verification?.txid?.toLowerCase?.() === proofTxid?.toLowerCase?.()
  );

  if (proofTxid && txidAlreadyReceipted) {
    throw new Error("PROOF_TXID_ALREADY_CONSUMED");
  }

  const verification = verifyCsdProofObject(condition, proof);

const action = await executeGraphAction({
  authorization: auth,
  condition,
  proof,
  mode: args.mode,
});

  const receipt: AonObject = {
    objectType: "receipt",
    schemaVersion: "1",
    namespace: auth.namespace,
    createdAt: Date.now(),
    creator: args.creator ?? "aon-executor-v0",
    references: [authorizationHash, conditionHash, proofHash],
payload: {
  receiptType: "authorized_state_transition_completed",
  result: action.result,
  executionTx: args.executionTx ?? action.executionTx ?? null,
  summary: args.summary ?? null,
  verification,
  executor: {
    mode: action.mode,
    executed: action.executed,
  },
},
  };

  const saved = await putObject(receipt);
  await announceObject(saved);

  return {
    receipt: saved,
    verification,
    authorization: auth,
    condition,
    proof,
  };
}

await app.register(cors, { origin: true });
await loadStore();
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
  const objects = listObjects();

  return {
    ok: true,
    executable: findExecutableGraphs(objects, {
      namespace: q.namespace,
      includeCompleted: q.includeCompleted === "true",
    }),
  };
});

app.get("/v1/receipts/by-condition/:conditionHash", async (req) => {
  const conditionHash = ((req.params as any).conditionHash as string).toLowerCase();

  const receipts = listObjects({
    objectType: "receipt",
  }).filter((r: any) =>
    r.references?.map((x: string) => x.toLowerCase()).includes(conditionHash)
  );

  return {
    ok: true,
    conditionHash,
    receipts,
  };
});

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


app.post("/v1/receipts/from-executable", async (req, reply) => {
  try {
    const body = req.body as any;

    if (!body.authorizationHash || !body.conditionHash || !body.proofHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_HASHES" },
      });
    }

    const result = await consumeExecutableGraph({
      authorizationHash: body.authorizationHash,
      conditionHash: body.conditionHash,
      proofHash: body.proofHash,
      creator: body.creator ?? "aon-node-v0",
      executionTx: body.executionTx ?? null,
      summary: body.summary ?? null,
    });

    return {
      ok: true,
      objectHash: result.receipt.objectHash,
      receipt: result.receipt,
    };
  } catch (err: any) {
    const code = err?.message ?? "RECEIPT_CREATION_FAILED";
    const status =
      code === "CONDITION_ALREADY_CONSUMED" || code === "PROOF_TXID_ALREADY_CONSUMED"
        ? 409
        : code === "OBJECT_NOT_FOUND"
          ? 404
          : 400;

    return reply.code(status).send({
      ok: false,
      error: { code },
    });
  }
});

app.get("/v1/receipts/canonical/by-condition/:conditionHash", async (req) => {
  const conditionHash = ((req.params as any).conditionHash as string).toLowerCase();

  const receipts = listObjects({
    objectType: "receipt",
  })
    .filter((r: any) =>
      r.references?.map((x: string) => x.toLowerCase()).includes(conditionHash)
    )
    .sort((a: any, b: any) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));

  return {
    ok: true,
    conditionHash,
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

    if (!body.conditionHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_CONDITION_HASH" },
      });
    }

    if (!body.txid) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_TXID" },
      });
    }

    const obj = await makeCsdPaymentProofObject({
      conditionHash: body.conditionHash,
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

app.post("/v1/conditions/csd-payment", async (req, reply) => {
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

    const authPayload = auth.payload.authorization;

    const expectedRecipientScriptPubKey = body.expectedRecipientScriptPubKey
      ? requireHex(body.expectedRecipientScriptPubKey, "INVALID_EXPECTED_RECIPIENT_SCRIPT")
      : authPayload.sellerCsdScriptHash;

    const expectedAmount = String(body.expectedAmount ?? authPayload.csdAmount);
    const minConfirmations = Number(body.minConfirmations ?? authPayload.minConfirmations ?? 1);
    const expectedGenesisHash = body.expectedGenesisHash
      ? requireHex(body.expectedGenesisHash, "INVALID_EXPECTED_GENESIS_HASH")
      : authPayload.csdGenesisHash;

    if (!expectedRecipientScriptPubKey) throw new Error("EXPECTED_RECIPIENT_SCRIPT_MISSING");
    if (!expectedAmount) throw new Error("EXPECTED_AMOUNT_MISSING");
    if (!Number.isFinite(minConfirmations) || minConfirmations < 0) {
      throw new Error("INVALID_MIN_CONFIRMATIONS");
    }

    const condition: AonObject = {
      objectType: "condition",
      schemaVersion: "1",
      namespace: body.namespace ?? auth.namespace ?? "aon:csd-usdc",
      createdAt: body.createdAt ?? nowMs(),
      creator: body.creator ?? "aon-node-v0",
      references: [authorizationHash],
      payload: {
        conditionType: "csd_payment",
        expectedRecipientScriptPubKey,
        expectedAmount,
        minConfirmations,
        expectedGenesisHash,
...(body.expectedIntentHash
  ? { expectedIntentHash: requireHex(body.expectedIntentHash, "INVALID_EXPECTED_INTENT_HASH") }
  : {}),
        authorizationType: auth.payload.authorizationType,
        summary: body.summary ?? null,
      },
    };

    const saved = await putObject(condition);
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
        code: err?.message ?? "CSD_PAYMENT_CONDITION_REJECTED",
      },
    });
  }
});


app.get("/v1/executable/next", async (req) => {
  const q = req.query as any;

  const executable = findExecutableGraphs(listObjects(), {
    namespace: q.namespace,
    includeCompleted: false,
  });

  const next =
    executable.find((x: any) => x.status === "executable" && isGraphConsumable(x)) ??
    null;

  return {
    ok: true,
    namespace: q.namespace ?? null,
    next,
  };
});


app.post("/v1/executor/consume", async (req, reply) => {
  try {
    const body = req.body as any;

    let authorizationHash = body.authorizationHash;
    let conditionHash = body.conditionHash;
    let proofHash = body.proofHash;

    if (body.auto === true || (!authorizationHash && !conditionHash && !proofHash)) {
      const executable = findExecutableGraphs(listObjects(), {
        namespace: body.namespace ?? "aon:csd-usdc",
        includeCompleted: false,
      });

const next = executable.find((x: any) => x.status === "executable" && isGraphConsumable(x));

      if (!next) {
        return reply.code(404).send({
          ok: false,
          error: { code: "NO_EXECUTABLE_GRAPH_AVAILABLE" },
        });
      }

      authorizationHash = next.authorization.objectHash;
      conditionHash = next.condition.objectHash;
      proofHash = next.proof.objectHash;
    }

    if (!authorizationHash || !conditionHash || !proofHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_HASHES" },
      });
    }

    const result = await consumeExecutableGraph({
      authorizationHash,
      conditionHash,
      proofHash,
      creator: body.creator ?? "aon-executor-v0",
      executionTx: body.executionTx ?? null,
      summary: body.summary ?? "Consumed by executor endpoint",
mode: body.mode ?? process.env.AON_EXECUTOR_MODE ?? "simulate",
    });

    return {
      ok: true,
      status: "consumed",
      authorizationHash,
      conditionHash,
      proofHash,
      objectHash: result.receipt.objectHash,
      receipt: result.receipt,
      verification: result.verification,
    };
  } catch (err: any) {
    const code = err?.message ?? "EXECUTOR_CONSUME_FAILED";
    const status =
      code === "CONDITION_ALREADY_CONSUMED" || code === "PROOF_TXID_ALREADY_CONSUMED"
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

await app.listen({ port, host: "0.0.0.0" });
