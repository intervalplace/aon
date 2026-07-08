import Database from "better-sqlite3";
import { mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { AonObject, assertValidObject, finalizeObject } from "./object.js";

const DATA_DIR = process.env.AON_DATA_DIR ?? "data";
const DB_PATH  = path.join(DATA_DIR, "aon.db");

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance.
// NORMAL synchronous is safe with WAL — only risks data loss on OS crash,
// not corruption. Acceptable for a p2p node.
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS objects (
    hash       TEXT PRIMARY KEY,
    objectType TEXT,
    namespace  TEXT,
    createdAt  INTEGER,
    data       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_type    ON objects(objectType);
  CREATE INDEX IF NOT EXISTS idx_ns      ON objects(namespace);
  CREATE INDEX IF NOT EXISTS idx_created ON objects(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_type_ns ON objects(objectType, namespace);

  CREATE TABLE IF NOT EXISTS refs (
    sourceHash TEXT NOT NULL,
    targetHash TEXT NOT NULL,
    PRIMARY KEY (sourceHash, targetHash)
  );

  CREATE INDEX IF NOT EXISTS idx_ref_target ON refs(targetHash);
`);

// ── Prepared statements ───────────────────────────────────────────────────────

const stmtInsert    = db.prepare(`INSERT OR IGNORE INTO objects (hash, objectType, namespace, createdAt, data) VALUES (@hash, @objectType, @namespace, @createdAt, @data)`);
const stmtInsertRef = db.prepare(`INSERT OR IGNORE INTO refs (sourceHash, targetHash) VALUES (@sourceHash, @targetHash)`);
const stmtGet       = db.prepare(`SELECT data FROM objects WHERE hash = ?`);
const stmtExists    = db.prepare(`SELECT hash FROM objects WHERE hash = ? LIMIT 1`);
const stmtCountAll  = db.prepare(`SELECT COUNT(*) as c FROM objects`);
const stmtCountType = db.prepare(`SELECT COUNT(*) as c FROM objects WHERE objectType = ?`);
const stmtCountNs   = db.prepare(`SELECT COUNT(*) as c FROM objects WHERE namespace = ?`);
const stmtCountTyNs = db.prepare(`SELECT COUNT(*) as c FROM objects WHERE objectType = ? AND namespace = ?`);
const stmtListAll   = db.prepare(`SELECT data FROM objects ORDER BY createdAt DESC LIMIT ? OFFSET ?`);
const stmtListType  = db.prepare(`SELECT data FROM objects WHERE objectType = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`);
const stmtListNs    = db.prepare(`SELECT data FROM objects WHERE namespace = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`);
const stmtListTyNs  = db.prepare(`SELECT data FROM objects WHERE objectType = ? AND namespace = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`);
const stmtInbound   = db.prepare(`SELECT sourceHash FROM refs WHERE targetHash = ?`);
// Sync: keyset pagination over hashes. ORDER BY hash (the primary key) is
// stable under concurrent inserts — unlike createdAt DESC, new objects can't
// shift pages mid-sync.
const stmtListHashes = db.prepare(`SELECT hash FROM objects WHERE hash > ? ORDER BY hash LIMIT ?`);
// H1: references filter — objects that reference a given target hash
const stmtListByRef      = db.prepare(`SELECT o.data FROM objects o INNER JOIN refs r ON r.sourceHash = o.hash WHERE r.targetHash = ? ORDER BY o.createdAt DESC LIMIT ? OFFSET ?`);
const stmtCountByRef     = db.prepare(`SELECT COUNT(*) as c FROM objects o INNER JOIN refs r ON r.sourceHash = o.hash WHERE r.targetHash = ?`);

// ── Transaction: insert object + its refs atomically ─────────────────────────

const txnPut = db.transaction((obj: AonObject) => {
  const hash = obj.objectHash!.toLowerCase();
  if (stmtExists.get(hash)) return;

  stmtInsert.run({
    hash,
    objectType: obj.objectType ?? null,
    namespace:  obj.namespace  ?? null,
    createdAt:  obj.createdAt  ?? null,
    data:       JSON.stringify(obj),
  });

  for (const ref of obj.references ?? []) {
    stmtInsertRef.run({ sourceHash: hash, targetHash: ref.toLowerCase() });
  }
});

// ── Migration from old file-based store ──────────────────────────────────────

function migrateFromFiles() {
  const indexPath = path.join(DATA_DIR, "index.json");
  if (!existsSync(indexPath)) return;
  if (((stmtCountAll.get() as any)?.c ?? 0) > 0) return;

  console.log("[store] Migrating from file-based store to SQLite...");
  let count = 0;
  try {
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    for (const entry of Object.values(index.objects ?? {}) as any[]) {
      try {
        const filePath = path.join(DATA_DIR, entry.path);
        if (!existsSync(filePath)) continue;
        const obj = JSON.parse(readFileSync(filePath, "utf8")) as AonObject;
        txnPut(obj);
        count++;
      } catch { /* skip corrupt entries */ }
    }
  } catch { /* index unreadable */ }
  console.log(`[store] Migrated ${count} objects to SQLite`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function loadStore() {
  migrateFromFiles();
  const total = (stmtCountAll.get() as any)?.c ?? 0;
  console.log(`[store] SQLite ready at ${DB_PATH} — ${total} objects`);
}

export async function putObject(input: AonObject): Promise<AonObject> {
  const obj = finalizeObject(input);
  assertValidObject(obj);
  txnPut(obj);
  return obj;
}

export function hasObject(hash: string): boolean {
  return stmtExists.get(hash.toLowerCase()) !== undefined;
}

// Page of object hashes for sync, hash-ordered (stable keyset pagination).
// Optional namespaces filter scopes the page to the given namespaces —
// used by namespace-subscribed sync (see sync.ts).
export function listHashes(opts?: { after?: string | null; limit?: number; namespaces?: string[] }) {
  const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1_000));
  const after = (opts?.after ?? "").toLowerCase();
  const ns = (opts?.namespaces ?? [])
    .filter((x) => typeof x === "string" && x.length > 0 && x.length <= 256)
    .slice(0, 64);

  let rows: { hash: string }[];
  if (ns.length === 0) {
    rows = stmtListHashes.all(after, limit) as { hash: string }[];
  } else {
    const placeholders = ns.map(() => "?").join(",");
    rows = db
      .prepare(`SELECT hash FROM objects WHERE hash > ? AND namespace IN (${placeholders}) ORDER BY hash LIMIT ?`)
      .all(after, ...ns, limit) as { hash: string }[];
  }
  const hashes = rows.map((r) => r.hash);
  return { hashes, done: hashes.length < limit };
}

export function getObject(hash: string): AonObject | null {
  const row = stmtGet.get(hash.toLowerCase()) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}

export function getInboundObjects(hash: string): AonObject[] {
  return (stmtInbound.all(hash.toLowerCase()) as { sourceHash: string }[])
    .map(r => getObject(r.sourceHash))
    .filter((o): o is AonObject => o !== null);
}

export function listObjects(filter?: {
  objectType?: string;
  namespace?:  string;
  references?: string;   // H1: filter to objects that reference this hash
  limit?:      number;
  offset?:     number;
}) {
  const limit  = filter?.limit  ?? 50;
  const offset = filter?.offset ?? 0;
  const type   = filter?.objectType;
  const ns     = filter?.namespace;
  const ref    = filter?.references?.toLowerCase();

  let rows:  { data: string }[];
  let total: number;

  // H1: references filter takes precedence when provided
  if (ref) {
    rows  = stmtListByRef.all(ref, limit, offset) as { data: string }[];
    total = ((stmtCountByRef.get(ref) as any)?.c ?? 0);
  } else if (type && ns) {
    rows  = stmtListTyNs.all(type, ns, limit, offset) as { data: string }[];
    total = ((stmtCountTyNs.get(type, ns) as any)?.c ?? 0);
  } else if (type) {
    rows  = stmtListType.all(type, limit, offset) as { data: string }[];
    total = ((stmtCountType.get(type) as any)?.c ?? 0);
  } else if (ns) {
    rows  = stmtListNs.all(ns, limit, offset) as { data: string }[];
    total = ((stmtCountNs.get(ns) as any)?.c ?? 0);
  } else {
    rows  = stmtListAll.all(limit, offset) as { data: string }[];
    total = ((stmtCountAll.get() as any)?.c ?? 0);
  }

  return {
    objects: rows.map(r => JSON.parse(r.data) as AonObject),
    total,
    offset,
    limit,
  };
}
