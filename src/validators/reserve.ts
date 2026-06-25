import type { AonObject } from "../object.js";

import {
    requireNamespace,
    requireReferenceTypes,
} from "./graph.js";

export async function validateReserve(
    obj: AonObject
) {

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
