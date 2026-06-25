import type { AonObject } from "../object.js";
import { verifyObjectSignature } from "./signatures.js";

export async function validateRevocation(
    obj: AonObject
) {
    await verifyObjectSignature(obj);
}
