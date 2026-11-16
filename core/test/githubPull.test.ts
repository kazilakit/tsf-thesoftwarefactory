import { describe, expect, it } from 'vitest';
import type { PrReview } from '../src/github.js';
import type { IssueComment, ProjectItem } from '../src/githubBoard.js';
import type { GitHubSettings } from '../src/githubConfig.js';
import { emptyPushed, type GitHubLink, type PushedState } from '../src/githubLink.js';
import { parseCommand, planPull, pullNeeds, type PullInput, type PullTaskView } from '../src/githubPull.js';
import { blockedKey, bodyHash, issueText, markerOf } from '../src/githubPush.js';
import type { Approval, Status, Task } from '../src/types.js';

const statusMap: Record<Status, string> = {
  inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress', plan_review: 'In progress',
  build: 'In progress', verify: 'In progress', review: 'In progress', pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog',
};
const settings: GitHubSettings = { mode: 'github-only', project: { owner: 'o', number: 3 }, label: 'factory', approvers: ['octo-user'], statusMap };
const T0 = '2026-11-15T10:00:00Z';
const later = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

const task = (o: Partial<Task> = {}): Task => ({
  taskId: 'T-1', factoryId: 'f', title: 'Title', description: 'Desc', repo: 'app', baseBranch: 'dev', status: 'inbox', stage: null, branch: null,
  prUrl: null, attempt: 0, blockedReason: null, question: null, answer: null, gateOverrides: {}, dependsOn: [], claimBy: null, claimUntil: null,
  costUsd: 0, version: 4, ...o,
} as Task);
const pushedFor = (t: Task, o: Partial<PushedState> = {}): PushedState => ({
  ...emptyPushed(), status: t.status, option: statusMap[t.status], title: t.title, bodyHash: bodyHash(issueText(t.description, t.taskId, t.factoryId)),
  label: 'factory', ...o,
});
const link = (pushed: PushedState, o: Partial<GitHubLink> = {}): GitHubLink => ({
  taskId: 'T-1', factoryId: 'f', repo: 'o/app', issueNumber: 7, issueNodeId: 'I_7', project: 'o/3', itemId: 'PVTI_7', pushed, error: null, lease: null,
  reported: [], version: 1, ...o,
});
const view = (t: Task, o: Partial<PullTaskView> & { pushed?: Partial<PushedState> } = {}): PullTaskView => {
  const { pushed, ...rest } = o;
  return { task: t, link: link(pushedFor(t, pushed)), docs: {}, approvals: [], ...rest };
};
const item = (o: { number?: number; status?: string | null; title?: string; body?: string; labels?: string[]; state?: 'open' | 'closed'; repo?: string } = {}): ProjectItem => {
  const [owner, repo] = (o.repo ?? 'o/app').split('/') as [string, string];
  const n = o.number ?? 7;
  return {
    itemId: `PVTI_${n}`, status: o.status === undefined ? 'Backlog' : o.status,
    issue: {
      repo: { owner, repo }, number: n, nodeId: `I_${n}`, title: o.title ?? 'Title', body: o.body ?? `Desc\n\n${markerOf('T-1', 'f')}`,
      state: o.state ?? 'open', stateReason: null, labels: o.labels ?? ['factory'], updatedAt: T0,
    },
  };
};
const input = (o: Partial<PullInput> = {}): PullInput => ({
  factoryId: 'f', settings, repos: [{ repoId: 'app', slug: 'o/app', baseBranch: 'dev' }], otherRepos: [], items: [], tasks: [], unlinked: [], ...o,
});
const comment = (id: number, body: string, min: number, author = 'octo-user'): IssueComment => ({ id, author, body, createdAt: later(min) });
const review = (o: Partial<PrReview> = {}): PrReview => ({
  id: 1, author: 'octo-user', state: 'approved', body: 'LGTM', submittedAt: later(1), commitId: 'head', ...o,
});
const newIssue = (o: Parameters<typeof item>[0] = {}) => item({ number: 4, title: '  New thing ', body: 'Do it\r\n', ...o });

describe('parseCommand', () => {
  it('parseCommand reads the first line command', () => {
    expect(parseCommand('/approve')).toEqual({ cmd: 'approve', text: '' });
    expect(parseCommand('/changes  fix X\nand Y')).toEqual({ cmd: 'changes', text: 'fix X\nand Y' });
    expect(parseCommand('/APPROVE')).toEqual({ cmd: 'approve', text: '' });
    expect(parseCommand('\n  \n/unblock\r\nok')).toEqual({ cmd: 'unblock', text: 'ok' });
    expect(parseCommand('/answer use Postgres')).toEqual({ cmd: 'answer', text: 'use Postgres' });
    expect(parseCommand('please /approve')).toBeNull();
    expect(parseCommand('/approved')).toBeNull();
    expect(parseCommand('/answer')).toBeNull();
  });
});

describe('planPull: new issues', () => {
  it('new labelled issue in Todo becomes a ready task', () => {
    const plan = planPull(input({ items: [newIssue({ status: 'Todo' })] }));
    expect(plan).toEqual({
      factoryId: 'f', notApplied: [],
      actions: [{
        kind: 'create', issue: { repo: 'o/app', number: 4 }, nodeId: 'I_4', itemId: 'PVTI_4', option: 'Todo', labelled: true,
        repoId: 'app', baseBranch: 'dev', title: 'New thing', description: 'Do it', status: 'ready',
      }],
    });
  });
  it('new labelled issue in Backlog becomes inbox', () => {
    const plan = planPull(input({ items: [newIssue({ status: 'Backlog' }), newIssue({ number: 2, status: null })] }));
    expect(plan.actions.map((a) => [a.issue.number, (a as { status: string }).status])).toEqual([[2, 'inbox'], [4, 'inbox']]);
  });
  it("an issue without the label is skipped; with label '' it is created", () => {
    expect(planPull(input({ items: [newIssue({ labels: [] })] }))).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
    const plan = planPull(input({ settings: { ...settings, label: '' }, items: [newIssue({ labels: [] })] }));
    expect(plan.actions).toMatchObject([{ kind: 'create', labelled: false }]);
  });
  it('a closed new issue is skipped', () => {
    expect(planPull(input({ items: [newIssue({ state: 'closed' })] })).actions).toEqual([]);
  });
  it("new issue in a repo of no factory is not applied; in another factory's repo it is ignored", () => {
    const plan = planPull(input({ otherRepos: ['o/other'], items: [newIssue({ repo: 'o/x' }), newIssue({ repo: 'O/Other' })] }));
    expect(plan.actions).toEqual([]);
    expect(plan.notApplied).toEqual([{ taskId: null, issue: 'o/x#4', change: 'new issue', reason: "repo o/x is not one of factory f's repos" }]);
  });
  it('issue with the marker of a missing task asks for --rebuild', () => {
    const plan = planPull(input({ items: [newIssue({ body: `x\n\n${markerOf('T-9', 'f')}` })] }));
    expect(plan.actions).toEqual([]);
    expect(plan.notApplied).toEqual([{
      taskId: null, issue: 'o/app#4', change: 'issue has the marker of T-9, which is not on the board', reason: 'run factory sync --rebuild',
    }]);
  });
  it('marker of an unlinked task is left to the pusher; marker of another factory is ignored', () => {
    expect(planPull(input({ unlinked: ['T-9'], items: [newIssue({ body: `x\n\n${markerOf('T-9', 'f')}` })] }))).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
    expect(planPull(input({ items: [newIssue({ body: `x\n\n${markerOf('T-9', 'g')}` })] }))).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
  });
});

describe('planPull: Status', () => {
  it('card moved Backlog to Todo marks the inbox task ready', () => {
    const plan = planPull(input({ tasks: [view(task())], items: [item({ status: 'Todo' })] }));
    expect(plan).toEqual({
      factoryId: 'f', notApplied: [],
      actions: [{ kind: 'ready', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, onApplied: { status: 'ready', option: 'Todo' } }],
    });
  });
  it('card moved while tsf moved too is not applied', () => {
    const plan = planPull(input({ tasks: [view(task(), { pushed: { status: 'blocked' } })], items: [item({ status: 'Todo' })] }));
    expect(plan.actions).toEqual([]);
    expect(plan.notApplied).toEqual([{ taskId: 'T-1', issue: 'o/app#7', change: 'Status Todo', reason: 'changed in tsf too' }]);
  });
  it('any other Status move is not applied and resets the option', () => {
    const t = task({ status: 'build', stage: 'build' });
    const plan = planPull(input({ tasks: [view(t)], items: [item({ status: 'Todo' })] }));
    expect(plan.actions).toEqual([]);
    expect(plan.notApplied).toEqual([{
      taskId: 'T-1', issue: 'o/app#7', change: 'Status Todo', reason: 'the factory sets this Status; it goes back to In progress', link: { option: 'Todo' },
    }]);
  });
  it('a Status equal to the map is no change', () => {
    const t = task({ status: 'spec', stage: 'spec' });
    const plan = planPull(input({ tasks: [view(t, { pushed: { option: 'Todo', status: 'ready' } })], items: [item({ status: 'In progress' })] }));
    expect(plan).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
    expect(planPull(input({ tasks: [view(task())], items: [item({ status: null })] }))).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
  });
});

describe('planPull: close and label', () => {
  it('closed issue cancels', () => {
    const plan = planPull(input({ tasks: [view(task({ status: 'build' }))], items: [item({ state: 'closed', status: 'Todo', title: 'Other' })] }));
    expect(plan).toEqual({
      factoryId: 'f', notApplied: [],
      actions: [{ kind: 'cancel', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, why: 'issue closed' }],
    });
  });
  it('a closed issue whose PR merged is left to the engine', () => {
    const t = task({ status: 'pr_open', prUrl: 'https://github.com/o/app/pull/9' });
    const plan = planPull(input({ tasks: [view(t, { prState: 'merged' })], items: [item({ state: 'closed', status: 'In review' })] }));
    expect(plan).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
  });
  it('a merged PR on a task at stage ship is left to the engine', () => {
    const t = task({ status: 'blocked', stage: 'ship', prUrl: 'https://github.com/o/app/pull/9' });
    const plan = planPull(input({ tasks: [view(t, { prState: 'merged' })], items: [item({ state: 'closed', status: 'In progress' })] }));
    expect(plan).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
  });
  it('a merged PR on a task that is not pr_open and not at ship is not applied, with the task status', () => {
    const t = task({ status: 'build', stage: 'build', prUrl: 'https://github.com/o/app/pull/9' });
    const plan = planPull(input({ tasks: [view(t, { prState: 'merged' })], items: [item({ state: 'closed', status: 'In progress' })] }));
    expect(plan).toEqual({
      factoryId: 'f', actions: [], notApplied: [{ taskId: 'T-1', issue: 'o/app#7', change: 'issue closed', reason: 'PR merged but task is build' }],
    });
  });
  it('a closed issue whose PR state is unknown is not cancelled', () => {
    const t = task({ status: 'pr_open', prUrl: 'https://github.com/o/app/pull/9' });
    const plan = planPull(input({ tasks: [view(t)], items: [item({ state: 'closed', status: 'In review' })] }));
    expect(plan).toEqual({
      factoryId: 'f', actions: [], notApplied: [{ taskId: 'T-1', issue: 'o/app#7', change: 'issue closed', reason: 'PR state unknown' }],
    });
  });
  it('a closed issue the factory closed and a done task are no change', () => {
    const done = task({ status: 'done' });
    expect(planPull(input({ tasks: [view(done)], items: [item({ state: 'closed', status: 'Todo' })] })).actions).toEqual([]);
  });
  it('label removed: inbox cancels, build blocks, blocked stays', () => {
    const cancel = planPull(input({ tasks: [view(task())], items: [item({ labels: [] })] }));
    expect(cancel.actions).toEqual([{ kind: 'cancel', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, why: 'label removed' }]);
    const build = task({ status: 'build', stage: 'build' });
    const block = planPull(input({ tasks: [view(build)], items: [item({ labels: [], status: 'Todo' })] }));
    expect(block).toEqual({
      factoryId: 'f', notApplied: [],
      actions: [{ kind: 'block', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, reason: 'label removed' }],
    });
    const blocked = task({ status: 'blocked', blockedReason: 'label removed' });
    expect(planPull(input({ tasks: [view(blocked)], items: [item({ labels: [], status: 'Todo' })] }))).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
  });
  it('a label never pushed is not a removal', () => {
    const plan = planPull(input({ tasks: [view(task(), { pushed: { label: null } })], items: [item({ labels: [] })] }));
    expect(plan.actions).toEqual([]);
  });
});

describe('planPull: title and body', () => {
  it('title edited in inbox becomes an edit', () => {
    const plan = planPull(input({ tasks: [view(task())], items: [item({ title: ' New title ' })] }));
    expect(plan.actions).toEqual([{
      kind: 'edit', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, title: 'New title',
      onApplied: { title: 'New title', bodyHash: bodyHash('Desc') },
    }]);
  });
  it('edit and ready together: edit comes first', () => {
    const plan = planPull(input({ tasks: [view(task())], items: [item({ status: 'Todo', body: `New desc\n\n${markerOf('T-1', 'f')}` })] }));
    expect(plan.actions.map((a) => a.kind)).toEqual(['edit', 'ready']);
    expect(plan.actions[0]).toMatchObject({ description: 'New desc' });
    expect(plan.actions[0]).not.toHaveProperty('title');
  });
  it('edited in both tsf and GitHub is not applied', () => {
    const plan = planPull(input({ tasks: [view(task({ title: 'tsf title' }), { pushed: { title: 'Title' } })], items: [item({ title: 'gh title' })] }));
    expect(plan.actions).toEqual([]);
    expect(plan.notApplied).toEqual([{ taskId: 'T-1', issue: 'o/app#7', change: 'title/body', reason: 'changed in tsf too' }]);
  });
  it('edited after ready is reported once', () => {
    const t = task({ status: 'build', stage: 'build' });
    const it = item({ title: 'Changed', status: 'In progress' });
    const key = 'edit:' + bodyHash('Changed\nDesc');
    const first = planPull(input({ tasks: [view(t)], items: [it] }));
    expect(first.actions).toEqual([]);
    expect(first.notApplied).toEqual([{ taskId: 'T-1', issue: 'o/app#7', change: 'title/body', reason: 'edited after ready; not applied', link: { report: key } }]);
    const second = planPull(input({ tasks: [{ ...view(t), link: { ...view(t).link, reported: [key] } }], items: [it] }));
    expect(second).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
  });
  it('CRLF and trailing space are not an edit', () => {
    const plan = planPull(input({ tasks: [view(task({ description: 'D' }))], items: [item({ body: `D\r\n\r\n${markerOf('T-1', 'f')}\r\n` })] }));
    expect(plan).toEqual({ factoryId: 'f', actions: [], notApplied: [] });
  });
  it('edit whose body lost the marker clears bodyHash on apply', () => {
    const plan = planPull(input({ tasks: [view(task())], items: [item({ body: 'Rewritten' })] }));
    expect(plan.actions).toEqual([{
      kind: 'edit', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, description: 'Rewritten', onApplied: { title: 'Title', bodyHash: null },
    }]);
  });
});

describe('planPull: commands', () => {
  const specTask = task({ status: 'spec_review', stage: 'spec' });
  const atSpec = (comments: IssueComment[], o: Partial<PullTaskView> = {}): PullTaskView =>
    view(specTask, { docs: { spec: 2 }, pushed: { docs: { spec: 2, plan: 0 }, docAt: { spec: T0, plan: null } }, comments, ...o });
  const run = (v: PullTaskView) => planPull(input({ tasks: [v], items: [item({ status: 'In progress' })] }));

  it('/approve after the spec comment by an approver decides', () => {
    expect(run(atSpec([comment(11, '/approve', 1, 'Octo-User')])).actions).toEqual([{
      kind: 'decide', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, gate: 'spec', decision: 'approve', docVersion: 2,
      comment: '', approvalId: 'github:comment:11', by: 'Octo-User', commentId: 11,
    }]);
  });
  it('by a non-approver, or before docAt, is ignored', () => {
    expect(run(atSpec([comment(11, '/approve', 1, 'someone'), comment(12, '/approve', -1), comment(13, '/approve', 0)])).actions).toEqual([]);
  });
  it('the first command wins', () => {
    const a = run(atSpec([comment(12, '/changes later', 3), comment(11, 'looks good\n/approve', 1), comment(10, '/approve', 2)])).actions;
    expect(a).toMatchObject([{ kind: 'decide', decision: 'approve', commentId: 10 }]);
  });
  it('/changes text becomes the comment', () => {
    const a = run(atSpec([comment(11, '/changes  use the v2 API\nnot v1', 1)])).actions;
    expect(a).toMatchObject([{ kind: 'decide', gate: 'spec', decision: 'changes', comment: 'use the v2 API\nnot v1' }]);
  });
  it('commands are not read when the current spec is not pushed yet', () => {
    const v = atSpec([comment(11, '/approve', 1)], { docs: { spec: 2 } });
    v.link.pushed.docs = { spec: 1, plan: 0 };
    expect(pullNeeds(input({ tasks: [v], items: [item({ status: 'In progress' })] })).comments).toEqual([]);
    expect(run(v).actions).toEqual([]);
    const ok = atSpec([]);
    expect(pullNeeds(input({ tasks: [ok], items: [item({ status: 'In progress' })] })).comments).toEqual([{ taskId: 'T-1', since: T0 }]);
  });
  it('/answer on a blocked task answers; /unblock with no text answers "unblocked by octo-user"', () => {
    const b = task({ status: 'blocked', stage: 'spec', blockedReason: 'need info', question: 'Which DB?' });
    const blockedView = (comments: IssueComment[]) => view(b, { pushed: { blocked: blockedKey(b), blockedAt: T0 }, comments });
    const runB = (comments: IssueComment[]) => planPull(input({ tasks: [blockedView(comments)], items: [item({ status: 'In progress' })] })).actions;
    expect(pullNeeds(input({ tasks: [blockedView([])], items: [item({ status: 'In progress' })] })).comments).toEqual([{ taskId: 'T-1', since: T0 }]);
    expect(runB([comment(5, '/approve', 1), comment(6, '/answer Postgres', 2)])).toEqual([{
      kind: 'answer', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, text: 'Postgres', by: 'octo-user', unblock: false, commentId: 6,
      onApplied: { blockedAt: later(2) },
    }]);
    expect(runB([comment(7, '/unblock', 1)])).toMatchObject([{ kind: 'answer', text: 'unblocked by octo-user', unblock: true, commentId: 7 }]);
    expect(runB([comment(7, '/unblock go on', 1)])).toMatchObject([{ kind: 'answer', text: 'go on', unblock: true }]);
  });
  it('a decision already recorded is not planned again', () => {
    const approvals: Approval[] = [{ taskId: 'T-1', gate: 'spec', docVersion: 2, decision: 'approve', comment: '', at: T0 }];
    expect(run(atSpec([comment(11, '/approve', 1)], { approvals })).actions).toEqual([]);
  });
});

describe('planPull: PR reviews', () => {
  const pr = task({ status: 'pr_open', stage: 'review', prUrl: 'https://github.com/o/app/pull/9' });
  const runR = (reviews: PrReview[], docs: PullTaskView['docs'] = { review: 3 }) =>
    planPull(input({ tasks: [view(pr, { docs, reviews: { headSha: 'head', reviews } })], items: [item({ status: 'In review' })] }));

  it('PR approved on the head commit decides pr approve; a review on an old commit is ignored; changes_requested decides changes', () => {
    expect(pullNeeds(input({ tasks: [view(pr)], items: [item({ status: 'In review' })] })).reviews).toEqual([{ taskId: 'T-1', prUrl: pr.prUrl }]);
    expect(runR([review({ id: 21 })]).actions).toEqual([{
      kind: 'decide', taskId: 'T-1', version: 4, issue: { repo: 'o/app', number: 7 }, gate: 'pr', decision: 'approve', docVersion: 3,
      comment: 'LGTM', approvalId: 'github:review:21', by: 'octo-user', commentId: null,
    }]);
    expect(runR([review({ commitId: 'old' }), review({ author: 'other', submittedAt: later(5) }), review({ state: 'commented', submittedAt: later(6) })]).actions).toEqual([]);
    const latest = runR([review({ id: 21, submittedAt: later(1) }), review({ id: 22, state: 'changes_requested', body: 'fix it', submittedAt: later(2) })]);
    expect(latest.actions).toMatchObject([{ kind: 'decide', gate: 'pr', decision: 'changes', comment: 'fix it', approvalId: 'github:review:22' }]);
  });
  it('a review submitted before the task last moved to pr_open is not counted; one after it is', () => {
    const runAt = (reviews: PrReview[], prOpenAt: string) =>
      planPull(input({ tasks: [view(pr, { docs: { review: 2 }, prOpenAt, reviews: { headSha: 'head', reviews } })], items: [item({ status: 'In review' })] }));
    const old = review({ id: 21, state: 'changes_requested', submittedAt: later(1) });
    expect(runAt([old], later(5)).actions).toEqual([]);
    expect(runAt([old, review({ id: 22, submittedAt: later(6) })], later(5)).actions).toMatchObject([
      { kind: 'decide', gate: 'pr', decision: 'approve', docVersion: 2, approvalId: 'github:review:22' },
    ]);
    expect(runAt([review({ id: 23, submittedAt: null })], later(5)).actions).toEqual([]);
  });
  it('a review with no review doc is not applied', () => {
    expect(runR([review()], {}).notApplied).toEqual([{ taskId: 'T-1', issue: 'o/app#7', change: 'PR review', reason: 'no review doc to decide on' }]);
  });
  it('the PR state is needed when the issue closed and the factory did not close it', () => {
    const v = view(pr);
    expect(pullNeeds(input({ tasks: [v], items: [item({ state: 'closed', status: 'In review' })] })).prStates).toEqual([{ taskId: 'T-1', prUrl: pr.prUrl }]);
    expect(pullNeeds(input({ tasks: [v], items: [item({ status: 'In review' })] })).prStates).toEqual([]);
  });
});
