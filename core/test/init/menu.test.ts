import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { VersionConflictError } from '../../src/boardStore.js';
import { DEFAULT_SETTINGS } from '../../src/defaults.js';
import type { DoctorCheck } from '../../src/doctor.js';
import { DEFAULT_GH_USER } from '../../src/factories.js';
import { loadFactoryFile, newFactoryFile, saveFactoryFile, type NewFactory } from '../../src/factoryFile.js';
import { FakeGitHubBoard } from '../../src/githubBoard.js';
import { FakeGitHubSetup } from '../../src/githubSetup.js';
import type { GhCli } from '../../src/init/ghCli.js';
import { runInit } from '../../src/init/menu.js';
import { scriptedPrompter, type Prompter } from '../../src/init/prompts.js';
import type { InitDeps } from '../../src/init/shared.js';
import { FileStore } from '../../src/store.js';
import type { Validated } from '../../src/validated.js';
import { defFixture, repoFixture } from '../factoryFixtures.js';

const ok = <T>(r: Validated<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const CONFLICT = 'factory.yaml changed while you were answering; nothing was saved. Run the item again.';
const PKG = JSON.stringify({ scripts: { test: 'vitest run' } });
// Menu: 1 models, 2 gates, 3 approvers, 4 status map, 5 add repo, 6 change repo, 7 remove repo, 8 add factory, 9 re-check, 10 quit.
const QUIT = '10';

class FakeGh implements GhCli {
  constructor(private list: string[] = ['me']) {}
  async logins() { return this.list; }
  async login() {}
  async refreshProjectScope() {}
}

let root: string;
let fakeSetup: FakeGitHubSetup;
let fakeBoard: FakeGitHubBoard;
let gh: FakeGh;
let store: FileStore;
let doctorCalls: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsf-menu-'));
  fakeSetup = new FakeGitHubSetup();
  fakeSetup.repos.set('o/web', { defaultBranch: 'main', branches: ['dev', 'develop'] });
  fakeSetup.files.set('o/web@main', { 'package.json': PKG, 'package-lock.json': '{}' });
  fakeSetup.repos.set('o/api', { defaultBranch: 'dev', branches: [] });
  fakeSetup.files.set('o/api@dev', { 'package.json': PKG, 'package-lock.json': '{}' });
  fakeBoard = new FakeGitHubBoard();
  gh = new FakeGh();
  store = new FileStore(join(root, '.factory', 'board.json'), { factoriesDir: join(root, 'factories') });
  doctorCalls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(answers: string[], wrap?: (p: Prompter) => Prompter): InitDeps & { transcript: string[] } {
  const scripted = scriptedPrompter(answers);
  const d: InitDeps = {
    root, prompt: wrap ? wrap(scripted) : scripted, gh, boardFor: () => fakeBoard, setupFor: () => fakeSetup,
    openStore: async () => store,
    doctor: async (factoryId): Promise<DoctorCheck[]> => {
      doctorCalls.push(factoryId);
      return [{ factoryId, check: 'gh login', ok: true, detail: 'me logged in' }];
    },
    platform: 'linux', now: () => new Date('2026-11-16T00:00:00Z'),
  };
  return Object.assign(d, { transcript: scripted.transcript });
}

const WEB = { id: 'web', remote: 'git@github.com:o/web.git', baseBranch: 'dev', checks: [{ name: 'test', cwd: '.', run: 'npm test' }] };
const API = { id: 'api', remote: 'git@github.com:o/api.git', baseBranch: 'dev', checks: [] };

function seedFactory(id = 'app', over: Partial<NewFactory> = {}) {
  return saveFactoryFile(ok(newFactoryFile(join(root, 'factories', id), {
    id, name: 'App', accounts: { github: 'me' },
    board: { source: 'github', project: 'me/4', label: 'factory', approvers: ['me'], statusMap: null },
    gates: { ...DEFAULT_SETTINGS.gates }, models: {}, protectedBranches: ['dev', 'stg', 'main'], repos: [WEB], ...over,
  })));
}

const fileText = (id = 'app') => readFileSync(join(root, 'factories', id, 'factory.yaml'), 'utf8');
const loaded = (id = 'app') => ok(loadFactoryFile(join(root, 'factories', id)));

const LEGACY = `# Old factory.
factoryId: leg
name: Legacy
protectedBranches: [dev, stg, main]
`;
const LEGACY_REPO = `repoId: web
remote: git@github.com:o/web.git
baseBranch: dev
checks:
  - { name: test, cwd: ., run: npm test }
`;

function seedLegacy(): void {
  const dir = join(root, 'factories', 'leg');
  mkdirSync(join(dir, 'repos'), { recursive: true });
  writeFileSync(join(dir, 'factory.yaml'), LEGACY);
  writeFileSync(join(dir, 'repos', 'web.yaml'), LEGACY_REPO);
}

describe('runInit', () => {
  test('with no factory it runs the first run', async () => {
    const d = deps([]);
    expect(await runInit(d)).toBe(130);
    expect(d.transcript.at(-1)).toBe('setup cancelled; nothing was written');
  });

  test('change models saves only factory.agents and re-runs doctor', async () => {
    seedFactory();
    const before = loaded().doc.toJS() as { factory: Record<string, unknown> };
    // per stage: spec opus, plan session, build sonnet, verify session, review session
    const d = deps(['1', '2', '2', '1', '3', '1', '1', QUIT]);
    expect(await runInit(d)).toBe(0);
    const after = loaded().doc.toJS() as { factory: Record<string, unknown> };
    expect(after.factory.agents).toEqual({ spec: 'opus', build: 'sonnet' });
    delete after.factory.agents;
    expect(after).toEqual(before);
    expect(d.transcript).toContain('Models now: session model for every stage');
    expect(doctorCalls).toEqual(['app']);
  });

  test('change gates, approvers and status map each apply their change', async () => {
    seedFactory();
    fakeBoard.addProject({ owner: 'me', number: 4 }, ['A', 'B', 'C']);
    fakeSetup.statusOptions.set('me/4', ['A', 'B', 'C']);
    // 13 statuses over A, B, C and "New column…".
    const map = ['1', '2', '3', '3', '3', '3', '3', '3', '3', '4', 'Shipped', '4', '3', '1'];
    const d = deps(['2', 'n', 'y', 'n', '3', 'me, alice', '4', ...map, QUIT]);
    expect(await runInit(d)).toBe(0);
    const f = loaded();
    expect(f.config.gates).toEqual({ spec: false, plan: true, pr: false });
    expect(f.config.board.approvers).toEqual(['me', 'alice']);
    expect(f.config.board.statusMap).toMatchObject({ inbox: 'A', ready: 'B', pr_open: 'Shipped', cancelled: 'A' });
    expect(fakeSetup.statusOptions.get('me/4')).toContain('Shipped');
    expect(d.transcript).toContain('Gates now: spec waits, plan does not wait, pr waits');
    expect(d.transcript).toContain('Approvers now: me');
    expect(doctorCalls).toHaveLength(3);
  });

  test('add a repo appends to repos.list with detected checks', async () => {
    seedFactory();
    const d = deps(['5', 'o/api', '', '1', QUIT]);
    expect(await runInit(d)).toBe(0);
    const f = loaded();
    expect(f.config.repos.map((r) => r.repoId)).toEqual(['web', 'api']);
    expect(f.config.repos[1]).toMatchObject({ baseBranch: 'dev', checks: [{ name: 'install', run: 'npm ci' }, expect.anything()] });
    expect(fakeBoard.labels.get('o/api')?.has('factory')).toBe(true);
    expect(d.transcript).toContain('Repos now: web');
    expect(doctorCalls).toEqual(['app']);
  });

  test('change a repo updates its base and checks', async () => {
    seedFactory();
    const d = deps([
      '6', '1', '1', 'main', 'develop', // web, base branch: main refused, then develop
      '6', '1', '3', '2', 'lint', '', 'npm run lint', '', '1', // web, checks: add lint, keep
      QUIT,
    ]);
    expect(await runInit(d)).toBe(0);
    const r = loaded().config.repos[0]!;
    expect(r.baseBranch).toBe('develop');
    expect(r.checks).toEqual([{ name: 'test', cwd: '.', run: 'npm test' }, { name: 'lint', cwd: '.', run: 'npm run lint' }]);
    expect(d.transcript).toContain('main is never a base branch');
    expect(d.transcript).toContain('  base branch: dev');
    expect(doctorCalls).toHaveLength(2);
  });

  test('remove a repo with open tasks lists them; cancel then remove cancels and removes', async () => {
    seedFactory('app', { repos: [WEB, API] });
    await store.createTask({ factoryId: 'app', title: 'Fix login', description: 'd', repo: 'web', status: 'ready' });
    await store.createTask({ factoryId: 'app', title: 'Api work', description: 'd', repo: 'api' });
    const d = deps(['7', '1', '1', QUIT]);
    expect(await runInit(d)).toBe(0);
    expect(d.transcript).toContain('  T-1 ready Fix login');
    expect(d.transcript).toContain('  1. Cancel these tasks, then remove the repo');
    expect(d.transcript).toContain('  2. Keep the repo');
    expect((await store.getTask('T-1')).status).toBe('cancelled');
    expect((await store.getTask('T-2')).status).toBe('inbox');
    expect(loaded().config.repos.map((r) => r.repoId)).toEqual(['api']);
  });

  test('remove a repo with open tasks; keep leaves file and tasks unchanged', async () => {
    seedFactory();
    await store.createTask({ factoryId: 'app', title: 'Fix login', description: 'd', repo: 'web', status: 'ready' });
    const text = fileText();
    const d = deps(['7', '1', '2', QUIT]);
    expect(await runInit(d)).toBe(0);
    expect(fileText()).toBe(text);
    expect((await store.getTask('T-1')).status).toBe('ready');
    expect(doctorCalls).toEqual([]);
  });

  test('a legacy file is converted after asking; declining changes nothing', async () => {
    seedFactory();
    seedLegacy();
    // factories: 1 app, 2 leg, 3 Quit. Declining goes back to the choice.
    const d1 = deps(['2', 'n', '3']);
    expect(await runInit(d1)).toBe(0);
    expect(d1.transcript.some((l) => l.startsWith('This file is in the old format. Convert it (and move repos/*.yaml into it)?'))).toBe(true);
    expect(fileText('leg')).toBe(LEGACY);
    expect(existsSync(join(root, 'factories', 'leg', 'repos', 'web.yaml'))).toBe(true);

    // yes; no ghUser: the login (only one, me) is confirmed; then the full menu.
    const d2 = deps(['2', 'y', '', QUIT]);
    expect(await runInit(d2)).toBe(0);
    const f = loaded('leg');
    expect(f.shape).toBe('new');
    expect(f.config.accounts).toEqual({ github: 'me' });
    expect(f.config.repos.map((r) => r.repoId)).toEqual(['web']);
    expect(existsSync(join(root, 'factories', 'leg', 'repos', 'web.yaml'))).toBe(false);
    expect(d2.transcript).toContain('  1. Change models');
  });

  test('a board.json-only factory can only be exported, then gets the full menu', async () => {
    await store.saveFactoryDef(null, defFixture('old', { ghUser: DEFAULT_GH_USER }));
    await store.saveFactoryRepo(null, repoFixture('old', 'web'));
    await store.setSettings({ factories: { old: { factory: { ...DEFAULT_SETTINGS, gates: { spec: false, plan: true, pr: true } }, repos: {} } } });
    const d = deps(['1', 'n', 'other-me', QUIT]);
    expect(await runInit(d)).toBe(0);
    const menu = d.transcript.slice(0, d.transcript.indexOf('  3. Quit') + 1);
    expect(menu).toEqual(expect.arrayContaining(['  1. Export to YAML', '  2. Re-check', '  3. Quit']));
    expect(menu).not.toContain('  1. Change models');
    const f = loaded('old');
    expect(f.config.accounts).toEqual({ github: 'other-me' });
    expect(f.config.gates).toEqual({ spec: false, plan: true, pr: true });
    expect(f.config.repos.map((r) => r.repoId)).toEqual(['web']);
    expect(d.transcript).toContain('  1. Change models');
  });

  test('the factory choice lists folders and board.json-only definitions', async () => {
    seedFactory();
    await store.saveFactoryDef(null, defFixture('old'));
    const d = deps(['3']);
    expect(await runInit(d)).toBe(0);
    expect(d.transcript).toEqual(expect.arrayContaining(['  1. app', '  2. old (board.json)', '  3. Quit']));
  });

  test('a hand edit during an item makes the save report the conflict and keep the edit', async () => {
    seedFactory();
    const path = join(root, 'factories', 'app', 'factory.yaml');
    const wrap = (p: Prompter): Prompter => ({
      ...p,
      async ask(q, o) {
        const a = await p.ask(q, o);
        if (q.startsWith('Approvers')) writeFileSync(path, `# hand edit\n${readFileSync(path, 'utf8')}`);
        return a;
      },
    });
    const d = deps(['3', 'alice', QUIT], wrap);
    expect(await runInit(d)).toBe(0);
    expect(d.transcript).toContain(CONFLICT);
    expect(fileText().startsWith('# hand edit\n')).toBe(true);
    expect(loaded().config.board.approvers).toEqual(['me']);
    expect(doctorCalls).toEqual([]);
  });

  test('a hand edit before the tasks are cancelled cancels nothing', async () => {
    seedFactory();
    await store.createTask({ factoryId: 'app', title: 'Fix login', description: 'd', repo: 'web', status: 'ready' });
    const path = join(root, 'factories', 'app', 'factory.yaml');
    const wrap = (p: Prompter): Prompter => ({
      ...p,
      async choose(q, options, o) {
        const a = await p.choose(q, options, o);
        if (q === 'What now?') writeFileSync(path, `# hand edit\n${readFileSync(path, 'utf8')}`);
        return a;
      },
    });
    const d = deps(['7', '1', '1', QUIT], wrap);
    expect(await runInit(d)).toBe(0);
    expect(d.transcript).toContain(CONFLICT);
    expect((await store.getTask('T-1')).status).toBe('ready');
    expect(loaded().config.repos.map((r) => r.repoId)).toEqual(['web']);
  });

  test('a task that changes while it is being cancelled names the task and the tasks already cancelled', async () => {
    seedFactory();
    await store.createTask({ factoryId: 'app', title: 'Fix login', description: 'd', repo: 'web', status: 'ready' });
    await store.createTask({ factoryId: 'app', title: 'More login', description: 'd', repo: 'web', status: 'ready' });
    const text = fileText();
    const real = store.updateTask.bind(store);
    store.updateTask = async (id, version, patch) => {
      if (id === 'T-2') throw new VersionConflictError('T-2', version, version + 1);
      return real(id, version, patch);
    };
    const d = deps(['7', '1', '1', QUIT]);
    expect(await runInit(d)).toBe(0);
    expect(d.transcript).not.toContain(CONFLICT);
    expect(d.transcript).toContain('T-2 changed while it was being cancelled; web was not removed. Already cancelled: T-1. Run the item again.');
    expect((await store.getTask('T-1')).status).toBe('cancelled');
    expect((await store.getTask('T-2')).status).toBe('ready');
    expect(fileText()).toBe(text);
  });

  test('add another factory runs the first-run questions and leaves the first factory alone', async () => {
    seedFactory();
    gh = new FakeGh(['me', 'other']);
    const text = fileText();
    // name, id, project 1 = Create a new Project, title, approvers, gates x3, models, repo lines, Default setup.
    const d = deps(['8', 'My App', '', '1', '', '', '', '', '', '1', 'o/web', '', '1']);
    expect(await runInit(d)).toBe(0);
    expect(d.transcript.some((l) => l.startsWith('Which GitHub login'))).toBe(false);
    expect(loaded('my-app').config.accounts).toEqual({ github: 'me' });
    expect(fileText()).toBe(text);
    expect(d.transcript.at(-1)).toBe('Ready. Open Claude Code and run /factory:run.');
  });

  test('closing the input in the menu exits 130', async () => {
    seedFactory();
    expect(await runInit(deps(['1']))).toBe(130);
  });
});
