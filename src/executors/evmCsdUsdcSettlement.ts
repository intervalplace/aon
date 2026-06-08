import { createWalletClient, http, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const abi = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "auth",
        type: "tuple",
        components: [
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
      },
      { name: "signature", type: "bytes" },
      { name: "csdTxid", type: "bytes32" },
      { name: "aonConditionHash", type: "bytes32" },
      { name: "aonProofHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function asHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) throw new Error(code);
  return x as Hex;
}

export async function executeCsdUsdcSettlementOnEvm(args: {
  authorization: any;
  condition: any;
  proof: any;
}) {
  const contract = getAddress(requireEnv("AON_SETTLEMENT_CONTRACT"));
  const rpcUrl = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);

  const client = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const auth = args.authorization.payload.authorization;
  const sig = args.authorization.signature?.signature;
  const csdTxid = args.proof.payload?.txid ?? args.proof.payload?.proof?.txid;

  if (!sig) throw new Error("AUTH_SIGNATURE_MISSING");
  if (!csdTxid) throw new Error("CSD_TXID_MISSING");

  const txHash = await client.writeContract({
    address: contract,
    abi,
    functionName: "settle",
    args: [
      {
        buyer: getAddress(auth.buyer),
        sellerUsdcRecipient: getAddress(auth.sellerUsdcRecipient),
        sellerCsdScriptHash: asHex(auth.sellerCsdScriptHash, "INVALID_SELLER_CSD_SCRIPT_HASH"),
        csdGenesisHash: asHex(auth.csdGenesisHash, "INVALID_CSD_GENESIS_HASH"),
        tradeIntentHash: asHex(auth.tradeIntentHash, "INVALID_TRADE_INTENT_HASH"),
        csdAmount: BigInt(auth.csdAmount),
        usdc: getAddress(auth.usdc),
        usdcAmount: BigInt(auth.usdcAmount),
        minConfirmations: BigInt(auth.minConfirmations),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: asHex(auth.nonce, "INVALID_NONCE"),
      },
      asHex(sig, "INVALID_AUTH_SIGNATURE"),
      asHex(csdTxid, "INVALID_CSD_TXID"),
      asHex(args.condition.objectHash, "INVALID_CONDITION_HASH"),
      asHex(args.proof.objectHash, "INVALID_PROOF_HASH"),
    ],
  });

  return {
    executed: true,
    mode: "contract",
    executionTx: txHash,
    result: "contract_settlement_submitted",
  };
}
