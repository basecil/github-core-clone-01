// graphql.ts — GitHub GraphQL v4 endpoint (POST /api/graphql).
//
// A dependency-free GraphQL executor for the documents gh and github-mcp-server
// send (the kit's checks-graphql.ts GRAPHQL_DOCUMENTS): a small lexer +
// recursive-descent parser for the query-language subset those documents use,
// schema validation against the implemented surface, and resolvers over the
// shared store. Mutations go through the same store / pulls functions as REST,
// so every change is visible on both surfaces.
//
// Transport: POST /api/graphql, JSON body {query, variables?, operationName?}
// or a batch (an array of such operations, answered in order). Auth is the
// same bearer token as REST: missing/wrong → 401 {"message": ...}. Malformed
// JSON → 400 {"message": ...}. A GraphQL-level failure (an unknown field, a
// bad argument) is HTTP 200 with an `errors` array, never an HTTP error.
// A successful null (unknown repository, unknown node id) carries NO errors.
//
// Global ids are opaque base64url of `Kind:<stable parts>` (the repo's numeric
// id plus the issue/PR number), so they are stable across reads. Issue cursors
// are base64url of `cursor:<index>` in the ordered list. No randomness, no
// wall clock anywhere: timestamps come from the store's logical clock.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  checkAuth,
  createComment,
  createIssue,
  getIssue,
  getPullRequest,
  getRepoByName,
  isViewer,
  learnOwner,
  listRepos,
  PLACEHOLDER_LOGIN,
  repoOwnerLogin,
  tickIso,
  viewerLogin,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  computePullFiles,
  createPullRequestRecord,
  mergeableState,
  mergePullRequestRecord,
} from './pulls.ts';
import { sendError, sendJson, sendNotFound } from './rest.ts';

// ── Transport ─────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024;

class MalformedBodyError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read the request body (≤10 MB) and parse it as JSON (object or array). */
async function readBodyJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new MalformedBodyError('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw new MalformedBodyError('Problems parsing JSON');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedBodyError('Problems parsing JSON');
  }
}

/** Handle POST /api/graphql (mounted by app.ts). Always answers, never throws. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendNotFound(res);
      return;
    }
    if (!checkAuth(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    let body: unknown;
    try {
      body = await readBodyJson(req);
    } catch (err) {
      if (err instanceof MalformedBodyError) {
        sendError(res, 400, err.message);
        return;
      }
      throw err;
    }
    // GitHub's operation batching: a JSON array of operations is answered by an
    // array of per-operation bodies, in the same order.
    if (Array.isArray(body)) {
      sendJson(res, 200, body.map((entry) => executeRequest(entry)));
      return;
    }
    if (!isRecord(body)) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    sendJson(res, 200, executeRequest(body));
  } catch {
    sendError(res, 500, 'Internal Server Error');
  }
}

// ── Execution entry ───────────────────────────────────────────────────────────

interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

interface GraphQLResult {
  data: unknown;
  errors?: GraphQLError[];
}

/** One operation body ({query, variables?, operationName?}) → one result envelope. */
function executeRequest(entry: unknown): GraphQLResult {
  if (!isRecord(entry)) {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const query = entry.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isRecord(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  return executeDocument(query, variables, operationName);
}

/** Parse → select the operation → apply variable defaults → validate → execute. */
function executeDocument(
  query: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): GraphQLResult {
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }

  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  } else {
    return {
      data: null,
      errors: [{ message: 'Must provide operation name if query contains multiple operations.' }],
    };
  }

  // Provided values win; variable defaults fill the rest. An explicit null is
  // a value (the pagination document sends `after: null`).
  const coerced: Record<string, unknown> = {};
  for (const definition of operation.variables) {
    if (variables[definition.name] !== undefined) {
      coerced[definition.name] = variables[definition.name];
    } else if (definition.defaultValue !== null) {
      coerced[definition.name] = evalValue(definition.defaultValue, variables);
    }
  }
  for (const [key, value] of Object.entries(variables)) {
    if (!(key in coerced)) coerced[key] = value;
  }

  const validationErrors = validateOperation(document, operation);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };

  const ctx: ExecContext = { variables: coerced, fragments: document.fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, { __typename: rootType }, operation.selections, ctx, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ── Lexer ─────────────────────────────────────────────────────────────────────

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

class GraphQLSyntaxError extends Error {}

const PUNCTUATION = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function describeToken(token: Token): string {
  if (token.kind === 'eof') return 'end of the document';
  if (token.kind === 'string') return `string "${token.value}"`;
  return `${token.kind} "${token.value}"`;
}

/** Tokenize a GraphQL document. Commas and `#` comments are insignificant. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = source.length;
  const isNameStart = (char: string): boolean => /[_A-Za-z]/.test(char);
  const isNameContinue = (char: string): boolean => /[_0-9A-Za-z]/.test(char);
  const isDigit = (char: string): boolean => /[0-9]/.test(char);

  while (index < length) {
    const char = source[index] as string;
    // Whitespace, commas and comments.
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    // The spread punctuator.
    if (char === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    // Names.
    if (isNameStart(char)) {
      const start = index;
      index += 1;
      while (index < length && isNameContinue(source[index] as string)) index += 1;
      tokens.push({ kind: 'name', value: source.slice(start, index) });
      continue;
    }
    // Numbers (int or float).
    if (char === '-' || isDigit(char)) {
      const start = index;
      if (char === '-') index += 1;
      if (index >= length || !isDigit(source[index] as string)) {
        throw new GraphQLSyntaxError('Syntax Error: Invalid number.');
      }
      while (index < length && isDigit(source[index] as string)) index += 1;
      let isFloat = false;
      if (source[index] === '.' && isDigit(source[index + 1] as string)) {
        isFloat = true;
        index += 1;
        while (index < length && isDigit(source[index] as string)) index += 1;
      }
      const exponent = source[index];
      if (exponent === 'e' || exponent === 'E') {
        isFloat = true;
        index += 1;
        if (source[index] === '+' || source[index] === '-') index += 1;
        if (index >= length || !isDigit(source[index] as string)) {
          throw new GraphQLSyntaxError('Syntax Error: Invalid number.');
        }
        while (index < length && isDigit(source[index] as string)) index += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, index) });
      continue;
    }
    // Strings (with escapes).
    if (char === '"') {
      index += 1;
      let value = '';
      let closed = false;
      while (index < length) {
        const current = source[index] as string;
        if (current === '"') {
          index += 1;
          closed = true;
          break;
        }
        if (current === '\n' || current === '\r') break;
        if (current === '\\') {
          const escaped = source[index + 1];
          if (escaped === undefined) break;
          if (escaped === 'u') {
            const hex = source.slice(index + 2, index + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('Syntax Error: Invalid unicode escape.');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            index += 6;
            continue;
          }
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          const replacement = simple[escaped];
          if (replacement === undefined) throw new GraphQLSyntaxError(`Syntax Error: Invalid escape \\${escaped}.`);
          value += replacement;
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      if (!closed) throw new GraphQLSyntaxError('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value });
      continue;
    }
    throw new GraphQLSyntaxError(`Syntax Error: Unexpected character "${char}".`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ── AST + parser ──────────────────────────────────────────────────────────────

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  args: ArgumentNode[];
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: ArgumentNode[];
  directives: DirectiveNode[];
  selections: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinitionNode {
  name: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefinitionNode[];
  selections: SelectionNode[];
}

interface FragmentDefinitionNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinitionNode>;
}

/** Recursive-descent parser for the query-language subset the checks send. */
class Parser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.position] as Token;
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private isName(value?: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && (value === undefined || token.value === value);
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`Syntax Error: Expected "${value}", found ${describeToken(token)}.`);
    }
    return token;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new GraphQLSyntaxError(`Syntax Error: Expected ${what}, found ${describeToken(token)}.`);
    }
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefinitionNode>();
    while (this.peek().kind !== 'eof') {
      if (this.isPunct('{')) {
        operations.push({
          kind: 'query',
          name: null,
          variables: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (this.isName('query') || this.isName('mutation') || this.isName('subscription')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (this.isName('fragment')) {
        const fragment = this.parseFragmentDefinition();
        fragments.set(fragment.name, fragment);
        continue;
      }
      throw new GraphQLSyntaxError(`Syntax Error: Unexpected ${describeToken(this.peek())}.`);
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const kind = this.next().value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = this.parseVariableDefinitions();
    this.parseDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseVariableDefinitions(): VariableDefinitionNode[] {
    const definitions: VariableDefinitionNode[] = [];
    if (!this.isPunct('(')) return definitions;
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.parseDirectives();
      definitions.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  /** Consume a type reference (named, list, non-null); the shape is not needed. */
  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.isPunct('!')) this.next();
  }

  private parseFragmentDefinition(): FragmentDefinitionNode {
    this.next(); // 'fragment'
    const name = this.expectName('a fragment name');
    if (name === 'on') throw new GraphQLSyntaxError('Syntax Error: Unexpected Name "on".');
    this.expectName('"on"');
    const typeCondition = this.expectName('a type name');
    this.parseDirectives();
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') {
        throw new GraphQLSyntaxError('Syntax Error: Expected "}", found end of the document.');
      }
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.isName('on')) {
        this.next();
        const typeCondition = this.expectName('a type name');
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    let name = this.expectName('a field name');
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName('a field name');
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selections };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.isPunct('(')) return args;
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.isPunct('@')) {
      this.next();
      const name = this.expectName('a directive name');
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(constantOnly: boolean): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      if (constantOnly) throw new GraphQLSyntaxError('Syntax Error: A variable is not allowed in a constant value.');
      this.next();
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: token.value };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: token.value };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue(constantOnly));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constantOnly) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLSyntaxError(`Syntax Error: Unexpected ${describeToken(token)}.`);
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// ── Value evaluation ──────────────────────────────────────────────────────────

/** Evaluate an AST value against the operation's variables (undefined = absent). */
function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) {
        const value = evalValue(field.value, variables);
        if (value !== undefined) out[field.name] = value;
      }
      return out;
    }
  }
}

/** A field's arguments, evaluated; an undefined variable means the argument is absent. */
function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) {
    const value = evalValue(arg.value, variables);
    if (value !== undefined) args[arg.name] = value;
  }
  return args;
}

/** @skip(if:) / @include(if:) — the only directives the documents could carry. */
function skippedByDirective(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const arg = directive.args.find((entry) => entry.name === 'if');
    if (arg === undefined) continue;
    const value = evalValue(arg.value, variables);
    if (directive.name === 'skip' && value === true) return true;
    if (directive.name === 'include' && value !== true) return true;
  }
  return false;
}

// ── Schema ────────────────────────────────────────────────────────────────────

// Field name → return type (`[T]` for a list of T). Only the surface the checks
// use, plus the introspection types. This table drives BOTH validation (an
// unknown field is a GraphQL error naming it) and the `__type` introspection
// answers (a type's fields are exactly the fields implemented here).
const SCHEMA: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: {
    login: 'String',
    id: 'ID',
  },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
    createdAt: 'String',
    updatedAt: 'String',
    description: 'String',
  },
  Ref: {
    name: 'String',
  },
  Issue: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    createdAt: 'String',
    updatedAt: 'String',
  },
  IssueConnection: {
    nodes: '[Issue]',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  },
  PageInfo: {
    hasNextPage: 'Boolean',
    hasPreviousPage: 'Boolean',
    startCursor: 'String',
    endCursor: 'String',
  },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'String',
    files: 'PullRequestChangedFileConnection',
    createdAt: 'String',
    updatedAt: 'String',
  },
  PullRequestConnection: {
    nodes: '[PullRequest]',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  },
  PullRequestChangedFileConnection: {
    nodes: '[PullRequestChangedFile]',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  },
  PullRequestChangedFile: {
    path: 'String',
  },
  Node: {
    id: 'ID',
  },
  IssueComment: {
    id: 'ID',
    body: 'String',
    createdAt: 'String',
    updatedAt: 'String',
  },
  IssueCommentEdge: {
    node: 'IssueComment',
    cursor: 'String',
  },
  CreateIssuePayload: {
    issue: 'Issue',
    clientMutationId: 'String',
  },
  CloseIssuePayload: {
    issue: 'Issue',
    clientMutationId: 'String',
  },
  CreatePullRequestPayload: {
    pullRequest: 'PullRequest',
    clientMutationId: 'String',
  },
  MergePullRequestPayload: {
    pullRequest: 'PullRequest',
    clientMutationId: 'String',
  },
  AddCommentPayload: {
    commentEdge: 'IssueCommentEdge',
    subject: 'Issue',
    clientMutationId: 'String',
  },
  __Type: {
    name: 'String',
    kind: 'String',
    description: 'String',
    fields: '[__Field]',
    enumValues: '[__EnumValue]',
  },
  __Field: {
    name: 'String',
    description: 'String',
  },
  __EnumValue: {
    name: 'String',
    description: 'String',
  },
  __Schema: {
    queryType: '__Type',
    mutationType: '__Type',
    subscriptionType: '__Type',
    types: '[__Type]',
    directives: '[__Directive]',
  },
  __Directive: {
    name: 'String',
  },
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

/** The object types that implement the Node interface (for `... on Node`). */
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User']);

/** `[T]` → `T`; anything else unchanged. */
function unwrapType(type: string): string {
  if (type.startsWith('[') && type.endsWith(']')) return type.slice(1, -1);
  return type;
}

/** Whether an inline fragment's type condition applies to an object of this type. */
function fragmentApplies(typeCondition: string, objectType: string): boolean {
  if (typeCondition === objectType) return true;
  if (typeCondition === 'Node') return NODE_TYPES.has(objectType);
  return false;
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Validate an operation's selections against the schema; every unknown field is an error. */
function validateOperation(document: DocumentNode, operation: OperationNode): GraphQLError[] {
  const errors: GraphQLError[] = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(rootType, operation.selections, document, errors, new Set());
  return errors;
}

function validateSelections(
  typeName: string,
  selections: SelectionNode[],
  document: DocumentNode,
  errors: GraphQLError[],
  seenFragments: Set<string>,
): void {
  const fields = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') {
        if (selection.selections !== null) {
          errors.push({ message: 'Field "__typename" must not have a selection since type "String" has no subfields.' });
        }
        continue;
      }
      const returnType = fields?.[selection.name];
      if (returnType === undefined) {
        errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
        continue;
      }
      const unwrapped = unwrapType(returnType);
      if (SCALAR_TYPES.has(unwrapped)) {
        if (selection.selections !== null) {
          errors.push({
            message: `Field "${selection.name}" must not have a selection since type "${unwrapped}" has no subfields.`,
          });
        }
      } else if (selection.selections === null) {
        errors.push({ message: `Field "${selection.name}" of type "${unwrapped}" must have a selection of subfields.` });
      } else {
        validateSelections(unwrapped, selection.selections, document, errors, seenFragments);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      const onType = selection.typeCondition ?? typeName;
      if (SCHEMA[onType] === undefined) {
        errors.push({ message: `Unknown type "${onType}".` });
        continue;
      }
      validateSelections(onType, selection.selections, document, errors, seenFragments);
      continue;
    }
    if (seenFragments.has(selection.name)) continue;
    const fragment = document.fragments.get(selection.name);
    if (fragment === undefined) {
      errors.push({ message: `Unknown fragment "${selection.name}".` });
      continue;
    }
    if (SCHEMA[fragment.typeCondition] === undefined) {
      errors.push({ message: `Unknown type "${fragment.typeCondition}".` });
      continue;
    }
    seenFragments.add(selection.name);
    validateSelections(fragment.typeCondition, fragment.selections, document, errors, seenFragments);
  }
}

// ── Executor ──────────────────────────────────────────────────────────────────

/** A field error: the field answers null and the error is collected, like GitHub. */
class GqlError extends Error {}

/** Every resolved object carries its __typename plus its store records. */
type SourceObject = Record<string, unknown>;

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinitionNode>;
  errors: GraphQLError[];
}

type Resolver = (source: SourceObject, args: Record<string, unknown>, ctx: ExecContext) => unknown;

/** Execute a selection set on an object; returns the response object. */
function executeSelections(
  typeName: string,
  source: SourceObject,
  selections: SelectionNode[],
  ctx: ExecContext,
  path: (string | number)[],
): Record<string, unknown> {
  const grouped = collectFields(source, selections, ctx);
  const result: Record<string, unknown> = {};
  for (const [responseKey, group] of grouped) {
    const field = group[0] as FieldNode;
    const mergedSelections = group.flatMap((entry) => entry.selections ?? []);
    const fieldPath = [...path, responseKey];
    let value: unknown;
    try {
      value = resolveField(typeName, source, field.name, argsOf(field, ctx.variables), ctx);
    } catch (err) {
      if (err instanceof GqlError) {
        ctx.errors.push({ message: err.message, path: fieldPath });
        result[responseKey] = null;
        continue;
      }
      throw err;
    }
    result[responseKey] = completeValue(value, mergedSelections, ctx, fieldPath);
  }
  return result;
}

/**
 * Expand fragments and @skip/@include, then group the fields by response key
 * (alias or name), merging the selection sets of repeated fields.
 */
function collectFields(
  source: SourceObject,
  selections: SelectionNode[],
  ctx: ExecContext,
): Map<string, FieldNode[]> {
  const grouped = new Map<string, FieldNode[]>();
  const objectType = typeof source.__typename === 'string' ? source.__typename : '';
  const collect = (list: SelectionNode[], visited: Set<string>): void => {
    for (const selection of list) {
      if (selection.kind === 'field') {
        if (skippedByDirective(selection.directives, ctx.variables)) continue;
        const key = selection.alias ?? selection.name;
        const group = grouped.get(key);
        if (group === undefined) grouped.set(key, [selection]);
        else group.push(selection);
        continue;
      }
      if (selection.kind === 'inline') {
        if (skippedByDirective(selection.directives, ctx.variables)) continue;
        if (selection.typeCondition !== null && !fragmentApplies(selection.typeCondition, objectType)) continue;
        collect(selection.selections, visited);
        continue;
      }
      if (skippedByDirective(selection.directives, ctx.variables)) continue;
      if (visited.has(selection.name)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue; // validation already reported it
      visited.add(selection.name);
      if (!fragmentApplies(fragment.typeCondition, objectType)) continue;
      collect(fragment.selections, visited);
    }
  };
  collect(selections, new Set());
  return grouped;
}

/** Complete a resolved value: null stays null, lists map, objects recurse. */
function completeValue(
  value: unknown,
  selections: SelectionNode[],
  ctx: ExecContext,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, selections, ctx, [...path, index]));
  }
  if (typeof value === 'object') {
    const source = value as SourceObject;
    const typeName = typeof source.__typename === 'string' ? source.__typename : '';
    if (selections.length === 0 || typeName === '') return value;
    return executeSelections(typeName, source, selections, ctx, path);
  }
  return value;
}

/** Resolve one field: `__typename`, a resolver, or a plain property of the source. */
function resolveField(
  typeName: string,
  source: SourceObject,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: ExecContext,
): unknown {
  if (fieldName === '__typename') return source.__typename ?? typeName;
  const resolver = RESOLVERS[typeName]?.[fieldName];
  if (resolver !== undefined) return resolver(source, args, ctx);
  if (fieldName in source) return source[fieldName];
  return null;
}

// ── Global ids + cursors ──────────────────────────────────────────────────────

/**
 * An opaque, stable global id: base64url of `Kind:<stable parts>`. The repo's
 * numeric id plus the issue/PR number never change, so repeated reads agree.
 */
function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    // A round-trip check rejects ids that merely decode to something plausible.
    if (Buffer.from(text, 'utf8').toString('base64url') !== id) return null;
    const parts = text.split(':');
    const kind = parts[0];
    if (kind === undefined || kind === '' || parts.length < 2) return null;
    return { kind, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

/** An opaque cursor: base64url of `cursor:<index>` in the ordered list. */
function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return null;
    const index = Number(match[1]);
    return Number.isSafeInteger(index) ? index : null;
  } catch {
    return null;
  }
}

// ── Object wrappers ───────────────────────────────────────────────────────────

function userObject(login: string): SourceObject {
  return { __typename: 'User', login };
}

function repoObject(repo: Repo): SourceObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): SourceObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: PullRequest): SourceObject {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObject(repo: Repo, issue: Issue, comment: IssueComment): SourceObject {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function asRepo(source: SourceObject): Repo {
  return source.repo as Repo;
}

function asIssue(source: SourceObject): Issue {
  return source.issue as Issue;
}

function asPull(source: SourceObject): PullRequest {
  return source.pull as PullRequest;
}

function asComment(source: SourceObject): IssueComment {
  return source.comment as IssueComment;
}

// ── Global-id lookups ─────────────────────────────────────────────────────────

function repoByNumericId(id: number): Repo | undefined {
  return listRepos().find((candidate) => candidate.id === id);
}

function requireRepo(id: unknown): Repo {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  const numericId = decoded !== null && decoded.kind === 'Repository' ? Number(decoded.parts[0]) : Number.NaN;
  const repo = Number.isInteger(numericId) ? repoByNumericId(numericId) : undefined;
  if (repo === undefined) throw new GqlError(`Could not resolve to a Repository with the id of ${String(id)}.`);
  return repo;
}

function requireIssue(id: unknown): { repo: Repo; issue: Issue } {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  const repoId = decoded !== null && decoded.kind === 'Issue' ? Number(decoded.parts[0]) : Number.NaN;
  const number = decoded !== null && decoded.kind === 'Issue' ? Number(decoded.parts[1]) : Number.NaN;
  const repo = Number.isInteger(repoId) ? repoByNumericId(repoId) : undefined;
  const issue = repo !== undefined && Number.isInteger(number) ? getIssue(repo, number) : undefined;
  if (repo === undefined || issue === undefined) {
    throw new GqlError(`Could not resolve to an Issue with the id of ${String(id)}.`);
  }
  return { repo, issue };
}

function requirePull(id: unknown): { repo: Repo; pull: PullRequest } {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  const repoId = decoded !== null && decoded.kind === 'PullRequest' ? Number(decoded.parts[0]) : Number.NaN;
  const number = decoded !== null && decoded.kind === 'PullRequest' ? Number(decoded.parts[1]) : Number.NaN;
  const repo = Number.isInteger(repoId) ? repoByNumericId(repoId) : undefined;
  const pull = repo !== undefined && Number.isInteger(number) ? getPullRequest(repo, number) : undefined;
  if (repo === undefined || pull === undefined) {
    throw new GqlError(`Could not resolve to a PullRequest with the id of ${String(id)}.`);
  }
  return { repo, pull };
}

/** Query.node(id:) — any global id round-trips to its object, or null. */
function nodeById(id: string): SourceObject | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const [first, second, third] = decoded.parts;
  if (decoded.kind === 'Repository') {
    const repoId = Number(first);
    if (!Number.isInteger(repoId)) return null;
    const repo = repoByNumericId(repoId);
    return repo === undefined ? null : repoObject(repo);
  }
  if (decoded.kind === 'User') {
    return typeof first === 'string' && first !== '' ? userObject(first) : null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest' || decoded.kind === 'IssueComment') {
    const repoId = Number(first);
    const number = Number(second);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
    const repo = repoByNumericId(repoId);
    if (repo === undefined) return null;
    if (decoded.kind === 'Issue') {
      const issue = getIssue(repo, number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (decoded.kind === 'PullRequest') {
      const pull = getPullRequest(repo, number);
      return pull === undefined ? null : pullObject(repo, pull);
    }
    const commentId = Number(third);
    if (!Number.isInteger(commentId)) return null;
    const issue = getIssue(repo, number);
    const comment = issue?.comments.find((entry) => entry.id === commentId);
    return issue === undefined || comment === undefined ? null : commentObject(repo, issue, comment);
  }
  return null;
}

// ── Connections ───────────────────────────────────────────────────────────────

/** Slice an ordered list into a Relay connection (first/after + pageInfo). */
function paginate<T>(
  ordered: readonly T[],
  args: Record<string, unknown>,
  map: (item: T) => SourceObject,
  typeName: string,
): SourceObject {
  const first =
    typeof args.first === 'number' && Number.isFinite(args.first)
      ? Math.max(0, Math.floor(args.first))
      : ordered.length;
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const index = decodeCursor(after);
    if (index !== null) start = Math.min(index + 1, ordered.length);
  }
  const slice = ordered.slice(start, start + first);
  const hasNextPage = start + slice.length < ordered.length;
  return {
    __typename: typeName,
    nodes: slice.map(map),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length === 0 ? null : encodeCursor(start),
      endCursor: slice.length === 0 ? null : encodeCursor(start + slice.length - 1),
    },
    totalCount: ordered.length,
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): SourceObject {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  // orderBy {field, direction}; the default is CREATED_AT DESC, as on GitHub.
  // Creation order is number order — every created_at takes the next logical tick.
  const orderBy = isRecord(args.orderBy) ? args.orderBy : undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  if (orderBy?.field === 'UPDATED_AT') {
    list.sort((a, b) => {
      if (a.updated_at !== b.updated_at) return direction * (a.updated_at < b.updated_at ? -1 : 1);
      return direction * (a.number - b.number);
    });
  } else {
    list.sort((a, b) => direction * (a.number - b.number));
  }
  return paginate(list, args, (issue) => issueObject(repo, issue), 'IssueConnection');
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): SourceObject {
  let list = [...repo.pullRequests];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.filter((value): value is string => typeof value === 'string'));
    list = list.filter((pull) => wanted.has(pullState(pull)));
  } else {
    // GitHub's default: open pull requests only.
    list = list.filter((pull) => pull.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  return paginate(list, args, (pull) => pullObject(repo, pull), 'PullRequestConnection');
}

/** GitHub's PullRequestState: a merged PR reads MERGED, never CLOSED. */
function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ── Introspection ─────────────────────────────────────────────────────────────

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

/** The __Type record for a named type, or null when the schema has no such type. */
function typeObject(name: string): SourceObject | null {
  if (name === 'SearchType') {
    return { __typename: '__Type', name, kind: 'ENUM', fields: [], enumValues: [...SEARCH_TYPE_VALUES] };
  }
  const fields = SCHEMA[name];
  if (fields === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: name === 'Node' ? 'INTERFACE' : 'OBJECT',
    fields: Object.keys(fields),
    enumValues: [],
  };
}

function schemaObject(): SourceObject {
  const types: SourceObject[] = [];
  for (const name of [...Object.keys(SCHEMA), 'SearchType']) {
    const type = typeObject(name);
    if (type !== null) types.push(type);
  }
  return {
    __typename: '__Schema',
    queryType: typeObject('Query'),
    mutationType: typeObject('Mutation'),
    subscriptionType: null,
    types,
    directives: [],
  };
}

// ── Resolvers ─────────────────────────────────────────────────────────────────

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => userObject(viewerLogin() ?? PLACEHOLDER_LOGIN),
    repository: (_source, args) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      // Owner-bearing, authenticated: learn the viewer login from the argument
      // too, so viewer.login is right even if GraphQL runs before any REST call.
      learnOwner(owner);
      if (!isViewer(owner)) return null;
      const repo = getRepoByName(name);
      return repo === undefined ? null : repoObject(repo);
    },
    node: (_source, args) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      return nodeById(id);
    },
    __type: (_source, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      return typeObject(name);
    },
    __schema: () => schemaObject(),
  },

  Mutation: {
    createIssue: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = requireRepo(input.repositoryId);
      const title = input.title;
      if (typeof title !== 'string' || title === '') throw new GqlError('Title is required.');
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssue(repo, { title, body, labels: [] });
      return {
        __typename: 'CreateIssuePayload',
        issue: issueObject(repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    closeIssue: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const { repo, issue } = requireIssue(input.issueId);
      if (issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closed_at = tickIso();
      }
      issue.updated_at = tickIso();
      return {
        __typename: 'CloseIssuePayload',
        issue: issueObject(repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    createPullRequest: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = requireRepo(input.repositoryId);
      const title = input.title;
      const baseRef = input.baseRefName;
      const headRef = input.headRefName;
      if (typeof title !== 'string' || title === '') throw new GqlError('Title is required.');
      if (typeof baseRef !== 'string' || typeof headRef !== 'string') {
        throw new GqlError('baseRefName and headRefName are required.');
      }
      const pull = createPullRequestRecord(repo, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
      });
      if (pull === null) throw new GqlError('Head or base branch does not exist.');
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullObject(repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    mergePullRequest: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const { repo, pull } = requirePull(input.pullRequestId);
      const method = input.mergeMethod;
      if (method !== 'SQUASH' && method !== 'MERGE') {
        throw new GqlError(`Merge method ${String(method)} is not supported.`);
      }
      const result = mergePullRequestRecord(repo, pull, method === 'SQUASH' ? 'squash' : 'merge');
      if (!result.ok) throw new GqlError(result.message);
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullObject(repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    addComment: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const { repo, issue } = requireIssue(input.subjectId);
      const body = input.body;
      if (typeof body !== 'string' || body === '') throw new GqlError('Body is required.');
      const comment = createComment(issue, body);
      issue.updated_at = tickIso();
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: commentObject(repo, issue, comment),
          cursor: Buffer.from(`comment:${comment.id}`, 'utf8').toString('base64url'),
        },
        subject: issueObject(repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
  },

  Repository: {
    id: (source) => globalId('Repository', asRepo(source).id),
    databaseId: (source) => asRepo(source).id,
    name: (source) => asRepo(source).name,
    nameWithOwner: (source) => {
      const repo = asRepo(source);
      return `${repoOwnerLogin(repo)}/${repo.name}`;
    },
    owner: (source) => userObject(repoOwnerLogin(asRepo(source))),
    defaultBranchRef: (source) => {
      const repo = asRepo(source);
      if (!repo.refs.has(`refs/heads/${repo.default_branch}`)) return null;
      return { __typename: 'Ref', name: repo.default_branch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = asRepo(source);
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = getIssue(repo, number);
      return issue === undefined ? null : issueObject(repo, issue);
    },
    issues: (source, args) => issuesConnection(asRepo(source), args),
    pullRequests: (source, args) => pullRequestsConnection(asRepo(source), args),
    pullRequest: (source, args) => {
      const repo = asRepo(source);
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = getPullRequest(repo, number);
      return pull === undefined ? null : pullObject(repo, pull);
    },
    createdAt: (source) => asRepo(source).created_at,
    updatedAt: (source) => asRepo(source).updated_at,
    description: (source) => asRepo(source).description,
  },

  Issue: {
    id: (source) => globalId('Issue', asRepo(source).id, asIssue(source).number),
    number: (source) => asIssue(source).number,
    title: (source) => asIssue(source).title,
    body: (source) => asIssue(source).body,
    state: (source) => (asIssue(source).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (source) => asIssue(source).created_at,
    updatedAt: (source) => asIssue(source).updated_at,
  },

  PullRequest: {
    id: (source) => globalId('PullRequest', asRepo(source).id, asPull(source).number),
    number: (source) => asPull(source).number,
    title: (source) => asPull(source).title,
    body: (source) => asPull(source).body,
    state: (source) => pullState(asPull(source)),
    merged: (source) => asPull(source).merged,
    headRefName: (source) => asPull(source).head.ref,
    baseRefName: (source) => asPull(source).base.ref,
    mergeable: (source) => mergeableState(asRepo(source), asPull(source)),
    files: (source, args) => {
      const repo = asRepo(source);
      const pull = asPull(source);
      const files = computePullFiles(repo, pull);
      const first =
        typeof args.first === 'number' && Number.isFinite(args.first)
          ? Math.max(0, Math.floor(args.first))
          : files.length;
      const slice = files.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: slice.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: slice.length < files.length,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: files.length,
      };
    },
    createdAt: (source) => asPull(source).created_at,
    updatedAt: (source) => asPull(source).updated_at,
  },

  IssueComment: {
    id: (source) => globalId('IssueComment', asRepo(source).id, asIssue(source).number, asComment(source).id),
    body: (source) => asComment(source).body,
    createdAt: (source) => asComment(source).created_at,
    updatedAt: (source) => asComment(source).updated_at,
  },

  __Type: {
    fields: (source) =>
      (source.fields as string[]).map((name) => ({ __typename: '__Field', name })),
    enumValues: (source) =>
      (source.enumValues as string[]).map((name) => ({ __typename: '__EnumValue', name })),
  },
};
