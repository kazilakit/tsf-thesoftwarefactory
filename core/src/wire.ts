import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { shellExec } from './checks.js';
import { localStoreDir } from './storeSelect.js';
import { Engine } from './engine.js';
import { LocalGitRepos } from './git.js';
import { OctokitGitHub, type GitHub, type GitHubFor } from './github.js';
import { FactoryConfig } from './factories.js';
import { OctokitGitHubBoard, type GitHubBoard, type GitHubBoardFor, type ProjectInfo, type RepoRef } from './githubBoard.js';
import type { ProjectRef } from './githubConfig.js';
import { GhLoginMissingError, readGhToken, realExecFile, SecretMissingError, type ExecFile } from './secrets.js';
import { FileStore, type BoardStore } from './store.js';
import type { Mode } from './types.js';

export interface WireOptions {
  root: string;
  mode: Mode;
  /** Where the engine's operational notes go. */
  log?: (msg: string) => void;
}

/** A factory root has core/package.json and plugin/.claude-plugin/plugin.json named `factory`; an unreadable manifest means no. */
function isFactoryRoot(dir: string): boolean {
  try {
    if (!existsSync(join(dir, 'core', 'package.json'))) return false;
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')) as { name?: unknown };
    return manifest?.name === 'factory';
  } catch {
    return false;
  }
}

/** `FACTORY_ROOT`, else the nearest parent folder of the cwd that is a factory root. */
export function findRoot(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.FACTORY_ROOT) return resolve(env.FACTORY_ROOT);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (isFactoryRoot(dir)) return dir;
    if (dirname(dir) === dir) throw new Error('factory root not found (set FACTORY_ROOT or run inside the factory folder)');
  }
}

/** Builds a gh login's client from its token on the first use (one read, a failed read is not cached); a missing login becomes GhLoginMissingError. */
export class LoadOnce<T> {
  private inner: Promise<T> | undefined;
  constructor(
    private readonly user: string,
    private readonly read: (user: string) => Promise<string>,
    private readonly make: (token: string) => T,
  ) {}
  get(): Promise<T> {
    if (!this.inner) {
      const loading = this.read(this.user).then(
        (token) => this.make(token),
        (e: unknown) => { throw e instanceof SecretMissingError && !(e instanceof GhLoginMissingError) ? new GhLoginMissingError(this.user) : e; },
      );
      loading.catch(() => { if (this.inner === loading) this.inner = undefined; });
      this.inner = loading;
    }
    return this.inner;
  }
  /** Forgets the client, so the next get() reads the token again. */
  reset(): void {
    this.inner = undefined;
  }
  /** Runs a call on the client; a 401 resets it (a new `gh auth login` takes effect) and the error is rethrown. */
  async run<R>(fn: (client: T) => Promise<R>): Promise<R> {
    const client = await this.get();
    try {
      return await fn(client);
    } catch (e) {
      if ((e as { status?: unknown } | null)?.status === 401) this.reset();
      throw e;
    }
  }
}

/** One GitHub client per gh login, each created on its first call, so commands that never touch GitHub read no token. A failed read is not cached. */
class LazyGitHub implements GitHub {
  private readonly loader: LoadOnce<GitHub>;
  constructor(user: string, read: (user: string) => Promise<string>, make: (token: string) => GitHub) {
    this.loader = new LoadOnce(user, read, make);
  }
  private get gh(): Promise<GitHub> {
    return this.loader.get();
  }
  async ensureReady() {
    await this.gh;
  }
  async openPr(p: Parameters<GitHub['openPr']>[0]) {
    return this.loader.run((c) => c.openPr(p));
  }
  async findOpenPr(p: Parameters<GitHub['findOpenPr']>[0]) {
    return this.loader.run((c) => c.findOpenPr(p));
  }
  async prState(url: string) {
    return this.loader.run((c) => c.prState(url));
  }
  async prReviews(url: string) {
    return this.loader.run((c) => c.prReviews(url));
  }
  async mergePr(url: string, base: string, protectedBranches?: readonly string[]) {
    return this.loader.run((c) => c.mergePr(url, base, protectedBranches));
  }
}

/** `GitHubFor` over the gh CLI logins (`gh auth token --user <ghUser>`): lazy, and one client per login. */
export function lazyGitHubFor(
  read?: (user: string) => Promise<string>,
  make: (token: string) => GitHub = (token) => new OctokitGitHub(token),
  exec: ExecFile = realExecFile,
): GitHubFor {
  const readToken = read ?? ((user: string) => readGhToken(user, exec));
  const clients = new Map<string, GitHub>();
  return (user) => {
    let c = clients.get(user);
    if (!c) clients.set(user, (c = new LazyGitHub(user, readToken, make)));
    return c;
  };
}

/** The GitHubBoard of one gh login, created on its first call like LazyGitHub. */
class LazyGitHubBoard implements GitHubBoard {
  private readonly loader: LoadOnce<GitHubBoard>;
  constructor(user: string, read: (user: string) => Promise<string>, make: (token: string) => GitHubBoard) {
    this.loader = new LoadOnce(user, read, make);
  }
  private get b(): Promise<GitHubBoard> {
    return this.loader.get();
  }
  async ensureReady() {
    await this.b;
  }
  async tokenScopes() {
    return this.loader.run((c) => c.tokenScopes());
  }
  async project(p: ProjectRef) {
    return this.loader.run((c) => c.project(p));
  }
  async listItems(p: ProjectInfo) {
    return this.loader.run((c) => c.listItems(p));
  }
  async createIssue(r: RepoRef, i: Parameters<GitHubBoard['createIssue']>[1]) {
    return this.loader.run((c) => c.createIssue(r, i));
  }
  async updateIssue(r: RepoRef, number: number, patch: Parameters<GitHubBoard['updateIssue']>[2]) {
    return this.loader.run((c) => c.updateIssue(r, number, patch));
  }
  async closeIssue(r: RepoRef, number: number, reason: 'completed' | 'not_planned') {
    return this.loader.run((c) => c.closeIssue(r, number, reason));
  }
  async addLabels(r: RepoRef, number: number, labels: string[]) {
    return this.loader.run((c) => c.addLabels(r, number, labels));
  }
  async addToProject(p: ProjectInfo, issueNodeId: string) {
    return this.loader.run((c) => c.addToProject(p, issueNodeId));
  }
  async setStatus(p: ProjectInfo, itemId: string, option: string) {
    return this.loader.run((c) => c.setStatus(p, itemId, option));
  }
  async listComments(r: RepoRef, number: number, since?: string) {
    return this.loader.run((c) => c.listComments(r, number, since));
  }
  async addComment(r: RepoRef, number: number, body: string) {
    return this.loader.run((c) => c.addComment(r, number, body));
  }
  async reactToComment(r: RepoRef, commentId: number, content: '+1') {
    return this.loader.run((c) => c.reactToComment(r, commentId, content));
  }
  async labelExists(r: RepoRef, name: string) {
    return this.loader.run((c) => c.labelExists(r, name));
  }
  async createLabel(r: RepoRef, name: string) {
    return this.loader.run((c) => c.createLabel(r, name));
  }
}

/** `GitHubBoardFor` over the gh CLI logins: lazy, and one client per login. */
export function lazyGitHubBoardFor(
  read?: (user: string) => Promise<string>,
  make: (token: string) => GitHubBoard = (token) => new OctokitGitHubBoard(token),
  exec: ExecFile = realExecFile,
): GitHubBoardFor {
  const readToken = read ?? ((user: string) => readGhToken(user, exec));
  const clients = new Map<string, GitHubBoard>();
  return (user) => {
    let c = clients.get(user);
    if (!c) clients.set(user, (c = new LazyGitHubBoard(user, readToken, make)));
    return c;
  };
}

export async function wire(o: WireOptions): Promise<{ engine: Engine; store: BoardStore }> {
  const store: BoardStore = new FileStore(join(localStoreDir(o.root), 'board.json'), { factoriesDir: join(o.root, 'factories'), ...(o.log ? { log: o.log } : {}) });
  const engine = new Engine({
    store,
    git: new LocalGitRepos(o.root),
    githubFor: lazyGitHubFor(),
    factories: async () => new FactoryConfig(await store.listFactoryDefs(), await store.listFactoryRepos()),
    exec: shellExec,
    now: () => new Date(),
    mode: o.mode,
    claimant: process.env.FACTORY_CLAIMANT || `${o.mode}:${hostname()}`,
    ...(o.log ? { log: o.log } : {}),
  });
  return { engine, store };
}
