import fs from "fs/promises";
import path from "path";
import { AonObject, assertValidObject, finalizeObject } from "./object.js";
import { validateObject } from "./validators/index.js";

const DATA_DIR = process.env.AON_DATA_DIR ?? "data";
const OBJECTS_DIR = path.join(DATA_DIR, "objects");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

type AonIndexEntry = {
  objectHash: string;
  objectType: string;
  namespace: string;
  createdAt: number;
  references: string[];
  path: string;
};

type AonIndex = {
  objects: Record<string, AonIndexEntry>;
};

let index: AonIndex = { objects: {} };
let objects: Record<string, AonObject> = {};

function shardPath(hash: string) {
  const h = hash.toLowerCase();
  const clean = h.startsWith("0x") ? h.slice(2) : h;

  return path.join(
    OBJECTS_DIR,
    clean.slice(0, 2),
    clean.slice(2, 4),
    `${h}.json`
  );
}

async function exists(file: string) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function loadStore() {
  await fs.mkdir(OBJECTS_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    index = JSON.parse(raw);
  } catch {
    index = { objects: {} };
  }

  objects = {};

  for (const entry of Object.values(index.objects)) {
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, entry.path), "utf8");
      const obj = JSON.parse(raw) as AonObject;

      const h = obj.objectHash?.toLowerCase();
      if (!h) continue;

      objects[h] = obj;
    } catch {
      // Skip corrupt/missing object files for now.
      // Later: quarantine and rebuild index.
    }
  }
}

export async function saveStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const tmp = `${INDEX_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2));
  await fs.rename(tmp, INDEX_PATH);
}

export async function putObject(input: AonObject) {
  const obj = finalizeObject(input);
  const objectHash = assertValidObject(obj).toLowerCase();

  await validateObject(obj);

  const file = shardPath(objectHash);
  const rel = path.relative(DATA_DIR, file);

  if (!(await exists(file))) {
    await fs.mkdir(path.dirname(file), { recursive: true });

    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, file);
  }

  objects[objectHash] = obj;

  index.objects[objectHash] = {
    objectHash,
    objectType: obj.objectType,
    namespace: obj.namespace,
    createdAt: Number(obj.createdAt ?? 0),
    references: obj.references ?? [],
    path: rel,
  };

  await saveStore();

  return obj;
}

export function getObject(hash: string) {
  return objects[hash.toLowerCase()] ?? null;
}

export function listObjects(filter?: {
  objectType?: string;
  namespace?: string;
  references?: string;
}) {
  return Object.values(objects).filter((obj) => {
    if (filter?.objectType && obj.objectType !== filter.objectType) return false;
    if (filter?.namespace && obj.namespace !== filter.namespace) return false;

    if (
      filter?.references &&
      !obj.references
        .map((r) => r.toLowerCase())
        .includes(filter.references.toLowerCase())
    ) {
      return false;
    }

    return true;
  });
}
