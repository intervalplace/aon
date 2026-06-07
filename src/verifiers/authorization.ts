import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import type { AonObject } from "../object.js";

function stableStringify(x: any): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;

  return `{${Object.keys(x)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`)
    .join(",")}}`;
}

function assertSameObject(a: any, b: any) {
  if (stableStringify(a) !== stableStringify(b)) {
    throw new Error("AUTH_PAYLOAD_MESSAGE_MISMATCH");
  }
}

export async function verifyAuthorizationObject(obj: AonObject) {
  if (obj.objectType !== "authorization") return { ok: true, skipped: true };

  const sig = (obj as any).signature;

  if (!sig) {
    if (process.env.AON_DEV_ALLOW_UNSIGNED === "true") {
      return { ok: true, skipped: true, reason: "DEV_UNSIGNED_ALLOWED" };
    }

    throw new Error("AUTH_SIGNATURE_MISSING");
  }

  if (sig.scheme !== "eip712") {
    throw new Error("AUTH_SIGNATURE_SCHEME_UNSUPPORTED");
  }

  if (!sig.signer) throw new Error("AUTH_SIGNER_MISSING");
  if (!sig.signature) throw new Error("AUTH_SIGNATURE_HEX_MISSING");
  if (!sig.domain) throw new Error("AUTH_DOMAIN_MISSING");
  if (!sig.types) throw new Error("AUTH_TYPES_MISSING");
  if (!sig.primaryType) throw new Error("AUTH_PRIMARY_TYPE_MISSING");
  if (!sig.message) throw new Error("AUTH_MESSAGE_MISSING");

  const signer = getAddress(sig.signer);

  if (obj.creator && obj.creator.startsWith("0x")) {
    const creator = getAddress(obj.creator as Address);
    if (creator !== signer) throw new Error("AUTH_CREATOR_SIGNER_MISMATCH");
  }

  if (obj.payload?.authorization) {
    assertSameObject(obj.payload.authorization, sig.message);
  }

  const valid = await verifyTypedData({
    address: signer,
    domain: sig.domain,
    types: sig.types,
    primaryType: sig.primaryType,
    message: sig.message,
    signature: sig.signature as Hex,
  } as any);

  if (!valid) throw new Error("AUTH_SIGNATURE_INVALID");

  return {
    ok: true,
    scheme: "eip712",
    signer,
    primaryType: sig.primaryType,
    chainId: sig.domain?.chainId ?? null,
    verifyingContract: sig.domain?.verifyingContract ?? null,
  };
}
