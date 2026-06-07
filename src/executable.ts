import { AonObject } from "./object.js";

function lowerRefs(obj: AonObject) {
  return (obj.references ?? []).map((x) => x.toLowerCase());
}

export function findExecutableGraphs(
  objects: AonObject[],
  opts?: {
    namespace?: string;
    includeCompleted?: boolean;
  }
) {
  const authorizations = objects.filter((o) =>
    o.objectType === "authorization" &&
    (!opts?.namespace || o.namespace === opts.namespace)
  );

  const conditions = objects.filter((o) => o.objectType === "condition");
  const proofs = objects.filter((o) => o.objectType === "proof");
  const receipts = objects.filter((o) =>
    o.objectType === "receipt" &&
    (!opts?.namespace || o.namespace === opts.namespace)
  );

  const executable = [];

  for (const auth of authorizations) {
    if (!auth.objectHash) continue;

    const authHash = auth.objectHash.toLowerCase();

    const relatedConditions = conditions.filter((c) =>
      lowerRefs(c).includes(authHash)
    );

    for (const condition of relatedConditions) {
      if (!condition.objectHash) continue;

      const conditionHash = condition.objectHash.toLowerCase();

      const conditionConsumed = receipts.some((r) =>
        lowerRefs(r).includes(conditionHash)
      );

      const relatedProofs = proofs.filter((p) =>
        lowerRefs(p).includes(conditionHash)
      );

      for (const proof of relatedProofs) {
        if (!proof.objectHash) continue;

        const proofHash = proof.objectHash.toLowerCase();

        const exactReceipt = receipts.find((r) => {
          const refs = lowerRefs(r);
          return (
            refs.includes(authHash) &&
            refs.includes(conditionHash) &&
            refs.includes(proofHash)
          );
        });

        const status = exactReceipt
          ? "completed"
          : conditionConsumed
            ? "consumed"
            : "executable";

        if (!opts?.includeCompleted && status !== "executable") {
          continue;
        }

        executable.push({
          status,
          authorization: auth,
          condition,
          proof,
          receipt: exactReceipt ?? null,
        });
      }
    }
  }

  return executable;
}
