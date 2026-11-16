import { VersionConflictError, type BoardStore } from './boardStore.js';
import { redactSecrets } from './doctor.js';
import type { FactoryDef, FactoryRepo } from './factories.js';
import type { GitHubFor } from './github.js';
import type { GitHubBoard, GitHubBoardFor, IssueComment, ProjectItem, RepoRef } from './githubBoard.js';
import { githubConfigProblems } from './githubConfig.js';
import { emptyPushed, type GitHubLink, type PushedState } from './githubLink.js';
import { issueName, planPull, pullNeeds, type NotApplied, type PullInput, type PullPlan, type PullTaskView } from './githubPull.js';
import { applyPull, type ApplyResult, type PullCreated, type PullError } from './githubPullApply.js';
import { bodyHash, markerIn, projectKey, stripMarker } from './githubPush.js';
import { parseRemote } from './remote.js';
import type { DocKind, Status, Task } from './types.js';

// Node side of pull: reads GitHub, runs the pure planner and applier, saves the link records, and reacts to the comments it used.

export interface PullResult extends ApplyResult { factoryId: string; skipped: 'busy' | null }
/** Frees the pull lock. `touch`, when the lock has one, refreshes it and returns false when another pull took it over. */
export type PullRelease = (() => void) & { touch?: () => boolean };
/** Takes the factory's pull lock: a release function, or null when another pull holds it. */
export type PullLock = (factoryId: string) => Promise<PullRelease | null>;
export interface PullerDeps { store: BoardStore; boardFor: GitHubBoardFor; githubFor: GitHubFor; now: () => Date; lock?: PullLock }

export interface RebuildResult {
  factoryId: string;
  rebuilt: { taskId: string; issue: string; status: Status }[];
  skipped: { issue: string; reason: string }[];
  error: string | null;
}

/** The newest `## <Heading> v<N>` comment: its number, text without the reply footer, and creation time. */
function latestDoc(comments: IssueComment[], heading: string): { n: number; body: string; at: string } | null {
  const head = `## ${heading} v`;
  let best: { n: number; body: string; at: string } | null = null;
  for (const c of comments) {
    const m = c.body.startsWith(head) ? /^(\d+)\n\n/.exec(c.body.slice(head.length)) : null;
    if (!m) continue;
    const n = Number(m[1]);
    if (best && n <= best.n) continue;
    best = { n, body: c.body.slice(head.length + m[0].length).replace(/\n\n---\nReply [\s\S]*$/, ''), at: c.createdAt };
  }
  return best;
}

type Fail = (taskId: string | null, issue: string | null, e: unknown, prefix?: string) => void;

const REPORTED_MAX = 20;
const WITH_DOCS = new Set(['spec_review', 'plan_review', 'pr_open', 'blocked']);
const noLock: PullLock = async () => () => undefined;
const empty = (factoryId: string, skipped: PullResult['skipped'] = null): PullResult => ({ factoryId, created: [], applied: [], notApplied: [], errors: [], skipped });
const slugOf = (r: FactoryRepo): string => { const { owner, repo } = parseRemote(r.remote); return `${owner}/${repo}`; };
const refOfName = (name: string): RepoRef => { const [owner, repo] = name.replace(/#\d+$/, '').split('/'); return { owner: owner!, repo: repo! }; };

export class GitHubPuller {
  constructor(private readonly d: PullerDeps) {}

  /** Every github-only factory (or only `factoryIds`), by factory id. Never throws for a GitHub error. */
  async pull(factoryIds?: string[]): Promise<PullResult[]> {
    const { store } = this.d;
    const defs = await store.listFactoryDefs();
    const repos = await store.listFactoryRepos();
    const picked = defs.filter((f) => f.github?.mode === 'github-only' && (!factoryIds || factoryIds.includes(f.factoryId)))
      .sort((a, b) => a.factoryId.localeCompare(b.factoryId, undefined, { numeric: true }));
    const out: PullResult[] = [];
    for (const def of picked) {
      let release: PullRelease | null = null;
      try {
        release = await (this.d.lock ?? noLock)(def.factoryId);
        if (!release) { out.push(empty(def.factoryId, 'busy')); continue; }
        out.push(await this.pullFactory(def, defs, repos, release));
      } catch (e) {
        out.push({ ...empty(def.factoryId), errors: [{ taskId: null, issue: null, message: this.firstLine(e) }] });
      } finally {
        release?.();
      }
    }
    return out;
  }

  /** Restores an empty github-only factory's board from its marked issues. Never throws for a GitHub error. */
  async rebuild(factoryIds?: string[]): Promise<RebuildResult[]> {
    const { store } = this.d;
    const defs = await store.listFactoryDefs();
    const repos = await store.listFactoryRepos();
    const picked = defs.filter((f) => f.github?.mode === 'github-only' && (!factoryIds || factoryIds.includes(f.factoryId)))
      .sort((a, b) => a.factoryId.localeCompare(b.factoryId, undefined, { numeric: true }));
    const out: RebuildResult[] = [];
    for (const def of picked) {
      const res: RebuildResult = { factoryId: def.factoryId, rebuilt: [], skipped: [], error: null };
      let release: PullRelease | null = null;
      try {
        release = await (this.d.lock ?? noLock)(def.factoryId);
        if (!release) res.error = 'another pull is running';
        else await this.rebuildFactory(def, defs, repos, res);
      } catch (e) {
        res.error = this.firstLine(e);
      } finally {
        release?.();
      }
      out.push(res);
    }
    return out;
  }

  private async rebuildFactory(def: FactoryDef, defs: FactoryDef[], allRepos: FactoryRepo[], res: RebuildResult): Promise<void> {
    const { store } = this.d;
    const f = def.factoryId;
    const settings = def.github!;
    if ((await store.listTasks()).some((t) => t.factoryId === f) || (await store.listGitHubLinks(f)).length > 0) {
      res.error = `the board already has tasks for factory ${f}; --rebuild only fills an empty board`;
      return;
    }
    const problem = githubConfigProblems(defs, allRepos).find((p) => p.factoryId === f);
    if (problem) { res.error = problem.message; return; }
    const board = this.d.boardFor(def.ghUser);
    const project = await board.project(settings.project);
    if (!project) { res.error = `Project ${projectKey(settings.project)} not found`; return; }
    const items = await board.listItems(project);
    const mine = allRepos.filter((r) => r.factoryId === f);
    const repoOf = (item: ProjectItem): FactoryRepo | undefined => mine.find((r) => slugOf(r).toLowerCase() === `${item.issue.repo.owner}/${item.issue.repo.repo}`.toLowerCase());
    const byOption = new Map<string, Status[]>();
    for (const [st, option] of Object.entries(settings.statusMap) as [Status, string][]) {
      if (st === 'done' || st === 'cancelled') continue;
      byOption.set(option, [...(byOption.get(option) ?? []), st]);
    }
    const seen = new Set<string>();
    const open = items.filter((i) => i.issue.state === 'open')
      .sort((a, b) => `${a.issue.repo.owner}/${a.issue.repo.repo}`.localeCompare(`${b.issue.repo.owner}/${b.issue.repo.repo}`) || a.issue.number - b.issue.number);
    for (const item of open) {
      const mark = markerIn(item.issue.body);
      const repo = repoOf(item);
      if (!mark || mark.factoryId !== f || !repo) continue;
      const issue = issueName({ repo: slugOf(repo), number: item.issue.number });
      if (!/^T-\d+$/.test(mark.taskId)) { res.skipped.push({ issue, reason: `marker id ${mark.taskId} is not a task id` }); continue; }
      if (seen.has(mark.taskId)) { res.skipped.push({ issue, reason: `duplicate marker for ${mark.taskId}` }); continue; }
      seen.add(mark.taskId);
      try {
        const status = await this.restoreOne(def, repo, item, mark.taskId, byOption, issue, board);
        res.rebuilt.push({ taskId: mark.taskId, issue, status });
      } catch (e) {
        res.skipped.push({ issue, reason: this.firstLine(e) });
      }
    }
  }

  private async restoreOne(
    def: FactoryDef, repo: FactoryRepo, item: ProjectItem, taskId: string, byOption: Map<string, Status[]>, issue: string, board: GitHubBoard,
  ): Promise<Status> {
    const { store } = this.d;
    const settings = def.github!;
    const { issue: gi } = item;
    const comments = await board.listComments(gi.repo, gi.number);
    const spec = latestDoc(comments, 'Spec');
    const plan = latestDoc(comments, 'Plan');
    const unique = item.status === null ? undefined : byOption.get(item.status);
    const only = unique?.length === 1 ? unique[0]! : undefined;
    const restorable = only === 'inbox' || only === 'ready' || (only === 'spec_review' && spec !== null) || (only === 'plan_review' && plan !== null);
    const status: Status = restorable ? only! : 'blocked';
    const description = stripMarker(gi.body);
    const at = this.d.now().toISOString();
    await store.restoreTask({
      taskId, factoryId: def.factoryId, title: gi.title.trim(), description, repo: repo.repoId, baseBranch: repo.baseBranch, status, stage: null,
      branch: null, prUrl: null, attempt: 0, blockedReason: status === 'blocked' ? 'rebuilt from GitHub, check status' : null, question: null, answer: null,
      gateOverrides: {}, dependsOn: [], claimBy: null, claimUntil: null, costUsd: 0, version: 1,
    });
    for (const [kind, d] of [['spec', spec], ['plan', plan]] as [DocKind, typeof spec][]) if (d) await store.addDoc(taskId, kind, d.body, 'github · rebuilt');
    await store.addEvents([{ taskId, factoryId: def.factoryId, actor: 'github', action: 'create', field: null, from: null, to: status, reason: `rebuilt from GitHub issue ${issue}`, at }]);
    const labelled = gi.labels.includes(settings.label);
    await store.saveGitHubLink(null, {
      taskId, factoryId: def.factoryId, repo: `${gi.repo.owner}/${gi.repo.repo}`, issueNumber: gi.number, issueNodeId: gi.nodeId,
      project: projectKey(settings.project), itemId: item.itemId,
      pushed: {
        ...emptyPushed(), status, option: item.status, title: gi.title, bodyHash: bodyHash(description), label: labelled ? settings.label : null,
        docs: { spec: spec ? 1 : 0, plan: plan ? 1 : 0 }, docAt: { spec: spec?.at ?? null, plan: plan?.at ?? null },
      },
      error: null, lease: null, reported: [], version: 0,
    });
    return status;
  }

  private firstLine(e: unknown): string {
    return redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
  }

  /** Reads the Project and builds the plan for one factory. plan null when the Project could not be read (errors say why). */
  async planFactory(
    def: FactoryDef, defs: FactoryDef[], repos: FactoryRepo[],
  ): Promise<{ plan: PullPlan | null; errors: PullError[] }> {
    const { store } = this.d;
    const settings = def.github!;
    const errors: PullError[] = [];
    const fail: Fail = (taskId, issue, e, prefix = '') => { errors.push({ taskId, issue, message: prefix + this.firstLine(e) }); };
    const problem = githubConfigProblems(defs, repos).find((p) => p.factoryId === def.factoryId);
    if (problem) { fail(null, null, problem.message); return { plan: null, errors }; }

    const board = this.d.boardFor(def.ghUser);
    let items: ProjectItem[];
    try {
      const project = await board.project(settings.project);
      if (!project) { fail(null, null, `Project ${projectKey(settings.project)} not found`); return { plan: null, errors }; }
      items = await board.listItems(project);
    } catch (e) { fail(null, null, e); return { plan: null, errors }; }

    const mine = repos.filter((r) => r.factoryId === def.factoryId);
    const links = new Map((await store.listGitHubLinks(def.factoryId)).map((l) => [l.taskId, l]));
    const tasks = (await store.listTasks()).filter((t) => t.factoryId === def.factoryId);
    const linked = tasks.filter((t) => links.get(t.taskId)?.issueNumber != null);
    const input: PullInput = {
      factoryId: def.factoryId, settings,
      repos: mine.map((r) => ({ repoId: r.repoId, slug: slugOf(r), baseBranch: r.baseBranch })),
      otherRepos: repos.filter((r) => r.factoryId !== def.factoryId).map(slugOf),
      items, tasks: await Promise.all(linked.map((t) => this.view(t, links.get(t.taskId)!))),
      unlinked: tasks.filter((t) => links.get(t.taskId)?.issueNumber == null).map((t) => t.taskId),
    };
    await this.fetchNeeds(input, def, board, fail);
    return { plan: planPull(input), errors };
  }

  /** Saves NotApplied link patches (option, report) only; used by the watcher. */
  async saveNotAppliedLinks(def: FactoryDef, notApplied: NotApplied[]): Promise<PullError[]> {
    void def;
    const errors: PullError[] = [];
    await this.saveLinks({ created: [], applied: [], notApplied, errors: [] }, (taskId, issue, e, prefix = '') => { errors.push({ taskId, issue, message: prefix + this.firstLine(e) }); });
    return errors;
  }

  private async pullFactory(def: FactoryDef, defs: FactoryDef[], allRepos: FactoryRepo[], lock: PullRelease): Promise<PullResult> {
    const { store } = this.d;
    const result = empty(def.factoryId);
    const fail: Fail = (taskId, issue, e, prefix = '') => { result.errors.push({ taskId, issue, message: prefix + this.firstLine(e) }); };
    const { plan, errors } = await this.planFactory(def, defs, allRepos);
    result.errors.push(...errors);
    if (!plan) return result;
    const board = this.d.boardFor(def.ghUser);
    // The GitHub reads can be slow: refresh the lock so it is not taken over as stale, and stop if it already was.
    if (lock.touch && !lock.touch()) { fail(null, null, 'pull lock taken over by another pull; nothing applied'); return result; }
    // Each new task's link is saved right after its create, so a pusher never sees the task without its issue.
    const applied = await applyPull(store, this.d.now, plan, { onCreated: (c) => this.save(c.taskId, (cur) => this.createdLink(def, c, cur)) });
    result.created = applied.created;
    result.applied = applied.applied;
    result.notApplied = applied.notApplied;
    result.errors.push(...applied.errors);
    await this.saveLinks(applied, fail);
    for (const a of applied.applied) {
      if (a.commentId === null) continue;
      try { await board.reactToComment(refOfName(a.issue), a.commentId, '+1'); } catch (e) { fail(a.taskId, a.issue, e, 'reaction failed: '); }
    }
    return result;
  }

  private async view(task: Task, link: GitHubLink): Promise<PullTaskView> {
    const { store } = this.d;
    if (!WITH_DOCS.has(task.status)) return { task, link, docs: {}, approvals: [] };
    const docs: PullTaskView['docs'] = {};
    for (const k of ['spec', 'plan', 'review'] as const) {
      const doc = await store.currentDoc(task.taskId, k);
      if (doc) docs[k] = doc.version;
    }
    const view: PullTaskView = { task, link, docs, approvals: await store.listApprovals(task.taskId) };
    if (task.status === 'pr_open') {
      const moves = (await store.listEvents(task.taskId)).filter((e) => e.action === 'move' && e.to === 'pr_open').map((e) => e.at).sort();
      if (moves.length > 0) view.prOpenAt = moves.at(-1)!;
    }
    return view;
  }

  /** Fills each view with what `pullNeeds` names; a failed read is an error for that task and the view goes without it. */
  private async fetchNeeds(input: PullInput, def: FactoryDef, board: GitHubBoard, fail: Fail): Promise<void> {
    const needs = pullNeeds(input);
    const client = this.d.githubFor(def.ghUser);
    const viewOf = (id: string): PullTaskView => input.tasks.find((v) => v.task.taskId === id)!;
    const where = (v: PullTaskView): string => issueName({ repo: v.link.repo, number: v.link.issueNumber! });
    for (const n of needs.comments) {
      const v = viewOf(n.taskId);
      try { v.comments = await board.listComments(refOfName(v.link.repo), v.link.issueNumber!, n.since); } catch (e) { fail(n.taskId, where(v), e); }
    }
    for (const n of needs.reviews) {
      const v = viewOf(n.taskId);
      try { v.reviews = await client.prReviews(n.prUrl); } catch (e) { fail(n.taskId, where(v), e); }
    }
    for (const n of needs.prStates) {
      const v = viewOf(n.taskId);
      try { v.prState = await client.prState(n.prUrl); } catch (e) { fail(n.taskId, where(v), e); }
    }
  }

  /** The link of a task the pull just created; an existing link is never overwritten. */
  private createdLink(def: FactoryDef, c: PullCreated, cur: GitHubLink | null): GitHubLink {
    if (cur) throw new Error(`a link already exists for the new task ${cur.taskId}`);
    const settings = def.github!;
    const a = c.action;
    return {
      taskId: c.taskId, factoryId: def.factoryId, repo: a.issue.repo, issueNumber: a.issue.number, issueNodeId: a.nodeId,
      project: projectKey(settings.project), itemId: a.itemId,
      pushed: { ...emptyPushed(), status: c.status, option: a.option, title: a.title, bodyHash: null, label: a.labelled ? settings.label : null },
      error: null, lease: null, reported: [], version: 0,
    };
  }

  /** Saves the patches of applied and not-applied items; one re-read and retry on a conflict. */
  private async saveLinks(r: ApplyResult, fail: Fail): Promise<void> {
    type Step = (l: GitHubLink) => GitHubLink;
    const patches = new Map<string, { issue: string; steps: Step[] }>();
    const slot = (taskId: string, issue: string) => {
      if (!patches.has(taskId)) patches.set(taskId, { issue, steps: [] });
      return patches.get(taskId)!;
    };
    const pushed = (l: GitHubLink, p: Partial<PushedState>): GitHubLink => ({ ...l, pushed: { ...l.pushed, ...p } });
    for (const a of r.applied) if (a.onApplied) slot(a.taskId, a.issue).steps.push((l) => pushed(l, a.onApplied!));
    for (const n of r.notApplied) {
      if (!n.taskId || !n.link) continue;
      const { option, report } = n.link;
      slot(n.taskId, n.issue).steps.push((l) => {
        const next = option !== undefined ? pushed(l, { option }) : l;
        return report !== undefined && !next.reported.includes(report) ? { ...next, reported: [...next.reported, report].slice(-REPORTED_MAX) } : next;
      });
    }
    for (const [taskId, p] of patches) {
      const build = (cur: GitHubLink | null): GitHubLink | null => (cur ? p.steps.reduce((l, s) => s(l), structuredClone(cur)) : null);
      try {
        await this.save(taskId, build);
      } catch (e) {
        fail(taskId, p.issue, e);
      }
    }
  }

  private async save(taskId: string, build: (cur: GitHubLink | null) => GitHubLink | null): Promise<void> {
    const { store } = this.d;
    for (let attempt = 0; ; attempt++) {
      const cur = (await store.getGitHubLink(taskId)) ?? null;
      const next = build(cur);
      // A live lease belongs to a pusher whose next save would conflict with ours: leave the link, the next pull plans again.
      if (!next || (cur?.lease && Date.parse(cur.lease.until) > this.d.now().getTime()) || (cur && JSON.stringify(cur) === JSON.stringify(next))) return;
      try {
        await store.saveGitHubLink(cur, next);
        return;
      } catch (e) {
        if (!(e instanceof VersionConflictError) || attempt >= 1) throw e;
      }
    }
  }
}
