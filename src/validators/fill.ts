import type { AonObject } from "../object.js";

import {
    requireObject,
    requireNamespace,
    requireReferenceCount,
} from "./graph.js";

export async function validateFill(
    obj: AonObject
) {

    requireReferenceCount(obj, 4);

    const makerAuth =
        requireObject(
            obj.references[0],
            "authorization"
        );

    const takerAuth =
        requireObject(
            obj.references[1],
            "authorization"
        );

    const makerOrder =
        requireObject(
            obj.references[2],
            "order"
        );

    const takerOrder =
        requireObject(
            obj.references[3],
            "order"
        );

    requireNamespace(
        makerAuth.namespace,
        obj.namespace
    );

    requireNamespace(
        takerAuth.namespace,
        obj.namespace
    );

    requireNamespace(
        makerOrder.namespace,
        obj.namespace
    );

    requireNamespace(
        takerOrder.namespace,
        obj.namespace
    );
}
