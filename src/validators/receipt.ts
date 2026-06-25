import type { AonObject } from "../object.js";

import { requireObject } from "./graph.js";

export async function validateReceipt(
    obj: AonObject
) {

    for (const ref of obj.references ?? []) {
        requireObject(ref);
    }
}
