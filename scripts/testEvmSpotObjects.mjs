import { privateKeyToAccount } from "viem/accounts";

const AON = process.env.AON_URL ?? "http://127.0.0.1:8787";

async function post(path, body) {
  const res = await fetch(`${AON}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(`${path}: ${JSON.stringify(json, null, 2)}`);
  return json;
}

async function get(path) {
  const res = await fetch(`${AON}${path}`);
  return await res.json();
}

function hex32(byte) {
  return `0x${byte.repeat(32)}`;
}

const maker = privateKeyToAccount(
  "0x4019e96887def59e26a0929378394432f1b3986f42029269720f249943bf5fb5"
);

const taker = privateKeyToAccount(
  "0x59c6995e998f97a5a0044976f3f0345ba5f489568411dc3b6c52f14f3e541f8f"
);

const now = Math.floor(Date.now() / 1000);

const settlementContract =
  process.env.AON_EVM_SPOT_SETTLEMENT_CONTRACT ??
  "0x0000000000000000000000000000000000000009";

const baseToken = "0x0000000000000000000000000000000000000010";
const quoteToken = "0x0000000000000000000000000000000000000020";
const marketId = hex32("aa");

const domain = {
  name: "AON EVM Spot",
  version: "1",
  chainId: 1,
  verifyingContract: settlementContract,
};

const authTypes = {
  TradingSessionAuthorization: [
    { name: "grantor", type: "address" },
    { name: "settlementContract", type: "address" },
    { name: "baseToken", type: "address" },
    { name: "quoteToken", type: "address" },
    { name: "marketId", type: "bytes32" },
    { name: "sideMask", type: "uint8" },
    { name: "maxBaseExposure", type: "uint256" },
    { name: "maxQuoteExposure", type: "uint256" },
    { name: "maxExecutorFeeQuote", type: "uint256" },
    { name: "minPrice", type: "uint256" },
    { name: "maxPrice", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "validBefore", type: "uint64" },
    { name: "authNonce", type: "bytes32" },
  ],
};

const orderTypes = {
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

const makerAuth = {
  grantor: maker.address,
  settlementContract,
  baseToken,
  quoteToken,
  marketId,
  sideMask: 2,
  maxBaseExposure: "1000000000000000000",
  maxQuoteExposure: "0",
  maxExecutorFeeQuote: "1000000000000000",
  minPrice: "1000000000000000000",
  maxPrice: "1000000000000000000",
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  authNonce: hex32("bb"),
};

const takerAuth = {
  grantor: taker.address,
  settlementContract,
  baseToken,
  quoteToken,
  marketId,
  sideMask: 1,
  maxBaseExposure: "0",
  maxQuoteExposure: "1000000000000000000",
  maxExecutorFeeQuote: "1000000000000000",
  minPrice: "1000000000000000000",
  maxPrice: "1000000000000000000",
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  authNonce: hex32("cc"),
};

const makerAuthSignature = await maker.signTypedData({
  domain,
  types: authTypes,
  primaryType: "TradingSessionAuthorization",
  message: makerAuth,
});

const takerAuthSignature = await taker.signTypedData({
  domain,
  types: authTypes,
  primaryType: "TradingSessionAuthorization",
  message: takerAuth,
});

const makerAuthObj = await post("/v1/authorizations/evm-spot/from-signed-auth", {
  authorization: makerAuth,
  signature: makerAuthSignature,
  signer: maker.address,
  domain,
  types: authTypes,
});

const takerAuthObj = await post("/v1/authorizations/evm-spot/from-signed-auth", {
  authorization: takerAuth,
  signature: takerAuthSignature,
  signer: taker.address,
  domain,
  types: authTypes,
});

const makerOrder = {
  trader: maker.address,
  marketId,
  side: 0,
  price: "1000000000000000000",
  baseAmount: "1000000000000000000",
  orderNonce: hex32("dd"),
  sessionAuthHash: makerAuthObj.objectHash,
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
};

const takerOrder = {
  trader: taker.address,
  marketId,
  side: 1,
  price: "1000000000000000000",
  baseAmount: "1000000000000000000",
  orderNonce: hex32("ee"),
  sessionAuthHash: takerAuthObj.objectHash,
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
};

const makerOrderSignature = await maker.signTypedData({
  domain,
  types: orderTypes,
  primaryType: "SignedOrder",
  message: makerOrder,
});

const takerOrderSignature = await taker.signTypedData({
  domain,
  types: orderTypes,
  primaryType: "SignedOrder",
  message: takerOrder,
});

const makerOrderObj = await post("/v1/orders/evm-spot/from-signed-order", {
  authorizationHash: makerAuthObj.objectHash,
  order: makerOrder,
  signature: makerOrderSignature,
  signer: maker.address,
  domain,
  types: orderTypes,
});

const takerOrderObj = await post("/v1/orders/evm-spot/from-signed-order", {
  authorizationHash: takerAuthObj.objectHash,
  order: takerOrder,
  signature: takerOrderSignature,
  signer: taker.address,
  domain,
  types: orderTypes,
});

const fill1 = await post("/v1/fills/evm-spot", {
  makerAuthorizationHash: makerAuthObj.objectHash,
  takerAuthorizationHash: takerAuthObj.objectHash,
  makerOrderHash: makerOrderObj.objectHash,
  takerOrderHash: takerOrderObj.objectHash,
  fill: {
    price: "1000000000000000000",
    baseAmount: "400000000000000000",
    quoteAmount: "400000000000000000",
    executorFeeQuoteAmount: "100000000000000",
    fillNonce: hex32("f1"),
    settlementContract,
  },
});

console.log("created first partial fill", fill1.objectHash);
console.log(JSON.stringify(await get("/v1/executable/open?namespace=aon:evm-spot"), null, 2));

const consumed1 = await post("/v1/executor/consume", {
  namespace: "aon:evm-spot",
  auto: true,
  mode: "simulate",
});

console.log("consumed first partial fill");
console.log(JSON.stringify(consumed1, null, 2));

const fill2 = await post("/v1/fills/evm-spot", {
  makerAuthorizationHash: makerAuthObj.objectHash,
  takerAuthorizationHash: takerAuthObj.objectHash,
  makerOrderHash: makerOrderObj.objectHash,
  takerOrderHash: takerOrderObj.objectHash,
  fill: {
    price: "1000000000000000000",
    baseAmount: "600000000000000000",
    quoteAmount: "600000000000000000",
    executorFeeQuoteAmount: "100000000000000",
    fillNonce: hex32("f2"),
    settlementContract,
  },
});

console.log("created second partial fill", fill2.objectHash);
console.log(JSON.stringify(await get("/v1/executable/open?namespace=aon:evm-spot"), null, 2));
