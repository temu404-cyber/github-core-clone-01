// Git object store primitives: SHA-1 object ids, trees, commits, tags,
// packfile read/write (plain objects only on write; OFS/REF deltas resolved
// on read), and pkt-line framing. No git binary, only node:crypto and
// node:zlib. Written from the git object format and protocol v2/v0 specs.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of "<type> <len>\0" + data, as a lowercase hex object id. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The raw bytes of a loose object (header + data), for hashing checks. */
export function objectBytes(type: GitObjectType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize tree entries, sorted the way git sorts them (a directory sorts as "name/"). */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit. `author`/`committer` are full "<name> <email> <epoch> +0000" lines. */
export function encodeCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The commit timestamp (epoch seconds) from its author line, or 0. */
export function commitEpoch(authorLine: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(authorLine);
  return match === null ? 0 : Number(match[1]);
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line (payload + "\n" already included by the caller when needed). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' }
  | { kind: 'data'; payload: Buffer };

/** Decode pkt-lines from a buffer; throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(length) || length < 0 || length > 65520) {
      throw new Error(`bad pkt-line length ${JSON.stringify(buffer.subarray(offset, offset + 4).toString('ascii'))}`);
    }
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** The text lines of data packets (without trailing "\n"), ignoring flush/delim. */
export function pktTextLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- packfiles

function encodePackEntryHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    out.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(b);
  return Buffer.from(out);
}

/** Build a packfile (version 2, plain objects, no deltas) from resolved objects. */
export function writePack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(encodePackEntryHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A pack entry's declared size varint, read at `offset`. */
function readVarintSize(buffer: Buffer, offset: number): { size: number; next: number } {
  let byte = buffer[offset] ?? 0;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { size, next };
}

/** OFS_DELTA's base offset varint, read at `offset`. */
function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset] ?? 0;
  let baseOffset = byte & 0x7f;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { baseOffset, next };
}

function readDeltaVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = offset;
  for (;;) {
    const byte = buffer[next] ?? 0;
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next };
}

/** Apply a git binary delta to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readDeltaVarint(delta, offset);
  offset = source.next;
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const target = readDeltaVarint(delta, offset);
  offset = target.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] ?? 0;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          copyOffset |= (delta[offset] ?? 0) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          copySize |= (delta[offset] ?? 0) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      out.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== target.value || produced !== target.value) {
    throw new Error('delta target size mismatch');
  }
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out (an object the
 * client already has, looked up in the server's store).
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    // The type lives in bits 4-6 of the entry's first byte.
    const firstByte = pack[entryOffset] ?? 0;
    const realTypeCode = (firstByte >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode: realTypeCode, size: header.size, data: Buffer.alloc(0) };
    if (realTypeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (realTypeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[realTypeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${realTypeCode}`);
    }
    const inflated = zlibInflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const written = inflated.engine.bytesWritten;
    if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
    if (inflated.buffer.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.buffer.length}`);
    }
    entry.data = inflated.buffer;
    offset += written;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry, seen: Set<number>): GitObject => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
      seen.add(entry.offset);
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry, seen);
      } else if (entry.baseOid !== undefined) {
        const baseEntry = raw.find((candidate) => {
          if (candidate.typeCode === 6 || candidate.typeCode === 7) return false;
          return objectId(CODE_TYPE[candidate.typeCode] as GitObjectType, candidate.data) === entry.baseOid;
        });
        if (baseEntry !== undefined) base = resolve(baseEntry, seen);
        else base = options.resolveBase?.(entry.baseOid);
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      } else {
        throw new Error('delta entry has no base');
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    const type = CODE_TYPE[entry.typeCode] as GitObjectType;
    return { type, data: entry.data };
  };

  for (const entry of raw) {
    const object = resolve(entry, new Set());
    objects.set(objectId(object.type, object.data), object);
  }
  return { objects, deltaCount };
}
