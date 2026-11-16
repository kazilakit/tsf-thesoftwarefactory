import { Octokit } from '@octokit/rest';
import { isProtected, ProtectedBranchError } from './branchGuard.js';
import { parseRemote } from './remote.js';
export { parseRemote };

/** The client for a factory's gh login (its `ghUser`). */
export type GitHubFor = (ghUser: string) => GitHub;

export type PrState = 'open' | 'merged' | 'closed';

/** One review on a PR; `state` is GitHub's, lower-cased. */
export interface PrReview {
  id: number;
  author: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  body: string;
  submittedAt: string | null;
  commitId: string | null;
}

export interface GitHub {
  /** Resolves the credential up front; rejects with GhLoginMissingError when the factory's gh login is not logged in. Clients without a lazy credential omit it. */
  ensureReady?(): Promise<void>;
  openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }>;
  /** The open PR from `head` into `base` in the remote's repo, or null. */
  findOpenPr(p: { remote: string; head: string; base: string }): Promise<{ url: string; number: number } | null>;
  prState(url: string): Promise<PrState>;
  /** The PR's current head commit and all its reviews. */
  prReviews(url: string): Promise<{ headSha: string; reviews: PrReview[] }>;
  /** Merges only when the PR's real base is `base` and not protected (in `protectedBranches`, default dev/stg/main); throws ProtectedBranchError or PrBaseMismatchError otherwise. */
  mergePr(url: string, base: string, protectedBranches?: readonly string[]): Promise<void>;
}

/** The PR targets another base than the one the caller expects; it is never merged. */
export class PrBaseMismatchError extends Error {
  constructor(url: string, actual: string, expected: string) {
    super(`${url} targets ${actual}, not ${expected}; not merged`);
    this.name = 'PrBaseMismatchError';
  }
}

/** Refuses a merge unless the PR's stored base is unprotected and equals the expected base. */
function assertMergeBase(url: string, actual: string, expected: string, protectedBranches?: readonly string[]): void {
  if (isProtected(actual, protectedBranches)) throw new ProtectedBranchError(actual);
  if (actual !== expected) throw new PrBaseMismatchError(url, actual, expected);
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/.exec(url);
  if (!m) throw new Error(`unsupported pull request url: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export class OctokitGitHub implements GitHub {
  private readonly octokit: Octokit;

  constructor(token: string, opts?: { fetch?: typeof fetch }) {
    this.octokit = new Octokit({ auth: token, ...(opts?.fetch ? { request: { fetch: opts.fetch } } : {}) });
  }

  async openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
    const { owner, repo } = parseRemote(p.remote);
    const res = await this.octokit.rest.pulls.create({ owner, repo, head: p.head, base: p.base, title: p.title, body: p.body });
    return { url: res.data.html_url, number: res.data.number };
  }

  async findOpenPr(p: { remote: string; head: string; base: string }): Promise<{ url: string; number: number } | null> {
    const { owner, repo } = parseRemote(p.remote);
    const { data } = await this.octokit.rest.pulls.list({ owner, repo, head: `${owner}:${p.head}`, base: p.base, state: 'open' });
    const pr = data[0];
    return pr ? { url: pr.html_url, number: pr.number } : null;
  }

  async prState(url: string): Promise<PrState> {
    const { owner, repo, number } = parsePrUrl(url);
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    if (data.merged) return 'merged';
    return data.state === 'closed' ? 'closed' : 'open';
  }

  async prReviews(url: string): Promise<{ headSha: string; reviews: PrReview[] }> {
    const { owner, repo, number } = parsePrUrl(url);
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    const list = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
    const reviews = list.map((r) => ({
      id: r.id,
      author: r.user?.login ?? '',
      state: r.state.toLowerCase() as PrReview['state'],
      body: r.body ?? '',
      submittedAt: r.submitted_at ?? null,
      commitId: r.commit_id ?? null,
    }));
    return { headSha: data.head.sha, reviews };
  }

  async mergePr(url: string, base: string, protectedBranches?: readonly string[]): Promise<void> {
    if (isProtected(base, protectedBranches)) throw new ProtectedBranchError(base);
    const { owner, repo, number } = parsePrUrl(url);
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    assertMergeBase(url, data.base.ref, base, protectedBranches);
    await this.octokit.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: 'merge', sha: data.head.sha });
  }
}

export class FakeGitHub implements GitHub {
  readonly prs = new Map<string, { base: string; head: string; state: PrState; headSha: string; reviews: PrReview[] }>();
  private next = 1;
  private reviewId = 1;

  async openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
    if (await this.findOpenPr(p)) throw new Error(`A pull request already exists for ${p.head} into ${p.base}`);
    const number = this.next++;
    const url = `${this.prefix(p.remote)}${number}`;
    this.prs.set(url, { base: p.base, head: p.head, state: 'open', headSha: `sha-${number}-1`, reviews: [] });
    return { url, number };
  }

  async findOpenPr(p: { remote: string; head: string; base: string }): Promise<{ url: string; number: number } | null> {
    const prefix = this.prefix(p.remote);
    for (const [url, pr] of this.prs) {
      if (url.startsWith(prefix) && pr.head === p.head && pr.base === p.base && pr.state === 'open') {
        return { url, number: Number(url.slice(prefix.length)) };
      }
    }
    return null;
  }

  async prState(url: string): Promise<PrState> {
    return this.pr(url).state;
  }

  async prReviews(url: string): Promise<{ headSha: string; reviews: PrReview[] }> {
    const pr = this.pr(url);
    return { headSha: pr.headSha, reviews: pr.reviews.map((r) => ({ ...r })) };
  }

  /** Adds a review; `commitId` defaults to the current head. */
  addReview(url: string, r: { author: string; state: PrReview['state']; body?: string; commitId?: string }): PrReview {
    const pr = this.pr(url);
    const review: PrReview = {
      id: this.reviewId++,
      author: r.author,
      state: r.state,
      body: r.body ?? '',
      submittedAt: new Date().toISOString(),
      commitId: r.commitId ?? pr.headSha,
    };
    pr.reviews.push(review);
    return review;
  }

  /** Moves the head to a new commit (a re-ship); earlier reviews keep their old commit. */
  newHead(url: string): string {
    const pr = this.pr(url);
    const n = Number(/^sha-(\d+)-(\d+)$/.exec(pr.headSha)![2]) + 1;
    pr.headSha = `sha-${/^sha-(\d+)-/.exec(pr.headSha)![1]}-${n}`;
    return pr.headSha;
  }

  async mergePr(url: string, base: string, protectedBranches?: readonly string[]): Promise<void> {
    if (isProtected(base, protectedBranches)) throw new ProtectedBranchError(base);
    const pr = this.pr(url);
    assertMergeBase(url, pr.base, base, protectedBranches);
    pr.state = 'merged';
  }

  setState(url: string, state: PrState): void {
    this.pr(url).state = state;
  }

  private prefix(remote: string): string {
    const { owner, repo } = parseRemote(remote);
    return `https://github.com/${owner}/${repo}/pull/`;
  }

  private pr(url: string) {
    const pr = this.prs.get(url);
    if (!pr) throw new Error(`unknown pull request: ${url}`);
    return pr;
  }
}
