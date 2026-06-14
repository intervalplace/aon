import type { AonObject } from "./object.js";

function refsLower(obj: any) {
  return (obj.references ?? []).map((x: string) => x.toLowerCase());
}

function asBigInt(x: any) {
  if (x === undefined || x === null || x === "") return 0n;
  return BigInt(String(x));
}

function fillData(fill: any) {
  return fill.payload?.fill ?? fill.payload ?? {};
}

function fillNonce(fill: any) {
  return fillData(fill).fillNonce ?? fillData(fill).nonce ?? fill.objectHash;
}

function makerOrderHash(fill: any) {
  return fillData(fill).makerOrderHash?.toLowerCase?.();
}

function takerOrderHash(fill: any) {
  return fillData(fill).takerOrderHash?.toLowerCase?.();
}

function fillBaseAmount(fill: any) {
  return asBigInt(fillData(fill).baseAmount);
}

function makerOrderBaseAmount(fill: any) {
  return asBigInt(fill.payload?.makerOrder?.baseAmount ?? fillData(fill).makerOrderBaseAmount);
}

function takerOrderBaseAmount(fill: any) {
  return asBigInt(fill.payload?.takerOrder?.baseAmount ?? fillData(fill).takerOrderBaseAmount);
}

function receiptConsumesFill(receipt: any, fill: any) {
  const fillHash = fill.objectHash?.toLowerCase?.();
  const nonce = fillNonce(fill)?.toLowerCase?.();

  return (
    (fillHash && refsLower(receipt).includes(fillHash)) ||
    (nonce && receipt.payload?.fillNonce?.toLowerCase?.() === nonce) ||
    (nonce && receipt.payload?.execution?.fillNonce?.toLowerCase?.() === nonce)
  );
}

function isFillReceipted(receipts: any[], fill: any) {
  return receipts.some((r) => receiptConsumesFill(r, fill));
}

function sumReceiptedBaseForOrder(args: {
  fills: any[];
  receipts: any[];
  orderHash: string | undefined;
  side: "maker" | "taker";
}) {
  if (!args.orderHash) return 0n;

  let total = 0n;

  for (const fill of args.fills) {
    const orderHash =
      args.side === "maker" ? makerOrderHash(fill) : takerOrderHash(fill);

    if (orderHash !== args.orderHash) continue;
    if (!isFillReceipted(args.receipts, fill)) continue;

    total += fillBaseAmount(fill);
  }

  return total;
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

    const receipt = receipts.find((r: any) => receiptConsumesFill(r, fill));

    const currentFillBase = fillBaseAmount(fill);

    const mOrderHash = makerOrderHash(fill);
    const tOrderHash = takerOrderHash(fill);

    const makerAlreadyFilled = sumReceiptedBaseForOrder({
      fills,
      receipts,
      orderHash: mOrderHash,
      side: "maker",
    });

    const takerAlreadyFilled = sumReceiptedBaseForOrder({
      fills,
      receipts,
      orderHash: tOrderHash,
      side: "taker",
    });

    const makerTotal = makerOrderBaseAmount(fill);
    const takerTotal = takerOrderBaseAmount(fill);

    const makerRemaining =
      makerTotal > makerAlreadyFilled ? makerTotal - makerAlreadyFilled : 0n;

    const takerRemaining =
      takerTotal > takerAlreadyFilled ? takerTotal - takerAlreadyFilled : 0n;

    const wouldOverfillMaker =
      makerTotal > 0n && makerAlreadyFilled + currentFillBase > makerTotal;

    const wouldOverfillTaker =
      takerTotal > 0n && takerAlreadyFilled + currentFillBase > takerTotal;

    const status = receipt
      ? "completed"
      : wouldOverfillMaker || wouldOverfillTaker
        ? "overfilled"
        : "executable";

    if (!opts?.includeCompleted && status !== "executable") continue;

    out.push({
      status,
      namespace: "aon:evm-spot",
      makerAuthorization: makerAuth,
      takerAuthorization: takerAuth,
      fill,
      receipt: receipt ?? null,
      partialFill: {
        fillBaseAmount: currentFillBase.toString(),
        makerOrderHash: mOrderHash ?? null,
        takerOrderHash: tOrderHash ?? null,
        makerOrderBaseAmount: makerTotal.toString(),
        takerOrderBaseAmount: takerTotal.toString(),
        makerAlreadyFilled: makerAlreadyFilled.toString(),
        takerAlreadyFilled: takerAlreadyFilled.toString(),
        makerRemaining: makerRemaining.toString(),
        takerRemaining: takerRemaining.toString(),
        wouldOverfillMaker,
        wouldOverfillTaker,
      },
    });
  }

  return out;
}
