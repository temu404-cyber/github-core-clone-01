// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments. Everything lives in Maps; there is no
// disk, no database and no wall clock in the data — a deterministic counter
// clock stamps created/updated times so two runs on one instance agree.

import {
  ZERO_OID,
  encodeCommit,
  encodeTree,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';
import { SCENARIO_EPOCH_SEC, viewerLogin } from './scenario.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  numberSeq: number;
  labelSeq: number;
  commentSeq: number;
}

/** A deterministic clock: ISO stamps 1 second apart from the scenario epoch. */
class Clock {
  #seq = 0;
  nowIso(): string {
    this.#seq += 1;
    return new Date((SCENARIO_EPOCH_SEC + this.#seq) * 1000).toISOString();
  }
  /** A commit epoch (seconds) that only moves forward. */
  nowEpoch(): number {
    this.#seq += 1;
    return SCENARIO_EPOCH_SEC + this.#seq;
  }
}

export class Store {
  readonly viewer = viewerLogin();
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  #repoSeq = 0;
  #issueSeq = 0;
  #pullSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewer) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.#repoSeq += 1;
    const now = this.clock.nowIso();
    const repo: Repo = {
      id: this.#repoSeq,
      name,
      owner: this.viewer,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      numberSeq: 0,
      labelSeq: 0,
      commentSeq: 0,
    };
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, object: GitObject): string {
    const oid = objectId(object.type, object.data);
    repo.objects.set(oid, object);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The ref's tip, or undefined when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, full ref, HEAD, or raw oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
    if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
    return undefined;
  }

  /** Peel a tag object (or a commit) to its commit oid. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      return this.peelToCommit(repo, tag.object);
    }
    return undefined;
  }

  // ------------------------------------------------------------ trees

  /** The flat path -> {oid, mode} map of a tree, recursively. */
  treeMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree objects for a flat path map; returns the root tree oid. */
  buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, file);
        }
      }
      for (const [dir] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      const tree = encodeTree(entries);
      return this.putObject(repo, { type: 'tree', data: tree });
    };
    return build('');
  }

  /** Create a commit on top of `files` (a flat path map) and store it. */
  makeCommit(
    repo: Repo,
    files: Map<string, { oid: string; mode: string }>,
    message: string,
    parents: string[],
  ): string {
    const treeOid = this.buildTree(repo, files);
    const epoch = this.clock.nowEpoch();
    const ident = `${this.viewer} <${this.viewer}@example.invalid> ${epoch} +0000`;
    const commit = encodeCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    return this.putObject(repo, { type: 'commit', data: commit });
  }

  /** The commit object of a tip, parsed. */
  commitOf(repo: Repo, oid: string): { tree: string; parents: string[]; author: string; committer: string; message: string } | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  // ------------------------------------------------------------ ancestry

  /** Is `ancestor` reachable from `tip` by following parents? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(repo, current);
      if (commit === undefined) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** All commit oids reachable from `tip`, nearest first. Commits in `stopAt` are included but not descended past. */
  reachableCommits(repo: Repo, tip: string, stopAt: ReadonlySet<string> = new Set()): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(repo, current);
      if (commit === undefined) continue;
      out.push(current);
      if (stopAt.has(current)) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** The merge base of two tips: the nearest common ancestor of `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsA = new Set(this.reachableCommits(repo, a));
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsA.has(current)) return current;
      const commit = this.commitOf(repo, current);
      if (commit === undefined) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return undefined;
  }

  /** All objects reachable from a commit: the commit, its trees and blobs, and its ancestors' objects. */
  closureObjects(repo: Repo, tip: string): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const addTree = (treeOid: string): void => {
      const object = repo.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree' || out.has(treeOid)) return;
      out.set(treeOid, object);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') {
          addTree(entry.oid);
        } else {
          const blob = repo.objects.get(entry.oid);
          if (blob !== undefined && !out.has(entry.oid)) out.set(entry.oid, blob);
        }
      }
    };
    for (const commitOid of this.reachableCommits(repo, tip)) {
      const commit = repo.objects.get(commitOid);
      if (commit !== undefined && !out.has(commitOid)) out.set(commitOid, commit);
      const info = this.commitOf(repo, commitOid);
      if (info !== undefined) addTree(info.tree);
    }
    return out;
  }

  // ------------------------------------------------------------ diff

  diffTrees(
    repo: Repo,
    baseTreeOid: string | undefined,
    headTreeOid: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid?: string; newOid?: string }> {
    const base = baseTreeOid === undefined ? new Map() : this.treeMap(repo, baseTreeOid);
    const head = this.treeMap(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid?: string; newOid?: string }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) out.push({ path, status: 'added', newOid: h.oid });
      else if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b.oid });
      else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
      }
    }
    return out;
  }

  /** Line counts for a blob, for pull-request file stats. */
  blobLines(repo: Repo, oid: string): string[] {
    const object = repo.objects.get(oid);
    if (object === undefined) return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Added/deleted line counts between two blobs (LCS on lines). */
  lineDiff(repo: Repo, oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
    const oldLines = oldOid === undefined ? [] : this.blobLines(repo, oldOid);
    const newLines = newOid === undefined ? [] : this.blobLines(repo, newOid);
    if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
    if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
    // LCS length via a two-row DP; files here are small.
    let prev = new Array<number>(newLines.length + 1).fill(0);
    let curr = new Array<number>(newLines.length + 1).fill(0);
    for (let i = 1; i <= oldLines.length; i += 1) {
      curr[0] = 0;
      for (let j = 1; j <= newLines.length; j += 1) {
        curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    const lcs = prev[newLines.length] ?? 0;
    return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
  }

  // ------------------------------------------------------------ issues / pulls

  nextNumber(repo: Repo): number {
    repo.numberSeq += 1;
    return repo.numberSeq;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    this.#issueSeq += 1;
    const now = this.clock.nowIso();
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label !== undefined) labels.push(label);
    }
    const issue: Issue = {
      id: this.#issueSeq,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      labels,
      userLogin: this.viewer,
      createdAt: now,
      updatedAt: now,
      createdSeq: repo.issues.length,
    };
    repo.issues.push(issue);
    return issue;
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    repo.labelSeq += 1;
    const label: Label = { id: repo.labelSeq, name, color: color || 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | undefined {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return undefined;
    const headCommit = this.peelToCommit(repo, headSha);
    const baseCommit = this.peelToCommit(repo, baseSha);
    if (headCommit === undefined || baseCommit === undefined) return undefined;
    const mergeBase = this.mergeBase(repo, headCommit, baseCommit) ?? baseCommit;
    this.#pullSeq += 1;
    const now = this.clock.nowIso();
    const pull: Pull = {
      id: this.#pullSeq,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha: headCommit,
      baseSha: baseCommit,
      mergeBaseSha: mergeBase,
      userLogin: this.viewer,
      createdAt: now,
      updatedAt: now,
      createdSeq: repo.pulls.length,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** The files the head changed against the merge base, with line stats. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseCommit = this.commitOf(repo, pull.mergeBaseSha);
    const headCommit = this.commitOf(repo, pull.headSha);
    if (baseCommit === undefined || headCommit === undefined) return [];
    const changes = this.diffTrees(repo, baseCommit.tree, headCommit.tree);
    return changes.map((change) => {
      const stats = this.lineDiff(repo, change.oldOid, change.newOid);
      const status = change.status === 'removed' ? 'removed' : change.status === 'added' ? 'added' : 'modified';
      return {
        filename: change.path,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        changes: stats.additions + stats.deletions,
      };
    });
  }

  /** Would squashing this pull conflict with what the base gained since the merge base? */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseCommit = this.commitOf(repo, pull.mergeBaseSha);
    const headCommit = this.commitOf(repo, pull.headSha);
    const currentBaseCommit = this.commitOf(repo, pull.baseSha);
    if (baseCommit === undefined || headCommit === undefined || currentBaseCommit === undefined) return true;
    const headChanges = this.diffTrees(repo, baseCommit.tree, headCommit.tree);
    const baseChanges = this.diffTrees(repo, baseCommit.tree, currentBaseCommit.tree);
    const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const baseChange = baseByPath.get(change.path);
      if (baseChange === undefined) continue;
      if (baseChange.newOid !== change.newOid) return true;
    }
    return false;
  }

  /** Squash-merge the pull onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; conflict: boolean } {
    if (pull.state !== 'open' || pull.merged) return { ok: false, conflict: false };
    // Re-resolve the base tip: the branch may have moved since the pull opened.
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const baseCommitOid = baseTip === undefined ? undefined : this.peelToCommit(repo, baseTip);
    if (baseCommitOid === undefined) return { ok: false, conflict: false };
    pull.baseSha = baseCommitOid;
    if (this.pullConflicts(repo, pull)) return { ok: false, conflict: true };
    const baseCommit = this.commitOf(repo, pull.baseSha);
    const headCommit = this.commitOf(repo, pull.headSha);
    const mergeBaseCommit = this.commitOf(repo, pull.mergeBaseSha);
    if (baseCommit === undefined || headCommit === undefined || mergeBaseCommit === undefined) {
      return { ok: false, conflict: false };
    }
    // Apply the head's changes onto the base tree.
    const files = this.treeMap(repo, baseCommit.tree);
    const headChanges = this.diffTrees(repo, mergeBaseCommit.tree, headCommit.tree);
    for (const change of headChanges) {
      if (change.status === 'removed') files.delete(change.path);
      else if (change.newOid !== undefined) files.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const message = `${pull.title} (#${pull.number})`;
    const mergeCommit = this.makeCommit(repo, files, message, [pull.baseSha]);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.nowIso();
    pull.mergeCommitSha = mergeCommit;
    pull.updatedAt = pull.mergedAt;
    return { ok: true, sha: mergeCommit };
  }
}

export { ZERO_OID };
export type { GitObjectType };
