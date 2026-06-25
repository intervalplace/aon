import type { AonObject } from "../object.js";
import { verifyObjectSignature } from "./signatures.js";

import {
    requireObject,
    requireNamespace,
    requireReferenceCount,
} from "./graph.js";

export async function validateOrder(
    obj: AonObject
) {

    await verifyObjectSignature(obj);

    requireReferenceCount(obj, 1);

    const auth =
        requireObject(
            obj.references[0],
            "authorization"
        );

    requireNamespace(
        auth.namespace,
        obj.namespace
    );
}
