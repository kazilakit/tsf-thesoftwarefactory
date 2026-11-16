// Pure (no Node API): validates the factory's github block.
import type { FactoryDef, FactoryRepo } from './factories.js';
import { parseRemote } from './remote.js';
import { ALL_STATUSES } from './status.js';
import type { Status } from './types.js';
import { DEFAULT_GH_USER, GH_USER_PATTERN, NO_FACTORY_APP, type Validated } from './validated.js';

export type GitHubMode = 'github-only';
export interface ProjectRef { owner: string; number: number }
export interface GitHubSettings {
  mode: GitHubMode;
  project: ProjectRef;
  /** '' = no label filter. */
  label: string;
  /** GitHub logins, at least one. */
  approvers: string[];
  /** Project Status option name per status (trimmed). */
  statusMap: Record<Status, string>;
}

export const DEFAULT_LABEL = 'factory';

/** The status map of the design spec, section 5. */
export const DEFAULT_STATUS_MAP: Record<Status, string> = {
  inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress', plan_review: 'In progress',
  build: 'In progress', verify: 'In progress', review: 'In progress', pr_open: 'In review', done: 'Merged', blocked: 'In progress',
  cancelled: 'Backlog',
};

/** One Project column per status, named after it: the map for a Project the wizard creates (design section 14, call 4). */
export const STANDARD_STATUS_MAP: Record<Status, string> = {
  inbox: 'Inbox', ready: 'Ready', spec: 'Spec', spec_review: 'Spec review', plan: 'Plan', plan_review: 'Plan review',
  build: 'Build', verify: 'Verify', review: 'Review', pr_open: 'PR open', done: 'Done', blocked: 'Blocked', cancelled: 'Cancelled',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** "owner/number": owner a GitHub login, number a positive integer. */
export function parseProjectRef(v: string): ProjectRef | null {
  const m = /^([^/]+)\/(\d+)$/.exec(v.trim());
  if (!m || !GH_USER_PATTERN.test(m[1]!)) return null;
  const number = Number(m[2]);
  return Number.isSafeInteger(number) && number > 0 ? { owner: m[1]!, number } : null;
}

/** `owner/number` text, or the parsed `{ owner, number }` a stored definition already holds; both pass the same checks. */
function projectOf(v: unknown): ProjectRef | null {
  if (typeof v === 'string') return parseProjectRef(v);
  if (!isObject(v) || typeof v.owner !== 'string' || typeof v.number !== 'number') return null;
  return Number.isSafeInteger(v.number) ? parseProjectRef(`${v.owner}/${v.number}`) : null;
}

function statusMapOf(v: unknown): Validated<Record<Status, string>> {
  if (!isObject(v)) return fail('github.statusMap must map statuses to Project Status options');
  for (const k of Object.keys(v)) {
    if (!(ALL_STATUSES as readonly string[]).includes(k)) return fail(`github.statusMap has an unknown status: ${k}`);
  }
  const out = {} as Record<Status, string>;
  for (const s of ALL_STATUSES) {
    const o = v[s];
    if (o === undefined || o === null) return fail(`github.statusMap.${s} is required`);
    if (typeof o !== 'string' || o.trim() === '') return fail(`github.statusMap.${s} must not be blank`);
    out[s] = o.trim();
  }
  if (out.inbox === out.ready) return fail('github.statusMap: inbox and ready must map to different options');
  for (const s of ALL_STATUSES) {
    if (s === 'inbox' || s === 'ready' || s === 'done' || s === 'cancelled') continue;
    if (out[s] === out.inbox) return fail(`github.statusMap.${s} must not share the inbox option (only done and cancelled may)`);
    if (out[s] === out.ready) return fail(`github.statusMap.${s} must not share the ready option (only done and cancelled may)`);
  }
  return { ok: true, value: out };
}

export function validateGitHubSettings(input: unknown, ghUser: string): Validated<GitHubSettings | undefined> {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!isObject(input)) return fail('github must be an object');
  if (input.mode === undefined || input.mode === null) return fail('github.mode is required');
  if (input.mode === 'connected') return fail(`github.mode connected needs the factory-app store: ${NO_FACTORY_APP}`);
  if (input.mode !== 'github-only') return fail('github.mode must be github-only');
  const project = projectOf(input.project);
  if (!project) return fail('github.project must be owner/number');
  let label = DEFAULT_LABEL;
  if (input.label !== undefined && input.label !== null) {
    if (typeof input.label !== 'string') return fail('github.label must be text');
    if (input.label !== '' && input.label.trim() === '') return fail('github.label must be "" or a label name, not blank space');
    label = input.label.trim();
  }
  let approvers = [ghUser];
  if (input.approvers !== undefined && input.approvers !== null) {
    const a = input.approvers;
    if (!Array.isArray(a) || a.length === 0 || !a.every((x) => typeof x === 'string' && (x.trim() === DEFAULT_GH_USER || GH_USER_PATTERN.test(x.trim())))) {
      return fail('github.approvers must list at least one GitHub login');
    }
    approvers = (a as string[]).map((x) => x.trim());
  }
  const statusMap = statusMapOf(input.statusMap);
  if (!statusMap.ok) return statusMap;
  return { ok: true, value: { mode: input.mode, project, label, approvers, statusMap: statusMap.value } };
}

export interface GitHubConfigProblem {
  factoryId: string; repoId?: string; message: string;
  /** Set on the "already used by" problem: the factory repo that owns the GitHub repo first. */
  clashWith?: { factoryId: string; repoId: string };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const parsedRemote = (remote: string): { owner: string; repo: string } | null => {
  try { return parseRemote(remote); } catch { return null; }
};

/** Cross-factory checks: each GitHub repo belongs to one factory repo. Factories without `github` are ignored. */
export function githubConfigProblems(defs: FactoryDef[], repos: FactoryRepo[]): GitHubConfigProblem[] {
  const problems: GitHubConfigProblem[] = [];
  const owners = new Map<string, { id: string; factoryId: string; repoId: string; slug: string }>();
  const sortedRepos = [...repos].sort((a, b) => byId(a.factoryId, b.factoryId) || byId(a.repoId, b.repoId));
  for (const def of [...defs].sort((a, b) => byId(a.factoryId, b.factoryId))) {
    const github = def.github;
    if (!github) continue;
    for (const repo of sortedRepos.filter((r) => r.factoryId === def.factoryId)) {
      const remote = parsedRemote(repo.remote);
      if (!remote) { problems.push({ factoryId: def.factoryId, repoId: repo.repoId, message: 'remote is not a GitHub repo; GitHub mode needs one' }); continue; }
      const key = `${remote.owner}/${remote.repo}`.toLowerCase();
      const first = owners.get(key);
      if (first) problems.push({ factoryId: def.factoryId, repoId: repo.repoId, message: `${first.slug} is already used by ${first.id}; a GitHub repo can belong to only one factory repo`, clashWith: { factoryId: first.factoryId, repoId: first.repoId } });
      else owners.set(key, { id: `${def.factoryId}/${repo.repoId}`, factoryId: def.factoryId, repoId: repo.repoId, slug: `${remote.owner}/${remote.repo}` });
    }
  }
  return problems;
}
