import fs from "fs/promises";
import path from "path";
import { AonObject, assertValidObject, finalizeObject } from "./object.js";
import { validateObject } from "./validators/index.js";
import { updateGraph } from "./graphUpdater.js";


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
  inbound: Record<string, string[]>;
  byType: Record<string, string[]>;
  byNamespace: Record<string, string[]>;
  byTypeNamespace: Record<string, string[]>;
};

function emptyIndex(): AonIndex {
  return {
    objects: {},
    inbound: {},
    byType: {},
    byNamespace: {},
    byTypeNamespace: {},
  };
}

let index: AonIndex = emptyIndex();
let objects: Record<string, AonObject> = {};

function addUnique(map: Record<string, string[]>, key: string, value: string) {
  const k = key.toLowerCase();
  const v = value.toLowerCase();

  if (!map[k]) map[k] = [];
  if (!map[k].includes(v)) map[k].push(v);
}

function typeNamespaceKey(type: string, namespace: string) {
  return `${type}::${namespace}`;
}

function rebuildDerivedIndexes() {
  index.inbound = {};
  index.byType = {};
  index.byNamespace = {};
  index.byTypeNamespace = {};

  for (const entry of Object.values(index.objects)) {
    const h = entry.objectHash.toLowerCase();

    addUnique(index.byType, entry.objectType, h);
    addUnique(index.byNamespace, entry.namespace, h);
    addUnique(index.byTypeNamespace, typeNamespaceKey(entry.objectType, entry.namespace), h);

    for (const ref of entry.references ?? []) {
      addUnique(index.inbound, ref, h);
    }
  }
}

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
    const parsed = JSON.parse(raw);

    index = {
      ...emptyIndex(),
      ...parsed,
      objects: parsed.objects ?? {},
    };

    rebuildDerivedIndexes();
  } catch {
    index = emptyIndex();
  }

  objects = {};

  for (const entry of Object.values(index.objects)) {
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, entry.path), "utf8");
      const obj = JSON.parse(raw) as AonObject;
      const h = obj.objectHash?.toLowerCase();

      if (h) objects[h] = obj;
    } catch {
      // Later: quarantine corrupt/missing files.
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

rebuildDerivedIndexes();
await saveStore();

await updateGraph(obj);

return obj;
}

export function getObject(hash: string) {
  return objects[hash.toLowerCase()] ?? null;
}

export function getInboundObjectHashes(hash: string) {
  return index.inbound[hash.toLowerCase()] ?? [];
}

export function getInboundObjects(hash: string) {
  return getInboundObjectHashes(hash)
    .map(getObject)
    .filter(Boolean) as AonObject[];
}

export function listObjects(filter?: {
  objectType?: string;
  namespace?: string;
  references?: string;
}) {
  let hashes: string[];

  if (filter?.objectType && filter?.namespace) {
    hashes = index.byTypeNamespace[
      typeNamespaceKey(filter.objectType, filter.namespace).toLowerCase()
    ] ?? [];
  } else if (filter?.objectType) {
    hashes = index.byType[filter.objectType.toLowerCase()] ?? [];
  } else if (filter?.namespace) {
    hashes = index.byNamespace[filter.namespace.toLowerCase()] ?? [];
  } else {
    hashes = Object.keys(index.objects);
  }

  let out = hashes
    .map(getObject)
    .filter(Boolean) as AonObject[];

  if (filter?.references) {
    const ref = filter.references.toLowerCase();
    out = out.filter((obj) =>
      (obj.references ?? []).map((r) => r.toLowerCase()).includes(ref)
    );
  }

  return out;
}
