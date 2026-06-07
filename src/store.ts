import fs from "fs/promises";
import path from "path";
import { AonObject, assertValidObject, finalizeObject } from "./object.js";

const DB_PATH = process.env.AON_DB_PATH ?? "data/aon-objects.json";

type AonDb = {
  objects: Record<string, AonObject>;
};

let db: AonDb = {
  objects: {},
};

export async function loadStore() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    db = JSON.parse(raw);
  } catch {
    db = { objects: {} };
  }
}

export async function saveStore() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, DB_PATH);
}

export async function putObject(input: AonObject) {
  const objectHash = assertValidObject(input);
  const obj = finalizeObject(input);

  db.objects[objectHash.toLowerCase()] = obj;
  await saveStore();

  return obj;
}

export function getObject(hash: string) {
  return db.objects[hash.toLowerCase()] ?? null;
}

export function listObjects(filter?: {
  objectType?: string;
  namespace?: string;
  references?: string;
}) {
  return Object.values(db.objects).filter((obj) => {
    if (filter?.objectType && obj.objectType !== filter.objectType) return false;
    if (filter?.namespace && obj.namespace !== filter.namespace) return false;
    if (
      filter?.references &&
      !obj.references.map((r) => r.toLowerCase()).includes(filter.references.toLowerCase())
    ) {
      return false;
    }
    return true;
  });
}
