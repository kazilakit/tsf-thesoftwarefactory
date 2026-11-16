import { describe, expect, it } from 'vitest';
import { applyPull } from '../src/githubPullApply.js';
import { planPull, type PullAction, type PullInput, type PullPlan } from '../src/githubPull.js';
import { createTask } from '../src/owner.js';
import { MemoryStore, type BoardStore } from '../src/store.js';
import type { Task } from '../src/types.js';
import { defFixture, repoFixture } from './factoryFixtures.js';
import { emptyPushed } from '../src/githubLink.js';
import type { GitHubSettings } from '../src/githubConfig.js';
import type { ProjectItem } from '../src/githubBoard.js';
import { markerOf } from '../src/githubPush.js';

const NOW = '2026-11-15T10:00:00.000Z';
const now = () => new Date(NOW);
const issue = { repo: 'o/app', number: 7 };

const setup = async (patch: Partial<Task> = {}) => {
  const store = new MemoryStore({ factories: { defs: [defFixture('f')], repos: [repoFixture('f', 'app')] } });
  const t = await createTask(store, now, { factoryId: 'f', title: 'Title', description: 'Desc', repo: 'app' });
  const task = Object.keys(patch).length ? await store.updateTask(t.taskId, t.version, patch) : t;
  return { store, task };
};
const plan = (actions: PullAction[], notApplied: PullPlan['notApplied'] = []): PullPlan => ({ factoryId: 'f', actions, notApplied });
const events = async (s: BoardStore, id = 'T-1') => (await s.listEvents(id)).filter((e) => e.action !== 'create');

describe('applyPull', () => {
  it('create makes the task with a github create event', async () => {
    const { store } = await setup();
    const action: PullAction = {
      kind: 'create', issue: { repo: 'o/app', number: 9 }, nodeId: 'I', itemId: 'P', option: null, labelled: true, repoId: 'app', baseBranch: 'dev', title: 'New', description: 'd', status: 'ready',
    };
    const r = await applyPull(store, now, plan([action]));
    expect(r.created).toMatchObject([{ taskId: 'T-2', issue: 'o/app#9', status: 'ready' }]);
    expect((await store.listEvents('T-2'))[0]).toMatchObject({ actor: 'github', action: 'create', to: 'ready' });
  });

  it('onCreated runs right after each create, before the next action; a throw is an error for that task', async () => {
    const { store } = await setup();
    const mk = (number: number): PullAction => ({
      kind: 'create', issue: { repo: 'o/app', number }, nodeId: 'I', itemId: 'P', option: null, labelled: true, repoId: 'app', baseBranch: 'dev', title: `N${number}`, description: 'd', status: 'inbox',
    });
    const seen: string[] = [];
    const r = await applyPull(store, now, plan([mk(9), mk(10)]), { onCreated: async (c) => {
      seen.push(`${c.taskId}:${(await store.listTasks()).length}`);
      if (c.taskId === 'T-2') throw new Error('save failed\nmore');
    } });
    expect(seen).toEqual(['T-2:2', 'T-3:3']);
    expect(r.created.map((c) => c.taskId)).toEqual(['T-2', 'T-3']);
    expect(r.errors).toEqual([{ taskId: 'T-2', issue: 'o/app#9', message: 'save failed' }]);
  });

  it('a refused create is not applied, not an error', async () => {
    const { store } = await setup();
    const r = await applyPull(store, now, plan([{
      kind: 'create', issue: { repo: 'o/app', number: 9 }, nodeId: 'I', itemId: 'P', option: null, labelled: true, repoId: 'nope', baseBranch: 'dev', title: 'New', description: 'd', status: 'inbox',
    }]));
    expect(r.errors).toEqual([]);
    expect(r.created).toEqual([]);
    expect(r.notApplied).toMatchObject([{ taskId: null, issue: 'o/app#9', change: 'create' }]);
  });

  it('ready, edit, cancel apply with actor github', async () => {
    const { store, task } = await setup();
    const r = await applyPull(store, now, plan([
      { kind: 'edit', taskId: 'T-1', version: task.version, issue, title: 'T2', onApplied: { title: 'T2' } },
      { kind: 'ready', taskId: 'T-1', version: task.version, issue, onApplied: { status: 'ready' } },
      { kind: 'cancel', taskId: 'T-1', version: task.version, issue, why: 'issue closed' },
    ]));
    expect(r.applied.map((x) => x.change)).toEqual(['title/description edited', 'inbox -> ready', 'cancelled (issue closed)']);
    expect(r.applied[0]!.onApplied).toEqual({ title: 'T2' });
    expect((await store.getTask('T-1')).status).toBe('cancelled');
    const ev = await events(store);
    expect(new Set(ev.map((e) => e.actor))).toEqual(new Set(['github']));
    expect(ev.map((e) => e.reason)).toContain('marked ready on GitHub');
    expect(ev.map((e) => e.reason)).toContain('cancelled on GitHub (issue closed)');
    expect(ev.map((e) => e.reason)).toContain('edited on GitHub');
  });

  it('block moves a build task to blocked with reason label removed and clears the claim', async () => {
    const { store, task } = await setup({ status: 'build', stage: 'build', claimBy: 'c', claimUntil: NOW });
    const r = await applyPull(store, now, plan([{ kind: 'block', taskId: 'T-1', version: task.version, issue, reason: 'label removed' }]));
    expect(r.applied[0]!.change).toBe('blocked (label removed)');
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', blockedReason: 'label removed', claimBy: null, claimUntil: null, answer: null });
    expect(await events(store)).toContainEqual(expect.objectContaining({ actor: 'github', field: 'status', to: 'blocked' }));
  });

  const toSpecReview = async () => {
    const s = await setup({ status: 'spec_review', stage: 'spec' });
    await s.store.addDoc('T-1', 'spec', 'S', 'spec-writer');
    return { store: s.store, version: (await s.store.getTask('T-1')).version };
  };
  const decideAction = (version: number): PullAction => ({
    kind: 'decide', taskId: 'T-1', version, issue, gate: 'spec', decision: 'approve', docVersion: 1, comment: 'fine', approvalId: 'github:comment:5', by: 'octo-user', commentId: 5,
  });

  it('decide writes the approval with actor github · octo-user; the same approvalId twice stores one approval', async () => {
    const { store, version } = await toSpecReview();
    const r = await applyPull(store, now, plan([decideAction(version), decideAction(version)]));
    expect(r.applied.map((x) => [x.change, x.commentId])).toEqual([['spec approved by octo-user', 5], ['spec approved by octo-user', 5]]);
    expect(await store.listApprovals('T-1')).toHaveLength(1);
    expect((await events(store))[0]).toMatchObject({ actor: 'github · octo-user', field: 'approval', to: 'spec:approve@v1' });
  });

  it('a decide stores the comment exactly, so planning again yields no decide', async () => {
    const { store, version } = await toSpecReview();
    await applyPull(store, now, plan([decideAction(version)]));
    const t = await store.getTask('T-1');
    const approvals = await store.listApprovals('T-1');
    expect(approvals[0]!.comment).toBe('fine');
    const settings: GitHubSettings = {
      mode: 'github-only', project: { owner: 'o', number: 3 }, label: 'factory', approvers: ['octo-user'],
      statusMap: { inbox: 'B', ready: 'T', spec: 'P', spec_review: 'P', plan: 'P', plan_review: 'P', build: 'P', verify: 'P', review: 'P', pr_open: 'R', done: 'M', blocked: 'P', cancelled: 'B' },
    };
    const item: ProjectItem = {
      itemId: 'P', status: 'P',
      issue: { repo: { owner: 'o', repo: 'app' }, number: 7, nodeId: 'I', title: t.title, body: `${t.description}\n\n${markerOf('T-1', 'f')}`, state: 'open', stateReason: null, labels: ['factory'], updatedAt: NOW },
    };
    const pushed = { ...emptyPushed(), status: t.status, option: 'P', title: t.title, label: 'factory', docs: { spec: 1, plan: 0 }, docAt: { ...emptyPushed().docAt, spec: '2026-11-15T09:00:00Z' } };
    const input: PullInput = {
      factoryId: 'f', settings, repos: [], otherRepos: [], items: [item], unlinked: [],
      tasks: [{
        task: t, docs: { spec: 1 }, approvals,
        comments: [{ id: 5, author: 'octo-user', body: '/approve\n  fine \n', createdAt: '2026-11-15T09:30:00Z' }],
        link: { taskId: 'T-1', factoryId: 'f', repo: 'o/app', issueNumber: 7, issueNodeId: 'I', project: 'o/3', itemId: 'P', pushed, error: null, lease: null, reported: [], version: 1 },
      }],
    };
    expect(planPull(input).actions.filter((a) => a.kind === 'decide')).toEqual([]);
  });

  it('answer then unblock text', async () => {
    const { store, task } = await setup({ status: 'blocked', stage: 'build', question: 'why?' });
    const v = (await store.getTask('T-1')).version;
    const r = await applyPull(store, now, plan([{ kind: 'answer', taskId: 'T-1', version: v, issue, text: 'because', by: 'octo-user', unblock: false, commentId: 3, onApplied: {} }]));
    expect(r.applied[0]!.change).toBe('answered by octo-user');
    expect((await store.getTask('T-1')).answer).toBe('because');
    expect(await events(store)).toContainEqual(expect.objectContaining({ actor: 'github · octo-user', field: 'answer' }));
    const s2 = await setup({ status: 'blocked', stage: 'build' });
    const v2 = (await s2.store.getTask('T-1')).version;
    const r2 = await applyPull(s2.store, now, plan([{ kind: 'answer', taskId: 'T-1', version: v2, issue, text: 'unblocked by octo-user', by: 'octo-user', unblock: true, commentId: 4, onApplied: {} }]));
    expect(r2.applied[0]!.change).toBe('unblocked by octo-user');
    expect((await s2.store.getTask('T-1')).answer).toBe('unblocked by octo-user');
  });

  it('a stale version is not applied', async () => {
    const { store, task } = await setup();
    const r = await applyPull(store, now, plan([{ kind: 'ready', taskId: 'T-1', version: task.version - 1, issue, onApplied: {} }], [{ taskId: null, issue: 'o/x#1', change: 'c', reason: 'r' }]));
    expect(r.applied).toEqual([]);
    expect(r.notApplied).toEqual([
      { taskId: null, issue: 'o/x#1', change: 'c', reason: 'r' },
      { taskId: 'T-1', issue: 'o/app#7', change: 'ready', reason: 'task changed meanwhile' },
    ]);
    expect((await store.getTask('T-1')).status).toBe('inbox');
  });

  it('a refused owner action is not applied with its first line', async () => {
    const { store, task } = await setup();
    const r = await applyPull(store, now, plan([{ kind: 'answer', taskId: 'T-1', version: task.version, issue, text: 'x', by: 'a', unblock: false, commentId: 1, onApplied: {} }]));
    expect(r.notApplied[0]!.reason).toBe('T-1 is not blocked');
    expect(r.errors).toEqual([]);
  });

  it('two actions on one task: edit then ready both apply', async () => {
    const { store, task } = await setup();
    const r = await applyPull(store, now, plan([
      { kind: 'edit', taskId: 'T-1', version: task.version, issue, description: 'New', onApplied: {} },
      { kind: 'ready', taskId: 'T-1', version: task.version, issue, onApplied: {} },
    ]));
    expect(r.notApplied).toEqual([]);
    expect(r.applied).toHaveLength(2);
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', description: 'New' });
  });

  it('an unexpected store error is reported and the next action still runs', async () => {
    const { store, task } = await setup();
    const real = store.getTask.bind(store);
    let calls = 0;
    store.getTask = async (id: string) => {
      if (calls++ === 0) throw new Error('disk on fire\nmore');
      return real(id);
    };
    const r = await applyPull(store, now, plan([
      { kind: 'ready', taskId: 'T-1', version: task.version, issue, onApplied: {} },
      { kind: 'ready', taskId: 'T-1', version: task.version, issue, onApplied: {} },
    ]));
    expect(r.errors).toEqual([{ taskId: 'T-1', issue: 'o/app#7', message: 'disk on fire' }]);
    expect(r.applied).toHaveLength(1);
  });
});
