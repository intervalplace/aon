import type { AonObject } from "../object.js";
import { validateReserve } from "./reserve.js";
import { validateProof } from "./proof.js";
import { validateFill } from "./fill.js";
import { validateReceipt } from "./receipt.js";
import { validateAuthorization } from "./authorization.js";
import { validateOrder } from "./order.js";
import { validateRevocation } from "./revocation.js";

export async function validateObject(
    obj: AonObject
) {

    switch (obj.objectType) {

        case "authorization":
            await validateAuthorization(obj);
            return;

        case "order":
            await validateOrder(obj);
            return;

        case "revocation":
            await validateRevocation(obj);
            return;

case "reserve":
    await validateReserve(obj);
    return;

case "proof":
    await validateProof(obj);
    return;

case "fill":
    await validateFill(obj);
    return;

case "receipt":
    await validateReceipt(obj);
    return;

case "namespace_manifest":
    return;

        default:
            throw new Error("UNKNOWN_OBJECT_TYPE");
    }
}
