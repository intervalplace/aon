import type { AonObject } from "../object.js";

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

        case "fill":
        case "proof":
        case "reserve":
        case "receipt":
        case "namespace_manifest":
            return;

        default:
            throw new Error("UNKNOWN_OBJECT_TYPE");
    }
}
