import type { AonObject } from "../object.js";

import { verifyObjectSignature } from "./signatures.js";

import {
    requireReferenceTypes,
} from "./graph.js";

export async function validateRevocation(
    obj: AonObject
) {

    await verifyObjectSignature(obj);

    requireReferenceTypes(
        obj,
        ["authorization"]
    );
}
