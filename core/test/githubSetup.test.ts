import { describe, expect, test, vi } from 'vitest';
import { FakeGitHubSetup, OctokitGitHubSetup, lazyGitHubSetupFor } from '../src/githubSetup.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const urlOf = (u: Request | string | URL) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url);
type Call = [Request | string | URL, RequestInit | undefined];
const bodyOf = (call: unknown) => JSON.parse(String((call as Call)[1]?.body)) as { query: string; variables: Record<string, unknown> };
const setup = (f: unknown) => new OctokitGitHubSetup('t', { fetch: f as typeof fetch });

describe('OctokitGitHubSetup', () => {
  test('listProjects pages through a user and an org, open only', async () => {
    const pages = [
      { projectsV2: { nodes: [{ number: 1, title: 'A', closed: false }, { number: 2, title: 'Old', closed: true }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
      { projectsV2: { nodes: [{ number: 3, title: 'B', closed: false }], pageInfo: { hasNextPage: false, endCursor: null } } },
    ];
    const f = vi.fn(async () => json({ data: { repositoryOwner: pages.shift() } }));
    expect(await setup(f).listProjects('acme')).toEqual([{ owner: 'acme', number: 1, title: 'A' }, { owner: 'acme', number: 3, title: 'B' }]);
    expect(bodyOf(f.mock.calls[1]).variables).toEqual({ owner: 'acme', after: 'c1' });
    expect(bodyOf(f.mock.calls[0]).query).toContain('... on Organization');
    expect(bodyOf(f.mock.calls[0]).query).toContain('... on User');
  });

  test('createProject looks up the owner id then creates', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ data: { repositoryOwner: { id: 'O1' } } }))
      .mockResolvedValueOnce(json({ data: { createProjectV2: { projectV2: { number: 7, title: 'Factory' } } } }));
    expect(await setup(f).createProject('acme', 'Factory')).toEqual({ owner: 'acme', number: 7, title: 'Factory' });
    expect(bodyOf(f.mock.calls[1]).variables).toEqual({ ownerId: 'O1', title: 'Factory' });
  });

  test('ensureStatusOptions sends existing options with their ids plus the missing names and returns only the added', async () => {
    const field = { id: 'F1', options: [{ id: 'o1', name: 'Todo', color: 'GREEN', description: 'd' }, { id: 'o2', name: 'Done', color: 'RED', description: '' }] };
    const f = vi.fn()
      .mockResolvedValueOnce(json({ data: { repositoryOwner: { projectV2: { id: 'P1', field } } } }))
      .mockResolvedValueOnce(json({ data: { updateProjectV2Field: { projectV2Field: { id: 'F1' } } } }));
    const added = await setup(f).ensureStatusOptions({ owner: 'acme', number: 3 }, ['Todo', 'Review']);
    expect(added).toEqual(['Review']);
    const sent = bodyOf(f.mock.calls[1]).variables;
    expect(sent.fieldId).toBe('F1');
    expect(sent.options).toEqual([
      { id: 'o1', name: 'Todo', color: 'GREEN', description: 'd' }, { id: 'o2', name: 'Done', color: 'RED', description: '' },
      { name: 'Review', color: 'GRAY', description: '' }]);
  });

  test('ensureStatusOptions makes no update when nothing is missing', async () => {
    const field = { id: 'F1', options: [{ id: 'o1', name: 'Todo', color: 'GREEN', description: '' }] };
    const f = vi.fn(async () => json({ data: { repositoryOwner: { projectV2: { id: 'P1', field } } } }));
    expect(await setup(f).ensureStatusOptions({ owner: 'a', number: 1 }, ['Todo'])).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test('repo returns null on 404 and the default branch otherwise', async () => {
    expect(await setup(vi.fn(async () => json({ message: 'Not Found' }, 404))).repo({ owner: 'o', repo: 'r' })).toBeNull();
    expect(await setup(vi.fn(async () => json({ default_branch: 'main' }))).repo({ owner: 'o', repo: 'r' })).toEqual({ defaultBranch: 'main' });
  });

  test('branchExists is false on 404', async () => {
    expect(await setup(vi.fn(async () => json({}, 404))).branchExists({ owner: 'o', repo: 'r' }, 'dev')).toBe(false);
    expect(await setup(vi.fn(async () => json({ name: 'dev' }))).branchExists({ owner: 'o', repo: 'r' }, 'dev')).toBe(true);
  });

  test('listFiles reads the recursive tree and keeps blobs only', async () => {
    const f = vi.fn(async () => json({ truncated: false, tree: [{ path: 'a', type: 'tree' }, { path: 'a/b.txt', type: 'blob' }, { path: 'c', type: 'commit' }] }));
    expect(await setup(f).listFiles({ owner: 'o', repo: 'r' }, 'dev')).toEqual(['a/b.txt']);
    expect(urlOf((f.mock.calls[0] as unknown as Call)[0])).toMatch(/git\/trees\/dev\?recursive=1/);
  });

  test('readFile decodes base64 and returns null on 404', async () => {
    const content = Buffer.from('hello').toString('base64');
    expect(await setup(vi.fn(async () => json({ type: 'file', encoding: 'base64', content }))).readFile({ owner: 'o', repo: 'r' }, 'dev', 'x')).toBe('hello');
    expect(await setup(vi.fn(async () => json({}, 404))).readFile({ owner: 'o', repo: 'r' }, 'dev', 'x')).toBeNull();
  });

  test('viewer returns the login and org logins', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ login: 'me' }))
      .mockResolvedValueOnce(json([{ login: 'acme' }]));
    expect(await setup(f).viewer()).toEqual({ login: 'me', orgs: ['acme'] });
  });
});

describe('OctokitGitHubSetup edge cases', () => {
  const r = { owner: 'o', repo: 'r' };
  test('listFiles throws a clear error on a truncated tree', async () => {
    const f = vi.fn(async () => json({ truncated: true, tree: [{ path: 'a', type: 'blob' }] }));
    await expect(setup(f).listFiles(r, 'dev')).rejects.toThrow(/o\/r is too large/);
  });
  test('listFiles of an empty repo (409) is empty', async () => {
    expect(await setup(vi.fn(async () => json({ message: 'Git Repository is empty.' }, 409))).listFiles(r, 'main')).toEqual([]);
  });
  test('ensureStatusOptions reports a missing project', async () => {
    const f = vi.fn(async () => json({ data: { repositoryOwner: { projectV2: null } } }));
    await expect(setup(f).ensureStatusOptions({ owner: 'acme', number: 9 }, ['Todo'])).rejects.toThrow('Project acme/9 not found');
  });
});

describe('FakeGitHubSetup and lazyGitHubSetupFor', () => {
  test('fake records added options, keeps existing ones', async () => {
    const fake = new FakeGitHubSetup();
    fake.projects.set('acme', [{ owner: 'acme', number: 1, title: 'P' }]);
    fake.statusOptions.set('acme/1', ['Todo']);
    expect(await fake.ensureStatusOptions({ owner: 'acme', number: 1 }, ['Todo', 'Done'])).toEqual(['Done']);
    expect(fake.statusOptions.get('acme/1')).toEqual(['Todo', 'Done']);
    expect(fake.addedOptions).toEqual([{ project: 'acme/1', names: ['Done'] }]);
  });

  test('one client per login, token read once', async () => {
    const read = vi.fn(async (l: string) => `tok-${l}`);
    const forLogin = lazyGitHubSetupFor(read);
    expect(forLogin('a')).toBe(forLogin('a'));
    expect(read).not.toHaveBeenCalled();
  });
});
