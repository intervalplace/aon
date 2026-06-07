import "./polyfills.js";
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
} from "./p2p.js";


const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await loadStore();
await startP2p();


app.get("/v1/health", async () => ({
  ok: true,
  service: "aon-node-v0",
}));

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

    const authorizationHash = body.authorizationHash;
    const conditionHash = body.conditionHash;
    const proofHash = body.proofHash;

    if (!authorizationHash || !conditionHash || !proofHash) {
      return reply.code(400).send({
        ok: false,
        error: { code: "MISSING_HASHES" },
      });
    }

    const auth = getObject(authorizationHash);
    const condition = getObject(conditionHash);
    const proof = getObject(proofHash);

    if (!auth || !condition || !proof) {
      return reply.code(404).send({
        ok: false,
        error: { code: "OBJECT_NOT_FOUND" },
      });
    }


if (auth.objectType !== "authorization") {

  return reply.code(400).send({ ok: false, error: { code: "INVALID_AUTHORIZATION_OBJECT" } });

}

if (condition.objectType !== "condition") {

  return reply.code(400).send({ ok: false, error: { code: "INVALID_CONDITION_OBJECT" } });

}

if (proof.objectType !== "proof") {

  return reply.code(400).send({ ok: false, error: { code: "INVALID_PROOF_OBJECT" } });

}

if (!condition.references.map((r) => r.toLowerCase()).includes(authorizationHash.toLowerCase())) {

  return reply.code(400).send({

    ok: false,

    error: { code: "CONDITION_DOES_NOT_REFERENCE_AUTHORIZATION" },

  });

}

if (!proof.references.map((r) => r.toLowerCase()).includes(conditionHash.toLowerCase())) {

  return reply.code(400).send({

    ok: false,

    error: { code: "PROOF_DOES_NOT_REFERENCE_CONDITION" },

  });

}

const existingReceipts = listObjects({
  objectType: "receipt",
  namespace: auth.namespace,
});

const conditionAlreadyReceipted = existingReceipts.some((r: any) =>
  r.references?.map((x: string) => x.toLowerCase()).includes(conditionHash.toLowerCase())
);

if (conditionAlreadyReceipted) {
  return reply.code(409).send({
    ok: false,
    error: { code: "CONDITION_ALREADY_CONSUMED" },
  });
}

const proofTxid = proof.payload?.txid ?? proof.payload?.proof?.txid;

const txidAlreadyReceipted = existingReceipts.some((r: any) =>
  r.payload?.verification?.txid?.toLowerCase?.() === proofTxid?.toLowerCase?.()
);

if (proofTxid && txidAlreadyReceipted) {
  return reply.code(409).send({
    ok: false,
    error: { code: "PROOF_TXID_ALREADY_CONSUMED" },
  });
}

const verification = verifyCsdProofObject(condition, proof);

const receipt: AonObject = {
  objectType: "receipt",
  schemaVersion: "1",
  namespace: auth.namespace,
  createdAt: Date.now(),
  creator: body.creator ?? "aon-node-v0",
  references: [authorizationHash, conditionHash, proofHash],
  payload: {
    receiptType: "authorized_state_transition_completed",
    result: body.result ?? "executed",
    executionTx: body.executionTx ?? null,
    summary: body.summary ?? null,
	verification,
  },
};
    const saved = await putObject(receipt);

await announceObject(saved);

return {
  ok: true,
  objectHash: saved.objectHash,
  receipt: saved,
};
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "RECEIPT_CREATION_FAILED" },
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
await app.listen({ port, host: "0.0.0.0" });
