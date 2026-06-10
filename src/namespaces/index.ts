import type { AonObject } from "../object.js";
import { verifyCsdPaymentProof } from "../verifiers/csd.js";
import {
  executeCsdUsdcSettlementOnEvm,
  lockCsdUsdcOnEvm,
} from "../executors/evmCsdUsdcSettlement.js";

export type NamespaceAdapter = {
  namespace: string;
  authorizationType: string;
  proofType: string;
  reserveType: string;

  normalizeAuthorization(auth: any): any;
  types(): any;
  summarizeAuthorization(auth: AonObject): any;
  reward(graph: any): any;
  verify(graph: { authorization: any; reserve: any; proof: any }): any;
  execute(graph: { authorization: any; reserve: any; proof: any; mode?: string }): Promise<any>;
  lock(args: { authorization: any }): Promise<any>;
};

function asString(x: any) {
  return x === undefined || x === null ? "0" : String(x);
}

export const csdUsdcAdapter: NamespaceAdapter = {
  namespace: "aon:csd-usdc",
  authorizationType: "csd_usdc_release",
  reserveType: "evm_usdc_lock",
  proofType: "csd_payment",

  normalizeAuthorization(auth: any) {
    return {
      buyer: auth.buyer,
      sellerUsdcRecipient: auth.sellerUsdcRecipient,
      sellerCsdScriptHash: auth.sellerCsdScriptHash,
      csdGenesisHash: auth.csdGenesisHash,
      tradeIntentHash: auth.tradeIntentHash,
      csdAmount: String(auth.csdAmount),
      usdc: auth.usdc,
      usdcAmount: String(auth.usdcAmount),
      minConfirmations: String(auth.minConfirmations),
      executorFeeAmount: asString(auth.executorFeeAmount),
      validAfter: String(auth.validAfter),
      validBefore: String(auth.validBefore),
      nonce: auth.nonce,
    };
  },

  types() {
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
  },

  summarizeAuthorization(auth: any) {
    const a = auth.payload?.authorization ?? {};

    return {
      objectHash: auth.objectHash,
      objectType: auth.objectType,
      namespace: auth.namespace,
      createdAt: auth.createdAt,
      buyer: a.buyer,
      sellerUsdcRecipient: a.sellerUsdcRecipient,
      csdAmount: a.csdAmount,
      usdcAmount: a.usdcAmount,
      executorFeeAmount: a.executorFeeAmount ?? "0",
      reward: {
        token: a.usdc,
        amount: String(a.executorFeeAmount ?? "0"),
      },
      usdc: a.usdc,
      validBefore: a.validBefore,
      payload: auth.payload,
    };
  },

  reward(graph: any) {
    const a = graph.authorization?.payload?.authorization ?? {};

    return {
      token: a.usdc,
      amount: String(a.executorFeeAmount ?? "0"),
      tokenSymbol: "USDC",
      decimals: 6,
    };
  },

  verify({ authorization, proof }) {
    const a = authorization.payload.authorization;

    return verifyCsdPaymentProof({
      proof: proof.payload.proof,
      expectedRecipientScriptPubKey: a.sellerCsdScriptHash,
      expectedAmount: BigInt(a.csdAmount),
      minConfirmations: Number(a.minConfirmations ?? 1),
      expectedGenesisHash: a.csdGenesisHash,
    });
  },

  async execute({ authorization, reserve, proof, mode }) {
    if (mode === "off") {
      return { executed: false, mode, executionTx: null, result: "verified_only" };
    }

    if (mode === "simulate") {
      const txid = proof.payload?.txid ?? proof.payload?.proof?.txid;
      return {
        executed: true,
        mode,
        executionTx: `simulated:aon:${txid}`,
        result: "simulated_settlement",
      };
    }

    if (mode === "contract") {
      return await executeCsdUsdcSettlementOnEvm({ authorization, reserve, proof });
    }

    throw new Error("UNKNOWN_EXECUTOR_MODE");
  },

  async lock({ authorization }) {
    return await lockCsdUsdcOnEvm({ authorization });
  },
};

const adapters = new Map<string, NamespaceAdapter>([
  [csdUsdcAdapter.namespace, csdUsdcAdapter],
]);

export function getNamespaceAdapter(namespace: string) {
  const adapter = adapters.get(namespace);
  if (!adapter) throw new Error("UNSUPPORTED_NAMESPACE");
  return adapter;
}

export function listNamespaceAdapters() {
  return [...adapters.values()];
}
