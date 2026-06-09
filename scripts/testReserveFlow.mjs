import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";

const AON = process.env.AON ?? "http://127.0.0.1:8787";
const CSD_TXID = process.env.CSD_TXID;
const BUYER_PK = process.env.TEST_BUYER_PRIVATE_KEY;
const SETTLEMENT = process.env.AON_SETTLEMENT_CONTRACT;

if (!BUYER_PK) throw new Error("TEST_BUYER_PRIVATE_KEY_MISSING");
if (!SETTLEMENT) throw new Error("AON_SETTLEMENT_CONTRACT_MISSING");
if (!CSD_TXID) throw new Error("CSD_TXID_MISSING");

const account = privateKeyToAccount(BUYER_PK);
const now = Math.floor(Date.now() / 1000);

const authorization = {
  buyer: account.address,
  sellerUsdcRecipient: getAddress(process.env.TEST_SELLER_USDC_RECIPIENT ?? "0xc271dd5164bDD49B6FedAA8ea1537Cb4020681D1"),
  sellerCsdScriptHash: process.env.TEST_SELLER_CSD_SCRIPT_HASH ?? "0xd4da77ed0cfd74ca14ed41e4cb3e43d053ea8d58000000000000000000000000",
  csdGenesisHash: process.env.TEST_CSD_GENESIS_HASH ?? "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52",
  tradeIntentHash: `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
  csdAmount: process.env.TEST_CSD_AMOUNT ?? "100000000",
  usdc: getAddress(process.env.TEST_USDC ?? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  usdcAmount: process.env.TEST_USDC_AMOUNT ?? "1000000",
  minConfirmations: process.env.TEST_MIN_CONFIRMATIONS ?? "1",
  validAfter: String(now - 60),
  validBefore: String(now + Number(process.env.TEST_VALID_SECONDS ?? 3600)),
  nonce: `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
};

const domain = {
  name: "Covenant CSD/USDC",
  version: "1",
  chainId: Number(process.env.AON_EVM_CHAIN_ID ?? 1),
  verifyingContract: getAddress(SETTLEMENT),
};

const types = {
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

async function post(path, body) {
  const res = await fetch(`${AON}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!json.ok) {
    console.error(path, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

const signature = await account.signTypedData({
  domain,
  types,
  primaryType: "CsdUsdcAuthorization",
  message: authorization,
});

const auth = await post("/v1/authorizations/csd-usdc/from-signed-auth", {
  authorization,
  signature,
  domain,
  types,
  primaryType: "CsdUsdcAuthorization",
});

console.log("AUTH", auth.objectHash);

const reserve = await post("/v1/reserves/csd-usdc/lock", {
  authorizationHash: auth.objectHash,
});

console.log("RESERVE", reserve.objectHash);
console.log("LOCK_TX", reserve.lock?.lockTx);

const proof = await post("/v1/proofs/csd/from-txid", {
  reserveHash: reserve.objectHash,
  txid: CSD_TXID,
});

console.log("PROOF", proof.objectHash);

const consumed = await post("/v1/executor/consume", {
  authorizationHash: auth.objectHash,
  reserveHash: reserve.objectHash,
  proofHash: proof.objectHash,
  mode: "contract",
});

console.log("RECEIPT", consumed.objectHash);
console.log("EVM_TX", consumed.receipt?.payload?.executionTx);
console.log(JSON.stringify(consumed.verification, null, 2));
