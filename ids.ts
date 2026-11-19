// Opaque, stable global ids (the GraphQL `id` fields and REST `node_id`s).
// They encode a type tag plus numeric ids in base64url, so the same object
// always reads back the same id, and an id never equals a database id or a
// bare issue/PR number.

function encode(tag: string, parts: Array<string | number>): string {
  const raw = `${tag}:${parts.join(':')}`;
  return `${tag[0] ?? 'X'}_` + Buffer.from(raw, 'utf8').toString('base64url');
}

function decode(id: string): { tag: string; parts: string[] } | undefined {
  const match = /^([A-Z])_(.+)$/.exec(id);
  if (match === null) return undefined;
  const raw = Buffer.from(match[2] ?? '', 'base64url').toString('utf8');
  const segments = raw.split(':');
  const tag = segments.shift();
  if (tag === undefined) return undefined;
  return { tag, parts: segments };
}

export function repoGlobalId(repoId: number): string {
  return encode('Repository', [repoId]);
}

export function issueGlobalId(repoId: number, number: number): string {
  return encode('Issue', [repoId, number]);
}

export function pullGlobalId(repoId: number, number: number): string {
  return encode('PullRequest', [repoId, number]);
}

export function commentGlobalId(repoId: number, issueNumber: number, commentId: number): string {
  return encode('IssueComment', [repoId, issueNumber, commentId]);
}

/** Decode a global id into its kind and numeric parts, or undefined. */
export function decodeGlobalId(
  id: string,
): { kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment'; repoId: number; number: number; commentId: number } | undefined {
  const decoded = decode(id);
  if (decoded === undefined) return undefined;
  const repoId = Number(decoded.parts[0]);
  if (!Number.isInteger(repoId)) return undefined;
  if (decoded.tag === 'Repository') return { kind: 'Repository', repoId, number: 0, commentId: 0 };
  const number = Number(decoded.parts[1]);
  if (!Number.isInteger(number)) return undefined;
  if (decoded.tag === 'Issue') return { kind: 'Issue', repoId, number, commentId: 0 };
  if (decoded.tag === 'PullRequest') return { kind: 'PullRequest', repoId, number, commentId: 0 };
  if (decoded.tag === 'IssueComment') {
    const commentId = Number(decoded.parts[2]);
    if (!Number.isInteger(commentId)) return undefined;
    return { kind: 'IssueComment', repoId, number, commentId };
  }
  return undefined;
}
