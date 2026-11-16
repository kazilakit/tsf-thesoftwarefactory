import { describe, expect, test } from 'vitest';
import { VersionConflictError } from '../src/boardStore.js';
import type { GitHubLink } from '../src/githubLink.js';
import { MemoryStore } from '../src/store.js';
import { FakeGitHubBoard, type GitHubBoard } from '../src/githubBoard.js';
import { FakeGitHub } from '../src/github.js';
import { GitHubPuller, type PullLock } from '../src/githubPuller.js';
import { GitHubPusher } from '../src/githubPusher.js';
import { issueBody } from '../src/githubPush.js';
import { defFixture, repoFixture } from './factoryFixtures.js';

const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
  plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
  pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as const;
const OPTIONS = ['Backlog', 'Todo', 'In progress', 'In review', 'Merged'];
const hub = (number = 3, statusMap: Record<string, string> = map) => ({ mode: 'github-only' as const, project: { owner: 'o', number }, label: 'factory', approvers: ['octo-user'], statusMap: statusMap as never });
const NOW = new Date('2026-06-01T00:00:00Z');
const REPO = { owner: 'o', repo: 'app' };
const PROJECT = { owner: 'o', number: 3 };

function setup(opts: { statusMap?: Record<string, string>; options?: string[]; github?: boolean; lock?: PullLock; board?: (b: FakeGitHubBoard) => GitHubBoard; wrap?: (st: MemoryStore) => MemoryStore } = {}) {
  const base = new MemoryStore({
    factories: {
      defs: [defFixture('f', opts.github === false ? {} : { github: hub(3, opts.statusMap) })],
      repos: [repoFixture('f', 'app', { remote: 'git@github.com:o/app.git' })],
    },
  });
  const store = opts.wrap ? opts.wrap(base) : base;
  const board = new FakeGitHubBoard();
  board.addProject(PROJECT, opts.options ?? OPTIONS);
  const gh = new FakeGitHub();
  const seen = opts.board ? opts.board(board) : board;
  const pusher = new GitHubPusher({ store: base, boardFor: () => board, now: () => NOW, claimant: 'x' });
  const puller = new GitHubPuller({ store, boardFor: () => seen, githubFor: () => gh, now: () => NOW, ...(opts.lock ? { lock: opts.lock } : {}) });
  return { store, board, gh, pusher, puller };
}
type S = ReturnType<typeof setup>;
const add = (s: S) => s.store.createTask({ factoryId: 'f', title: 'Do it', description: 'desc', repo: 'app' });
const project = async (s: S) => (await s.board.project(PROJECT))!;

describe('GitHubPuller', () => {
  test('a labelled Todo issue becomes a ready task with a link and no marker yet', async () => {
    const s = setup();
    const made = await s.board.createIssue(REPO, { title: 'From GitHub', body: 'please', labels: ['factory'] });
    const item = await s.board.addToProject(await project(s), made.nodeId);
    await s.board.setStatus(await project(s), item, 'Todo');
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    expect(r!.created).toHaveLength(1);
    const task = await s.store.getTask(r!.created[0]!.taskId);
    expect(task).toMatchObject({ status: 'ready', title: 'From GitHub' });
    const link = (await s.store.getGitHubLink(task.taskId))!;
    expect(link).toMatchObject({ repo: 'o/app', issueNumber: 1, project: 'o/3', itemId: item });
    expect(link.pushed).toMatchObject({ status: 'ready', option: 'Todo', title: 'From GitHub', bodyHash: null, label: 'factory' });
    await s.pusher.pushTask(task.taskId);
    expect(s.board.issue(REPO, 1).body).toContain(`tsf:task=${task.taskId}`);
  });

  test('/approve after the pushed spec comment records the approval and reacts', async () => {
    const s = setup();
    const t = await add(s);
    await s.store.addDoc(t.taskId, 'spec', 'the spec', 'agent');
    await s.store.updateTask(t.taskId, 1, { status: 'spec_review' });
    await s.pusher.pushTask(t.taskId);
    const c = await s.board.addComment(REPO, 1, '/approve', 'octo-user');
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    const approvals = await s.store.listApprovals(t.taskId);
    expect(approvals).toMatchObject([{ gate: 'spec', docVersion: 1, decision: 'approve' }]);
    expect(s.board.reactions).toEqual([{ commentId: c.id, content: '+1' }]);
  });

  test('a Status move not applied is put back by the next push', async () => {
    const s = setup();
    const t = await add(s);
    await s.store.updateTask(t.taskId, 1, { status: 'ready' });
    await s.pusher.pushTask(t.taskId);
    const item = (await s.board.listItems(await project(s)))[0]!;
    await s.board.setStatus(await project(s), item.itemId, 'In review');
    const [r] = await s.puller.pull();
    expect(r!.notApplied).toHaveLength(1);
    expect((await s.store.getGitHubLink(t.taskId))!.pushed.option).toBe('In review');
    await s.pusher.pushTask(t.taskId);
    expect((await s.board.listItems(await project(s)))[0]!.status).toBe('Todo');
  });

  test('PR approve review on pr_open records the pr approval', async () => {
    const s = setup();
    const t = await add(s);
    const pr = await s.gh.openPr({ remote: 'git@github.com:o/app.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await s.store.addDoc(t.taskId, 'review', 'the review', 'agent');
    await s.store.updateTask(t.taskId, 1, { status: 'pr_open', prUrl: pr.url });
    await s.pusher.pushTask(t.taskId);
    s.gh.addReview(pr.url, { author: 'octo-user', state: 'approved' });
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    expect(await s.store.listApprovals(t.taskId)).toMatchObject([{ gate: 'pr', docVersion: 1, decision: 'approve' }]);
    expect(s.board.reactions).toEqual([]);
  });

  test('a closed issue with a merged PR does not cancel', async () => {
    const s = setup();
    const t = await add(s);
    const pr = await s.gh.openPr({ remote: 'git@github.com:o/app.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await s.store.updateTask(t.taskId, 1, { status: 'pr_open', prUrl: pr.url });
    await s.pusher.pushTask(t.taskId);
    await s.board.closeIssue(REPO, 1, 'completed');
    s.gh.setState(pr.url, 'merged');
    const [r] = await s.puller.pull();
    expect(r!.applied).toEqual([]);
    expect((await s.store.getTask(t.taskId)).status).toBe('pr_open');
  });

  test('a missing project is one factory error, other factories still pull', async () => {
    const store = new MemoryStore({
      factories: {
        defs: [defFixture('f', { github: hub(3) }), defFixture('g', { github: hub(9) })],
        repos: [repoFixture('f', 'app', { remote: 'git@github.com:o/app.git' }), repoFixture('g', 'other', { remote: 'git@github.com:o/other.git' })],
      },
    });
    const board = new FakeGitHubBoard();
    board.addProject(PROJECT, OPTIONS);
    const p = await board.project(PROJECT);
    const made = await board.createIssue(REPO, { title: 'New', body: '', labels: ['factory'] });
    await board.addToProject(p!, made.nodeId);
    const puller = new GitHubPuller({ store, boardFor: () => board, githubFor: () => new FakeGitHub(), now: () => NOW });
    const out = await puller.pull();
    expect(out.map((r) => r.factoryId)).toEqual(['f', 'g']);
    expect(out[0]!.created).toHaveLength(1);
    expect(out[1]!.errors).toHaveLength(1);
    expect(out[1]!.errors[0]).toMatchObject({ taskId: null, message: expect.stringContaining('not found') });
  });

  test('a held pull lock skips the factory', async () => {
    let calls = 0;
    const s = setup({ lock: async () => null, board: (b) => new Proxy(b, { get(t, p, r) { calls++; const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v; } }) });
    const out = await s.puller.pull();
    expect(out).toMatchObject([{ factoryId: 'f', skipped: 'busy', created: [], errors: [] }]);
    expect(calls).toBe(0);
  });

  test('releases the lock even when the pull fails', async () => {
    let released = 0;
    const s = setup({ lock: async () => () => { released++; }, board: (b) => Object.assign(Object.create(b), { project: async () => { throw new Error('down'); } }) });
    const [r] = await s.puller.pull();
    expect(r!.errors).toMatchObject([{ taskId: null, message: 'down' }]);
    expect(released).toBe(1);
  });

  test('each created task has its link saved before the next create', async () => {
    const seenAtSecond: (GitHubLink | undefined)[] = [];
    let creates = 0;
    const s = setup({ wrap: (st) => new Proxy(st, { get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p !== 'createTask') return typeof v === 'function' ? v.bind(t) : v;
      return async (...a: unknown[]) => {
        if (++creates === 2) seenAtSecond.push(await t.getGitHubLink('T-1'));
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    } }) });
    for (const n of [1, 2]) {
      const made = await s.board.createIssue(REPO, { title: `New ${n}`, body: '', labels: ['factory'] });
      await s.board.addToProject(await project(s), made.nodeId);
    }
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    expect(r!.created.map((c) => c.taskId)).toEqual(['T-1', 'T-2']);
    expect(seenAtSecond).toMatchObject([{ taskId: 'T-1', issueNumber: 1 }]);
    expect(await s.store.getGitHubLink('T-2')).toMatchObject({ issueNumber: 2 });
  });

  test('the lock is touched after the GitHub reads and before anything is applied', async () => {
    const order: string[] = [];
    const lock: PullLock = async () => Object.assign(() => { order.push('release'); }, { touch: () => { order.push('touch'); return true; } });
    const s = setup({ lock, board: (b) => new Proxy(b, { get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => { if (p === 'listItems') order.push('read'); return v.apply(t, a); };
    } }) });
    const made = await s.board.createIssue(REPO, { title: 'New', body: '', labels: ['factory'] });
    await s.board.addToProject(await project(s), made.nodeId);
    const orig = s.store.createTask.bind(s.store);
    s.store.createTask = async (x) => { order.push('apply'); return orig(x); };
    const [r] = await s.puller.pull();
    expect(r!.created).toHaveLength(1);
    expect(order).toEqual(['read', 'touch', 'apply', 'release']);
  });

  test('a lock lost before applying stops the pull with an error and changes nothing', async () => {
    const lock: PullLock = async () => Object.assign(() => undefined, { touch: () => false });
    const s = setup({ lock });
    const made = await s.board.createIssue(REPO, { title: 'New', body: '', labels: ['factory'] });
    await s.board.addToProject(await project(s), made.nodeId);
    const [r] = await s.puller.pull();
    expect(r!.created).toEqual([]);
    expect(r!.errors).toMatchObject([{ taskId: null, message: 'pull lock taken over by another pull; nothing applied' }]);
    expect(await s.store.listTasks()).toEqual([]);
  });

  test('a PR review from before the task last moved to pr_open is not counted again', async () => {
    const s = setup();
    const t = await add(s);
    const pr = await s.gh.openPr({ remote: 'git@github.com:o/app.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await s.store.addDoc(t.taskId, 'review', 'review v1', 'agent');
    await s.store.updateTask(t.taskId, 1, { status: 'pr_open', prUrl: pr.url });
    await s.pusher.pushTask(t.taskId);
    const old = s.gh.addReview(pr.url, { author: 'octo-user', state: 'changes_requested', body: 'fix it' });
    // The task went back through build (no new commit) and review wrote doc v2, then returned to pr_open.
    await s.store.addDoc(t.taskId, 'review', 'review v2', 'agent');
    const moved = new Date(Date.parse(old.submittedAt!) + 1_000).toISOString();
    await s.store.addEvents([{ taskId: t.taskId, factoryId: 'f', actor: 'core', action: 'move', field: 'status', from: 'review', to: 'pr_open', reason: 'shipped', at: moved }]);
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    expect(r!.applied).toEqual([]);
    expect(await s.store.listApprovals(t.taskId)).toEqual([]);
  });

  test('an /answer moves pushed.blockedAt to that comment, so it is not read again if the task blocks again', async () => {
    const s = setup();
    const t = await add(s);
    await s.store.updateTask(t.taskId, 1, { status: 'blocked', stage: 'spec', blockedReason: 'need info', question: 'Which DB?' });
    await s.pusher.pushTask(t.taskId);
    const c = await s.board.addComment(REPO, 1, '/answer Postgres', 'octo-user');
    const [r] = await s.puller.pull();
    expect(r!.applied).toMatchObject([{ change: 'answered by octo-user' }]);
    expect((await s.store.getGitHubLink(t.taskId))!.pushed.blockedAt).toBe(c.createdAt);
  });

  test('factory without github is not pulled', async () => {
    const s = setup({ github: false });
    expect(await s.puller.pull()).toEqual([]);
  });
});

/** A ready task pushed to GitHub whose card was then moved, so the pull plans an `option` link patch. */
async function movedCard(s: S) {
  const t = await add(s);
  await s.store.updateTask(t.taskId, 1, { status: 'ready' });
  await s.pusher.pushTask(t.taskId);
  const item = (await s.board.listItems(await project(s)))[0]!;
  await s.board.setStatus(await project(s), item.itemId, 'In review');
  return t;
}
/** The store, but `saveGitHubLink` runs `before` and throws a conflict on its first `times` calls. */
const conflicting = (times: number, before: (inner: MemoryStore) => Promise<void> = async () => undefined) => (st: MemoryStore): MemoryStore => {
  let n = times;
  return new Proxy(st, { get(t, p, r) {
    const v = Reflect.get(t, p, r);
    if (typeof v !== 'function') return v;
    if (p !== 'saveGitHubLink') return v.bind(t);
    return async (...a: unknown[]) => {
      if (n-- > 0) { await before(t); throw new VersionConflictError('link', 1, 2); }
      return (v as (...x: unknown[]) => unknown).apply(t, a);
    };
  } });
};

describe('GitHubPuller link writes', () => {
  test('a conflict is retried once on a fresh read and keeps a concurrent change', async () => {
    let taskId = '';
    const s = setup({ wrap: conflicting(1, async (inner) => {
      const l = (await inner.getGitHubLink(taskId))!;
      await inner.saveGitHubLink(l, { ...l, pushed: { ...l.pushed, docAt: { spec: 'T1', plan: null } } });
    }) });
    taskId = (await movedCard(s)).taskId;
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    const l = (await s.store.getGitHubLink(taskId))!;
    expect(l.pushed.option).toBe('In review');
    expect(l.pushed.docAt.spec).toBe('T1');
  });

  test('a second conflict is an error for that task', async () => {
    const s = setup({ wrap: conflicting(2) });
    const t = await movedCard(s);
    const [r] = await s.puller.pull();
    expect(r!.errors).toMatchObject([{ taskId: t.taskId }]);
  });

  test('a link with a live lease gets no puller write', async () => {
    const s = setup();
    const t = await movedCard(s);
    const l = (await s.store.getGitHubLink(t.taskId))!;
    const leased = await s.store.saveGitHubLink(l, { ...l, lease: { by: 'x', until: new Date(NOW.getTime() + 60_000).toISOString() } });
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    expect(await s.store.getGitHubLink(t.taskId)).toEqual(leased);
  });

  test('a patch that changes nothing writes nothing', async () => {
    const s = setup();
    const t = await movedCard(s);
    await s.puller.pull();
    const after = (await s.store.getGitHubLink(t.taskId))!;
    await s.puller.pull();
    expect((await s.store.getGitHubLink(t.taskId))!.version).toBe(after.version);
  });

  test('an existing link for a new task is not overwritten', async () => {
    const stub = (id: string): GitHubLink => ({ taskId: id, factoryId: 'f', repo: 'o/app', issueNumber: null, issueNodeId: null, project: null, itemId: null,
      pushed: { status: null, option: null, title: null, bodyHash: null, label: null, docs: { spec: 0, plan: 0 }, blocked: null, closed: false, docAt: { spec: null, plan: null }, blockedAt: null },
      error: null, lease: null, reported: [], version: 1 });
    const s = setup({ wrap: (st) => new Proxy(st, { get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === 'getGitHubLink') return async (id: string) => stub(id);
      return typeof v === 'function' ? v.bind(t) : v;
    } }) });
    const made = await s.board.createIssue(REPO, { title: 'New', body: '', labels: ['factory'] });
    await s.board.addToProject(await project(s), made.nodeId);
    const [r] = await s.puller.pull();
    expect(r!.created).toHaveLength(1);
    expect(r!.errors).toMatchObject([{ taskId: r!.created[0]!.taskId }]);
  });

  test('a throwing lock is an error for that factory only', async () => {
    const s = setup({ lock: async () => { throw new Error('lock broke'); } });
    const [r] = await s.puller.pull();
    expect(r!.errors).toMatchObject([{ taskId: null, message: 'lock broke' }]);
  });
  describe('rebuild', () => {
    const marked = async (s: S, id: string, option: string, factory = 'f', title = `Title ${id}`) => {
      const made = await s.board.createIssue(REPO, { title, body: issueBody(`desc ${id}`, id, factory), labels: ['factory'] });
      const item = await s.board.addToProject(await project(s), made.nodeId);
      await s.board.setStatus(await project(s), item, option);
      return made.number;
    };

    test('rebuild restores marked issues', async () => {
      const s = setup();
      await marked(s, 'T-2', 'Todo');
      const n3 = await marked(s, 'T-3', 'In progress');
      await marked(s, 'T-5', 'In review');
      await marked(s, 'T-9', 'Todo', 'other');
      await s.board.addComment(REPO, n3, '## Spec v1\n\nS1', 'bot');
      await s.board.addComment(REPO, n3, '## Spec v2\n\nS2\n\n---\nReply `/approve` to approve, or `/changes <what to change>` to send it back.', 'bot');
      await s.board.addComment(REPO, n3, '## Plan v1\n\nP', 'bot');
      const [r] = await s.puller.rebuild();
      expect(r!.error).toBeNull();
      expect(r!.rebuilt.map((x) => [x.taskId, x.status])).toEqual([['T-2', 'ready'], ['T-3', 'blocked'], ['T-5', 'blocked']]);
      expect(await s.store.getTask('T-2')).toMatchObject({ status: 'ready', title: 'Title T-2', description: 'desc T-2', repo: 'app', stage: null, version: 1 });
      expect(await s.store.getTask('T-3')).toMatchObject({ status: 'blocked', blockedReason: 'rebuilt from GitHub, check status' });
      expect(await s.store.currentDoc('T-3', 'spec')).toMatchObject({ version: 1, body: 'S2', author: 'github · rebuilt' });
      expect(await s.store.currentDoc('T-3', 'plan')).toMatchObject({ body: 'P' });
      expect(await s.store.getTask('T-5')).toMatchObject({ status: 'blocked' });
      await expect(s.store.getTask('T-9')).rejects.toThrow();
      const link = (await s.store.getGitHubLink('T-3'))!;
      expect(link).toMatchObject({ repo: 'o/app', issueNumber: n3, project: 'o/3' });
      expect(link.pushed).toMatchObject({ status: 'blocked', option: 'In progress', docs: { spec: 1, plan: 1 }, blocked: null, closed: false });
      expect(link.pushed.docAt.spec).not.toBeNull();
      expect((await s.store.listEvents('T-3'))[0]).toMatchObject({ actor: 'github', action: 'create', reason: `rebuilt from GitHub issue o/app#${n3}` });
    });

    test('a duplicate marker is skipped', async () => {
      const s = setup();
      await marked(s, 'T-2', 'Todo');
      await marked(s, 'T-2', 'Todo');
      const [r] = await s.puller.rebuild();
      expect(r!.rebuilt).toHaveLength(1);
      expect(r!.skipped).toEqual([{ issue: 'o/app#2', reason: 'duplicate marker for T-2' }]);
    });

    test('rebuild spec_review with a spec comment is restored and accepts /approve', async () => {
      const statusMap = { ...map, spec_review: 'Spec review' };
      const s = setup({ statusMap, options: [...OPTIONS, 'Spec review'] });
      const n = await marked(s, 'T-4', 'Spec review');
      await s.board.addComment(REPO, n, '## Spec v1\n\nthe spec', 'bot');
      const [r] = await s.puller.rebuild();
      expect(r!.rebuilt).toMatchObject([{ taskId: 'T-4', status: 'spec_review' }]);
      await s.board.addComment(REPO, n, '/approve', 'octo-user');
      const [p] = await s.puller.pull();
      expect(p!.errors).toEqual([]);
      expect(await s.store.listApprovals('T-4')).toMatchObject([{ gate: 'spec', docVersion: 1, decision: 'approve' }]);
    });

    test('spec_review without a spec comment is blocked', async () => {
      const s = setup({ statusMap: { ...map, spec_review: 'Spec review' }, options: [...OPTIONS, 'Spec review'] });
      await marked(s, 'T-4', 'Spec review');
      const [r] = await s.puller.rebuild();
      expect(r!.rebuilt).toMatchObject([{ status: 'blocked' }]);
    });

    test('rebuild refuses a factory that has tasks', async () => {
      const s = setup();
      await add(s);
      await marked(s, 'T-2', 'Todo');
      const [r] = await s.puller.rebuild();
      expect(r!.error).toBe('the board already has tasks for factory f; --rebuild only fills an empty board');
      expect(r!.rebuilt).toEqual([]);
      expect(await s.store.listTasks()).toHaveLength(1);
    });

    test('after rebuild a push posts the blocked comment with /unblock and nothing else', async () => {
      const s = setup();
      const n = await marked(s, 'T-3', 'In progress');
      await s.board.addComment(REPO, n, '## Spec v1\n\nS1', 'bot');
      await s.puller.rebuild();
      await s.pusher.pushTask('T-3');
      const comments = await s.board.listComments(REPO, n);
      expect(comments).toHaveLength(2);
      expect(comments[1]!.body).toContain('/unblock');
    });
  });

  test('planFactory returns the plan without applying it', async () => {
    const s = setup();
    const made = await s.board.createIssue(REPO, { title: 'From GitHub', body: 'please', labels: ['factory'] });
    const item = await s.board.addToProject(await project(s), made.nodeId);
    await s.board.setStatus(await project(s), item, 'Todo');
    const def = (await s.store.listFactoryDefs())[0]!;
    const r = await s.puller.planFactory(def, await s.store.listFactoryDefs(), await s.store.listFactoryRepos());
    expect(r.errors).toEqual([]);
    expect(r.plan!.actions[0]!.kind).toBe('create');
    expect(await s.store.listTasks()).toEqual([]);
  });
});
