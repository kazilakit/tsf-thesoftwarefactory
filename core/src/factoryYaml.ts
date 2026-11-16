// Pure (no Node API): turns either factory.yaml shape (provider-neutral, or the legacy flat one) into the internal definitions.
import {
  RESERVED_ID, validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo,
} from './factories.js';
import { GATE_DOC } from './gates.js';
import { DEFAULT_LABEL, DEFAULT_STATUS_MAP, type GitHubSettings, type ProjectRef } from './githubConfig.js';
import type { Gate, Status } from './types.js';
import { NO_FACTORY_APP, type Validated } from './validated.js';

/** Where the factory's state lives: this build has the local store only (`factory-app` is refused with a clear error). */
export type FactorySource = 'local';
export type BoardSource = 'none' | 'github' | 'trello' | 'jira';

export interface BoardConfig {
  source: BoardSource;
  /** The GitHub Project; null when the factory does not use GitHub. */
  project: ProjectRef | null;
  label: string;
  approvers: string[];
  statusMap: Record<Status, string>;
}

/** One factory.yaml, normalised. `def.version` and each repo's `version` are 0: the loader sets them. */
export interface FactoryYaml {
  shape: 'new' | 'legacy';
  source: FactorySource;
  def: FactoryDef;
  repos: FactoryRepo[];
  /** The YAML's gates; null when it has none. */
  gates: Partial<Record<Gate, boolean>> | null;
  /** Login per service, never a token. */
  accounts: Record<string, string>;
  board: BoardConfig;
}

const FACTORY_SOURCES: readonly FactorySource[] = ['local'];
const BOARD_SOURCES: readonly BoardSource[] = ['none', 'github', 'trello', 'jira'];
const RESERVED_BOARDS: readonly string[] = ['trello', 'jira'];
const MIRRORS = ['none'] as const;
const GATES = Object.keys(GATE_DOC) as Gate[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const given = (v: unknown): boolean => v !== undefined && v !== null;

/** Where each internal definition field lives in the new shape. */
const DEF_PATHS: Record<string, string> = {
  factoryId: 'factory.id', name: 'factory.name', gitName: 'factory.git.name', gitEmail: 'factory.git.email', docsPath: 'factory.docsPath',
  ghUser: 'accounts.github', active: 'factory.active', agentModels: 'factory.agents', protectedBranches: 'repos.protectedBranches',
  github: 'board', version: 'factory.version',
};
const repoPaths = (prefix: string): Record<string, string> => ({
  repoId: `${prefix}id`, remote: `${prefix}remote`, baseBranch: `${prefix}baseBranch`, checks: `${prefix}checks`,
  protectedBranches: `${prefix}protectedBranches`, version: `${prefix}version`,
});

/** Rewrites an internal error (`field.sub message`) as `<yaml.path>: message`; an error it cannot place is kept as it is. */
function located(error: string, paths: Record<string, string>): string {
  const m = /^(\w+)((?:\.[\w-]+)*):? (.*)$/.exec(error);
  if (!m || !Object.hasOwn(paths, m[1]!)) return error;
  return `${paths[m[1]!]}${m[2]}: ${m[3]}`;
}

/** An optional object at `path`; undefined when absent. */
function objectAt(parent: Record<string, unknown>, key: string, path: string): Validated<Record<string, unknown> | undefined> {
  const v = parent[key];
  if (!given(v)) return { ok: true, value: undefined };
  return isObject(v) ? { ok: true, value: v } : fail(`${path}: must be an object`);
}

/** An optional choice at `path`, `fallback` when absent. */
function choiceAt<T extends string>(v: unknown, path: string, choices: readonly T[], fallback: T): Validated<T> {
  if (!given(v)) return { ok: true, value: fallback };
  return (choices as readonly unknown[]).includes(v) ? { ok: true, value: v as T } : fail(`${path}: must be one of ${choices.join(', ')}`);
}

/** A repo host: only github in v1. Blank counts as left out. */
function hostAt(v: unknown, path: string): Validated<'github'> {
  if (!given(v) || v === 'github' || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: 'github' };
  return typeof v === 'string' ? fail(`${path}: ${v} is not supported yet`) : fail(`${path}: must be text`);
}

function accountsOf(v: unknown): Validated<Record<string, string>> {
  if (!given(v)) return { ok: true, value: {} };
  if (!isObject(v)) return fail('accounts: must map services to logins');
  const out: Record<string, string> = {};
  for (const [k, login] of Object.entries(v)) {
    if (typeof login !== 'string') return fail(`accounts.${k}: must be text`);
    if (login.trim() !== '') out[k] = login.trim();
  }
  return { ok: true, value: out };
}

function gatesOf(v: unknown): Validated<Partial<Record<Gate, boolean>> | null> {
  if (!given(v)) return { ok: true, value: null };
  if (!isObject(v)) return fail('gates: must map gates to true or false');
  const out: Partial<Record<Gate, boolean>> = {};
  for (const [k, on] of Object.entries(v)) {
    if (!(GATES as string[]).includes(k)) return fail(`gates: has an unknown gate: ${k}`);
    if (typeof on !== 'boolean') return fail(`gates.${k}: must be true or false`);
    out[k as Gate] = on;
  }
  return { ok: true, value: out };
}

/** The board as the factory sees it; the GitHub fields come from the validated github block when there is one. */
function boardOf(source: BoardSource, github: GitHubSettings | undefined): BoardConfig {
  if (!github) return { source, project: null, label: DEFAULT_LABEL, approvers: [], statusMap: { ...DEFAULT_STATUS_MAP } };
  const { project, label, approvers, statusMap } = github;
  return { source, project, label, approvers, statusMap };
}

/** The legacy flat shape: validated as today, then mapped. Repos live in `repos/*.yaml` and are not read here. */
function fromLegacy(raw: unknown): Validated<FactoryYaml> {
  const d = validateFactoryDef(raw);
  if (!d.ok) return d;
  const def = { ...d.value, version: 0 };
  const rawGhUser = (raw as Record<string, unknown>).ghUser;
  return {
    ok: true,
    value: {
      shape: 'legacy', source: 'local', def, repos: [], gates: null,
      // The resolved login whenever GitHub is used, even if the file left ghUser out (it falls back as today).
      accounts: def.github || (typeof rawGhUser === 'string' && rawGhUser.trim() !== '') ? { github: def.ghUser } : {},
      board: def.github ? boardOf('github', def.github) : boardOf('none', undefined),
    },
  };
}

/** The factory-app store (and its board and GitHub mirror) is refused by name, so the error says why. */
function factoryAppError(factory: Record<string, unknown>, board: Record<string, unknown>): string | null {
  if (factory.source === 'factory-app') return `factory.source: factory-app: ${NO_FACTORY_APP}`;
  if (board.source === 'factory-app') return `board.source: factory-app: ${NO_FACTORY_APP}`;
  if (given(board.mirror) && board.mirror !== 'none') return `board.mirror: ${String(board.mirror)}: ${NO_FACTORY_APP}`;
  return null;
}

function fromNew(raw: Record<string, unknown>, factory: Record<string, unknown>): Validated<FactoryYaml> {
  const boardAt = objectAt(raw, 'board', 'board');
  if (!boardAt.ok) return boardAt;
  const reposAt = objectAt(raw, 'repos', 'repos');
  if (!reposAt.ok) return reposAt;
  const gitAt = objectAt(factory, 'git', 'factory.git');
  if (!gitAt.ok) return gitAt;
  const [board, repos, git] = [boardAt.value ?? {}, reposAt.value ?? {}, gitAt.value ?? {}];
  const accounts = accountsOf(raw.accounts);
  if (!accounts.ok) return accounts;
  const app = factoryAppError(factory, board);
  if (app) return fail(app);
  const source = choiceAt(factory.source, 'factory.source', FACTORY_SOURCES, 'local');
  if (!source.ok) return source;
  const boardSource = choiceAt(board.source, 'board.source', BOARD_SOURCES, 'none');
  if (!boardSource.ok) return boardSource;
  const mirror = choiceAt(board.mirror, 'board.mirror', MIRRORS, 'none');
  if (!mirror.ok) return mirror;
  if (RESERVED_BOARDS.includes(boardSource.value)) return fail(`board.source: ${boardSource.value} is not supported yet`);

  const host = hostAt(repos.host, 'repos.host');
  if (!host.ok) return host;
  const list = repos.list ?? [];
  if (!Array.isArray(list)) return fail('repos.list: must be a list of repos');
  for (const [i, e] of list.entries()) {
    if (!isObject(e)) return fail(`repos.list[${i}]: must be an object`);
    const h = hostAt(e.host, `repos.list[${i}].host`);
    if (!h.ok) return h;
  }
  const gates = gatesOf(raw.gates);
  if (!gates.ok) return gates;

  // Every repo host is github in v1, so any repo uses the github account.
  const usedBy = [boardSource.value === 'github' && 'board', list.length > 0 && 'repos']
    .filter((x): x is string => typeof x === 'string');
  if (usedBy.length > 0 && accounts.value.github === undefined) return fail(`accounts.github is required (used by: ${usedBy.join(', ')})`);

  const github = boardSource.value === 'github' && {
    mode: 'github-only', project: board.project, label: board.label, approvers: board.approvers, statusMap: board.statusMap ?? DEFAULT_STATUS_MAP,
  };
  const d = validateFactoryDef({
    factoryId: factory.id, name: factory.name, gitName: git.name, gitEmail: git.email, docsPath: factory.docsPath,
    ghUser: accounts.value.github, active: factory.active, agentModels: factory.agents, protectedBranches: repos.protectedBranches,
    ...(github ? { github } : {}), version: 0,
  });
  if (!d.ok) return fail(textError(d.error, factory, git) ?? located(d.error, DEF_PATHS));
  const def = d.value;

  const out: FactoryRepo[] = [];
  for (const [i, e] of (list as Record<string, unknown>[]).entries()) {
    const prefix = `repos.list[${i}].`;
    const r = validateFactoryRepo({
      repoId: e.id, remote: e.remote, baseBranch: e.baseBranch, checks: e.checks, protectedBranches: e.protectedBranches, version: 0,
    }, def);
    if (!r.ok) return fail(r.error === 'main is never a base' ? `${prefix}baseBranch: ${r.error}` : located(r.error, repoPaths(prefix)));
    if (out.some((x) => x.repoId === r.value.repoId)) return fail(`${prefix}id: duplicate repo id ${r.value.repoId}`);
    out.push(r.value);
  }
  return {
    ok: true,
    value: {
      shape: 'new', source: source.value, def, repos: out, gates: gates.value, accounts: accounts.value,
      board: boardOf(boardSource.value, def.github),
    },
  };
}

/** Errors the internal validator reports for several fields at once, placed on the one field that caused them. */
function textError(error: string, factory: Record<string, unknown>, git: Record<string, unknown>): string | null {
  if (error === `factory id ${RESERVED_ID} is reserved`) return `factory.id: ${RESERVED_ID} is reserved`;
  if (!error.endsWith('must be text')) return null;
  const fields: [unknown, string][] = [[factory.name, 'factory.name'], [factory.docsPath, 'factory.docsPath'], [git.name, 'factory.git.name'], [git.email, 'factory.git.email']];
  const bad = fields.find(([v]) => given(v) && typeof v !== 'string');
  return bad ? `${bad[1]}: must be text` : null;
}

/**
 * Normalises a parsed factory.yaml. A top-level `factory` object means the new shape; anything else is read as the
 * legacy flat shape. New-shape errors read `<yaml.path>: <message>`; legacy errors read as they always have.
 */
export function normaliseFactoryYaml(raw: unknown): Validated<FactoryYaml> {
  if (isObject(raw) && isObject(raw.factory)) return fromNew(raw, raw.factory);
  return fromLegacy(raw);
}
