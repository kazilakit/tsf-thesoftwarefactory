// Pure (no Node API): validates factory definitions.
import { isMainRef } from './branches.js';
import { normaliseChecks, type Checks } from './checksSchema.js';
import { validateGitHubSettings, type GitHubSettings } from './githubConfig.js';
import type { AgentStep } from './types.js';
import { DEFAULT_GH_USER, GH_USER_PATTERN, type Validated } from './validated.js';

export { DEFAULT_GH_USER, GH_USER_PATTERN, type Validated };

/** The stages whose agent a factory can set a model for. */
export const AGENT_STEPS: readonly AgentStep[] = ['spec', 'plan', 'build', 'verify', 'review'];
/** The models a factory can choose for a stage agent. */
export const AGENT_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];
export type AgentModels = Partial<Record<AgentStep, AgentModel>>;

export interface FactoryDef {
  factoryId: string;
  name: string;
  protectedBranches: string[];
  gitName: string;
  gitEmail: string;
  docsPath: string;
  /** GitHub login of the gh CLI account whose token the factory opens PRs with. The Board stores the login, never a token. */
  ghUser: string;
  active: boolean;
  /** Model per stage agent; a stage left out runs on the session's model. */
  agentModels?: AgentModels;
  /** GitHub Issues and Projects integration; absent = the factory does not use GitHub. */
  github?: GitHubSettings;
  version: number;
}

export interface FactoryRepo {
  factoryId: string;
  repoId: string;
  remote: string;
  baseBranch: string;
  checks: Checks;
  /** Set only when the repo overrides the factory's list (`main` always included). */
  protectedBranches?: string[];
  version: number;
}

export interface FactoryHealth {
  factoryId: string;
  /** Whether the factory's gh login was found (`gh auth status`) when last checked. */
  ghLoggedIn: boolean;
  checkedAt: string;
}

export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const ID_MAX = 40;
/** The settings scope of the whole Board; no factory may take it. */
export const RESERVED_ID = 'global';
export const isValidId = (v: unknown): v is string => typeof v === 'string' && v.length <= ID_MAX && ID_PATTERN.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Adds `main`, trims, drops blanks and duplicates. Order is kept. */
export function ensureMain(branches: string[]): string[] {
  const out: string[] = [];
  for (const b of [...branches, 'main']) {
    const name = b.trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The protected branches for a repo: its own override, else the factory's list. */
export function protectedFor(def: FactoryDef, repo: Pick<FactoryRepo, 'protectedBranches'> | undefined): string[] {
  return repo?.protectedBranches ?? def.protectedBranches;
}

const isBranchList = (v: unknown): v is string[] => Array.isArray(v) && v.every((b) => typeof b === 'string');

function text(input: Record<string, unknown>, key: string, fallback: string): string | null {
  const v = input[key];
  if (v === undefined || v === null) return fallback;
  return typeof v === 'string' ? v.trim() : null;
}

function agentModelsOf(v: unknown): Validated<AgentModels | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (!isObject(v)) return fail('agentModels must map stages to models');
  const out: AgentModels = {};
  for (const [k, m] of Object.entries(v)) {
    if (!(AGENT_STEPS as readonly string[]).includes(k)) return fail(`agentModels has an unknown stage: ${k}`);
    if (!(AGENT_MODELS as readonly unknown[]).includes(m)) return fail(`agentModels.${k} must be one of ${AGENT_MODELS.join(', ')}`);
    out[k as AgentStep] = m as AgentModel;
  }
  return { ok: true, value: Object.keys(out).length === 0 ? undefined : out };
}

export function validateFactoryDef(input: unknown): Validated<FactoryDef> {
  if (!isObject(input)) return fail('factory must be an object');
  const { factoryId } = input;
  if (!isValidId(factoryId)) return fail(`factoryId must match ${ID_PATTERN.source} and be at most ${ID_MAX} characters`);
  if (factoryId === RESERVED_ID) return fail(`factory id ${RESERVED_ID} is reserved`);
  const name = text(input, 'name', factoryId);
  if (name === null) return fail('name must be text');
  if (name === '') return fail('name must not be blank');
  const gitName = text(input, 'gitName', '');
  const gitEmail = text(input, 'gitEmail', '');
  const docsPath = text(input, 'docsPath', '');
  const rawGhUser = text(input, 'ghUser', '');
  if (gitName === null || gitEmail === null || docsPath === null || rawGhUser === null) {
    return fail('gitName, gitEmail, docsPath and ghUser must be text');
  }
  const ghUser = rawGhUser === '' ? DEFAULT_GH_USER : rawGhUser;
  if (ghUser !== DEFAULT_GH_USER && !GH_USER_PATTERN.test(ghUser)) return fail('ghUser must be a GitHub login');
  if (gitEmail !== '' && !gitEmail.includes('@')) return fail('gitEmail must contain @');
  if (docsPath !== '' && !docsPath.startsWith('/')) return fail('docsPath must be an absolute folder or empty');
  const rawBranches = input.protectedBranches ?? ['dev', 'stg', 'main'];
  if (!isBranchList(rawBranches)) return fail('protectedBranches must be a list of branch names');
  const active = input.active ?? true;
  if (typeof active !== 'boolean') return fail('active must be true or false');
  const version = input.version ?? 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return fail('version must be a whole number');
  const models = agentModelsOf(input.agentModels);
  if (!models.ok) return models;
  const github = validateGitHubSettings(input.github, ghUser);
  if (!github.ok) return github;
  return {
    ok: true,
    value: {
      factoryId, name, protectedBranches: ensureMain(rawBranches), gitName, gitEmail, docsPath,
      ghUser, active, ...(models.value ? { agentModels: models.value } : {}), ...(github.value ? { github: github.value } : {}), version,
    },
  };
}

export function validateFactoryRepo(input: unknown, def: FactoryDef): Validated<FactoryRepo> {
  if (!isObject(input)) return fail('repo must be an object');
  const { repoId } = input;
  if (!isValidId(repoId)) return fail(`repoId must match ${ID_PATTERN.source} and be at most ${ID_MAX} characters`);
  const remote = text(input, 'remote', '');
  if (remote === null || remote === '') return fail('remote must not be blank');
  // git would read it as an option (`git clone -- <remote>` guards the clone too).
  if (remote.startsWith('-')) return fail('remote must not start with -');
  const baseBranch = text(input, 'baseBranch', 'dev');
  if (baseBranch === null || baseBranch === '') return fail('baseBranch must not be blank');
  if (isMainRef(baseBranch)) return fail('main is never a base');
  const parsed = normaliseChecks(input.checks);
  if (!parsed.ok) return parsed;
  const branches = input.protectedBranches;
  if (branches !== undefined && branches !== null && !isBranchList(branches)) return fail('protectedBranches must be a list of branch names');
  const version = input.version ?? 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return fail('version must be a whole number');
  return {
    ok: true,
    value: {
      factoryId: def.factoryId, repoId, remote, baseBranch, checks: parsed.value,
      ...(isBranchList(branches) ? { protectedBranches: ensureMain(branches) } : {}), version,
    },
  };
}

/** Definitions held in memory. A definition that fails validation is left out and listed in `skipped()`. */
export class FactoryConfig {
  private readonly defs = new Map<string, FactoryDef>();
  private readonly byFactory = new Map<string, FactoryRepo[]>();
  private readonly skips: { id: string; reason: string }[] = [];
  private readonly rows: number;

  constructor(defs: FactoryDef[], repos: FactoryRepo[]) {
    this.rows = defs.length;
    for (const d of defs) {
      const r = validateFactoryDef(d);
      if (!r.ok) this.skips.push({ id: String((d as { factoryId?: unknown } | null)?.factoryId ?? '?'), reason: r.error });
      else if (this.defs.has(r.value.factoryId)) this.skips.push({ id: r.value.factoryId, reason: 'duplicate factory id' });
      else this.defs.set(r.value.factoryId, { ...r.value, version: d.version });
    }
    for (const repo of repos) {
      const def = this.defs.get(repo.factoryId);
      const id = `${repo.factoryId}/${repo.repoId}`;
      if (!def) {
        this.skips.push({ id, reason: `factory ${repo.factoryId} is not available` });
        continue;
      }
      const r = validateFactoryRepo(repo, def);
      if (!r.ok) {
        this.skips.push({ id, reason: r.error });
        continue;
      }
      const list = this.byFactory.get(def.factoryId) ?? [];
      if (list.some((x) => x.repoId === repo.repoId)) {
        this.skips.push({ id, reason: 'duplicate repo id' });
        continue;
      }
      list.push(r.value);
      this.byFactory.set(def.factoryId, list);
    }
  }

  factories(): FactoryDef[] {
    return [...this.defs.values()];
  }
  /** True when any definition row was given, valid or skipped (false before the Board's Import of the first factory). */
  hasDefinitions(): boolean {
    return this.rows > 0;
  }
  factory(id: string): FactoryDef | undefined {
    return this.defs.get(id);
  }
  repo(factoryId: string, repoId: string): FactoryRepo | undefined {
    return this.byFactory.get(factoryId)?.find((r) => r.repoId === repoId);
  }
  repos(factoryId: string): FactoryRepo[] {
    return [...(this.byFactory.get(factoryId) ?? [])];
  }
  skipped(): { id: string; reason: string }[] {
    return [...this.skips];
  }
}
