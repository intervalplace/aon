import type { AonObject } from "../object.js";

import {
    requireNamespace,
    requireReferenceTypes,
} from "./graph.js";

export async function validateFill(
    obj: AonObject
) {

    const [
        makerAuth,
        takerAuth,
        makerOrder,
        takerOrder,
    ] =
        requireReferenceTypes(
            obj,
            [
                "authorization",
                "authorization",
                "order",
                "order",
            ]
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
