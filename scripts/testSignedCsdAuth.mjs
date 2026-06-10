import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";

const AON = process.env.AON ?? "http://127.0.0.1:8787";

const account = privateKeyToAccount(
  "0x4019e96887def59e26a0929378394432f1b3986f42029269720f249943bf5fb5"
);

const now = Math.floor(Date.now() / 1000);

const authorization = {
  buyer: account.address,
  sellerUsdcRecipient: getAddress("0xc271dd5164bDD49B6FedAA8ea1537Cb4020681D1"),
sellerCsdScriptHash:
  "0xd4da77ed0cfd74ca14ed41e4cb3e43d053ea8d58000000000000000000000000",
  csdGenesisHash:
    "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52",
  tradeIntentHash:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  csdAmount: "100000000",
  usdc: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  usdcAmount: "1000000",
  minConfirmations: "1",
  executorFeeToken: getAddress("0xc271dd5164bDD49B6FedAA8ea1537Cb4020681D1"),
  executorFeeAmount: "100000", // 0.10 USDC
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  nonce:
    "0x2222222222222222222222222222222222222222222222222222222222222222",
};

const domain = {
name: "AON CSD/USDC",
version: "2",
  chainId: 1,
  verifyingContract: "0x212C08Cfefc666751323f12BB422Fffc08124bfC",
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
    { name: "executorFeeToken", type: "address" },
    { name: "executorFeeAmount", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "validBefore", type: "uint64" },
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
