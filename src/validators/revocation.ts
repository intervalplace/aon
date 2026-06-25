import type { AonObject } from "../object.js";

import { verifyObjectSignature } from "./signatures.js";
import { requireObject } from "./graph.js";

export async function validateRevocation(
    obj: AonObject
) {

    await verifyObjectSignature(obj);

    requireObject(
        obj.references[0]
    );
}
