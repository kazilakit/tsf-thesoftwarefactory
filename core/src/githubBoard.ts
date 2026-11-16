import { Octokit } from '@octokit/rest';
import type { ProjectRef } from './githubConfig.js';

export interface RepoRef { owner: string; repo: string }
export interface ProjectInfo { projectId: string; statusFieldId: string; options: { id: string; name: string }[] }
export interface BoardIssue {
  repo: RepoRef; number: number; nodeId: string; title: string; body: string;
  state: 'open' | 'closed'; stateReason: 'completed' | 'not_planned' | 'reopened' | null;
  labels: string[]; updatedAt: string;
}
/** An issue on a Project; draft items and pull requests are skipped. */
export interface ProjectItem { itemId: string; status: string | null; issue: BoardIssue }
export interface IssueComment { id: number; author: string; body: string; createdAt: string }

/** The Project's Status field has no option with this exact name. */
export class UnknownStatusOptionError extends Error {
  constructor(option: string) {
    super(`Project has no Status option "${option}"`);
    this.name = 'UnknownStatusOptionError';
  }
}

/** GitHub Issues and Projects v2, as the board sync needs them. */
export interface GitHubBoard {
  /** Resolves the credential up front; rejects with GhLoginMissingError when the gh login is not logged in. Clients without a lazy credential omit it. */
  ensureReady?(): Promise<void>;
  /** The token's scopes, from the x-oauth-scopes header of GET /user; null when the header is absent (fine-grained or app tokens). */
  tokenScopes(): Promise<string[] | null>;
  /** A user's or an org's Project with its single select field named "Status"; null when absent. */
  project(p: ProjectRef): Promise<ProjectInfo | null>;
  /** Every issue item on the Project (all pages, 100 per page). */
  listItems(p: ProjectInfo): Promise<ProjectItem[]>;
  createIssue(r: RepoRef, i: { title: string; body: string; labels: string[] }): Promise<{ number: number; nodeId: string }>;
  updateIssue(r: RepoRef, number: number, patch: { title?: string; body?: string; labels?: string[] }): Promise<void>;
  closeIssue(r: RepoRef, number: number, reason: 'completed' | 'not_planned'): Promise<void>;
  /** Adds the labels and keeps the issue's other labels. */
  addLabels(r: RepoRef, number: number, labels: string[]): Promise<void>;
  /** Returns the item id; adding an issue already on the Project returns its existing item. */
  addToProject(p: ProjectInfo, issueNodeId: string): Promise<string>;
  /** Sets the Status option with this exact name; UnknownStatusOptionError when there is none. */
  setStatus(p: ProjectInfo, itemId: string, option: string): Promise<void>;
  /** Oldest first, all pages; with `since`, only comments created after it. */
  listComments(r: RepoRef, number: number, since?: string): Promise<IssueComment[]>;
  addComment(r: RepoRef, number: number, body: string): Promise<IssueComment>;
  reactToComment(r: RepoRef, commentId: number, content: '+1'): Promise<void>;
  labelExists(r: RepoRef, name: string): Promise<boolean>;
  createLabel(r: RepoRef, name: string): Promise<void>;
}

/** The board client for a factory's gh login (its `ghUser`). */
export type GitHubBoardFor = (ghUser: string) => GitHubBoard;

function optionId(p: ProjectInfo, option: string): string {
  const o = p.options.find((x) => x.name === option);
  if (!o) throw new UnknownStatusOptionError(option);
  return o.id;
}

const PROJECT_FIELDS = `id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }`;
const PROJECT_QUERY = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    ... on User { projectV2(number: $number) { ${PROJECT_FIELDS} } }
    ... on Organization { projectV2(number: $number) { ${PROJECT_FIELDS} } }
  }
}`;
const ITEMS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        nodes {
          id
          fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content {
            __typename
            ... on Issue {
              number id title body state stateReason updatedAt
              labels(first: 100) { nodes { name } }
              repository { owner { login } name }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const ADD_ITEM = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;
const SET_STATUS = `mutation($project: ID!, $item: ID!, $field: ID!, $singleSelectOptionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $singleSelectOptionId } }) {
    projectV2Item { id }
  }
}`;

interface ProjectNode { id: string; field: { id?: string; options?: { id: string; name: string }[] } | null }
interface IssueNode {
  __typename: string; number: number; id: string; title: string; body: string; state: string; stateReason: string | null;
  updatedAt: string; labels: { nodes: { name: string }[] }; repository: { owner: { login: string }; name: string };
}
interface ItemsPage {
  nodes: ({ id: string; fieldValueByName: { name?: string } | null; content: IssueNode | { __typename: string } | null } | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const STATE_REASONS = new Map<string, BoardIssue['stateReason']>([['COMPLETED', 'completed'], ['NOT_PLANNED', 'not_planned'], ['REOPENED', 'reopened']]);
/** Reasons the board does not model (such as DUPLICATE) read as null. */
const stateReasonOf = (r: string | null): BoardIssue['stateReason'] => (r ? STATE_REASONS.get(r) ?? null : null);

type RestComment = { id: number; user?: { login: string } | null; body?: string; created_at: string };
const toComment = (c: RestComment): IssueComment => ({ id: c.id, author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at });

export class OctokitGitHubBoard implements GitHubBoard {
  private readonly octokit: Octokit;

  constructor(token: string, opts?: { fetch?: typeof fetch }) {
    this.octokit = new Octokit({ auth: token, ...(opts?.fetch ? { request: { fetch: opts.fetch } } : {}) });
  }

  async tokenScopes(): Promise<string[] | null> {
    const { headers } = await this.octokit.rest.users.getAuthenticated();
    const raw = headers['x-oauth-scopes'];
    return typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  }

  async project(p: ProjectRef): Promise<ProjectInfo | null> {
    let res: { repositoryOwner: { projectV2?: ProjectNode | null } | null };
    try {
      res = await this.octokit.graphql(PROJECT_QUERY, { owner: p.owner, number: p.number });
    } catch (e) {
      const errors = (e as { errors?: { type?: string }[] }).errors;
      if (errors?.some((x) => x.type === 'NOT_FOUND')) return null;
      throw e;
    }
    const proj = res.repositoryOwner?.projectV2;
    if (!proj) return null;
    if (!proj.field?.id) throw new Error(`Project ${p.owner}/${p.number} has no single select field named "Status"`);
    return { projectId: proj.id, statusFieldId: proj.field.id, options: proj.field.options ?? [] };
  }

  async listItems(p: ProjectInfo): Promise<ProjectItem[]> {
    const out: ProjectItem[] = [];
    for (let after: string | null = null; ;) {
      const res: { node: { items: ItemsPage } } = await this.octokit.graphql(ITEMS_QUERY, { id: p.projectId, after });
      const page = res.node.items;
      for (const n of page.nodes) {
        if (n?.content?.__typename !== 'Issue') continue;
        const c = n.content as IssueNode;
        out.push({
          itemId: n.id,
          status: n.fieldValueByName?.name ?? null,
          issue: {
            repo: { owner: c.repository.owner.login, repo: c.repository.name }, number: c.number, nodeId: c.id, title: c.title, body: c.body,
            state: c.state === 'CLOSED' ? 'closed' : 'open',
            stateReason: stateReasonOf(c.stateReason),
            labels: c.labels.nodes.map((l) => l.name), updatedAt: c.updatedAt,
          },
        });
      }
      if (!page.pageInfo.hasNextPage) return out;
      after = page.pageInfo.endCursor;
    }
  }

  async createIssue(r: RepoRef, i: { title: string; body: string; labels: string[] }): Promise<{ number: number; nodeId: string }> {
    const { data } = await this.octokit.rest.issues.create({ owner: r.owner, repo: r.repo, title: i.title, body: i.body, labels: i.labels });
    return { number: data.number, nodeId: data.node_id };
  }

  async updateIssue(r: RepoRef, number: number, patch: { title?: string; body?: string; labels?: string[] }): Promise<void> {
    await this.octokit.rest.issues.update({ owner: r.owner, repo: r.repo, issue_number: number, ...patch });
  }

  async closeIssue(r: RepoRef, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    await this.octokit.rest.issues.update({ owner: r.owner, repo: r.repo, issue_number: number, state: 'closed', state_reason: reason });
  }

  async addLabels(r: RepoRef, number: number, labels: string[]): Promise<void> {
    await this.octokit.rest.issues.addLabels({ owner: r.owner, repo: r.repo, issue_number: number, labels });
  }

  async addToProject(p: ProjectInfo, issueNodeId: string): Promise<string> {
    const res: { addProjectV2ItemById: { item: { id: string } } } = await this.octokit.graphql(ADD_ITEM, { project: p.projectId, content: issueNodeId });
    return res.addProjectV2ItemById.item.id;
  }

  async setStatus(p: ProjectInfo, itemId: string, option: string): Promise<void> {
    const singleSelectOptionId = optionId(p, option);
    await this.octokit.graphql(SET_STATUS, { project: p.projectId, item: itemId, field: p.statusFieldId, singleSelectOptionId });
  }

  async listComments(r: RepoRef, number: number, since?: string): Promise<IssueComment[]> {
    const data = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: r.owner, repo: r.repo, issue_number: number, per_page: 100, ...(since ? { since } : {}),
    });
    // The API's `since` filters on the update time; keep only comments created after it.
    return data.map(toComment).filter((c) => !since || Date.parse(c.createdAt) > Date.parse(since));
  }

  async addComment(r: RepoRef, number: number, body: string): Promise<IssueComment> {
    const { data } = await this.octokit.rest.issues.createComment({ owner: r.owner, repo: r.repo, issue_number: number, body });
    return toComment(data);
  }

  async reactToComment(r: RepoRef, commentId: number, content: '+1'): Promise<void> {
    await this.octokit.rest.reactions.createForIssueComment({ owner: r.owner, repo: r.repo, comment_id: commentId, content });
  }

  async labelExists(r: RepoRef, name: string): Promise<boolean> {
    try {
      await this.octokit.rest.issues.getLabel({ owner: r.owner, repo: r.repo, name });
      return true;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return false;
      throw e;
    }
  }

  async createLabel(r: RepoRef, name: string): Promise<void> {
    await this.octokit.rest.issues.createLabel({ owner: r.owner, repo: r.repo, name });
  }
}

type FakeIssue = BoardIssue & { comments: IssueComment[]; itemStatus?: string | null };

/** In-memory GitHubBoard for tests. Repos and Project owners compare case-insensitively. */
export class FakeGitHubBoard implements GitHubBoard {
  /** null: the token has no x-oauth-scopes header. */
  scopes: string[] | null = ['repo', 'project'];
  /** Key `${owner}/${repo}` lower-cased. */
  labels = new Map<string, Set<string>>();
  readonly reactions: { commentId: number; content: string }[] = [];
  private readonly issues = new Map<string, FakeIssue>();
  private readonly projects = new Map<string, ProjectInfo>();
  /** projectId -> issue nodeId -> item. */
  private readonly items = new Map<string, Map<string, { itemId: string; status: string | null }>>();
  private nextId = 1;
  private clock = Date.parse('2026-01-01T00:00:00Z');

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private repoKey(r: RepoRef): string {
    return `${r.owner}/${r.repo}`.toLowerCase();
  }

  addProject(p: ProjectRef, options: string[]): ProjectInfo {
    const n = this.nextId++;
    const info: ProjectInfo = { projectId: `P${n}`, statusFieldId: `F${n}`, options: options.map((name, i) => ({ id: `P${n}-o${i + 1}`, name })) };
    this.projects.set(`${p.owner.toLowerCase()}/${p.number}`, info);
    this.items.set(info.projectId, new Map());
    return info;
  }

  issue(r: RepoRef, number: number): FakeIssue {
    const i = this.issues.get(`${this.repoKey(r)}#${number}`);
    if (!i) throw new Error(`unknown issue: ${r.owner}/${r.repo}#${number}`);
    return i;
  }

  async tokenScopes(): Promise<string[] | null> {
    return this.scopes ? [...this.scopes] : null;
  }

  async project(p: ProjectRef): Promise<ProjectInfo | null> {
    return this.projects.get(`${p.owner.toLowerCase()}/${p.number}`) ?? null;
  }

  async listItems(p: ProjectInfo): Promise<ProjectItem[]> {
    const items = this.projectItems(p);
    return [...this.issues.values()].flatMap((i) => {
      const it = items.get(i.nodeId);
      if (!it) return [];
      const { comments: _c, itemStatus: _s, ...issue } = i;
      return [{ itemId: it.itemId, status: it.status, issue: { ...issue, repo: { ...issue.repo }, labels: [...issue.labels] } }];
    });
  }

  async createIssue(r: RepoRef, i: { title: string; body: string; labels: string[] }): Promise<{ number: number; nodeId: string }> {
    const key = this.repoKey(r);
    const number = [...this.issues.values()].filter((x) => this.repoKey(x.repo) === key).length + 1;
    const nodeId = `I${this.nextId++}`;
    this.issues.set(`${key}#${number}`, {
      repo: { owner: r.owner, repo: r.repo }, number, nodeId, title: i.title, body: i.body, state: 'open', stateReason: null,
      labels: [...i.labels], updatedAt: this.now(), comments: [],
    });
    return { number, nodeId };
  }

  async updateIssue(r: RepoRef, number: number, patch: { title?: string; body?: string; labels?: string[] }): Promise<void> {
    const i = this.issue(r, number);
    if (patch.title !== undefined) i.title = patch.title;
    if (patch.body !== undefined) i.body = patch.body;
    if (patch.labels !== undefined) i.labels = [...patch.labels];
    i.updatedAt = this.now();
  }

  async closeIssue(r: RepoRef, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    const i = this.issue(r, number);
    i.state = 'closed';
    i.stateReason = reason;
    i.updatedAt = this.now();
  }

  async addLabels(r: RepoRef, number: number, labels: string[]): Promise<void> {
    const i = this.issue(r, number);
    for (const l of labels) if (!i.labels.includes(l)) i.labels.push(l);
    i.updatedAt = this.now();
  }

  async addToProject(p: ProjectInfo, issueNodeId: string): Promise<string> {
    const items = this.projectItems(p);
    const issue = [...this.issues.values()].find((i) => i.nodeId === issueNodeId);
    if (!issue) throw new Error(`unknown issue node: ${issueNodeId}`);
    let it = items.get(issueNodeId);
    if (!it) {
      items.set(issueNodeId, (it = { itemId: `IT${this.nextId++}`, status: null }));
      issue.itemStatus = null;
    }
    return it.itemId;
  }

  async setStatus(p: ProjectInfo, itemId: string, option: string): Promise<void> {
    optionId(p, option);
    for (const [nodeId, it] of this.projectItems(p)) {
      if (it.itemId !== itemId) continue;
      it.status = option;
      const issue = [...this.issues.values()].find((i) => i.nodeId === nodeId);
      if (issue) issue.itemStatus = option;
      return;
    }
    throw new Error(`unknown project item: ${itemId}`);
  }

  async listComments(r: RepoRef, number: number, since?: string): Promise<IssueComment[]> {
    return this.issue(r, number).comments.filter((c) => !since || Date.parse(c.createdAt) > Date.parse(since)).map((c) => ({ ...c }));
  }

  async addComment(r: RepoRef, number: number, body: string, author = 'octo-user'): Promise<IssueComment> {
    const c: IssueComment = { id: this.nextId++, author, body, createdAt: this.now() };
    this.issue(r, number).comments.push(c);
    return { ...c };
  }

  async reactToComment(_r: RepoRef, commentId: number, content: '+1'): Promise<void> {
    this.reactions.push({ commentId, content });
  }

  async labelExists(r: RepoRef, name: string): Promise<boolean> {
    return this.labels.get(this.repoKey(r))?.has(name) ?? false;
  }

  async createLabel(r: RepoRef, name: string): Promise<void> {
    const key = this.repoKey(r);
    if (!this.labels.has(key)) this.labels.set(key, new Set());
    this.labels.get(key)!.add(name);
  }

  private projectItems(p: ProjectInfo) {
    const items = this.items.get(p.projectId);
    if (!items) throw new Error(`unknown project: ${p.projectId}`);
    return items;
  }
}
