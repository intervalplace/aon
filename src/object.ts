import { keccak256, toBytes } from "viem";

export type AonObjectType =
  | "authorization"
  | "condition"
  | "proof"
  | "receipt";

export type AonObject = {
  objectType: AonObjectType;
  schemaVersion: "1";
  namespace: string;
  createdAt: number;
  creator?: string;
  references: string[];
  payload: Record<string, unknown>;
  signature?: string;
  objectHash?: string;
};

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined && k !== "objectHash")
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function hashObject(obj: AonObject): string {
  return keccak256(toBytes(canonicalize(obj)));
}

export function finalizeObject(obj: AonObject): AonObject {
  return {
    ...obj,
    objectHash: hashObject(obj),
  };
}

export function assertValidObject(obj: AonObject) {
  if (!obj.objectType) throw new Error("MISSING_OBJECT_TYPE");
  if (obj.schemaVersion !== "1") throw new Error("UNSUPPORTED_SCHEMA");
  if (!obj.namespace) throw new Error("MISSING_NAMESPACE");
  if (!Array.isArray(obj.references)) throw new Error("INVALID_REFERENCES");
  if (!obj.payload || typeof obj.payload !== "object") {
    throw new Error("INVALID_PAYLOAD");
  }

  const expected = hashObject(obj);

  if (obj.objectHash && obj.objectHash.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("OBJECT_HASH_MISMATCH");
  }

  return expected;
}
