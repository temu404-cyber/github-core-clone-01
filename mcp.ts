// Model Context Protocol at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks the modern revision (2026-07-28) through server/discover, and the
// legacy handshake (2025-11-25 and earlier) through initialize. The tools act
// on the same store as REST, so a repository or issue created over MCP reads
// back over /api/v3 as the same object.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Store } from './store.ts';

export interface McpResult {
  status: number;
  headers?: Record<string, string>;
  /** JSON body, or null for an empty (202 notification) reply. */
  body: unknown;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'forge-session-1';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The tool list, built once so two tools/list calls answer byte for byte. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const ALIASES: Record<string, string> = {
  createrepository: 'create_repo',
  repocreate: 'create_repo',
  reposcreate: 'create_repo',
  repositorycreate: 'create_repo',
  getrepository: 'get_repo',
  repoget: 'get_repo',
  reposget: 'get_repo',
  repositoryget: 'get_repo',
  issuecreate: 'create_issue',
  issuescreate: 'create_issue',
  issueslist: 'list_issues',
  issuelist: 'list_issues',
  pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const normalized = normalizeToolName(name);
  const canonical: Record<string, string> = {
    createrepo: 'create_repo',
    getrepo: 'get_repo',
    createissue: 'create_issue',
    listissues: 'list_issues',
    createpullrequest: 'create_pull_request',
    mergepullrequest: 'merge_pull_request',
  };
  let target = canonical[normalized] ?? ALIASES[normalized];
  if (target === undefined) {
    // A server prefix on the name is allowed: match as a suffix.
    for (const [key, value] of Object.entries(canonical)) {
      if (normalized.endsWith(key)) {
        target = value;
        break;
      }
    }
    if (target === undefined) {
      for (const [key, value] of Object.entries(ALIASES)) {
        if (normalized.endsWith(key)) {
          target = value;
          break;
        }
      }
    }
  }
  if (target === undefined) return undefined;
  return TOOLS.find((tool) => tool.name === target);
}

/** Pick the first defined argument among several candidate names. */
function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** Split a "owner/repo" full_name into [owner, repo]. */
function splitFullName(args: Record<string, unknown>): [string | undefined, string | undefined] {
  const fullName = pickArg(args, 'full_name', 'fullName', 'repository_full_name');
  if (typeof fullName !== 'string') return [undefined, undefined];
  const slash = fullName.indexOf('/');
  if (slash < 0) return [undefined, undefined];
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } {
  const [fullOwner, fullRepo] = splitFullName(args);
  const owner = pickArg(args, 'owner', 'owner_login', 'org', 'user', 'login', 'namespace');
  const repo = pickArg(args, 'repo', 'repository', 'repo_name', 'project');
  return {
    owner: typeof owner === 'string' ? owner : (fullOwner ?? ''),
    repo: typeof repo === 'string' ? repo : (fullRepo ?? ''),
  };
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return {
    status: 200,
    headers: { 'mcp-session-id': SESSION_ID },
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
  };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return {
    status: 200,
    headers: { 'mcp-session-id': SESSION_ID },
    body: { jsonrpc: '2.0', id: id ?? null, result },
  };
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === undefined) return toolError(`Unknown tool: ${name}`);
  // The required arguments the suite can fill; anything else is an error.
  for (const required of tool.inputSchema.required) {
    if (required === 'owner' || required === 'repo') continue; // resolved below (full_name may carry them)
    if (pickArg(args, required) === undefined) return toolError(`Missing required argument: ${required}`);
  }
  const { owner, repo: repoName } = ownerRepoOf(args);
  if (tool.name !== 'create_repo' && (owner === '' || repoName === '')) {
    return toolError('Missing required argument: owner or repo');
  }

  if (tool.name === 'create_repo') {
    const repoNameArg = pickArg(args, 'name');
    if (typeof repoNameArg !== 'string' || repoNameArg === '') return toolError('Missing required argument: name');
    if (store.getRepo(store.viewer, repoNameArg) !== undefined) return toolError('Repository already exists');
    const description = pickArg(args, 'description');
    const repo = store.createRepo(repoNameArg, typeof description === 'string' ? description : '', pickArg(args, 'private') === true);
    return toolResult(repoJson(store, repo));
  }

  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== store.viewer) return toolError('Repository not found');

  if (tool.name === 'get_repo') return toolResult(repoJson(store, repo));

  if (tool.name === 'create_issue') {
    const title = pickArg(args, 'title');
    if (typeof title !== 'string' || title === '') return toolError('Missing required argument: title');
    const body = pickArg(args, 'body');
    const issue = store.createIssue(repo, title, typeof body === 'string' ? body : '', []);
    return toolResult(issueJson(store, repo, issue));
  }

  if (tool.name === 'list_issues') {
    const state = pickArg(args, 'state');
    const wanted = typeof state === 'string' ? state.toLowerCase() : 'open';
    const list = repo.issues.filter((issue) => (wanted === 'all' ? true : issue.state === wanted));
    const result = { issues: list.map((issue) => issueJson(store, repo, issue)) };
    return toolResult(result);
  }

  if (tool.name === 'create_pull_request') {
    const title = pickArg(args, 'title');
    const head = pickArg(args, 'head', 'head_ref', 'head_branch', 'source', 'from', 'branch');
    const base = pickArg(args, 'base', 'base_ref', 'target', 'into');
    if (typeof title !== 'string' || title === '') return toolError('Missing required argument: title');
    if (typeof head !== 'string' || head === '') return toolError('Missing required argument: head');
    if (typeof base !== 'string' || base === '') return toolError('Missing required argument: base');
    const pull = store.createPull(repo, title, '', head, base);
    if (pull === undefined) return toolError('head or base branch does not exist');
    return toolResult(pullJson(store, repo, pull));
  }

  if (tool.name === 'merge_pull_request') {
    const pullNumber = pickArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number');
    const number = typeof pullNumber === 'number' ? pullNumber : Number(pullNumber);
    if (!Number.isInteger(number) || number < 1) return toolError('Missing required argument: pull_number');
    const pull = repo.pulls.find((item) => item.number === number);
    if (pull === undefined) return toolError('Pull request not found');
    if (pull.state !== 'open') return toolError('Pull request is not open');
    const result = store.mergePull(repo, pull);
    if (!result.ok) return toolError(result.conflict ? 'Merge conflict' : 'Merge failed');
    return toolResult(pullJson(store, repo, pull));
  }

  return toolError(`Unknown tool: ${name}`);
}

/**
 * Handle one POST /mcp request. `rawBody` is the request body as text.
 * Auth was checked by the caller: a missing token never reaches this.
 */
export function handleMcp(store: Store, rawBody: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Try to keep the caller's id for the parse error.
    const idMatch = /"id"\s*:\s*("[^"]*"|\d+)/.exec(rawBody);
    let id: unknown = null;
    if (idMatch !== null) {
      const raw = idMatch[1] as string;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    return { status: 400, headers: { 'mcp-session-id': SESSION_ID }, body: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, headers: { 'mcp-session-id': SESSION_ID }, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  if (method === 'notifications/initialized' || (isNotification && method.startsWith('notifications/'))) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return rpcError(id, -32602, 'Missing tool name');
    const tool = findTool(name);
    if (tool === undefined) return rpcError(id, -32601, `Unknown tool: ${name}`);
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }

  if (isNotification) return { status: 202, body: null };
  return rpcError(id, -32601, `Method not found: ${method}`);
}
