import type { BoardStore, StoredSettings } from './boardStore.js';
import { VersionConflictError } from './boardStore.js';
import { redactSecrets } from './doctor.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { resolveGates, resolveSettings } from './gates.js';
import type { GitHubBoard, GitHubBoardFor, ProjectInfo, ProjectItem, RepoRef } from './githubBoard.js';
import type { GitHubSettings } from './githubConfig.js';
import { emptyPushed, type GitHubLink } from './githubLink.js';
import { blockedKey, bodyHash, issueText, markerIn, planPush, stripMarker, projectKey, type PushAction } from './githubPush.js';
import { githubConfigProblems } from './githubConfig.js';
import { parseRemote } from './remote.js';
import type { FactoryDef, FactoryRepo } from './factories.js';
import type { Task } from './types.js';

// Runs the planned GitHub actions for a task: one pusher per task at a time (lease), progress saved after each action, backoff on failure.

export interface PushResult {
  taskId: string;
  /** "owner/repo#n" once the issue exists. */
  issue: string | null;
  /** One short phrase per action taken, e.g. "created", "status Todo", "spec v2 comment", "closed". */
  done: string[];
  error: string | null;
  /** `busy`: the factory's pull holds its lock, so a task it is creating may not have its link yet. */
  skipped: 'not-github' | 'leased' | 'backoff' | 'busy' | null;
}
export interface PusherDeps {
  store: BoardStore; boardFor: GitHubBoardFor; now: () => Date; claimant: string;
  /** True while a pull of the factory runs (its lock is held). Default: never. */
  pullBusy?: (factoryId: string) => boolean;
}

export const LEASE_MS = 60_000;
export const backoffMs = (attempts: number): number => Math.min(5_000 * 2 ** (attempts - 1), 600_000);

/** Per-pass cache: Projects, and the items of each Project (for adopting marked issues). */
interface ProjectCache { projects: Map<string, ProjectInfo | null>; items: Map<string, ProjectItem[]> }
const newCache = (): ProjectCache => ({ projects: new Map(), items: new Map() });
/** What one pass reads once: the definitions, repos, stored settings and links. */
interface Snapshot { defs: FactoryDef[]; repos: FactoryRepo[]; stored: StoredSettings; links: Map<string, GitHubLink> }
const isTerminal = (t: Task): boolean => t.status === 'done' || t.status === 'cancelled';

const numericId = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);

function phrase(a: PushAction): string | null {
  switch (a.kind) {
    case 'create': return 'created';
    case 'addToProject': return null;
    case 'setStatus': return `status ${a.option}`;
    case 'addLabel': return `label ${a.label}`;
    case 'updateIssue': return 'title/body';
    case 'comment': return a.about === 'blocked' ? 'blocked comment' : `${a.about} v${a.version} comment`;
    case 'close': return 'closed';
  }
}

export class GitHubPusher {
  constructor(private readonly d: PusherDeps) {}

  async pushTask(taskId: string, opts: { ignoreBackoff?: boolean } = {}): Promise<PushResult> {
    const { store } = this.d;
    const link = await store.getGitHubLink(taskId);
    const snap: Snapshot = {
      defs: await store.listFactoryDefs(), repos: await store.listFactoryRepos(), stored: await store.getSettings(),
      links: new Map(link ? [[taskId, link]] : []),
    };
    return this.push(await store.getTask(taskId), opts, newCache(), snap);
  }

  /** Every task of every github-only factory (or only `factoryIds`), one at a time, by task id. */
  async pushAll(factoryIds?: string[], opts: { ignoreBackoff?: boolean } = {}): Promise<PushResult[]> {
    const { store } = this.d;
    const defs = await store.listFactoryDefs();
    const snap: Snapshot = {
      defs, repos: await store.listFactoryRepos(), stored: await store.getSettings(),
      links: new Map((await store.listGitHubLinks()).map((l) => [l.taskId, l])),
    };
    const ids = new Set(defs.filter((f) => f.github?.mode === 'github-only' && (!factoryIds || factoryIds.includes(f.factoryId))).map((f) => f.factoryId));
    const tasks = (await this.d.store.listTasks()).filter((t) => ids.has(t.factoryId)).sort((a, b) => numericId(a.taskId) - numericId(b.taskId));
    const cache = newCache();
    const out: PushResult[] = [];
    for (const t of tasks) {
      try {
        out.push(await this.push(t, opts, cache, snap));
      } catch (e) {
        out.push({ taskId: t.taskId, issue: null, done: [], error: this.firstLine(e), skipped: null });
      }
    }
    return out;
  }

  private firstLine(e: unknown): string {
    return redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
  }

  private async push(task: Task, opts: { ignoreBackoff?: boolean }, cache: ProjectCache, snap: Snapshot): Promise<PushResult> {
    const { store } = this.d;
    const taskId = task.taskId;
    const now = this.d.now();
    const result: PushResult = { taskId, issue: null, done: [], error: null, skipped: null };
    const def = snap.defs.find((f) => f.factoryId === task.factoryId);
    const settings = def?.github;
    if (!def || !settings || settings.mode !== 'github-only') return { ...result, skipped: 'not-github' };
    if (this.d.pullBusy?.(task.factoryId)) return { ...result, skipped: 'busy' }; // the next push, after the pull, does it
    const link = snap.links.get(taskId);
    if (link) result.issue = this.issueName(link);
    // Nothing more to push for a closed issue, or for a task that ended before it was ever pushed: no config check, no write.
    if (link?.pushed.closed || (!link && isTerminal(task))) return result;
    if (link?.error && !opts.ignoreBackoff && Date.parse(link.error.nextAttemptAt) > now.getTime()) return { ...result, skipped: 'backoff' };

    const factoryRepo = snap.repos.find((r) => r.factoryId === task.factoryId && r.repoId === task.repo);
    if (!factoryRepo) return this.fail(link, task, '', `repo ${task.repo} is not configured for factory ${task.factoryId}`, result);
    let ref: RepoRef;
    try { ref = parseRemote(factoryRepo.remote); } catch (e) { return this.fail(link, task, '', this.firstLine(e), result); }
    const repoName = `${ref.owner}/${ref.repo}`;
    const problem = githubConfigProblems(snap.defs, snap.repos)
      .find((p) => (p.factoryId === task.factoryId && (p.repoId === undefined || p.repoId === task.repo))
        || (p.clashWith?.factoryId === task.factoryId && p.clashWith.repoId === task.repo)); // the first owner is blocked too: it is a clash
    if (problem) return this.fail(link, task, repoName, problem.message, result);

    const stored = snap.stored.factories[task.factoryId];
    const gates = resolveGates(resolveSettings(stored?.factory ?? DEFAULT_SETTINGS, stored?.repos[task.repo]), task.gateOverrides);
    const docs = { spec: await store.currentDoc(taskId, 'spec'), plan: await store.currentDoc(taskId, 'plan') };
    const actions = planPush({ task, link, settings, docs, gates });
    const key = blockedKey(task);
    if (actions.length === 0 && !link?.error && (link?.pushed.blocked ?? null) === key) return result;

    if (link?.lease && Date.parse(link.lease.until) > now.getTime()) return { ...result, skipped: 'leased' };
    const base: GitHubLink = link ?? {
      taskId, factoryId: task.factoryId, repo: repoName, issueNumber: null, issueNodeId: null, project: null, itemId: null,
      pushed: emptyPushed(), error: null, lease: null, reported: [], version: 0,
    };
    let cur: GitHubLink;
    try {
      cur = await store.saveGitHubLink(link ?? null, { ...base, lease: { by: this.d.claimant, until: new Date(now.getTime() + LEASE_MS).toISOString() } });
    } catch (e) {
      if (e instanceof VersionConflictError) return { ...result, skipped: 'leased' };
      throw e;
    }

    try {
      cur = await this.run(task, def, ref, settings, actions, cur, result, cache, (l) => { cur = l; });
      const pushed = { ...cur.pushed, blocked: key };
      try {
        cur = await store.saveGitHubLink(cur, { ...cur, pushed, error: null, lease: null });
      } catch (e) {
        if (!(e instanceof VersionConflictError)) throw e; // the actions are done; the next push re-plans
      }
      result.issue = this.issueName(cur);
      return result;
    } catch (e) {
      const message = this.firstLine(e);
      const attempts = (link?.error?.attempts ?? 0) + 1;
      result.error = message;
      try {
        const latest = cur;
        const failed = { message, attempts, nextAttemptAt: new Date(this.d.now().getTime() + backoffMs(attempts)).toISOString() };
        const saved = await store.saveGitHubLink(latest, { ...latest, error: failed, lease: null });
        result.issue = this.issueName(saved);
      } catch { /* a conflict means another pusher owns the link now; otherwise the lease expires by itself */ }
      return result;
    }
  }

  /** Records a failure that happens before any GitHub call (config problem): link error with backoff, lease respected. */
  private async fail(link: GitHubLink | undefined, task: Task, repo: string, message: string, result: PushResult): Promise<PushResult> {
    const now = this.d.now();
    if (link?.lease && Date.parse(link.lease.until) > now.getTime()) return { ...result, skipped: 'leased' };
    const attempts = (link?.error?.attempts ?? 0) + 1;
    const error = { message, attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)).toISOString() };
    const base: GitHubLink = link ?? {
      taskId: task.taskId, factoryId: task.factoryId, repo, issueNumber: null, issueNodeId: null, project: null, itemId: null,
      pushed: emptyPushed(), error: null, lease: null, reported: [], version: 0,
    };
    try {
      await this.d.store.saveGitHubLink(link ?? null, { ...base, error, lease: null });
    } catch (e) {
      if (e instanceof VersionConflictError) return { ...result, skipped: 'leased' };
      throw e;
    }
    return { ...result, error: message };
  }

  private issueName(l: GitHubLink): string | null {
    return l.issueNumber == null ? null : `${l.repo}#${l.issueNumber}`;
  }

  private async run(task: Task, def: FactoryDef, ref: RepoRef, settings: GitHubSettings, actions: PushAction[], start: GitHubLink, result: PushResult, cache: ProjectCache, track: (l: GitHubLink) => void): Promise<GitHubLink> {
    if (actions.length === 0) return start;
    const board = this.d.boardFor(def.ghUser);
    let project: ProjectInfo | undefined;
    if (actions.some((a) => a.kind === 'addToProject' || a.kind === 'setStatus')) project = await this.project(board, def.ghUser, settings, cache);
    let labelReady = false;
    const ensureLabel = async (): Promise<void> => {
      if (labelReady || settings.label === '') return;
      if (!(await board.labelExists(ref, settings.label))) await board.createLabel(ref, settings.label);
      labelReady = true;
    };
    let cur = start;
    const save = async (patch: (l: GitHubLink) => GitHubLink): Promise<void> => {
      const next = patch(structuredClone(cur));
      if (next.lease) next.lease = { ...next.lease, until: new Date(this.d.now().getTime() + LEASE_MS).toISOString() };
      cur = await this.d.store.saveGitHubLink(cur, next);
      track(cur);
    };
    for (const a of actions) {
      const note = (): void => { const p = phrase(a); if (p) result.done.push(p); }; // right after the GitHub call, before its save
      switch (a.kind) {
        case 'create': {
          const found = await this.findMarked(board, def.ghUser, settings, project!, ref, task, cache);
          if (found) {
            result.done.push('adopted');
            await save((l) => ({
              ...l, issueNumber: found.issue.number, issueNodeId: found.issue.nodeId, itemId: found.itemId, project: projectKey(settings.project),
              pushed: { ...l.pushed, title: found.issue.title, bodyHash: bodyHash(stripMarker(found.issue.body)), label: settings.label !== '' && found.issue.labels.includes(settings.label) ? settings.label : null },
            }));
            break;
          }
          await ensureLabel();
          const made = await board.createIssue(ref, { title: a.title, body: a.body, labels: a.labels });
          note();
          const label = settings.label === '' ? null : settings.label;
          const hash = bodyHash(issueText(task.description, task.taskId, task.factoryId));
          await save((l) => ({ ...l, issueNumber: made.number, issueNodeId: made.nodeId, pushed: { ...l.pushed, title: a.title, bodyHash: hash, label } }));
          break;
        }
        case 'addToProject': {
          const itemId = await board.addToProject(project!, cur.issueNodeId!);
          note();
          await save((l) => ({ ...l, itemId, project: projectKey(settings.project) }));
          break;
        }
        case 'setStatus':
          await board.setStatus(project!, cur.itemId!, a.option);
          note();
          await save((l) => ({ ...l, pushed: { ...l.pushed, status: task.status, option: a.option } }));
          break;
        case 'addLabel':
          await ensureLabel();
          await board.addLabels(ref, cur.issueNumber!, [a.label]);
          note();
          await save((l) => ({ ...l, pushed: { ...l.pushed, label: a.label } }));
          break;
        case 'updateIssue': {
          await board.updateIssue(ref, cur.issueNumber!, { title: a.title, body: a.body });
          note();
          const hash = bodyHash(issueText(task.description, task.taskId, task.factoryId));
          await save((l) => ({ ...l, pushed: { ...l.pushed, title: a.title, bodyHash: hash } }));
          break;
        }
        case 'comment': {
          const posted = await board.addComment(ref, cur.issueNumber!, a.body);
          note();
          if (a.about === 'blocked') await save((l) => ({ ...l, pushed: { ...l.pushed, blocked: a.key, blockedAt: posted.createdAt } }));
          else await save((l) => ({ ...l, pushed: { ...l.pushed, docs: { ...l.pushed.docs, [a.about]: a.version }, docAt: { ...l.pushed.docAt, [a.about]: posted.createdAt } } }));
          break;
        }
        case 'close':
          await board.closeIssue(ref, cur.issueNumber!, a.reason);
          note();
          await save((l) => ({ ...l, pushed: { ...l.pushed, closed: true, status: task.status } }));
          break;
      }
    }
    return cur;
  }

  /** An open or closed issue of the repo on the Project whose marker names this task and factory (listed once per pass). */
  private async findMarked(board: GitHubBoard, ghUser: string, s: GitHubSettings, project: ProjectInfo, ref: RepoRef, task: Task, cache: ProjectCache): Promise<ProjectItem | undefined> {
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
    return (await this.items(board, ghUser, s, project, cache)).find((it) => {
      if (!same(it.issue.repo.owner, ref.owner) || !same(it.issue.repo.repo, ref.repo)) return false;
      const m = markerIn(it.issue.body);
      return m?.taskId === task.taskId && m.factoryId === task.factoryId;
    });
  }

  /** The items of the Project, listed once per pass. */
  private async items(board: GitHubBoard, ghUser: string, s: GitHubSettings, project: ProjectInfo, cache: ProjectCache): Promise<ProjectItem[]> {
    const k = `${ghUser}|${projectKey(s.project)}`;
    if (!cache.items.has(k)) cache.items.set(k, await board.listItems(project));
    return cache.items.get(k)!;
  }

  private async project(board: GitHubBoard, ghUser: string, s: GitHubSettings, cache: ProjectCache): Promise<ProjectInfo> {
    const k = `${ghUser}|${projectKey(s.project)}`;
    if (!cache.projects.has(k)) cache.projects.set(k, await board.project(s.project));
    const p = cache.projects.get(k);
    if (!p) throw new Error(`Project ${s.project.owner}/${s.project.number} not found`);
    return p;
  }
}
