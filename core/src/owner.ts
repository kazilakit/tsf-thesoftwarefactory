import {
  canonicalJson as canon, ForbiddenError, OwnerOnlyError, parseScope, updateHeld, VersionConflictError, type BoardStore, type StoredSettings,
} from './boardStore.js';
import { GATE_DOC } from './gates.js';
import { diffEvents } from './history.js';
import { isMainRef } from './branches.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { createsCycle, normalizeDeps } from './dependencies.js';
import { isValidId, validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from './factories.js';
import { assertMove } from './status.js';
import {
  type Approval, type DocKind, type FactoryEvent, type Gate, type RepoId, type RepoSettings, type Settings, type Status, type Task,
} from './types.js';

// The owner's actions, used by `factory dev` and the GitHub pull. Pure (no Node API).

export type OwnerActionCode = 'not-waiting' | 'not-blocked' | 'not-editable' | 'invalid';

/** The owner may not do this now, or sent a value outside the rules. Nothing was written. */
export class OwnerActionError extends Error {
  constructor(readonly code: OwnerActionCode, message: string) {
    super(message);
    this.name = 'OwnerActionError';
  }
}

/** The owner decided on a doc version that is no longer the current one. Nothing was written. */
export class StaleDocError extends Error {
  constructor(readonly taskId: string, readonly kind: DocKind, readonly seenVersion: number, readonly currentVersion: number) {
    super(`${taskId} ${kind} is now v${currentVersion}, not v${seenVersion}`);
    this.name = 'StaleDocError';
  }
}

export const OWNER_ACTOR = 'you';
/** Who acted when it was not the owner on the Board (a GitHub user). `reason` replaces the default event reason. */
export interface OwnerBy { actor: string; reason?: string }
export const GITHUB_ACTOR = 'github';
export const githubActor = (login?: string): string => (login ? `github · ${login}` : GITHUB_ACTOR);
const GATES: readonly Gate[] = ['spec', 'plan', 'pr'];
/** The status a task waits in for each gate. */
export const GATE_STATUS: Readonly<Record<Gate, Status>> = { spec: 'spec_review', plan: 'plan_review', pr: 'pr_open' };
/** Later the core is working on the task, so its definition is fixed. */
export const EDITABLE_STATUSES: readonly Status[] = ['inbox', 'ready'];
const EDITABLE_FIELDS = ['title', 'description', 'repo', 'baseBranch', 'gateOverrides', 'dependsOn'] as const;
export type TaskEdit = Partial<Pick<Task, (typeof EDITABLE_FIELDS)[number]>>;
/** `<factoryId>` or `<factoryId>/<repoId>`. */
export type SettingsScope = string;
const SETTING_KEYS = ['maxParallel', 'maxTurnsPerStage', 'maxCostPerTaskUsd', 'paused', 'gates'] as const;
/** Inclusive ranges; maxParallel and maxTurnsPerStage are whole numbers. */
export const SETTING_RANGES = {
  maxParallel: { min: 1, max: 10, integer: true },
  maxTurnsPerStage: { min: 1, max: 500, integer: true },
  maxCostPerTaskUsd: { min: 0, max: 1000, integer: false },
} as const;

/** Every creator and the edit refuse `main` as a task base, in any form. */
const NEVER_MAIN = 'the factory never targets main';
const invalid = (message: string): never => {
  throw new OwnerActionError('invalid', message);
};
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isRepoId = (v: unknown): v is RepoId => isValidId(v);
const REPO_ID_RULE = 'lowercase letters, digits and hyphens, starting with a letter';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Drops undefined values: a key set to undefined is a key not sent. */
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const randomUUID = (): string => globalThis.crypto.randomUUID();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `inherit`: a gate may be null (a repo scope going back to the factory's switch). */
function checkGates(v: unknown, what: string, inherit = false): void {
  if (!isObject(v)) invalid(`${what} must be an object of gate switches`);
  for (const [gate, on] of Object.entries(v as object)) {
    if (!(GATES as readonly string[]).includes(gate)) invalid(`${what}: unknown gate ${gate}`);
    if (on === undefined || (inherit && on === null)) continue;
    if (typeof on !== 'boolean') invalid(`${what}.${gate} must be true or false`);
  }
}

/**
 * The events are built once by the caller; a retry sends the same rows. A refusal is final.
 */
async function writeEvents(store: BoardStore, events: FactoryEvent[]): Promise<void> {
  if (events.length === 0) return;
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.addEvents(events);
    } catch (e) {
      if (attempt >= 2 || e instanceof ForbiddenError || e instanceof OwnerOnlyError) throw e;
      await sleep(200 * 2 ** attempt);
    }
  }
}

/** One compare-and-set write with the owner's events. */
async function ownerUpdate(store: BoardStore, now: () => Date, task: Task, patch: Partial<Task>, reason: string, by?: OwnerBy): Promise<Task> {
  const at = now().toISOString();
  const updated = await updateHeld(store, task, patch);
  const actor = by?.actor ?? OWNER_ACTOR;
  const why = by?.reason ?? reason;
  const events = [...diffEvents(task, updated, actor, why, at), ...ownerFieldEvents(task, updated, why, at, actor)];
  await writeEvents(store, events);
  return updated;
}

/** diffEvents covers the core's fields; these are the owner's (title … gateOverrides). */
function ownerFieldEvents(before: Task, after: Task, reason: string, at: string, actor: string = OWNER_ACTOR): FactoryEvent[] {
  const text = (v: unknown) => (typeof v === 'string' ? v : canon(v));
  return EDITABLE_FIELDS.filter((f) => canon(before[f]) !== canon(after[f])).map((field) => ({
    taskId: after.taskId, factoryId: after.factoryId, actor, action: 'set' as const, field, from: text(before[field]), to: text(after[field]), reason, at,
  }));
}

async function requireFactory(store: BoardStore, factoryId: string): Promise<void> {
  if (!(await store.listFactoryDefs()).some((d) => d.factoryId === factoryId)) invalid(`factory ${factoryId} does not exist`);
}

/** The factory exists and has the repo. */
async function requireRepo(store: BoardStore, factoryId: string, repoId: string): Promise<void> {
  await requireFactory(store, factoryId);
  if (!(await store.listFactoryRepos(factoryId)).some((r) => r.repoId === repoId)) invalid(`repo ${repoId} is not in factory ${factoryId}`);
}

/**
 * Validates a dependency list and returns it normalized. Every id must be a stored task of `factoryId`. `taskId` is the
 * task being edited (null for a new one: nothing can depend on it yet, so no self or cycle check).
 * Ids in `stored` (the task's current list) skip the existence and factory checks: a missing task counts as finished, so
 * an edit may keep or drop one.
 */
async function checkDeps(store: BoardStore, factoryId: string, taskId: string | null, deps: unknown, stored: readonly string[] = []): Promise<string[]> {
  if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string')) return invalid('dependsOn must be a list of task ids');
  const ids = normalizeDeps(deps as string[]);
  const tasks = await store.listTasks();
  for (const id of ids) {
    if (id === taskId) invalid(`${id} cannot depend on itself`);
    if (stored.includes(id)) continue;
    const found = tasks.find((t) => t.taskId === id);
    if (!found) invalid(`dependency ${id} does not exist`);
    if (found!.factoryId !== factoryId) invalid(`dependency ${id} is not in factory ${factoryId}`);
  }
  // Two simultaneous edits can each pass this check and together close a cycle; with a single owner that is accepted.
  if (taskId !== null && createsCycle(taskId, ids, tasks)) {
    const closing = ids.find((id) => createsCycle(taskId, [id], tasks));
    invalid(`${closing ?? 'these dependencies'} would make a cycle`);
  }
  return ids;
}

/** The shared validation and insert-then-event of both creators; `actor` and `reason` name who made the task. */
async function insertTask(
  store: BoardStore, now: () => Date, input: { factoryId: string; title: string; description: string; repo: RepoId; baseBranch?: string; status?: 'inbox' | 'ready'; dependsOn?: string[] },
  actor: string, reason: string,
): Promise<Task> {
  if (!isValidId(input.factoryId)) invalid(`factoryId must be a factory id (${REPO_ID_RULE})`);
  if (!nonBlank(input.title)) invalid('title must not be blank');
  if (typeof input.description !== 'string') invalid('description must be text');
  if (!isRepoId(input.repo)) invalid(`repo must be a repo id (${REPO_ID_RULE})`);
  if (input.baseBranch !== undefined && !nonBlank(input.baseBranch)) invalid('base branch must not be blank');
  if (input.baseBranch !== undefined && isMainRef(input.baseBranch)) invalid(NEVER_MAIN);
  await requireFactory(store, input.factoryId);
  await requireRepo(store, input.factoryId, input.repo);
  const dependsOn = input.dependsOn === undefined ? undefined : await checkDeps(store, input.factoryId, null, input.dependsOn);
  const at = now().toISOString();
  const task = await store.createTask({
    factoryId: input.factoryId, title: input.title.trim(), description: input.description, repo: input.repo,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}), ...(input.status !== undefined ? { status: input.status } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
  });
  await writeEvents(store, [{ taskId: task.taskId, factoryId: task.factoryId, actor, action: 'create', field: null, from: null, to: task.status, reason, at }]);
  return task;
}

export async function createTask(
  store: BoardStore, now: () => Date, input: { factoryId: string; title: string; description: string; repo: RepoId; baseBranch?: string; dependsOn?: string[] },
): Promise<Task> {
  return insertTask(store, now, input, OWNER_ACTOR, 'created');
}

/** The pull creates a task from a GitHub issue (`o/r#n`); the base is never main. */
export function createTaskFromGitHub(
  store: BoardStore, now: () => Date,
  input: { factoryId: string; title: string; description: string; repo: RepoId; baseBranch: string; status: 'inbox' | 'ready' }, issue: string,
): Promise<Task> {
  return insertTask(store, now, input, GITHUB_ACTOR, `created from GitHub issue ${issue}`);
}

export const CORE_NEW_ACTOR = 'core · new';

/**
 * `factory new`: the one task the core may insert, run by the owner from their session. Starts in inbox unless `ready`;
 * the owner-only fields stay the owner's afterwards. The base is never main.
 */
export async function createTaskAsCore(
  store: BoardStore, now: () => Date, input: { factoryId: string; title: string; description: string; repo: RepoId; baseBranch?: string; ready?: boolean; dependsOn?: string[] },
): Promise<Task> {
  if (typeof input.baseBranch === 'string' && isMainRef(input.baseBranch)) invalid(NEVER_MAIN);
  const { ready, baseBranch, ...rest } = input;
  return insertTask(
    store, now, { ...rest, ...(typeof baseBranch === 'string' ? { baseBranch: baseBranch.trim() } : {}), status: ready ? 'ready' : 'inbox' },
    CORE_NEW_ACTOR, 'created by factory new',
  );
}

async function move(store: BoardStore, now: () => Date, taskId: string, to: Status, reason: string, by?: OwnerBy): Promise<Task> {
  const task = await store.getTask(taskId);
  assertMove(task.status, to, 'you');
  // Cancel is terminal: it frees the claim, so the slot is free and the old claimant's next call fails with ClaimError.
  return ownerUpdate(store, now, task, to === 'cancelled' ? { status: to, claimBy: null, claimUntil: null } : { status: to }, reason, by);
}

export function markReady(store: BoardStore, now: () => Date, taskId: string, by?: OwnerBy): Promise<Task> {
  return move(store, now, taskId, 'ready', 'marked ready', by);
}

export function cancelTask(store: BoardStore, now: () => Date, taskId: string, by?: OwnerBy): Promise<Task> {
  return move(store, now, taskId, 'cancelled', 'cancelled', by);
}

/**
 * The engine's sync resumes the task once it sees the answer. `seenVersion` is the task version the owner saw the
 * question at: if the task moved on since (another question, a restart), the answer is refused, not applied to it.
 */
export async function answerTask(store: BoardStore, now: () => Date, taskId: string, text: string, seenVersion: number, by?: OwnerBy): Promise<Task> {
  if (!nonBlank(text)) invalid('answer must not be blank');
  const task = await store.getTask(taskId);
  if (task.version !== seenVersion) throw new VersionConflictError(taskId, seenVersion, task.version);
  if (task.status !== 'blocked') throw new OwnerActionError('not-blocked', `${taskId} is not blocked`);
  return ownerUpdate(store, now, task, { answer: text }, 'answered', by);
}

/**
 * Records the owner's decision on the doc version they saw. It only records: the engine's sync applies it (moves the
 * task on, back for changes, or merges an approved PR when it may).
 */
export async function decideGate(
  store: BoardStore, now: () => Date, taskId: string, gate: Gate, decision: 'approve' | 'changes', seenDocVersion: number, comment: string,
  approvalId?: string, by?: OwnerBy,
): Promise<Approval> {
  if (!(GATES as readonly string[]).includes(gate)) invalid(`gate must be one of ${GATES.join(', ')}`);
  if (decision !== 'approve' && decision !== 'changes') invalid('decision must be approve or changes');
  if (!Number.isInteger(seenDocVersion) || seenDocVersion < 1) invalid('seen doc version must be a whole number from 1');
  if (typeof comment !== 'string') invalid('comment must be text');
  if (approvalId !== undefined && !nonBlank(approvalId)) invalid('approval id must not be blank');
  const task = await store.getTask(taskId);
  if (task.status !== GATE_STATUS[gate]) throw new OwnerActionError('not-waiting', `${taskId} is not waiting at the ${gate} gate`);
  const kind = GATE_DOC[gate];
  const doc = await store.currentDoc(taskId, kind);
  if (!doc) return invalid(`no current ${kind} doc for ${taskId}`);
  if (doc.version !== seenDocVersion) throw new StaleDocError(taskId, kind, seenDocVersion, doc.version);
  const reason = by?.reason ?? (comment.trim() || (decision === 'approve' ? 'approved' : 'changes requested'));
  const events: FactoryEvent[] = [{
    taskId, factoryId: task.factoryId, actor: by?.actor ?? OWNER_ACTOR, action: 'set', field: 'approval', from: null, to: `${gate}:${decision}@v${doc.version}`, reason, at: now().toISOString(),
  }];
  const approval = await store.addApproval({ approvalId: approvalId ?? randomUUID(), taskId, gate, docVersion: doc.version, decision, comment });
  await writeEvents(store, events);
  return approval;
}

/** Edits the task's definition while it is in the inbox or ready. A write since `expectedVersion` is a VersionConflictError. */
export async function editTask(store: BoardStore, now: () => Date, taskId: string, expectedVersion: number, patch: TaskEdit, by?: OwnerBy): Promise<Task> {
  if (!isObject(patch)) invalid('edit must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) invalid(`${key} cannot be edited`);
    if (value === undefined) continue;
    if (key === 'title' && !nonBlank(value)) invalid('title must not be blank');
    if (key === 'description' && typeof value !== 'string') invalid('description must be text');
    if (key === 'repo' && !isRepoId(value)) invalid(`repo must be a repo id (${REPO_ID_RULE})`);
    if (key === 'baseBranch' && !nonBlank(value)) invalid('base branch must not be blank');
    if (key === 'gateOverrides') checkGates(value, 'gateOverrides');
  }
  const clean: TaskEdit = defined(patch);
  if (clean.title !== undefined) clean.title = clean.title.trim();
  if (clean.gateOverrides) clean.gateOverrides = defined(clean.gateOverrides);
  const task = await store.getTask(taskId);
  if (!EDITABLE_STATUSES.includes(task.status)) {
    throw new OwnerActionError('not-editable', `${taskId} is ${task.status}; only inbox and ready tasks can be edited`);
  }
  if (task.version !== expectedVersion) throw new VersionConflictError(taskId, expectedVersion, task.version);
  if (clean.baseBranch !== undefined && clean.baseBranch !== task.baseBranch && isMainRef(clean.baseBranch)) invalid(NEVER_MAIN);
  if (clean.dependsOn !== undefined) clean.dependsOn = await checkDeps(store, task.factoryId, task.taskId, clean.dependsOn, task.dependsOn);
  if (!EDITABLE_FIELDS.some((f) => f in clean && canon(clean[f]) !== canon(task[f]))) return task;
  if (clean.repo !== undefined && clean.repo !== task.repo) await requireRepo(store, task.factoryId, clean.repo);
  return ownerUpdate(store, now, task, clean, 'edited', by);
}

/** A repo scope's patch: null (for a key, or for one gate) means inherit the factory's value. */
export type RepoSettingsPatch = { [K in Exclude<keyof Settings, 'gates'>]?: Settings[K] | null } & {
  gates?: Partial<Record<Gate, boolean | null>> | null;
};

/** The event text for a repo key that went back to the factory's value. */
export const INHERIT = 'inherit';

/**
 * Merges `patch` over a factory's settings or over one of its repos' overrides and writes one event per changed key.
 * A key left out (or undefined) is kept. In a repo scope, null removes the key (or the gate) so the factory's value
 * applies again; a gates object left empty is dropped. Returns the stored settings.
 */
export async function saveSettings(
  store: BoardStore, now: () => Date, scope: SettingsScope, patch: RepoSettingsPatch | RepoSettings | Settings,
): Promise<StoredSettings> {
  const { factoryId, repoId } = parseScope(String(scope));
  if (!isValidId(factoryId) || (repoId !== undefined && !isValidId(repoId))) {
    invalid(`scope must be a factory id or <factory id>/<repo id> (${REPO_ID_RULE})`);
  }
  const isFactory = repoId === undefined;
  if (!isObject(patch)) invalid('settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) invalid(`unknown setting ${key}`);
    if (value === undefined) continue;
    if (value === null) {
      if (isFactory) invalid(`${key} cannot inherit: factory settings have no parent`);
      continue;
    }
    if (key === 'paused' && typeof value !== 'boolean') invalid('paused must be true or false');
    if (key === 'gates') checkGates(value, 'gates', !isFactory);
    if (key in SETTING_RANGES) {
      const r = SETTING_RANGES[key as keyof typeof SETTING_RANGES];
      const ok = typeof value === 'number' && Number.isFinite(value) && value >= r.min && value <= r.max && (!r.integer || Number.isInteger(value));
      if (!ok) invalid(`${key} must be ${r.integer ? 'a whole number' : 'a number'} from ${r.min} to ${r.max}`);
    }
  }
  if (isFactory) await requireFactory(store, factoryId);
  else await requireRepo(store, factoryId, repoId);
  const stored = await store.getSettings();
  const entry = stored.factories[factoryId];
  const read = isFactory ? (entry?.factory ?? DEFAULT_SETTINGS) : entry?.repos[repoId];
  const current: RepoSettings = read ?? {};
  const next = mergeSettings(current, patch as RepoSettingsPatch);
  const changed = SETTING_KEYS.filter((k) => canon(current[k]) !== canon(next[k]));
  if (changed.length === 0) return stored;
  const at = now().toISOString();
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const events: FactoryEvent[] = changed.map((k) => ({
    taskId: '-', factoryId, actor: OWNER_ACTOR, action: 'set', field: `settings.${scope}.${k}`,
    from: json(current[k]), to: next[k] === undefined ? INHERIT : json(next[k]), reason: 'settings saved', at,
  }));
  const base = entry ?? { factory: DEFAULT_SETTINGS, repos: {} };
  const updated: StoredSettings = {
    factories: { ...stored.factories, [factoryId]: isFactory ? { ...base, factory: next as Settings } : { ...base, repos: { ...base.repos, [repoId]: next } } },
  };
  // Only this scope, and only if it is still what was read: a concurrent save is a VersionConflictError, not lost.
  await store.updateSettingsScope(scope, read, next);
  await writeEvents(store, events);
  return updated;
}

/**
 * Resets the settings of a repo that no longer exists (an orphaned `<factory>/<repo>` scope) so they are inherited from the
 * factory again: the scope is removed and one event per key says `inherit`. A repo that still exists goes through saveSettings.
 */
export async function resetRemovedRepoSettings(store: BoardStore, now: () => Date, factoryId: string, repoId: string): Promise<StoredSettings> {
  if (!isValidId(factoryId) || !isValidId(repoId)) invalid(`scope must be <factory id>/<repo id> (${REPO_ID_RULE})`);
  await requireFactory(store, factoryId);
  if ((await store.listFactoryRepos(factoryId)).some((r) => r.repoId === repoId)) invalid(`repo ${repoId} still exists in factory ${factoryId}; edit its settings instead`);
  const stored = await store.getSettings();
  const entry = stored.factories[factoryId];
  const read = entry?.repos[repoId];
  if (read === undefined) return stored;
  const scope = `${factoryId}/${repoId}`;
  const at = now().toISOString();
  const events: FactoryEvent[] = SETTING_KEYS.filter((k) => read[k] !== undefined).map((k) => ({
    taskId: '-', factoryId, actor: OWNER_ACTOR, action: 'set', field: `settings.${scope}.${k}`,
    from: JSON.stringify(read[k]), to: INHERIT, reason: 'settings of a removed repo reset', at,
  }));
  await store.updateSettingsScope(scope, read, null);
  await writeEvents(store, events);
  const { [repoId]: _gone, ...repos } = entry!.repos;
  return { factories: { ...stored.factories, [factoryId]: { ...entry!, repos } } };
}

/** A checked patch over `current`: undefined keeps, null removes, gates merge per gate. */
function mergeSettings(current: RepoSettings, patch: RepoSettingsPatch): RepoSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === 'gates') continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (patch.gates === null) delete next.gates;
  else if (patch.gates !== undefined) {
    const gates: Record<string, boolean> = { ...current.gates };
    for (const [gate, on] of Object.entries(patch.gates)) {
      if (on === null) delete gates[gate];
      else if (on !== undefined) gates[gate] = on;
    }
    if (Object.keys(gates).length > 0) next.gates = gates;
    else delete next.gates;
  }
  return next as RepoSettings;
}

const DEF_FIELDS = ['name', 'protectedBranches', 'gitName', 'gitEmail', 'docsPath', 'ghUser', 'active', 'agentModels'] as const;
const REPO_FIELDS = ['remote', 'baseBranch', 'checks'] as const;
const eventText = (v: unknown): string => (typeof v === 'string' ? v : canon(v));

/**
 * A field's value for history. A missing agentModels is `{}` (every stage uses the session's model),
 * so absent and empty compare equal and an event never says `undefined`.
 */
const fieldValue = <T extends object>(row: T, f: keyof T & string): unknown =>
  f === 'agentModels' ? (row[f] ?? {}) : row[f];

/** One event per field whose value differs (every field on an insert, from null, except an absent optional field). */
function fieldEvents<T extends object>(
  fields: readonly (keyof T & string)[], before: T | null, after: T, factoryId: string, name: (f: string) => string, reason: string, at: string,
): FactoryEvent[] {
  return fields
    .filter((f) => (before === null ? after[f] !== undefined : canon(fieldValue(before, f)) !== canon(fieldValue(after, f))))
    .map((f) => ({
      taskId: '-', factoryId, actor: OWNER_ACTOR, action: 'set' as const, field: name(f),
      from: before === null ? null : eventText(fieldValue(before, f)), to: eventText(fieldValue(after, f)), reason, at,
    }));
}

/**
 * Saves a factory definition (`before` null inserts) after validating it; `main` is added to the protected branches if
 * missing. Writes one `def.<field>` event per changed field, compared with the validated value. Returns the stored one.
 */
export async function saveFactory(store: BoardStore, now: () => Date, before: FactoryDef | null, after: FactoryDef): Promise<FactoryDef> {
  const checked = validateFactoryDef(after);
  if (!checked.ok) return invalid(checked.error);
  if (before !== null && before.factoryId !== after.factoryId) invalid('factoryId cannot be changed');
  // History is the stored row's, not the caller's `before` (same version, other content).
  const previous = before === null ? null : ((await store.listFactoryDefs()).find((d) => d.factoryId === before.factoryId) ?? null);
  const stored = await store.saveFactoryDef(before, checked.value);
  await writeEvents(store, fieldEvents(DEF_FIELDS, previous, stored, stored.factoryId, (f) => `def.${f}`, 'factory saved', now().toISOString()));
  return stored;
}

/** Saves a repo of an existing factory (`before` null inserts) after validating it. One `repo.<repoId>.<field>` event per changed field. */
export async function saveRepo(store: BoardStore, now: () => Date, before: FactoryRepo | null, after: FactoryRepo): Promise<FactoryRepo> {
  if (!isObject(after)) return invalid('repo must be an object');
  const def = (await store.listFactoryDefs()).find((d) => d.factoryId === after.factoryId);
  if (!def) return invalid(`factory ${String(after.factoryId)} does not exist`);
  const checked = validateFactoryRepo(after, def);
  if (!checked.ok) return invalid(checked.error);
  if (before !== null && (before.factoryId !== after.factoryId || before.repoId !== after.repoId)) invalid('factoryId and repoId cannot be changed');
  const previous = before === null
    ? null
    : ((await store.listFactoryRepos(before.factoryId)).find((r) => r.repoId === before.repoId) ?? null);
  const stored = await store.saveFactoryRepo(before, checked.value);
  await writeEvents(store, fieldEvents(REPO_FIELDS, previous, stored, stored.factoryId, (f) => `repo.${stored.repoId}.${f}`, 'repo saved', now().toISOString()));
  return stored;
}
