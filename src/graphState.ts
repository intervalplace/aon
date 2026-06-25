import fs from "fs/promises";
import path from "path";

const DATA_DIR = process.env.AON_DATA_DIR ?? "data";
const GRAPH_STATE_PATH = path.join(DATA_DIR, "graph-state.json");

export type CandidateStatus =
  | "candidate"
  | "waiting"
  | "executable"
  | "invalid"
  | "consumed"
  | "revoked"
  | "expired";

export type GraphStatus =
  | "waiting_reserve"
  | "waiting_proof"
  | "waiting_fill"
  | "executable"
  | "consumed"
  | "revoked"
  | "expired";

export type Candidate = {
  objectHash: string;
  objectType: string;
  status: CandidateStatus;
  reason?: string;
  updatedAt: number;
};

export type AuthorizationGraph = {
  authorization: string;
  namespace: string;
  reserve?: string;
  proofs: Candidate[];
  fills: Candidate[];
  receipts: Candidate[];
  status: GraphStatus;
  updatedAt: number;
};

type GraphStateDb = {
  version: 1;
  graphs: Record<string, AuthorizationGraph>;
};

let state: GraphStateDb = {
  version: 1,
  graphs: {},
};

function nowMs() {
  return Date.now();
}

function lowerHash(hash: string) {
  return hash.toLowerCase();
}

function emptyGraph(args: {
  authorizationHash: string;
  namespace: string;
}): AuthorizationGraph {
  return {
    authorization: lowerHash(args.authorizationHash),
    namespace: args.namespace,
    proofs: [],
    fills: [],
    receipts: [],
    status: "waiting_reserve",
    updatedAt: nowMs(),
  };
}

function upsertCandidate(
  list: Candidate[],
  candidate: Candidate
) {
  const h = lowerHash(candidate.objectHash);
  const existing = list.find((c) => lowerHash(c.objectHash) === h);

  if (existing) {
    existing.status = candidate.status;
    existing.reason = candidate.reason;
    existing.updatedAt = candidate.updatedAt;
    return existing;
  }

  list.push({
    ...candidate,
    objectHash: h,
  });

  return list[list.length - 1];
}

export async function loadGraphState() {
  try {
    const raw = await fs.readFile(GRAPH_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    state = {
      version: 1,
      graphs: parsed.graphs ?? {},
    };
  } catch {
    state = {
      version: 1,
      graphs: {},
    };
  }
}

export async function saveGraphState() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const tmp = `${GRAPH_STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, GRAPH_STATE_PATH);
}

export function getGraphState() {
  return state;
}

export function getAuthorizationGraph(
  authorizationHash: string
) {
  return state.graphs[lowerHash(authorizationHash)] ?? null;
}

export function ensureAuthorizationGraph(args: {
  authorizationHash: string;
  namespace: string;
}) {
  const h = lowerHash(args.authorizationHash);

  if (!state.graphs[h]) {
    state.graphs[h] = emptyGraph({
      authorizationHash: h,
      namespace: args.namespace,
    });
  }

  return state.graphs[h];
}

export function listAuthorizationGraphs(filter?: {
  namespace?: string;
  status?: GraphStatus;
}) {
  return Object.values(state.graphs).filter((g) => {
    if (filter?.namespace && g.namespace !== filter.namespace) return false;
    if (filter?.status && g.status !== filter.status) return false;
    return true;
  });
}

export function listExecutableGraphs(namespace?: string) {
  return listAuthorizationGraphs({
    namespace,
    status: "executable",
  });
}

export function setGraphReserve(args: {
  authorizationHash: string;
  namespace: string;
  reserveHash: string;
}) {
  const graph = ensureAuthorizationGraph({
    authorizationHash: args.authorizationHash,
    namespace: args.namespace,
  });

  graph.reserve = lowerHash(args.reserveHash);
  graph.status = "waiting_proof";
  graph.updatedAt = nowMs();

  return graph;
}

export function addProofCandidate(args: {
  authorizationHash: string;
  namespace: string;
  proofHash: string;
  status?: CandidateStatus;
  reason?: string;
}) {
  const graph = ensureAuthorizationGraph({
    authorizationHash: args.authorizationHash,
    namespace: args.namespace,
  });

  const candidate = upsertCandidate(graph.proofs, {
    objectHash: args.proofHash,
    objectType: "proof",
    status: args.status ?? "candidate",
    reason: args.reason,
    updatedAt: nowMs(),
  });

  graph.updatedAt = nowMs();

  return { graph, candidate };
}

export function addFillCandidate(args: {
  authorizationHash: string;
  namespace: string;
  fillHash: string;
  status?: CandidateStatus;
  reason?: string;
}) {
  const graph = ensureAuthorizationGraph({
    authorizationHash: args.authorizationHash,
    namespace: args.namespace,
  });

  const candidate = upsertCandidate(graph.fills, {
    objectHash: args.fillHash,
    objectType: "fill",
    status: args.status ?? "candidate",
    reason: args.reason,
    updatedAt: nowMs(),
  });

  graph.updatedAt = nowMs();

  return { graph, candidate };
}

export function addReceiptCandidate(args: {
  authorizationHash: string;
  namespace: string;
  receiptHash: string;
  status?: CandidateStatus;
  reason?: string;
}) {
  const graph = ensureAuthorizationGraph({
    authorizationHash: args.authorizationHash,
    namespace: args.namespace,
  });

  const candidate = upsertCandidate(graph.receipts, {
    objectHash: args.receiptHash,
    objectType: "receipt",
    status: args.status ?? "consumed",
    reason: args.reason,
    updatedAt: nowMs(),
  });

  graph.status = "consumed";
  graph.updatedAt = nowMs();

  return { graph, candidate };
}

export function markCandidateStatus(args: {
  authorizationHash: string;
  candidateHash: string;
  status: CandidateStatus;
  reason?: string;
}) {
  const graph = getAuthorizationGraph(args.authorizationHash);
  if (!graph) return null;

  const h = lowerHash(args.candidateHash);
  const all = [...graph.proofs, ...graph.fills, ...graph.receipts];
  const candidate = all.find((c) => lowerHash(c.objectHash) === h);

  if (!candidate) return null;

  candidate.status = args.status;
  candidate.reason = args.reason;
  candidate.updatedAt = nowMs();

  if (args.status === "executable") {
    graph.status = "executable";
  }

  if (args.status === "consumed") {
    graph.status = "consumed";
  }

  graph.updatedAt = nowMs();

  return { graph, candidate };
}

export function markGraphRevoked(authorizationHash: string) {
  const graph = getAuthorizationGraph(authorizationHash);
  if (!graph) return null;

  graph.status = "revoked";
  graph.updatedAt = nowMs();

  for (const c of [...graph.proofs, ...graph.fills]) {
    if (c.status === "candidate" || c.status === "waiting" || c.status === "executable") {
      c.status = "revoked";
      c.reason = "AUTHORIZATION_REVOKED";
      c.updatedAt = nowMs();
    }
  }

  return graph;
}
