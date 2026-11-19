// GitHub REST v3 under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON with an
// X-GitHub-Request-Id (added by the server layer); errors carry a string
// message. A repository belongs to the login the bearer token names, so the
// same name under another owner is 404, never 403.

import { objectId } from './gitcore.ts';
import { commentGlobalId, issueGlobalId, pullGlobalId, repoGlobalId } from './ids.ts';
import type { Comment, Issue, Pull, Repo, Store } from './store.ts';

export interface RestResult {
  status: number;
  /** JSON body, or null for an empty (204) reply. */
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: 1000,
      node_id: `U_${Buffer.from(`User:1000`, 'utf8').toString('base64url')}`,
      type: 'User',
      site_admin: false,
    },
    private: repo.private,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const comments = repo.comments.get(issue.number) ?? [];
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.id, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.userLogin, id: 1000, type: 'User' },
    labels: issue.labels.map((label) => ({
      id: label.id,
      node_id: `L_${Buffer.from(`Label:${repo.id}:${label.id}`, 'utf8').toString('base64url')}`,
      name: label.name,
      color: label.color,
      description: label.description,
      default: false,
    })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

export function commentJson(store: Store, repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo.id, issueNumber, comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: comment.userLogin, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const mergeable = pull.state === 'open' ? !store.pullConflicts(repo, pull) : false;
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.id, pull.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.userLogin, id: 1000, type: 'User' },
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: repo.owner, id: 1000, type: 'User' },
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: repo.owner, id: 1000, type: 'User' },
      repo: repoJson(store, repo),
    },
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function pageOf<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(host: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | undefined {
  if (page * perPage >= total) return undefined;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<http://${host}${path}?${next.toString()}>; rel="next"`;
}

/** Look up a repo, answering 404 when the owner is not the token's login or the repo is missing. */
function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== store.viewer) return undefined;
  return store.getRepo(owner, name);
}

/**
 * Route one REST request. `path` is the path after /api/v3 (without a leading
 * slash), already URL-decoded per segment. `body` is the parsed JSON body, or
 * undefined when there was no body; `bodyValid` is false when a body was
 * present but not valid JSON.
 */
export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  bodyValid: boolean,
  host: string,
): RestResult {
  const segments = path === '' ? [] : path.split('/').filter((segment) => segment !== '');
  if (!bodyValid) return err(400, 'Malformed JSON body');

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      login: store.viewer,
      id: 1000,
      node_id: `U_${Buffer.from('User:1000', 'utf8').toString('base64url')}`,
      type: 'User',
      site_admin: false,
      name: store.viewer,
      email: `${store.viewer}@example.invalid`,
    });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = parsePagination(query);
      const all = store.listViewerRepos();
      const headers: Record<string, string> = {};
      const link = linkHeader(host, '/api/v3/user/repos', query, page, perPage, all.length);
      if (link !== undefined) headers.link = link;
      return ok(200, pageOf(all, page, perPage).map((repo) => repoJson(store, repo)), headers);
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      const existing = store.getRepo(store.viewer, name);
      if (existing !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      return ok(201, repoJson(store, repo));
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1] ?? '');
    const name = decodeURIComponent(segments[2] ?? '');
    const rest = segments.slice(3);
    const repo = findRepo(store, owner, name);
    if (repo === undefined) return err(404, 'Not Found');

    // /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.updatedAt = store.clock.nowIso();
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/branches[/{branch}]
    if (rest[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (rest.length === 1) {
        const branches: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
        }
        return ok(200, branches);
      }
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, branchJson(repo, branch, sha));
    }

    // /repos/{owner}/{repo}/commits
    if (rest[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === undefined) return ok(200, []);
      const commitOid = store.peelToCommit(repo, tip) ?? tip;
      const { page, perPage } = parsePagination(query);
      const all = store.reachableCommits(repo, commitOid).map((sha) => {
        const info = store.commitOf(repo, sha);
        const authorLine = info?.author ?? '';
        const authorName = authorLine.split(' <')[0] ?? '';
        const authorEmail = /<([^>]*)>/.exec(authorLine)?.[1] ?? '';
        return {
          sha,
          commit: {
            message: info?.message ?? '',
            author: { name: authorName, email: authorEmail, date: new Date(0).toISOString() },
            committer: { name: authorName, email: authorEmail, date: new Date(0).toISOString() },
          },
          author: { login: store.viewer, id: 1000, type: 'User' },
          committer: { login: store.viewer, id: 1000, type: 'User' },
          parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
        };
      });
      const headers: Record<string, string> = {};
      const link = linkHeader(host, `/api/v3/repos/${owner}/${name}/commits`, query, page, perPage, all.length);
      if (link !== undefined) headers.link = link;
      return ok(200, pageOf(all, page, perPage), headers);
    }

    // /repos/{owner}/{repo}/git/refs[/...]
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const input = (body ?? {}) as Record<string, unknown>;
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
        const existing = repo.refs.get(ref);
        if (existing !== undefined) {
          if (existing === sha) return ok(200, { ref, object: { sha, type: 'commit', url: '' } });
          return err(422, 'Reference already exists');
        }
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha, type: 'commit', url: '' } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const refs: Record<string, unknown>[] = [];
          for (const [ref, sha] of [...repo.refs.entries()].sort()) {
            refs.push({ ref, object: { sha, type: 'commit', url: '' } });
          }
          return ok(200, refs);
        }
        const ref = rest.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { ref, object: { sha, type: 'commit', url: '' } });
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (filePath === '') return err(404, 'Not Found');
      const branch = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = branch === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, branch);
        if (tip === undefined) return err(404, 'Not Found');
        const commitOid = store.peelToCommit(repo, tip);
        if (commitOid === undefined) return err(404, 'Not Found');
        const info = store.commitOf(repo, commitOid);
        if (info === undefined) return err(404, 'Not Found');
        const files = store.treeMap(repo, info.tree);
        const exact = files.get(filePath);
        if (exact !== undefined) {
          const blob = repo.objects.get(exact.oid);
          const content = blob === undefined ? Buffer.alloc(0) : blob.data;
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: content.toString('base64'),
            sha: exact.oid,
          });
        }
        // A directory: list its direct entries.
        const prefix = `${filePath}/`;
        const entries: Record<string, unknown>[] = [];
        const seen = new Map<string, { type: string; oid: string }>();
        for (const [path, file] of files) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) {
            seen.set(restPath, { type: 'file', oid: file.oid });
          } else {
            const dir = restPath.slice(0, slash);
            if (!seen.has(dir)) {
              // The directory's tree oid: rebuild from the tree walk.
              const dirTree = findDirTree(repo, info.tree, filePath);
              seen.set(dir, { type: 'dir', oid: dirTree ?? '' });
            }
          }
        }
        if (seen.size === 0) return err(404, 'Not Found');
        for (const [entryName, entry] of [...seen.entries()].sort()) {
          const blob = entry.type === 'file' ? repo.objects.get(entry.oid) : undefined;
          entries.push({
            type: entry.type,
            name: entryName,
            path: `${filePath}/${entryName}`,
            sha: entry.oid,
            size: blob === undefined ? 0 : blob.data.length,
          });
        }
        return ok(200, entries);
      }
      if (method === 'PUT') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'Update file';
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        if (contentB64 === '') return err(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const branchName = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        const tipCommit = tip === undefined ? undefined : store.commitOf(repo, tip);
        const files = tipCommit === undefined ? new Map() : store.treeMap(repo, tipCommit.tree);
        const existing = files.get(filePath);
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (givenSha !== undefined && existing !== undefined && givenSha !== existing.oid) {
          return err(409, 'sha does not match the current file');
        }
        if (givenSha !== undefined && existing === undefined) return err(409, 'sha does not match the current file');
        const blobOid = store.putObject(repo, { type: 'blob', data: content });
        files.set(filePath, { oid: blobOid, mode: '100644' });
        const parents = tipCommit === undefined ? [] : [tip as string];
        const commitOid = store.makeCommit(repo, files, message, parents);
        repo.refs.set(`refs/heads/${branchName}`, commitOid);
        return ok(existing === undefined ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'Delete file';
        const branchName = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        if (tip === undefined) return err(404, 'Not Found');
        const tipCommit = store.commitOf(repo, tip);
        if (tipCommit === undefined) return err(404, 'Not Found');
        const files = store.treeMap(repo, tipCommit.tree);
        const existing = files.get(filePath);
        if (existing === undefined) return err(404, 'Not Found');
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (givenSha !== undefined && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
        files.delete(filePath);
        const commitOid = store.makeCommit(repo, files, message, [tip]);
        repo.refs.set(`refs/heads/${branchName}`, commitOid);
        return ok(200, { commit: { sha: commitOid, message } });
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const input = (body ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '') return err(422, 'name is required');
        const label = store.createLabel(repo, name, typeof input.color === 'string' ? input.color : 'ededed');
        return ok(201, { id: label.id, name: label.name, color: label.color, description: label.description, default: false });
      }
      if (method === 'GET' && rest.length === 1) {
        return ok(
          200,
          [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description, default: false })),
        );
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/issues[/{number}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const { page, perPage } = parsePagination(query);
          const headers: Record<string, string> = {};
          const link = linkHeader(host, `/api/v3/repos/${owner}/${name}/issues`, query, page, perPage, list.length);
          if (link !== undefined) headers.link = link;
          return ok(200, pageOf(list, page, perPage).map((issue) => issueJson(store, repo, issue)), headers);
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') return err(422, 'title is required');
          const labelNames = Array.isArray(input.labels) ? (input.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) return err(422, `Label "${labelName}" does not exist`);
          }
          const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labelNames);
          return ok(201, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const issue = repo.issues.find((item) => item.number === number);
      if (issue === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const input = (body ?? {}) as Record<string, unknown>;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (Array.isArray(input.labels)) {
            const labelNames = (input.labels as unknown[]).filter((x): x is string => typeof x === 'string');
            for (const labelName of labelNames) {
              if (!repo.labels.has(labelName)) return err(422, `Label "${labelName}" does not exist`);
            }
            issue.labels = labelNames
              .map((labelName) => repo.labels.get(labelName))
              .filter((label): label is import('./store.ts').Label => label !== undefined);
          }
          issue.updatedAt = store.clock.nowIso();
          return ok(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const comments = repo.comments.get(number) ?? [];
          return ok(200, comments.map((comment) => commentJson(store, repo, number, comment)));
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const commentBody = typeof input.body === 'string' ? input.body : '';
          if (commentBody === '') return err(422, 'body is required');
          repo.commentSeq += 1;
          const now = store.clock.nowIso();
          const comment: Comment = { id: repo.commentSeq, body: commentBody, userLogin: store.viewer, createdAt: now, updatedAt: now };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          return ok(201, commentJson(store, repo, number, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/pulls[/{number}[/files|merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
          list = [...list].sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, perPage } = parsePagination(query);
          const headers: Record<string, string> = {};
          const link = linkHeader(host, `/api/v3/repos/${owner}/${name}/pulls`, query, page, perPage, list.length);
          if (link !== undefined) headers.link = link;
          return ok(200, pageOf(list, page, perPage).map((pull) => pullJson(store, repo, pull)), headers);
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const pull = store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base);
          if (pull === undefined) return err(422, 'head or base branch does not exist');
          return ok(201, pullJson(store, repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const pull = repo.pulls.find((item) => item.number === number);
      if (pull === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, pullJson(store, repo, pull));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return err(404, 'Not Found');
        const files = store.pullFiles(repo, pull).map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        }));
        return ok(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, 'Pull request is not open');
        const result = store.mergePull(repo, pull);
        if (!result.ok) {
          if (result.conflict) return err(405, 'Merge conflict');
          return err(422, 'Merge failed');
        }
        return ok(200, { merged: true, sha: result.sha, message: `Pull request #${pull.number} merged` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

/** Find a directory's tree oid by walking a root tree. */
function findDirTree(repo: Repo, rootTreeOid: string, dirPath: string): string | undefined {
  const segments = dirPath.split('/').filter((segment) => segment !== '');
  let current = rootTreeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((item) => item.name === segment && item.mode === '40000');
    if (entry === undefined) return undefined;
    current = entry.oid;
  }
  return current;
}

export { objectId };
