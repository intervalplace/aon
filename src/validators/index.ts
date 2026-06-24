import type { AonObject } from "../object.js";
import { verifyObjectSignature } from "./signatures.js";

export async function validateObject(
  obj: AonObject
) {
  await verifyObjectSignature(obj);
}
