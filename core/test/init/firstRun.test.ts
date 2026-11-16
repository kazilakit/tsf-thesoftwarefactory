import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DoctorCheck } from '../../src/doctor.js';
import { loadFactoryFile } from '../../src/factoryFile.js';
import { FakeGitHubBoard } from '../../src/githubBoard.js';
import { DEFAULT_STATUS_MAP, STANDARD_STATUS_MAP } from '../../src/githubConfig.js';
import { FakeGitHubSetup } from '../../src/githubSetup.js';
import { firstRun } from '../../src/init/firstRun.js';
import type { GhCli } from '../../src/init/ghCli.js';
import { scriptedPrompter } from '../../src/init/prompts.js';
import { idFromName, type InitDeps } from '../../src/init/shared.js';
import { MemoryStore } from '../../src/store.js';
import type { Validated } from '../../src/validated.js';
import { defFixture } from '../factoryFixtures.js';

const ok = <T>(r: Validated<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const READY = 'Ready. Open Claude Code and run /factory:run.';
const WINDOWS = 'Note: the factory steps themselves (git worktrees, the guard hook, shell checks) have not been tested on Windows yet.';
const PKG = JSON.stringify({ scripts: { test: 'vitest run' } });

/** gh fake: `logins` is what each logins() call returns in turn (the last repeats). */
class FakeGh implements GhCli {
  calls: string[] = [];
  constructor(private seq: string[][], private onRefresh: () => void = () => {}) {}
  async logins() {
    this.calls.push('logins');
    return this.seq.length > 1 ? this.seq.shift()! : this.seq[0]!;
  }
  async login() { this.calls.push('login'); }
  async refreshProjectScope(login: string) { this.calls.push(`refresh ${login}`); this.onRefresh(); }
}

let root: string;
let fakeSetup: FakeGitHubSetup;
let fakeBoard: FakeGitHubBoard;
let gh: FakeGh;
let store: MemoryStore;
let doctorRuns: DoctorCheck[][];
let doctorCalls: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsf-init-'));
  fakeSetup = new FakeGitHubSetup();
  fakeSetup.repos.set('o/web', { defaultBranch: 'main', branches: ['dev'] });
  fakeSetup.files.set('o/web@main', { 'package.json': PKG, 'package-lock.json': '{}' });
  fakeBoard = new FakeGitHubBoard();
  gh = new FakeGh([['me']]);
  store = new MemoryStore();
  doctorRuns = [];
  doctorCalls = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(answers: string[], over: Partial<InitDeps> = {}): InitDeps & { transcript: string[] } {
  const prompt = scriptedPrompter(answers);
  const d: InitDeps = {
    root, prompt, gh, boardFor: () => fakeBoard, setupFor: () => fakeSetup,
    openStore: async () => store,
    doctor: async (factoryId) => {
      const run = doctorRuns[doctorCalls++] ?? [];
      return run.length ? run : [{ factoryId, check: 'gh login', ok: true, detail: 'me logged in' }];
    },
    platform: 'linux', now: () => new Date('2026-11-15T00:00:00Z'),
    ...over,
  };
  return Object.assign(d, { transcript: prompt.transcript });
}

// name, id (default), project 1 = Create a new Project, title (default), approvers (default),
// gates x3 (defaults), models 1 = session, repo lines, Default setup.
const SCRIPT_DEFAULT_PATH = ['My App', '', '1', '', '', '', '', '', '1', 'o/web', '', '1'];

describe('firstRun', () => {
  test('default path writes a factory.yaml that loads, creates labels and columns, and ends Ready', async () => {
    const d = deps(SCRIPT_DEFAULT_PATH);
    const code = await firstRun(d);
    expect(code).toBe(0);
    const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
    expect(f.config.def).toMatchObject({ name: 'My App', ghUser: 'me' });
    expect(f.config.def.github).toMatchObject({ project: { owner: 'me', number: 1 }, label: 'factory', approvers: ['me'] });
    expect(f.config.board.statusMap).toEqual(STANDARD_STATUS_MAP);
    expect(f.config.def.protectedBranches).toEqual(['dev', 'stg', 'main']);
    expect(f.config.repos[0]).toMatchObject({
      repoId: 'web', remote: 'git@github.com:o/web.git', baseBranch: 'dev',
      checks: [{ name: 'install', run: 'npm ci' }, expect.anything()],
    });
    expect(f.config.repos[0]!.protectedBranches).toBeUndefined();
    expect(fakeSetup.projects.get('me')).toEqual([{ owner: 'me', number: 1, title: 'My App' }]);
    expect(fakeSetup.statusOptions.get('me/1')).toEqual(expect.arrayContaining([...new Set(Object.values(STANDARD_STATUS_MAP))]));
    expect(fakeBoard.labels.get('o/web')?.has('factory')).toBe(true);
    expect(d.transcript.some((l) => l.includes('may be incomplete'))).toBe(true);
    expect(d.transcript.at(-1)).toBe(READY);
  });

  test('no gh login runs gh auth login; a missing project scope runs the refresh', async () => {
    gh = new FakeGh([[], ['me']], () => { fakeBoard.scopes = ['repo', 'project']; });
    fakeBoard.scopes = ['repo'];
    expect(await firstRun(deps(SCRIPT_DEFAULT_PATH))).toBe(0);
    expect(gh.calls).toEqual(['logins', 'login', 'logins', 'refresh me']);
  });

  test('a login still without the project scope after the refresh stops with exit 1', async () => {
    fakeBoard.scopes = null;
    const d = deps(SCRIPT_DEFAULT_PATH);
    expect(await firstRun(d)).toBe(1);
    expect(d.transcript.at(-1)).toContain('gh auth refresh --hostname github.com -s project');
    expect(existsSync(join(root, 'factories'))).toBe(false);
  });

  test('several logins: the chosen one is written; none ever falls back to a default', async () => {
    gh = new FakeGh([['me', 'other']]);
    expect(await firstRun(deps(['2', ...SCRIPT_DEFAULT_PATH]))).toBe(0);
    const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
    expect(f.config.accounts).toEqual({ github: 'other' });
  });

  test('a repo whose default branch is main uses dev when it exists, else asks and refuses main', async () => {
    fakeSetup.repos.set('o/api', { defaultBranch: 'main', branches: ['develop'] });
    const script = ['My App', '', '1', '', '', '', '', '', '1', 'o/web', 'https://github.com/o/api', '', '1', 'main', 'nope', 'develop'];
    const d = deps(script);
    expect(await firstRun(d)).toBe(0);
    const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
    expect(f.config.repos.map((r) => [r.repoId, r.baseBranch])).toEqual([['web', 'dev'], ['api', 'develop']]);
    expect(f.config.repos[1]!.checks).toEqual([]);
    expect(d.transcript).toContain('main is never a base branch');
    expect(d.transcript).toContain('o/api has no branch nope');
    expect(d.transcript).toContain('no checks found for api');
  });

  test('bad repo lines re-ask the whole list, naming the bad lines', async () => {
    const script = ['My App', '', '1', '', '', '', '', '', '1', 'o/web', 'not a link', 'o/missing', '', 'o/web', '', '1'];
    const d = deps(script);
    expect(await firstRun(d)).toBe(0);
    expect(d.transcript.some((l) => l.includes('not a link') && l.includes('not a GitHub repo'))).toBe(true);
    expect(d.transcript.some((l) => l.includes('o/missing') && l.includes('not found'))).toBe(true);
  });

  test('custom path: edited checks, base and protected branches land in the file', async () => {
    const script = [
      'My App', '', '1', '', '', '', '', '', '1', 'git@github.com:o/web.git', '',
      '2', // Custom setup
      'release', // base (exists? no) -> re-asked
      'dev', // base
      'dev, qa', // protected
      // checks menu: 1 keep, 2 add, 3 edit, 4 remove
      '3', '2', '', '', 'npm test', '', // edit check 2 (test): keep name, cwd, new run, keep needs
      '2', 'lint', 'web', 'npm run lint', '', // add lint in cwd web, no needs
      '4', '1', // remove install -> test needs install: keep fails
      '1', // keep -> error, menu again
      '3', '1', '', '', '', '-', // edit test: clear needs
      '1', // keep
    ];
    const d = deps(script);
    expect(await firstRun(d)).toBe(0);
    const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
    expect(f.config.repos[0]).toMatchObject({
      baseBranch: 'dev', protectedBranches: ['dev', 'qa', 'main'],
      checks: [{ name: 'test', cwd: '.', run: 'npm test' }, { name: 'lint', cwd: 'web', run: 'npm run lint' }],
    });
    expect(f.config.repos[0]!.checks[0]!.needs).toBeUndefined();
    expect(d.transcript).toContain('o/web has no branch release');
    expect(d.transcript.some((l) => l.includes('install is not an earlier check'))).toBe(true);
  });

  test('existing Project with the five default columns: yes keeps statusMap out of the file', async () => {
    fakeSetup.projects.set('me', [{ owner: 'me', number: 4, title: 'Old board' }]);
    fakeBoard.addProject({ owner: 'me', number: 4 }, ['Backlog', 'Todo', 'In progress', 'In review', 'Merged']);
    fakeSetup.statusOptions.set('me/4', ['Backlog', 'Todo', 'In progress', 'In review', 'Merged']);
    const script = ['My App', '', '1', '', '', '', '', '', '1', 'o/web', '', '1'];
    const d = deps(script);
    expect(await firstRun(d)).toBe(0);
    const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
    expect(f.doc.getIn(['board', 'statusMap'])).toBeUndefined();
    expect(f.config.board.statusMap).toEqual(DEFAULT_STATUS_MAP);
    expect(f.config.board.project).toEqual({ owner: 'me', number: 4 });
    expect(d.transcript.some((l) => l.startsWith('Use the default map (Backlog, Todo, In progress, In review, Merged)?'))).toBe(true);
    expect(fakeSetup.projects.get('me')).toHaveLength(1);
  });

  test('per-status map that breaks the rules is asked again', async () => {
    fakeSetup.projects.set('me', [{ owner: 'me', number: 4, title: 'Old board' }]);
    fakeBoard.addProject({ owner: 'me', number: 4 }, ['A', 'B', 'C']);
    // 13 statuses; options: 1 A, 2 B, 3 C, 4 New column…
    const bad = Array(13).fill('1'); // everything on A: inbox = ready
    const good = ['1', '2', '3', '3', '3', '3', '3', '3', '3', '4', 'Shipped', '4', '3', '1'];
    const script = ['My App', '', '1', '', ...bad, ...good, '', '', '', '1', 'o/web', '', '1'];
    const d = deps(script);
    expect(await firstRun(d)).toBe(0);
    const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
    expect(f.config.board.statusMap).toMatchObject({ inbox: 'A', ready: 'B', spec: 'C', pr_open: 'Shipped', done: 'Shipped', blocked: 'C', cancelled: 'A' });
    expect(d.transcript.some((l) => l.includes('inbox and ready must map to different options'))).toBe(true);
    expect(fakeSetup.addedOptions.flatMap((x) => x.names)).toEqual(['A', 'B', 'C', 'Shipped']);
  });

  test('per-stage models land in factory.agents; session leaves a stage out', async () => {
    const script = ['My App', '', '1', '', '', '', '', '', '2', '2', '1', '3', '4', '5', 'o/web', '', '1'];
    expect(await firstRun(deps(script))).toBe(0);
    const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
    expect(f.config.def.agentModels).toEqual({ spec: 'opus', build: 'sonnet', verify: 'haiku', review: 'fable' });
  });

  test('the id must be valid, not global and not taken', async () => {
    await store.saveFactoryDef(null, defFixture('taken'));
    const script = ['My App', 'Bad Id', 'global', 'taken', 'mine', '1', '', '', '', '', '', '1', 'o/web', '', '1'];
    const d = deps(script);
    expect(await firstRun(d)).toBe(0);
    expect(existsSync(join(root, 'factories', 'mine', 'factory.yaml'))).toBe(true);
    expect(d.transcript.filter((l) => l.startsWith('The id ') || l.includes('reserved') || l.includes('already exists'))).toHaveLength(3);
  });

  test('input closing before the write leaves no factory folder and exits 130', async () => {
    const d = deps(SCRIPT_DEFAULT_PATH.slice(0, -1)); // stops at the setup question
    expect(await firstRun(d)).toBe(130);
    expect(existsSync(join(root, 'factories'))).toBe(false);
    expect(fakeSetup.projects.size).toBe(0);
    expect(fakeBoard.labels.size).toBe(0);
    expect(d.transcript.at(-1)).toBe('setup cancelled; nothing was written');
  });

  test('doctor failures: retry re-runs doctor; no exits 1 with the hint', async () => {
    const fail: DoctorCheck = { factoryId: 'my-app', check: 'repo web', ok: false, detail: 'not visible' };
    doctorRuns = [[fail], [fail]];
    const d = deps([...SCRIPT_DEFAULT_PATH, 'y', 'n']);
    expect(await firstRun(d)).toBe(1);
    expect(doctorCalls).toBe(2);
    expect(d.transcript.filter((l) => l === 'FAIL repo web: not visible')).toHaveLength(2);
    expect(d.transcript.at(-1)).toBe('Fix the failures above, then run ./factory init and choose Re-check.');

    doctorRuns = [[fail]];
    doctorCalls = 0;
    rmSync(join(root, 'factories'), { recursive: true });
    fakeSetup.projects.clear();
    const d2 = deps([...SCRIPT_DEFAULT_PATH, '']);
    expect(await firstRun(d2)).toBe(0);
    expect(doctorCalls).toBe(2);
  });

  test('an invalid factory file is refused before a new Project is created', async () => {
    fakeSetup.me = { login: 'me', orgs: ['bad_org'] };
    // name, id, project 1 = Create a new Project, owner 2 = bad_org, title, approvers, gates x3, models, repo, setup
    const d = deps(['My App', '', '1', '2', '', '', '', '', '', '1', 'o/web', '', '1']);
    expect(await firstRun(d)).toBe(1);
    expect(fakeSetup.projects.size).toBe(0);
    expect(existsSync(join(root, 'factories'))).toBe(false);
    expect(d.transcript.at(-1)).toContain('project');
  });

  test('a save that fails after the Project was created names that Project', async () => {
    class RacingSetup extends FakeGitHubSetup {
      override async createProject(owner: string, title: string) {
        mkdirSync(join(root, 'factories', 'my-app'), { recursive: true });
        writeFileSync(join(root, 'factories', 'my-app', 'factory.yaml'), 'factory: { id: my-app }\n');
        return super.createProject(owner, title);
      }
    }
    const racing = new RacingSetup();
    racing.repos.set('o/web', { defaultBranch: 'main', branches: ['dev'] });
    const d = deps(SCRIPT_DEFAULT_PATH, { setupFor: () => racing });
    expect(await firstRun(d)).toBe(1);
    expect(d.transcript.at(-1)).toMatch(/^Created the Project me\/1, but factory\.yaml was not written: /);
  });

  test('after the scope refresh the re-check uses a fresh board client, not the cached one', async () => {
    fakeBoard.scopes = ['repo']; // the cached client keeps the old token's scopes
    let current = ['repo'];
    gh = new FakeGh([['me']], () => { current = ['repo', 'project']; });
    const fresh = () => Object.assign(new FakeGitHubBoard(), { scopes: [...current] });
    const d = deps(SCRIPT_DEFAULT_PATH, { freshBoardFor: fresh });
    expect(await firstRun(d)).toBe(0);
    expect(gh.calls).toEqual(['logins', 'refresh me']);
  });

  test('on win32 the Windows note follows Ready', async () => {
    const d = deps(SCRIPT_DEFAULT_PATH, { platform: 'win32' });
    expect(await firstRun(d)).toBe(0);
    expect(d.transcript.slice(-2)).toEqual([READY, WINDOWS]);
  });
});

describe('idFromName', () => {
  test('lowercases, dashes and dedupes against taken ids', () => {
    expect(idFromName('My App', [])).toBe('my-app');
    expect(idFromName('  42 Things!! ', [])).toBe('things');
    expect(idFromName('My App', ['my-app', 'my-app-2'])).toBe('my-app-3');
    expect(idFromName('Global', [])).toBe('global-2');
    expect(idFromName('***', [])).toBe('factory');
    expect(idFromName('x'.repeat(60), ['x'.repeat(40)])).toBe(`${'x'.repeat(38)}-2`);
  });
});
