import { describe, expect, test, vi } from 'vitest';
import { ProtectedBranchError } from '../src/branchGuard.js';
import { FakeGitHub, OctokitGitHub, parseRemote, PrBaseMismatchError } from '../src/github.js';

describe('parseRemote', () => {
  test.each([
    ['git@github.com:example-org/blocks-data.git'],
    ['git@github.com:example-org/blocks-data'],
    ['https://github.com/example-org/blocks-data'],
    ['https://github.com/example-org/blocks-data.git'],
  ])('parses %s', (r) => {
    expect(parseRemote(r)).toEqual({ owner: 'example-org', repo: 'blocks-data' });
  });

  test('throws a plain Error for anything else', () => {
    expect(() => parseRemote('ftp://example.com/x')).toThrow(Error);
    expect(() => parseRemote('/local/path')).toThrow('unsupported remote');
  });
});

describe('OctokitGitHub', () => {
  test('mergePr to a protected base rejects before any network call', async () => {
    const fetchStub = vi.fn();
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    await expect(gh.mergePr('https://github.com/o/r/pull/1', 'main')).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('openPr returns url and number', async () => {
    const fetchStub = vi.fn(async () => json({ html_url: 'https://github.com/o/r/pull/7', number: 7 }, 201));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    const res = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'factory/x', base: 'dev', title: 'T', body: 'B' });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7 });
  });

  test.each([
    [{ state: 'open', merged: false }, 'open'],
    [{ state: 'closed', merged: false }, 'closed'],
    [{ state: 'closed', merged: true }, 'merged'],
  ] as const)('prState maps %j to %s', async (body, expected) => {
    const fetchStub = vi.fn(async () => json(body));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    expect(await gh.prState('https://github.com/o/r/pull/3')).toBe(expected);
  });

  const urlOf = (u: Request | string | URL) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url);
  const pull = (baseRef: string) => ({ base: { ref: baseRef }, head: { sha: 'abc123' }, state: 'open', merged: false });

  test('mergePr reads the PR first and merges its head sha with the merge method', async () => {
    const fetchStub = vi.fn(async (u: Request | string | URL, _i?: RequestInit) =>
      urlOf(u).endsWith('/merge') ? json({ merged: true }) : json(pull('feature/x')),
    );
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    await gh.mergePr('https://github.com/o/r/pull/3', 'feature/x');
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchStub.mock.calls[0]![0])).toMatch(/\/repos\/o\/r\/pulls\/3$/);
    const [url, init] = fetchStub.mock.calls[1] as [Request | string, RequestInit | undefined];
    expect(urlOf(url)).toContain('/repos/o/r/pulls/3/merge');
    const body = init?.body ?? (await (url as Request).text());
    expect(JSON.parse(String(body))).toMatchObject({ merge_method: 'merge', sha: 'abc123' });
  });

  test('mergePr refuses a PR whose real base is protected, whatever base the caller passes', async () => {
    const fetchStub = vi.fn(async () => json(pull('dev')));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    await expect(gh.mergePr('https://github.com/o/r/pull/3', 'feature/x')).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test('mergePr refuses a PR whose base differs from the expected one', async () => {
    const fetchStub = vi.fn(async () => json(pull('feature/y')));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    const p = gh.mergePr('https://github.com/o/r/pull/3', 'feature/x');
    await expect(p).rejects.toBeInstanceOf(PrBaseMismatchError);
    await expect(p).rejects.not.toBeInstanceOf(ProtectedBranchError);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test('findOpenPr lists open PRs by owner:head and base', async () => {
    const fetchStub = vi.fn(async (_u: Request | string | URL) => json([{ html_url: 'https://github.com/o/r/pull/9', number: 9 }]));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    const res = await gh.findOpenPr({ remote: 'git@github.com:o/r.git', head: 'factory/T-1-x', base: 'dev' });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/9', number: 9 });
    const u = new URL(urlOf(fetchStub.mock.calls[0]![0]));
    expect(u.pathname).toBe('/repos/o/r/pulls');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ head: 'o:factory/T-1-x', base: 'dev', state: 'open' });
  });

  test('prReviews returns head sha and reviews', async () => {
    const fetchStub = vi.fn(async (u: Request | string | URL) =>
      urlOf(u).includes('/reviews')
        ? json([{ id: 11, user: { login: 'alice' }, state: 'APPROVED', body: 'ok', submitted_at: '2026-01-01T00:00:00Z', commit_id: 'abc123' }])
        : json(pull('dev')),
    );
    const client = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    const res = await client.prReviews('https://github.com/o/r/pull/7');
    expect(res).toEqual({
      headSha: 'abc123',
      reviews: [{ id: 11, author: 'alice', state: 'approved', body: 'ok', submittedAt: '2026-01-01T00:00:00Z', commitId: 'abc123' }],
    });
    const paths = fetchStub.mock.calls.map((c) => new URL(urlOf(c[0])).pathname);
    expect(paths).toContain('/repos/o/r/pulls/7');
    expect(paths).toContain('/repos/o/r/pulls/7/reviews');
  });

  test('findOpenPr returns null when none is open', async () => {
    const fetchStub = vi.fn(async () => json([]));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    expect(await gh.findOpenPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'dev' })).toBeNull();
  });
});

describe('FakeGitHub', () => {
  test('open after openPr, merged after mergePr', async () => {
    const gh = new FakeGitHub();
    const a = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'feature/x', title: 't', body: 'b' });
    const b = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h2', base: 'feature/x', title: 't', body: 'b' });
    expect(a).toEqual({ url: 'https://github.com/o/r/pull/1', number: 1 });
    expect(b.number).toBe(2);
    expect(await gh.prState(a.url)).toBe('open');
    await gh.mergePr(a.url, 'feature/x');
    expect(await gh.prState(a.url)).toBe('merged');
    gh.setState(b.url, 'closed');
    expect(gh.prs.get(b.url)).toMatchObject({ base: 'feature/x', head: 'h2', state: 'closed' });
  });

  test('reviews default to the head commit; newHead moves it', async () => {
    const fake = new FakeGitHub();
    const a = await fake.openPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'feature/x', title: 't', body: 'b' });
    expect(await fake.prReviews(a.url)).toEqual({ headSha: 'sha-1-1', reviews: [] });
    const r1 = fake.addReview(a.url, { author: 'alice', state: 'approved' });
    expect(r1).toMatchObject({ id: 1, author: 'alice', state: 'approved', body: '', commitId: 'sha-1-1' });
    expect(fake.newHead(a.url)).toBe('sha-1-2');
    const r2 = fake.addReview(a.url, { author: 'bob', state: 'changes_requested', body: 'no' });
    expect(r2.id).toBeGreaterThan(r1.id);
    expect(r2.commitId).toBe('sha-1-2');
    const old = fake.addReview(a.url, { author: 'c', state: 'commented', commitId: 'sha-1-1' });
    expect(old.commitId).toBe('sha-1-1');
    const res = await fake.prReviews(a.url);
    expect(res.headSha).toBe('sha-1-2');
    expect(res.reviews).toHaveLength(3);
  });

  test('openPr refuses a second open PR with the same head and base in the same repo, like GitHub', async () => {
    const gh = new FakeGitHub();
    const p = { remote: 'git@github.com:o/r.git', head: 'h', base: 'dev', title: 't', body: 'b' };
    const a = await gh.openPr(p);
    await expect(gh.openPr(p)).rejects.toThrow('already exists');
    await gh.openPr({ ...p, remote: 'git@github.com:o/other.git' });
    gh.setState(a.url, 'closed');
    await expect(gh.openPr(p)).resolves.toMatchObject({ number: 3 });
  });

  test('mergePr to a protected base throws and leaves state', async () => {
    const gh = new FakeGitHub();
    const a = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await expect(gh.mergePr(a.url, 'dev')).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(await gh.prState(a.url)).toBe('open');
  });

  test('mergePr checks the stored base, not the one the caller passes', async () => {
    const gh = new FakeGitHub();
    const intoDev = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await expect(gh.mergePr(intoDev.url, 'feature/x')).rejects.toBeInstanceOf(ProtectedBranchError);
    const intoY = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'feature/y', title: 't', body: 'b' });
    await expect(gh.mergePr(intoY.url, 'feature/x')).rejects.toBeInstanceOf(PrBaseMismatchError);
    expect(await gh.prState(intoDev.url)).toBe('open');
    expect(await gh.prState(intoY.url)).toBe('open');
  });

  test('findOpenPr finds an open PR by repo, head and base', async () => {
    const gh = new FakeGitHub();
    const p = { remote: 'git@github.com:o/r.git', head: 'h', base: 'dev', title: 't', body: 'b' };
    expect(await gh.findOpenPr(p)).toBeNull();
    const a = await gh.openPr(p);
    expect(await gh.findOpenPr(p)).toEqual(a);
    expect(await gh.findOpenPr({ ...p, base: 'stg' })).toBeNull();
    expect(await gh.findOpenPr({ ...p, remote: 'git@github.com:o/other.git' })).toBeNull();
    gh.setState(a.url, 'closed');
    expect(await gh.findOpenPr(p)).toBeNull();
  });
});
