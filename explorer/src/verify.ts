// Browser-side EIP-712 signature check for the explorer, bundled to
// explorer/verify.js by `npm run build:explorer` (pinned: viem from package-lock).
// Objects signed with { scheme: "eip712", signer, domain, types, primaryType?,
// message, signature } are checked: the signature must recover to `signer`.
import { recoverTypedDataAddress } from "viem";

type Sig = { scheme?: string; signer?: string; domain?: any; types?: Record<string, { name: string; type: string }[]>; primaryType?: string; message?: any; signature?: string };

// uint/int fields are stored as decimal strings in JSON; EIP-712 encoding wants bigints
function normalize(types: Sig["types"], type: string, value: any): any {
  if (value == null) return value;
  if (type.endsWith("[]")) return Array.isArray(value) ? value.map((v) => normalize(types, type.slice(0, -2), v)) : value;
  if (/^u?int\d*$/.test(type)) return typeof value === "string" || typeof value === "number" ? BigInt(value) : value;
  const fields = types?.[type];
  if (!fields || typeof value !== "object") return value;
  const out: any = {};
  for (const f of fields) out[f.name] = normalize(types, f.type, value[f.name]);
  return out;
}

function primaryTypeOf(types: NonNullable<Sig["types"]>): string | undefined {
  const names = Object.keys(types).filter((t) => t !== "EIP712Domain");
  const referenced = new Set(names.flatMap((t) => types[t].map((f) => f.type.replace(/\[\]$/, ""))));
  const roots = names.filter((t) => !referenced.has(t));
  return roots.length === 1 ? roots[0] : undefined;
}

// "valid" | "invalid" | "unsigned" | "unknown" (a signature scheme we don't check)
export async function verifyObject(obj: any): Promise<"valid" | "invalid" | "unsigned" | "unknown"> {
  const sig: Sig | undefined = obj?.signature;
  if (!sig || typeof sig !== "object") return "unsigned";
  if (sig.scheme !== "eip712") return "unknown";
  try {
    const types = { ...(sig.types ?? {}) };
    delete (types as any).EIP712Domain;
    const primaryType = sig.primaryType ?? primaryTypeOf(types);
    if (!primaryType || !sig.signer || !sig.signature) return "invalid";
    const domain = { ...sig.domain };
    if (domain.chainId != null) domain.chainId = BigInt(domain.chainId);
    const recovered = await recoverTypedDataAddress({
      domain, types: types as any, primaryType, message: normalize(types, primaryType, sig.message), signature: sig.signature as `0x${string}`,
    });
    return recovered.toLowerCase() === String(sig.signer).toLowerCase() ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

(globalThis as any).aonVerify = verifyObject;
