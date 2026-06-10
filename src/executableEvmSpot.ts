import type { AonObject } from "./object.js";

function refsLower(obj: any) {
  return (obj.references ?? []).map((x: string) => x.toLowerCase());
}

export function findExecutableEvmSpotGraphs(
  objects: AonObject[],
  opts?: { includeCompleted?: boolean }
) {
  const fills = objects.filter(
    (o: any) =>
      o.namespace === "aon:evm-spot" &&
      o.objectType === "proof" &&
      o.payload?.proofType === "evm_spot_fill"
  );

  const receipts = objects.filter(
    (o: any) =>
      o.namespace === "aon:evm-spot" &&
      o.objectType === "receipt"
  );

  const out = [];

  for (const fill of fills) {
    if (!fill.objectHash) continue;

    const refs = refsLower(fill);
    if (refs.length < 2) continue;

    const makerAuth = objects.find(
      (o: any) => o.objectHash?.toLowerCase() === refs[0]
    );

    const takerAuth = objects.find(
      (o: any) => o.objectHash?.toLowerCase() === refs[1]
    );

    if (!makerAuth || !takerAuth) continue;

    const receipt = receipts.find((r: any) =>
      refsLower(r).includes(fill.objectHash!.toLowerCase())
    );

    const status = receipt ? "completed" : "executable";

    if (!opts?.includeCompleted && status !== "executable") continue;

    out.push({
      status,
      namespace: "aon:evm-spot",
      makerAuthorization: makerAuth,
      takerAuthorization: takerAuth,
      fill,
      receipt: receipt ?? null,
    });
  }

  return out;
}
