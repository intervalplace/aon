import fs from "fs/promises";
import path from "path";
import { AonObject, assertValidObject, finalizeObject } from "./object.js";

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

// ── Write lock ────────────────────────────────────────────────────────────────
// Prevents concurrent putObject calls from interleaving index writes.
// Node.js is single-threaded but async — without this, two overlapping
// putObject calls can each read the index, modify it, and write back,
// with the second write overwriting the first's changes.

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn);
  // Keep the chain moving even if fn throws
  writeLock = next.then(
    () => {},
    () => {}
  );
  return next;
}


function addUnique(map: Record<string, string[]>, key: string, value: string) {
  const k = key.toLowerCase();
  const v = value.toLowerCase();
  if (!map[k]) map[k] = [];
  if (!map[k].includes(v)) map[k].push(v);
}

function typeNamespaceKey(type: string, namespace: string) {
  return `${type}::${namespace}`;
}

function addToIndexEntry(entry: AonIndexEntry) {
  const h = entry.objectHash.toLowerCase();
  addUnique(index.byType, entry.objectType, h);
  addUnique(index.byNamespace, entry.namespace, h);
  addUnique(index.byTypeNamespace, typeNamespaceKey(entry.objectType, entry.namespace), h);
  for (const ref of entry.references ?? []) {
    addUnique(index.inbound, ref, h);
  }
}

// Full rebuild — used only at startup when loading from disk
function rebuildDerivedIndexes() {
  index.inbound = {};
  index.byType = {};
  index.byNamespace = {};
  index.byTypeNamespace = {};
  for (const entry of Object.values(index.objects)) {
    addToIndexEntry(entry);
  }
}

function shardPath(hash: string) {
  const h = hash.toLowerCase();
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  return path.join(OBJECTS_DIR, clean.slice(0, 2), clean.slice(2, 4), `${h}.json`);
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
      // quarantine corrupt/missing files later
    }
  }
}

export async function saveStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2));
  await fs.rename(tmp, INDEX_PATH);
}

export async function putObject(input: AonObject): Promise<AonObject> {
  // Finalize and validate outside the lock — pure computation, no I/O
  const obj = finalizeObject(input);
  const objectHash = assertValidObject(obj).toLowerCase();
  const file = shardPath(objectHash);
  const rel = path.relative(DATA_DIR, file);

  // Write the shard file outside the lock — it's content-addressed so
  // writing the same file twice is harmless
  if (!(await exists(file))) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, file);
  }

  // Hold the lock only for the in-memory index update and index file write
  return withWriteLock(async () => {
    objects[objectHash] = obj;

    const entry: AonIndexEntry = {
      objectHash,
      objectType: obj.objectType,
      namespace: obj.namespace,
      createdAt: Number(obj.createdAt ?? 0),
      references: obj.references ?? [],
      path: rel,
    };

    index.objects[objectHash] = entry;
    addToIndexEntry(entry); // incremental — no full rebuild needed
    await saveStore();

    return obj;
  });
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
  limit?: number;
  offset?: number;
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

  let out = hashes.map(getObject).filter(Boolean) as AonObject[];

  if (filter?.references) {
    const ref = filter.references.toLowerCase();
    out = out.filter((obj) =>
      (obj.references ?? []).map((r) => r.toLowerCase()).includes(ref)
    );
  }

  const total = out.length;
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? total;
  out = out.slice(offset, offset + limit);

  return { objects: out, total, offset, limit };
}
