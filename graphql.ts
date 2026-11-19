// GitHub GraphQL v4 at /api/graphql: a small parser and executor for the
// documents gh and github-mcp-server actually send, plus the introspection
// they need. Unknown fields answer HTTP 200 with an errors array naming
// them; an unknown repository answers data.repository = null with no errors.

import { decodeGlobalId, issueGlobalId, pullGlobalId, repoGlobalId, commentGlobalId } from './ids.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type SelectionNode =
  | { kind: 'field'; alias: string | undefined; name: string; args: ArgumentNode[]; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | undefined; selections: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | undefined;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | undefined }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  peek(): Token | undefined {
    return this.#tokens[this.#pos];
  }

  next(): Token {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.#pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} but got ${JSON.stringify(token.value)}`);
    }
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name but got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} but got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    const token = this.peek() as Token;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') {
      name = this.next().value;
    }
    const variableDefinitions: Array<{ name: string; defaultValue: ValueNode | undefined }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // The variable type: a name, possibly wrapped in [ ] and !.
        this.parseVariableType();
        let defaultValue: ValueNode | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue(true);
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    // Directives (e.g. @include) are not used by the suite's documents; skip them.
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selections };
  }

  parseVariableType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseVariableType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      // "... { ... }" — an inline fragment without a type condition.
      return { kind: 'inlineFragment', typeCondition: undefined, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: ArgumentNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue(false) });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('variable in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue(isConst));
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ------------------------------------------------------------------ values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(args: ArgumentNode[], name: string, variables: Record<string, unknown>): unknown {
  const arg = args.find((item) => item.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, variables);
}

// ------------------------------------------------------------------ executor

type GqlValue =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'User'; login: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; nodes: Array<{ __typename: 'Issue'; repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; nodes: Array<{ __typename: 'PullRequest'; repo: Repo; pull: Pull }> }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: Array<{ __typename: 'PullRequestChangedFile'; path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'IssueCommentEdge'; node: { __typename: 'IssueComment'; id: string; body: string } }
  | { __typename: 'IssueComment'; id: string; body: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string; kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues: string[] | null }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const SEARCH_TYPE_ENUMS = ['ISSUE', 'REPOSITORY', 'USER'];

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number | undefined {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    if (match === null) return undefined;
    return Number(match[1]);
  } catch {
    return undefined;
  }
}

class Executor {
  #store: Store;
  #variables: Record<string, unknown>;
  #fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }> = [];

  constructor(store: Store, variables: Record<string, unknown>, fragments: Map<string, FragmentNode>) {
    this.#store = store;
    this.#variables = variables;
    this.#fragments = fragments;
  }

  executeOperation(operation: OperationNode): Record<string, unknown> | null {
    const root: GqlValue = operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
    const out: Record<string, unknown> = {};
    for (const selection of operation.selections) {
      const result = this.executeSelection(selection, root, operation.operation === 'mutation' ? 'Mutation' : 'Query');
      if (result === undefined) return null;
      out[result.key] = result.value;
    }
    return out;
  }

  executeSelection(
    selection: SelectionNode,
    value: GqlValue,
    typeName: string,
  ): { key: string; value: unknown } | undefined {
    if (selection.kind === 'fragmentSpread') {
      // Handled by the caller through executeSelections; a spread on its own
      // contributes nothing here.
      return undefined;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== value.__typename) return undefined;
      // Inline fragments merge their fields into the parent object; the
      // caller flattens them via executeSelections.
      return undefined;
    }
    const field = this.resolveField(value, typeName, selection);
    if (field === undefined) return undefined;
    return { key: selection.alias ?? selection.name, value: field };
  }

  /** Execute a selection set against a value, returning the object or null on error. */
  executeSelections(selections: SelectionNode[], value: GqlValue, typeName: string): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragmentSpread') {
        const fragment = this.#fragments.get(selection.name);
        if (fragment === undefined) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".` });
          return null;
        }
        if (fragment.typeCondition !== value.__typename) continue;
        const nested = this.executeSelections(fragment.selections, value, fragment.typeCondition);
        if (nested === null) return null;
        Object.assign(out, nested);
        continue;
      }
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== undefined && selection.typeCondition !== value.__typename) continue;
        const nested = this.executeSelections(selection.selections, value, selection.typeCondition ?? typeName);
        if (nested === null) return null;
        Object.assign(out, nested);
        continue;
      }
      const field = this.resolveField(value, typeName, selection);
      if (field === undefined) return null;
      out[selection.alias ?? selection.name] = field;
    }
    return out;
  }

  /** Resolve one field, executing its sub-selections when it returns an object. */
  resolveField(value: GqlValue, typeName: string, selection: Extract<SelectionNode, { kind: 'field' }>): unknown {
    const raw = this.rawField(value, typeName, selection);
    if (raw === undefined) return undefined; // error already recorded
    if (raw === null) return null;
    if (selection.selections.length === 0) return raw;
    if (Array.isArray(raw)) {
      return raw.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in item) {
          return this.executeSelections(selection.selections, item as GqlValue, (item as GqlValue).__typename);
        }
        return item;
      });
    }
    if (typeof raw === 'object' && '__typename' in raw) {
      return this.executeSelections(selection.selections, raw as GqlValue, (raw as GqlValue).__typename);
    }
    if (typeof raw === 'object') {
      // A plain record (a mutation payload): resolve each sub-field from it.
      const out: Record<string, unknown> = {};
      for (const sub of selection.selections) {
        if (sub.kind !== 'field') continue;
        const field = this.resolveField(raw as unknown as GqlValue, '', sub);
        if (field === undefined) return undefined;
        out[sub.alias ?? sub.name] = field;
      }
      return out;
    }
    return raw;
  }

  /** The field's value before sub-selection execution. `undefined` means "error recorded". */
  rawField(value: GqlValue, typeName: string, selection: Extract<SelectionNode, { kind: 'field' }>): unknown {
    const store = this.#store;
    const args = selection.args;
    const name = selection.name;

    // A plain record (a mutation payload): resolve by key, before any type dispatch.
    if (typeof value === 'object' && value !== null && !('__typename' in value)) {
      const record = value as unknown as Record<string, unknown>;
      if (name in record) return record[name];
      this.errors.push({ message: `Cannot query field "${name}" on type "MutationPayload".` });
      return undefined;
    }

    // Introspection on Query.
    if (typeName === 'Query' && name === '__type') {
      const typeNameArg = argValue(args, 'name', this.#variables);
      if (typeof typeNameArg !== 'string') return null;
      if (typeNameArg === 'SearchType') {
        return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_ENUMS } as GqlValue;
      }
      const fields = TYPE_FIELDS[typeNameArg];
      if (fields === undefined) return null;
      return { __typename: '__Type', name: typeNameArg, kind: 'OBJECT', fields, enumValues: null } as GqlValue;
    }

    if (typeName === 'Query') {
      if (name === 'viewer') return { __typename: 'User', login: store.viewer } as GqlValue;
      if (name === 'repository') {
        const owner = argValue(args, 'owner', this.#variables);
        const repoName = argValue(args, 'name', this.#variables);
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        if (owner !== store.viewer) return null;
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) return null;
        return { __typename: 'Repository', repo } as GqlValue;
      }
      if (name === 'node') {
        const id = argValue(args, 'id', this.#variables);
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (decoded === undefined || decoded.kind !== 'Repository') return null;
        for (const repo of store.repos.values()) {
          if (repo.id === decoded.repoId) return { __typename: 'Repository', repo } as GqlValue;
        }
        return null;
      }
      return this.unknownField(typeName, name);
    }

    if (typeName === 'Mutation') {
      if (name === 'createIssue') {
        const input = argValue(args, 'input', this.#variables) as Record<string, unknown> | undefined;
        const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
        const decoded = decodeGlobalId(repositoryId);
        const repo = decoded === undefined ? undefined : [...store.repos.values()].find((item) => item.id === decoded.repoId);
        if (repo === undefined) {
          this.errors.push({ message: 'Repository not found.' });
          return undefined;
        }
        const title = typeof input?.title === 'string' ? input.title : '';
        const body = typeof input?.body === 'string' ? input.body : '';
        const issue = store.createIssue(repo, title, body, []);
        return { issue: { __typename: 'Issue', repo, issue } as GqlValue };
      }
      if (name === 'closeIssue') {
        const input = argValue(args, 'input', this.#variables) as Record<string, unknown> | undefined;
        const issueId = typeof input?.issueId === 'string' ? input.issueId : '';
        const found = this.findIssue(issueId);
        if (found === undefined) {
          this.errors.push({ message: 'Issue not found.' });
          return undefined;
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = store.clock.nowIso();
        return { issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } as GqlValue };
      }
      if (name === 'createPullRequest') {
        const input = argValue(args, 'input', this.#variables) as Record<string, unknown> | undefined;
        const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
        const decoded = decodeGlobalId(repositoryId);
        const repo = decoded === undefined ? undefined : [...store.repos.values()].find((item) => item.id === decoded.repoId);
        if (repo === undefined) {
          this.errors.push({ message: 'Repository not found.' });
          return undefined;
        }
        const headRefName = typeof input?.headRefName === 'string' ? input.headRefName : '';
        const baseRefName = typeof input?.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
        const title = typeof input?.title === 'string' ? input.title : '';
        const body = typeof input?.body === 'string' ? input.body : '';
        const pull = store.createPull(repo, title, body, headRefName, baseRefName);
        if (pull === undefined) {
          this.errors.push({ message: 'head or base branch does not exist.' });
          return undefined;
        }
        return { pullRequest: { __typename: 'PullRequest', repo, pull } as GqlValue };
      }
      if (name === 'mergePullRequest') {
        const input = argValue(args, 'input', this.#variables) as Record<string, unknown> | undefined;
        const pullRequestId = typeof input?.pullRequestId === 'string' ? input.pullRequestId : '';
        const found = this.findPull(pullRequestId);
        if (found === undefined) {
          this.errors.push({ message: 'Pull request not found.' });
          return undefined;
        }
        const result = store.mergePull(found.repo, found.pull);
        if (!result.ok) {
          this.errors.push({ message: result.conflict ? 'Merge conflict.' : 'Merge failed.' });
          return undefined;
        }
        return { pullRequest: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } as GqlValue };
      }
      if (name === 'addComment') {
        const input = argValue(args, 'input', this.#variables) as Record<string, unknown> | undefined;
        const subjectId = typeof input?.subjectId === 'string' ? input.subjectId : '';
        const body = typeof input?.body === 'string' ? input.body : '';
        const found = this.findIssue(subjectId);
        if (found === undefined) {
          this.errors.push({ message: 'Subject not found.' });
          return undefined;
        }
        found.repo.commentSeq += 1;
        const now = store.clock.nowIso();
        const comment = { id: found.repo.commentSeq, body, userLogin: store.viewer, createdAt: now, updatedAt: now };
        const list = found.repo.comments.get(found.issue.number) ?? [];
        list.push(comment);
        found.repo.comments.set(found.issue.number, list);
        const node = {
          __typename: 'IssueComment',
          id: commentGlobalId(found.repo.id, found.issue.number, comment.id),
          body: comment.body,
        } as GqlValue;
        return { commentEdge: { __typename: 'IssueCommentEdge', node } as GqlValue };
      }
      return this.unknownField(typeName, name);
    }

    if (typeName === 'Repository' && value.__typename === 'Repository') {
      const repo = value.repo;
      switch (name) {
        case 'id':
          return repoGlobalId(repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', login: repo.owner } as GqlValue;
        case 'defaultBranchRef':
          return { __typename: 'Ref', name: repo.defaultBranch } as GqlValue;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argValue(args, 'number', this.#variables);
          if (typeof number !== 'number') return null;
          const issue = repo.issues.find((item) => item.number === number);
          if (issue === undefined) return null;
          return { __typename: 'Issue', repo, issue } as GqlValue;
        }
        case 'issues': {
          const first = argValue(args, 'first', this.#variables);
          const states = argValue(args, 'states', this.#variables) as string[] | undefined;
          const orderBy = argValue(args, 'orderBy', this.#variables) as Record<string, unknown> | undefined;
          const after = argValue(args, 'after', this.#variables);
          let list = [...repo.issues];
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          if (typeof after === 'string' && after !== '') {
            const cursorNumber = numberFromCursor(after);
            if (cursorNumber !== undefined) {
              list = list.filter((issue) => (direction === 'asc' ? issue.number > cursorNumber : issue.number < cursorNumber));
            }
          }
          const limit = typeof first === 'number' ? first : list.length;
          const nodes = list.slice(0, limit);
          const hasNextPage = list.length > nodes.length;
          const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]?.number ?? 0) : null;
          return {
            __typename: 'IssueConnection',
            nodes: nodes.map((issue) => ({ __typename: 'Issue', repo, issue }) as GqlValue),
            pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor } as GqlValue,
          } as GqlValue;
        }
        case 'pullRequests': {
          const first = argValue(args, 'first', this.#variables);
          const limit = typeof first === 'number' ? first : repo.pulls.length;
          const nodes = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, limit);
          return {
            __typename: 'PullRequestConnection',
            nodes: nodes.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as GqlValue),
          } as GqlValue;
        }
        case 'pullRequest': {
          const number = argValue(args, 'number', this.#variables);
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.find((item) => item.number === number);
          if (pull === undefined) return null;
          return { __typename: 'PullRequest', repo, pull } as GqlValue;
        }
        default:
          return this.unknownField(typeName, name);
      }
    }

    if (typeName === 'Issue' && value.__typename === 'Issue') {
      const issue = value.issue;
      switch (name) {
        case 'id':
          return issueGlobalId(value.repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        default:
          return this.unknownField(typeName, name);
      }
    }

    if (typeName === 'PullRequest' && value.__typename === 'PullRequest') {
      const pull = value.pull;
      switch (name) {
        case 'id':
          return pullGlobalId(value.repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          if (pull.state !== 'open') return pull.merged ? 'MERGEABLE' : 'UNKNOWN';
          return store.pullConflicts(value.repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'files': {
          const first = argValue(args, 'first', this.#variables);
          const files = store.pullFiles(value.repo, pull);
          const limit = typeof first === 'number' ? first : files.length;
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, limit).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }) as GqlValue),
          } as GqlValue;
        }
        default:
          return this.unknownField(typeName, name);
      }
    }

    if (typeName === 'User' && value.__typename === 'User') {
      if (name === 'login') return value.login;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'Ref' && value.__typename === 'Ref') {
      if (name === 'name') return value.name;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'IssueConnection' && value.__typename === 'IssueConnection') {
      if (name === 'nodes') return value.nodes;
      if (name === 'pageInfo') return value.pageInfo;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'PullRequestConnection' && value.__typename === 'PullRequestConnection') {
      if (name === 'nodes') return value.nodes;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'PullRequestChangedFileConnection' && value.__typename === 'PullRequestChangedFileConnection') {
      if (name === 'nodes') return value.nodes;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'PullRequestChangedFile' && value.__typename === 'PullRequestChangedFile') {
      if (name === 'path') return value.path;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'PageInfo' && value.__typename === 'PageInfo') {
      if (name === 'hasNextPage') return value.hasNextPage;
      if (name === 'endCursor') return value.endCursor;
      return this.unknownField(typeName, name);
    }

    if (typeName === '__Type' && value.__typename === '__Type') {
      if (name === 'name') return value.name;
      if (name === 'kind') return value.kind;
      if (name === 'fields') {
        return value.fields.map((field) => ({ __typename: '__Field', name: field }) as GqlValue);
      }
      if (name === 'enumValues') {
        if (value.enumValues === null) return null;
        return value.enumValues.map((enumValue) => ({ __typename: '__EnumValue', name: enumValue }) as GqlValue);
      }
      return this.unknownField(typeName, name);
    }

    if (typeName === '__Field' && value.__typename === '__Field') {
      if (name === 'name') return value.name;
      return this.unknownField(typeName, name);
    }

    if (typeName === '__EnumValue' && value.__typename === '__EnumValue') {
      if (name === 'name') return value.name;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'IssueCommentEdge' && value.__typename === 'IssueCommentEdge') {
      if (name === 'node') return value.node;
      return this.unknownField(typeName, name);
    }

    if (typeName === 'IssueComment' && value.__typename === 'IssueComment') {
      if (name === 'id') return value.id;
      if (name === 'body') return value.body;
      return this.unknownField(typeName, name);
    }

    return this.unknownField(typeName, name);
  }

  findIssue(globalId: string): { repo: Repo; issue: Issue } | undefined {
    const decoded = decodeGlobalId(globalId);
    if (decoded === undefined || decoded.kind !== 'Issue') return undefined;
    for (const repo of this.#store.repos.values()) {
      if (repo.id !== decoded.repoId) continue;
      const issue = repo.issues.find((item) => item.number === decoded.number);
      if (issue !== undefined) return { repo, issue };
    }
    return undefined;
  }

  findPull(globalId: string): { repo: Repo; pull: Pull } | undefined {
    const decoded = decodeGlobalId(globalId);
    if (decoded === undefined || decoded.kind !== 'PullRequest') return undefined;
    for (const repo of this.#store.repos.values()) {
      if (repo.id !== decoded.repoId) continue;
      const pull = repo.pulls.find((item) => item.number === decoded.number);
      if (pull !== undefined) return { repo, pull };
    }
    return undefined;
  }

  unknownField(typeName: string, name: string): undefined {
    this.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return undefined;
  }
}

/**
 * Execute one GraphQL request body ({query, variables, operationName}) or a
 * batch (an array of them). Returns the response object for the body.
 */
export function executeGraphQL(
  store: Store,
  body: unknown,
): Record<string, unknown> | Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.map((item) => executeOne(store, item));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const input = (body ?? {}) as Record<string, unknown>;
  const query = typeof input.query === 'string' ? input.query : '';
  const variables = (input.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof input.operationName === 'string' ? input.operationName : undefined;
  if (query === '') {
    return { data: null, errors: [{ message: 'Must provide a query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error.' }] };
  }
  const operation =
    document.operations.find((item) => operationName !== undefined && item.name === operationName) ??
    document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  const executor = new Executor(store, variables, document.fragments);
  const data = executor.executeOperation(operation);
  if (executor.errors.length > 0) {
    return { data: data ?? null, errors: executor.errors };
  }
  return { data };
}
