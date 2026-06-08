import { privateKeyToAccount } from "viem/accounts";


const AON = process.env.AON ?? "http://127.0.0.1:8787";
const CSD_TXID =
  process.env.CSD_TXID ??
  "0x80c72b4c4970710ebf1342c6e724d946406635498d0185960651f23c103cad63";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);

const now = Math.floor(Date.now() / 1000);

const domain = {
  name: "Covenant CSD/USDC",
  version: "1",
  chainId: 84532,
  verifyingContract: "0xd3CE5f8eACF501A11299BAd2c6C72850E2FDe9AD",
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

const authorization = {
  buyer: account.address,
  sellerUsdcRecipient: "0x0000000000000000000000000000000000000002",
sellerCsdScriptHash:
  "0xd4da77ed0cfd74ca14ed41e4cb3e43d053ea8d58000000000000000000000000",
  csdGenesisHash: "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52",
  tradeIntentHash: `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
  csdAmount: "100000000",
  usdc: "0x0000000000000000000000000000000000000003",
  usdcAmount: "1000000",
  minConfirmations: "1",
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  nonce: `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
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

async function get(path) {
  const res = await fetch(`${AON}${path}`);
  return await res.json();
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
});

console.log("AUTH", auth.objectHash);

const condition = await post("/v1/conditions/csd-payment", {
  authorizationHash: auth.objectHash,
});

console.log("COND", condition.objectHash);

const proof = await post("/v1/proofs/csd/from-txid", {
  conditionHash: condition.objectHash,
  txid: CSD_TXID,
});

console.log("PROOF", proof.objectHash);

const next = await get("/v1/executable/next?namespace=aon:csd-usdc");
console.log("NEXT", next.next?.authorization?.objectHash ?? null);

const consumed = await post("/v1/executor/consume", {
  namespace: "aon:csd-usdc",
  auto: true,
});

console.log("RECEIPT", consumed.objectHash);
console.log(JSON.stringify(consumed.verification, null, 2));
