import type { FactoryDef, FactoryHealth, FactoryRepo } from './factories.js';
import type { GitHubLink } from './githubLink.js';
import type { Approval, Doc, DocKind, FactoryEvent, Mode, RepoId, RepoSettings, Run, Settings, Step, Task } from './types.js';

// The store contract, its errors and updateHeld. Pure (no Node API); store.ts re-exports it.

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class VersionConflictError extends Error {
  /** `message` replaces the version wording when the conflict is a changed value, not a version number. */
  constructor(taskId: string, expected: number, actual: number, message?: string) {
    super(message ?? `version conflict on ${taskId}: expected ${expected}, found ${actual}`);
    this.name = 'VersionConflictError';
  }
}

/** The store refused the write (an access or column rule): nothing was written, and the same call is refused again. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** The caller's identity may not do this at all (the owner does it on the Board). */
export class OwnerOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerOnlyError';
  }
}

/**
 * The task update landed (version + 1) but the task could not be read back. Final: sending the update again
 * would be a version conflict with our own write. The caller knows the result: its task plus its patch.
 */
export class RereadAfterUpdateError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} updated; re-read failed`);
    this.name = 'RereadAfterUpdateError';
  }
}

export type NewApproval = Omit<Approval, 'at'> & { approvalId?: string };

/** The same approval content: a stored one with the caller's id is a retry only if this matches. */
export const sameApproval = (a: Omit<Approval, 'at'>, b: Omit<Approval, 'at'>): boolean =>
  a.taskId === b.taskId && a.gate === b.gate && a.docVersion === b.docVersion && a.decision === b.decision && a.comment === b.comment;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with object keys sorted, so equal values compare equal whatever their key order. undefined is 'undefined'. */
export const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    isPlainObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x) ?? 'undefined';

/** The stored value of one settings scope changed since the caller read it. */
export const settingsConflict = (scope: string): VersionConflictError =>
  new VersionConflictError(`settings ${scope}`, Number.NaN, Number.NaN, `settings ${scope} changed since they were read; reload and save again`);

/** Settings per factory: the factory's own scope and one scope per repo. A factory without stored settings is absent. */
export interface StoredSettings {
  factories: Record<string, { factory: Settings; repos: Record<string, RepoSettings> }>;
}

/** Who calls a store that checks it: the owner on the Board, or the factory core. A store made without one checks nothing. */
export type StoreIdentity = 'owner' | 'core';

/** The settings scope of a factory (`<f>`) or of one of its repos (`<f>/<r>`). */
export function parseScope(scope: string): { factoryId: string; repoId?: string } {
  const slash = scope.indexOf('/');
  return slash < 0 ? { factoryId: scope } : { factoryId: scope.slice(0, slash), repoId: scope.slice(slash + 1) };
}

/** `status` is where the task starts (default inbox); the owner's Board and `factory new` choose it. */
export interface NewTask { factoryId: string; title: string; description: string; repo: RepoId; baseBranch?: string; status?: 'inbox' | 'ready'; dependsOn?: string[] }

/** A task is created only in inbox or ready; the type is no defence against a JS caller. */
export function assertNewStatus(status: unknown): void {
  if (status !== undefined && status !== 'inbox' && status !== 'ready') throw new Error(`a new task starts in inbox or ready, not ${String(status)}`);
}

export interface BoardStore {
  listTasks(): Promise<Task[]>;
  /** Throws NotFoundError. */
  getTask(id: string): Promise<Task>;
  createTask(t: NewTask): Promise<Task>;
  /** Throws VersionConflictError; returns the stored task with version + 1. */
  updateTask(id: string, expectedVersion: number, patch: Partial<Task>): Promise<Task>;
  /** Core only. Inserts the task as given, at version 1 (a rebuild keeps the task's id); VersionConflictError when the id exists. */
  restoreTask(t: Task): Promise<Task>;
  addDoc(taskId: string, kind: DocKind, body: string, author: string): Promise<Doc>;
  currentDoc(taskId: string, kind: DocKind): Promise<Doc | undefined>;
  /** Every version of a task's doc, ascending; the highest is 'current', the rest 'superseded'. */
  listDocs(taskId: string, kind: DocKind): Promise<Doc[]>;
  /** A caller-supplied `approvalId` makes a retry safe: the same id returns the approval already stored. */
  addApproval(a: NewApproval): Promise<Approval>;
  listApprovals(taskId: string): Promise<Approval[]>;
  /** The factory definitions. */
  listFactoryDefs(): Promise<FactoryDef[]>;
  /** One factory's repos, or every factory's when `factoryId` is left out. */
  listFactoryRepos(factoryId?: string): Promise<FactoryRepo[]>;
  /**
   * Owner only. Compare-and-set on `version`: `before` null inserts (a VersionConflictError if the factory exists),
   * otherwise `before.version` must be the stored one. Returns the stored definition with the next version.
   */
  saveFactoryDef(before: FactoryDef | null, after: FactoryDef): Promise<FactoryDef>;
  /** Owner only. As saveFactoryDef, keyed by factory and repo id. */
  saveFactoryRepo(before: FactoryRepo | null, after: FactoryRepo): Promise<FactoryRepo>;
  /** What was last pushed to GitHub per task: one factory's links, or every factory's when `factoryId` is left out. */
  listGitHubLinks(factoryId?: string): Promise<GitHubLink[]>;
  getGitHubLink(taskId: string): Promise<GitHubLink | undefined>;
  /** Core only. Compare-and-set on `version` as saveFactoryDef, keyed by task id. Returns the stored link. */
  saveGitHubLink(before: GitHubLink | null, after: GitHubLink): Promise<GitHubLink>;
  listFactoryHealth(): Promise<FactoryHealth[]>;
  /** Core only: the owner reads health, the core writes it. */
  setFactoryHealth(h: FactoryHealth): Promise<void>;
  getSettings(): Promise<StoredSettings>;
  /** Dev use only (writes every scope, no conflict check). The Board uses updateSettingsScope. */
  setSettings(s: StoredSettings): Promise<void>;
  /**
   * Writes one scope only (`<factoryId>` or `<factoryId>/<repoId>`), if its stored value (a factory scope merged over
   * the defaults, a missing repo scope undefined) still equals `before` as canonical JSON; otherwise throws
   * VersionConflictError. `after` null removes a repo scope.
   */
  updateSettingsScope(scope: string, before: unknown, after: Settings | RepoSettings | null): Promise<void>;
  startRun(r: { taskId: string; step: Step; mode: Mode; agent: string }): Promise<Run>;
  openRun(taskId: string, step: Step): Promise<Run | undefined>;
  finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }): Promise<void>;
  /** A task's runs, finished or not, by start time ascending. */
  listRuns(taskId: string): Promise<Run[]>;
  addEvents(e: FactoryEvent[]): Promise<void>;
  listEvents(taskId?: string): Promise<FactoryEvent[]>;
}

/**
 * updateTask for a caller that holds the task at `task.version`. A write that landed but could not be read back
 * (RereadAfterUpdateError) is exactly the held task plus the patch at version + 1: the version check proved the row
 * was the held task. So the caller still gets the task, and can write its events.
 */
export async function updateHeld(store: BoardStore, task: Task, patch: Partial<Task>): Promise<Task> {
  try {
    return await store.updateTask(task.taskId, task.version, patch);
  } catch (e) {
    if (e instanceof RereadAfterUpdateError) return { ...task, ...structuredClone(patch), version: task.version + 1 };
    throw e;
  }
}
