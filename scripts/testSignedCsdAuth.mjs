import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";

const AON = process.env.AON ?? "http://127.0.0.1:8787";

const account = privateKeyToAccount(
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
);

const now = Math.floor(Date.now() / 1000);

const authorization = {
  buyer: account.address,
  sellerUsdcRecipient: getAddress("0x0000000000000000000000000000000000000002"),
sellerCsdScriptHash:
  "0xd4da77ed0cfd74ca14ed41e4cb3e43d053ea8d58000000000000000000000000",
  csdGenesisHash:
    "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52",
  tradeIntentHash:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  csdAmount: "100000000",
  usdc: getAddress("0x0000000000000000000000000000000000000003"),
  usdcAmount: "1000000",
  minConfirmations: "1",
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  nonce:
    "0x2222222222222222222222222222222222222222222222222222222222222222",
};

const domain = {
  name: "CsdUsdcSettlement",
  version: "1",
  chainId: 84532,
  verifyingContract: getAddress("0x0000000000000000000000000000000000000004"),
};

const types = {
  CsdUsdcAuthorization: [
    { name: "buyer", type: "address" },
    { name: "sellerUsdcRecipient", type: "address" },
    { name: "sellerCsdScriptHash", type: "bytes20" },
    { name: "csdGenesisHash", type: "bytes32" },
    { name: "tradeIntentHash", type: "bytes32" },
    { name: "csdAmount", type: "uint256" },
    { name: "usdc", type: "address" },
    { name: "usdcAmount", type: "uint256" },
    { name: "minConfirmations", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const signature = await account.signTypedData({
  domain,
  types,
  primaryType: "CsdUsdcAuthorization",
  message: authorization,
});



const res = await fetch(`${AON}/v1/authorizations/csd-usdc/from-signed-auth`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    authorization,
    signature,
    domain,
    types,
    primaryType: "CsdUsdcAuthorization",
  }),
});

const json = await res.json();
console.log(JSON.stringify(json, null, 2));
