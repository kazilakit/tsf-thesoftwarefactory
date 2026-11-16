// Node-only: the factory config library. Loads one factory.yaml keeping comments and key order, applies named changes,
// and saves atomically with a content-version check. The wizard and the FileStore's definition writes go through it.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Document, isMap, isNode, isPair, isScalar, isSeq, parse, parseDocument, type Node, type Pair, type YAMLMap } from 'yaml';
import { VersionConflictError, type BoardStore } from './boardStore.js';
import type { Check } from './checksSchema.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { DEFAULT_GH_USER, validateFactoryRepo, type AgentModels, type FactoryDef, type FactoryRepo } from './factories.js';
import { yamlVersion } from './factoriesFs.js';
import { normaliseFactoryYaml, type FactoryYaml } from './factoryYaml.js';
import { DEFAULT_STATUS_MAP } from './githubConfig.js';
import { TERMINAL } from './status.js';
import type { Gate, Status, Task } from './types.js';
import type { Validated } from './validated.js';

export interface RepoEntry { id: string; remote: string; host?: 'github'; baseBranch: string; protectedBranches?: string[]; checks: Check[] }

export interface FactoryFile {
  /** The factory folder (`<factories>/<id>`); `path` is its factory.yaml. */
  dir: string;
  path: string;
  doc: Document;
  /** yamlVersion of the text on disk; 0 for a new file. */
  version: number;
  shape: 'new' | 'legacy';
  /** Repos still in `repos/<id>.yaml`: repo id to file. */
  legacyRepoFiles: Record<string, string>;
  /** Files the save deletes (repo files moved into `repos.list`). */
  removedFiles: string[];
  /** The yamlVersion each removed file had when it was read: the save refuses to delete a file that changed since. */
  removedVersions: Record<string, number>;
  config: FactoryYaml;
}

export type BoardChoice = { source: 'none' } | { source: 'github'; project: string; label: string };

export type ConfigChange =
  | { kind: 'setFactory'; name?: string; docsPath?: string; git?: { name: string; email: string }; active?: boolean }
  | { kind: 'setModels'; models: AgentModels }
  | { kind: 'setGates'; gates: Record<Gate, boolean> }
  | { kind: 'setAccounts'; accounts: Record<string, string> }
  | { kind: 'setBoard'; board: BoardChoice }
  | { kind: 'setApprovers'; approvers: string[] }
  | { kind: 'setStatusMap'; statusMap: Record<Status, string> | null }
  | { kind: 'setProtectedBranches'; branches: string[] }
  | { kind: 'addRepo'; repo: RepoEntry }
  | { kind: 'updateRepo'; repoId: string; patch: Partial<Omit<RepoEntry, 'id' | 'protectedBranches'>> & { protectedBranches?: string[] | null } }
  | { kind: 'removeRepo'; repoId: string }
  /** `githubLogin` fills `accounts.github` when the old file has no `ghUser` (its fallback login is never written). */
  | { kind: 'convert'; githubLogin?: string };

export interface NewFactory {
  id: string; name: string; accounts: Record<string, string>;
  board: { source: 'none' } | { source: 'github'; project: string; label: string; approvers: string[]; statusMap: Record<Status, string> | null };
  gates: Record<Gate, boolean>; models: AgentModels; protectedBranches: string[]; repos: RepoEntry[]; docsPath?: string; git?: { name: string; email: string };
}

const HEADER = ' Written by factory init. Edit freely; ./factory init keeps your comments.';
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const fileOf = (dir: string): string => join(dir, 'factory.yaml');
const oldFormat = (path: string): string => `${path} is in the old format; convert it first`;
const sameRecord = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

// --- Document helpers: scalars are set in place (their comments stay); collections get a fresh node. ---

type Path = (string | number)[];

function value(doc: Document, v: unknown): unknown {
  return v !== null && typeof v === 'object' ? doc.createNode(v) : v;
}

function del(doc: Document, path: Path): void {
  if (doc.hasIn(path)) doc.deleteIn(path);
}

/** A sequence keeps the flow style of the one it replaces. */
function setSeq(doc: Document, path: Path, items: unknown[]): void {
  const prev = doc.getIn(path, true);
  const node = doc.createNode(items);
  if (isSeq(prev) && prev.flow) node.flow = true;
  doc.setIn(path, node);
}

/** Sets a map key by key, so the keys that stay keep their comments; keys not in `obj` go. */
function setMap(doc: Document, path: Path, obj: Record<string, unknown>): void {
  const prev = doc.getIn(path, true);
  if (!isMap(prev)) {
    doc.setIn(path, doc.createNode(obj));
    return;
  }
  for (const item of [...prev.items]) {
    const key = isScalar(item.key) ? item.key.value : item.key;
    if (!Object.hasOwn(obj, String(key))) prev.delete(key);
  }
  for (const [k, v] of Object.entries(obj)) prev.set(k, value(doc, v));
}

/** A repo entry as the YAML holds it; each check is one flow line. */
function repoNode(doc: Document, r: RepoEntry): Node {
  const node = doc.createNode(repoJs(r)) as YAMLMap;
  checksFlow(node.get('checks', true));
  return node;
}

const checkJs = (c: Check): Record<string, string> => ({ name: c.name, cwd: c.cwd, run: c.run, ...(c.needs ? { needs: c.needs } : {}) });

function repoJs(r: RepoEntry): Record<string, unknown> {
  return {
    id: r.id, remote: r.remote, ...(r.host ? { host: r.host } : {}), baseBranch: r.baseBranch,
    ...(r.protectedBranches ? { protectedBranches: r.protectedBranches } : {}), checks: r.checks.map(checkJs),
  };
}

function checksFlow(checks: unknown): void {
  if (isSeq(checks)) for (const c of checks.items) if (isMap(c)) c.flow = true;
}

const entryOf = (r: FactoryRepo): RepoEntry => ({
  id: r.repoId, remote: r.remote, baseBranch: r.baseBranch, checks: r.checks, ...(r.protectedBranches ? { protectedBranches: r.protectedBranches } : {}),
});

/** The index of a repo in `repos.list`, or -1. */
function listIndex(doc: Document, repoId: string): number {
  const list = doc.getIn(['repos', 'list'], true);
  if (!isSeq(list)) return -1;
  return list.items.findIndex((e) => isMap(e) && e.get('id') === repoId);
}

function appendRepo(doc: Document, node: Node): void {
  const list = doc.getIn(['repos', 'list'], true);
  if (isSeq(list)) list.items.push(node);
  else doc.setIn(['repos', 'list'], doc.createNode([node]));
}

// --- Normalising a document plus the repos still in repos/*.yaml ---

interface LegacyRepo { file: string; raw: unknown; version: number }

/** Normalises the document and the old repo files into one config, with the file versions set. */
function normalise(dir: string, doc: Document, version: number, legacy: Record<string, LegacyRepo>): Validated<FactoryYaml> {
  const path = fileOf(dir);
  const y = normaliseFactoryYaml(doc.toJS());
  if (!y.ok) return fail(`${path}: ${y.error}`);
  const id = basename(dir);
  if (y.value.def.factoryId !== id) return fail(`${path}: ${y.value.shape === 'new' ? 'factory.id:' : 'factoryId'} must be "${id}"`);
  const def: FactoryDef = { ...y.value.def, version };
  const repos = y.value.repos.map((r) => ({ ...r, version }));
  for (const [repoId, l] of Object.entries(legacy)) {
    const r = validateFactoryRepo(l.raw, def);
    if (!r.ok) return fail(`${l.file}: ${r.error}`);
    if (r.value.repoId !== repoId) return fail(`${l.file}: repoId must be "${repoId}"`);
    if (repos.some((x) => x.repoId === repoId)) return fail(`${l.file}: repo id ${repoId} is in repos.list and repos/${repoId}.yaml`);
    repos.push({ ...r.value, version: l.version });
  }
  return { ok: true, value: { ...y.value, def, repos } };
}

/** The repos of `config` that still live in their own files, as normalise takes them. */
function legacyOf(file: FactoryFile, files: Record<string, string>): Record<string, LegacyRepo> {
  const out: Record<string, LegacyRepo> = {};
  for (const [repoId, f] of Object.entries(files)) {
    const r = file.config.repos.find((x) => x.repoId === repoId)!;
    out[repoId] = { file: f, raw: r, version: r.version };
  }
  return out;
}

function build(dir: string, doc: Document, version: number, legacy: Record<string, LegacyRepo>, removed: Record<string, number>): Validated<FactoryFile> {
  const config = normalise(dir, doc, version, legacy);
  if (!config.ok) return config;
  const legacyRepoFiles = Object.fromEntries(Object.entries(legacy).map(([id, l]) => [id, l.file]));
  return {
    ok: true,
    value: {
      dir, path: fileOf(dir), doc, version, shape: config.value.shape, legacyRepoFiles,
      removedFiles: Object.keys(removed), removedVersions: removed, config: config.value,
    },
  };
}

/** What uses the GitHub account (every repo host is github in v1), as the normaliser names it. */
function loginUses(board: string, hasRepos: boolean): string[] {
  return [board === 'github' && 'board', hasRepos && 'repos'].filter((x): x is string => typeof x === 'string');
}

/** `accounts` for a file written from a source without a login of its own; an error when something needs one. */
function accountsFor(login: string | undefined, uses: string[]): Validated<Record<string, string>> {
  if (login) return { ok: true, value: { github: login } };
  return uses.length > 0 ? fail(`accounts.github is required (used by: ${uses.join(', ')})`) : { ok: true, value: {} };
}

/** Reads `<dir>/repos/*.yaml`. */
function readRepoFiles(dir: string): Validated<Record<string, LegacyRepo>> {
  const reposDir = join(dir, 'repos');
  const out: Record<string, LegacyRepo> = {};
  if (!existsSync(reposDir)) return { ok: true, value: out };
  for (const f of readdirSync(reposDir).filter((n) => n.endsWith('.yaml')).sort()) {
    const file = join(reposDir, f);
    try {
      const text = readFileSync(file, 'utf8');
      out[f.slice(0, -5)] = { file, raw: parse(text), version: yamlVersion(text) };
    } catch (e) {
      return fail(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: true, value: out };
}

/** Loads `<dir>/factory.yaml` (either shape) and its old `repos/*.yaml`. Errors read `<path>: <field.path>: <message>`. */
export function loadFactoryFile(dir: string): Validated<FactoryFile> {
  const path = fileOf(dir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return fail(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return fail(`${path}: ${doc.errors[0]!.message}`);
  const repos = readRepoFiles(dir);
  if (!repos.ok) return repos;
  return build(dir, doc, yamlVersion(text), repos.value, {});
}

// --- Changes ---

/** Applies one named change to a copy of the document and re-validates. The given file is not changed. */
export function applyChange(file: FactoryFile, change: ConfigChange): Validated<FactoryFile> {
  if (change.kind === 'convert') return convert(file, change.githubLogin);
  if (file.shape === 'legacy') return fail(oldFormat(file.path));
  const doc = file.doc.clone();
  const legacy = { ...file.legacyRepoFiles };
  const removed = { ...file.removedVersions };
  const error = edit(doc, file, change, legacy, removed);
  if (error) return fail(`${file.path}: ${error}`);
  return build(file.dir, doc, file.version, legacyOf(file, legacy), removed);
}

/** Edits `doc` (and the old repo files and removed lists) for one change; returns an error, or null. */
function edit(doc: Document, file: FactoryFile, change: Exclude<ConfigChange, { kind: 'convert' }>, legacy: Record<string, string>, removed: Record<string, number>): string | null {
  switch (change.kind) {
    case 'setFactory': {
      const { name, docsPath, git, active } = change;
      if (name !== undefined) doc.setIn(['factory', 'name'], name);
      if (docsPath !== undefined) doc.setIn(['factory', 'docsPath'], docsPath);
      if (git !== undefined) setMap(doc, ['factory', 'git'], git);
      if (active !== undefined) doc.setIn(['factory', 'active'], active);
      return null;
    }
    case 'setModels':
      if (Object.keys(change.models).length === 0) del(doc, ['factory', 'agents']);
      else setMap(doc, ['factory', 'agents'], change.models);
      return null;
    case 'setGates':
      setMap(doc, ['gates'], change.gates);
      return null;
    case 'setAccounts':
      setMap(doc, ['accounts'], change.accounts);
      return null;
    case 'setBoard':
      doc.setIn(['board', 'source'], change.board.source);
      if (change.board.source === 'github') {
        doc.setIn(['board', 'project'], change.board.project);
        doc.setIn(['board', 'label'], change.board.label);
      } else {
        for (const k of ['project', 'label', 'approvers', 'statusMap']) del(doc, ['board', k]);
      }
      return null;
    case 'setApprovers':
      if (file.config.board.source === 'none') return 'board.approvers: set the board first';
      setSeq(doc, ['board', 'approvers'], change.approvers);
      return null;
    case 'setStatusMap':
      if (file.config.board.source === 'none') return 'board.statusMap: set the board first';
      if (change.statusMap === null) del(doc, ['board', 'statusMap']);
      else setMap(doc, ['board', 'statusMap'], change.statusMap);
      return null;
    case 'setProtectedBranches':
      setSeq(doc, ['repos', 'protectedBranches'], change.branches);
      return null;
    case 'addRepo':
      if (Object.hasOwn(legacy, change.repo.id)) return `repos: duplicate repo id ${change.repo.id} (in repos/${change.repo.id}.yaml)`;
      appendRepo(doc, repoNode(doc, change.repo));
      return null;
    case 'updateRepo':
      return updateRepo(doc, file, change, legacy, removed);
    case 'removeRepo': {
      const i = listIndex(doc, change.repoId);
      if (i >= 0) doc.deleteIn(['repos', 'list', i]);
      else if (Object.hasOwn(legacy, change.repoId)) moveOut(file, change.repoId, legacy, removed);
      else return `repos: no repo ${change.repoId}`;
      return null;
    }
  }
}

/** Marks a repo file for deletion, with the version it was read at. */
function moveOut(file: FactoryFile, repoId: string, legacy: Record<string, string>, removed: Record<string, number>): void {
  removed[legacy[repoId]!] = file.config.repos.find((r) => r.repoId === repoId)!.version;
  delete legacy[repoId];
}

function updateRepo(doc: Document, file: FactoryFile, change: Extract<ConfigChange, { kind: 'updateRepo' }>, legacy: Record<string, string>, removed: Record<string, number>): string | null {
  const { repoId, patch } = change;
  const i = listIndex(doc, repoId);
  if (i < 0) {
    if (!Object.hasOwn(legacy, repoId)) return `repos: no repo ${repoId}`;
    const { protectedBranches, ...rest } = patch;
    const before = entryOf(file.config.repos.find((r) => r.repoId === repoId)!);
    const entry: RepoEntry = { ...before, ...definedOf(rest) };
    if (protectedBranches === null) delete entry.protectedBranches;
    else if (protectedBranches !== undefined) entry.protectedBranches = protectedBranches;
    appendRepo(doc, repoNode(doc, entry));
    moveOut(file, repoId, legacy, removed);
    return null;
  }
  const item = doc.getIn(['repos', 'list', i], true) as YAMLMap;
  for (const k of ['remote', 'host', 'baseBranch'] as const) if (patch[k] !== undefined) item.set(k, patch[k]);
  if (patch.protectedBranches === null) item.delete('protectedBranches');
  else if (patch.protectedBranches !== undefined) setSeq(doc, ['repos', 'list', i, 'protectedBranches'], patch.protectedBranches);
  if (patch.checks !== undefined) {
    item.set('checks', doc.createNode(patch.checks.map(checkJs)));
    checksFlow(item.get('checks', true));
  }
  return null;
}

const definedOf = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

// --- Converting the old shape ---

/** Old key paths and where they live in the new shape: comments on them are carried over. */
const CARRIED: [Path, Path][] = [
  [['factoryId'], ['factory', 'id']], [['name'], ['factory', 'name']], [['docsPath'], ['factory', 'docsPath']],
  [['active'], ['factory', 'active']], [['gitName'], ['factory', 'git', 'name']], [['gitEmail'], ['factory', 'git', 'email']],
  [['agentModels'], ['factory', 'agents']], [['ghUser'], ['accounts', 'github']], [['protectedBranches'], ['repos', 'protectedBranches']],
  [['github'], ['board']], [['github', 'project'], ['board', 'project']], [['github', 'label'], ['board', 'label']],
  [['github', 'approvers'], ['board', 'approvers']], [['github', 'statusMap'], ['board', 'statusMap']],
];

/**
 * Writes the new shape: the old flat file in the new layout and every `repos/*.yaml` in `repos.list` (those files go
 * on save). Keeps the top-of-file comment and, best effort, the comments on the keys it carries over. On a new-shape
 * file it only moves the repo files into the list.
 */
function convert(file: FactoryFile, githubLogin: string | undefined): Validated<FactoryFile> {
  const legacyIds = Object.keys(file.legacyRepoFiles);
  const legacy = { ...file.legacyRepoFiles };
  const removed = { ...file.removedVersions };
  for (const id of legacyIds) moveOut(file, id, legacy, removed);
  const repoComment = (id: string): string | undefined => repoFileComment(file.legacyRepoFiles[id]!);
  let doc: Document;
  if (file.shape === 'legacy') {
    const d = newShapeDoc(file, githubLogin);
    if (!d.ok) return fail(`${file.path}: ${d.error}`);
    doc = d.value;
  } else doc = file.doc.clone();
  for (const id of legacyIds) {
    const node = repoNode(doc, entryOf(file.config.repos.find((r) => r.repoId === id)!));
    const comment = repoComment(id);
    if (comment) node.commentBefore = comment;
    appendRepo(doc, node);
  }
  return build(file.dir, doc, file.version, {}, removed);
}

function repoFileComment(file: string): string | undefined {
  try {
    const d = parseDocument(readFileSync(file, 'utf8'));
    const first = isMap(d.contents) ? d.contents.items[0]?.key : undefined;
    return [d.commentBefore, d.contents?.commentBefore, isNode(first) ? first.commentBefore : undefined].filter(Boolean).join('\n') || undefined;
  } catch {
    return undefined;
  }
}

/** The legacy document as a new-shape document, without the repo files. */
function newShapeDoc(file: FactoryFile, githubLogin: string | undefined): Validated<Document> {
  const raw = file.doc.toJS() as Record<string, unknown>;
  const { config } = file;
  const git = { ...(raw.gitName !== undefined ? { name: raw.gitName } : {}), ...(raw.gitEmail !== undefined ? { email: raw.gitEmail } : {}) };
  const factory = {
    id: raw.factoryId, ...(raw.name !== undefined ? { name: raw.name } : {}), source: config.source,
    ...(raw.docsPath !== undefined ? { docsPath: raw.docsPath } : {}), ...(Object.keys(git).length > 0 ? { git } : {}),
    ...(raw.active !== undefined ? { active: raw.active } : {}), ...(config.def.agentModels ? { agents: raw.agentModels } : {}),
  };
  // The old file's own ghUser, else the given login; never the fallback login an old file without one ran on.
  const own = typeof raw.ghUser === 'string' && raw.ghUser.trim() !== '' ? raw.ghUser.trim() : undefined;
  const accounts = accountsFor(own ?? githubLogin, loginUses(config.board.source, config.repos.length > 0));
  if (!accounts.ok) return accounts;
  const github = raw.github as Record<string, unknown> | undefined;
  const { mode: _mode, ...boardRest } = github ?? {};
  const board = { source: config.board.source, ...boardRest };
  const repos = raw.protectedBranches !== undefined ? { protectedBranches: raw.protectedBranches } : undefined;
  const doc = new Document({ factory, ...(Object.keys(accounts.value).length > 0 ? { accounts: accounts.value } : {}), board, ...(repos ? { repos } : {}) });
  carryComments(file.doc, doc);
  return { ok: true, value: doc };
}

function pairAt(doc: Document, path: Path): Pair | undefined {
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return undefined;
  return parent.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === path[path.length - 1]);
}

function carryComments(from: Document, to: Document): void {
  const top = [from.commentBefore, isNode(from.contents) ? from.contents.commentBefore : undefined].filter(Boolean).join('\n');
  if (top) to.commentBefore = top;
  if (from.comment) to.comment = from.comment;
  for (const [a, b] of CARRIED) {
    const src = pairAt(from, a);
    const dst = pairAt(to, b);
    if (!src || !dst || !isNode(src.key) || !isNode(dst.key)) continue;
    if (src.key.commentBefore) dst.key.commentBefore = src.key.commentBefore;
    if (src.key.spaceBefore) dst.key.spaceBefore = true;
    if (isNode(src.value) && isNode(dst.value)) {
      if (src.value.comment) dst.value.comment = src.value.comment;
      if (src.value.commentBefore) dst.value.commentBefore = src.value.commentBefore;
    }
  }
}

// --- Saving ---

const STRINGIFY = { lineWidth: 0 };

/**
 * The yaml package re-renders every line (one space before an inline comment, its own flow padding). So that a save
 * changes only the lines a change touched, each output line the change left alone is taken from the file as it was.
 * This holds when the old text renders to the same number of lines; otherwise the rendered text is used as it is.
 */
function keepLines(old: string | null, rendered: string): string {
  if (old === null) return rendered;
  const orig = old.split('\n');
  const before = parseDocument(old).toString(STRINGIFY).split('\n');
  if (before.length !== orig.length) return rendered;
  const after = rendered.split('\n');
  const kept = lcsMatches(before, after);
  const merged = after.map((line, j) => (kept.has(j) ? orig[kept.get(j)!]! : line)).join('\n');
  // Never trade correctness for looks: the merged text must hold exactly what the rendered text holds.
  try {
    return isDeepStrictEqual(parse(merged), parse(rendered)) ? merged : rendered;
  } catch {
    return rendered;
  }
}

/** For each line of `b` in a longest common subsequence with `a`, the index of its match in `a`. */
function lcsMatches(a: string[], b: string[]): Map<number, number> {
  const n = a.length;
  const m = b.length;
  const len = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) len[i]![j] = a[i] === b[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
  }
  const out = new Map<number, number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) out.set(j++, i++);
    else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

const changed = (file: string, expected: number, actual: number): VersionConflictError =>
  new VersionConflictError(file, expected, actual, `${file} changed since it was read; reload and save again`);

/**
 * Saves the file: refuses an old-format file; throws VersionConflictError when the file on disk is not the one that
 * was read (or appeared since a new file was made), or a file it would delete changed or vanished; writes a temp file
 * and renames it over (keeping CRLF line endings); deletes `removedFiles`.
 * Returns the file as loaded again.
 */
export function saveFactoryFile(file: FactoryFile): FactoryFile {
  if (file.shape === 'legacy') throw new Error(oldFormat(file.path));
  const check = normalise(file.dir, file.doc, file.version, legacyOf(file, file.legacyRepoFiles));
  if (!check.ok) throw new Error(check.error);
  const text = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
  const onDisk = text === null ? 0 : yamlVersion(text);
  if (onDisk !== file.version || (file.version === 0 && text !== null)) throw changed(file.path, file.version, onDisk);
  for (const [f, v] of Object.entries(file.removedVersions)) {
    const now = existsSync(f) ? yamlVersion(readFileSync(f, 'utf8')) : 0;
    if (now !== v) throw changed(f, v, now);
  }
  mkdirSync(file.dir, { recursive: true });
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const out = keepLines(text === null ? null : text.replace(/\r\n/g, '\n'), file.doc.toString(STRINGIFY));
  const tmp = `${file.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, eol === '\n' ? out : out.replace(/\n/g, eol));
    renameSync(tmp, file.path);
  } finally {
    rmSync(tmp, { force: true });
  }
  for (const f of file.removedFiles) rmSync(f, { force: true });
  const reloaded = loadFactoryFile(file.dir);
  if (!reloaded.ok) throw new Error(reloaded.error);
  return reloaded.value;
}

// --- New files ---

function newDoc(dir: string, content: Record<string, unknown>): Validated<FactoryFile> {
  const doc = new Document(content);
  doc.commentBefore = HEADER;
  checksFlowAll(doc);
  return build(dir, doc, 0, {}, {});
}

function checksFlowAll(doc: Document): void {
  const list = doc.getIn(['repos', 'list'], true);
  if (isSeq(list)) for (const e of list.items) if (isMap(e)) checksFlow(e.get('checks', true));
}

/** A new local factory file (version 0, not yet on disk). Gates and models are written only when not the defaults. */
export function newFactoryFile(dir: string, init: NewFactory): Validated<FactoryFile> {
  const b = init.board;
  const board = b.source === 'none' ? { source: 'none' } : {
    source: 'github', project: b.project, label: b.label, approvers: b.approvers, ...(b.statusMap ? { statusMap: b.statusMap } : {}),
  };
  return newDoc(dir, {
    factory: {
      id: init.id, name: init.name, source: 'local', ...(init.docsPath ? { docsPath: init.docsPath } : {}), ...(init.git ? { git: init.git } : {}),
      active: true, ...(Object.keys(init.models).length > 0 ? { agents: init.models } : {}),
    },
    accounts: init.accounts,
    board,
    ...(sameRecord(init.gates, DEFAULT_SETTINGS.gates) ? {} : { gates: init.gates }),
    repos: { protectedBranches: init.protectedBranches, list: init.repos.map(repoJs) },
  });
}

/** A board.json definition (no YAML yet) as a new factory file: the "export to YAML" of design section 14, call 3. */
export function fileFromDefinition(
  dir: string, def: FactoryDef, repos: FactoryRepo[], gates: Record<Gate, boolean> | null, githubLogin?: string,
): Validated<FactoryFile> {
  const gh = def.github;
  const board = !gh ? { source: 'none' } : {
    source: 'github',
    project: `${gh.project.owner}/${gh.project.number}`, label: gh.label, approvers: gh.approvers,
    ...(sameRecord(gh.statusMap, DEFAULT_STATUS_MAP) ? {} : { statusMap: gh.statusMap }),
  };
  // A ghUser equal to the fallback login is what a definition without one holds: it is not written into a user's file.
  const own = def.ghUser !== DEFAULT_GH_USER ? def.ghUser : undefined;
  const accounts = accountsFor(own ?? githubLogin, loginUses(board.source, repos.length > 0));
  if (!accounts.ok) return fail(`${fileOf(dir)}: ${accounts.error}`);
  return newDoc(dir, {
    factory: {
      id: def.factoryId, name: def.name, source: 'local', ...(def.docsPath ? { docsPath: def.docsPath } : {}),
      ...(def.gitName || def.gitEmail ? { git: { name: def.gitName, email: def.gitEmail } } : {}),
      active: def.active, ...(def.agentModels ? { agents: def.agentModels } : {}),
    },
    ...(Object.keys(accounts.value).length > 0 ? { accounts: accounts.value } : {}),
    board,
    ...(gates ? { gates } : {}),
    repos: { protectedBranches: def.protectedBranches, list: repos.map((r) => repoJs(entryOf(r))) },
  });
}

/** The tasks of one factory repo that are not done or cancelled (removing a repo is refused while it has any). */
export async function openTasksForRepo(store: BoardStore, factoryId: string, repoId: string): Promise<Task[]> {
  return (await store.listTasks()).filter((t) => t.factoryId === factoryId && t.repo === repoId && !TERMINAL.has(t.status));
}
