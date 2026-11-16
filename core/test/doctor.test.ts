import { describe, expect, test } from 'vitest';
import { doctor } from '../src/doctor.js';
import { FakeGitHubSetup } from '../src/githubSetup.js';
import { FakeGitHubBoard, type GitHubBoard } from '../src/githubBoard.js';
import { defFixture, repoFixture } from './factoryFixtures.js';

const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
  plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
  pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as const;
const OPTIONS = ['Backlog', 'Todo', 'In progress', 'In review', 'Merged'];
const gh = (over: { label?: string; statusMap?: Record<string, string> } = {}) => ({
  mode: 'github-only' as const, project: { owner: 'octo-user', number: 3 }, label: over.label ?? 'factory',
  approvers: ['octo-user'], statusMap: (over.statusMap ?? map) as never,
});
const def = (id: string, github?: ReturnType<typeof gh>, ghUser = 'octo-user') => defFixture(id, { ghUser, ...(github ? { github } : {}) });
const LOGGED = new Set(['octo-user']);
const SKIPPED = 'not needed: nothing in this factory uses GitHub';

function setup(options: string[] | null = OPTIONS) {
  const board = new FakeGitHubBoard();
  if (options) board.addProject({ owner: 'octo-user', number: 3 }, options);
  return board;
}
const run = (board: GitHubBoard, defs: ReturnType<typeof def>[], repos = defs.map((d) => repoFixture(d.factoryId, 'api')), more: { loggedIn?: Set<string>; only?: string[] } = {}) =>
  doctor({ defs, repos, loggedIn: more.loggedIn ?? LOGGED, boardFor: () => board, ...(more.only ? { only: more.only } : {}) });
const names = (c: { check: string }[]) => c.map((x) => x.check);

describe('doctor', () => {
  test('factory without github: only the login check', async () => {
    expect(await run(setup(), [def('a')])).toEqual([{ factoryId: 'a', check: 'gh login', ok: true, detail: 'octo-user logged in' }]);
  });

  test('not logged in stops that factory, the next is still checked', async () => {
    const out = await run(setup(), [def('a', gh(), 'someone'), def('b')]);
    expect(out).toEqual([
      { factoryId: 'a', check: 'gh login', ok: false, detail: 'someone is not logged in (run: gh auth login --hostname github.com)' },
      { factoryId: 'b', check: 'gh login', ok: true, detail: 'octo-user logged in' },
    ]);
  });

  test('an inactive factory is skipped with one passing line, the next is still checked', async () => {
    const off = defFixture('a', { ghUser: 'someone', active: false });
    const out = await doctor({ defs: [off, def('b')], repos: [repoFixture('b', 'api')], loggedIn: LOGGED, boardFor: () => setup() });
    expect(out).toEqual([
      { factoryId: 'a', check: 'active', ok: true, detail: 'skipped: the factory is inactive (name it with --factory to check it)' },
      { factoryId: 'b', check: 'gh login', ok: true, detail: 'octo-user logged in' },
    ]);
  });

  test('an inactive factory named with --factory is checked in full', async () => {
    const off = defFixture('a', { ghUser: 'someone', active: false });
    expect(await run(setup(), [off], undefined, { only: ['a'] })).toEqual([
      { factoryId: 'a', check: 'gh login', ok: false, detail: 'someone is not logged in (run: gh auth login --hostname github.com)' },
    ]);
  });

  test('all good: checks in order', async () => {
    const board = setup();
    board.labels.set('org/api', new Set(['factory']));
    const out = await run(board, [def('a', gh())]);
    expect(names(out)).toEqual(['gh login', 'config', 'scope', 'project', 'status options', 'label api']);
    expect(out.every((c) => c.ok)).toBe(true);
    expect(out.find((c) => c.check === 'status options')!.detail).toBe('all 13 statuses map to existing options');
    expect(out.at(-1)!.detail).toBe('exists');
  });

  test('missing project scope skips project and status options but not labels', async () => {
    const board = setup();
    board.scopes = ['repo'];
    const out = await run(board, [def('a', gh())]);
    expect(names(out)).toEqual(['gh login', 'config', 'scope', 'label api']);
    expect(out[2]).toMatchObject({ ok: false, detail: 'the gh login needs the project scope (run: gh auth refresh -s project)' });
  });

  test('a token without OAuth scopes fails the scope check with its own detail', async () => {
    const board = setup();
    board.scopes = null;
    const out = await run(board, [def('a', gh())]);
    expect(out.find((c) => c.check === 'scope')).toMatchObject({
      ok: false,
      detail: 'the gh login token has no OAuth scopes (fine-grained or app token); log in with gh auth login to get a token with the project scope',
    });
    expect(names(out)).not.toContain('project');
  });

  test('project not found', async () => {
    const out = await run(setup(null), [def('a', gh())]);
    expect(out.find((c) => c.check === 'project')).toMatchObject({ ok: false, detail: 'project octo-user/3 not found or not visible to octo-user' });
    expect(names(out)).not.toContain('status options');
  });

  test('missing status options are listed once, in status order', async () => {
    const one = await run(setup(['Backlog', 'Todo', 'In progress', 'In review']), [def('a', gh())]);
    expect(one.find((c) => c.check === 'status options')).toMatchObject({ ok: false, detail: 'missing on the Project: Merged' });
    const two = await run(setup(['Backlog', 'Todo', 'In progress']), [def('a', gh())]);
    expect(two.find((c) => c.check === 'status options')!.detail).toBe('missing on the Project: In review, Merged');
  });

  test('option names match exactly', async () => {
    const out = await run(setup(['Backlog', 'Todo', 'in progress', 'In review', 'Merged']), [def('a', gh())]);
    expect(out.find((c) => c.check === 'status options')).toMatchObject({ ok: false, detail: 'missing on the Project: In progress' });
  });

  test('labels: missing is ok, empty label means no filter', async () => {
    const out = await run(setup(), [def('a', gh())]);
    expect(out.at(-1)).toMatchObject({ check: 'label api', ok: true, detail: 'missing; created on first push' });
    const none = await run(setup(), [def('a', gh({ label: '' }))]);
    expect(none.at(-1)).toMatchObject({ check: 'label api', ok: true, detail: 'no label filter' });
  });

  test('one label check per repo in repoId order', async () => {
    const d = def('a', gh());
    const out = await run(setup(), [d], [repoFixture('a', 'web', { remote: 'git@github.com:org/web.git' }), repoFixture('a', 'api')]);
    expect(names(out).slice(-2)).toEqual(['label api', 'label web']);
  });

  test('config problems become failing config checks', async () => {
    const a = def('a', gh());
    const b = def('b', gh());
    const out = await run(setup(), [a, b], [repoFixture('a', 'api'), repoFixture('b', 'api')]);
    expect(out.filter((c) => c.check.startsWith('config'))).toEqual([
      { factoryId: 'a', check: 'config', ok: true, detail: 'ok' },
      { factoryId: 'b', check: 'config api', ok: false, detail: 'org/api is already used by a/api; a GitHub repo can belong to only one factory repo' },
    ]);
  });

  test('only limits the factories checked but duplicates are still found', async () => {
    const a = def('a', gh());
    const b = def('b', gh());
    const out = await run(setup(), [a, b], [repoFixture('a', 'api'), repoFixture('b', 'api')], { only: ['b'] });
    expect(new Set(out.map((c) => c.factoryId))).toEqual(new Set(['b']));
    expect(out.some((c) => c.check.startsWith('config') && !c.ok)).toBe(true);
  });

  test('a client error fails the check with its first line and the next factory is still checked', async () => {
    const bad: GitHubBoard = Object.assign(Object.create(setup()) as GitHubBoard, {
      tokenScopes: async () => { throw new Error('boom gho_secret123\nsecond line'); },
    });
    const out = await doctor({ defs: [def('a', gh()), def('b')], repos: [], loggedIn: LOGGED, boardFor: () => bad });
    expect(out.find((c) => c.check === 'scope')).toMatchObject({ ok: false, detail: 'boom [redacted]' });
    expect(out.at(-1)).toMatchObject({ factoryId: 'b', check: 'gh login' });
  });

  test('a Project without a Status field fails the project check', async () => {
    const board = setup();
    board.project = async () => { throw new Error('Project octo-user/3 has no single select field named "Status"'); };
    const out = await run(board, [def('a', gh())]);
    expect(out.find((c) => c.check === 'project')).toMatchObject({ ok: false });
  });

  test('no detail carries a token', async () => {
    const board = setup();
    board.project = async () => { throw new Error('Bad credentials for github_pat_ABC_123'); };
    const out = await run(board, [def('a', gh())]);
    expect(out.find((c) => c.check === 'project')).toMatchObject({ ok: false, detail: 'Bad credentials for [redacted]' });
    expect(out.some((c) => /\b(?:gh[opsur]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/.test(c.detail))).toBe(false);
  });

  test('an empty label makes no labelExists call', async () => {
    const board = setup();
    let calls = 0;
    board.labelExists = async () => { calls++; return true; };
    await run(board, [def('a', gh({ label: '' }))]);
    expect(calls).toBe(0);
  });

  test('a repo with a non-GitHub remote gets no label check', async () => {
    const out = await run(setup(), [def('a', gh())], [repoFixture('a', 'api', { remote: 'git@example.com:org/api.git' })]);
    expect(names(out).some((n) => n.startsWith('label'))).toBe(false);
  });
});

describe('doctor', () => {
  describe('factory.yaml and repo access', () => {
    const setupFake = (...repos: [string, string[]][]) => {
      const f = new FakeGitHubSetup();
      for (const [k, branches] of repos) f.repos.set(k, { defaultBranch: 'main', branches });
      return f;
    };
    const withSetup = (f: FakeGitHubSetup, defs: ReturnType<typeof def>[], repos: ReturnType<typeof repoFixture>[], more: object = {}) =>
      doctor({ defs, repos, loggedIn: LOGGED, boardFor: () => setup(), setupFor: () => f, ...more });

    test('a factory.yaml problem is a failing config file check with the fix', async () => {
      const out = await doctor({
        defs: [def('a')], repos: [], loggedIn: LOGGED, boardFor: () => setup(),
        fileProblems: [{ factoryId: 'gone', file: '/f/gone/factory.yaml', reason: 'factory.agents.build: bad model' }, { factoryId: 'a', file: '/f/a/factory.yaml', reason: 'x: y' }],
      });
      expect(out).toEqual([
        { factoryId: 'a', check: 'config file', ok: false, detail: '/f/a/factory.yaml: x: y; fix the file or run ./factory init' },
        { factoryId: 'a', check: 'gh login', ok: true, detail: SKIPPED },
        { factoryId: 'gone', check: 'config file', ok: false, detail: '/f/gone/factory.yaml: factory.agents.build: bad model; fix the file or run ./factory init' },
      ]);
    });

    test('repo and base checks per repo, in repoId order, for a factory without github', async () => {
      const f = setupFake(['org/api', ['dev']], ['org/web', []]);
      const out = await withSetup(f, [def('a')], [repoFixture('a', 'web'), repoFixture('a', 'api')]);
      expect(out.map((c) => [c.check, c.ok, c.detail])).toEqual([
        ['gh login', true, 'octo-user logged in'],
        ['repo api', true, 'org/api reachable as octo-user'],
        ['base api', true, 'dev exists'],
        ['repo web', true, 'org/web reachable as octo-user'],
        ['base web', false, 'base branch dev not found on org/web'],
      ]);
    });

    test('an unreachable repo fails repo and skips base', async () => {
      const out = await withSetup(setupFake(), [def('a')], [repoFixture('a', 'api'), repoFixture('a', 'x', { remote: 'git@gitlab.com:o/x.git' })]);
      expect(out.map((c) => [c.check, c.ok, c.detail])).toEqual([
        ['gh login', true, 'octo-user logged in'],
        ['repo api', false, 'org/api not found or not visible to octo-user'],
        ['repo x', false, 'remote is not a GitHub repo (only GitHub is supported)'],
      ]);
    });

    test('a client error fails the repo check with its first line', async () => {
      const f = setupFake();
      f.repo = async () => { throw new Error('boom ghp_abc123\nmore'); };
      const out = await withSetup(f, [def('a')], [repoFixture('a', 'api')]);
      expect(out[1]).toEqual({ factoryId: 'a', check: 'repo api', ok: false, detail: 'boom [redacted]' });
    });

    test('without setupFor no repo checks run (old callers unchanged)', async () => {
      expect(names(await run(setup(), [def('a')]))).toEqual(['gh login']);
    });

    test('a factory where nothing uses GitHub skips the login check (no default login named)', async () => {
      const out = await doctor({ defs: [def('a', undefined, 'octo-user')], repos: [], loggedIn: new Set(), boardFor: () => setup(), setupFor: () => setupFake() });
      expect(out).toEqual([{ factoryId: 'a', check: 'gh login', ok: true, detail: SKIPPED }]);
      expect(JSON.stringify(out)).not.toContain('octo-user');
    });

    test('a factory that uses GitHub with no login set says so and points at ./factory init', async () => {
      const out = await doctor({ defs: [def('a', undefined, '(not set)')], repos: [repoFixture('a', 'api')], loggedIn: new Set(['(not set)']), boardFor: () => setup() });
      expect(out).toEqual([{ factoryId: 'a', check: 'gh login', ok: false, detail: 'no GitHub login is set for this factory (run: ./factory init)' }]);
    });

    test('a factory with repos or a github block still needs the login', async () => {
      const repos = await doctor({ defs: [def('a', undefined, 'someone')], repos: [repoFixture('a', 'api')], loggedIn: new Set(), boardFor: () => setup() });
      expect(repos[0]).toMatchObject({ check: 'gh login', ok: false });
      const board = await doctor({ defs: [def('a', gh(), 'someone')], repos: [], loggedIn: new Set(), boardFor: () => setup() });
      expect(board[0]).toMatchObject({ check: 'gh login', ok: false });
    });

    test('not logged in skips the repo checks', async () => {
      const out = await withSetup(setupFake(['org/api', ['dev']]), [def('a', undefined, 'someone')], [repoFixture('a', 'api')]);
      expect(names(out)).toEqual(['gh login']);
    });
  });
});
