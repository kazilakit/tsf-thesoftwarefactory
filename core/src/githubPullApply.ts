import { VersionConflictError, updateHeld, type BoardStore } from './boardStore.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { resolveGates, resolveSettings } from './gates.js';
import { diffEvents } from './history.js';
import { issueName, type NotApplied, type PullAction, type PullPlan } from './githubPull.js';
import type { PushedState } from './githubLink.js';
import { IllegalInputError, decide } from './machine.js';
import { answerTask, cancelTask, createTaskFromGitHub, decideGate, editTask, githubActor, markReady, OwnerActionError, StaleDocError, type OwnerBy } from './owner.js';
import { assertMove, IllegalMoveError } from './status.js';
import type { Task } from './types.js';

// Pure applier (no Node API, no credential): runs a PullPlan through the owner functions, with a version check per action.

export interface PullApplied { taskId: string; issue: string; change: string; commentId: number | null; onApplied?: Partial<PushedState> }
export interface PullCreated { taskId: string; issue: string; status: 'inbox' | 'ready'; action: Extract<PullAction, { kind: 'create' }> }
export interface PullError { taskId: string | null; issue: string | null; message: string }
export interface ApplyResult { created: PullCreated[]; applied: PullApplied[]; notApplied: NotApplied[]; errors: PullError[] }
/** `onCreated` runs right after each create (the core saves the new task's link there); a throw is an error for that task. */
export interface ApplyHooks {
  onCreated?: (created: PullCreated) => Promise<void>;
  /** Runs before action `index`; a throw stops the apply and is thrown to the caller. */
  beforeAction?: (index: number) => Promise<void>;
}

type Linked = Exclude<PullAction, { kind: 'create' }>;
type Done = { task: Task; change: string };

// doctor.ts's redactSecrets needs Node (secrets.ts), so this pure module keeps its own copy of the token rule.
const TOKEN = /\b(?:gh[opsur]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g;
export const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.replace(TOKEN, '[redacted]');
const refused = (e: unknown): boolean =>
  e instanceof VersionConflictError || e instanceof StaleDocError || e instanceof OwnerActionError || e instanceof IllegalMoveError || e instanceof IllegalInputError;
const GITHUB: OwnerBy = { actor: 'github' };
const gateName = (a: Extract<Linked, { kind: 'decide' }>): string => (a.gate === 'pr' ? 'PR' : a.gate);

/** The core `block` move: the label was removed, so the task stops with that reason and frees its claim. */
async function block(store: BoardStore, now: () => Date, task: Task, reason: string): Promise<Task> {
  const stored = (await store.getSettings()).factories[task.factoryId];
  const settings = resolveSettings(stored?.factory ?? DEFAULT_SETTINGS, stored?.repos[task.repo]);
  const d = decide(task, { kind: 'limit', reason }, resolveGates(settings, task.gateOverrides));
  assertMove(task.status, d.status, 'core');
  const at = now().toISOString();
  const updated = await updateHeld(store, task, { ...d.patch, status: d.status, stage: d.stage, answer: null, claimBy: null, claimUntil: null });
  await store.addEvents(diffEvents(task, updated, 'github', d.reason, at));
  return updated;
}

async function run(store: BoardStore, now: () => Date, task: Task, a: Linked): Promise<Done> {
  const id = a.taskId;
  switch (a.kind) {
    case 'ready':
      return { task: await markReady(store, now, id, { ...GITHUB, reason: 'marked ready on GitHub' }), change: 'inbox -> ready' };
    case 'edit': {
      const patch = { ...(a.title !== undefined ? { title: a.title } : {}), ...(a.description !== undefined ? { description: a.description } : {}) };
      return { task: await editTask(store, now, id, task.version, patch, { ...GITHUB, reason: 'edited on GitHub' }), change: 'title/description edited' };
    }
    case 'cancel':
      return { task: await cancelTask(store, now, id, { ...GITHUB, reason: `cancelled on GitHub (${a.why})` }), change: `cancelled (${a.why})` };
    case 'block':
      return { task: await block(store, now, task, a.reason), change: 'blocked (label removed)' };
    case 'decide': {
      await decideGate(store, now, id, a.gate, a.decision, a.docVersion, a.comment, a.approvalId, { actor: githubActor(a.by) });
      return { task, change: `${gateName(a)} ${a.decision === 'approve' ? 'approved' : 'changes requested'} by ${a.by}` };
    }
    case 'answer':
      return { task: await answerTask(store, now, id, a.text, task.version, { actor: githubActor(a.by) }), change: `${a.unblock ? 'unblocked' : 'answered'} by ${a.by}` };
  }
}

/** Applies the plan's actions in order; a refused action is "not applied", any other error is reported and the run goes on. */
export async function applyPull(store: BoardStore, now: () => Date, plan: PullPlan, hooks: ApplyHooks = {}): Promise<ApplyResult> {
  const out: ApplyResult = { created: [], applied: [], notApplied: [...plan.notApplied], errors: [] };
  /** The version each task has after this plan's earlier actions. */
  const versions = new Map<string, number>();
  for (const [index, a] of plan.actions.entries()) {
    await hooks.beforeAction?.(index);
    const issue = issueName(a.issue);
    if (a.kind === 'create') {
      let created: PullCreated;
      try {
        const t = await createTaskFromGitHub(
          store, now, { factoryId: plan.factoryId, title: a.title, description: a.description, repo: a.repoId, baseBranch: a.baseBranch, status: a.status }, issue,
        );
        created = { taskId: t.taskId, issue, status: a.status, action: a };
        out.created.push(created);
      } catch (e) {
        if (refused(e)) out.notApplied.push({ taskId: null, issue, change: 'create', reason: firstLine(e) });
        else out.errors.push({ taskId: null, issue, message: firstLine(e) });
        continue;
      }
      try { await hooks.onCreated?.(created); } catch (e) { out.errors.push({ taskId: created.taskId, issue, message: firstLine(e) }); }
      continue;
    }
    const na = (reason: string, change = a.kind): void => void out.notApplied.push({ taskId: a.taskId, issue, change, reason });
    try {
      const task = await store.getTask(a.taskId);
      if (task.version !== (versions.get(a.taskId) ?? a.version)) {
        na('task changed meanwhile');
        continue;
      }
      const done = await run(store, now, task, a);
      versions.set(a.taskId, done.task.version);
      out.applied.push({
        taskId: a.taskId, issue, change: done.change, commentId: 'commentId' in a ? a.commentId : null, ...('onApplied' in a ? { onApplied: a.onApplied } : {}),
      });
    } catch (e) {
      if (refused(e)) na(firstLine(e));
      else out.errors.push({ taskId: a.taskId, issue, message: firstLine(e) });
    }
  }
  return out;
}
