import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { ClaimError, Engine, StageError, UnknownFactoryError, withRetry, type EngineDeps } from '../src/engine.js';
import type { Exec } from '../src/checks.js';
import type { GitRepos } from '../src/git.js';
import { emptyPushed } from '../src/githubLink.js';
import { FakeGitHub, type GitHub } from '../src/github.js';
import { IllegalInputError } from '../src/machine.js';
import { FactoryConfig, type FactoryDef, type FactoryRepo } from '../src/factories.js';
import { normaliseChecks } from '../src/checksSchema.js';
import { defFixture, repoFixture } from './factoryFixtures.js';
import { nextTicket } from './nextTicket.js';
import { GhLoginMissingError, SecretMissingError } from '../src/secrets.js';
import {
  ForbiddenError, MemoryStore, NotFoundError, OwnerOnlyError, RereadAfterUpdateError,
  VersionConflictError, type BoardStore,
} from '../src/store.js';
import type { RepoId, Task } from '../src/types.js';

const ROOT = join(tmpdir(), 'factory-engine-test');
const REMOTE = 'git@github.com:example-org/blocks-data.git';

const DEFS: FactoryDef[] = [defFixture('blocks')];
const OLD_CHECKS = {
  server: { cwd: 'server', build: 'dotnet build', test: 'dotnet test' },
  client: { cwd: 'client', install: 'npm ci', typecheck: 'npm run tc', lint: 'npm run lint', test: 'npm test' },
  e2e: 'off',
} as const;
const CHECKS = (() => {
  const r = normaliseChecks(OLD_CHECKS);
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();
const REPOS: FactoryRepo[] = [
  repoFixture('blocks', 'data', { remote: REMOTE, checks: structuredClone(CHECKS) as never }),
  repoFixture('blocks', 'iam', { remote: 'git@github.com:example-org/blocks-iam.git', checks: structuredClone(CHECKS) as never }),
];

class FakeGit implements GitRepos {
  readonly calls: string[] = [];
  readonly bases: string[] = [];
  readonly pushes: { path: string; branch: string }[] = [];
  /** The protected list each push was given. */
  readonly pushProtected: (readonly string[] | undefined)[] = [];
  async ensureClone(factoryId: string, c: FactoryRepo) {
    this.calls.push(`clone ${factoryId}/${c.repoId}`);
    return join(ROOT, '.clones', factoryId, c.repoId);
  }
  async worktree(_factoryId: string, c: FactoryRepo, taskId: string, branch: string) {
    this.calls.push(`worktree ${taskId} ${branch}`);
    this.bases.push(c.baseBranch);
    return join(ROOT, '.clones', 'worktrees', taskId);
  }
  async push(path: string, branch: string, protectedBranches?: readonly string[]) {
    this.pushes.push({ path, branch });
    this.pushProtected.push(protectedBranches);
  }
  async isClean() {
    return true;
  }
}

function setup(
  opts: { githubFor?: (ghUser: string) => GitHub; failing?: string[]; git?: FakeGit; onExec?: () => Promise<void>; log?: (msg: string) => void; store?: (now: () => Date) => BoardStore; defs?: FactoryDef[]; repos?: FactoryRepo[] } = {},
) {
  const clock = { t: new Date('2026-11-09T10:00:00Z') };
  const store: BoardStore = opts.store?.(() => clock.t) ?? new MemoryStore();
  const git = opts.git ?? new FakeGit();
  const github = new FakeGitHub();
  const exec: Exec = async (cmd) => {
    await opts.onExec?.();
    return { code: opts.failing?.includes(cmd) ? 1 : 0, output: 'out' };
  };
  const deps: EngineDeps = {
    store,
    git,
    githubFor: opts.githubFor ?? (() => github),
    factories: async () => new FactoryConfig(opts.defs ?? DEFS, opts.repos ?? REPOS),
    exec,
    now: () => clock.t,
    mode: 'session',
    claimant: 'me',
    ...(opts.log ? { log: opts.log } : {}),
  };
  return { store, git, github, clock, engine: new Engine(deps) };
}

/** Creates a task and puts it straight into the given state. */
async function put(store: BoardStore, patch: Partial<Task>, base = 'dev', repo: RepoId = 'data'): Promise<Task> {
  const t = await store.createTask({ factoryId: 'blocks', title: 'Add widget', description: 'd', repo, baseBranch: base });
  return Object.keys(patch).length ? store.updateTask(t.taskId, t.version, patch) : t;
}

const claimedBy = (who: string, clock: { t: Date }) => ({
  claimBy: who,
  claimUntil: new Date(clock.t.getTime() + 60_000).toISOString(),
});

const result = (r: object) => JSON.stringify(r);

afterEach(() => {
  vi.useRealTimers();
});

/** Two factories, `a` (repo api) and `b` (repos api and web, own docs path), for the per-factory tests. */
const TWO = (over: { a?: Partial<FactoryDef>; b?: Partial<FactoryDef> } = {}) => ({
  defs: [defFixture('a', over.a), defFixture('b', { docsPath: '/docs/b', ...over.b })],
  repos: [
    repoFixture('a', 'api'),
    repoFixture('b', 'api', { checks: structuredClone(CHECKS).map((c) => (c.name.startsWith('server.') ? { ...c, cwd: 'srv', run: c.name === 'server.build' ? 'make' : 'make test' } : c)) }),
    repoFixture('b', 'web'),
  ],
});

const putIn = async (store: BoardStore, factoryId: string, patch: Partial<Task> = { status: 'ready' }, repo = 'api'): Promise<Task> => {
  const t = await store.createTask({ factoryId, title: 'Add widget', description: 'd', repo, baseBranch: 'dev' });
  return Object.keys(patch).length ? store.updateTask(t.taskId, t.version, patch) : t;
};

describe('next across factories', () => {
  test('picks the oldest workable task across both factories', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'b');
    await putIn(store, 'a');
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-1', context: { factory: { factoryId: 'b' } } });
  });

  test("the ticket carries the model the factory set for the step's stage", async () => {
    const { store, engine } = setup(TWO({ b: { agentModels: { spec: 'haiku' } } }));
    await putIn(store, 'b');
    const ticket = await nextTicket(engine);
    expect(ticket).toMatchObject({ step: 'spec', model: 'haiku' });
    expect(JSON.parse(JSON.stringify(ticket)).model).toBe('haiku');
  });

  test('the ticket has no model key when the stage has no entry or the factory has none', async () => {
    const first = setup(TWO({ a: { agentModels: { plan: 'opus' } } }));
    await putIn(first.store, 'a');
    const ticket = (await nextTicket(first.engine))!;
    expect(ticket.step).toBe('spec');
    expect('model' in ticket).toBe(false);
    expect(JSON.stringify(ticket)).not.toContain('"model"');

    const second = setup(TWO());
    await putIn(second.store, 'b');
    const other = (await nextTicket(second.engine))!;
    expect(other.step).toBe('spec');
    expect('model' in other).toBe(false);
  });

  test('check and ship tickets never carry a model', async () => {
    const { store, engine } = setup(TWO({ a: { agentModels: { spec: 'opus', plan: 'opus', build: 'opus', verify: 'opus', review: 'opus' } } }));
    await putIn(store, 'a', { status: 'verify', stage: 'check', branch: 'factory/T-1-a' });
    const ticket = (await nextTicket(engine))!;
    expect(ticket.step).toBe('check');
    expect('model' in ticket).toBe(false);
  });

  test('a filter picks only in the named factories', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a');
    await putIn(store, 'b');
    expect(await nextTicket(engine, undefined, ['b'])).toMatchObject({ taskId: 'T-2' });
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null });
  });

  test('a factory at maxParallel does not stop the other', async () => {
    const { store, engine, clock } = setup(TWO());
    await store.setSettings({ factories: { a: { factory: { ...DEFAULT_SETTINGS, maxParallel: 1 }, repos: {} }, b: { factory: { ...DEFAULT_SETTINGS, maxParallel: 1 }, repos: {} } } });
    await putIn(store, 'a', { status: 'build', stage: 'build', branch: 'factory/T-1-a', ...claimedBy('other', clock) });
    await putIn(store, 'a');
    await putIn(store, 'b');
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-3', context: { factory: { factoryId: 'b' } } });
  });

  test('a paused factory still advances approved work on next, which then reports paused', async () => {
    const { store, engine } = setup(TWO());
    await store.setSettings({ factories: { b: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    const t = await putIn(store, 'b', { status: 'spec_review', stage: null, branch: 'factory/T-1-a' });
    await store.addDoc(t.taskId, 'spec', 'spec', 'a');
    await store.addApproval({ taskId: t.taskId, gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
    expect(await engine.next(undefined, ['b'])).toEqual({ kind: 'none', reason: 'paused' });
    expect((await store.getTask(t.taskId)).status).toBe('plan');
  });

  test('an invalid factory definition leaves its tasks untouched and is logged once', async () => {
    const logs: string[] = [];
    const bad = { ...defFixture('b'), gitEmail: 'no-at-sign' };
    const { store, engine, github } = setup({ defs: [defFixture('a'), bad], repos: [repoFixture('a', 'api'), repoFixture('b', 'api')], log: (m) => logs.push(m) });
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-a', base: 'dev', title: 't', body: 'b' });
    await putIn(store, 'b', { status: 'pr_open', branch: 'factory/T-1-a', prUrl: pr.url });
    await putIn(store, 'b', { status: 'build', stage: 'build', branch: 'factory/T-2-a', costUsd: 999 });
    github.setState(pr.url, 'merged');
    const before = await store.listTasks();
    await engine.sync();
    await engine.next();
    expect(await store.listTasks()).toEqual(before);
    expect(logs.filter((l) => l.startsWith('factory b skipped: '))).toHaveLength(1);
  });

  test('an invalid repo row leaves its tasks untouched; other repos of the factory work', async () => {
    const logs: string[] = [];
    const { store, engine } = setup({ defs: [defFixture('b')], repos: [repoFixture('b', 'api', { remote: '' }), repoFixture('b', 'web')], log: (m) => logs.push(m) });
    await putIn(store, 'b', { status: 'build', stage: 'build', branch: 'factory/T-1-a' }, 'api');
    await putIn(store, 'b', { status: 'ready' }, 'web');
    const before = await store.getTask('T-1');
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-2' });
    await engine.next();
    expect(await store.getTask('T-1')).toEqual(before);
    expect(logs.filter((l) => l.startsWith('repo b/api skipped: '))).toHaveLength(1);
  });

  test('paused and inactive are reported only when every factory in the filter is', async () => {
    const paused = setup(TWO());
    await paused.store.setSettings({ factories: { b: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    await putIn(paused.store, 'b');
    expect(await paused.engine.next(undefined, ['b'])).toEqual({ kind: 'none', reason: 'paused' });
    expect((await paused.store.getTask('T-1')).claimBy).toBeNull();
    await putIn(paused.store, 'a');
    expect(await paused.engine.next()).toMatchObject({ kind: 'ticket', ticket: { taskId: 'T-2' } });

    const inactive = setup(TWO({ b: { active: false } }));
    await putIn(inactive.store, 'b');
    expect(await inactive.engine.next(undefined, ['b'])).toEqual({ kind: 'none', reason: 'inactive' });
    expect(await inactive.engine.next()).toEqual({ kind: 'none', reason: 'nothing to do' });
  });

  test('every factory paused with no filter reports paused; an unknown filter is an UnknownFactoryError', async () => {
    const { store, engine } = setup(TWO());
    await store.setSettings({ factories: { a: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} }, b: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    expect(await engine.next()).toEqual({ kind: 'none', reason: 'paused' });
    await expect(engine.next(undefined, ['zzz'])).rejects.toBeInstanceOf(UnknownFactoryError);
    await expect(engine.next(undefined, ['a', 'zzz'])).rejects.toThrow('unknown factory zzz');
  });

  test('a targeted task in a paused or inactive factory says so, while the other factory is open', async () => {
    const paused = setup(TWO());
    await paused.store.setSettings({ factories: { b: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    await putIn(paused.store, 'b');
    await putIn(paused.store, 'a');
    expect(await paused.engine.next('T-1')).toEqual({ kind: 'none', reason: 'paused' });
    expect((await paused.store.getTask('T-2')).claimBy).toBeNull();

    const inactive = setup(TWO({ b: { active: false } }));
    await putIn(inactive.store, 'b');
    await putIn(inactive.store, 'a');
    expect(await inactive.engine.next('T-1')).toEqual({ kind: 'none', reason: 'inactive' });
    expect(await inactive.engine.next('T-2')).toMatchObject({ kind: 'ticket', ticket: { taskId: 'T-2' } });
  });

  test('a task whose repo is gone is blocked by sync, and one whose factory is gone too', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'b', { status: 'ready' }, 'gone');
    await putIn(store, 'x', { status: 'build', stage: 'build', branch: 'b' });
    await putIn(store, 'b', { status: 'done' }, 'gone');
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', blockedReason: 'repo gone no longer exists in b' });
    expect(await store.getTask('T-2')).toMatchObject({ status: 'blocked', blockedReason: 'factory x no longer exists' });
    expect((await store.getTask('T-3')).status).toBe('done');
  });

  test('a factory that is gone but left an invalid repo row blocks its tasks, not idles them', async () => {
    const { store, engine } = setup({ defs: [defFixture('a')], repos: [repoFixture('a', 'api'), repoFixture('x', 'api', { remote: '' })] });
    await putIn(store, 'x', { status: 'build', stage: 'build', branch: 'factory/T-1-a' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', blockedReason: 'factory x no longer exists' });
  });

  test('check and ship on a claimed task of an invalid factory or repo say it is invalid, not gone', async () => {
    const bad = { ...defFixture('b'), gitEmail: 'no-at-sign' };
    const { store, engine, clock } = setup({ defs: [defFixture('a'), bad], repos: [repoFixture('a', 'api'), repoFixture('a', 'web', { remote: '' }), repoFixture('b', 'api')] });
    await putIn(store, 'b', { status: 'verify', stage: 'check', branch: 'factory/T-1-a', ...claimedBy('me', clock) });
    await putIn(store, 'a', { status: 'review', stage: 'ship', branch: 'factory/T-2-a', ...claimedBy('me', clock) }, 'web');
    await expect(engine.check('T-1')).rejects.toThrow('factory b is invalid (skipped)');
    await expect(engine.ship('T-2')).rejects.toThrow('repo a/web is invalid (skipped)');
  });

  describe('ship per factory', () => {
    class AccountGitHub extends FakeGitHub {
      constructor(readonly account: string) { super(); }
    }
    class NotLoggedInGitHub extends FakeGitHub {
      constructor(private readonly user: string) { super(); }
      private missing(): never { throw new GhLoginMissingError(this.user); }
      ensureReady(): Promise<void> { return this.missing(); }
      override openPr(): never { return this.missing(); }
      override findOpenPr(): never { return this.missing(); }
      override prState(): never { return this.missing(); }
      override mergePr(): never { return this.missing(); }
    }

    test('a gh login that is not there blocks only that factory\'s task; the other factory opens its PR with its own client (R16)', async () => {
      const clients = new Map<string, GitHub>([['gh-a', new NotLoggedInGitHub('gh-a')], ['gh-b', new AccountGitHub('gh-b')]]);
      const asked: string[] = [];
      const { store, engine, git } = setup({ ...TWO(), githubFor: (acct) => { asked.push(acct); return clients.get(acct)!; } });
      await putIn(store, 'a', { status: 'review', stage: 'ship', branch: 'factory/T-1-x' });
      await putIn(store, 'b', { status: 'review', stage: 'ship', branch: 'factory/T-2-x' });
      await store.setSettings({ factories: { b: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: true } }, repos: {} } } });
      await nextTicket(engine, 'T-1');
      expect(await engine.ship('T-1')).toMatchObject({ status: 'blocked', blockedReason: 'gh account gh-a is not logged in (run: gh auth login)' });
      expect(git.pushes).toEqual([]);
      await nextTicket(engine, 'T-2');
      expect(await engine.ship('T-2')).toMatchObject({ status: 'pr_open', prUrl: 'https://github.com/org/api/pull/1' });
      expect([...(clients.get('gh-b') as AccountGitHub).prs.values()]).toHaveLength(1);
      expect(new Set(asked)).toEqual(new Set(['gh-a', 'gh-b']));
    });

    test('the factory\'s protected list decides: a push to rel is refused, dev is mergeable', async () => {
      const { store, engine, git, github } = setup(TWO({ a: { protectedBranches: ['rel', 'main'] } }));
      await store.setSettings({ factories: { a: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: false } }, repos: {} } } });
      await putIn(store, 'a', { status: 'review', stage: 'ship', branch: 'rel' });
      await nextTicket(engine, 'T-1');
      await expect(engine.ship('T-1')).rejects.toThrow('push to rel refused');
      expect(git.pushes).toEqual([]);
      await putIn(store, 'a', { status: 'review', stage: 'ship', branch: 'factory/T-2-x' });
      await nextTicket(engine, 'T-2');
      expect((await engine.ship('T-2')).status).toBe('done');
      expect([...github.prs.values()][0]).toMatchObject({ base: 'dev', state: 'merged' });
    });

    test('ship pushes with the repo protectedBranches override when it has one', async () => {
      const t = TWO();
      t.repos[0] = { ...t.repos[0]!, protectedBranches: ['release', 'main'] };
      const { store, engine, git, github } = setup(t);
      await store.setSettings({ factories: { a: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: false } }, repos: {} } } });
      await putIn(store, 'a', { status: 'review', stage: 'ship', branch: 'factory/T-1-x' });
      await nextTicket(engine, 'T-1');
      expect((await engine.ship('T-1')).status).toBe('done');
      expect(git.pushProtected).toEqual([['release', 'main']]);
      // dev is not protected for this repo, so the PR into dev merges.
      expect([...github.prs.values()][0]).toMatchObject({ base: 'dev', state: 'merged' });
    });
  });

  test('a gate resolved from b/api repo settings overrides b', async () => {
    const { store, engine } = setup(TWO());
    await store.setSettings({ factories: { b: { factory: { ...DEFAULT_SETTINGS, gates: { spec: true, plan: false, pr: true } }, repos: { api: { gates: { spec: false } } } } } });
    await putIn(store, 'b', { status: 'spec', stage: 'spec', branch: 'factory/T-1-a' }, 'api');
    await putIn(store, 'b', { status: 'spec', stage: 'spec', branch: 'factory/T-2-a' }, 'web');
    for (const id of ['T-1', 'T-2']) {
      expect(await nextTicket(engine, id)).toMatchObject({ taskId: id });
      await engine.complete(id, 'spec', JSON.stringify({ status: 'done', summary: 's', doc: 'the spec' }));
    }
    expect((await store.getTask('T-1')).status).toBe('plan');
    expect((await store.getTask('T-2')).status).toBe('spec_review');
  });

  test('the ticket context carries the factory docsPath and the repo checks', async () => {
    const { store, engine, git } = setup(TWO());
    await putIn(store, 'b', { status: 'ready' }, 'api');
    const ticket = await nextTicket(engine);
    expect(ticket!.context.factory).toEqual({ factoryId: 'b', name: 'b', docsPath: '/docs/b' });
    expect(ticket!.context.checks.slice(0, 2)).toEqual([
      { name: 'server.build', cwd: 'srv', run: 'make' }, { name: 'server.test', cwd: 'srv', run: 'make test', needs: 'server.build' }]);
    expect(git.calls[0]).toBe('clone b/api');
  });

  test('a definition that fails validation is logged once and is not a factory', async () => {
    const logs: string[] = [];
    const { store, engine } = setup({ defs: [defFixture('a'), { ...defFixture('x'), factoryId: 'GATE-gate' }], repos: [repoFixture('a', 'api')], log: (m) => logs.push(m) });
    await putIn(store, 'a');
    expect(await engine.next(undefined, ['GATE-gate'])).toEqual({ kind: 'none', reason: 'nothing to do' });
    await engine.next();
    await engine.status();
    expect(logs.filter((l) => l.startsWith('factory GATE-gate skipped: '))).toHaveLength(1);
    expect((await engine.status()).factories.map((f) => f.factoryId)).toEqual(['a']);
  });
});

describe('no or missing factory definitions', () => {
  test('no factory definitions at all: next says no-factories and changes nothing, even with repo rows', async () => {
    const { store, engine } = setup({ defs: [], repos: [repoFixture('blocks', 'data')] });
    await putIn(store, 'blocks', { status: 'ready' }, 'data');
    await putIn(store, 'blocks', { status: 'build', stage: 'build', branch: 'factory/T-2-a', costUsd: 999 }, 'data');
    const before = await store.listTasks();
    expect(await engine.next()).toEqual({ kind: 'none', reason: 'no-factories' });
    expect(await engine.next('T-1')).toEqual({ kind: 'none', reason: 'no-factories' });
    expect(await engine.next(undefined, ['blocks'])).toEqual({ kind: 'none', reason: 'no-factories' });
    await engine.sync();
    expect(await store.listTasks()).toEqual(before);
    expect((await store.getTask('T-1')).status).toBe('ready');
  });

  test('an invalid definition row is still a row: next is not no-factories', async () => {
    const { engine } = setup({ defs: [{ ...defFixture('b'), gitEmail: 'no-at-sign' }], repos: [] });
    expect(await engine.next()).toEqual({ kind: 'none', reason: 'nothing to do' });
  });

  test('a deleted factory blocks its tasks', async () => {
    const { store, engine } = setup({ defs: [defFixture('a')], repos: [repoFixture('a', 'api')] });
    await putIn(store, 'blocks', { status: 'build', stage: 'build', branch: 'factory/T-1-a' }, 'data');
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', blockedReason: 'factory blocks no longer exists' });
  });
});

describe('next', () => {
  test('paused: returns null and claims nothing', async () => {
    const { store, engine } = setup();
    await store.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    await put(store, { status: 'ready' });
    expect(await nextTicket(engine)).toBeNull();
    expect((await store.getTask('T-1')).claimBy).toBeNull();
  });

  test('skips tasks in a paused repo but still claims in other repos', async () => {
    const { store, engine } = setup();
    await store.setSettings({ factories: { blocks: { factory: DEFAULT_SETTINGS, repos: { data: { paused: true } } } } });
    await put(store, { status: 'ready' });
    await put(store, { status: 'ready' }, 'dev', 'iam');
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-2', step: 'spec' });
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null });
    expect(await nextTicket(engine, 'T-1')).toBeNull();
  });

  test('the worktree branches from the task base, not the repo default', async () => {
    const { store, engine, git } = setup();
    await put(store, { status: 'ready' }, 'feature/x');
    await nextTicket(engine);
    expect(git.bases).toEqual(['feature/x']);
  });

  test('returns null when maxParallel tasks are already claimed', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'spec', stage: 'spec', branch: 'factory/T-1-a', ...claimedBy('other', clock) });
    await put(store, { status: 'plan', stage: 'plan', branch: 'factory/T-2-a', ...claimedBy('other', clock) });
    await put(store, { status: 'ready' });
    expect(await nextTicket(engine)).toBeNull();
    expect((await store.getTask('T-3')).status).toBe('ready');
  });

  test('a ready task is claimed, gets a branch and worktree, and moves to spec', async () => {
    const { store, engine, git } = setup();
    await put(store, { status: 'ready' });
    const ticket = await nextTicket(engine);
    expect(ticket).toMatchObject({
      taskId: 'T-1',
      step: 'spec',
      worktree: join(ROOT, '.clones', 'worktrees', 'T-1'),
      runId: 'R-1',
    });
    expect(git.calls).toEqual(['clone blocks/data', 'worktree T-1 factory/T-1-add-widget']);
    const t = await store.getTask('T-1');
    expect(t).toMatchObject({ status: 'spec', stage: 'spec', branch: 'factory/T-1-add-widget', claimBy: 'me' });
    expect(ticket!.context.task).toEqual(t);
    const events = await store.listEvents('T-1');
    expect(events).toContainEqual(
      expect.objectContaining({ field: 'status', from: 'ready', to: 'spec', actor: 'core · session' }),
    );
    expect(await store.openRun('T-1', 'spec')).toMatchObject({ agent: 'spec-writer', mode: 'session' });
  });

  test('picks the lowest T-<n> that is ready or at a working stage, skipping claimed and waiting tasks', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'spec_review', stage: null, branch: 'b1' });
    await put(store, { status: 'build', stage: 'build', branch: 'b2', ...claimedBy('other', clock) });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b3' });
    await put(store, { status: 'plan', stage: 'plan', branch: 'b4' });
    await put(store, { status: 'ready' });
    const ticket = await nextTicket(engine);
    expect(ticket).toMatchObject({ taskId: 'T-4', step: 'plan' });
  });

  test('picks an explicit task', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await put(store, { status: 'build', stage: 'build', branch: 'factory/T-2-x' });
    expect(await nextTicket(engine, 'T-2')).toMatchObject({ taskId: 'T-2', step: 'build' });
  });

  test('context carries the current spec and plan, the answer as feedback and the latest verify doc', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'factory/T-1-x', answer: 'fix the test' });
    await store.addDoc('T-1', 'spec', 'spec v1', 'a');
    await store.addDoc('T-1', 'spec', 'spec v2', 'a');
    await store.addDoc('T-1', 'plan', 'the plan', 'a');
    await store.addDoc('T-1', 'verify', 'checks report', 'core · checks');
    const ticket = await nextTicket(engine);
    expect(ticket!.context).toEqual({
      task: await store.getTask('T-1'),
      factory: { factoryId: 'blocks', name: 'blocks', docsPath: '/docs' },
      checks: CHECKS,
      spec: 'spec v2',
      plan: 'the plan',
      feedback: 'fix the test',
      checksReport: 'checks report',
    });
  });

  test('context omits keys that have no value', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    const ticket = await nextTicket(engine);
    expect(Object.keys(ticket!.context)).toEqual(['task', 'factory', 'checks']);
  });

  test('core steps get a ticket without a run', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    const ticket = await nextTicket(engine);
    expect(ticket).toMatchObject({ step: 'check', runId: null });
    expect(await store.openRun('T-1', 'check')).toBeUndefined();
  });

  class BrokenGit extends FakeGit {
    constructor(private readonly broken: string) {
      super();
    }
    override async worktree(factoryId: string, c: FactoryRepo, taskId: string, branch: string): Promise<string> {
      if (taskId === this.broken) throw new Error('worktree add failed\nfatal: details');
      return super.worktree(factoryId, c, taskId, branch);
    }
  }

  test('an explicit task: releases the claim and rethrows when work after the claim fails', async () => {
    const { store, engine } = setup({ git: new BrokenGit('T-1') });
    await put(store, { status: 'ready' });
    await expect(nextTicket(engine, 'T-1')).rejects.toThrow('worktree add failed');
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null, claimUntil: null });
  });

  test('a setup failure releases the task, records it and moves on to the next candidate', async () => {
    const { store, engine } = setup({ git: new BrokenGit('T-1') });
    await put(store, { status: 'ready' });
    await put(store, { status: 'ready' });
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-2', step: 'spec' });
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null, claimUntil: null });
    expect(await store.listEvents('T-1')).toContainEqual(
      expect.objectContaining({ actor: 'core · session', action: 'set', field: 'setupError', to: 'worktree add failed', reason: 'setup failed' }),
    );
  });

  test('a setup failure on the only candidate gives null', async () => {
    const { store, engine } = setup({ git: new BrokenGit('T-1') });
    await put(store, { status: 'ready' });
    expect(await nextTicket(engine)).toBeNull();
    expect((await store.getTask('T-1')).claimBy).toBeNull();
  });

  test('reuses the open run for the step instead of starting a new one', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'ready' });
    expect((await nextTicket(engine))!.runId).toBe('R-1');
    clock.t = new Date(clock.t.getTime() + 3_600_000); // claim lapses, the run is still open
    const startRun = vi.spyOn(store, 'startRun');
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-1', step: 'spec', runId: 'R-1' });
    expect(startRun).not.toHaveBeenCalled();
  });

  test('returns null when nothing is workable', async () => {
    const { store, engine } = setup();
    await put(store, {});
    expect(await nextTicket(engine)).toBeNull();
  });
});

describe('feedback', () => {
  test('a spec-change comment does not leak into the planner or implementer feedback', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'v1' }));
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'changes', comment: 'drop the cache idea' });
    const respec = await nextTicket(engine);
    expect(respec).toMatchObject({ step: 'spec', context: { feedback: 'drop the cache idea' } });
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'v2' }));
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 2, decision: 'approve', comment: '' });
    const plan = await nextTicket(engine);
    expect(plan!.step).toBe('plan');
    expect(plan!.context.feedback).toBeUndefined();
    await engine.complete('T-1', 'plan', result({ status: 'done', summary: 's', doc: 'p' }));
    const build = await nextTicket(engine);
    expect(build!.step).toBe('build');
    expect(build!.context.feedback).toBeUndefined();
  });

  test('the answer to a verifier question reaches the resumed verifier', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'verify', stage: 'verify', branch: 'factory/T-1-x' });
    await nextTicket(engine);
    await engine.complete('T-1', 'verify', result({ status: 'blocked', summary: 's', question: 'AC3: which API?' }));
    const b = await store.getTask('T-1');
    await store.updateTask('T-1', b.version, { answer: 'use v2' });
    const resumed = await nextTicket(engine);
    expect(resumed).toMatchObject({ step: 'verify', context: { feedback: 'use v2' } });
    expect(resumed!.context.task).toMatchObject({ question: null, blockedReason: null, attempt: 0 });
  });
});

describe('store round trips', () => {
  test('an identical spec rewritten after a changes request waits at spec_review (no loop)', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'same spec' }));
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'changes', comment: 'try again' });
    expect(await nextTicket(engine)).toMatchObject({ step: 'spec', context: { feedback: 'try again' } });
    clock.t = new Date(clock.t.getTime() + 121_000);
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'same spec' }));
    expect(t.status).toBe('spec_review');
    expect(await store.currentDoc('T-1', 'spec')).toMatchObject({ version: 2, body: 'same spec' });
    await engine.sync();
    expect(await nextTicket(engine)).toBeNull();
    expect((await store.getTask('T-1')).status).toBe('spec_review');
  });

  test('a released claim reads back as null', async () => {
    const git = new FakeGit();
    git.worktree = async () => { throw new Error('disk full'); };
    const { store, engine } = setup({ git });
    await put(store, { status: 'spec', stage: 'spec', branch: 'b' });
    expect(await nextTicket(engine)).toBeNull();
    expect(await store.getTask('T-1')).toMatchObject({ claimBy: null, claimUntil: null });
  });

  test('a forward move clears the answer and the claim', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'v1' }));
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'changes', comment: 'drop the cache idea' });
    expect(await nextTicket(engine)).toMatchObject({ step: 'spec', context: { feedback: 'drop the cache idea' } });
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'v2' }));
    expect(t).toMatchObject({ status: 'spec_review', answer: null, claimBy: null, claimUntil: null });
    expect(await store.getTask('T-1')).toMatchObject({ answer: null, claimBy: null, claimUntil: null });
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 2, decision: 'approve', comment: '' });
    const plan = await nextTicket(engine);
    expect(plan!.step).toBe('plan');
    expect(plan!.context.feedback).toBeUndefined();
  });
});

describe('complete', () => {
  test('rejects another claimant and a step that is not the stage', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'spec', stage: 'spec', branch: 'b', ...claimedBy('other', clock) });
    await expect(engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'x' }))).rejects.toBeInstanceOf(
      ClaimError,
    );
    await put(store, { status: 'spec', stage: 'spec', branch: 'b', ...claimedBy('me', clock) });
    await expect(engine.complete('T-2', 'plan', result({ status: 'done', summary: 's', doc: 'x' }))).rejects.toBeInstanceOf(
      StageError,
    );
  });

  test('done with a doc writes the doc, finishes the run and moves on', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: '# Spec', costUsd: 1.5, turns: 4 }));
    expect(t).toMatchObject({ status: 'spec_review', stage: null, costUsd: 1.5, claimBy: null, claimUntil: null });
    expect(await store.currentDoc('T-1', 'spec')).toMatchObject({
      version: 1,
      body: '# Spec',
      author: 'spec-writer · session · run R-1',
    });
    expect(await store.openRun('T-1', 'spec')).toBeUndefined();
    const events = await store.listEvents('T-1');
    expect(events).toContainEqual(
      expect.objectContaining({ field: 'status', from: 'spec', to: 'spec_review', actor: 'spec-writer · session · run R-1' }),
    );
  });

  test('a claim renewed between the first read and the apply does not break complete', async () => {
    // A detached renewal (plugin renew.mjs) can land while complete writes the doc and finishes the run.
    const hook = { onFinish: async () => {} };
    class RenewingStore extends MemoryStore {
      override async finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }) {
        await super.finishRun(runId, p);
        await hook.onFinish();
      }
    }
    const { store, engine } = setup({ store: () => new RenewingStore() });
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    const before = (await store.getTask('T-1')).version;
    hook.onFinish = async () => {
      await engine.renew('T-1');
    };
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: '# Spec' }));
    expect(t).toMatchObject({ status: 'spec_review', stage: null, claimBy: null });
    expect(t.version).toBeGreaterThan(before + 1);
  });

  test('accepts a lapsed claim nobody re-claimed', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    clock.t = new Date(clock.t.getTime() + 3_600_000);
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'x' }));
    expect(t.status).toBe('spec_review');
  });

  test('a missing result blocks the task as failed', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    const t = await engine.complete('T-1', 'spec', undefined);
    expect(t.status).toBe('blocked');
    expect(t.blockedReason).toMatch(/^invalid agent result/);
  });

  test('a cost of 5.01 at the default limit blocks the task', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await nextTicket(engine);
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'x', costUsd: 5.01 }));
    expect(t).toMatchObject({ status: 'blocked', stage: 'spec', costUsd: 5.01 });
    expect(t.blockedReason).toMatch(/cost/);
  });
});

describe('check', () => {
  test('passing checks write a verify doc and move to the verify agent', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    await nextTicket(engine);
    const t = await engine.check('T-1');
    expect(t).toMatchObject({ status: 'verify', stage: 'verify' });
    const doc = await store.currentDoc('T-1', 'verify');
    expect(doc).toMatchObject({ author: 'core · checks' });
    expect(doc!.body).toContain('## Checks: passed');
  });

  test('failing checks return to build with the failing and skipped step names', async () => {
    const { store, engine } = setup({ failing: ['dotnet build'] });
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    await nextTicket(engine);
    const t = await engine.check('T-1');
    expect(t).toMatchObject({ status: 'build', stage: 'build', attempt: 1, answer: 'server.build, server.test' });
  });

  test('a claim renewed during the checks does not break the final write', async () => {
    const hook = { onExec: async () => {} };
    const { store, engine } = setup({ onExec: () => hook.onExec() });
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    await nextTicket(engine);
    let renewals = 0;
    hook.onExec = async () => {
      await engine.renew('T-1');
      renewals++;
    };
    const t = await engine.check('T-1');
    expect(renewals).toBeGreaterThan(0);
    expect(t).toMatchObject({ status: 'verify', stage: 'verify', claimBy: null });
  });

  test('a claim taken over during the checks: no report and no move', async () => {
    const hook = { onExec: async () => {} };
    const { store, engine, clock } = setup({ onExec: () => hook.onExec() });
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    await nextTicket(engine);
    hook.onExec = async () => {
      const t = await store.getTask('T-1');
      if (t.claimBy === 'me') await store.updateTask('T-1', t.version, claimedBy('other', clock));
    };
    await expect(engine.check('T-1')).rejects.toBeInstanceOf(ClaimError);
    expect(await store.getTask('T-1')).toMatchObject({ status: 'verify', stage: 'check', claimBy: 'other' });
    expect(await store.currentDoc('T-1', 'verify')).toBeUndefined();
  });

  test('requires the claim and stage check', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'verify', stage: 'check', branch: 'b' });
    await expect(engine.check('T-1')).rejects.toBeInstanceOf(ClaimError);
    await put(store, { status: 'verify', stage: 'verify', branch: 'b', ...claimedBy('me', clock) });
    await expect(engine.check('T-2')).rejects.toBeInstanceOf(StageError);
  });
});

describe('ship', () => {
  async function atShip(base: string, prGate: boolean, log?: (m: string) => void) {
    const s = setup(log ? { log } : {});
    await s.store.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: prGate } }, repos: {} } } });
    await put(s.store, { status: 'review', stage: 'ship', branch: 'factory/T-1-add-widget' }, base);
    await s.store.addDoc('T-1', 'spec', 'S'.repeat(5000), 'a');
    await nextTicket(s.engine);
    return s;
  }

  test('base dev with the PR gate off stops at pr_open without a merge', async () => {
    const { engine, github, git } = await atShip('dev', false);
    const t = await engine.ship('T-1');
    expect(t).toMatchObject({ status: 'pr_open', stage: null, prUrl: 'https://github.com/example-org/blocks-data/pull/1' });
    expect(git.pushes).toEqual([{ path: join(ROOT, '.clones', 'worktrees', 'T-1'), branch: 'factory/T-1-add-widget' }]);
    expect([...github.prs.values()]).toMatchObject([{ base: 'dev', head: 'factory/T-1-add-widget', state: 'open' }]);
  });

  test('base feature/x with the PR gate off merges and is done', async () => {
    const { engine, github } = await atShip('feature/x', false);
    const t = await engine.ship('T-1');
    expect(t.status).toBe('done');
    expect([...github.prs.values()][0]!.state).toBe('merged');
  });

  test('base feature/x with the PR gate on waits at pr_open', async () => {
    const { engine, github } = await atShip('feature/x', true);
    expect((await engine.ship('T-1')).status).toBe('pr_open');
    expect([...github.prs.values()][0]!.state).toBe('open');
  });

  test('PR title and body', async () => {
    const { engine, github } = await atShip('dev', true);
    const openPr = vi.spyOn(github, 'openPr');
    await engine.ship('T-1');
    expect(openPr).toHaveBeenCalledWith({
      remote: REMOTE,
      head: 'factory/T-1-add-widget',
      base: 'dev',
      title: '[T-1] Add widget',
      body: `Factory task T-1\n\n${'S'.repeat(3000)}`,
    });
  });

  const linkFor = (repo: string, issueNumber: number | null) => ({
    taskId: 'T-1', factoryId: 'blocks', repo, issueNumber, issueNodeId: null, project: null, itemId: null,
    pushed: emptyPushed(), error: null, lease: null, reported: [], version: 1,
  });

  test('ship adds Closes #n when the task has an issue', async () => {
    const { engine, github, store } = await atShip('dev', true);
    await store.saveGitHubLink(null, linkFor('EXAMPLE-ORG/Blocks-Data', 12));
    const openPr = vi.spyOn(github, 'openPr');
    await engine.ship('T-1');
    expect(openPr.mock.calls[0]![0].body.endsWith('\n\nCloses #12')).toBe(true);
  });

  test('a failed link read is logged and the PR still opens', async () => {
    const logs: string[] = [];
    const { engine, github, store } = await atShip('dev', true, (m) => logs.push(m));
    vi.spyOn(store, 'getGitHubLink').mockRejectedValue(new Error('boom\nsecond'));
    await engine.ship('T-1');
    expect(logs).toContain('PR body: issue link not read (boom)');
    expect(github.prs.size).toBe(1);
  });

  test('ship body unchanged without a link, with another repo, or without an issue number', async () => {
    for (const link of [undefined, linkFor('other/repo', 12), linkFor('example-org/blocks-data', null)]) {
      const { engine, github, store } = await atShip('dev', true);
      if (link) await store.saveGitHubLink(null, link);
      const openPr = vi.spyOn(github, 'openPr');
      await engine.ship('T-1');
      expect(openPr.mock.calls[0]![0].body).toBe(`Factory task T-1\n\n${'S'.repeat(3000)}`);
    }
  });

  test.each(['main', 'origin/main', 'refs/heads/main'])('base %s blocks the task before the gh login check and pushes nothing', async (base) => {
    const asked: string[] = [];
    const s = setup({ githubFor: () => { asked.push('github'); return new FakeGitHub(); } });
    await s.store.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: false } }, repos: {} } } });
    await put(s.store, { status: 'review', stage: 'ship', branch: 'factory/T-1-add-widget' }, base);
    await nextTicket(s.engine);
    asked.length = 0;
    expect(await s.engine.ship('T-1')).toMatchObject({ status: 'blocked', stage: 'ship', blockedReason: 'base main is never a target', prUrl: null });
    expect(s.git.pushes).toEqual([]);
    expect(asked).toEqual([]); // no GitHub client, so no token read
  });

  test('ships from the task base', async () => {
    const { engine, git } = await atShip('feature/x', true);
    await engine.ship('T-1');
    expect(git.bases.at(-1)).toBe('feature/x');
  });

  test('shipping again after PR changes reuses the open PR', async () => {
    const { store, engine, github, git } = await atShip('dev', true);
    const first = await engine.ship('T-1');
    await store.addDoc('T-1', 'review', 'approve', 'reviewer');
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'changes', comment: 'rename it' });
    await engine.sync();
    const back = await store.getTask('T-1');
    expect(back.status).toBe('build');
    // build → verify → review happen; the reviewer approves a new review doc.
    await store.updateTask('T-1', back.version, { status: 'review', stage: 'ship' });
    await store.addDoc('T-1', 'review', 'approve again', 'reviewer');
    await nextTicket(engine);
    const again = await engine.ship('T-1');
    expect(again).toMatchObject({ status: 'pr_open', prUrl: first.prUrl });
    expect(github.prs.size).toBe(1);
    expect(git.pushes).toHaveLength(2);
  });

  test('a PR merged while changes were requested blocks the task without a push', async () => {
    const { store, engine, github, git } = await atShip('dev', true);
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-add-widget', base: 'dev', title: 't', body: 'b' });
    github.setState(pr.url, 'merged');
    const t = await store.getTask('T-1');
    await store.updateTask('T-1', t.version, { prUrl: pr.url });
    const blocked = await engine.ship('T-1');
    expect(blocked).toMatchObject({
      status: 'blocked', stage: 'ship', prUrl: pr.url, blockedReason: 'previous PR was merged; new commits are not shipped',
    });
    expect(git.pushes).toHaveLength(0);
  });

  test('shipping a task whose PR was closed opens a new PR', async () => {
    const { store, engine, github } = await atShip('dev', true);
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-add-widget', base: 'dev', title: 't', body: 'b' });
    github.setState(pr.url, 'closed');
    const t = await store.getTask('T-1');
    await store.updateTask('T-1', t.version, { prUrl: pr.url });
    const shipped = await engine.ship('T-1');
    expect(shipped.status).toBe('pr_open');
    expect(shipped.prUrl).not.toBe(pr.url);
    expect(github.prs.size).toBe(2);
  });

  test('a reused PR into dev is not merged after the task base changed to feature/x; the task blocks', async () => {
    const { store, engine, github } = setup();
    await store.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: false } }, repos: {} } } });
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-x', base: 'dev', title: 't', body: 'b' });
    await put(store, { status: 'review', stage: 'ship', branch: 'factory/T-1-x', prUrl: pr.url }, 'feature/x');
    await nextTicket(engine);
    const t = await engine.ship('T-1');
    expect(t).toMatchObject({ status: 'blocked', stage: 'ship' });
    expect(t.blockedReason).toMatch(/targets dev.*not merged/);
    expect(github.prs.get(pr.url)!.state).toBe('open');
  });

  test('a PR into another unprotected base is not merged either', async () => {
    const { store, engine, github } = setup();
    await store.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: false } }, repos: {} } } });
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-x', base: 'feature/y', title: 't', body: 'b' });
    await put(store, { status: 'review', stage: 'ship', branch: 'factory/T-1-x', prUrl: pr.url }, 'feature/x');
    await nextTicket(engine);
    const t = await engine.ship('T-1');
    expect(t).toMatchObject({ status: 'blocked', stage: 'ship', blockedReason: `${pr.url} targets feature/y, not feature/x; not merged` });
    expect(github.prs.get(pr.url)!.state).toBe('open');
  });

  /** Fails every task write whose patch matches `when` while `down.on` is true. */
  function storeOutage(store: BoardStore, when: (patch: Partial<Task>) => boolean) {
    const down = { on: true };
    const update = store.updateTask.bind(store);
    vi.spyOn(store, 'updateTask').mockImplementation(async (id, v, patch) => {
      if (down.on && when(patch)) throw new Error('blocks down');
      return update(id, v, patch);
    });
    return down;
  }

  async function failsAfterRetries<T>(p: Promise<T>, message: string) {
    const settled = expect(p).rejects.toThrow(message);
    await vi.runAllTimersAsync();
    await settled;
  }

  test('the store fails after the PR opens: the PR url is kept and the next ship reuses the PR', async () => {
    vi.useFakeTimers();
    const { store, engine, github } = await atShip('dev', true);
    const down = storeOutage(store, (patch) => 'status' in patch);
    await failsAfterRetries(engine.ship('T-1'), 'blocks down');
    const url = 'https://github.com/example-org/blocks-data/pull/1';
    expect(await store.getTask('T-1')).toMatchObject({ status: 'review', stage: 'ship', prUrl: url });
    down.on = false;
    expect(await engine.ship('T-1')).toMatchObject({ status: 'pr_open', prUrl: url });
    expect(github.prs.size).toBe(1);
  });

  test('the store fails before the PR url is saved: the next ship finds the open PR', async () => {
    vi.useFakeTimers();
    const { store, engine, github } = await atShip('dev', true);
    const down = storeOutage(store, () => true);
    await failsAfterRetries(engine.ship('T-1'), 'blocks down');
    expect((await store.getTask('T-1')).prUrl).toBeNull();
    down.on = false;
    const openPr = vi.spyOn(github, 'openPr');
    const t = await engine.ship('T-1');
    expect(t).toMatchObject({ status: 'pr_open', prUrl: 'https://github.com/example-org/blocks-data/pull/1' });
    expect(openPr).not.toHaveBeenCalled();
    expect(github.prs.size).toBe(1);
  });

  test('the merge fails after the PR opens: the next ship merges that same PR', async () => {
    vi.useFakeTimers();
    const { store, engine, github } = await atShip('feature/x', false);
    const merge = vi.spyOn(github, 'mergePr').mockRejectedValue(new Error('GitHub down'));
    await failsAfterRetries(engine.ship('T-1'), 'GitHub down');
    const url = 'https://github.com/example-org/blocks-data/pull/1';
    expect((await store.getTask('T-1')).prUrl).toBe(url);
    merge.mockRestore();
    expect(await engine.ship('T-1')).toMatchObject({ status: 'done', prUrl: url });
    expect(github.prs.size).toBe(1);
    expect(github.prs.get(url)!.state).toBe('merged');
  });

  test('a claim renewed during the push does not break the final write', async () => {
    const { engine, git } = await atShip('dev', true);
    vi.spyOn(git, 'push').mockImplementation(async () => {
      await engine.renew('T-1');
    });
    expect((await engine.ship('T-1')).status).toBe('pr_open');
  });

  test('a claim taken over during the push: nothing is written, the next ship finds the PR', async () => {
    const { store, engine, git, github, clock } = await atShip('dev', true);
    vi.spyOn(git, 'push').mockImplementation(async () => {
      const t = await store.getTask('T-1');
      await store.updateTask('T-1', t.version, claimedBy('other', clock));
    });
    await expect(engine.ship('T-1')).rejects.toBeInstanceOf(ClaimError);
    expect(await store.getTask('T-1')).toMatchObject({ status: 'review', stage: 'ship', prUrl: null, claimBy: 'other' });
    expect(github.prs.size).toBe(1);
  });

  test('requires the claim and stage ship', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'review', stage: 'ship', branch: 'b' });
    await expect(engine.ship('T-1')).rejects.toBeInstanceOf(ClaimError);
    await put(store, { status: 'review', stage: 'review', branch: 'b', ...claimedBy('me', clock) });
    await expect(engine.ship('T-2')).rejects.toBeInstanceOf(StageError);
  });
});

describe('sync', () => {
  test('a spec approval at v1 after spec v2 exists does not open the gate', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'spec_review', branch: 'b' });
    await store.addDoc('T-1', 'spec', 'v1', 'a');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
    await store.addDoc('T-1', 'spec', 'v2', 'a');
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('spec_review');
  });

  test('an approval of the current spec moves to plan; changes go back to spec with the comment', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'spec_review', branch: 'b' });
    await store.addDoc('T-1', 'spec', 'v1', 'a');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
    await put(store, { status: 'plan_review', branch: 'b' });
    await store.addDoc('T-2', 'plan', 'v1', 'a');
    await store.addApproval({ taskId: 'T-2', gate: 'plan', docVersion: 1, decision: 'changes', comment: 'smaller' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'plan', stage: 'plan' });
    expect(await store.getTask('T-2')).toMatchObject({ status: 'plan', stage: 'plan', answer: 'smaller' });
  });

  async function prOpen(base = 'dev') {
    const s = setup();
    const pr = await s.github.openPr({ remote: REMOTE, head: 'factory/T-1-x', base, title: 't', body: 'b' });
    await put(s.store, { status: 'pr_open', branch: 'factory/T-1-x', prUrl: pr.url }, base);
    await s.store.addDoc('T-1', 'review', 'approve', 'reviewer');
    return { ...s, url: pr.url };
  }

  test('a PR closed on GitHub blocks the task', async () => {
    const { store, engine, github, url } = await prOpen();
    github.setState(url, 'closed');
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', blockedReason: 'PR closed without merge' });
  });

  test('a PR merged on GitHub completes the task', async () => {
    const { store, engine, github, url } = await prOpen();
    github.setState(url, 'merged');
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('done');
  });

  test('PR changes requested on the Board return to build', async () => {
    const { store, engine } = await prOpen();
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'changes', comment: 'rename it' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', answer: 'rename it', attempt: 1 });
  });

  test('PR changes requested on a protected base return to build', async () => {
    const { store, engine } = await prOpen('dev');
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'changes', comment: 'rename it' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', answer: 'rename it' });
  });

  test('PR approve on an unprotected base merges', async () => {
    const { store, engine, github, url } = await prOpen('feature/x');
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'approve', comment: '' });
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('done');
    expect(github.prs.get(url)!.state).toBe('merged');
  });

  test('PR approve on a protected base is ignored', async () => {
    const { store, engine, github, url } = await prOpen('dev');
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'approve', comment: '' });
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('pr_open');
    expect(github.prs.get(url)!.state).toBe('open');
  });

  test('a blocked task with an answer resumes at its stage', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', question: 'q?', answer: 'do x' });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', question: 'q?', answer: '' });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', question: 'q?', answer: '  \n\t ' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', question: null, answer: 'do x' });
    expect((await store.getTask('T-2')).status).toBe('blocked');
    expect((await store.getTask('T-3')).status).toBe('blocked');
  });

  const GH_ONLY = { mode: 'github-only' as const, project: { owner: 'o', number: 1 }, label: 'factory', approvers: ['octo-user'],
    statusMap: { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress', plan_review: 'In progress',
      build: 'In progress', verify: 'In progress', review: 'In progress', pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as never };

  test('an answered stage-less blocked task restarts in a github-only factory', async () => {
    const { store, engine } = setup({ defs: [defFixture('blocks', { github: GH_ONLY })] });
    await put(store, { status: 'blocked', stage: null, attempt: 2, question: 'q?', blockedReason: 'rebuilt from GitHub, check status', answer: 'unblocked by x' });
    await put(store, { status: 'blocked', stage: null, answer: '  ' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', stage: null, attempt: 0, question: null, blockedReason: null, answer: null });
    expect((await store.getTask('T-2')).status).toBe('blocked');
  });

  test('the same task stays blocked in a factory without github', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'blocked', stage: null, question: 'q?', answer: 'unblocked by x' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', answer: 'unblocked by x' });
  });

  test('a working task over the cost limit is blocked; waiting-without-stage and blocked tasks are left alone', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', costUsd: 6 });
    await put(store, { status: 'spec_review', stage: null, branch: 'b', costUsd: 6 });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', costUsd: 6 });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', stage: 'build' });
    expect((await store.getTask('T-2')).status).toBe('spec_review');
    expect((await store.getTask('T-3')).blockedReason).toBeNull();
  });

  test('a third failed check blocks the task and a stale answer does not resume it', async () => {
    const { store, engine } = setup({ failing: ['dotnet build'] });
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    for (let i = 0; i < 3; i++) {
      const t = await store.getTask('T-1');
      if (t.status === 'build') await store.updateTask('T-1', t.version, { status: 'verify', stage: 'check' });
      await nextTicket(engine);
      await engine.check('T-1');
    }
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', stage: 'build', attempt: 3, answer: null });
    await engine.sync();
    const blocked = await store.getTask('T-1');
    expect(blocked.status).toBe('blocked');
    await store.updateTask('T-1', blocked.version, { answer: 'try a clean build' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', attempt: 0, answer: 'try a clean build' });
  });

  test('an illegal input or move is a bug and surfaces from sync', async () => {
    vi.useFakeTimers();
    const { engine, github } = await prOpen();
    const task = { status: 'pr_open', stage: null } as const;
    vi.spyOn(github, 'prState').mockRejectedValue(new IllegalInputError(task, 'bug'));
    const p = engine.sync();
    const settled = expect(p).rejects.toBeInstanceOf(IllegalInputError);
    await vi.runAllTimersAsync();
    await settled;
  });

  test('a GitHub outage: 3 failed tries skip the task without moving it', async () => {
    vi.useFakeTimers();
    const { store, engine, github } = await prOpen();
    const prState = vi.spyOn(github, 'prState').mockRejectedValue(new Error('GitHub down'));
    const p = engine.sync();
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(prState).toHaveBeenCalledTimes(3);
    expect((await store.getTask('T-1')).status).toBe('pr_open');
  });

  test('a GitHub blip: one failure then merged gives done', async () => {
    vi.useFakeTimers();
    const { store, engine, github } = await prOpen();
    vi.spyOn(github, 'prState').mockRejectedValueOnce(new Error('blip')).mockResolvedValue('merged');
    const p = engine.sync();
    await vi.runAllTimersAsync();
    await p;
    expect((await store.getTask('T-1')).status).toBe('done');
  });

  test('a version conflict skips that task and carries on', async () => {
    const { store, engine, github, url } = await prOpen();
    github.setState(url, 'merged');
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', answer: 'go' });
    const update = vi.spyOn(store, 'updateTask');
    update.mockRejectedValueOnce(new VersionConflictError('T-1', 1, 2));
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('pr_open');
    expect((await store.getTask('T-2')).status).toBe('build');
  });
});

describe('status', () => {
  test('lists active claims, counts per status, every task and each factory', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', ...claimedBy('other', clock) });
    await put(store, { status: 'build', stage: 'build', branch: 'b', claimBy: 'old', claimUntil: '2026-01-01T00:00:00Z' });
    await put(store, { status: 'blocked', stage: 'verify', branch: 'b', question: 'which API?', blockedReason: null, prUrl: 'u' });
    const s = await engine.status();
    expect(s).toEqual({
      paused: false,
      active: [{ taskId: 'T-1', step: 'build', claimBy: 'other', claimUntil: claimedBy('other', clock).claimUntil }],
      counts: { build: 2, blocked: 1 },
      tasks: [
        { taskId: 'T-1', title: 'Add widget', repo: 'data', status: 'build', stage: 'build', blockedReason: null, question: null, prUrl: null },
        { taskId: 'T-2', title: 'Add widget', repo: 'data', status: 'build', stage: 'build', blockedReason: null, question: null, prUrl: null },
        { taskId: 'T-3', title: 'Add widget', repo: 'data', status: 'blocked', stage: 'verify', blockedReason: null, question: 'which API?', prUrl: 'u' },
      ],
      factories: [{ factoryId: 'blocks', name: 'blocks', active: true, paused: false, counts: { build: 2, blocked: 1 }, ghUser: 'gh-blocks', ghLoggedIn: null }],
    });
  });
});

describe('status per factory', () => {
  test('a filter limits tasks and factories; ghLoggedIn comes from the health row', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a');
    await putIn(store, 'b');
    await store.setFactoryHealth({ factoryId: 'b', ghLoggedIn: false, checkedAt: '2026-11-10T00:00:00Z' });
    const s = await engine.status(['b']);
    expect(s.tasks.map((t) => t.taskId)).toEqual(['T-2']);
    expect(s.factories).toEqual([{ factoryId: 'b', name: 'b', active: true, paused: false, counts: { ready: 1 }, ghUser: 'gh-b', ghLoggedIn: false }]);
    expect((await engine.status()).factories.map((f) => [f.factoryId, f.ghLoggedIn])).toEqual([['a', null], ['b', false]]);
  });
});

describe('status settings isolation', () => {
  test('paused in a/api does not touch b/api', async () => {
    const { store, engine } = setup(TWO());
    await store.setSettings({ factories: { a: { factory: DEFAULT_SETTINGS, repos: { api: { paused: true } } } } });
    await putIn(store, 'a');
    await putIn(store, 'b');
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-2' });
    expect((await engine.status()).factories.map((f) => f.paused)).toEqual([false, false]);
  });
});

describe('sync log', () => {
  test('a task skipped by sync is logged with its first error line', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const { store, engine, github } = setup({ log: (m) => logs.push(m) });
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-x', base: 'dev', title: 't', body: 'b' });
    await put(store, { status: 'pr_open', branch: 'factory/T-1-x', prUrl: pr.url });
    vi.spyOn(github, 'prState').mockRejectedValue(new Error('GitHub down\nstack'));
    const p = engine.sync();
    await vi.runAllTimersAsync();
    await p;
    expect(logs).toEqual(['sync: skipped T-1: GitHub down']);
  });
});

describe('withRetry', () => {
  test('waits 500 then 1000 ms between three tries, then throws', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    const p = withRetry(fn, { tries: 3, baseMs: 500 });
    const settled = expect(p).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);
    await settled;
  });

  test('never retries a SecretMissingError', async () => {
    const fn = vi.fn().mockRejectedValue(new SecretMissingError('a secret not found'));
    await expect(withRetry(fn, { tries: 3, baseMs: 500 })).rejects.toBeInstanceOf(SecretMissingError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['NotFoundError', new NotFoundError('task T-9')],
    ['OwnerOnlyError', new OwnerOnlyError('createTask is done on the Board, not by the factory core')],
    ['ForbiddenError', new ForbiddenError('task T-1 update forbidden')],
    ['RereadAfterUpdateError', new RereadAfterUpdateError('T-1')],
  ])('never retries a %s', async (_name, error) => {
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn, { tries: 3, baseMs: 500 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('never retries a VersionConflictError', async () => {
    const fn = vi.fn().mockRejectedValue(new VersionConflictError('T-1', 1, 2));
    await expect(withRetry(fn, { tries: 3, baseMs: 500 })).rejects.toBeInstanceOf(VersionConflictError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('next with peek', () => {
  test('reports the task next would claim and claims nothing', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a');
    await putIn(store, 'a');
    expect(await engine.next(undefined, undefined, { peek: true })).toEqual({ kind: 'work', taskId: 'T-1' });
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null });
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-1' });
  });

  test('says nothing to do when every ready task waits on a dependency', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a', { status: 'inbox' });
    await putIn(store, 'a', { status: 'ready', dependsOn: ['T-1'] });
    expect(await engine.next(undefined, undefined, { peek: true })).toEqual({ kind: 'none', reason: 'nothing to do' });
  });

  test('a factory at maxParallel has no work to peek', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a');
    await putIn(store, 'a');
    await putIn(store, 'a');
    await nextTicket(engine);
    await nextTicket(engine);
    expect(await engine.next(undefined, undefined, { peek: true })).toEqual({ kind: 'none', reason: 'nothing to do' });
  });

  test('a named waiting task still reports what it waits on', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a', { status: 'inbox' });
    await putIn(store, 'a', { status: 'ready', dependsOn: ['T-1'] });
    expect(await engine.next('T-2', undefined, { peek: true })).toEqual({ kind: 'none', reason: 'waiting', taskId: 'T-2', waitingOn: ['T-1'] });
  });
});

describe('next with dependencies', () => {
  const dep = (ids: string[]): Partial<Task> => ({ status: 'ready', dependsOn: ids });

  test('a task waits while its dependency is in spec; the dependency is claimed first', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a');
    await putIn(store, 'a', dep(['T-1']));
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-1' });
    expect(await engine.next()).toEqual({ kind: 'none', reason: 'nothing to do' });
    expect(await store.getTask('T-2')).toMatchObject({ status: 'ready', claimBy: null });
  });

  test('a dependency still in inbox leaves nothing to do', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a', { status: 'inbox' });
    await putIn(store, 'a', dep(['T-1']));
    expect(await engine.next()).toEqual({ kind: 'none', reason: 'nothing to do' });
  });

  test.each(['pr_open', 'cancelled'] as const)('a dependency in %s releases the task', async (status) => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a', { status });
    await putIn(store, 'a', dep(['T-1']));
    expect(await nextTicket(engine)).toMatchObject({ taskId: 'T-2' });
  });

  test('a blocked dependency keeps the task waiting', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a', { status: 'blocked', stage: 'build' });
    await putIn(store, 'a', dep(['T-1']));
    expect(await engine.next()).toEqual({ kind: 'none', reason: 'nothing to do' });
  });

  test('a named waiting task reports what it waits on and is not claimed', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a', { status: 'inbox' });
    await putIn(store, 'a', dep(['T-1']));
    expect(await engine.next('T-2')).toEqual({ kind: 'none', reason: 'waiting', taskId: 'T-2', waitingOn: ['T-1'] });
    expect(await store.getTask('T-2')).toMatchObject({ status: 'ready', claimBy: null });
  });

  test('a task past ready is still picked when its dependency went back to build', async () => {
    const { store, engine } = setup(TWO());
    await putIn(store, 'a', { status: 'build', stage: 'build', claimBy: 'other', claimUntil: '2000-01-01T00:00:00.000Z' });
    const t = await putIn(store, 'a', { status: 'plan', stage: 'plan', branch: 'factory/T-2-a', dependsOn: ['T-1'] });
    await store.addDoc(t.taskId, 'spec', 'spec', 'a');
    const o = await engine.next('T-2');
    expect(o.kind).toBe('ticket');
  });
});
