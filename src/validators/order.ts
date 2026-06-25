import type { AonObject } from "../object.js";

import { verifyObjectSignature } from "./signatures.js";

import {
    requireNamespace,
    requireReferenceTypes,
} from "./graph.js";

export async function validateOrder(
    obj: AonObject
) {

    await verifyObjectSignature(obj);

    const [auth] =
        requireReferenceTypes(
            obj,
            ["authorization"]
        );

    requireNamespace(
        auth.namespace,
        obj.namespace
    );
}
