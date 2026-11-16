import { sameApproval } from './boardStore.js';
import type { PrReview, PrState } from './github.js';
import type { IssueComment, ProjectItem } from './githubBoard.js';
import type { GitHubSettings } from './githubConfig.js';
import type { GitHubLink, PushedState } from './githubLink.js';
import { blockedKey, bodyHash, issueText, markerIn, stripMarker } from './githubPush.js';
import type { Approval, Gate, Task } from './types.js';

// Pure planner (no Node API, no credential): what was read from GitHub, as owner actions and "not applied" items.

export interface IssueRef { repo: string; number: number }
export const issueName = (r: IssueRef): string => `${r.repo}#${r.number}`;

export type PullCommand = { cmd: 'approve' | 'changes' | 'answer' | 'unblock'; text: string };

const COMMAND_RE = /^\/(approve|changes|answer|unblock)(?=\s|$)/i;

/** The command on the first non-blank line, with the rest of the comment as its text; null when there is none. */
export function parseCommand(body: string): PullCommand | null {
  const text = body.replace(/\r\n/g, '\n').replace(/^\s+/, '');
  const m = COMMAND_RE.exec(text);
  if (!m) return null;
  const cmd = m[1]!.toLowerCase() as PullCommand['cmd'];
  const rest = text.slice(m[0].length).trim();
  return cmd === 'answer' && rest === '' ? null : { cmd, text: rest };
}

export interface PullTaskView {
  task: Task; link: GitHubLink; docs: { spec?: number; plan?: number; review?: number }; approvals: Approval[];
  comments?: IssueComment[]; reviews?: { headSha: string; reviews: PrReview[] }; prState?: PrState;
  /** When the task last moved to pr_open (its latest move event): only reviews submitted after it count. */
  prOpenAt?: string;
}

export interface PullInput {
  factoryId: string; settings: GitHubSettings;
  /** This factory's repos; slug "owner/repo". */
  repos: { repoId: string; slug: string; baseBranch: string }[];
  /** Slugs owned by other factories. */
  otherRepos: string[];
  items: ProjectItem[];
  /** This factory's tasks that have a link. */
  tasks: PullTaskView[];
  /** Ids of this factory's tasks without a link. */
  unlinked: string[];
}

export type PullAction =
  | { kind: 'create'; issue: IssueRef; nodeId: string; itemId: string; option: string | null; labelled: boolean;
      repoId: string; baseBranch: string; title: string; description: string; status: 'inbox' | 'ready' }
  | { kind: 'ready'; taskId: string; version: number; issue: IssueRef; onApplied: Partial<PushedState> }
  | { kind: 'edit'; taskId: string; version: number; issue: IssueRef; title?: string; description?: string; onApplied: Partial<PushedState> }
  | { kind: 'cancel'; taskId: string; version: number; issue: IssueRef; why: 'issue closed' | 'label removed' }
  | { kind: 'block'; taskId: string; version: number; issue: IssueRef; reason: 'label removed' }
  | { kind: 'decide'; taskId: string; version: number; issue: IssueRef; gate: Gate; decision: 'approve' | 'changes';
      docVersion: number; comment: string; approvalId: string; by: string; commentId: number | null }
  | { kind: 'answer'; taskId: string; version: number; issue: IssueRef; text: string; by: string; unblock: boolean; commentId: number; onApplied: Partial<PushedState> };

export interface NotApplied { taskId: string | null; issue: string; change: string; reason: string; link?: { option?: string; report?: string } }
export interface PullPlan { factoryId: string; actions: PullAction[]; notApplied: NotApplied[] }
export interface PullNeeds {
  comments: { taskId: string; since: string }[]; reviews: { taskId: string; prUrl: string }[]; prStates: { taskId: string; prUrl: string }[];
}

const lower = (s: string): string => s.toLowerCase();
const slugOf = (it: ProjectItem): string => `${it.issue.repo.owner}/${it.issue.repo.repo}`;
const refOf = (it: ProjectItem): IssueRef => ({ repo: slugOf(it), number: it.issue.number });
const closedTask = (t: Task): boolean => t.status === 'done' || t.status === 'cancelled';
const hasLabel = (it: ProjectItem, label: string): boolean => it.issue.labels.some((l) => lower(l) === lower(label));
const isApprover = (s: GitHubSettings, login: string): boolean => s.approvers.some((a) => lower(a) === lower(login));
const matches = (v: PullTaskView, it: ProjectItem): boolean =>
  lower(v.link.repo) === lower(slugOf(it)) && v.link.issueNumber === it.issue.number;
const itemOf = (i: PullInput, v: PullTaskView): ProjectItem | undefined => i.items.find((it) => matches(v, it));

/** Where to read commands for a task: the gate it waits at, or its block, with the time of the comment that asked. */
function commandTarget(i: PullInput, v: PullTaskView): { gate: 'spec' | 'plan' | null; since: string } | null {
  const { task, link: { pushed: p } } = v;
  const kind = task.status === 'spec_review' ? 'spec' : task.status === 'plan_review' ? 'plan' : null;
  if (kind) {
    const at = p.docAt[kind];
    return p.docs[kind] === v.docs[kind] && at ? { gate: kind, since: at } : null;
  }
  if (task.status === 'blocked' && task.answer === null && p.blocked === blockedKey(task) && p.blockedAt) return { gate: null, since: p.blockedAt };
  return null;
}

/** What else to read from GitHub before planning: comments, PR reviews and PR states. */
export function pullNeeds(i: PullInput): PullNeeds {
  const out: PullNeeds = { comments: [], reviews: [], prStates: [] };
  for (const v of i.tasks) {
    const it = itemOf(i, v);
    const { task } = v;
    if (!it || closedTask(task)) continue;
    const target = commandTarget(i, v);
    if (target) out.comments.push({ taskId: task.taskId, since: target.since });
    if (task.status === 'pr_open' && task.prUrl) out.reviews.push({ taskId: task.taskId, prUrl: task.prUrl });
    if (task.prUrl && it.issue.state === 'closed' && !v.link.pushed.closed) out.prStates.push({ taskId: task.taskId, prUrl: task.prUrl });
  }
  return out;
}

type Out = { actions: PullAction[]; notApplied: NotApplied[] };

function planUnlinked(i: PullInput, it: ProjectItem, out: Out): void {
  const slug = slugOf(it);
  if (it.issue.state === 'closed' || i.otherRepos.some((r) => lower(r) === lower(slug))) return;
  const marker = markerIn(it.issue.body);
  if (marker && marker.factoryId !== i.factoryId) return;
  if (marker) {
    if (i.unlinked.includes(marker.taskId) || i.tasks.some((v) => v.task.taskId === marker.taskId)) return;
    out.notApplied.push({
      taskId: null, issue: issueName(refOf(it)), change: `issue has the marker of ${marker.taskId}, which is not on the board`, reason: 'run factory sync --rebuild',
    });
    return;
  }
  const { label, statusMap } = i.settings;
  if (label !== '' && !hasLabel(it, label)) return;
  const repo = i.repos.find((r) => lower(r.slug) === lower(slug));
  if (!repo) {
    out.notApplied.push({ taskId: null, issue: issueName(refOf(it)), change: 'new issue', reason: `repo ${slug} is not one of factory ${i.factoryId}'s repos` });
    return;
  }
  out.actions.push({
    kind: 'create', issue: refOf(it), nodeId: it.issue.nodeId, itemId: it.itemId, option: it.status, labelled: label !== '' && hasLabel(it, label),
    repoId: repo.repoId, baseBranch: repo.baseBranch, title: it.issue.title.trim(), description: stripMarker(it.issue.body),
    status: it.status === statusMap.ready ? 'ready' : 'inbox',
  });
}

/** Rules 1 and 2: a close or a label removal, which end the task's planning when they fire. */
function closeOrLabel(i: PullInput, v: PullTaskView, it: ProjectItem, base: { taskId: string; version: number; issue: IssueRef }, out: Out): PullAction | 'skip' | null {
  const { task, link: { pushed: p } } = v;
  const { label } = i.settings;
  if (it.issue.state === 'closed' && !p.closed) {
    if (v.prState === 'merged') {
      // The engine finishes a merged PR only from pr_open or the ship step; anywhere else say so instead of waiting forever.
      if (task.status !== 'pr_open' && task.stage !== 'ship') {
        out.notApplied.push({ taskId: task.taskId, issue: issueName(base.issue), change: 'issue closed', reason: `PR merged but task is ${task.status}` });
      }
      return 'skip';
    }
    // A PR whose state could not be read may have merged and closed the issue (Closes #n): never cancel then.
    if (task.prUrl && v.prState === undefined) {
      out.notApplied.push({ taskId: task.taskId, issue: issueName(base.issue), change: 'issue closed', reason: 'PR state unknown' });
      return 'skip';
    }
    return { kind: 'cancel', ...base, why: 'issue closed' };
  }
  if (label !== '' && !hasLabel(it, label) && p.label === label) {
    if (task.status === 'inbox' || task.status === 'ready') return { kind: 'cancel', ...base, why: 'label removed' };
    return task.status === 'blocked' ? 'skip' : { kind: 'block', ...base, reason: 'label removed' };
  }
  return null;
}

/** Rule 3: a Status move on the card. */
function statusMove(i: PullInput, v: PullTaskView, it: ProjectItem, base: { taskId: string; version: number; issue: IssueRef }, out: Out): PullAction | null {
  const { task, link: { pushed: p } } = v;
  const map = i.settings.statusMap;
  const obs = it.status;
  if (obs === null || obs === map[task.status] || obs === p.option) return null;
  const na = { taskId: task.taskId, issue: issueName(base.issue), change: `Status ${obs}` };
  if (obs === map.ready && task.status === 'inbox') {
    if (p.status !== 'inbox') out.notApplied.push({ ...na, reason: 'changed in tsf too' });
    else if (p.option === map.inbox) return { kind: 'ready', ...base, onApplied: { status: 'ready', option: obs } };
    else out.notApplied.push({ ...na, reason: `the factory sets this Status; it goes back to ${map[task.status]}`, link: { option: obs } });
    return null;
  }
  out.notApplied.push({ ...na, reason: `the factory sets this Status; it goes back to ${map[task.status]}`, link: { option: obs } });
  return null;
}

/** Rule 4: the issue's title or body edited on GitHub. */
function titleBody(v: PullTaskView, it: ProjectItem, base: { taskId: string; version: number; issue: IssueRef }, out: Out): PullAction | null {
  const { task, link } = v;
  const p = link.pushed;
  const t = it.issue.title.trim();
  const d = stripMarker(it.issue.body);
  const text = issueText(task.description, task.taskId, task.factoryId);
  const inSync = t === task.title && d === text;
  const ghChanged = t !== p.title || bodyHash(d) !== p.bodyHash;
  if (inSync || !ghChanged) return null;
  const tsfChanged = task.title !== p.title || bodyHash(text) !== p.bodyHash;
  const na = { taskId: task.taskId, issue: issueName(base.issue), change: 'title/body' };
  if (task.status === 'inbox' || task.status === 'ready') {
    if (tsfChanged) {
      out.notApplied.push({ ...na, reason: 'changed in tsf too' });
      return null;
    }
    return {
      kind: 'edit', ...base, ...(t !== task.title ? { title: t } : {}), ...(d !== text ? { description: d } : {}),
      onApplied: { title: t, bodyHash: markerIn(it.issue.body) ? bodyHash(d) : null },
    };
  }
  const key = 'edit:' + bodyHash(t + '\n' + d);
  if (!link.reported.includes(key)) out.notApplied.push({ ...na, reason: 'edited after ready; not applied', link: { report: key } });
  return null;
}

/** Rule 5: the first `/approve`, `/changes`, `/answer` or `/unblock` from an approver after the comment that asked. */
function commands(i: PullInput, v: PullTaskView, base: { taskId: string; version: number; issue: IssueRef }): PullAction | null {
  const target = commandTarget(i, v);
  if (!target || !v.comments) return null;
  const since = Date.parse(target.since);
  const valid = v.comments
    .filter((c) => Date.parse(c.createdAt) > since && isApprover(i.settings, c.author))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  for (const c of valid) {
    const cmd = parseCommand(c.body);
    if (!cmd) continue;
    if (target.gate && (cmd.cmd === 'approve' || cmd.cmd === 'changes')) {
      const docVersion = v.docs[target.gate];
      if (docVersion === undefined) return null;
      return {
        kind: 'decide', ...base, gate: target.gate, decision: cmd.cmd, docVersion, comment: cmd.text,
        approvalId: `github:comment:${c.id}`, by: c.author, commentId: c.id,
      };
    }
    if (!target.gate && (cmd.cmd === 'answer' || cmd.cmd === 'unblock')) {
      const text = cmd.cmd === 'unblock' && cmd.text === '' ? `unblocked by ${c.author}` : cmd.text;
      // Later commands are read only after this one, so it is not replayed if the task blocks again with the same key.
      return { kind: 'answer', ...base, text, by: c.author, unblock: cmd.cmd === 'unblock', commentId: c.id, onApplied: { blockedAt: c.createdAt } };
    }
  }
  return null;
}

/** Rule 6: the latest approver review on the PR's head commit, submitted after the task last moved to pr_open. */
function prReview(i: PullInput, v: PullTaskView, base: { taskId: string; version: number; issue: IssueRef }, out: Out): PullAction | null {
  if (v.task.status !== 'pr_open' || !v.reviews) return null;
  const { headSha, reviews } = v.reviews;
  const since = v.prOpenAt === undefined ? null : Date.parse(v.prOpenAt);
  const fresh = (r: PrReview): boolean => since === null || (r.submittedAt !== null && Date.parse(r.submittedAt) > since);
  const latest = reviews
    .filter((r) => isApprover(i.settings, r.author) && (r.state === 'approved' || r.state === 'changes_requested') && r.commitId === headSha && fresh(r))
    .sort((a, b) => Date.parse(b.submittedAt ?? '') - Date.parse(a.submittedAt ?? '') || b.id - a.id)[0];
  if (!latest) return null;
  if (v.docs.review === undefined) {
    out.notApplied.push({ taskId: v.task.taskId, issue: issueName(base.issue), change: 'PR review', reason: 'no review doc to decide on' });
    return null;
  }
  return {
    kind: 'decide', ...base, gate: 'pr', decision: latest.state === 'approved' ? 'approve' : 'changes', docVersion: v.docs.review,
    comment: latest.body, approvalId: `github:review:${latest.id}`, by: latest.author, commentId: null,
  };
}

const recorded = (v: PullTaskView, a: PullAction): boolean =>
  a.kind === 'decide' &&
  v.approvals.some((x) => sameApproval(x, { taskId: v.task.taskId, gate: a.gate, docVersion: a.docVersion, decision: a.decision, comment: a.comment }));

function planLinked(i: PullInput, v: PullTaskView, it: ProjectItem, out: Out): void {
  if (closedTask(v.task)) return;
  const base = { taskId: v.task.taskId, version: v.task.version, issue: refOf(it) };
  const ended = closeOrLabel(i, v, it, base, out);
  if (ended === 'skip') return;
  if (ended) {
    out.actions.push(ended);
    return;
  }
  const ready = statusMove(i, v, it, base, out);
  const edit = titleBody(v, it, base, out);
  const found = [edit, ready, commands(i, v, base), prReview(i, v, base, out)];
  for (const a of found) if (a && !recorded(v, a)) out.actions.push(a);
}

const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** The change set for one factory: tasks to create, owner actions to apply, and GitHub changes not applied. */
export function planPull(i: PullInput): PullPlan {
  const creates: Out = { actions: [], notApplied: [] };
  const perTask = new Map<string, Out>();
  for (const it of i.items) {
    const v = i.tasks.find((x) => matches(x, it));
    if (!v) {
      planUnlinked(i, it, creates);
      continue;
    }
    const out = perTask.get(v.task.taskId) ?? { actions: [], notApplied: [] };
    perTask.set(v.task.taskId, out);
    planLinked(i, v, it, out);
  }
  creates.actions.sort((a, b) => lower(a.issue.repo).localeCompare(lower(b.issue.repo)) || a.issue.number - b.issue.number);
  creates.notApplied.sort((a, b) => a.issue.localeCompare(b.issue, undefined, { numeric: true }));
  const ids = [...perTask.keys()].sort(byId);
  return {
    factoryId: i.factoryId,
    actions: [...creates.actions, ...ids.flatMap((id) => perTask.get(id)!.actions)],
    notApplied: [...creates.notApplied, ...ids.flatMap((id) => perTask.get(id)!.notApplied)],
  };
}
