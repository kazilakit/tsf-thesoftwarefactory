import { describe, expect, it } from 'vitest';
import type { GitHubSettings } from '../src/githubConfig.js';
import { emptyPushed, type GitHubLink, type PushedState } from '../src/githubLink.js';
import { bodyHash, blockedKey, issueBody, issueText, markerIn, markerOf, planPush, projectKey, stripMarker, type PushInput } from '../src/githubPush.js';
import type { Doc, Status, Task } from '../src/types.js';

const statusMap: Record<Status, string> = {
  inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress', plan_review: 'In review',
  build: 'In progress', verify: 'In progress', review: 'In review', pr_open: 'In review', done: 'Done', blocked: 'Blocked', cancelled: 'Backlog',
};
const settings: GitHubSettings = { mode: 'github-only', project: { owner: 'o', number: 3 }, label: 'factory', approvers: ['a'], statusMap };
const task = (o: Partial<Task> = {}): Task => ({
  taskId: 'T-1', factoryId: 'f', title: 'Title', description: 'Desc', repo: 'r', baseBranch: 'main', status: 'inbox', stage: null, branch: null,
  prUrl: null, attempt: 0, blockedReason: null, question: null, answer: null, gateOverrides: {}, dependsOn: [], claimBy: null, claimUntil: null,
  costUsd: 0, version: 1, ...o,
} as Task);
const pushedFor = (t: Task, o: Partial<PushedState> = {}): PushedState => ({
  ...emptyPushed(), status: t.status, option: statusMap[t.status], title: t.title, bodyHash: bodyHash(t.description), label: 'factory', ...o,
});
const link = (pushed: PushedState, o: Partial<GitHubLink> = {}): GitHubLink => ({
  taskId: 'T-1', factoryId: 'f', repo: 'o/r', issueNumber: 7, issueNodeId: 'I', project: 'o/3', itemId: 'it', pushed, error: null, lease: null, reported: [], version: 1, ...o,
});
const doc = (kind: 'spec' | 'plan', version: number): Doc => ({ taskId: 'T-1', kind, version, body: 'Body', author: 'x', status: 'current' });
const input = (t: Task, l: GitHubLink | undefined, o: Partial<PushInput> = {}): PushInput =>
  ({ task: t, link: l, settings, docs: {}, gates: { spec: true, plan: true, pr: true }, ...o });
const kinds = (a: { kind: string }[]) => a.map((x) => x.kind);

describe('planPush', () => {
  it('a new inbox task: create, addToProject, setStatus Backlog', () => {
    const a = planPush(input(task(), undefined));
    expect(kinds(a)).toEqual(['create', 'addToProject', 'setStatus']);
    const c = a[0] as { body: string; labels: string[] };
    expect(c.body.endsWith('<!-- tsf:task=T-1 factory=f -->')).toBe(true);
    expect(c.labels).toEqual(['factory']);
    expect(a[2]).toEqual({ kind: 'setStatus', option: 'Backlog' });
  });
  it("label '' creates with no labels and never adds one", () => {
    const s = { ...settings, label: '' };
    const a = planPush({ ...input(task(), undefined), settings: s });
    expect((a[0] as { labels: string[] }).labels).toEqual([]);
    const t = task();
    expect(kinds(planPush({ ...input(t, link(pushedFor(t, { label: null }))), settings: s }))).toEqual([]);
  });
  it('blank description: body is the marker alone', () => {
    const a = planPush(input(task({ description: '  \n' }), undefined));
    expect((a[0] as { body: string }).body).toBe(markerOf('T-1', 'f'));
    expect(issueBody('hi  \n', 'T-1', 'f')).toBe('hi\n\n<!-- tsf:task=T-1 factory=f -->');
  });
  it('nothing changed: no actions', () => {
    const t = task();
    expect(planPush(input(t, link(pushedFor(t))))).toEqual([]);
  });
  it('status change maps through statusMap; spec and spec_review sharing an option push nothing', () => {
    const t = task({ status: 'spec' });
    const l = link(pushedFor(task(), {}));
    expect(planPush(input(t, l))).toEqual([{ kind: 'setStatus', option: 'In progress' }]);
    const t2 = task({ status: 'spec_review' });
    expect(planPush(input(t2, link(pushedFor(t, {}))))).toEqual([]);
  });
  it('edited statusMap re-pushes Status', () => {
    const t = task({ status: 'ready' });
    const s = { ...settings, statusMap: { ...statusMap, ready: 'Ready' } };
    expect(planPush({ ...input(t, link(pushedFor(t, { option: 'Todo' }))), settings: s })).toEqual([{ kind: 'setStatus', option: 'Ready' }]);
  });
  it('changed project re-adds the item and sets Status', () => {
    const t = task();
    expect(kinds(planPush(input(t, link(pushedFor(t), { project: 'o/2' }))))).toEqual(['addToProject', 'setStatus']);
    expect(projectKey({ owner: 'o', number: 3 })).toBe('o/3');
  });
  it('new label is added', () => {
    const t = task();
    expect(planPush(input(t, link(pushedFor(t, { label: 'old' }))))).toEqual([{ kind: 'addLabel', label: 'factory' }]);
  });
  it('title or description edit: updateIssue with marker kept', () => {
    const t = task();
    const l = link(pushedFor(t));
    const a = planPush(input(task({ title: 'New' }), l));
    expect(a).toEqual([{ kind: 'updateIssue', title: 'New', body: issueBody('Desc', 'T-1', 'f') }]);
    const b = planPush(input(task({ description: 'Other' }), l));
    expect((b[0] as { body: string }).body).toBe(issueBody('Other', 'T-1', 'f'));
  });
  it('spec v2 with gate on: one comment with heading and reply line', () => {
    const t = task();
    const a = planPush(input(t, link(pushedFor(t, { docs: { spec: 0, plan: 0 } })), { docs: { spec: doc('spec', 2) } }));
    expect(a).toHaveLength(1);
    const c = a[0] as { body: string; about: string; version: number };
    expect(c.body.startsWith('## Spec v2')).toBe(true);
    expect(c.body).toContain('/approve');
    expect([c.about, c.version]).toEqual(['spec', 2]);
  });
  it('spec comment without the reply line when the gate is off', () => {
    const t = task();
    const l = link(pushedFor(t));
    const off = planPush(input(t, l, { docs: { spec: doc('spec', 1) }, gates: { spec: false, plan: true, pr: true } }));
    expect((off[0] as { body: string }).body).not.toContain('/approve');
  });
  it('blocked with question: comment with /answer line; same block again: nothing', () => {
    const t = task({ status: 'blocked', blockedReason: 'why', question: 'what?' });
    const a = planPush(input(t, link(pushedFor(t, { status: 'build', option: 'In progress' }))));
    const c = a.find((x) => x.kind === 'comment') as { body: string; key: string };
    expect(c.body).toContain('**Blocked:** why');
    expect(c.body).toContain('**Question:** what?');
    expect(c.body).toContain('/answer');
    expect(c.key).toBe(blockedKey(t));
    expect(planPush(input(t, link(pushedFor(t, { blocked: blockedKey(t) }))))).toEqual([]);
  });
  it('cancelled: setStatus Backlog then close not_planned; done completed; already closed nothing', () => {
    const t = task({ status: 'cancelled' });
    const p = pushedFor(task({ status: 'build' }));
    expect(planPush(input(t, link(p)))).toEqual([{ kind: 'setStatus', option: 'Backlog' }, { kind: 'close', reason: 'not_planned' }]);
    const d = task({ status: 'done' });
    expect(planPush(input(d, link(pushedFor(task({ status: 'verify' }), { option: 'Done' }))))).toEqual([{ kind: 'close', reason: 'completed' }]);
    expect(planPush(input(d, link(pushedFor(d, { closed: true }))))).toEqual([]);
  });
  it('a done task never pushed: no actions', () => {
    expect(planPush(input(task({ status: 'done' }), undefined))).toEqual([]);
    expect(planPush(input(task({ status: 'cancelled' }), undefined))).toEqual([]);
  });
  it('bodyHash is stable sha256 hex', () => {
    expect(bodyHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('F1: a 70,000-char spec comment is capped with the truncation note', () => {
    const big: Doc = { ...doc('spec', 1), body: 'x'.repeat(70_000) };
    const a = planPush(input(task(), link(pushedFor(task())), { docs: { spec: big } }));
    const c = a.find((x) => x.kind === 'comment')! as { body: string };
    expect(c.body.length).toBeLessThanOrEqual(65_536);
    expect(c.body.endsWith('\n\n… (truncated; the full text is in tsf)') || c.body.includes('Reply `/approve`')).toBe(true);
    expect(c.body).toContain('(truncated; the full text is in tsf)');
  });

  it('F1: a 70,000-char description gives an issue body capped, ending with the marker', () => {
    const t = task({ description: 'y'.repeat(70_000) });
    const [create] = planPush(input(t, undefined)) as { body: string }[];
    expect(create!.body.length).toBeLessThanOrEqual(65_536);
    expect(create!.body.endsWith(markerOf('T-1', 'f'))).toBe(true);
    expect(create!.body).toContain('(truncated; the full text is in tsf)');
    const upd = planPush(input(t, link(pushedFor(task())))).find((x) => x.kind === 'updateIssue') as { body: string };
    expect(upd.body.length).toBeLessThanOrEqual(65_536);
    expect(upd.body.endsWith(markerOf('T-1', 'f'))).toBe(true);
  });

  it('F3: a closed task plans nothing even when project, label or statusMap changed', () => {
    const t = task({ status: 'done' });
    const l = link(pushedFor(t, { closed: true }));
    expect(planPush(input(t, l, { settings: { ...settings, project: { owner: 'o', number: 9 } } }))).toEqual([]);
    expect(planPush(input(t, l, { settings: { ...settings, label: 'new' } }))).toEqual([]);
    expect(planPush(input(t, l, { settings: { ...settings, statusMap: { ...statusMap, done: 'Shipped' } } }))).toEqual([]);
    expect(planPush(input({ ...t, title: 'Changed' }, l))).toEqual([]);
  });

  it('stripMarker normalises CRLF, drops the marker and trailing space', () => {
    expect(stripMarker('a\r\nb  \n\n<!-- tsf:task=T-1 factory=f -->\n')).toBe('a\nb');
  });
  it('markerIn finds the marker', () => {
    expect(markerIn('x\n\n<!-- tsf:task=T-1 factory=f -->')).toEqual({ taskId: 'T-1', factoryId: 'f' });
    expect(markerIn('no marker')).toBeNull();
  });
  it('issueBody is issueText plus the marker', () => {
    expect(issueBody('D\n', 'T-1', 'f')).toBe(`${issueText('D\n', 'T-1', 'f')}\n\n${markerOf('T-1', 'f')}`);
    expect(issueBody('', 'T-1', 'f')).toBe(markerOf('T-1', 'f'));
  });
  it('a description with trailing newline pushes nothing more once pushed', () => {
    const t = task({ description: 'D\n' });
    const l = link(pushedFor(t, { bodyHash: bodyHash(issueText('D\n', t.taskId, t.factoryId)) }));
    expect(planPush(input(t, l))).toEqual([]);
  });
  it('blocked comment is capped', () => {
    const t = task({ status: 'blocked', blockedReason: 'r'.repeat(70_000), question: 'q?' });
    const a = planPush(input(t, link(pushedFor(t, { status: 'build', option: 'In progress' }))));
    const c = a.find((x) => x.kind === 'comment') as { body: string };
    expect(c.body.length).toBeLessThanOrEqual(65_000);
    expect(c.body.endsWith('\n\nReply `/answer <text>` to answer, or `/unblock` to resume.')).toBe(true);
  });
  it('blocked without question asks for /unblock; with question for /answer or /unblock', () => {
    const p = (t: Task) => (planPush(input(t, link(pushedFor(t, { status: 'build', option: 'In progress' })))).find((x) => x.kind === 'comment') as { body: string }).body;
    expect(p(task({ status: 'blocked', blockedReason: 'why' })).endsWith('\n\nReply `/unblock` to resume.')).toBe(true);
    expect(p(task({ status: 'blocked', blockedReason: 'why', question: 'q?' })).endsWith('\n\nReply `/answer <text>` to answer, or `/unblock` to resume.')).toBe(true);
  });
});
