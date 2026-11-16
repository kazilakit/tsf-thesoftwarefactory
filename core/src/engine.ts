import { parseAgentResult } from './agentResult.js';
import { assertPushAllowed, branchName, isMainRef, ProtectedBranchError } from './branchGuard.js';
import { formatReport, runChecks, type Exec } from './checks.js';
import { claim, claimExpired, release, renew } from './claims.js';
import { AGENT_FOR, DEFAULT_SETTINGS } from './defaults.js';
import { GATE_DOC, resolveGates, resolveSettings, shouldMerge, validApproval } from './gates.js';
import type { GitRepos } from './git.js';
import { PrBaseMismatchError, parseRemote, type GitHub, type GitHubFor } from './github.js';
import { unfinishedDeps } from './dependencies.js';
import { diffEvents } from './history.js';
import { decide, IllegalInputError, type Decision, type Input } from './machine.js';
import type { Checks } from './checksSchema.js';
import { protectedFor, type AgentModel, type FactoryConfig, type FactoryDef, type FactoryRepo } from './factories.js';
import { GhLoginMissingError, SecretMissingError } from './secrets.js';
import { assertMove, IllegalMoveError, TERMINAL } from './status.js';
import {
  ForbiddenError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError,
  updateHeld, VersionConflictError, type BoardStore, type StoredSettings,
} from './store.js';
import type { AgentResult, AgentStep, DocKind, FactoryEvent, Gate, Mode, Settings, Status, Step, Task } from './types.js';

export interface EngineDeps {
  store: BoardStore;
  git: GitRepos;
  /** The GitHub client for a factory's gh login (`ghUser`). */
  githubFor: GitHubFor;
  /** The factory definitions, read from the store each time `next`, `sync` or `status` runs. */
  factories: () => Promise<FactoryConfig>;
  exec: Exec;
  now: () => Date;
  mode: Mode;
  claimant: string;
  /** Operational notes such as tasks sync skipped (the CLI writes them to stderr). Default: dropped. */
  log?: (msg: string) => void;
}

export interface Ticket {
  taskId: string;
  step: Step;
  worktree: string;
  runId: string | null;
  /** The model the factory set for this agent step's stage; absent means the session's model. */
  model?: AgentModel;
  context: {
    task: Task;
    factory: { factoryId: string; name: string; docsPath: string };
    /** The repo's check commands. */
    checks: Checks;
    spec?: string;
    plan?: string;
    feedback?: string;
    /** The report the checks step wrote (the verify doc). */
    checksReport?: string;
  };
}

/** `no-factories`: the Board has no factory definition at all (before the first Import); nothing was changed. */
export type NextOutcome = { kind: 'ticket'; ticket: Ticket } | { kind: 'none'; reason: 'nothing to do' | 'paused' | 'inactive' | 'no-factories' }
  | { kind: 'none'; reason: 'waiting'; taskId: string; waitingOn: string[] }
  /** Only with `peek`: the task `next` would claim now. Nothing was claimed. */
  | { kind: 'work'; taskId: string };

/** What the CLI prints for `no-factories`. */
export const NO_FACTORIES = 'no factories; run ./factory init';

export interface FactoryStatus {
  factoryId: string;
  name: string;
  active: boolean;
  paused: boolean;
  counts: Partial<Record<Status, number>>;
  /** The gh CLI login the factory uses (its validated `ghUser`). */
  ghUser: string;
  /** Whether the factory's gh login was found when last checked; null when it was never checked. */
  ghLoggedIn: boolean | null;
}

export interface EngineStatus {
  /** True when every factory in the filter is paused. */
  paused: boolean;
  active: { taskId: string; step: Step | null; claimBy: string | null; claimUntil: string | null }[];
  counts: Partial<Record<Status, number>>;
  tasks: Pick<Task, 'taskId' | 'title' | 'repo' | 'status' | 'stage' | 'blockedReason' | 'question' | 'prUrl'>[];
  factories: FactoryStatus[];
}

export class ClaimError extends Error {
  constructor(taskId: string, claimant: string) {
    super(`${taskId} is not claimed by ${claimant}`);
    this.name = 'ClaimError';
  }
}

/** `next --factory <id>` named a factory that is neither defined nor skipped as invalid. */
export class UnknownFactoryError extends Error {
  constructor(readonly factoryId: string) {
    super(`unknown factory ${factoryId}`);
    this.name = 'UnknownFactoryError';
  }
}

export class StageError extends Error {
  constructor(taskId: string, step: Step, stage: Step | null) {
    super(`${taskId} is at stage ${stage ?? '-'}, not ${step}`);
    this.name = 'StageError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors that the same call would hit again: retrying only delays them. */
const FINAL_ERRORS = [
  VersionConflictError, SecretMissingError, ProtectedBranchError, PrBaseMismatchError,
  NotFoundError, OwnerOnlyError, ForbiddenError, RereadAfterUpdateError,
];

/** Retries `fn` with doubling waits (baseMs, 2·baseMs, …) between tries. FINAL_ERRORS are rethrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { tries: number; baseMs: number }): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (FINAL_ERRORS.some((E) => e instanceof E) || i + 1 >= opts.tries) throw e;
      await sleep(opts.baseMs * 2 ** i);
    }
  }
}

const RETRY = { tries: 3, baseMs: 500 };
const retry = <T>(fn: () => Promise<T>) => withRetry(fn, RETRY);

const AGENT_STEPS: ReadonlySet<Step> = new Set<Step>(['spec', 'plan', 'build', 'verify', 'review']);
const WORKING: ReadonlySet<Status> = new Set<Status>(['spec', 'plan', 'build', 'verify', 'review']);
const taskNum = (id: string) => Number(id.slice(id.indexOf('-') + 1)) || 0;

/** One factory's own settings (before repo and task overrides), defaults where none are stored. */
const factorySettings = (stored: StoredSettings, factoryId: string): Settings => stored.factories[factoryId]?.factory ?? DEFAULT_SETTINGS;

export class Engine {
  constructor(private readonly deps: EngineDeps) {}

  private get coreActor() {
    return `core · ${this.deps.mode}`;
  }

  /** Reads the definitions and logs each skipped one (an invalid definition is not a factory) once. */
  private async loadFactories(): Promise<FactoryConfig> {
    const cfg = await retry(() => this.deps.factories());
    for (const { id, reason } of cfg.skipped()) this.logOnce(`${id.includes('/') ? 'repo' : 'factory'} ${id} skipped: ${reason}`);
    return cfg;
  }

  private logOnce(note: string): void {
    if (this.loggedSkips.has(note)) return;
    this.loggedSkips.add(note);
    this.deps.log?.(note);
  }

  private readonly loggedSkips = new Set<string>();

  /** `filter` limits the pass to those factories; left out, every factory. With no definitions at all it changes nothing. */
  async sync(filter?: string[]): Promise<void> {
    const cfg = await this.loadFactories();
    if (!cfg.hasDefinitions()) {
      this.deps.log?.(NO_FACTORIES);
      return;
    }
    await this.syncWith(cfg, filter);
  }

  private async syncWith(cfg: FactoryConfig, filter?: string[]): Promise<void> {
    const { store } = this.deps;
    const stored = await retry(() => store.getSettings());
    for (const task of await retry(() => store.listTasks())) {
      if (filter && !filter.includes(task.factoryId)) continue;
      try {
        if (this.skipped(cfg, task)) continue; // its definition is invalid: leave the task as it is until it is fixed
        const gone = this.goneReason(cfg, task);
        if (gone) {
          if (!TERMINAL.has(task.status) && task.status !== 'blocked' && task.status !== 'inbox') {
            await this.apply(task, this.decideFor(task, { kind: 'limit', reason: gone }, factorySettings(stored, task.factoryId)), this.coreActor);
          }
          continue;
        }
        const settings = this.settingsFor(stored, task);
        const def = cfg.factory(task.factoryId)!;
        const moved = await this.syncGate(task, settings, def, protectedFor(def, cfg.repo(task.factoryId, task.repo)));
        const t = moved ?? task;
        if (t.stage !== null && t.status !== 'blocked' && !TERMINAL.has(t.status) && t.costUsd > settings.maxCostPerTaskUsd) {
          await this.apply(t, this.decideFor(t, { kind: 'limit', reason: costReason(t.costUsd, settings) }, settings), this.coreActor);
        }
      } catch (e) {
        // Illegal inputs and moves are bugs and surface. Version conflicts and outages that outlast the retries skip this task for this pass.
        if (e instanceof IllegalInputError || e instanceof IllegalMoveError) throw e;
        this.deps.log?.(`sync: skipped ${task.taskId}: ${firstLine(e)}`);
      }
    }
  }

  /** True when the task's factory or repo definition was skipped as invalid (not the same as deleted). */
  private skipped(cfg: FactoryConfig, task: Task): boolean {
    return this.skippedReason(cfg, task) !== undefined;
  }

  /** Why the task's definition was skipped as invalid; the repo clause applies only while the factory exists (a gone factory is not skipped). */
  private skippedReason(cfg: FactoryConfig, task: Task): string | undefined {
    const ids = new Set(cfg.skipped().map((s) => s.id));
    const { factoryId, repo } = task;
    if (!cfg.factory(factoryId)) return ids.has(factoryId) ? `factory ${factoryId} is invalid (skipped)` : undefined;
    return !cfg.repo(factoryId, repo) && ids.has(`${factoryId}/${repo}`) ? `repo ${factoryId}/${repo} is invalid (skipped)` : undefined;
  }

  /** Why the task's factory or repo cannot be found, or undefined when both are there. */
  private goneReason(cfg: FactoryConfig, task: Task): string | undefined {
    if (!cfg.factory(task.factoryId)) return `factory ${task.factoryId} no longer exists`;
    if (!cfg.repo(task.factoryId, task.repo)) return `repo ${task.repo} no longer exists in ${task.factoryId}`;
    return undefined;
  }

  /**
   * `filter` limits claiming to those factories; left out, every factory. With `peek`, it syncs and picks exactly as
   * it would, but claims nothing and returns the first candidate as `work`: a free check for a watcher.
   */
  async next(taskId?: string, filter?: string[], opts: { peek?: boolean } = {}): Promise<NextOutcome> {
    const { store, now, claimant } = this.deps;
    const cfg = await this.loadFactories();
    if (!cfg.hasDefinitions()) return { kind: 'none', reason: 'no-factories' };
    const known = new Set([...cfg.factories().map((f) => f.factoryId), ...cfg.skipped().filter((s) => !s.id.includes('/')).map((s) => s.id)]);
    const unknown = filter?.find((id) => !known.has(id));
    if (unknown !== undefined) throw new UnknownFactoryError(unknown);
    const stored = await retry(() => store.getSettings());
    const scope = cfg.factories().filter((f) => !filter || filter.includes(f.factoryId));
    const paused = (f: FactoryDef) => factorySettings(stored, f.factoryId).paused;
    // Paused or inactive means no new claims; approvals, PR merges and limits still advance.
    await this.syncWith(cfg, filter);
    const open = scope.filter((f) => f.active && !paused(f));
    if (open.length === 0) {
      const reason = scope.length === 0 ? 'nothing to do' : scope.some(paused) ? 'paused' : 'inactive';
      return { kind: 'none', reason };
    }

    const openIds = new Set(open.map((f) => f.factoryId));
    const tasks = await retry(() => store.listTasks());
    const activeBy = new Map<string, number>();
    for (const t of tasks) if (!claimExpired(t, now())) activeBy.set(t.factoryId, (activeBy.get(t.factoryId) ?? 0) + 1);
    const hasRoom = (factoryId: string) => (activeBy.get(factoryId) ?? 0) < factorySettings(stored, factoryId).maxParallel;

    const workable = (t: Task) => t.status === 'ready' || (t.stage !== null && WORKING.has(t.status));
    // A named task in a closed factory: say why it is not picked rather than "nothing to do".
    const target = taskId === undefined ? undefined : tasks.find((t) => t.taskId === taskId);
    const targetDef = target && workable(target) ? scope.find((f) => f.factoryId === target.factoryId) : undefined;
    if (target && targetDef) {
      if (this.settingsFor(stored, target).paused) return { kind: 'none', reason: 'paused' };
      if (!targetDef.active) return { kind: 'none', reason: 'inactive' };
      // A named task not started yet waits for its dependencies; one past ready is never held back.
      const waitingOn = target.status === 'ready' ? unfinishedDeps(target, tasks) : [];
      if (waitingOn.length > 0) return { kind: 'none', reason: 'waiting', taskId: target.taskId, waitingOn };
    }
    const candidates = tasks
      .filter((t) => openIds.has(t.factoryId) && hasRoom(t.factoryId) && cfg.repo(t.factoryId, t.repo))
      .filter((t) => !this.settingsFor(stored, t).paused)
      .filter((t) => taskId !== undefined || t.status !== 'ready' || unfinishedDeps(t, tasks).length === 0)
      .filter((t) => (taskId === undefined ? workable(t) && claimExpired(t, now()) : t.taskId === taskId && workable(t)))
      .sort((a, b) => taskNum(a.taskId) - taskNum(b.taskId));

    if (opts.peek) return candidates[0] ? { kind: 'work', taskId: candidates[0].taskId } : { kind: 'none', reason: 'nothing to do' };
    for (const candidate of candidates) {
      let claimed: Task | null;
      try {
        claimed = await retry(() => claim(store, candidate, claimant, now()));
      } catch {
        continue; // outage on this task: skip it this pass
      }
      if (!claimed) continue;
      try {
        const ticket = await this.ticket(claimed, this.settingsFor(stored, claimed), cfg);
        return ticket ? { kind: 'ticket', ticket } : { kind: 'none', reason: 'nothing to do' };
      } catch (e) {
        await this.releaseOwnClaim(claimed.taskId);
        if (taskId !== undefined) throw e;
        // One task that cannot be set up must not stop the queue: note why and try the next one.
        await this.noteSetupError(claimed, e);
      }
    }
    return { kind: 'none', reason: 'nothing to do' };
  }

  async complete(taskId: string, step: AgentStep, raw: string | undefined): Promise<Task> {
    return this.completeWith(taskId, step, parseAgentResult(raw, step));
  }

  async completeWith(taskId: string, step: AgentStep, parsed: AgentResult): Promise<Task> {
    const { store, mode } = this.deps;
    await this.claimedAt(taskId, step);
    const result = parsed;
    const run = await retry(() => store.openRun(taskId, step));
    if (!run) throw new Error(`no open ${step} run for ${taskId}`);
    const actor = `${AGENT_FOR[step]} · ${mode} · run ${run.runId}`;

    if (result.status === 'done' && result.doc !== undefined && step !== 'build') {
      const doc = result.doc;
      await retry(() => store.addDoc(taskId, step, doc, actor));
    }
    await retry(() =>
      store.finishRun(run.runId, { result: result.status, turns: result.turns ?? null, costUsd: result.costUsd ?? null }),
    );

    // A detached renewal may have bumped the task version while the doc and run were written: decide on the fresh task.
    const task = await this.claimedAt(taskId, step);
    const costUsd = task.costUsd + (result.costUsd ?? 0);
    const settings = this.settingsFor(await retry(() => store.getSettings()), task);
    const input: Input =
      costUsd > settings.maxCostPerTaskUsd
        ? { kind: 'limit', reason: costReason(costUsd, settings) }
        : { kind: 'agent', step, result };
    const decision = this.decideFor(task, input, settings);
    return this.apply(task, { ...decision, patch: { ...decision.patch, costUsd } }, actor);
  }

  async check(taskId: string): Promise<Task> {
    const { store, exec } = this.deps;
    const claimed = await this.claimedAt(taskId, 'check');
    const { def, repo } = this.repoOf(await this.loadFactories(), claimed);
    const worktree = await this.worktreeFor(def, repo, claimed, requireBranch(claimed));
    const report = await runChecks(repo, worktree, exec);
    // The checks take a while and the claim may have been renewed meanwhile: decide on the fresh task.
    const task = await this.claimedAt(taskId, 'check');
    const settings = this.settingsFor(await retry(() => store.getSettings()), task);
    await retry(() => store.addDoc(taskId, 'verify', formatReport(report), 'core · checks'));
    const summary = report.steps
      .filter((s) => s.exitCode !== 0)
      .map((s) => s.name)
      .join(', ');
    return this.apply(task, this.decideFor(task, { kind: 'checks', passed: report.passed, summary }, settings), this.coreActor);
  }

  async ship(taskId: string): Promise<Task> {
    const { store } = this.deps;
    const claimed = await this.claimedAt(taskId, 'ship');
    const { def, repo: cfg } = this.repoOf(await this.loadFactories(), claimed);
    const branch = requireBranch(claimed);
    const protectedBranches = protectedFor(def, cfg);
    assertPushAllowed(branch, protectedBranches);
    const settings = this.settingsFor(await retry(() => store.getSettings()), claimed);
    const block = (task: Task, reason: string) =>
      this.apply(task, this.decideFor(task, { kind: 'limit', reason }, settings), this.coreActor);
    // Defence in depth: the creators and the edit refuse main, but a row written another way must still never reach it.
    if (isMainRef(claimed.baseBranch)) return block(claimed, 'base main is never a target');
    try {
      const github = this.deps.githubFor(def.ghUser);
      await github.ensureReady?.(); // before any push: a missing gh login must not leave a pushed branch behind
      return await this.shipTo({ github, def, cfg, claimed, branch, settings, block });
    } catch (e) {
      // The factory's gh login is not logged in: block the task until the owner runs gh auth login and answers. Other factories are unaffected.
      if (!(e instanceof GhLoginMissingError)) throw e;
      return block(await this.claimedAt(taskId, 'ship'), e.message);
    }
  }

  private async shipTo(c: {
    github: GitHub; def: FactoryDef; cfg: FactoryRepo; claimed: Task; branch: string; settings: Settings; block: (task: Task, reason: string) => Promise<Task>;
  }): Promise<Task> {
    const { github, def, cfg, claimed, branch, settings, block } = c;
    const taskId = claimed.taskId;
    const protectedBranches = protectedFor(def, cfg);

    // A task returned from pr_open already has a PR: reuse it while open. If it merged meanwhile, the commits
    // made for the requested changes are not in it, so the task waits for the user instead of counting as done.
    const existing = claimed.prUrl;
    const state = existing ? await retry(() => github.prState(existing)) : undefined;
    if (existing && state === 'merged') return block(claimed, 'previous PR was merged; new commits are not shipped');

    const worktree = await this.worktreeFor(def, cfg, claimed, branch);
    await this.deps.git.push(worktree, branch, protectedBranches);

    // An earlier ship may have opened the PR and failed before recording it: find it before opening a new one.
    const pr =
      existing && state === 'open'
        ? { url: existing }
        : ((await retry(() => github.findOpenPr({ remote: cfg.remote, head: branch, base: claimed.baseBranch }))) ??
          (await retry(() => this.openPr(github, claimed, cfg, branch))));

    // Push and PR take a while and the claim may have been renewed: record the PR on the fresh task first.
    let task = await this.claimedAt(taskId, 'ship');
    if (task.prUrl !== pr.url) task = await this.record(task, { prUrl: pr.url }, 'PR opened');

    const merged = shouldMerge(task.baseBranch, resolveGates(settings, task.gateOverrides).pr, protectedBranches);
    if (merged) {
      try {
        await retry(() => github.mergePr(pr.url, task.baseBranch, protectedBranches));
      } catch (e) {
        if (e instanceof PrBaseMismatchError) return block(task, e.message);
        if (e instanceof ProtectedBranchError) return block(task, `${pr.url} targets ${e.branch}, a protected branch; not merged`);
        throw e;
      }
    }
    return this.apply(task, this.decideFor(task, { kind: 'shipped', prUrl: pr.url, merged }, settings), this.coreActor);
  }

  /** Extends this claimant's claim on the task by CLAIM_MS from now; throws ClaimError when the claim is not held. */
  async renew(taskId: string): Promise<Task> {
    const { store, claimant, now } = this.deps;
    const task = await retry(() => store.getTask(taskId));
    const renewed = await retry(() => renew(store, task, claimant, now()));
    if (!renewed) throw new ClaimError(taskId, claimant);
    return renewed;
  }

  async status(filter?: string[]): Promise<EngineStatus> {
    const { store, now } = this.deps;
    const cfg = await this.loadFactories();
    const stored = await retry(() => store.getSettings());
    const health = new Map((await retry(() => store.listFactoryHealth())).map((h) => [h.factoryId, h.ghLoggedIn]));
    const inScope = (factoryId: string) => !filter || filter.includes(factoryId);
    const tasks = (await retry(() => store.listTasks())).filter((t) => inScope(t.factoryId));
    const count = (list: Task[]) => {
      const counts: Partial<Record<Status, number>> = {};
      for (const t of list) counts[t.status] = (counts[t.status] ?? 0) + 1;
      return counts;
    };
    const active = tasks
      .filter((t) => !claimExpired(t, now()))
      .map((t) => ({ taskId: t.taskId, step: t.stage, claimBy: t.claimBy, claimUntil: t.claimUntil }));
    const list = tasks.map(({ taskId, title, repo, status, stage, blockedReason, question, prUrl }) => ({
      taskId, title, repo, status, stage, blockedReason, question, prUrl,
    }));
    const factories = cfg.factories().filter((f) => inScope(f.factoryId)).map((f) => ({
      factoryId: f.factoryId,
      name: f.name,
      active: f.active,
      paused: factorySettings(stored, f.factoryId).paused,
      counts: count(tasks.filter((t) => t.factoryId === f.factoryId)),
      ghUser: f.ghUser,
      ghLoggedIn: health.get(f.factoryId) ?? null,
    }));
    return { paused: factories.length > 0 && factories.every((f) => f.paused), active, counts: count(tasks), tasks: list, factories };
  }

  /** The only way a task changes status: checks the move, writes with the task's version, clears the claim, logs events. */
  private async apply(task: Task, decision: Decision, actor: string, reason = decision.reason): Promise<Task> {
    const { store, now } = this.deps;
    if (decision.status !== task.status) assertMove(task.status, decision.status, 'core');
    const updated = await retry(() =>
      updateHeld(store, task, {
        ...decision.patch,
        // A blocked task waits for a new answer; a stale one must not resume it.
        ...(decision.status === 'blocked' ? { answer: null } : {}),
        status: decision.status,
        stage: decision.stage,
        claimBy: null,
        claimUntil: null,
      }),
    );
    // Built once: a retry must send the same events (same time, same eventId), or a lost reply makes duplicates.
    const events = diffEvents(task, updated, actor, reason, now().toISOString());
    await retry(() => store.addEvents(events));
    return updated;
  }

  /** A version-checked field write that keeps status and claim, with its events. */
  private async record(task: Task, patch: Partial<Task>, reason: string): Promise<Task> {
    const { store, now } = this.deps;
    const updated = await retry(() => updateHeld(store, task, patch));
    const events = diffEvents(task, updated, this.coreActor, reason, now().toISOString());
    await retry(() => store.addEvents(events));
    return updated;
  }

  /** The task's issue number when the issue lives in the PR's repo; undefined on no link, another repo or a failed read. */
  private async linkedIssue(taskId: string, remote: string): Promise<number | undefined> {
    try {
      const link = await retry(() => this.deps.store.getGitHubLink(taskId));
      if (link?.issueNumber == null) return undefined;
      const { owner, repo } = parseRemote(remote);
      return link.repo.toLowerCase() === `${owner}/${repo}`.toLowerCase() ? link.issueNumber : undefined;
    } catch (e) {
      this.deps.log?.(`PR body: issue link not read (${firstLine(e)})`);
      return undefined;
    }
  }

  private async openPr(github: GitHub, task: Task, cfg: FactoryRepo, branch: string): Promise<{ url: string }> {
    const spec = (await retry(() => this.deps.store.currentDoc(task.taskId, 'spec')))?.body ?? '';
    const issue = await this.linkedIssue(task.taskId, cfg.remote);
    return github.openPr({
      remote: cfg.remote,
      head: branch,
      base: task.baseBranch,
      title: `[${task.taskId}] ${task.title}`,
      body: `Factory task ${task.taskId}\n\n${spec.slice(0, 3000)}${issue ? `\n\nCloses #${issue}` : ''}`,
    });
  }

  /** Approval, PR and answer moves for one task (`protectedBranches`: its repo's list); returns the moved task, or undefined if nothing moved. */
  private async syncGate(task: Task, settings: Settings, def: FactoryDef, protectedBranches: string[]): Promise<Task | undefined> {
    const { store } = this.deps;
    const github = this.deps.githubFor(def.ghUser);
    const approval = async (gate: Gate) => {
      const doc = await retry(() => store.currentDoc(task.taskId, GATE_DOC[gate]));
      return validApproval(await retry(() => store.listApprovals(task.taskId)), gate, doc?.version);
    };

    switch (task.status) {
      case 'spec_review':
      case 'plan_review': {
        const a = await approval(task.status === 'spec_review' ? 'spec' : 'plan');
        return a ? this.apply(task, this.decideFor(task, { kind: 'approval', approval: a }, settings), this.coreActor) : undefined;
      }
      case 'pr_open': {
        const url = task.prUrl;
        if (url) {
          const state = await retry(() => github.prState(url));
          if (state !== 'open') return this.apply(task, this.decideFor(task, { kind: 'pr', state }, settings), this.coreActor);
        }
        const a = await approval('pr');
        if (a?.decision === 'changes') {
          return this.apply(task, this.decideFor(task, { kind: 'approval', approval: a }, settings), this.coreActor);
        }
        if (a?.decision === 'approve' && url && shouldMerge(task.baseBranch, false, protectedBranches)) {
          await retry(() => github.mergePr(url, task.baseBranch, protectedBranches));
          return this.apply(task, this.decideFor(task, { kind: 'pr', state: 'merged' }, settings), this.coreActor);
        }
        return undefined;
      }
      case 'blocked':
        if (task.answer?.trim() && task.stage !== null) {
          return this.apply(task, this.decideFor(task, { kind: 'answered' }, settings), this.coreActor);
        }
        if (task.answer?.trim() && task.stage === null && def.github?.mode === 'github-only') {
          return this.apply(task, this.decideFor(task, { kind: 'restart' }, settings), this.coreActor);
        }
        return undefined;
      default:
        return undefined;
    }
  }

  /** Builds the ticket for a task this claimant just claimed, moving a ready task to spec first. */
  private async ticket(claimed: Task, settings: Settings, cfg: FactoryConfig): Promise<Ticket | null> {
    const { store, git, now, claimant, mode } = this.deps;
    const { def, repo } = this.repoOf(cfg, claimed);
    let task = claimed;
    let worktree: string;
    if (task.status === 'ready') {
      const branch = branchName(task.taskId, task.title);
      await git.ensureClone(def.factoryId, repo, protectedFor(def, repo));
      worktree = await this.worktreeFor(def, repo, task, branch);
      const d = this.decideFor(task, { kind: 'claimed' }, settings);
      const moved = await this.apply(task, { ...d, patch: { ...d.patch, branch } }, this.coreActor);
      const reclaimed = await retry(() => claim(store, moved, claimant, now()));
      if (!reclaimed) return null;
      task = reclaimed;
    } else {
      worktree = await this.worktreeFor(def, repo, task, requireBranch(task));
    }

    const step = task.stage!;
    let runId: string | null = null;
    if (AGENT_STEPS.has(step)) {
      const agentStep = step as AgentStep;
      // Each try looks for the open run first: a start whose reply was lost has made it already.
      const run = await retry(async () =>
        (await store.openRun(task.taskId, step)) ?? store.startRun({ taskId: task.taskId, step, mode, agent: AGENT_FOR[agentStep] }),
      );
      runId = run.runId;
    }

    const body = async (kind: DocKind) => (await retry(() => store.currentDoc(task.taskId, kind)))?.body;
    const context: Ticket['context'] = {
      task, factory: { factoryId: def.factoryId, name: def.name, docsPath: def.docsPath }, checks: repo.checks,
    };
    const values = {
      spec: await body('spec'),
      plan: await body('plan'),
      feedback: task.answer ?? undefined,
      checksReport: await body('verify'),
    };
    for (const [k, v] of Object.entries(values) as [keyof typeof values, string | undefined][]) {
      if (v !== undefined) context[k] = v;
    }
    const model = AGENT_STEPS.has(step) ? def.agentModels?.[step as AgentStep] : undefined;
    return { taskId: task.taskId, step, worktree, runId, ...(model ? { model } : {}), context };
  }

  /** Best effort: records a setup failure on the task's history; errors are ignored. */
  private async noteSetupError(task: Task, e: unknown): Promise<void> {
    const events: FactoryEvent[] = [
      {
        taskId: task.taskId, factoryId: task.factoryId, actor: this.coreActor, action: 'set', field: 'setupError', from: null, to: firstLine(e),
        reason: 'setup failed', at: this.deps.now().toISOString(),
      },
    ];
    try {
      await retry(() => this.deps.store.addEvents(events));
    } catch {
      // The next pass tries again.
    }
  }

  /** Best effort: drops this claimant's claim on the fresh task; errors are ignored. */
  private async releaseOwnClaim(taskId: string): Promise<void> {
    try {
      const fresh = await retry(() => this.deps.store.getTask(taskId));
      if (fresh.claimBy === this.deps.claimant) await retry(() => release(this.deps.store, fresh));
    } catch {
      // The claim expires on its own.
    }
  }

  /** Reads the task and checks this claimant holds it at `step`. A lapsed claim nobody re-claimed still counts. */
  private async claimedAt(taskId: string, step: Step): Promise<Task> {
    const task = await retry(() => this.deps.store.getTask(taskId));
    if (task.claimBy !== this.deps.claimant) throw new ClaimError(taskId, this.deps.claimant);
    if (task.stage !== step) throw new StageError(taskId, step, task.stage);
    return task;
  }

  private decideFor(task: Task, input: Input, settings: Settings): Decision {
    return decide(task, input, resolveGates(settings, task.gateOverrides));
  }

  private settingsFor(stored: StoredSettings, task: Task): Settings {
    const entry = stored.factories[task.factoryId];
    return resolveSettings(entry?.factory ?? DEFAULT_SETTINGS, entry?.repos[task.repo]);
  }

  /** The task's worktree; a new one branches from the task's base, not the repo default. */
  private worktreeFor(def: FactoryDef, repo: FactoryRepo, task: Task, branch: string): Promise<string> {
    return this.deps.git.worktree(
      def.factoryId, { ...repo, baseBranch: task.baseBranch }, task.taskId, branch, protectedFor(def, repo), { gitName: def.gitName, gitEmail: def.gitEmail },
    );
  }

  /** The task's factory and repo definitions; throws the blocking reason when either is gone. */
  private repoOf(cfg: FactoryConfig, task: Task): { def: FactoryDef; repo: FactoryRepo } {
    const reason = this.skippedReason(cfg, task) ?? this.goneReason(cfg, task);
    if (reason) throw new Error(reason);
    return { def: cfg.factory(task.factoryId)!, repo: cfg.repo(task.factoryId, task.repo)! };
  }
}

function requireBranch(task: Task): string {
  if (!task.branch) throw new Error(`${task.taskId} has no branch`);
  return task.branch;
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
}

function costReason(cost: number, s: Settings): string {
  return `cost limit reached ($${cost.toFixed(2)} > $${s.maxCostPerTaskUsd})`;
}
