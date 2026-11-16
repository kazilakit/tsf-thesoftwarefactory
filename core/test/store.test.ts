import { describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { FileStore, ForbiddenError, MemoryStore, RereadAfterUpdateError, updateHeld, VersionConflictError, type StoredSettings } from '../src/store.js';
import { parse } from 'yaml';
import { DEFAULT_STATUS_MAP } from '../src/githubConfig.js';
import { runStoreContract } from './storeContract.js';
import { yamlVersion } from '../src/factoriesFs.js';
import { emptyPushed, type GitHubLink } from '../src/githubLink.js';

const mk = (s: MemoryStore, title = 'a') => s.createTask({ factoryId: 'blocks', title, description: '', repo: 'data' });

runStoreContract('MemoryStore', (identity) => new MemoryStore({ identity }));
runStoreContract('FileStore', (identity) => new FileStore(join(mkdtempSync(join(tmpdir(), 'fs-contract-')), 'board.json'), { identity }));

describe('updateHeld', () => {
  test('a write that landed but could not be read back is the held task plus the patch', async () => {
    const s = new MemoryStore();
    const t = await mk(s);
    s.updateTask = async () => { throw new RereadAfterUpdateError(t.taskId); };
    expect(await updateHeld(s, t, { status: 'ready', claimBy: 'w' })).toEqual({ ...t, status: 'ready', claimBy: 'w', version: 2 });
  });
  test('other errors pass through', async () => {
    const s = new MemoryStore();
    const t = await mk(s);
    await s.updateTask(t.taskId, 1, { status: 'ready' });
    await expect(updateHeld(s, t, { status: 'spec' })).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('MemoryStore', () => {
  test('run ids are R-<n>', async () => {
    const s = new MemoryStore();
    const r = await s.startRun({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer' });
    expect(r.runId).toBe('R-1');
  });
  test('the same doc body twice makes a new version', async () => {
    const s = new MemoryStore();
    await s.addDoc('T-1', 'spec', 'one', 'me');
    expect((await s.addDoc('T-1', 'spec', 'one', 'me')).version).toBe(2);
  });
});

describe('FileStore', () => {
  test('reloads what an earlier instance wrote', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fs-')), 'sub', 'board.json');
    const a = new FileStore(path);
    await mk(a);
    await a.addDoc('T-1', 'spec', 'body', 'me');
    await a.startRun({ taskId: 'T-1', step: 'spec', mode: 'sdk', agent: 'x' });
    const b = new FileStore(path);
    expect((await b.listTasks()).map((t) => t.taskId)).toEqual(['T-1']);
    expect((await b.currentDoc('T-1', 'spec'))?.body).toBe('body');
    expect((await b.createTask({ factoryId: 'blocks', title: 'n', description: '', repo: 'os' })).taskId).toBe('T-2');
    expect((await b.startRun({ taskId: 'T-1', step: 'spec', mode: 'sdk', agent: 'x' })).runId).toBe('R-2');
  });

  const boardPath = () => join(mkdtempSync(join(tmpdir(), 'fs-')), 'board.json');

  test('two instances on one path: a write via A is visible to B, and B keeps it when it writes later', async () => {
    const path = boardPath();
    const a = new FileStore(path);
    const t = await mk(a);
    const b = new FileStore(path); // a second CLI process
    const bt = await b.getTask('T-1');
    await b.updateTask('T-1', bt.version, { status: 'cancelled' });
    await b.addEvents([{ taskId: 'T-1', factoryId: 'blocks', actor: 'you', action: 'move', field: 'status', from: 'inbox', to: 'cancelled', reason: 'c', at: 'now' }]);
    expect((await a.getTask('T-1')).status).toBe('cancelled');
    // A long-running process that read version 1 earlier must not overwrite the cancel.
    await expect(a.updateTask('T-1', t.version, { title: 'y' })).rejects.toBeInstanceOf(VersionConflictError);
    await a.addDoc('T-1', 'spec', 'body', 'me');
    const c = new FileStore(path);
    expect(await c.getTask('T-1')).toMatchObject({ status: 'cancelled', title: 'a' });
    expect(await c.listEvents()).toHaveLength(1);
    expect((await c.currentDoc('T-1', 'spec'))?.body).toBe('body');
  });

  test('interleaved writes from two instances all survive and leave no temp files', async () => {
    const path = boardPath();
    const a = new FileStore(path);
    const b = new FileStore(path);
    await Promise.all([mk(a, 'a1'), mk(b, 'b1'), mk(a, 'a2'), mk(b, 'b2')]);
    const ids = (await new FileStore(path).listTasks()).map((t) => t.taskId).sort();
    expect(ids).toEqual(['T-1', 'T-2', 'T-3', 'T-4']);
    expect(readdirSync(join(path, '..'))).toEqual(['board.json']);
  });

  test('a held lock makes a write fail with a clear error after the timeout', async () => {
    const path = boardPath();
    const a = new FileStore(path, { lockTimeoutMs: 100 });
    await mk(a);
    writeFileSync(`${path}.lock`, '');
    await expect(mk(a)).rejects.toThrow(/board store is locked/);
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(await a.listTasks()).toHaveLength(1);
  });

  test('a stale lock older than 30 s is removed', async () => {
    const path = boardPath();
    const a = new FileStore(path, { lockTimeoutMs: 100 });
    writeFileSync(`${path}.lock`, '');
    const old = new Date(Date.now() - 31_000);
    utimesSync(`${path}.lock`, old, old);
    await mk(a);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(await new FileStore(path).listTasks()).toHaveLength(1);
  });
});

describe('FileStore factories', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'fs-fac-'));

  const repoText = (base = 'dev') => `repoId: api\nremote: git@github.com:o/api.git\nbaseBranch: ${base}\nchecks:\n  server: { cwd: s, build: b, test: t }\n  client: { cwd: c, install: i, typecheck: tc, lint: l, test: t }\n  e2e: off\n`;
  /** A root with `factories/<id>/factory.yaml` and a board.json holding `stored`. */
  const rootWith = (yaml: Record<string, string>, stored: { defs?: unknown[]; repos?: unknown[]; settings?: unknown } = {}) => {
    const root = dir();
    for (const [rel, text] of Object.entries(yaml)) {
      mkdirSync(join(root, 'factories', rel, '..'), { recursive: true });
      writeFileSync(join(root, 'factories', rel), text);
    }
    const board = join(root, '.factory', 'board.json');
    mkdirSync(join(root, '.factory'), { recursive: true });
    writeFileSync(board, JSON.stringify({ factoryDefs: stored.defs ?? [], factoryRepos: stored.repos ?? [], settings: stored.settings ?? null }));
    return { root, board, opts: { factoriesDir: join(root, 'factories') } };
  };
  const storedDef = (factoryId: string, name: string) => ({ factoryId, name, gitName: '', gitEmail: '', docsPath: '', ghUser: 'octo-user', active: true, version: 3 });

  test('a YAML-backed definition wins over the board.json copy on every load', async () => {
    const { board, opts, root } = rootWith({ 'delta/factory.yaml': 'factoryId: delta\nname: New\n', 'delta/repos/api.yaml': repoText() }, { defs: [storedDef('delta', 'Old')] });
    const s = new FileStore(board, opts);
    expect((await s.listFactoryDefs()).map((d) => d.name)).toEqual(['New']);
    expect((await s.listFactoryRepos('delta')).map((r) => r.repoId)).toEqual(['api']);
    writeFileSync(join(root, 'factories', 'delta', 'factory.yaml'), 'factoryId: delta\nname: Newer\n');
    expect((await new FileStore(board, opts).listFactoryDefs()).map((d) => d.name)).toEqual(['Newer']);
  });

  test('a definition in board.json with no YAML keeps loading from board.json', async () => {
    const { board, opts } = rootWith({ 'delta/factory.yaml': 'factoryId: delta\nname: Delta\n' }, { defs: [storedDef('blocks', 'Blocks')] });
    const s = new FileStore(board, opts);
    expect((await s.listFactoryDefs()).map((d) => `${d.factoryId}:${d.name}:${d.version}`).sort()).toEqual(['blocks:Blocks:3', `delta:Delta:${yamlVersion('factoryId: delta\nname: Delta\n')}`]);
  });

  test('an invalid factory.yaml hides the board.json copy and is reported with the file and field path', async () => {
    const { board, opts } = rootWith({ 'delta/factory.yaml': 'factory:\n  id: delta\n  name: Delta\n  agents:\n    build: gpt\n' }, { defs: [storedDef('delta', 'Delta')] });
    const lines: string[] = [];
    const s = new FileStore(board, { ...opts, log: (l) => lines.push(l) });
    expect((await s.listFactoryDefs()).map((d) => d.factoryId)).toEqual([]);
    expect(s.factoryFileProblems()).toEqual([{ factoryId: 'delta', file: expect.stringMatching(/delta[\\/]factory\.yaml$/), reason: expect.stringContaining('factory.agents.build:') }]);
    expect(lines).toHaveLength(1);
  });

  test('editing a repos/*.yaml file is picked up without touching factory.yaml', async () => {
    const { board, opts, root } = rootWith({ 'delta/factory.yaml': 'factoryId: delta\nname: Delta\n', 'delta/repos/api.yaml': repoText() });
    const s = new FileStore(board, opts);
    expect((await s.listFactoryRepos('delta'))[0]!.baseBranch).toBe('dev');
    const file = join(root, 'factories', 'delta', 'repos', 'api.yaml');
    writeFileSync(file, repoText('stg'));
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await s.listFactoryRepos('delta'))[0]!.baseBranch).toBe('stg');
  });

  test('YAML gates win over board.json per gate; other settings stay from board.json', async () => {
    const yaml = 'factory:\n  id: delta\n  name: Delta\ngates: { plan: true }\n';
    const settings = { factories: { delta: { factory: { ...DEFAULT_SETTINGS, gates: { spec: false, plan: false, pr: true }, maxParallel: 4 }, repos: {} } } };
    const { board, opts } = rootWith({ 'delta/factory.yaml': yaml, 'echo/factory.yaml': yaml.replace(/delta/g, 'echo').replace('true', 'false') }, { settings });
    const s = new FileStore(board, opts);
    const got = await s.getSettings();
    expect(got.factories.delta!.factory).toMatchObject({ gates: { spec: false, plan: true, pr: true }, maxParallel: 4 });
    expect(got.factories.echo!.factory).toEqual({ ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, plan: false } });
    // A save based on what getSettings returned is not a conflict.
    await s.updateSettingsScope('delta', got.factories.delta!.factory, { ...got.factories.delta!.factory, maxParallel: 5 });
    expect((await s.getSettings()).factories.delta!.factory).toMatchObject({ gates: { plan: true }, maxParallel: 5 });
  });

  test('persisting a task write drops board.json copies of YAML-backed definitions', async () => {
    const storedRepo = { factoryId: 'delta', repoId: 'old', remote: 'git@github.com:o/old.git', baseBranch: 'dev', checks: {}, version: 1 };
    const { board, opts } = rootWith({ 'delta/factory.yaml': 'factoryId: delta\nname: Delta\n', 'delta/repos/api.yaml': repoText() },
      { defs: [storedDef('delta', 'Old'), storedDef('blocks', 'Blocks')], repos: [storedRepo] });
    const s = new FileStore(board, opts);
    await s.createTask({ factoryId: 'delta', title: 't', description: '', repo: 'api' });
    const raw = JSON.parse(readFileSync(board, 'utf8')) as { factoryDefs: { factoryId: string }[]; factoryRepos: unknown[]; tasks: unknown[] };
    expect(raw.factoryDefs.map((d) => d.factoryId)).toEqual(['blocks']);
    expect(raw.factoryRepos).toEqual([]);
    expect(raw.tasks).toHaveLength(1);
  });

  test('an invalid definition is skipped with a logged reason; the valid one loads', async () => {
    const root = dir();
    for (const id of ['alpha', 'broken']) mkdirSync(join(root, 'factories', id), { recursive: true });
    writeFileSync(join(root, 'factories', 'alpha', 'factory.yaml'), 'factoryId: alpha\nname: Alpha\n');
    writeFileSync(join(root, 'factories', 'broken', 'factory.yaml'), 'factoryId: Not Valid\n');
    const lines: string[] = [];
    const s = new FileStore(join(root, 'board.json'), { factoriesDir: join(root, 'factories'), log: (l) => lines.push(l) });
    expect((await s.listFactoryDefs()).map((d) => d.factoryId)).toEqual(['alpha']);
    await s.listFactoryDefs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('broken');
  });

  test('the github block comes from factory.yaml on every load; a board.json-only def loses a hand-edited one', async () => {
    const root = dir();
    mkdirSync(join(root, 'factories', 'delta'), { recursive: true });
    const yaml = join(root, 'factories', 'delta', 'factory.yaml');
    const plain = 'factoryId: delta\nname: Delta\n';
    const github = 'github:\n  mode: github-only\n  project: octo-user/3\n  statusMap:\n    inbox: Backlog\n    ready: Todo\n'
      + '    spec: In progress\n    spec_review: In progress\n    plan: In progress\n    plan_review: In progress\n    build: In progress\n'
      + '    verify: In progress\n    review: In progress\n    pr_open: In review\n    done: Done\n    blocked: In progress\n    cancelled: Done\n';
    writeFileSync(yaml, plain);
    const board = join(root, 'board.json');
    const opts = { factoriesDir: join(root, 'factories') };
    expect((await new FileStore(board, opts).listFactoryDefs())[0]).not.toHaveProperty('github');

    writeFileSync(yaml, plain + github);
    const [withHub] = await new FileStore(board, opts).listFactoryDefs();
    expect(withHub).toMatchObject({ github: { mode: 'github-only', project: { owner: 'octo-user', number: 3 }, label: 'factory' } });

    writeFileSync(yaml, plain);
    expect((await new FileStore(board, opts).listFactoryDefs())[0]).not.toHaveProperty('github');

    // A github hand-edited into a board.json definition that has no YAML is dropped.
    writeFileSync(board, JSON.stringify({ factoryDefs: [{ ...storedDef('legacy', 'Legacy'), github: withHub!.github }] }));
    const legacy = (await new FileStore(board, opts).listFactoryDefs()).find((d) => d.factoryId === 'legacy');
    expect(legacy).toBeDefined();
    expect(legacy).not.toHaveProperty('github');
  });

  test('without factoriesDir nothing is seeded', async () => {
    const root = dir();
    mkdirSync(join(root, 'factories', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'factories', 'alpha', 'factory.yaml'), 'factoryId: alpha\n');
    expect(await new FileStore(join(root, 'board.json')).listFactoryDefs()).toEqual([]);
  });

  test('an old file without factories loads as factory blocks', async () => {
    const root = dir();
    const task = { taskId: 'T-1', title: 't', description: '', repo: 'data', baseBranch: 'dev', status: 'inbox', stage: null, branch: null, prUrl: null,
      attempt: 0, blockedReason: null, question: null, answer: null, gateOverrides: {}, claimBy: null, claimUntil: null, costUsd: 0, version: 1 };
    const event = { taskId: 'T-1', actor: 'you', action: 'create', field: null, from: null, to: 'inbox', reason: '', at: 't' };
    const legacy = { tasks: [task], docs: [], approvals: [], runs: [], events: [event],
      settings: { global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } };
    writeFileSync(join(root, 'board.json'), JSON.stringify(legacy));
    const s = new FileStore(join(root, 'board.json'));
    expect((await s.listTasks())[0]).toMatchObject({ taskId: 'T-1', factoryId: 'blocks', dependsOn: [] });
    expect((await s.listEvents('T-1'))[0]).toMatchObject({ factoryId: 'blocks' });
    expect(await s.getSettings()).toEqual({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } } });
    await s.updateSettingsScope('blocks/data', { maxParallel: 1 }, { maxParallel: 2 });
    expect((await new FileStore(join(root, 'board.json')).getSettings()).factories.blocks!.repos.data).toEqual({ maxParallel: 2 });
  });
});

const link = (taskId: string, factoryId: string): GitHubLink => ({
  taskId, factoryId, repo: 'o/r', issueNumber: null, issueNodeId: null, project: null, itemId: null,
  pushed: emptyPushed(), error: null, lease: null, reported: [], version: 0,
});

describe.each([
  ['MemoryStore', (identity?: 'core' | 'owner') => new MemoryStore({ identity })],
  ['FileStore', (identity?: 'core' | 'owner') => new FileStore(join(mkdtempSync(join(tmpdir(), 'fs-link-')), 'board.json'), { identity })],
])('%s GitHub links', (_name, make) => {
  test('saveGitHubLink inserts at version 1 and lists by factory', async () => {
    const s = make();
    const a = await s.saveGitHubLink(null, link('T-1', 'a'));
    await s.saveGitHubLink(null, link('T-2', 'b'));
    expect(a.version).toBe(1);
    expect(await s.listGitHubLinks('a')).toEqual([a]);
    expect(await s.listGitHubLinks()).toHaveLength(2);
    expect(await s.getGitHubLink('T-1')).toEqual(a);
    expect(await s.getGitHubLink('T-9')).toBeUndefined();
  });
  test('saveGitHubLink is compare-and-set', async () => {
    const s = make();
    const a = await s.saveGitHubLink(null, link('T-1', 'a'));
    const b = await s.saveGitHubLink(a, { ...a, issueNumber: 5 });
    expect(b.version).toBe(2);
    await expect(s.saveGitHubLink(a, { ...a, issueNumber: 6 })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(s.saveGitHubLink(null, link('T-1', 'a'))).rejects.toBeInstanceOf(VersionConflictError);
  });
  test('a stage 2 link loads with defaults', async () => {
    const s = make();
    const old = link('T-1', 'a');
    const { docAt: _d, blockedAt: _b, ...pushed } = old.pushed;
    const { reported: _r, ...rest } = old;
    await s.saveGitHubLink(null, { ...rest, pushed } as unknown as GitHubLink);
    const got = (await s.getGitHubLink('T-1'))!;
    expect(got.pushed.docAt).toEqual({ spec: null, plan: null });
    expect(got.pushed.blockedAt).toBeNull();
    expect(got.reported).toEqual([]);
    expect((await s.listGitHubLinks())[0]!.reported).toEqual([]);
  });
  test('owner identity may not save links', async () => {
    await expect(make('owner').saveGitHubLink(null, link('T-1', 'a'))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('FileStore GitHub links and factory.yaml', () => {
  test('a file without githubLinks loads', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fs-link-')), 'board.json');
    writeFileSync(path, '{"tasks":[]}');
    expect(await new FileStore(path).listGitHubLinks()).toEqual([]);
  });
  test('re-reads factory.yaml when it changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-yaml-'));
    mkdirSync(join(root, 'factories', 'a'), { recursive: true });
    const yaml = join(root, 'factories', 'a', 'factory.yaml');
    const text = (ready: string) => 'factoryId: a\nname: A\ngithub:\n  mode: github-only\n  project: octo-user/3\n  statusMap:\n    inbox: Backlog\n'
      + `    ready: ${ready}\n    spec: In progress\n    spec_review: In progress\n    plan: In progress\n    plan_review: In progress\n    build: In progress\n`
      + '    verify: In progress\n    review: In progress\n    pr_open: In review\n    done: Done\n    blocked: In progress\n    cancelled: Done\n';
    writeFileSync(yaml, text('Todo'));
    const s = new FileStore(join(root, 'board.json'), { factoriesDir: join(root, 'factories') });
    expect((await s.listFactoryDefs())[0]!.github!.statusMap.ready).toBe('Todo');
    writeFileSync(yaml, text('Ready'));
    const later = new Date(Date.now() + 2000);
    utimesSync(yaml, later, later);
    expect((await s.listFactoryDefs())[0]!.github!.statusMap.ready).toBe('Ready');
  });
});

describe.each([
  ['MemoryStore', (identity?: 'core' | 'owner') => new MemoryStore({ identity })],
  ['FileStore', (identity?: 'core' | 'owner') => new FileStore(join(mkdtempSync(join(tmpdir(), 'fs-restore-')), 'board.json'), { identity })],
])('%s restoreTask', (_n, make) => {
  const task = (taskId: string) => ({
    taskId, factoryId: 'blocks', title: 't', description: 'd', repo: 'data', baseBranch: 'dev', status: 'blocked' as const, stage: null, branch: null,
    prUrl: null, attempt: 0, blockedReason: 'r', question: null, answer: null, gateOverrides: {}, dependsOn: [], claimBy: null, claimUntil: null, costUsd: 0, version: 7,
  });

  test('restoreTask keeps the id; a second restore conflicts; createTask continues after the highest id', async () => {
    const s = make('core');
    expect(await s.restoreTask(task('T-5'))).toMatchObject({ taskId: 'T-5', version: 1, status: 'blocked' });
    expect(await s.getTask('T-5')).toMatchObject({ version: 1 });
    await expect(s.restoreTask(task('T-5'))).rejects.toBeInstanceOf(VersionConflictError);
    expect((await s.createTask({ factoryId: 'blocks', title: 'n', description: '', repo: 'data' })).taskId).toBe('T-6');
  });

  test('restoreTask is core only', async () => {
    await expect(make('owner').restoreTask(task('T-1'))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('FileStore writes YAML-backed definitions through factory.yaml', () => {
  const NEW = [
    '# Delta factory',
    'factory:',
    '  id: delta',
    '  name: Delta # the display name',
    '  source: local',
    'accounts:',
    '  github: octo-user',
    'board:',
    '  source: none',
    'repos:',
    '  protectedBranches: [dev, stg, main]',
    '  list:',
    '    - id: api',
    '      remote: git@github.com:o/api.git',
    '      baseBranch: dev',
    '      protectedBranches: [dev, main]',
    '      checks:',
    '        - { name: test, cwd: ., run: npm test }',
    '',
  ].join('\n');
  const LEGACY = 'factoryId: delta\nname: Delta\n';
  const HINT = /factories[\\/]delta[\\/]factory\.yaml is in the old format; run \.\/factory init to convert it/;
  const setup = (yaml: string, stored: { defs?: unknown[]; settings?: unknown } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'fs-yw-'));
    mkdirSync(join(root, 'factories', 'delta'), { recursive: true });
    const file = join(root, 'factories', 'delta', 'factory.yaml');
    writeFileSync(file, yaml);
    const board = join(root, '.factory', 'board.json');
    mkdirSync(join(root, '.factory'), { recursive: true });
    writeFileSync(board, JSON.stringify({ factoryDefs: stored.defs ?? [], settings: stored.settings ?? null }));
    return { file, board, store: new FileStore(board, { factoriesDir: join(root, 'factories') }) };
  };
  const rawBoard = (board: string) => JSON.parse(readFileSync(board, 'utf8')) as { factoryDefs: { factoryId: string }[]; factoryRepos: unknown[]; settings: StoredSettings };

  test('saveFactoryDef on a YAML-backed factory writes the YAML and returns the new hash version', async () => {
    const { file, board, store } = setup(NEW);
    const [def] = await store.listFactoryDefs();
    const saved = await store.saveFactoryDef(def!, { ...def!, name: 'Delta Two', gitName: 'Bot', gitEmail: 'bot@x.io', agentModels: { build: 'sonnet' } });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# Delta factory');
    expect(text).toContain('name: Delta Two # the display name');
    expect(text).toMatch(/git:\n {4}name: Bot\n {4}email: bot@x.io/);
    expect(saved).toMatchObject({ name: 'Delta Two', gitName: 'Bot', agentModels: { build: 'sonnet' }, version: yamlVersion(text) });
    expect(await store.listFactoryDefs()).toEqual([saved]);
    expect(rawBoard(board).factoryDefs).toEqual([]);
  });

  test('saveFactoryDef writes accounts, protected branches and the GitHub board', async () => {
    const { file, store } = setup(NEW);
    const [def] = await store.listFactoryDefs();
    const github = { mode: 'github-only' as const, project: { owner: 'o', number: 7 }, label: 'factory', approvers: ['ana'], statusMap: { ...DEFAULT_STATUS_MAP } };
    const saved = await store.saveFactoryDef(def!, { ...def!, ghUser: 'ana', protectedBranches: ['dev', 'main'], github });
    const y = parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(y.accounts).toEqual({ github: 'ana' });
    expect(y.repos!.protectedBranches).toEqual(['dev', 'main']);
    expect(y.board).toEqual({ source: 'github', project: 'o/7', label: 'factory', approvers: ['ana'] });
    expect(saved).toMatchObject({ ghUser: 'ana', github });
    const back = await store.saveFactoryDef(saved, { ...saved, github: undefined });
    expect((parse(readFileSync(file, 'utf8')) as Record<string, unknown>).board).toEqual({ source: 'none' });
    expect(back).not.toHaveProperty('github');
  });

  test('saveFactoryDef with a stale version throws VersionConflictError', async () => {
    const { file, store } = setup(NEW);
    const [def] = await store.listFactoryDefs();
    writeFileSync(file, NEW.replace('# Delta factory', '# edited by hand'));
    await expect(store.saveFactoryDef(def!, { ...def!, name: 'X' })).rejects.toBeInstanceOf(VersionConflictError);
    expect(readFileSync(file, 'utf8')).toContain('# edited by hand');
    await expect(store.saveFactoryDef(null, { ...def!, name: 'X' })).rejects.toThrow('factory delta already exists; reload and save again');
    await expect(store.saveFactoryDef(null, { ...def!, name: 'X' })).rejects.toBeInstanceOf(VersionConflictError);
  });

  test('saveFactoryRepo adds a repo to repos.list', async () => {
    const { file, board, store } = setup(NEW);
    const repo = { factoryId: 'delta', repoId: 'web', remote: 'git@github.com:o/web.git', baseBranch: 'dev', checks: [{ name: 'lint', cwd: '.', run: 'npm run lint' }], version: 0 };
    const saved = await store.saveFactoryRepo(null, repo);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('    - id: web');
    expect(text).toContain('{ name: lint, cwd: ., run: npm run lint }');
    expect(saved).toMatchObject({ repoId: 'web', remote: repo.remote, checks: repo.checks, version: yamlVersion(text) });
    expect((await store.listFactoryRepos('delta')).map((r) => r.repoId)).toEqual(['api', 'web']);
    expect(rawBoard(board).factoryRepos).toEqual([]);
    await expect(store.saveFactoryRepo(null, repo)).rejects.toThrow('repo delta/web already exists; reload and save again');
  });

  test('saveFactoryRepo updates a repo and keeps the fields the caller did not send', async () => {
    const { file, store } = setup(NEW);
    const [api] = await store.listFactoryRepos('delta');
    expect(api!.protectedBranches).toEqual(['dev', 'main']);
    // The Board's repo form rebuilds the repo without protectedBranches.
    const { protectedBranches: _p, ...fromForm } = api!;
    const saved = await store.saveFactoryRepo(api!, { ...fromForm, baseBranch: 'stg' });
    expect(saved).toMatchObject({ baseBranch: 'stg', protectedBranches: ['dev', 'main'] });
    expect(readFileSync(file, 'utf8')).toContain('      protectedBranches: [dev, main]');
    await expect(store.saveFactoryRepo(api!, { ...api!, baseBranch: 'dev' })).rejects.toBeInstanceOf(VersionConflictError);
  });

  test('updateSettingsScope writes gates to the YAML and the rest to board.json', async () => {
    const { file, board, store } = setup(NEW);
    const before = (await store.getSettings()).factories.delta?.factory ?? DEFAULT_SETTINGS;
    const gates = { spec: false, plan: true, pr: true };
    await store.updateSettingsScope('delta', before, { ...before, gates, maxParallel: 5 });
    expect((parse(readFileSync(file, 'utf8')) as Record<string, unknown>).gates).toEqual(gates);
    expect((await store.getSettings()).factories.delta!.factory).toEqual({ ...DEFAULT_SETTINGS, gates, maxParallel: 5 });
    // board.json keeps no copy of the YAML's gates: removing them from the YAML falls back to the defaults.
    const stored = rawBoard(board).settings.factories.delta!.factory;
    expect(stored).toEqual({ ...DEFAULT_SETTINGS, maxParallel: 5 });
    writeFileSync(file, NEW);
    expect((await store.getSettings()).factories.delta!.factory).toEqual({ ...DEFAULT_SETTINGS, maxParallel: 5 });
  });

  test('updateSettingsScope leaves factory.yaml alone when the gates do not change', async () => {
    const { file, store } = setup(NEW);
    const before = (await store.getSettings()).factories.delta?.factory ?? DEFAULT_SETTINGS;
    await store.updateSettingsScope('delta', before, { ...before, paused: true });
    expect(readFileSync(file, 'utf8')).toBe(NEW);
    expect((await store.getSettings()).factories.delta!.factory.paused).toBe(true);
  });

  test('writes to a legacy-shape YAML factory are refused with the convert hint', async () => {
    const { file, store } = setup(LEGACY);
    const [def] = await store.listFactoryDefs();
    await expect(store.saveFactoryDef(def!, { ...def!, name: 'X' })).rejects.toThrow(HINT);
    const repo = { factoryId: 'delta', repoId: 'web', remote: 'git@github.com:o/web.git', baseBranch: 'dev', checks: [], version: 0 };
    await expect(store.saveFactoryRepo(null, repo)).rejects.toThrow(HINT);
    const before = (await store.getSettings()).factories.delta?.factory ?? DEFAULT_SETTINGS;
    await expect(store.updateSettingsScope('delta', before, { ...before, gates: { ...before.gates, plan: true } })).rejects.toThrow(HINT);
    expect(readFileSync(file, 'utf8')).toBe(LEGACY);
    expect(await store.listFactoryRepos('delta')).toEqual([]);
    // Settings the YAML does not own (pause, limits) still save to board.json.
    await store.updateSettingsScope('delta', before, { ...before, paused: true });
    expect((await store.getSettings()).factories.delta!.factory).toEqual({ ...DEFAULT_SETTINGS, paused: true });
  });

  test('a board.json-only factory still saves to board.json', async () => {
    const { board, store } = setup(NEW);
    const def = { factoryId: 'echo', name: 'Echo', protectedBranches: ['main'], gitName: '', gitEmail: '', docsPath: '', ghUser: 'octo-user', active: true, version: 0 };
    const saved = await store.saveFactoryDef(null, def);
    expect(saved.version).toBe(1);
    const repo = { factoryId: 'echo', repoId: 'web', remote: 'git@github.com:o/web.git', baseBranch: 'dev', checks: [], version: 0 };
    expect((await store.saveFactoryRepo(null, repo)).version).toBe(1);
    const before = (await store.getSettings()).factories.echo?.factory ?? DEFAULT_SETTINGS;
    const gates = { spec: false, plan: false, pr: false };
    await store.updateSettingsScope('echo', before, { ...before, gates });
    const raw = rawBoard(board);
    expect(raw.factoryDefs.map((d) => d.factoryId)).toEqual(['echo']);
    expect(raw.factoryRepos).toHaveLength(1);
    expect(raw.settings.factories.echo!.factory.gates).toEqual(gates);
    expect(existsSync(join(board, '..', '..', 'factories', 'echo'))).toBe(false);
  });
});
