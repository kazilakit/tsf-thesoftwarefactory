import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { defFixture, repoFixture, seed } from './factoryFixtures.js';
import type { Exec } from '../src/checks.js';
import type { ExecFile } from '../src/secrets.js';
import { run, type CliDeps, type WireOptions } from '../src/cli.js';
import { Engine } from '../src/engine.js';
import { FactoryConfig } from '../src/factories.js';
import type { GitRepos } from '../src/git.js';
import { FakeGitHub } from '../src/github.js';
import { FakeGitHubBoard, type GitHubBoard } from '../src/githubBoard.js';
import { FakeGitHubSetup } from '../src/githubSetup.js';
import { FileStore, MemoryStore } from '../src/store.js';
import { emptyPushed } from '../src/githubLink.js';
import { issueBody } from '../src/githubPush.js';
import { GhLoginMissingError } from '../src/secrets.js';
import type { RepoId, Task } from '../src/types.js';

const ROOT = join(tmpdir(), 'factory-cli-test');
const git: GitRepos = {
  ensureClone: async (f, c) => join(ROOT, '.clones', f, c.repoId),
  worktree: async (_f, _c, taskId) => join(ROOT, '.clones', 'worktrees', taskId),
  push: async () => {},
  isClean: async () => true,
};

/** gh's `auth status --json hosts` answer for logins in state success on github.com. */
const ghStatusJson = (logins: string[]) =>
  JSON.stringify({ hosts: { 'github.com': logins.map((login) => ({ host: 'github.com', login, state: 'success', active: false })) } });

/** A fake `gh`: the listed names are the logged-in gh logins. It never runs the real gh, and refuses anything but `gh auth status`. */
const fakeGh = (logins: string[] = ['gh-blocks'], gh: { code?: number; stdout?: string } = {}): ExecFile => async (file, args) => {
  if (file !== 'gh' || args.join(' ') !== 'auth status --hostname github.com --json hosts') throw new Error(`unexpected ${file} ${args.join(' ')}`);
  return { code: gh.code ?? 0, stdout: gh.stdout ?? ghStatusJson(logins), stderr: '' };
};

function setup(factories = seed(), logins?: string[], ghCalls?: string[][], gh?: { code?: number; stdout?: string }, files?: string[], board?: GitHubBoard) {
  const store = new MemoryStore({ factories });
  const exec: Exec = async () => ({ code: 0, output: '' });
  const engine = new Engine({
    store, git, githubFor: () => new FakeGitHub(), factories: async () => new FactoryConfig(factories.defs, factories.repos),
    exec, now: () => new Date(), mode: 'session', claimant: 'me',
  });
  const wired: WireOptions[] = [];
  const makeEngine = async (o: WireOptions) => {
    wired.push(o);
    return { engine, store };
  };
  const out: string[] = [];
  const err: string[] = [];
  const fake = fakeGh(logins, gh);
  const exec2: ExecFile = (file, args, stdin) => {
    ghCalls?.push(args);
    files?.push(file);
    return fake(file, args, stdin);
  };
  const fakeSetup = new FakeGitHubSetup();
  fakeSetup.repos.set('org/data', { defaultBranch: 'main', branches: ['dev'] });
  const goWith = (extra: CliDeps, ...argv: string[]) => run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, makeEngine, { exec: exec2, githubSetupFor: () => fakeSetup, ...(board ? { githubBoardFor: () => board } : {}), ...extra });
  const go = (...argv: string[]) => goWith({}, ...argv);
  return { store, out, err, go, goWith, wired };
}

const put = async (store: MemoryStore, patch: Partial<Task>) => {
  const t = await store.createTask({ factoryId: 'blocks', title: 'Add widget', description: 'd', repo: 'data' });
  return store.updateTask(t.taskId, t.version, patch);
};

// The CLI reads these from the environment; clear them so the suite passes with or without them exported.
const AMBIENT = ['FACTORY_STORE', 'FACTORY_STORE_LOCAL_PATH', 'FACTORY_ROOT', 'FACTORY_CLAIMANT'] as const;
const ambient: Partial<Record<(typeof AMBIENT)[number], string>> = {};
beforeAll(() => {
  for (const k of AMBIENT) {
    if (process.env[k] !== undefined) ambient[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of AMBIENT) {
    if (ambient[k] === undefined) delete process.env[k];
    else process.env[k] = ambient[k];
  }
});

describe('factory cli', () => {
  test('next --json prints a ticket at the spec step', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).step).toBe('spec');
  });

  test('next prints a short line, and nothing to do when idle', async () => {
    const { store, out, go } = setup();
    expect(await go('next')).toBe(0);
    expect(out).toEqual(['nothing to do']);
    await put(store, { status: 'ready' });
    await go('next');
    expect(out[1]).toMatch(/^T-1 spec \(worktree .*T-1\)$/);
  });

  test('next prints paused when the factory is paused', async () => {
    const { store, out, go } = setup();
    await store.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    await put(store, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(out).toEqual(['paused']);
    expect((await store.getTask('T-1')).claimBy).toBeNull();
  });

  test('next with no factory definitions prints the init hint and leaves the task ready', async () => {
    const { store, out, go } = setup({ defs: [], repos: [] });
    await put(store, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(out).toEqual(['no factories; run ./factory init']);
    expect((await store.getTask('T-1')).status).toBe('ready');
  });

  test('next --factory limits the pass to the named factories; an unknown one exits 1', async () => {
    const { store, out, err, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('next', '--factory', 'other')).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['unknown factory other']);
    expect((await store.getTask('T-1')).claimBy).toBeNull();
    expect(await go('next', '--factory', 'blocks', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ taskId: 'T-1', context: { factory: { factoryId: 'blocks' } } });
  });

  test('complete with a missing result file blocks the task', async () => {
    const { store, go } = setup();
    await put(store, { status: 'ready' });
    await go('next');
    expect(await go('complete', 'T-1', 'spec', '--result', 'missing.json')).toBe(0);
    const t = await store.getTask('T-1');
    expect(t.status).toBe('blocked');
    expect(t.blockedReason).toMatch(/^invalid agent result/);
  });

  const replyFile = (text: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'factory-reply-')), 'reply.txt');
    writeFileSync(f, text);
    return f;
  };
  const SPEC_REPLY = '<factory-result>\n{"status":"done","summary":"s"}\n</factory-result>\n<factory-doc>\n# Spec\n</factory-doc>';

  test('complete --reply records the doc like --result', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    await go('next');
    expect(await go('complete', 'T-1', 'spec', '--reply', replyFile(SPEC_REPLY))).toBe(0);
    expect(out.at(-1)).toBe('T-1 spec_review');
    expect(await store.currentDoc('T-1', 'spec')).toMatchObject({ body: '# Spec' });
  });

  test('complete needs exactly one of --result or --reply', async () => {
    const { err, go } = setup();
    expect(await go('complete', 'T-1', 'spec')).toBe(1);
    expect(await go('complete', 'T-1', 'spec', '--result', 'a.json', '--reply', 'b.txt')).toBe(1);
    expect(err).toEqual(['error: pass exactly one of --result or --reply', 'error: pass exactly one of --result or --reply']);
  });

  describe('FACTORY_STORE', () => {
    afterEach(() => {
      delete process.env.FACTORY_STORE;
    });

    test('FACTORY_STORE defaults to local; local and file open the file store', async () => {
      const { go, wired } = setup();
      expect(await go('status')).toBe(0);
      process.env.FACTORY_STORE = 'local';
      expect(await go('status')).toBe(0);
      process.env.FACTORY_STORE = '';
      expect(await go('status')).toBe(0);
      expect(await go('--store', 'file', 'status')).toBe(0);
      expect(wired).toHaveLength(4);
    });

    test.each([['factory-app'], ['blocks']])('FACTORY_STORE=%s exits 1 with one line, before any store is built', async (v) => {
      const { err, go, wired } = setup();
      process.env.FACTORY_STORE = v;
      expect(await go('status')).toBe(1);
      expect(await go('dev', 'cancel', 'T-1')).toBe(1);
      const line = `error: --store ${v}: the factory-app store is not part of this build; use local`;
      expect(err).toEqual([line, line]);
      expect(wired).toHaveLength(0);
    });

    test('an invalid value exits 1', async () => {
      const { err, go } = setup();
      process.env.FACTORY_STORE = 'nope';
      expect(await go('status')).toBe(1);
      expect(err).toEqual(['error: --store must be local (or file)']);
    });
  });

  test('dev approve for a missing doc exits 1', async () => {
    const { store, err, go } = setup();
    await put(store, { status: 'spec_review', stage: 'spec' });
    expect(await go('dev', 'approve', 'T-1', 'plan')).toBe(1);
    expect(err.join('\n')).toMatch(/no current plan doc/);
  });



  test('the engine log goes to stderr', async () => {
    const { err, go, wired } = setup();
    await go('status');
    wired[0]!.log!('sync: skipped T-1: GitHub down');
    expect(err).toEqual(['sync: skipped T-1: GitHub down']);
  });

  test('status prints blocked tasks with their questions', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'blocked', stage: 'verify', question: 'AC3: which API?' });
    await put(store, { status: 'blocked', stage: 'build', blockedReason: 'returned to build 3 times', question: 'tests fail' });
    await go('status');
    expect(out).toContain('blocked: T-1 at verify, question: AC3: which API?');
    expect(out).toContain('blocked: T-2 at build (returned to build 3 times), question: tests fail');
  });

  test('ship against a branch dev exits 1 with one line', async () => {
    const { store, err, go } = setup();
    await put(store, {
      status: 'review', stage: 'ship', branch: 'dev', claimBy: 'me',
      claimUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await go('ship', 'T-1')).toBe(1);
    expect(err).toEqual(['error: push to dev refused (protected branch)']);
  });

  test('dev add, ready, approve, answer, cancel write events as you', async () => {
    const { store, out, err, go } = setup();
    expect(await go('dev', 'add', '--repo', 'data', '--title', 'X', '--description', 'd')).toBe(0);
    expect(await go('dev', 'ready', 'T-1')).toBe(0);
    expect((await store.getTask('T-1')).status).toBe('ready');

    await put(store, { status: 'spec_review', stage: 'spec' });
    await store.addDoc('T-2', 'spec', 'S', 'a');
    expect(await go('dev', 'approve', 'T-2', 'spec')).toBe(0);
    expect(await store.listApprovals('T-2')).toMatchObject([{ gate: 'spec', docVersion: 1, decision: 'approve' }]);
    const ev = (await store.listEvents('T-2')).find((e) => e.field === 'approval');
    expect(ev).toMatchObject({ actor: 'you', action: 'set', to: 'spec:approve@v1' });

    expect(await go('dev', 'answer', 'T-2', 'hi')).toBe(1);
    expect(err.at(-1)).toBe('error: T-2 is not blocked');
    await store.updateTask('T-2', (await store.getTask('T-2')).version, { status: 'blocked' });
    expect(await go('dev', 'answer', 'T-2', 'hi')).toBe(0);
    expect((await store.getTask('T-2')).answer).toBe('hi');

    expect(await go('dev', 'cancel', 'T-2')).toBe(0);
    expect((await store.getTask('T-2')).status).toBe('cancelled');
    expect(await go('dev', 'ready', 'T-2')).toBe(1);
    expect(out.length).toBeGreaterThan(0);
  });

  test('dev commands keep the owner rules: a blank title, a task not at the gate and a blank answer exit 1', async () => {
    const { store, err, go } = setup();
    expect(await go('dev', 'add', '--repo', 'data', '--title', ' ')).toBe(1);
    expect(err.at(-1)).toBe('error: title must not be blank');
    expect(await store.listTasks()).toEqual([]);

    await put(store, { status: 'plan_review', stage: 'plan' });
    await store.addDoc('T-1', 'spec', 'S', 'a');
    expect(await go('dev', 'approve', 'T-1', 'spec')).toBe(1);
    expect(err.at(-1)).toBe('error: T-1 is not waiting at the spec gate');
    expect(await store.listApprovals('T-1')).toEqual([]);

    await store.updateTask('T-1', (await store.getTask('T-1')).version, { status: 'blocked' });
    expect(await go('dev', 'answer', 'T-1', ' ')).toBe(1);
    expect(err.at(-1)).toBe('error: answer must not be blank');
  });

  test('dev approve --changes records the comment as the event reason', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'plan_review', stage: 'plan' });
    await store.addDoc('T-1', 'plan', 'P', 'a');
    expect(await go('dev', 'approve', 'T-1', 'plan', '--changes', 'split step 3')).toBe(0);
    expect(out).toEqual(['T-1 plan changes v1']);
    expect((await store.listEvents('T-1')).find((e) => e.field === 'approval')).toMatchObject({ to: 'plan:changes@v1', reason: 'split step 3' });
  });

  test('renew extends the held claim and prints the new claimUntil', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', claimBy: 'me', claimUntil: new Date(Date.now() + 1000).toISOString() });
    expect(await go('renew', 'T-1')).toBe(0);
    const t = await store.getTask('T-1');
    expect(Date.parse(t.claimUntil!)).toBeGreaterThan(Date.now() + 500_000);
    expect(out).toEqual([`T-1 claimed until ${t.claimUntil}`]);
  });

  test('renew of a claim not held exits 1 with one line', async () => {
    const { store, err, go } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', claimBy: 'other', claimUntil: new Date(Date.now() + 1000).toISOString() });
    expect(await go('renew', 'T-1')).toBe(1);
    expect(err).toEqual(['error: T-1 is not claimed by me']);
    expect((await store.getTask('T-1')).claimBy).toBe('other');
  });

  test('status --json and plain', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('status', '--json')).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json.counts).toEqual({ ready: 1 });
    expect(json.tasks).toMatchObject([{ taskId: 'T-1', status: 'ready' }]);
    expect(json.factories).toMatchObject([{ factoryId: 'blocks', name: 'blocks', active: true, paused: false, counts: { ready: 1 }, ghLoggedIn: true }]);
    await go('status');
    expect(out.slice(1).join('\n')).toMatch(/factory blocks: active, paused false, gh gh-blocks logged in, ready=1\n.*ready: 1/s);
  });
});

describe('factories, status health and --factory', () => {
  const two = () => ({ defs: [defFixture('blocks'), defFixture('delta')], repos: [repoFixture('blocks', 'data'), repoFixture('delta', 'api')] });

  test('next --factory delta prints paused for a paused delta', async () => {
    const { store, out, go } = setup(two());
    await store.setSettings({ factories: { delta: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    const t = await store.createTask({ factoryId: 'delta', title: 'x', description: '', repo: 'api', status: 'ready' });
    expect(t.status).toBe('ready');
    expect(await go('next', '--factory', 'delta')).toBe(0);
    expect(out).toEqual(['paused']);
  });

  test('factories --json lists defs and repos, names the gh login and has no token', async () => {
    const { out, go } = setup(two());
    expect(await go('factories', '--json')).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.factories.map((f: { factoryId: string }) => f.factoryId)).toEqual(['blocks', 'delta']);
    expect(json.factories[1].repos).toMatchObject([{ repoId: 'api' }]);
    expect(out.join('\n')).not.toMatch(/secret/);
    expect(json.factories[0].ghUser).toBe('gh-blocks');
    expect(Object.keys(json.factories[0]).filter((k) => /token|secret|^pat/i.test(k))).toEqual([]);
    await go('factories');
    expect(out.at(-1)).toBe('delta (delta) active: api');
  });

  test('new without --factory exits 1 with two active factories, and works with one', async () => {
    const two2 = setup(two());
    expect(await two2.go('new', '--repo', 'data', '--title', 'X', '--description', 'd')).toBe(1);
    expect(two2.err).toEqual(['error: --factory is required (active: blocks, delta)']);
    expect(await two2.store.listTasks()).toEqual([]);
    expect(await two2.go('new', '--factory', 'delta', '--repo', 'api', '--title', 'X', '--description', 'd')).toBe(0);
    expect(await two2.store.getTask('T-1')).toMatchObject({ factoryId: 'delta' });
    // An inactive factory does not count.
    const one = setup({ defs: [defFixture('blocks'), defFixture('delta', { active: false })], repos: two().repos });
    expect(await one.go('new', '--repo', 'data', '--title', 'X', '--description', 'd')).toBe(0);
    expect(await one.store.getTask('T-1')).toMatchObject({ factoryId: 'blocks' });
  });

  test('dev add needs --factory with two active factories', async () => {
    const { err, go } = setup(two());
    expect(await go('dev', 'add', '--repo', 'data', '--title', 'X')).toBe(1);
    expect(err).toEqual(['error: --factory is required (active: blocks, delta)']);
  });

  test('status writes a health row per factory and prints the gh login state (R16)', async () => {
    const { store, out, go } = setup(two(), ['gh-blocks']);
    expect(await go('status')).toBe(0);
    expect(out).toContain('factory blocks: active, paused false, gh gh-blocks logged in');
    expect(out).toContain('factory delta: active, paused false, gh gh-delta not logged in');
    const health = await store.listFactoryHealth();
    expect(health.map((h) => [h.factoryId, h.ghLoggedIn])).toEqual([['blocks', true], ['delta', false]]);
    expect(JSON.stringify(health)).not.toMatch(/secret/);
  });

  test('status asks gh auth status once, never gh auth token, and never the Keychain (R16)', async () => {
    const calls: string[][] = [];
    const files: string[] = [];
    const { out, go } = setup(two(), ['gh-blocks'], calls, undefined, files);
    expect(await go('status')).toBe(0);
    expect(calls).toEqual([['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']]);
    expect(files).toEqual(['gh']);
    expect(calls.some((a) => a.includes('token'))).toBe(false);
    expect(out).toContain('factory blocks: active, paused false, gh gh-blocks logged in');
  });

  test('status matches the login ignoring case, and only in state success (R16)', async () => {
    const stdout = JSON.stringify({ hosts: { 'github.com': [{ login: 'GH-Blocks', state: 'success' }, { login: 'gh-delta', state: 'error' }], 'ghe.example.com': [{ login: 'gh-delta', state: 'success' }] } });
    const { store, go } = setup(two(), [], undefined, { stdout });
    expect(await go('status')).toBe(0);
    expect((await store.listFactoryHealth()).map((h) => [h.factoryId, h.ghLoggedIn])).toEqual([['blocks', true], ['delta', false]]);
  });

  test.each([
    ['gh fails', { code: 1, stdout: '' }],
    ['gh prints no JSON', { stdout: 'not json' }],
    ['gh prints another shape', { stdout: '{"hosts":[]}' }],
  ])('%s: every factory is not logged in (R16)', async (_name, gh) => {
    const { store, out, go } = setup(two(), ['gh-blocks', 'gh-delta'], undefined, gh);
    expect(await go('status')).toBe(0);
    expect((await store.listFactoryHealth()).map((h) => h.ghLoggedIn)).toEqual([false, false]);
    expect(out).toContain('factory blocks: active, paused false, gh gh-blocks not logged in');
  });

  test('status prints unknown for a factory never checked (M2)', async () => {
    const { store, out, go } = setup(two());
    store.listFactoryDefs = async () => []; // nothing to probe: the health rows stay unwritten
    expect(await go('status')).toBe(0);
    expect(out).toContain('factory blocks: active, paused false, gh gh-blocks unknown');
    expect(out).toContain('factory delta: active, paused false, gh gh-delta unknown');
  });

  test('a health write failure is logged and status still succeeds', async () => {
    const { store, out, err, go } = setup();
    store.setFactoryHealth = async () => { throw new Error('refused'); };
    expect(await go('status')).toBe(0);
    expect(err).toEqual(['health of blocks not written: refused']);
    expect(out[1]).toBe('factory blocks: active, paused false, gh gh-blocks logged in');
  });

  test('status probes and records only the loaded, valid factories', async () => {
    const { store, go } = setup({ defs: [defFixture('blocks'), defFixture('bad', { name: '' })], repos: [] });
    expect(await go('status')).toBe(0);
    expect((await store.listFactoryHealth()).map((h) => h.factoryId)).toEqual(['blocks']);
  });

  test('status --factory limits the health check to the named factories', async () => {
    const { store, go } = setup(two());
    expect(await go('status', '--factory', 'delta')).toBe(0);
    expect((await store.listFactoryHealth()).map((h) => h.factoryId)).toEqual(['delta']);
  });
});

describe('next --peek', () => {
  test('prints the task and exits 0 when there is work, claiming nothing', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('next', '--peek')).toBe(0);
    expect(out).toEqual(['work T-1']);
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null });
  });

  test('prints the reason and exits 1 when there is none', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'inbox' });
    expect(await go('next', '--peek')).toBe(1);
    expect(out).toEqual(['nothing to do']);
  });

  test('refuses --peek with --json', async () => {
    const { go } = setup();
    expect(await go('next', '--peek', '--json')).toBe(1);
  });
});

describe('dependencies', () => {
  test('next T-2 prints what it waits on', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'inbox' });
    await put(store, { status: 'ready', dependsOn: ['T-1'] });
    expect(await go('next', 'T-2')).toBe(0);
    expect(out).toEqual(['T-2 is waiting on T-1']);
  });

  test('new --depends-on stores the list', async () => {
    const { store, go } = setup();
    await put(store, {});
    await put(store, {});
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', 'd', '--depends-on', 'T-1, T-2')).toBe(0);
    expect((await store.getTask('T-3')).dependsOn).toEqual(['T-1', 'T-2']);
  });

  test('dev add --depends-on stores the list', async () => {
    const { store, go } = setup();
    await put(store, {});
    expect(await go('dev', 'add', '--repo', 'data', '--title', 'X', '--depends-on', 'T-1')).toBe(0);
    expect((await store.getTask('T-2')).dependsOn).toEqual(['T-1']);
  });
});

describe('new', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'factory-new-'));

  test('creates an inbox task and prints the line; the event is core · new', async () => {
    const { store, out, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'Fix typo', '--description', 'd')).toBe(0);
    expect(out).toEqual(['T-1 created in inbox']);
    expect(await store.getTask('T-1')).toMatchObject({ title: 'Fix typo', description: 'd', repo: 'data', baseBranch: 'dev', status: 'inbox' });
    expect(await store.listEvents('T-1')).toMatchObject([{ actor: 'core · new', action: 'create', to: 'inbox', reason: 'created by factory new' }]);
  });

  test('--ready creates in ready; --base is used', async () => {
    const { store, out, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', '', '--ready', '--base', 'stg')).toBe(0);
    expect(out).toEqual(['T-1 created in ready']);
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', baseBranch: 'stg' });
  });

  test('--description-file reads the text as is', async () => {
    const { store, go } = setup();
    const file = join(dir(), 'd.md');
    writeFileSync(file, 'line one\n"quoted" $x `y`\n');
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description-file', file)).toBe(0);
    expect((await store.getTask('T-1')).description).toBe('line one\n"quoted" $x `y`\n');
  });

  test('--json prints the task', async () => {
    const { out, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', 'd', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ taskId: 'T-1', status: 'inbox' });
  });

  test('exactly one description source', async () => {
    const { store, err, go } = setup();
    const file = join(dir(), 'd.md');
    writeFileSync(file, 'x');
    expect(await go('new', '--repo', 'data', '--title', 'X')).toBe(1);
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', 'a', '--description-file', file)).toBe(1);
    expect(err).toEqual(Array(2).fill('error: pass exactly one of --description or --description-file'));
    expect(await store.listTasks()).toEqual([]);
  });

  test('a missing file, base main and an unknown repo exit 1 with one line', async () => {
    const { store, err, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description-file', '/nope/none.md')).toBe(1);
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', 'd', '--base', 'main')).toBe(1);
    expect(await go('new', '--repo', 'ZZZ!', '--title', 'X', '--description', 'd')).toBe(1);
    expect(err[0]).toBe('error: cannot read --description-file /nope/none.md');
    expect(err[1]).toContain('the factory never targets main');
    expect(err[2]).toContain('--repo must be a repo id');
    expect(await store.listTasks()).toEqual([]);
  });

});

describe('factory doctor', () => {
  const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
    plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
    pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as never;
  const github = { mode: 'github-only' as const, project: { owner: 'octo-user', number: 3 }, label: 'factory', approvers: ['gh-blocks'], statusMap: map };
  const withGithub = () => ({ defs: [defFixture('blocks', { github })], repos: [repoFixture('blocks', 'data')] });
  const board = (options: string[]) => {
    const b = new FakeGitHubBoard();
    b.addProject({ owner: 'octo-user', number: 3 }, options);
    b.labels.set('org/data', new Set(['factory']));
    return b;
  };

  test('prints a line per check and exits 0 when all pass (file store: with repo and base lines)', async () => {
    const { out, err, go } = setup(withGithub(), ['gh-blocks'], undefined, undefined, undefined, board(['Backlog', 'Todo', 'In progress', 'In review', 'Merged']));
    expect(await go('--store', 'file', 'doctor')).toBe(0);
    expect(out).toEqual([
      'ok blocks gh login: gh-blocks logged in',
      'ok blocks repo data: org/data reachable as gh-blocks',
      'ok blocks base data: dev exists',
      'ok blocks config: ok',
      'ok blocks scope: project scope present',
      'ok blocks project: octo-user/3 found',
      'ok blocks status options: all 13 statuses map to existing options',
      'ok blocks label data: exists',
    ]);
    expect(err).toEqual([]);
  });


  test('exits 1 on a failing check, with no extra error line', async () => {
    const { out, err, go } = setup(withGithub(), ['gh-blocks'], undefined, undefined, undefined, board(['Backlog', 'Todo', 'In progress', 'In review']));
    expect(await go('doctor')).toBe(1);
    expect(out).toContain('FAIL blocks status options: missing on the Project: Merged');
    expect(err).toEqual([]);
  });

  test('--json prints checks and still exits 1 on failure', async () => {
    const { out, go } = setup(withGithub(), [], undefined, undefined, undefined, board([]));
    expect(await go('doctor', '--json')).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual({ checks: [{ factoryId: 'blocks', check: 'gh login', ok: false, detail: 'gh-blocks is not logged in (run: gh auth login --hostname github.com)' }] });
  });

  test('prints FAIL for an invalid factory.yaml and exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-doctor-'));
    try {
      mkdirSync(join(dir, 'factories', 'broken'), { recursive: true });
      writeFileSync(join(dir, 'factories', 'broken', 'factory.yaml'), 'factory:\n  agents:\n    build: nonsense-model\n');
      const store = new FileStore(join(dir, 'board.json'), { factoriesDir: join(dir, 'factories') });
      const factories = withGithub();
      const engine = new Engine({
        store, git, githubFor: () => new FakeGitHub(), factories: async () => new FactoryConfig(factories.defs, factories.repos),
        exec: async () => ({ code: 0, output: '' }), now: () => new Date(), mode: 'session', claimant: 'me',
      });
      const out: string[] = [];
      const code = await run(['--store', 'file', 'doctor'], { out: (l) => out.push(l), err: () => {} }, async () => ({ engine, store }),
        { exec: fakeGh(['gh-blocks']), githubBoardFor: () => new FakeGitHubBoard(), githubSetupFor: () => new FakeGitHubSetup() });
      expect(code).toBe(1);
      expect(out.some((l) => l.startsWith('FAIL broken config file: ') && l.includes('fix the file or run ./factory init'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an unknown --factory exits 1', async () => {
    const { err, go } = setup(withGithub(), ['gh-blocks'], undefined, undefined, undefined, board([]));
    expect(await go('doctor', '--factory', 'nope')).toBe(1);
    expect(err).toEqual(['error: unknown factory: nope']);
  });
});

describe('GitHub pushing from the CLI', () => {
  const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
    plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
    pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as never;
  const github = { mode: 'github-only' as const, project: { owner: 'o', number: 3 }, label: 'factory', approvers: ['gh-blocks'], statusMap: map };
  const withGithub = () => ({ defs: [defFixture('blocks', { github })], repos: [repoFixture('blocks', 'app', { remote: 'git@github.com:o/app.git' })] });
  const newBoard = () => {
    const b = new FakeGitHubBoard();
    b.addProject({ owner: 'o', number: 3 }, ['Backlog', 'Todo', 'In progress', 'In review', 'Merged']);
    return b;
  };
  const NEW = ['new', '--repo', 'app', '--title', 'Do it', '--description', 'd'];
  const direct = (store: MemoryStore) => store.createTask({ factoryId: 'blocks', title: 'Do it', description: 'd', repo: 'app' });

  test('new pushes at once and prints the issue', async () => {
    const board = newBoard();
    const { out, err, go } = setup(withGithub(), [], undefined, undefined, undefined, board);
    expect(await go(...NEW)).toBe(0);
    expect(out).toEqual(['T-1 created in inbox', 'T-1 issue o/app#1']);
    expect(err).toEqual([]);
    expect(board.issue({ owner: 'o', repo: 'app' }, 1).title).toBe('Do it');
  });

  test('new --json prints only the task JSON', async () => {
    const { out, go } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    expect(await go(...NEW, '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).taskId).toBe('T-1');
  });

  test('new keeps the task when the push fails', async () => {
    const board = newBoard();
    board.project = async () => { throw new GhLoginMissingError('octo-user'); };
    const { err, store, go } = setup(withGithub(), [], undefined, undefined, undefined, board);
    expect(await go(...NEW)).toBe(0);
    expect((await store.getTask('T-1')).title).toBe('Do it');
    expect(err.join('\n')).toContain('github: T-1 not pushed (');
    expect(err.join('\n')).toContain('factory sync retries');
  });

  test('new on a factory without github prints no issue line and makes no board call', async () => {
    const board = newBoard();
    let calls = 0;
    const counting = new Proxy(board, { get: (t, p) => { if (typeof (t as never)[p] === 'function') calls++; return Reflect.get(t, p).bind?.(t) ?? Reflect.get(t, p); } });
    const { out, err, go } = setup(seed(), [], undefined, undefined, undefined, counting);
    expect(await go('new', '--repo', 'data', '--title', 'x', '--description', 'd')).toBe(0);
    expect(out).toEqual(['T-1 created in inbox']);
    expect(err).toEqual([]);
    expect(calls).toBe(0);
  });

  test('dev cancel pushes the close', async () => {
    const board = newBoard();
    const { go } = setup(withGithub(), [], undefined, undefined, undefined, board);
    await go(...NEW);
    expect(await go('dev', 'cancel', 'T-1')).toBe(0);
    expect(board.issue({ owner: 'o', repo: 'app' }, 1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
  });




  test('sync pushes waiting tasks and summarises', async () => {
    const { out, store, go } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    await direct(store);
    expect(await go('sync')).toBe(0);
    expect(out).toEqual(['pulled: created 0, applied 0, not applied 0, failed 0', 'T-1 o/app#1: created, status Backlog', 'pushed 1, failed 0']);
  });

  test('sync exits 1 when a task fails', async () => {
    const board = newBoard();
    board.project = async () => { throw new Error('boom'); };
    const { out, store, go } = setup(withGithub(), [], undefined, undefined, undefined, board);
    await direct(store);
    expect(await go('sync')).toBe(1);
    expect(out).toContain('FAIL T-1: boom');
    expect(out).toContain('pushed 0, failed 1');
  });

  test('sync with no github-only factory', async () => {
    const { out, go } = setup(seed(), [], undefined, undefined, undefined, newBoard());
    expect(await go('sync')).toBe(0);
    expect(out).toEqual(['no factory uses GitHub-only mode']);
  });

  test('sync --watch runs passes until watchTicks', async () => {
    const { out, store, goWith } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    const slept: number[] = [];
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const code = await goWith({ watchTicks: 2, sleep: async (ms) => { slept.push(ms); await direct(store); } }, 'sync', '--watch');
    expect(code).toBe(0);
    expect(slept).toEqual([5000]);
    expect(out).toEqual(['T-1 o/app#1: created, status Backlog']);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  test('sync --watch survives a failing pass', async () => {
    const { out, store, goWith } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    const orig = store.listFactoryDefs.bind(store);
    let n = 0;
    store.listFactoryDefs = async () => { if (n++ === 0) throw new Error('locked\nmore'); return orig(); };
    await direct(store);
    expect(await goWith({ watchTicks: 2, sleep: async () => {} }, 'sync', '--watch', '--interval', '1')).toBe(0);
    expect(out[0]).toBe('error: locked');
    expect(out).toContain('T-1 o/app#1: created, status Backlog');
  });

  test('sync --watch stops on SIGINT during the wait', async () => {
    const { out, store, goWith } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    await direct(store);
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const code = await goWith({ sleep: () => { setTimeout(() => process.emit('SIGINT'), 0); return new Promise<void>(() => {}); } }, 'sync', '--watch');
    expect(code).toBe(0);
    expect(out).toEqual(['T-1 o/app#1: created, status Backlog']);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  test('errors are redacted in output', async () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const { out, err, store, goWith } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    const orig = store.listFactoryDefs.bind(store);
    store.listFactoryDefs = async () => { throw new Error(`locked ${token}`); };
    await goWith({ watchTicks: 1 }, 'sync', '--watch');
    store.listFactoryDefs = orig;
    store.getTask = async () => { throw new Error(`broken ${token}`); };
    await goWith({}, 'new', '--repo', 'app', '--title', 'x', '--description', 'd');
    expect(out.join('\n')).toContain('error: locked [redacted]');
    expect(err.join('\n')).toContain('github: T-1 not pushed (broken [redacted])');
    expect([...out, ...err].join('\n')).not.toContain(token);
  });

  test('sync --interval 0 is refused', async () => {
    const { go } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    expect(await go('sync', '--interval', '0')).toBe(1);
  });

  test('status --json has no githubErrors key without errors', async () => {
    const { out, go } = setup(withGithub(), ['gh-blocks'], undefined, undefined, undefined, newBoard());
    expect(await go('status', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).not.toHaveProperty('githubErrors');
  });

  test('status lists push errors', async () => {
    const { out, store, go } = setup(withGithub(), ['gh-blocks'], undefined, undefined, undefined, newBoard());
    await direct(store);
    await store.saveGitHubLink(null, {
      taskId: 'T-1', factoryId: 'blocks', repo: 'o/app', issueNumber: null, issueNodeId: null, project: null, itemId: null,
      pushed: emptyPushed(), error: { message: 'boom', attempts: 2, nextAttemptAt: '2026-06-01T00:00:10.000Z' }, lease: null, reported: [], version: 0,
    });
    expect(await go('status', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).githubErrors).toHaveLength(1);
    out.length = 0;
    expect(await go('status')).toBe(0);
    expect(out).toContain('github: T-1 push failing (boom), attempt 2, next try 2026-06-01T00:00:10.000Z');
    out.length = 0;
    expect(await go('status', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).githubErrors[0]).toEqual({ taskId: 'T-1', message: 'boom', attempts: 2, nextAttemptAt: '2026-06-01T00:00:10.000Z' });
  });

  const staleLink = (message: string, nextAttemptAt: string) => ({
    taskId: 'T-1', factoryId: 'blocks', repo: 'o/app', issueNumber: null, issueNodeId: null, project: null, itemId: null,
    pushed: emptyPushed(), error: { message, attempts: 1, nextAttemptAt }, lease: null, reported: [], version: 0,
  });

  test('F2: next pushes the other tasks it moved too', async () => {
    const board = newBoard();
    const { store, go } = setup(withGithub(), ['gh-blocks'], undefined, undefined, undefined, board);
    await direct(store);
    const b = await direct(store);
    await go('sync');
    await store.updateTask(b.taskId, (await store.getTask(b.taskId)).version, { status: 'done' });
    await store.updateTask('T-1', (await store.getTask('T-1')).version, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(board.issue({ owner: 'o', repo: 'app' }, 2)).toMatchObject({ state: 'closed', stateReason: 'completed' });
  });

  test('F4: a manual sync retries a task in backoff', async () => {
    const { out, store, go } = setup(withGithub(), [], undefined, undefined, undefined, newBoard());
    await direct(store);
    await store.saveGitHubLink(null, staleLink('boom', '2099-01-01T00:00:00.000Z'));
    expect(await go('sync')).toBe(0);
    expect(out).toContain('T-1 o/app#1: created, status Backlog');
    expect((await store.getGitHubLink('T-1'))!.error).toBeNull();
  });

  test('M4: status hides stale errors of a factory that is not github-only any more', async () => {
    const { out, store, go } = setup(seed(), ['gh-blocks'], undefined, undefined, undefined, newBoard());
    await direct(store);
    await store.saveGitHubLink(null, staleLink('boom', '2026-06-01T00:00:10.000Z'));
    expect(await go('status', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).not.toHaveProperty('githubErrors');
  });

  test('M6: a failing health write is redacted', async () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const { err, store, go } = setup();
    store.setFactoryHealth = async () => { throw new Error(`nope ${token}`); };
    await go('status');
    expect(err.join('\n')).toContain('health of blocks not written: nope [redacted]');
  });

  test('M7: sync --watch with no github-only factory says so once and keeps watching', async () => {
    const { out, goWith } = setup(seed(), [], undefined, undefined, undefined, newBoard());
    const slept: number[] = [];
    expect(await goWith({ watchTicks: 3, sleep: async (ms) => { slept.push(ms); } }, 'sync', '--watch')).toBe(0);
    expect(out).toEqual(['no factory uses GitHub-only mode']);
    expect(slept).toHaveLength(2);
  });

  test('M4b: status still lists errors of github-only factories', async () => {
    const { out, store, go } = setup(withGithub(), ['gh-blocks'], undefined, undefined, undefined, newBoard());
    await direct(store);
    await store.saveGitHubLink(null, staleLink('boom', '2026-06-01T00:00:10.000Z'));
    await go('status', '--json');
    expect(JSON.parse(out.join('\n')).githubErrors).toHaveLength(1);
  });
});

describe('GitHub pulling from the CLI', () => {
  const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
    plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
    pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as never;
  const github = { mode: 'github-only' as const, project: { owner: 'o', number: 3 }, label: 'factory', approvers: ['gh-blocks'], statusMap: map };
  const withGithub = () => ({ defs: [defFixture('blocks', { github })], repos: [repoFixture('blocks', 'app', { remote: 'git@github.com:o/app.git' })] });
  const REPO = { owner: 'o', repo: 'app' };
  const PROJECT = { owner: 'o', number: 3 };
  const newBoard = () => {
    const b = new FakeGitHubBoard();
    b.addProject(PROJECT, ['Backlog', 'Todo', 'In progress', 'In review', 'Merged']);
    return b;
  };
  /** An issue on the Project in `option`, with the factory label; `body` may carry a marker. */
  const issue = async (board: FakeGitHubBoard, option: string, title = 'From GitHub', body = 'please') => {
    const made = await board.createIssue(REPO, { title, body, labels: ['factory'] });
    const project = (await board.project(PROJECT))!;
    const item = await board.addToProject(project, made.nodeId);
    await board.setStatus(project, item, option);
    return { number: made.number, item, project };
  };
  const memLock = () => {
    const held = new Set<string>();
    const taken: string[] = [];
    const lock = async (f: string) => {
      if (held.has(f)) return null;
      held.add(f);
      taken.push(f);
      return () => { held.delete(f); };
    };
    return { held, taken, lock };
  };
  const wire = (board: FakeGitHubBoard, extra: CliDeps = {}) => ({ githubFor: () => new FakeGitHub(), pullLock: memLock().lock, githubBoardFor: () => board, ...extra });

  test('next pulls a new Todo issue and hands out its spec ticket', async () => {
    const board = newBoard();
    await issue(board, 'Todo');
    const { out, err, goWith } = setup(withGithub());
    expect(await goWith(wire(board), '--store', 'file', 'next')).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^T-1 spec \(worktree /);
    expect(err).toContain('github: T-1 created from o/app#1 (ready)');
  });

  test('next --peek pulls too', async () => {
    const board = newBoard();
    await issue(board, 'Todo');
    const { out, goWith } = setup(withGithub());
    expect(await goWith(wire(board), '--store', 'file', 'next', '--peek')).toBe(0);
    expect(out).toEqual(['work T-1']);
  });

  test('next still works when the pull fails', async () => {
    const board = newBoard();
    board.project = async () => { throw new GhLoginMissingError('octo-user'); };
    const plain = setup(withGithub());
    const plainCode = await plain.goWith(wire(newBoard()), '--store', 'file', 'next');
    const { out, err, goWith } = setup(withGithub());
    expect(await goWith(wire(board), '--store', 'file', 'next')).toBe(plainCode);
    expect(out).toEqual(plain.out);
    expect(err.join('\n')).toContain('github: PULL FAIL');
  });

  test('next still works when the pull itself throws', async () => {
    const plain = setup(withGithub());
    const plainCode = await plain.goWith(wire(newBoard()), '--store', 'file', 'next');
    const { out, err, store, goWith } = setup(withGithub());
    const orig = store.listFactoryDefs.bind(store);
    let n = 0;
    store.listFactoryDefs = async () => { if (n++ === 0) throw new Error('locked\nmore'); return orig(); };
    expect(await goWith(wire(newBoard()), '--store', 'file', 'next')).toBe(plainCode);
    expect(out).toEqual(plain.out);
    expect(err).toContain('github: pull failed (locked)');
  });

  test('next pulls while the lock is free and skips when held', async () => {
    const board = newBoard();
    await issue(board, 'Todo');
    const lock = memLock();
    const { goWith, err, store } = setup(withGithub());
    lock.held.add('blocks');
    await goWith(wire(board, { pullLock: lock.lock }), '--store', 'file', 'next', '--peek');
    expect(await store.listTasks()).toHaveLength(0);
    expect(err.join('\n')).not.toContain('github:');
    lock.held.clear();
    await goWith(wire(board, { pullLock: lock.lock }), '--store', 'file', 'next', '--peek');
    expect(lock.taken).toEqual(['blocks']);
    expect(lock.held.size).toBe(0);
    expect(await store.listTasks()).toHaveLength(1);
  });

  test('next on a factory without github makes no board call', async () => {
    let calls = 0;
    const board = newBoard();
    const counting = new Proxy(board, { get: (t, p) => { if (typeof (t as never)[p] === 'function') calls++; return Reflect.get(t, p).bind?.(t) ?? Reflect.get(t, p); } });
    const { err, goWith } = setup(seed());
    await goWith(wire(counting), '--store', 'file', 'next');
    expect(calls).toBe(0);
    expect(err).toEqual([]);
  });


  test('sync prints pull lines and the pulled summary before the push', async () => {
    const board = newBoard();
    await issue(board, 'Todo');
    const { out, goWith } = setup(withGithub());
    expect(await goWith(wire(board), '--store', 'file', 'sync')).toBe(0);
    expect(out[0]).toBe('T-1 created from o/app#1 (ready)');
    expect(out[1]).toBe('pulled: created 1, applied 0, not applied 0, failed 0');
    expect(out.slice(2).at(-1)).toBe('pushed 1, failed 0');
  });

  test('sync reports a busy factory and exits 1 when the pull fails', async () => {
    const board = newBoard();
    const lock = memLock();
    lock.held.add('blocks');
    const busy = setup(withGithub());
    expect(await busy.goWith(wire(board, { pullLock: lock.lock }), '--store', 'file', 'sync')).toBe(0);
    expect(busy.out).toContain('github: pull of blocks skipped (another pull is running)');
    const bad = newBoard();
    bad.project = async () => { throw new Error('boom'); };
    const failing = setup(withGithub());
    expect(await failing.goWith(wire(bad), '--store', 'file', 'sync')).toBe(1);
    expect(failing.out.join('\n')).toContain('PULL FAIL');
    expect(failing.out.join('\n')).toContain('failed 1');
  });

  test('sync pushes nothing, silently, for a factory whose pull is busy', async () => {
    const board = newBoard();
    const { out, store, goWith } = setup(withGithub());
    const t = await store.createTask({ factoryId: 'blocks', title: 'Do it', description: 'd', repo: 'app' });
    expect(await goWith(wire(board, { pullBusy: (f) => f === 'blocks' }), '--store', 'file', 'sync')).toBe(0);
    expect(out.slice(1)).toEqual(['pushed 0, failed 0']);
    expect(await store.getGitHubLink(t.taskId)).toBeUndefined();
  });

  test('by default a held pull lock file also holds back the push', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-root-'));
    mkdirSync(join(root, '.factory'));
    writeFileSync(join(root, '.factory', 'pull-blocks.lock'), 'someone-else');
    const prev = process.env.FACTORY_ROOT;
    process.env.FACTORY_ROOT = root;
    try {
      const board = newBoard();
      const { out, store, goWith } = setup(withGithub());
      const t = await store.createTask({ factoryId: 'blocks', title: 'Do it', description: 'd', repo: 'app' });
      expect(await goWith({ githubFor: () => new FakeGitHub(), githubBoardFor: () => board }, '--store', 'file', 'sync')).toBe(0);
      expect(out).toContain('github: pull of blocks skipped (another pull is running)');
      expect(out.at(-1)).toBe('pushed 0, failed 0');
      expect(await store.getGitHubLink(t.taskId)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.FACTORY_ROOT; else process.env.FACTORY_ROOT = prev;
    }
  });

  test('by default the pull lock file lives in FACTORY_STORE_LOCAL_PATH, not in <root>/.factory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-root-'));
    const custom = mkdtempSync(join(tmpdir(), 'factory-store-'));
    mkdirSync(join(root, '.factory'));
    writeFileSync(join(root, '.factory', 'pull-blocks.lock'), 'not-the-store-dir'); // ignored: the lock is in the store dir
    writeFileSync(join(custom, 'pull-blocks.lock'), 'someone-else');
    const prev = { r: process.env.FACTORY_ROOT, p: process.env.FACTORY_STORE_LOCAL_PATH };
    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_STORE_LOCAL_PATH = custom;
    try {
      const { out, goWith } = setup(withGithub());
      expect(await goWith({ githubFor: () => new FakeGitHub(), githubBoardFor: () => newBoard() }, '--store', 'file', 'sync')).toBe(0);
      expect(out).toContain('github: pull of blocks skipped (another pull is running)');
      rmSync(join(custom, 'pull-blocks.lock'));
      out.length = 0;
      await goWith({ githubFor: () => new FakeGitHub(), githubBoardFor: () => newBoard() }, '--store', 'file', 'sync');
      expect(out.join('\n')).not.toContain('another pull is running');
      expect(readdirSync(join(root, '.factory'))).toEqual(['pull-blocks.lock']);
    } finally {
      for (const [k, v] of [['FACTORY_ROOT', prev.r], ['FACTORY_STORE_LOCAL_PATH', prev.p]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('sync --watch prints a NOT APPLIED line once across ticks', async () => {
    const board = newBoard();
    const { out, store, goWith } = setup(withGithub());
    const { item, project } = await issue(board, 'Todo');
    await goWith(wire(board), '--store', 'file', 'sync');
    expect((await store.listTasks())).toHaveLength(1);
    out.length = 0;
    const move = () => board.setStatus(project, item, 'In review');
    await move();
    expect(await goWith(wire(board, { watchTicks: 2, sleep: async () => { await move(); } }), '--store', 'file', 'sync', '--watch')).toBe(0);
    const notApplied = out.filter((l) => l.startsWith('NOT APPLIED'));
    expect(notApplied).toHaveLength(1);
    expect(out.some((l) => l.startsWith('pulled:'))).toBe(false);
  });

  test('sync --rebuild restores and pushes', async () => {
    const b2 = newBoard();
    await issue(b2, 'Todo', 'One', issueBody('d1', 'T-1', 'blocks'));
    await issue(b2, 'Todo', 'Two', issueBody('d2', 'T-2', 'blocks'));
    const { out, store, goWith } = setup(withGithub());
    expect(await goWith(wire(b2), '--store', 'file', 'sync', '--rebuild')).toBe(0);
    expect(out).toContain('T-1 rebuilt from o/app#1 (ready)');
    expect(out).toContain('rebuilt 2');
    expect(await store.listTasks()).toHaveLength(2);
  });

  test('sync --rebuild on a factory with tasks exits 1', async () => {
    const board = newBoard();
    const { out, store, goWith } = setup(withGithub());
    await store.createTask({ factoryId: 'blocks', title: 'x', description: 'd', repo: 'app' });
    expect(await goWith(wire(board), '--store', 'file', 'sync', '--rebuild')).toBe(1);
    expect(out.join('\n')).toContain('FAIL rebuild blocks: the board already has tasks');
  });

  test('sync --rebuild names a requested factory that is not github-only', async () => {
    const { out, goWith } = setup(seed());
    expect(await goWith(wire(newBoard()), '--store', 'file', 'sync', '--rebuild', '--factory', 'blocks')).toBe(1);
    expect(out.join('\n')).toContain('FAIL rebuild blocks: not a GitHub-only factory');
  });

  test('sync --rebuild with no github-only factory exits 1', async () => {
    const { out, goWith } = setup(seed());
    expect(await goWith(wire(newBoard()), '--store', 'file', 'sync', '--rebuild')).toBe(1);
    expect(out).toEqual(['no factory uses GitHub-only mode']);
  });

  test('sync --rebuild --watch is refused', async () => {
    const { err, goWith } = setup(withGithub());
    expect(await goWith(wire(newBoard()), '--store', 'file', 'sync', '--rebuild', '--watch')).toBe(1);
    expect(err).toEqual(['error: --rebuild runs once; leave out --watch']);
  });
});

describe('factory init', () => {
  test('runs the wizard on the local store even when FACTORY_STORE=blocks, and exits with its code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-init-cli-'));
    const prev = { root: process.env.FACTORY_ROOT, store: process.env.FACTORY_STORE };
    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_STORE = 'blocks';
    try {
      const { wired, goWith } = setup();
      const seen: { root: string; store: unknown }[] = [];
      const exit = await goWith({ runInit: async (d) => { seen.push({ root: d.root, store: await d.openStore() }); return 7; } }, 'init');
      expect(exit).toBe(7);
      expect(seen[0]!.root).toBe(root);
      expect(seen[0]!.store).toBeInstanceOf(FileStore);
      expect(wired).toEqual([]);
    } finally {
      for (const [k, v] of [['FACTORY_ROOT', prev.root], ['FACTORY_STORE', prev.store]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
