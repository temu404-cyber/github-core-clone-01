// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP in
// one process over the in-memory store. Kept separate from main.ts, which
// owns the entry <-> env lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  commitEpoch,
  decodePktLines,
  encodeTree,
  objectId,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The request's path, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token authorizes when it matches the trial's token (or, when the trial set none, any non-empty token). */
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

// ---------------------------------------------------------------- git helpers

interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
}

function sortedRefs(store: Store, repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const entry: AdvertisedRef = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = store.peelToCommit(repo, oid);
      if (peeled !== undefined) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main side-band-64k thin-pack no-progress ofs-delta multi_ack_detailed shallow agent=forge/1.0'
      : 'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(store, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

/** All tree and blob objects under a tree, recursively. */
function treeObjects(store: Store, repo: Repo, treeOid: string): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const walk = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree' || out.has(oid)) return;
    out.set(oid, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined && !out.has(entry.oid)) out.set(entry.oid, blob);
      }
    }
  };
  walk(treeOid);
  return out;
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  done: boolean;
}

/** Decide which objects a fetch sends, which shallow boundaries move, and which refs the wants name. */
function computeFetch(store: Store, repo: Repo, request: FetchRequest): FetchPlan {
  // Objects the client already owns: the haves' closures — stopping at the
  // shallow boundaries, whose ancestors the client does not have — and the
  // shallow boundaries' own commit + tree closure (never their ancestors).
  const ownedCommits = new Set<string>();
  const ownedObjects = new Map<string, GitObject>();
  const boundarySet = new Set(request.shallowBoundaries);
  for (const have of request.haves) {
    for (const commit of store.reachableCommits(repo, have, boundarySet)) ownedCommits.add(commit);
  }
  for (const oid of ownedCommits) {
    const commit = repo.objects.get(oid);
    if (commit !== undefined) ownedObjects.set(oid, commit);
    const info = store.commitOf(repo, oid);
    if (info !== undefined) {
      for (const [treeOid, object] of treeObjects(store, repo, info.tree)) ownedObjects.set(treeOid, object);
    }
  }
  for (const boundary of request.shallowBoundaries) {
    const commit = store.commitOf(repo, boundary);
    if (commit === undefined) continue;
    const object = repo.objects.get(boundary);
    if (object !== undefined) ownedObjects.set(boundary, object);
    for (const [oid, object2] of treeObjects(store, repo, commit.tree)) ownedObjects.set(oid, object2);
  }
  const excludedCommits = new Set<string>();
  for (const ref of request.deepenNot) {
    const tip = store.resolveRef(repo, ref);
    if (tip === undefined) continue;
    const commit = store.peelToCommit(repo, tip);
    if (commit === undefined) continue;
    for (const ancestor of store.reachableCommits(repo, commit)) excludedCommits.add(ancestor);
  }

  const included = new Set<string>();
  const extraObjects = new Map<string, GitObject>();

  const walkCommit = (oid: string, distance: number): void => {
    if (included.has(oid) || excludedCommits.has(oid)) return;
    const isBoundary = request.shallowBoundaries.includes(oid);
    if (isBoundary) {
      // The client owns this commit; when deepening, descend past it
      // without including it. Without a deepen, its history stays hidden.
      if (request.depth === undefined && request.deepenSince === undefined) return;
      const commit = store.commitOf(repo, oid);
      if (commit === undefined) return;
      for (const parent of commit.parents) walkCommit(parent, distance + 1);
      return;
    }
    if (ownedCommits.has(oid)) return;
    if (request.depth !== undefined && distance > request.depth) return;
    if (request.deepenSince !== undefined) {
      const commit = store.commitOf(repo, oid);
      if (commit !== undefined && commitEpoch(commit.author) < request.deepenSince) {
        // A boundary commit: include it, but not its ancestors.
        included.add(oid);
        return;
      }
    }
    included.add(oid);
    const commit = store.commitOf(repo, oid);
    if (commit === undefined) return;
    for (const parent of commit.parents) walkCommit(parent, distance + 1);
  };

  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraObjects.set(want, object);
      const tag = parseTag(object.data);
      if (tag.type === 'commit') {
        const target = store.peelToCommit(repo, want);
        if (target !== undefined) walkCommit(target, 1);
      } else {
        const target = repo.objects.get(tag.object);
        if (target !== undefined) extraObjects.set(tag.object, target);
      }
      continue;
    }
    if (object.type === 'commit') {
      walkCommit(want, 1);
      continue;
    }
    extraObjects.set(want, object);
  }

  const objects = new Map<string, GitObject>();
  for (const oid of included) {
    const commit = repo.objects.get(oid);
    if (commit !== undefined) objects.set(oid, commit);
    const info = store.commitOf(repo, oid);
    if (info !== undefined) {
      for (const [treeOid, object] of treeObjects(store, repo, info.tree)) objects.set(treeOid, object);
    }
  }
  for (const [oid, object] of extraObjects) objects.set(oid, object);
  for (const oid of ownedObjects.keys()) objects.delete(oid);

  // The new shallow boundaries: included commits whose parents are missing
  // from the client's store after this fetch. The old boundaries whose
  // parents are now present stop being boundaries.
  const ownedAfter = new Set<string>([...ownedCommits, ...request.shallowBoundaries, ...included]);
  const shallow: string[] = [];
  for (const oid of included) {
    const commit = store.commitOf(repo, oid);
    if (commit === undefined) continue;
    if (commit.parents.some((parent) => !ownedAfter.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of request.shallowBoundaries) {
    const commit = store.commitOf(repo, boundary);
    if (commit === undefined || commit.parents.length === 0) continue;
    if (commit.parents.every((parent) => ownedAfter.has(parent))) unshallow.push(boundary);
  }

  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of request.wants) {
    for (const ref of sortedRefs(store, repo)) {
      if (ref.oid === want) wantedRefs.push({ oid: want, ref: ref.name });
    }
  }

  return { objects, shallow, unshallow, wantedRefs };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) {
    // An empty pack still travels as one band-1 packet.
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return out;
}

function handleLsRefsV2(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue; // command=, agent=, object-format= lines
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headTip !== undefined) {
    if (headMatches) {
      lines.push(pktLine(symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headTip} HEAD\n`));
    }
  } else if (unborn && headMatches) {
    lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of sortedRefs(store, repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    const suffix = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
    lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function parseFetchV2(packets: ReturnType<typeof decodePktLines>): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], deepenNot: [], done: false };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    else if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') request.done = true;
  }
  return request;
}

function handleFetchV2(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  const request = parseFetchV2(packets);
  const plan = computeFetch(store, repo, request);
  const pack = writePack([...plan.objects.values()]);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n')];
  if (request.done) parts.push(pktLine('ready\n'));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of plan.wantedRefs) parts.push(pktLine(`${ref.oid} ${ref.ref}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], deepenNot: [], done: false };
  let inSecondSection = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inSecondSection = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inSecondSection) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        request.wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
      else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line === 'done') request.done = true;
    }
  }
  const plan = computeFetch(store, repo, request);
  const pack = writePack([...plan.objects.values()]);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Split a receive-pack body into its command pkt-lines and the pack that follows the flush. */
function splitReceivePack(body: Buffer): { commands: Array<{ old: string; newOid: string; ref: string }>; pack: Buffer } {
  let offset = 0;
  const commands: Array<{ old: string; newOid: string; ref: string }> = [];
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(length) || length < 0 || length > 65520) throw new Error('bad pkt-line length in receive-pack');
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4) throw new Error('bad pkt-line length in receive-pack');
    const payload = body.subarray(offset + 4, offset + length);
    const line = payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const main = nul >= 0 ? line.slice(0, nul) : line;
    const parts = main.split(' ');
    if (parts.length < 3 || parts[0] === undefined || parts[1] === undefined) {
      throw new Error('bad receive-pack command');
    }
    commands.push({ old: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    offset += length;
  }
  return { commands, pack: body.subarray(offset) };
}

function applyPushCommand(store: Store, repo: Repo, command: { old: string; newOid: string; ref: string }): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
    if (current !== command.old) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  if (command.old === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'object not found' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update: the old value must match, and the new tip must descend from it.
  if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
  if (current !== command.old) return { ok: false, reason: 'non-fast-forward' };
  const newCommit = store.peelToCommit(repo, command.newOid);
  const oldCommit = store.peelToCommit(repo, command.old);
  if (newCommit === undefined || oldCommit === undefined) return { ok: false, reason: 'non-fast-forward' };
  if (!store.isAncestor(repo, oldCommit, newCommit)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = splitReceivePack(body);
  let unpacked = new Map<string, GitObject>();
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      unpacked = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) }).objects;
    } catch {
      unpackOk = false;
      unpackDetail = 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const [oid, object] of unpacked) repo.objects.set(oid, object);
  }
  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const result = applyPushCommand(store, repo, command);
    reportLines.push(result.ok ? `ok ${command.ref}` : `ng ${command.ref} ${result.reason}`);
  }
  const parts: Buffer[] = [
    pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(`Counting objects: ${unpacked.size}, done.\n`, 'utf8')])),
  ];
  for (const line of reportLines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- server

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const query = queryOf(req);

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] ?? '');
          const repoName = decodeURIComponent(gitMatch[2] ?? '');
          const subpath = gitMatch[3] ?? '';
          const repo = owner === store.viewer ? store.getRepo(owner, repoName) : undefined;
          if (subpath === '/info/refs' && method === 'GET') {
            const service = query.get('service');
            if (repo === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            if (service === 'git-upload-pack') {
              const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
              sendBuffer(res, 200, isV2 ? v2Advertisement() : v0Advertisement(store, repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuffer(res, 200, v0Advertisement(store, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (subpath === '/git-upload-pack' && method === 'POST') {
            if (repo === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readBody(req);
            let packets;
            try {
              packets = decodePktLines(body);
            } catch {
              sendJson(res, 400, { message: 'Bad request' });
              return;
            }
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            if (isV2) {
              const first = packets.find((packet) => packet.kind === 'data');
              const command = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
              if (command === 'command=ls-refs') {
                sendBuffer(res, 200, handleLsRefsV2(store, repo, packets), 'application/x-git-upload-pack-result');
                return;
              }
              if (command === 'command=fetch') {
                sendBuffer(res, 200, handleFetchV2(store, repo, packets), 'application/x-git-upload-pack-result');
                return;
              }
              sendJson(res, 400, { message: 'Bad request' });
              return;
            }
            sendBuffer(res, 200, handleFetchV0(store, repo, packets), 'application/x-git-upload-pack-result');
            return;
          }
          if (subpath === '/git-receive-pack' && method === 'POST') {
            if (repo === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readBody(req);
            try {
              sendBuffer(res, 200, handleReceivePack(store, repo, body), 'application/x-git-receive-pack-result');
            } catch {
              sendJson(res, 400, { message: 'Bad request' });
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
          let body: unknown;
          let bodyValid = true;
          if (needsBody) {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                bodyValid = false;
              }
            }
          }
          const host = req.headers.host ?? '127.0.0.1';
          const result = handleRest(store, method, restPath, query, body, bodyValid, host);
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown = {};
          try {
            body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' });
            return;
          }
          sendJson(res, 200, executeGraphQL(store, body));
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, raw.toString('utf8'));
          if (result.status === 202 || result.body === null) {
            res.writeHead(result.status, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
}

export { encodeTree, objectId };
