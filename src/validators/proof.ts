import type { AonObject } from "../object.js";

import {
    requireNamespace,
    requireReferenceTypes,
} from "./graph.js";

export async function validateProof(
    obj: AonObject
) {

    const [reserve] =
        requireReferenceTypes(
            obj,
            ["reserve"]
        );

    requireNamespace(
        reserve.namespace,
        obj.namespace
    );
}
