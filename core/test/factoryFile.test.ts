import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';
import { VersionConflictError } from '../src/boardStore.js';
import { DEFAULT_GH_USER } from '../src/factories.js';
import { loadFactoriesFromDir } from '../src/factoriesFs.js';
import {
  applyChange, fileFromDefinition, loadFactoryFile, newFactoryFile, openTasksForRepo, saveFactoryFile,
  type ConfigChange, type FactoryFile, type NewFactory,
} from '../src/factoryFile.js';
import { DEFAULT_STATUS_MAP, STANDARD_STATUS_MAP } from '../src/githubConfig.js';
import { MemoryStore } from '../src/store.js';
import type { Validated } from '../src/validated.js';
import { defFixture, repoFixture } from './factoryFixtures.js';

// renameSync can be made to fail once (the failed-write test); otherwise it is the real one.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const ok = <T>(r: Validated<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const FIXTURE = `# My factory config.
# Hand written.

factory:
  id: myapp
  name: My App   # display name
  source: local
  git: { name: "Factory", email: "factory@example.com" }
  active: true
  agents:
    spec: opus
    build: sonnet

accounts:
  github: my-login

board:
  source: github
  project: my-login/7
  label: factory
  approvers: [my-login]

gates: { spec: true, plan: false, pr: true }

repos:
  protectedBranches: [dev, stg, main]
  list:
    - id: web # main web app
      remote: git@github.com:my-org/web.git
      baseBranch: dev
      checks:
        - { name: install, cwd: ., run: npm ci }
        - { name: test, cwd: ., run: npm test, needs: install }
`;

const LEGACY = `# Legacy factory.

factoryId: myapp
name: Old App   # the old one
ghUser: my-login
protectedBranches: [dev, main]
github:
  mode: github-only
  project: my-login/3
  # who approves
  approvers: [my-login]
  statusMap:
${stringify(DEFAULT_STATUS_MAP).trimEnd().split('\n').map((l) => `    ${l}`).join('\n')}
`;

const API_REPO = `# The API.
repoId: api
remote: git@github.com:my-org/api.git
baseBranch: dev
checks:
  - { name: test, cwd: ., run: npm test }
`;

const CHECKS = [{ name: 'test', cwd: '.', run: 'npm test' }];
const GATES = { spec: true, plan: false, pr: true };

let root: string;
let dir: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factoryfile-'));
  dir = join(root, 'myapp');
  path = join(dir, 'factory.yaml');
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeFixture = (text = FIXTURE) => writeFileSync(path, text);
const writeLegacy = () => {
  writeFileSync(path, LEGACY);
  mkdirSync(join(dir, 'repos'));
  writeFileSync(join(dir, 'repos', 'api.yaml'), API_REPO);
};
const loaded = () => ok(loadFactoryFile(dir));

describe('loadFactoryFile', () => {
  test('loads the new shape with a content-hash version', () => {
    writeFixture();
    const f = loaded();
    expect(f.shape).toBe('new');
    expect(f.path).toBe(path);
    expect(f.config.def.factoryId).toBe('myapp');
    expect(f.config.repos.map((r) => r.repoId)).toEqual(['web']);
    expect(f.version).toBe(loadFactoriesFromDir(root).defs[0]!.version);
    expect(f.version).toBeGreaterThan(0);
  });

  test('an invalid file names the file and the field path', () => {
    writeFixture(FIXTURE.replace('build: sonnet', 'build: gpt'));
    const r = loadFactoryFile(dir);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(new RegExp(`^${path.replace(/[.\\]/g, '\\$&')}: factory\\.agents\\.build: `)) });
  });

  test('a legacy file loads its repos/*.yaml', () => {
    writeLegacy();
    const f = loaded();
    expect(f.shape).toBe('legacy');
    expect(f.legacyRepoFiles).toEqual({ api: join(dir, 'repos', 'api.yaml') });
    expect(f.config.repos.map((r) => r.repoId)).toEqual(['api']);
  });
});

describe('applyChange and saveFactoryFile', () => {
  test('setModels keeps comments and the other lines byte for byte', () => {
    writeFixture();
    const before = readFileSync(path, 'utf8');
    const f = ok(applyChange(loaded(), { kind: 'setModels', models: { build: 'haiku' } }));
    const after = readFileSync(saveFactoryFile(f).path, 'utf8');
    expect(after).toContain('# main web app');
    expect(after).toContain('build: haiku');
    expect(after).not.toContain('spec: opus');
    expect(after.replace(/agents:[\s\S]*?\n(?=\S)/, '')).toBe(before.replace(/agents:[\s\S]*?\n(?=\S)/, ''));
  });

  const repo = { id: 'api', remote: 'git@github.com:my-org/api.git', baseBranch: 'dev', checks: CHECKS };
  const EVERY_CHANGE: [string, ConfigChange, (f: FactoryFile) => void][] = [
    ['setFactory', { kind: 'setFactory', name: 'Renamed', docsPath: '/docs', git: { name: 'Bot', email: 'bot@example.com' }, active: false },
      (f) => expect(f.config.def).toMatchObject({ name: 'Renamed', docsPath: '/docs', gitName: 'Bot', gitEmail: 'bot@example.com', active: false })],
    ['setModels', { kind: 'setModels', models: { review: 'fable' } }, (f) => expect(f.config.def.agentModels).toEqual({ review: 'fable' })],
    ['setModels {}', { kind: 'setModels', models: {} }, (f) => {
      expect(f.config.def.agentModels).toBeUndefined();
      expect(f.doc.hasIn(['factory', 'agents'])).toBe(false);
    }],
    ['setGates', { kind: 'setGates', gates: { spec: false, plan: true, pr: false } }, (f) => expect(f.config.gates).toEqual({ spec: false, plan: true, pr: false })],
    ['setAccounts', { kind: 'setAccounts', accounts: { github: 'other-login' } }, (f) => {
      expect(f.config.accounts).toEqual({ github: 'other-login' });
      expect(f.config.def.ghUser).toBe('other-login');
    }],
    ['setBoard github', { kind: 'setBoard', board: { source: 'github', project: 'org/9', label: '' } }, (f) => {
      expect(f.config.board).toMatchObject({ source: 'github', project: { owner: 'org', number: 9 }, label: '' });
    }],
    ['setBoard none', { kind: 'setBoard', board: { source: 'none' } }, (f) => {
      expect(f.config.board.source).toBe('none');
      expect(f.config.def.github).toBeUndefined();
      expect(f.doc.hasIn(['board', 'project'])).toBe(false);
    }],
    ['setApprovers', { kind: 'setApprovers', approvers: ['my-login', 'teammate'] }, (f) => expect(f.config.board.approvers).toEqual(['my-login', 'teammate'])],
    ['setStatusMap', { kind: 'setStatusMap', statusMap: STANDARD_STATUS_MAP }, (f) => expect(f.config.board.statusMap).toEqual(STANDARD_STATUS_MAP)],
    ['setStatusMap null', { kind: 'setStatusMap', statusMap: null }, (f) => {
      expect(f.config.board.statusMap).toEqual(DEFAULT_STATUS_MAP);
      expect(f.doc.hasIn(['board', 'statusMap'])).toBe(false);
    }],
    ['setProtectedBranches', { kind: 'setProtectedBranches', branches: ['stg'] }, (f) => expect(f.config.def.protectedBranches).toEqual(['stg', 'main'])],
    ['addRepo', { kind: 'addRepo', repo }, (f) => expect(f.config.repos.map((r) => r.repoId)).toEqual(['web', 'api'])],
    ['updateRepo', { kind: 'updateRepo', repoId: 'web', patch: { baseBranch: 'stg', protectedBranches: ['stg'] } }, (f) => {
      expect(f.config.repos[0]).toMatchObject({ repoId: 'web', baseBranch: 'stg', protectedBranches: ['stg', 'main'] });
    }],
    ['removeRepo', { kind: 'removeRepo', repoId: 'web' }, (f) => expect(f.config.repos).toEqual([])],
    ['convert', { kind: 'convert' }, (f) => expect(f.shape).toBe('new')],
  ];

  test.each(EVERY_CHANGE)('%s applies and re-validates', (_name, change, check) => {
    writeFixture();
    const f = ok(applyChange(loaded(), change));
    check(f);
    const saved = saveFactoryFile(f);
    check(saved);
    expect(saved.config).toEqual(ok(loadFactoryFile(dir)).config);
  });

  test('applyChange is pure: the loaded file is not changed', () => {
    writeFixture();
    const f = loaded();
    const text = f.doc.toString();
    ok(applyChange(f, { kind: 'removeRepo', repoId: 'web' }));
    expect(f.doc.toString()).toBe(text);
    expect(f.config.repos).toHaveLength(1);
  });

  test('an invalid change is refused with the field path and the file is untouched', () => {
    writeFixture();
    const r = applyChange(loaded(), { kind: 'setApprovers', approvers: ['bad login!'] });
    expect(r).toEqual({ ok: false, error: expect.stringContaining(`${path}: board.approvers: `) });
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  test('updateRepo and removeRepo of an unknown repo are refused', () => {
    writeFixture();
    expect(applyChange(loaded(), { kind: 'removeRepo', repoId: 'nope' })).toEqual({ ok: false, error: `${path}: repos: no repo nope` });
    expect(applyChange(loaded(), { kind: 'updateRepo', repoId: 'nope', patch: {} })).toEqual({ ok: false, error: `${path}: repos: no repo nope` });
  });

  test('addRepo with an id already in use is refused', () => {
    writeFixture();
    const r = applyChange(loaded(), { kind: 'addRepo', repo: { id: 'web', remote: 'git@github.com:o/x.git', baseBranch: 'dev', checks: CHECKS } });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('duplicate repo id web') });
  });


  test('a file whose factory id is not its folder name is refused', () => {
    writeFixture(FIXTURE.replace('id: myapp', 'id: other'));
    expect(loadFactoryFile(dir)).toEqual({ ok: false, error: `${path}: factory.id: must be "myapp"` });
  });

  test('a hand edit after load makes the save throw and survives', () => {
    writeFixture();
    const f = ok(applyChange(loaded(), { kind: 'setGates', gates: { spec: false, plan: false, pr: true } }));
    appendFileSync(path, '# my note\n');
    expect(() => saveFactoryFile(f)).toThrow(VersionConflictError);
    expect(() => saveFactoryFile(f)).toThrow(`${path} changed since it was read; reload and save again`);
    expect(readFileSync(path, 'utf8')).toContain('# my note');
  });

  test('a new file is not saved over a file that appeared meanwhile', () => {
    const f = ok(newFactoryFile(dir, newFactory()));
    writeFixture();
    expect(() => saveFactoryFile(f)).toThrow(VersionConflictError);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  test('the save writes through a temp file and leaves none behind', () => {
    writeFixture();
    saveFactoryFile(ok(applyChange(loaded(), { kind: 'setApprovers', approvers: ['x-y'] })));
    expect(readFileSync(path, 'utf8')).toContain('approvers: [ x-y ]');
    expect(readdirSync(dir)).toEqual(['factory.yaml']);
  });
});

describe('fix round 1', () => {
  test('a hand edit to a repos/<id>.yaml that the save would delete makes the save throw and survives', () => {
    writeFixture();
    mkdirSync(join(dir, 'repos'));
    const apiFile = join(dir, 'repos', 'api.yaml');
    writeFileSync(apiFile, API_REPO);
    const f = ok(applyChange(loaded(), { kind: 'updateRepo', repoId: 'api', patch: { baseBranch: 'stg' } }));
    appendFileSync(apiFile, '# my note\n');
    expect(() => saveFactoryFile(f)).toThrow(VersionConflictError);
    expect(() => saveFactoryFile(f)).toThrow(`${apiFile} changed since it was read; reload and save again`);
    expect(readFileSync(apiFile, 'utf8')).toContain('# my note');
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  test('a repos/<id>.yaml that vanished before the save makes it throw', () => {
    writeFixture();
    mkdirSync(join(dir, 'repos'));
    const apiFile = join(dir, 'repos', 'api.yaml');
    writeFileSync(apiFile, API_REPO);
    const f = ok(applyChange(loaded(), { kind: 'removeRepo', repoId: 'api' }));
    rmSync(apiFile);
    expect(() => saveFactoryFile(f)).toThrow(`${apiFile} changed since it was read; reload and save again`);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  const legacyNoLogin = () => {
    writeFileSync(path, LEGACY.replace('ghUser: my-login\n', ''));
    mkdirSync(join(dir, 'repos'));
    writeFileSync(join(dir, 'repos', 'api.yaml'), API_REPO);
  };

  test('convert of an old file without ghUser needs a login and never writes the fallback', () => {
    legacyNoLogin();
    const f = loaded();
    expect(applyChange(f, { kind: 'convert' })).toEqual({ ok: false, error: `${path}: accounts.github is required (used by: board, repos)` });
    const saved = saveFactoryFile(ok(applyChange(f, { kind: 'convert', githubLogin: 'me-x' })));
    expect(saved.config.accounts).toEqual({ github: 'me-x' });
    expect(readFileSync(path, 'utf8')).not.toContain(DEFAULT_GH_USER);
  });

  test('convert keeps an explicit ghUser over a given login', () => {
    writeLegacy();
    const c = ok(applyChange(loaded(), { kind: 'convert', githubLogin: 'me-x' }));
    expect(c.config.accounts).toEqual({ github: 'my-login' });
  });

  test('fileFromDefinition with the fallback login needs a login', () => {
    const def = defFixture('myapp', { ghUser: DEFAULT_GH_USER });
    const repos = [repoFixture('myapp', 'web')];
    expect(fileFromDefinition(dir, def, repos, null)).toEqual({ ok: false, error: `${path}: accounts.github is required (used by: repos)` });
    const saved = saveFactoryFile(ok(fileFromDefinition(dir, def, repos, null, 'me-x')));
    expect(saved.config.accounts).toEqual({ github: 'me-x' });
    expect(saved.config.def.ghUser).toBe('me-x');
    expect(readFileSync(path, 'utf8')).not.toContain(DEFAULT_GH_USER);
  });

  test('a failed write leaves no temp file and the old file in place', () => {
    writeFixture();
    const f = ok(applyChange(loaded(), { kind: 'setApprovers', approvers: ['x-y'] }));
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => saveFactoryFile(f)).toThrow('disk full');
    expect(readdirSync(dir)).toEqual(['factory.yaml']);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  test('a file with CRLF line endings keeps them', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    writeFixture(crlf);
    const f = ok(applyChange(loaded(), { kind: 'setModels', models: { build: 'haiku' } }));
    const after = readFileSync(saveFactoryFile(f).path, 'utf8');
    expect(after).toContain('build: haiku\r\n');
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    const cut = (t: string) => t.replace(/agents:[\s\S]*?\r\n(?=\S)/, '');
    expect(cut(after)).toBe(cut(crlf));
  });

  test('setApprovers and setStatusMap need a board first', () => {
    writeFixture();
    const none = ok(applyChange(loaded(), { kind: 'setBoard', board: { source: 'none' } }));
    expect(applyChange(none, { kind: 'setApprovers', approvers: ['x-y'] })).toEqual({ ok: false, error: `${path}: board.approvers: set the board first` });
    expect(applyChange(none, { kind: 'setStatusMap', statusMap: STANDARD_STATUS_MAP })).toEqual({ ok: false, error: `${path}: board.statusMap: set the board first` });
  });
});

describe('the old format', () => {
  test('a legacy file must be converted first; convert moves repos/*.yaml into repos.list', () => {
    writeLegacy();
    const f = loaded();
    expect(applyChange(f, { kind: 'setApprovers', approvers: ['my-login'] })).toEqual({ ok: false, error: `${path} is in the old format; convert it first` });
    expect(() => saveFactoryFile(f)).toThrow(`${path} is in the old format; convert it first`);

    const c = ok(applyChange(f, { kind: 'convert' }));
    expect(c.shape).toBe('new');
    expect(c.removedFiles).toEqual([join(dir, 'repos', 'api.yaml')]);
    expect(c.legacyRepoFiles).toEqual({});
    const saved = saveFactoryFile(c);
    expect(existsSync(join(dir, 'repos', 'api.yaml'))).toBe(false);
    expect(saved.shape).toBe('new');
    expect(saved.removedFiles).toEqual([]);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('# Legacy factory.')).toBe(true);
    expect(text).toContain('# the old one');
    expect(text).toContain('# who approves');
    expect(text).toContain('# The API.');
    // The same factory, now in the new shape.
    const { version: _a, ...before } = f.config.def;
    const { version: _b, ...after } = saved.config.def;
    expect(after).toEqual(before);
    expect(saved.config.repos.map(({ version: _v, ...r }) => r)).toEqual(f.config.repos.map(({ version: _v, ...r }) => r));
    expect(saved.config.board).toEqual(f.config.board);
  });

  test('updateRepo on a repos/<id>.yaml repo moves it into the list and deletes the file on save', () => {
    writeFixture();
    mkdirSync(join(dir, 'repos'));
    const apiFile = join(dir, 'repos', 'api.yaml');
    writeFileSync(apiFile, API_REPO);
    const f = loaded();
    expect(f.legacyRepoFiles).toEqual({ api: apiFile });
    const u = ok(applyChange(f, { kind: 'updateRepo', repoId: 'api', patch: { baseBranch: 'stg' } }));
    expect(u.removedFiles).toEqual([apiFile]);
    expect(u.legacyRepoFiles).toEqual({});
    const saved = saveFactoryFile(u);
    expect(existsSync(apiFile)).toBe(false);
    expect(saved.config.repos.map((r) => [r.repoId, r.baseBranch])).toEqual([['web', 'dev'], ['api', 'stg']]);
    expect(saved.doc.getIn(['repos', 'list', 1, 'id'])).toBe('api');
  });

  test('removeRepo on a repos/<id>.yaml repo drops it and deletes the file on save', () => {
    writeFixture();
    mkdirSync(join(dir, 'repos'));
    const apiFile = join(dir, 'repos', 'api.yaml');
    writeFileSync(apiFile, API_REPO);
    const saved = saveFactoryFile(ok(applyChange(loaded(), { kind: 'removeRepo', repoId: 'api' })));
    expect(existsSync(apiFile)).toBe(false);
    expect(saved.config.repos.map((r) => r.repoId)).toEqual(['web']);
  });
});

const newFactory = (over: Partial<NewFactory> = {}): NewFactory => ({
  id: 'myapp', name: 'My App', accounts: { github: 'my-login' },
  board: { source: 'github', project: 'my-login/7', label: 'factory', approvers: ['my-login'], statusMap: STANDARD_STATUS_MAP },
  gates: GATES, models: {}, protectedBranches: ['dev', 'stg', 'main'],
  repos: [{ id: 'web', remote: 'git@github.com:my-org/web.git', baseBranch: 'dev', checks: CHECKS }],
  ...over,
});

describe('newFactoryFile', () => {
  test('newFactoryFile round-trips through loadFactoryFile', () => {
    const f = ok(newFactoryFile(dir, newFactory()));
    expect(f.version).toBe(0);
    expect(existsSync(path)).toBe(false);
    const saved = saveFactoryFile(f);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('# Written by factory init. Edit freely; ./factory init keeps your comments.\n')).toBe(true);
    expect(text).not.toContain('gates:');
    expect(text).not.toContain('agents:');
    expect(saved.config).toEqual(ok(loadFactoryFile(dir)).config);
    expect(saved.config.def).toMatchObject({ factoryId: 'myapp', name: 'My App', ghUser: 'my-login', protectedBranches: ['dev', 'stg', 'main'] });
    expect(saved.config.board).toMatchObject({ source: 'github', approvers: ['my-login'], statusMap: STANDARD_STATUS_MAP });
    expect(saved.config.repos.map((r) => r.repoId)).toEqual(['web']);
  });

  test('gates and models other than the defaults are written', () => {
    const f = ok(newFactoryFile(dir, newFactory({ gates: { spec: false, plan: false, pr: true }, models: { build: 'haiku' }, board: { source: 'none' } })));
    const saved = saveFactoryFile(f);
    expect(saved.config.gates).toEqual({ spec: false, plan: false, pr: true });
    expect(saved.config.def.agentModels).toEqual({ build: 'haiku' });
    expect(saved.config.board.source).toBe('none');
  });

  test('an invalid new factory is refused with the field path', () => {
    const r = newFactoryFile(dir, newFactory({ accounts: {} }));
    expect(r).toEqual({ ok: false, error: `${path}: accounts.github is required (used by: board, repos)` });
  });
});

describe('fileFromDefinition', () => {
  test('fileFromDefinition writes a board.json definition that loads back to the same def', () => {
    const def = defFixture('myapp', {
      agentModels: { spec: 'opus' }, protectedBranches: ['dev', 'main'],
      github: { mode: 'github-only', project: { owner: 'gh-myapp', number: 4 }, label: 'factory', approvers: ['gh-myapp'], statusMap: DEFAULT_STATUS_MAP },
    });
    const repos = [repoFixture('myapp', 'web'), repoFixture('myapp', 'api', { protectedBranches: ['stg', 'main'] })];
    const saved = saveFactoryFile(ok(fileFromDefinition(dir, def, repos, { spec: false, plan: false, pr: true })));
    const { version: _v, ...expected } = def;
    const { version: _w, ...got } = saved.config.def;
    expect(got).toEqual(expected);
    expect(saved.config.repos.map(({ version: _x, ...r }) => r)).toEqual(repos.map(({ version: _x, ...r }) => r));
    expect(saved.config.gates).toEqual({ spec: false, plan: false, pr: true });
    const fromDir = loadFactoriesFromDir(root);
    expect(fromDir.defs[0]).toEqual(saved.config.def);
  });

  test('a definition without GitHub and without gates', () => {
    const def = defFixture('myapp');
    const saved = saveFactoryFile(ok(fileFromDefinition(dir, def, [], null)));
    expect(saved.config.board.source).toBe('none');
    expect(saved.config.gates).toBeNull();
    const { version: _v, ...expected } = def;
    const { version: _w, ...got } = saved.config.def;
    expect(got).toEqual(expected);
  });
});

describe('openTasksForRepo', () => {
  test('openTasksForRepo lists open tasks of that repo only', async () => {
    const store = new MemoryStore({
      factories: { defs: [defFixture('myapp'), defFixture('other')], repos: [repoFixture('myapp', 'web'), repoFixture('myapp', 'api'), repoFixture('other', 'web')] },
    });
    const a = await store.createTask({ factoryId: 'myapp', title: 'a', description: '', repo: 'web' });
    const done = await store.createTask({ factoryId: 'myapp', title: 'b', description: '', repo: 'web' });
    await store.updateTask(done.taskId, done.version, { status: 'cancelled' });
    await store.createTask({ factoryId: 'myapp', title: 'c', description: '', repo: 'api' });
    await store.createTask({ factoryId: 'other', title: 'd', description: '', repo: 'web' });
    const open = await openTasksForRepo(store, 'myapp', 'web');
    expect(open.map((t) => t.taskId)).toEqual([a.taskId]);
  });
});
