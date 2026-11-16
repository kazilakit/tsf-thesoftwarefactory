import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS } from './defaults.js';
import type { FactoryDef, FactoryHealth, FactoryRepo } from './factories.js';
import { loadFactoriesFromDir, type FactoryDirLoad, type FactoryFileProblem } from './factoriesFs.js';
import { applyChange, loadFactoryFile, saveFactoryFile, type ConfigChange, type FactoryFile } from './factoryFile.js';
import type { FactoryYaml } from './factoryYaml.js';
import { DEFAULT_STATUS_MAP, type GitHubSettings } from './githubConfig.js';
import { withLinkDefaults, type GitHubLink } from './githubLink.js';
import type {
  Approval, Doc, DocKind, FactoryEvent, Gate, Mode, RepoSettings, Run, Settings, Step, Task,
} from './types.js';

export {
  canonicalJson, ForbiddenError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError, sameApproval, updateHeld,
  VersionConflictError,
} from './boardStore.js';
export type { BoardStore, NewApproval, StoredSettings, StoreIdentity } from './boardStore.js';
import {
  ForbiddenError, NotFoundError, OwnerOnlyError, sameApproval, updateHeld,
  VersionConflictError, assertNewStatus, canonicalJson, parseScope, settingsConflict, type BoardStore, type NewApproval, type NewTask, type StoredSettings,
  type StoreIdentity,
} from './boardStore.js';

interface State {
  tasks: Task[];
  docs: Doc[];
  /** `approvalId` only when the caller gave one; never returned. */
  approvals: (Approval & { approvalId?: string })[];
  settings: StoredSettings | null;
  runs: Run[];
  events: FactoryEvent[];
  factoryDefs: FactoryDef[];
  factoryRepos: FactoryRepo[];
  health: FactoryHealth[];
  githubLinks: GitHubLink[];
}

const emptyState = (): State => ({
  tasks: [], docs: [], approvals: [], settings: null, runs: [], events: [], factoryDefs: [], factoryRepos: [], health: [], githubLinks: [],
});
const clone = <T>(v: T): T => structuredClone(v);
const num = (id: string) => Number(id.slice(id.indexOf('-') + 1)) || 0;
const publicApproval = ({ approvalId: _id, ...a }: Approval & { approvalId?: string }): Approval => clone(a);
const byStart = (a: Run, b: Run) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);
/** The row a compare-and-set save stores: version 1 for an insert, else the stored version + 1. */
function versionedSave<T extends { version: number }>(what: string, current: T | undefined, before: T | null, after: T): T {
  if (before === null) {
    if (current) throw new VersionConflictError(what, 0, current.version, `${what} already exists; reload and save again`);
    return { ...clone(after), version: 1 };
  }
  if (!current || current.version !== before.version) {
    throw new VersionConflictError(what, before.version, current?.version ?? 0, `${what} changed since it was read; reload and save again`);
  }
  return { ...clone(after), version: current.version + 1 };
}
const nextId = (prefix: string, ids: string[]) => `${prefix}-${1 + Math.max(0, ...ids.map(num))}`;

export interface MemoryStoreOptions {
  /** Who calls: the owner-only and core-only methods refuse the other. Left out, nothing is checked (tests, dev). */
  identity?: StoreIdentity;
  /** Definitions the store starts with (tests, dev). A FileStore reads them from `<dir>/factories` instead. */
  factories?: { defs: FactoryDef[]; repos: FactoryRepo[] };
}

export class MemoryStore implements BoardStore {
  protected state: State = emptyState();
  protected readonly identity: StoreIdentity | undefined;

  constructor(opts: MemoryStoreOptions = {}) {
    this.identity = opts.identity;
    if (opts.factories) this.state = { ...emptyState(), factoryDefs: clone(opts.factories.defs), factoryRepos: clone(opts.factories.repos) };
  }

  private ownerOnly(method: string): void {
    if (this.identity === 'core') throw new OwnerOnlyError(`${method} is done on the Board, not by the factory core`);
  }

  private coreOnly(method: string): void {
    if (this.identity === 'owner') throw new ForbiddenError(`${method} is done by the factory core, not on the Board`);
  }

  /** Runs a read against the current state. */
  protected async read<T>(fn: () => T): Promise<T> {
    return fn();
  }

  /** Runs a mutation against the current state; FileStore makes it a locked reload-modify-persist. */
  protected async write<T>(fn: () => T): Promise<T> {
    return fn();
  }

  private find(id: string): Task {
    const t = this.state.tasks.find((x) => x.taskId === id);
    if (!t) throw new NotFoundError(`task ${id}`);
    return t;
  }

  listTasks() {
    return this.read(() => clone(this.state.tasks));
  }

  getTask(id: string) {
    return this.read(() => clone(this.find(id)));
  }

  async createTask(t: NewTask) {
    assertNewStatus(t.status);
    return this.write(() => {
      const task: Task = {
        taskId: nextId('T', this.state.tasks.map((x) => x.taskId)),
        factoryId: t.factoryId,
        title: t.title,
        description: t.description,
        repo: t.repo,
        baseBranch: t.baseBranch ?? 'dev',
        status: t.status ?? 'inbox',
        stage: null,
        branch: null,
        prUrl: null,
        attempt: 0,
        blockedReason: null,
        question: null,
        answer: null,
        gateOverrides: {},
        dependsOn: [...(t.dependsOn ?? [])],
        claimBy: null,
        claimUntil: null,
        costUsd: 0,
        version: 1,
      };
      this.state.tasks.push(task);
      return clone(task);
    });
  }

  async restoreTask(t: Task) {
    this.coreOnly('restoreTask');
    return this.write(() => {
      const existing = this.state.tasks.find((x) => x.taskId === t.taskId);
      if (existing) throw new VersionConflictError(t.taskId, 0, existing.version);
      const task: Task = { ...clone(t), version: 1 };
      this.state.tasks.push(task);
      return clone(task);
    });
  }

  async updateTask(id: string, expectedVersion: number, patch: Partial<Task>) {
    if ('taskId' in patch || 'version' in patch) throw new Error('patch must not change taskId or version');
    return this.write(() => {
      const t = this.find(id);
      if (t.version !== expectedVersion) throw new VersionConflictError(id, expectedVersion, t.version);
      Object.assign(t, clone(patch));
      t.version += 1;
      return clone(t);
    });
  }

  addDoc(taskId: string, kind: DocKind, body: string, author: string) {
    return this.write(() => {
      const prior = this.state.docs.filter((d) => d.taskId === taskId && d.kind === kind);
      for (const d of prior) d.status = 'superseded';
      const doc: Doc = {
        taskId, kind, version: Math.max(0, ...prior.map((d) => d.version)) + 1, body, author, status: 'current',
      };
      this.state.docs.push(doc);
      return clone(doc);
    });
  }

  currentDoc(taskId: string, kind: DocKind) {
    return this.read(() => {
      const d = this.state.docs.find((x) => x.taskId === taskId && x.kind === kind && x.status === 'current');
      return d ? clone(d) : undefined;
    });
  }

  listDocs(taskId: string, kind: DocKind) {
    return this.read(() => {
      const docs = this.state.docs.filter((d) => d.taskId === taskId && d.kind === kind).sort((a, b) => a.version - b.version);
      return docs.map((d, i): Doc => ({ ...clone(d), status: i === docs.length - 1 ? 'current' : 'superseded' }));
    });
  }

  addApproval({ approvalId, ...a }: NewApproval) {
    return this.write(() => {
      const stored = approvalId === undefined ? undefined : this.state.approvals.find((x) => x.approvalId === approvalId);
      if (stored) {
        if (!sameApproval(stored, a)) throw new Error('addApproval: approval id already taken');
        return publicApproval(stored);
      }
      const approval: Approval = { ...a, at: new Date().toISOString() };
      this.state.approvals.push(approvalId === undefined ? approval : { ...approval, approvalId });
      return clone(approval);
    });
  }

  listApprovals(taskId: string) {
    return this.read(() => this.state.approvals.filter((a) => a.taskId === taskId).map(publicApproval));
  }

  listFactoryDefs() {
    return this.read(() => clone(this.state.factoryDefs));
  }

  listFactoryRepos(factoryId?: string) {
    return this.read(() => clone(this.state.factoryRepos.filter((r) => factoryId === undefined || r.factoryId === factoryId)));
  }

  async saveFactoryDef(before: FactoryDef | null, after: FactoryDef) {
    this.ownerOnly('saveFactoryDef');
    return this.write(() => this.putFactoryDef(before, after));
  }

  /** The compare-and-set save of a definition, run inside write(). */
  protected putFactoryDef(before: FactoryDef | null, after: FactoryDef): FactoryDef {
    const defs = this.state.factoryDefs;
    const i = defs.findIndex((d) => d.factoryId === after.factoryId);
    const stored = versionedSave(`factory ${after.factoryId}`, defs[i], before, after);
    if (i < 0) defs.push(stored);
    else defs[i] = stored;
    return clone(stored);
  }

  async saveFactoryRepo(before: FactoryRepo | null, after: FactoryRepo) {
    this.ownerOnly('saveFactoryRepo');
    return this.write(() => this.putFactoryRepo(before, after));
  }

  /** The compare-and-set save of a repo, run inside write(). */
  protected putFactoryRepo(before: FactoryRepo | null, after: FactoryRepo): FactoryRepo {
    const repos = this.state.factoryRepos;
    const i = repos.findIndex((r) => r.factoryId === after.factoryId && r.repoId === after.repoId);
    const stored = versionedSave(`repo ${after.factoryId}/${after.repoId}`, repos[i], before, after);
    if (i < 0) repos.push(stored);
    else repos[i] = stored;
    return clone(stored);
  }

  listGitHubLinks(factoryId?: string) {
    return this.read(() => clone(this.state.githubLinks.filter((l) => factoryId === undefined || l.factoryId === factoryId).map(withLinkDefaults)));
  }

  getGitHubLink(taskId: string) {
    return this.read(() => {
      const l = this.state.githubLinks.find((x) => x.taskId === taskId);
      return l ? clone(withLinkDefaults(l)) : undefined;
    });
  }

  async saveGitHubLink(before: GitHubLink | null, after: GitHubLink) {
    this.coreOnly('saveGitHubLink');
    return this.write(() => {
      const links = this.state.githubLinks;
      const i = links.findIndex((l) => l.taskId === after.taskId);
      const stored = versionedSave(`GitHub link ${after.taskId}`, links[i], before, after);
      if (i < 0) links.push(stored);
      else links[i] = stored;
      return clone(stored);
    });
  }

  listFactoryHealth() {
    return this.read(() => clone(this.state.health));
  }

  async setFactoryHealth(h: FactoryHealth) {
    this.coreOnly('setFactoryHealth');
    return this.write(() => {
      const i = this.state.health.findIndex((x) => x.factoryId === h.factoryId);
      if (i < 0) this.state.health.push(clone(h));
      else this.state.health[i] = clone(h);
    });
  }

  getSettings(): Promise<StoredSettings> {
    return this.read(() => this.settingsView(clone(this.state.settings ?? { factories: {} })));
  }

  /** The settings as callers see them; FileStore lays the YAML gates over them. The argument is a copy it may change. */
  protected settingsView(s: StoredSettings): StoredSettings {
    return s;
  }

  setSettings(s: StoredSettings) {
    return this.write(() => {
      this.state.settings = clone(s);
    });
  }

  async updateSettingsScope(scope: string, before: unknown, after: Settings | RepoSettings | null) {
    this.ownerOnly('updateSettingsScope');
    const { factoryId, repoId } = parseScope(scope);
    if (repoId === undefined && after === null) throw new Error('factory settings cannot be removed');
    return this.write(() => {
      const s: StoredSettings = this.state.settings ?? { factories: {} };
      const entry = this.settingsView(clone(s)).factories[factoryId];
      const current = repoId === undefined ? (entry?.factory ?? DEFAULT_SETTINGS) : entry?.repos[repoId];
      if (canonicalJson(current) !== canonicalJson(before)) throw settingsConflict(scope);
      const target = (s.factories[factoryId] ??= { factory: clone(DEFAULT_SETTINGS), repos: {} });
      if (repoId === undefined) target.factory = this.storedFactorySettings(factoryId, current as Settings, clone(after as Settings));
      else if (after === null) delete target.repos[repoId];
      else target.repos[repoId] = clone(after as RepoSettings);
      this.state.settings = s;
    });
  }

  /** What the store keeps of a factory scope save (`current` is the merged view it replaces); FileStore moves YAML gates out. */
  protected storedFactorySettings(_factoryId: string, _current: Settings, after: Settings): Settings {
    return after;
  }

  startRun(r: { taskId: string; step: Step; mode: Mode; agent: string }) {
    return this.write(() => {
      const run: Run = {
        runId: nextId('R', this.state.runs.map((x) => x.runId)),
        ...r,
        startedAt: new Date().toISOString(),
        endedAt: null,
        result: null,
        turns: null,
        costUsd: null,
      };
      this.state.runs.push(run);
      return clone(run);
    });
  }

  openRun(taskId: string, step: Step) {
    return this.read(() => {
      const open = this.state.runs.filter((r) => r.taskId === taskId && r.step === step && r.endedAt === null);
      const last = open[open.length - 1];
      return last ? clone(last) : undefined;
    });
  }

  finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }) {
    return this.write(() => {
      const run = this.state.runs.find((r) => r.runId === runId);
      if (!run) throw new NotFoundError(`run ${runId}`);
      Object.assign(run, p, { endedAt: new Date().toISOString() });
    });
  }

  listRuns(taskId: string) {
    return this.read(() => clone(this.state.runs.filter((r) => r.taskId === taskId).sort(byStart)));
  }

  addEvents(e: FactoryEvent[]) {
    return this.write(() => {
      this.state.events.push(...clone(e));
    });
  }

  listEvents(taskId?: string) {
    return this.read(() =>
      clone(taskId === undefined ? this.state.events : this.state.events.filter((e) => e.taskId === taskId)),
    );
  }
}

/** A board.json written before factories existed holds one factory's work; it loads as this factory's. */
const LEGACY_FACTORY = 'blocks';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A seeded key that matches no directory: the next load reads the factory files again. */
const STALE_YAML = '\0stale';
const differs = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) !== canonicalJson(b ?? null);
const oldYaml = (factoryId: string): string => `factories/${factoryId}/factory.yaml is in the old format; run ./factory init to convert it`;

/** The named changes that turn the file's definition into `after`; only the fields that differ are written. */
function defChanges(config: FactoryYaml, after: FactoryDef): ConfigChange[] {
  const cur = config.def;
  const out: ConfigChange[] = [];
  const factory: Extract<ConfigChange, { kind: 'setFactory' }> = { kind: 'setFactory' };
  if (after.name !== cur.name) factory.name = after.name;
  if (after.docsPath !== cur.docsPath) factory.docsPath = after.docsPath;
  if (after.active !== cur.active) factory.active = after.active;
  if (after.gitName !== cur.gitName || after.gitEmail !== cur.gitEmail) factory.git = { name: after.gitName, email: after.gitEmail };
  if (Object.keys(factory).length > 1) out.push(factory);
  if (differs(after.agentModels ?? {}, cur.agentModels ?? {})) out.push({ kind: 'setModels', models: after.agentModels ?? {} });
  if (after.ghUser !== cur.ghUser) out.push({ kind: 'setAccounts', accounts: { ...config.accounts, github: after.ghUser } });
  if (differs(after.protectedBranches, cur.protectedBranches)) out.push({ kind: 'setProtectedBranches', branches: after.protectedBranches });
  if (differs(after.github, cur.github)) out.push(...boardChanges(after.github));
  return out;
}

/** A local factory's board: none, or a GitHub Project (github-only). */
function boardChanges(gh: GitHubSettings | undefined): ConfigChange[] {
  if (!gh) return [{ kind: 'setBoard', board: { source: 'none' } }];
  return [
    { kind: 'setBoard', board: { source: 'github', project: `${gh.project.owner}/${gh.project.number}`, label: gh.label } },
    { kind: 'setApprovers', approvers: gh.approvers },
    { kind: 'setStatusMap', statusMap: differs(gh.statusMap, DEFAULT_STATUS_MAP) ? gh.statusMap : null },
  ];
}

/** The fields of `after` that differ from the stored repo. A protectedBranches the caller left out is kept as it is. */
function repoPatch(cur: FactoryRepo, after: FactoryRepo): Extract<ConfigChange, { kind: 'updateRepo' }>['patch'] {
  return {
    ...(after.remote !== cur.remote ? { remote: after.remote } : {}),
    ...(after.baseBranch !== cur.baseBranch ? { baseBranch: after.baseBranch } : {}),
    ...(differs(after.checks, cur.checks) ? { checks: after.checks } : {}),
    ...(after.protectedBranches !== undefined && differs(after.protectedBranches, cur.protectedBranches) ? { protectedBranches: after.protectedBranches } : {}),
  };
}

export interface FileStoreOptions extends Omit<MemoryStoreOptions, 'factories'> {
  /** How long a write waits for the lock before it gives up (default 5 s). */
  lockTimeoutMs?: number;
  /** The factory YAMLs (`<root>/factories`): their definitions, repos and gates win over board.json on every load. Left out: none. */
  factoriesDir?: string;
  /** Told why a definition file was skipped. */
  log?: (line: string) => void;
}

/** A lock file older than this belongs to a crashed writer and may be removed. */
const STALE_LOCK_MS = 30_000;

/**
 * A JSON file shared by several factory processes. Every call reloads the file; every write holds
 * `<path>.lock` while it reloads, changes and persists, so no process overwrites another's write.
 */
export class FileStore extends MemoryStore {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly factoriesDir: string | undefined;
  private readonly log: ((line: string) => void) | undefined;
  /** Read again only when a factory file changed (see yamlKey): a bad file is reported once per change. */
  private seeded: ({ key: string } & FactoryDirLoad) | undefined;

  constructor(private readonly path: string, opts: FileStoreOptions = {}) {
    super(opts);
    this.factoriesDir = opts.factoriesDir;
    this.log = opts.log;
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5_000;
    this.reload();
  }

  protected override async read<T>(fn: () => T): Promise<T> {
    this.reload();
    return fn();
  }

  protected override async write<T>(fn: () => T): Promise<T> {
    const fd = await this.lock();
    try {
      this.reload();
      const result = fn();
      this.persist();
      return result;
    } finally {
      closeSync(fd);
      rmSync(this.lockPath, { force: true });
    }
  }

  private reload(): void {
    const raw = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>) : {};
    this.state = this.upgrade(raw);
  }

  /** The factory files that were skipped on the last load, with the file and the reason. */
  factoryFileProblems(): FactoryFileProblem[] {
    this.reload();
    return clone(this.seeded?.problems ?? []);
  }

  /** The owned factory's file, loaded inside the write lock; undefined when board.json holds the factory. An old-format file is refused. */
  private ownedFile(factoryId: string): FactoryFile | undefined {
    if (this.factoriesDir === undefined || !this.seeded?.owned.includes(factoryId)) return undefined;
    const file = loadFactoryFile(join(this.factoriesDir, factoryId));
    if (!file.ok) throw new Error(file.error);
    if (file.value.shape === 'legacy') throw new Error(oldYaml(factoryId));
    return file.value;
  }

  /** Applies the changes and saves the file (nothing is written when there are none); the next load reads the files again. */
  private saveYaml(file: FactoryFile, changes: ConfigChange[]): FactoryFile {
    if (changes.length === 0) return file;
    let next = file;
    for (const change of changes) {
      const r = applyChange(next, change);
      if (!r.ok) throw new Error(r.error);
      next = r.value;
    }
    const saved = saveFactoryFile(next);
    if (this.seeded) this.seeded.key = STALE_YAML;
    return saved;
  }

  /** An owned definition is saved into its factory.yaml; its version is the file's content hash. */
  protected override putFactoryDef(before: FactoryDef | null, after: FactoryDef): FactoryDef {
    const file = this.ownedFile(after.factoryId);
    if (!file) return super.putFactoryDef(before, after);
    const what = `factory ${after.factoryId}`;
    if (before === null) throw new VersionConflictError(what, 0, file.version, `${what} already exists; reload and save again`);
    if (before.version !== file.version) throw new VersionConflictError(what, before.version, file.version, `${what} changed since it was read; reload and save again`);
    return clone(this.saveYaml(file, defChanges(file.config, after)).config.def);
  }

  /** An owned factory's repo is added to, or updated in, its factory.yaml. */
  protected override putFactoryRepo(before: FactoryRepo | null, after: FactoryRepo): FactoryRepo {
    const file = this.ownedFile(after.factoryId);
    if (!file) return super.putFactoryRepo(before, after);
    const what = `repo ${after.factoryId}/${after.repoId}`;
    const cur = file.config.repos.find((r) => r.repoId === after.repoId);
    const changes: ConfigChange[] = [];
    if (before === null) {
      if (cur) throw new VersionConflictError(what, 0, cur.version, `${what} already exists; reload and save again`);
      const { repoId: id, remote, baseBranch, checks, protectedBranches } = after;
      changes.push({ kind: 'addRepo', repo: { id, remote, baseBranch, checks, ...(protectedBranches ? { protectedBranches } : {}) } });
    } else {
      if (!cur || cur.version !== before.version) {
        throw new VersionConflictError(what, before.version, cur?.version ?? 0, `${what} changed since it was read; reload and save again`);
      }
      const patch = repoPatch(cur, after);
      if (Object.keys(patch).length > 0) changes.push({ kind: 'updateRepo', repoId: after.repoId, patch });
    }
    return clone(this.saveYaml(file, changes).config.repos.find((r) => r.repoId === after.repoId)!);
  }

  /**
   * An owned factory's gates go to its factory.yaml when they changed. board.json keeps the rest, with the defaults in
   * place of the gates the YAML holds, so a gate later removed from the YAML falls back to its default, not a stale copy.
   */
  protected override storedFactorySettings(factoryId: string, current: Settings, after: Settings): Settings {
    if (!this.seeded?.owned.includes(factoryId)) return after;
    let yamlGates = Object.keys(this.seeded.gates[factoryId] ?? {}) as Gate[];
    if (differs(after.gates, current.gates)) {
      this.saveYaml(this.ownedFile(factoryId)!, [{ kind: 'setGates', gates: after.gates }]);
      yamlGates = Object.keys(after.gates) as Gate[];
    }
    const gates = { ...after.gates };
    for (const g of yamlGates) gates[g] = DEFAULT_SETTINGS.gates[g];
    return { ...after, gates };
  }

  /** Owned factories' YAML gates win over the stored ones per gate; a missing factory scope starts from the defaults. */
  protected override settingsView(s: StoredSettings): StoredSettings {
    for (const [factoryId, gates] of Object.entries(this.seeded?.gates ?? {})) {
      const entry = (s.factories[factoryId] ??= { factory: clone(DEFAULT_SETTINGS), repos: {} });
      entry.factory = { ...entry.factory, gates: { ...entry.factory.gates, ...gates } };
    }
    return s;
  }

  /**
   * A file written before factories: its tasks and events belong to factory `blocks`, and its `{ global, repos }`
   * settings are that factory's. With `factoriesDir`, the YAML definitions and repos (see loadFactoriesFromDir, re-read
   * when a file changed) replace board.json's for every factory the YAML owns, valid or not; the other board.json
   * definitions keep loading, without a `github` block (only a YAML may give one).
   */
  private upgrade(raw: Record<string, unknown>): State {
    const state = { ...emptyState(), ...raw } as State;
    state.tasks = state.tasks.map((t) => ({ ...t, factoryId: t.factoryId ?? LEGACY_FACTORY, dependsOn: t.dependsOn ?? [] }));
    state.events = state.events.map((e) => ({ ...e, factoryId: e.factoryId ?? LEGACY_FACTORY }));
    const legacy = state.settings as unknown as { global?: Settings; repos?: Record<string, RepoSettings> } | null;
    if (legacy && 'global' in legacy) {
      state.settings = { factories: { [LEGACY_FACTORY]: { factory: legacy.global ?? clone(DEFAULT_SETTINGS), repos: legacy.repos ?? {} } } };
    }
    if (this.factoriesDir === undefined) return state;
    const key = this.yamlKey(this.factoriesDir);
    if (this.seeded?.key !== key) {
      this.seeded = { key, ...loadFactoriesFromDir(this.factoriesDir, (file, reason) => this.log?.(`skipped ${file}: ${reason}`)) };
    }
    const owned = new Set(this.seeded.owned);
    state.factoryDefs = [
      ...clone(this.seeded.defs),
      ...state.factoryDefs.filter((d) => !owned.has(d.factoryId)).map(({ github: _stored, ...def }) => def),
    ];
    state.factoryRepos = [...clone(this.seeded.repos), ...state.factoryRepos.filter((r) => !owned.has(r.factoryId))];
    return state;
  }

  /** Every factory.yaml and repos/*.yaml under the factories dir with its mtime and size: it changes when one is edited, added or removed. */
  private yamlKey(dir: string): string {
    const parts: string[] = [];
    const stamp = (file: string): void => {
      try {
        const st = statSync(file);
        parts.push(`${file}:${st.mtimeMs}:${st.size}`);
      } catch { /* not there */ }
    };
    if (!existsSync(dir)) return '';
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      stamp(join(dir, e.name, 'factory.yaml'));
      const reposDir = join(dir, e.name, 'repos');
      if (!existsSync(reposDir)) continue;
      for (const f of readdirSync(reposDir).filter((n) => n.endsWith('.yaml'))) stamp(join(reposDir, f));
    }
    return parts.sort().join('|');
  }

  /** Writes board.json without the definitions and repos the YAML owns: those live only in their files. */
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const owned = new Set(this.seeded?.owned ?? []);
    const state: State = {
      ...this.state,
      factoryDefs: this.state.factoryDefs.filter((d) => !owned.has(d.factoryId)),
      factoryRepos: this.state.factoryRepos.filter((r) => !owned.has(r.factoryId)),
    };
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }

  private async lock(): Promise<number> {
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        return openSync(this.lockPath, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (this.lockIsStale()) {
        rmSync(this.lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`board store is locked (${this.lockPath}); another factory process is writing, or remove the lock file`);
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }

  private lockIsStale(): boolean {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS;
    } catch {
      return false; // released meanwhile: just try again
    }
  }
}
