import type { AonObject } from "../object.js";
import {
    requireObject,
    requireNamespace,
    requireReferenceCount,
} from "./graph.js";

export async function validateReserve(
    obj: AonObject
) {

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
