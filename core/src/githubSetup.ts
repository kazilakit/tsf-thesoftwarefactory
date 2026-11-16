import { Octokit } from '@octokit/rest';
import type { RepoRef } from './githubBoard.js';
import type { ProjectRef } from './githubConfig.js';
import { readGhToken, realExecFile, type ExecFile } from './secrets.js';
import { LoadOnce } from './wire.js';

export interface ProjectSummary { owner: string; number: number; title: string }
/** The GitHub calls the wizard and doctor need: Projects, repos, trees. */
export interface GitHubSetup {
  viewer(): Promise<{ login: string; orgs: string[] }>;
  /** Open Projects of a user or org, all pages. */
  listProjects(owner: string): Promise<ProjectSummary[]>;
  createProject(owner: string, title: string): Promise<ProjectSummary>;
  /** Adds missing options to the Status field and keeps the existing ones (their ids, so items keep their values). Returns the names added. */
  ensureStatusOptions(ref: ProjectRef, names: string[]): Promise<string[]>;
  /** null: not found or not visible. */
  repo(r: RepoRef): Promise<{ defaultBranch: string } | null>;
  branchExists(r: RepoRef, branch: string): Promise<boolean>;
  /** Blob paths, recursive tree. */
  listFiles(r: RepoRef, ref: string): Promise<string[]>;
  readFile(r: RepoRef, ref: string, path: string): Promise<string | null>;
}
export type GitHubSetupFor = (login: string) => GitHubSetup;

const PAGE_FIELDS = `projectsV2(first: 100, after: $after) { nodes { number title closed } pageInfo { hasNextPage endCursor } }`;
const LIST_QUERY = `query($owner: String!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on User { ${PAGE_FIELDS} }
    ... on Organization { ${PAGE_FIELDS} }
  }
}`;
const OWNER_QUERY = `query($owner: String!) { repositoryOwner(login: $owner) { id } }`;
const CREATE = `mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title }) { projectV2 { number title } }
}`;
const STATUS_FIELDS = `id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name color description } } }`;
const STATUS_QUERY = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    ... on User { projectV2(number: $number) { ${STATUS_FIELDS} } }
    ... on Organization { projectV2(number: $number) { ${STATUS_FIELDS} } }
  }
}`;
// GitHub's reference: provided options overwrite the existing ones, and an option's `id` keeps its identity so items keep their values.
const UPDATE_OPTIONS = `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
  updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
}`;

interface ExistingOption { id: string; name: string; color: string; description: string }
interface ProjectsPage {
  repositoryOwner: { projectsV2?: { nodes: ({ number: number; title: string; closed: boolean } | null)[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null;
}
interface StatusRes {
  repositoryOwner: { projectV2?: { field: { id?: string; options?: ExistingOption[] } | null } | null } | null;
}
const isNotFound = (e: unknown) => (e as { status?: unknown } | null)?.status === 404;

export class OctokitGitHubSetup implements GitHubSetup {
  private readonly octokit: Octokit;

  constructor(token: string, opts?: { fetch?: typeof fetch }) {
    this.octokit = new Octokit({ auth: token, ...(opts?.fetch ? { request: { fetch: opts.fetch } } : {}) });
  }

  async viewer() {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    const orgs = await this.octokit.paginate(this.octokit.rest.orgs.listForAuthenticatedUser, { per_page: 100 });
    return { login: data.login, orgs: orgs.map((o) => o.login) };
  }

  async listProjects(owner: string): Promise<ProjectSummary[]> {
    const out: ProjectSummary[] = [];
    let after: string | null = null;
    for (;;) {
      const res: ProjectsPage = await this.octokit.graphql(LIST_QUERY, { owner, after });
      const page = res.repositoryOwner?.projectsV2;
      if (!page) return out;
      for (const n of page.nodes) if (n && !n.closed) out.push({ owner, number: n.number, title: n.title });
      if (!page.pageInfo.hasNextPage) return out;
      after = page.pageInfo.endCursor;
    }
  }

  async createProject(owner: string, title: string): Promise<ProjectSummary> {
    const o: { repositoryOwner: { id: string } | null } = await this.octokit.graphql(OWNER_QUERY, { owner });
    if (!o.repositoryOwner) throw new Error(`GitHub user or org "${owner}" not found`);
    const res: { createProjectV2: { projectV2: { number: number; title: string } } } = await this.octokit.graphql(CREATE, { ownerId: o.repositoryOwner.id, title });
    return { owner, number: res.createProjectV2.projectV2.number, title: res.createProjectV2.projectV2.title };
  }

  async ensureStatusOptions(ref: ProjectRef, names: string[]): Promise<string[]> {
    const res: StatusRes = await this.octokit.graphql(STATUS_QUERY, { owner: ref.owner, number: ref.number });
    const project = res.repositoryOwner?.projectV2;
    if (!project) throw new Error(`Project ${ref.owner}/${ref.number} not found`);
    const field = project.field;
    if (!field?.id) throw new Error(`Project ${ref.owner}/${ref.number} has no single select field named "Status"`);
    const existing = field.options ?? [];
    const missing = [...new Set(names)].filter((n) => !existing.some((e) => e.name === n));
    if (!missing.length) return [];
    // Existing options go back with their ids, colour and description; options sent without ids would clear items' Status.
    const options = [
      ...existing.map((e) => ({ id: e.id, name: e.name, color: e.color, description: e.description ?? '' })),
      ...missing.map((name) => ({ name, color: 'GRAY', description: '' })),
    ];
    await this.octokit.graphql(UPDATE_OPTIONS, { fieldId: field.id, options });
    return missing;
  }

  async repo(r: RepoRef) {
    try {
      const { data } = await this.octokit.rest.repos.get({ owner: r.owner, repo: r.repo });
      return { defaultBranch: data.default_branch };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async branchExists(r: RepoRef, branch: string): Promise<boolean> {
    try {
      await this.octokit.rest.repos.getBranch({ owner: r.owner, repo: r.repo, branch });
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async listFiles(r: RepoRef, ref: string): Promise<string[]> {
    let data: { truncated?: boolean; tree: { type?: string; path?: string }[] };
    try {
      ({ data } = await this.octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1', { owner: r.owner, repo: r.repo, tree_sha: ref }));
    } catch (e) {
      if ((e as { status?: unknown } | null)?.status === 409) return []; // an empty repo has no tree
      throw e;
    }
    if (data.truncated) throw new Error(`The file tree of ${r.owner}/${r.repo} is too large to list; add the checks by hand`);
    return data.tree.filter((t) => t.type === 'blob' && t.path).map((t) => t.path as string);
  }

  async readFile(r: RepoRef, ref: string, path: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({ owner: r.owner, repo: r.repo, path, ref });
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
}

const ownerKey = (o: string, n?: number) => (n === undefined ? o.toLowerCase() : `${o.toLowerCase()}/${n}`);
const repoKey = (r: RepoRef) => `${r.owner}/${r.repo}`.toLowerCase();

/** In-memory GitHubSetup for tests. Keys are lower-cased: projects by owner, statusOptions by `owner/number`, repos by `owner/repo`, files by `owner/repo@ref`. */
export class FakeGitHubSetup implements GitHubSetup {
  me = { login: 'me', orgs: [] as string[] };
  readonly projects = new Map<string, ProjectSummary[]>();
  readonly statusOptions = new Map<string, string[]>();
  readonly repos = new Map<string, { defaultBranch: string; branches: string[] }>();
  readonly files = new Map<string, Record<string, string>>();
  readonly addedOptions: { project: string; names: string[] }[] = [];

  async viewer() { return this.me; }
  async listProjects(owner: string) { return [...(this.projects.get(ownerKey(owner)) ?? [])]; }
  async createProject(owner: string, title: string) {
    const list = this.projects.get(ownerKey(owner)) ?? [];
    const p = { owner, number: list.reduce((m, x) => Math.max(m, x.number), 0) + 1, title };
    this.projects.set(ownerKey(owner), [...list, p]);
    this.statusOptions.set(ownerKey(owner, p.number), ['Todo', 'In Progress', 'Done']);
    return p;
  }
  async ensureStatusOptions(ref: ProjectRef, names: string[]) {
    const key = ownerKey(ref.owner, ref.number);
    const have = this.statusOptions.get(key) ?? [];
    const added = [...new Set(names)].filter((n) => !have.includes(n));
    if (added.length) {
      this.statusOptions.set(key, [...have, ...added]);
      this.addedOptions.push({ project: key, names: added });
    }
    return added;
  }
  async repo(r: RepoRef) {
    const x = this.repos.get(repoKey(r));
    return x ? { defaultBranch: x.defaultBranch } : null;
  }
  async branchExists(r: RepoRef, branch: string) {
    const x = this.repos.get(repoKey(r));
    return !!x && (x.defaultBranch === branch || x.branches.includes(branch));
  }
  async listFiles(r: RepoRef, ref: string) { return Object.keys(this.files.get(`${repoKey(r)}@${ref}`) ?? {}); }
  async readFile(r: RepoRef, ref: string, path: string) { return this.files.get(`${repoKey(r)}@${ref}`)?.[path] ?? null; }
}

/** One login's setup client, created on its first call from the login's token. */
class LazyGitHubSetup implements GitHubSetup {
  private readonly loader: LoadOnce<GitHubSetup>;
  constructor(user: string, read: (user: string) => Promise<string>, make: (token: string) => GitHubSetup) {
    this.loader = new LoadOnce(user, read, make);
  }
  viewer() { return this.loader.run((c) => c.viewer()); }
  listProjects(owner: string) { return this.loader.run((c) => c.listProjects(owner)); }
  createProject(owner: string, title: string) { return this.loader.run((c) => c.createProject(owner, title)); }
  ensureStatusOptions(ref: ProjectRef, names: string[]) { return this.loader.run((c) => c.ensureStatusOptions(ref, names)); }
  repo(r: RepoRef) { return this.loader.run((c) => c.repo(r)); }
  branchExists(r: RepoRef, branch: string) { return this.loader.run((c) => c.branchExists(r, branch)); }
  listFiles(r: RepoRef, ref: string) { return this.loader.run((c) => c.listFiles(r, ref)); }
  readFile(r: RepoRef, ref: string, path: string) { return this.loader.run((c) => c.readFile(r, ref, path)); }
}

/** `GitHubSetupFor` over the logged-in accounts: the token is read on first use, one client per login. */
export function lazyGitHubSetupFor(
  read?: (login: string) => Promise<string>,
  exec: ExecFile = realExecFile,
): GitHubSetupFor {
  const readToken = read ?? ((login: string) => readGhToken(login, exec));
  const clients = new Map<string, GitHubSetup>();
  return (login) => {
    let c = clients.get(login);
    if (!c) clients.set(login, (c = new LazyGitHubSetup(login, readToken, (t) => new OctokitGitHubSetup(t))));
    return c;
  };
}
