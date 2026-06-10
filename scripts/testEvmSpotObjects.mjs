const AON = process.env.AON_URL ?? "http://127.0.0.1:8787";

async function post(path, body) {
  const res = await fetch(`${AON}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
}

async function get(path) {
  const res = await fetch(`${AON}${path}`);
  return await res.json();
}

const now = Math.floor(Date.now() / 1000);

const makerAuth = {
  grantor: "0x0000000000000000000000000000000000000001",
  settlementContract: "0x0000000000000000000000000000000000000009",
  baseToken: "0x0000000000000000000000000000000000000010",
  quoteToken: "0x0000000000000000000000000000000000000020",
  marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sideMask: 2,
  maxBaseExposure: "1000000000000000000",
  maxQuoteExposure: "0",
  maxExecutorFeeQuote: "1000000",
  minPrice: "1000000000000000000",
  maxPrice: "1000000000000000000",
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  authNonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

const takerAuth = {
  ...makerAuth,
  grantor: "0x0000000000000000000000000000000000000002",
  sideMask: 1,
  maxBaseExposure: "0",
  maxQuoteExposure: "1000000000000000000",
  authNonce: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

const makerAuthObj = await post("/v1/objects", {
  objectType: "authorization",
  schemaVersion: "1",
  namespace: "aon:evm-spot",
  createdAt: Date.now(),
  creator: makerAuth.grantor,
  references: [],
  payload: {
    authorizationType: "evm_spot_session",
    authorization: makerAuth,
  },
  signature: {
    scheme: "eip712",
    signer: makerAuth.grantor,
    signature: "0x00",
  },
});

const takerAuthObj = await post("/v1/objects", {
  objectType: "authorization",
  schemaVersion: "1",
  namespace: "aon:evm-spot",
  createdAt: Date.now(),
  creator: takerAuth.grantor,
  references: [],
  payload: {
    authorizationType: "evm_spot_session",
    authorization: takerAuth,
  },
  signature: {
    scheme: "eip712",
    signer: takerAuth.grantor,
    signature: "0x00",
  },
});

const fillObj = await post("/v1/objects", {
  objectType: "proof",
  schemaVersion: "1",
  namespace: "aon:evm-spot",
  createdAt: Date.now(),
  creator: "aon-test-matcher",
  references: [makerAuthObj.objectHash, takerAuthObj.objectHash],
  payload: {
    proofType: "evm_spot_fill",
    settlementContract: makerAuth.settlementContract,
    makerAuth,
    makerAuthSig: "0x00",
    takerAuth,
    takerAuthSig: "0x00",
    makerOrder: {
      trader: makerAuth.grantor,
      marketId: makerAuth.marketId,
      side: 0,
      price: "1000000000000000000",
      baseAmount: "1000000000000000000",
      orderNonce: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      sessionAuthHash: makerAuthObj.objectHash,
      validAfter: String(now - 60),
      validBefore: String(now + 3600),
    },
    makerOrderSig: "0x00",
    takerOrder: {
      trader: takerAuth.grantor,
      marketId: takerAuth.marketId,
      side: 1,
      price: "1000000000000000000",
      baseAmount: "1000000000000000000",
      orderNonce: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      sessionAuthHash: takerAuthObj.objectHash,
      validAfter: String(now - 60),
      validBefore: String(now + 3600),
    },
    takerOrderSig: "0x00",
    fill: {
      makerOrderHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      takerOrderHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      makerAuthHash: makerAuthObj.objectHash,
      takerAuthHash: takerAuthObj.objectHash,
      price: "1000000000000000000",
      baseAmount: "1000000000000000000",
      quoteAmount: "1000000000000000000",
      executorFeeQuoteAmount: "1000000",
      fillNonce: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
  },
});

console.log({
  makerAuth: makerAuthObj.objectHash,
  takerAuth: takerAuthObj.objectHash,
  fill: fillObj.objectHash,
});

console.log(await get("/v1/executable/open?namespace=aon:evm-spot"));
