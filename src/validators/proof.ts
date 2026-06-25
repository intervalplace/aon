import type { AonObject } from "../object.js";

import {
    requireObject,
    requireNamespace,
    requireReferenceCount,
} from "./graph.js";

export async function validateProof(
    obj: AonObject
) {

    requireReferenceCount(obj, 1);

    const reserve =
        requireObject(
            obj.references[0],
            "reserve"
        );

    requireNamespace(
        reserve.namespace,
        obj.namespace
    );
}
