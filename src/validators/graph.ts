import type { AonObject } from "../object.js";
import { getObject } from "../store.js";

export function requireObject(
    hash: string,
    expectedType?: string
): AonObject {

    const obj = getObject(hash);

    if (!obj) {
        throw new Error("REFERENCED_OBJECT_NOT_FOUND");
    }

    if (
        expectedType &&
        obj.objectType !== expectedType
    ) {
        throw new Error("INVALID_REFERENCE_TYPE");
    }

    return obj;
}

export function requireNamespace(
    expected: string,
    actual: string
) {
    if (expected !== actual) {
        throw new Error("NAMESPACE_MISMATCH");
    }
}

export function requireReferenceCount(
    obj: AonObject,
    count: number
) {
    if ((obj.references ?? []).length !== count) {
        throw new Error("INVALID_REFERENCE_COUNT");
    }
}

export function requireReferenceTypes(
    obj: AonObject,
    expected: string[]
) {

    requireReferenceCount(
        obj,
        expected.length
    );

    return expected.map(
        (type, i) =>
            requireObject(
                obj.references[i],
                type
            )
    );
}
