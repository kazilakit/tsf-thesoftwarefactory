import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { shellExec } from '../src/checks.js';
import { Engine, type EngineDeps } from '../src/engine.js';
import { LocalGitRepos, type GitIdentity } from '../src/git.js';
import { FakeGitHub } from '../src/github.js';
import { FactoryConfig, type FactoryRepo } from '../src/factories.js';
import { run } from '../src/cli.js';
import { FakeGitHubBoard } from '../src/githubBoard.js';
import { FileStore } from '../src/store.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { defFixture, repoFixture } from './factoryFixtures.js';
import { nextTicket } from './nextTicket.js';
import { MemoryStore } from '../src/store.js';
import type { RepoId } from '../src/types.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

/** FakeGitHub only parses github.com remotes; the engine passes the temp bare repo path, so give it a github-shaped one. */
class PathRemoteGitHub extends FakeGitHub {
  /** The body of every PR opened. */
  readonly bodies: string[] = [];
  override openPr(p: Parameters<FakeGitHub['openPr']>[0]) {
    this.bodies.push(p.body);
    return super.openPr({ ...p, remote: 'git@github.com:example-org/blocks-data.git' });
  }
  override findOpenPr(p: Parameters<FakeGitHub['findOpenPr']>[0]) {
    return super.findOpenPr({ ...p, remote: 'git@github.com:example-org/blocks-data.git' });
  }
}

/** Clones and pushes the temp bare repo while the engine and the store keep the repo's real GitHub remote (the PR body reads the issue number from it). */
class BareRemoteGit extends LocalGitRepos {
  override ensureClone(f: string, repo: FactoryRepo, protectedBranches: string[]) {
    return super.ensureClone(f, { ...repo, remote: bare }, protectedBranches);
  }
  override worktree(f: string, repo: FactoryRepo, taskId: string, branch: string, protectedBranches: string[], identity?: GitIdentity) {
    return super.worktree(f, { ...repo, remote: bare }, taskId, branch, protectedBranches, identity);
  }
}

let tmp: string;
let bare: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'factory-integration-')));
  const seed = join(tmp, 'seed');
  bare = join(tmp, 'remote.git');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'dev');
  for (const d of ['server', 'client']) {
    mkdirSync(join(seed, d));
    writeFileSync(join(seed, d, '.keep'), '');
  }
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(tmp, 'clone', '-q', '--bare', seed, bare);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setup(clientTest = 'true') {
  const cfg = repoFixture('blocks', 'data', {
    remote: bare,
    checks: [
      { name: 'server.build', cwd: 'server', run: 'true' },
      { name: 'server.test', cwd: 'server', run: 'true', needs: 'server.build' },
      { name: 'client.install', cwd: 'client', run: 'true' },
      { name: 'client.typecheck', cwd: 'client', run: 'true', needs: 'client.install' },
      { name: 'client.lint', cwd: 'client', run: 'true', needs: 'client.install' },
      { name: 'client.test', cwd: 'client', run: clientTest, needs: 'client.install' },
    ],
  });
  const store = new MemoryStore();
  const github = new PathRemoteGitHub();
  const deps: EngineDeps = {
    store,
    git: new LocalGitRepos(join(tmp, 'factory')),
    githubFor: () => github,
    factories: async () => new FactoryConfig([defFixture('blocks')], [cfg]),
    exec: shellExec,
    now: () => new Date(),
    mode: 'session',
    claimant: 'me',
  };
  return { store, github, engine: new Engine(deps) };
}

const result = (r: object) => JSON.stringify(r);
const devSha = () => git(tmp, 'ls-remote', bare, 'refs/heads/dev').trim();

async function readyTask(store: MemoryStore) {
  const t = await store.createTask({ factoryId: 'blocks', title: 'Add widget', description: 'd', repo: 'data', baseBranch: 'dev' });
  await store.updateTask(t.taskId, t.version, { status: 'ready' });
}

async function buildOnce(engine: Engine, step: string, worktree: string, n: number) {
  expect(step).toBe('build');
  writeFileSync(join(worktree, `f${n}.txt`), String(n));
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', `change ${n}`);
  await engine.complete('T-1', 'build', result({ status: 'done', summary: 's' }));
}

describe('integration', () => {
  test('ready to pr_open with stubbed agents', async () => {
    const { store, github, engine } = setup();
    const before = devSha();
    await readyTask(store);

    let ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('spec');
    let task = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: '# Spec' }));
    expect(task.status).toBe('spec_review');

    const spec = await store.currentDoc('T-1', 'spec');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: spec!.version, decision: 'approve', comment: '' });
    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('plan');
    task = await engine.complete('T-1', 'plan', result({ status: 'done', summary: 's', doc: '# Plan' }));
    expect(task.status).toBe('build');

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('build');
    writeFileSync(join(ticket!.worktree, 'hello.txt'), 'hello');
    git(ticket!.worktree, 'add', '.');
    git(ticket!.worktree, 'commit', '-q', '-m', 'add hello');
    await engine.complete('T-1', 'build', result({ status: 'done', summary: 's' }));

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('check');
    await engine.check('T-1');

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('verify');
    await engine.complete('T-1', 'verify', result({ status: 'done', summary: 's', verdict: 'pass', doc: '# Verify' }));

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('review');
    await engine.complete('T-1', 'review', result({ status: 'done', summary: 's', verdict: 'approve', doc: '# Review' }));

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('ship');
    task = await engine.ship('T-1');

    expect(task.status).toBe('pr_open');
    expect(github.prs.size).toBe(1);
    const [url, pr] = [...github.prs][0]!;
    expect(pr.base).toBe('dev');
    expect(pr.head).toMatch(/^factory\/T-1-/);
    expect(git(tmp, 'ls-remote', bare, `refs/heads/${pr.head}`)).toContain(`refs/heads/${pr.head}`);
    expect(devSha()).toBe(before);

    const moves = (await store.listEvents('T-1')).filter((e) => e.action === 'move').map((e) => `${e.from}→${e.to}`);
    expect(moves).toEqual([
      'ready→spec',
      'spec→spec_review',
      'spec_review→plan',
      'plan→build',
      'build→verify',
      'verify→review',
      'review→pr_open',
    ]);

    github.setState(url, 'merged');
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('done');
  });

  test('checks fail three times → blocked', async () => {
    const { store, engine } = setup('false');
    await readyTask(store);

    await nextTicket(engine);
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: '# Spec' }));
    const spec = await store.currentDoc('T-1', 'spec');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: spec!.version, decision: 'approve', comment: '' });
    await nextTicket(engine);
    await engine.complete('T-1', 'plan', result({ status: 'done', summary: 's', doc: '# Plan' }));

    for (let n = 1; n <= 3; n++) {
      const ticket = await nextTicket(engine);
      await buildOnce(engine, ticket!.step, ticket!.worktree, n);
      expect((await nextTicket(engine))?.step).toBe('check');
      await engine.check('T-1');
    }

    const task = await store.getTask('T-1');
    expect(task.status).toBe('blocked');
    expect(task.attempt).toBe(3);
    expect(task.blockedReason).toBe('returned to build 3 times');
  });
});

describe('GitHub-only push', () => {
  const MAP = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress', plan_review: 'In progress',
    build: 'In progress', verify: 'In progress', review: 'In progress', pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' };
  const yamlText = (over: Record<string, string> = {}) => 'factoryId: f\nname: F\ngithub:\n  mode: github-only\n  project: o/3\n  statusMap:\n'
    + Object.entries({ ...MAP, ...over }).map(([k, v]) => `    ${k}: ${v}\n`).join('');
  const repoYaml = 'repoId: app\nremote: git@github.com:o/app.git\nchecks:\n  server: { cwd: s, build: b, test: t }\n  client: { cwd: c, install: i, typecheck: tc, lint: l, test: t }\n  e2e: off\n';

  test('GitHub-only push follows a task from new to cancelled', async () => {
    const root = join(tmp, 'froot');
    mkdirSync(join(root, 'factories', 'f', 'repos'), { recursive: true });
    const yaml = join(root, 'factories', 'f', 'factory.yaml');
    writeFileSync(yaml, yamlText());
    writeFileSync(join(root, 'factories', 'f', 'repos', 'app.yaml'), repoYaml);
    const board = new FakeGitHubBoard();
    const info = board.addProject({ owner: 'o', number: 3 }, ['Backlog', 'Todo', 'In progress', 'In review', 'Merged']);
    const REPO = { owner: 'o', repo: 'app' };
    const saved = process.env.FACTORY_ROOT;
    process.env.FACTORY_ROOT = root;
    try {
      let out: string[] = [];
      const go = async (...argv: string[]) => {
        out = [];
        const code = await run(['--store', 'file', ...argv], { out: (s) => out.push(s), err: (s) => out.push(s) }, undefined, { githubBoardFor: () => board });
        expect(code, out.join('\n')).toBe(0);
        return out.join('\n');
      };
      const status = async () => (await board.listItems(info))[0]!.status;
      const boardFile = join(root, '.factory', 'board.json');
      const linkVersion = async (id: string) => (await new FileStore(boardFile, { factoriesDir: join(root, 'factories') }).getGitHubLink(id))!.version;

      const created = await go('new', '--repo', 'app', '--title', 'A', '--description', 'D');
      const id = /^(\S+) created in/m.exec(created)![1]!;
      expect(created).toContain('issue o/app#1');
      expect(board.issue(REPO, 1).labels).toEqual(['factory']);
      expect(board.issue(REPO, 1).body).toMatch(new RegExp(`<!-- tsf:task=${id} factory=f -->$`));
      expect(await status()).toBe('Backlog');

      await go('dev', 'ready', id);
      expect(await status()).toBe('Todo');

      // The engine's own write path: a spec doc, then the task in spec_review.
      const engineSide = new FileStore(boardFile, { factoriesDir: join(root, 'factories') });
      await engineSide.addDoc(id, 'spec', '# Spec\nDo it.', 'spec-writer');
      const t = (await engineSide.getTask(id))!;
      await engineSide.updateTask(id, t.version, { status: 'spec_review', stage: 'spec' });
      expect(await go('sync')).toContain('pushed 1, failed 0');
      const comments = board.issue(REPO, 1).comments;
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body.startsWith('## Spec v1')).toBe(true);
      expect(await status()).toBe('In progress');

      writeFileSync(yaml, yamlText({ spec_review: 'In review' }));
      const later = new Date(Date.now() + 5000);
      utimesSync(yaml, later, later);
      await go('sync');
      expect(await status()).toBe('In review');
      expect(board.issue(REPO, 1).comments).toHaveLength(1);

      await go('dev', 'cancel', id);
      expect(board.issue(REPO, 1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
      expect(await status()).toBe('Backlog');

      const v = await linkVersion(id);
      expect(await go('sync')).toContain('pushed 0, failed 0');
      expect(await linkVersion(id)).toBe(v);
    } finally {
      if (saved === undefined) delete process.env.FACTORY_ROOT; else process.env.FACTORY_ROOT = saved;
    }
  });
});

describe('GitHub-only end to end', () => {
  const MAP = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress', plan_review: 'In progress',
    build: 'In progress', verify: 'In progress', review: 'In progress', pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' };
  const factoryYaml = 'factoryId: f\nname: F\nghUser: octo-user\ngithub:\n  mode: github-only\n  project: o/3\n  statusMap:\n'
    + Object.entries(MAP).map(([k, v]) => `    ${k}: ${v}\n`).join('');
  const repoYaml = 'repoId: app\nremote: git@github.com:o/app.git\nchecks:\n  server: { cwd: server, build: "true", test: "true" }\n'
    + '  client: { cwd: client, install: "true", typecheck: "true", lint: "true", test: "true" }\n  e2e: off\n';
  const reply = (r: object, doc?: string) => `<factory-result>\n${JSON.stringify(r)}\n</factory-result>${doc === undefined ? '' : `\n<factory-doc>\n${doc}\n</factory-doc>`}`;

  test('a hand-made issue goes from Todo to Merged through comments, reviews and the merge', async () => {
    const root = join(tmp, 'froot');
    mkdirSync(join(root, 'factories', 'f', 'repos'), { recursive: true });
    writeFileSync(join(root, 'factories', 'f', 'factory.yaml'), factoryYaml);
    writeFileSync(join(root, 'factories', 'f', 'repos', 'app.yaml'), repoYaml);
    const boardFile = join(root, '.factory', 'board.json');
    const fileStore = () => new FileStore(boardFile, { factoriesDir: join(root, 'factories') });
    const board = new FakeGitHubBoard();
    const info = board.addProject({ owner: 'o', number: 3 }, ['Backlog', 'Todo', 'In progress', 'In review', 'Merged']);
    const fakeGitHub = new PathRemoteGitHub();
    const REPO = { owner: 'o', repo: 'app' };
    const held = new Set<string>();
    const pullLock = async (f: string) => (held.has(f) ? null : (held.add(f), () => { held.delete(f); }));
    // Spec and PR gates on, plan gate off (the defaults, set explicitly).
    await fileStore().updateSettingsScope('f', DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, gates: { spec: true, plan: false, pr: true } });

    const makeEngine = async () => {
      const store = fileStore();
      const engine = new Engine({
        store,
        git: new BareRemoteGit(root),
        githubFor: () => fakeGitHub,
        factories: async () => new FactoryConfig(await store.listFactoryDefs(), await store.listFactoryRepos()),
        exec: shellExec,
        now: () => new Date(),
        mode: 'session',
        claimant: 'me',
      });
      return { engine, store };
    };
    const saved = process.env.FACTORY_ROOT;
    process.env.FACTORY_ROOT = root;
    try {
      let out: string[] = [];
      let err: string[] = [];
      const go = async (...argv: string[]) => {
        out = [];
        err = [];
        const code = await run(['--store', 'file', ...argv], { out: (s) => out.push(s), err: (s) => err.push(s) }, makeEngine,
          { githubBoardFor: () => board, githubFor: () => fakeGitHub, pullLock });
        expect(code, [...out, ...err].join('\n')).toBe(0);
        return out.join('\n');
      };
      let n = 0;
      const file = (text: string) => {
        const f = join(tmp, `reply-${n++}.txt`);
        writeFileSync(f, text);
        return f;
      };
      const ticket = async () => JSON.parse(await go('next', '--json')) as { step: string; worktree: string; context: { feedback?: string } };
      const status = async () => (await board.listItems(info))[0]!.status;
      const task = async () => (await fileStore().getTask('T-1'))!;
      const comment = (body: string, author: string) => board.addComment(REPO, 1, body, author);

      // 1. A hand-made issue in Todo becomes a task.
      const made = await board.createIssue(REPO, { title: 'Hand made', body: 'Please add a widget.', labels: ['factory'] });
      const item = await board.addToProject(info, made.nodeId);
      await board.setStatus(info, item, 'Todo');
      let t = await ticket();
      expect(err.join('\n')).toContain('T-1 created from o/app#1 (ready)');
      expect(t.step).toBe('spec');
      expect(board.issue(REPO, 1).body).toMatch(/<!-- tsf:task=T-1 factory=f -->$/);

      // 2. The spec is posted as a comment.
      await go('complete', 'T-1', 'spec', '--reply', file(reply({ status: 'done', summary: 's' }, '# Spec\nv1')));
      expect(board.issue(REPO, 1).comments[0]!.body).toMatch(/^## Spec v1/);
      expect(board.issue(REPO, 1).comments[0]!.body).toContain('/approve');
      expect(await status()).toBe('In progress');

      // 3. Only an approver counts; /changes sends the spec back, /approve moves on.
      await comment('/approve', 'someone-else');
      const changes = await comment('/changes add tests', 'octo-user');
      t = await ticket();
      expect(t.step).toBe('spec');
      expect(t.context.feedback).toBe('add tests');
      expect(board.reactions).toEqual([{ commentId: changes.id, content: '+1' }]);
      await go('complete', 'T-1', 'spec', '--reply', file(reply({ status: 'done', summary: 's' }, '# Spec\nv2')));
      expect(board.issue(REPO, 1).comments.some((c) => c.body.startsWith('## Spec v2'))).toBe(true);
      await comment('/approve', 'octo-user');
      expect((await ticket()).step).toBe('plan');

      // 4. Plan, build, check, verify, review, ship.
      await go('complete', 'T-1', 'plan', '--reply', file(reply({ status: 'done', summary: 's' }, '# Plan')));
      t = await ticket();
      expect(t.step).toBe('build');
      writeFileSync(join(t.worktree, 'hello.txt'), 'hello');
      git(t.worktree, 'add', '.');
      git(t.worktree, 'commit', '-q', '-m', 'add hello');
      await go('complete', 'T-1', 'build', '--result', file(result({ status: 'done', summary: 's' })));
      expect((await ticket()).step).toBe('check');
      await go('check', 'T-1');
      expect((await ticket()).step).toBe('verify');
      await go('complete', 'T-1', 'verify', '--reply', file(reply({ status: 'done', summary: 's', verdict: 'pass' }, '# Verify')));
      expect((await ticket()).step).toBe('review');
      await go('complete', 'T-1', 'review', '--reply', file(reply({ status: 'done', summary: 's', verdict: 'approve' }, '# Review')));
      expect((await ticket()).step).toBe('ship');
      await go('ship', 'T-1');
      expect((await task()).status).toBe('pr_open');
      const [prUrl, pr] = [...fakeGitHub.prs][0]!;
      expect(pr.base).toBe('dev');
      expect(await status()).toBe('In review');
      expect((await task()).prUrl).toBe(prUrl);
      expect(fakeGitHub.bodies[0]).toContain('Closes #1');

      // 5. An approved review is recorded; the protected base waits for the owner's merge.
      fakeGitHub.addReview(prUrl, { author: 'octo-user', state: 'approved' });
      await go('next');
      expect((await fileStore().listApprovals('T-1')).some((a) => a.gate === 'pr' && a.decision === 'approve')).toBe(true);
      expect((await task()).status).toBe('pr_open');

      // 6. The merge closes the issue (Closes #1) before the engine sees it; the task is done, not cancelled.
      fakeGitHub.setState(prUrl, 'merged');
      await board.closeIssue(REPO, 1, 'completed');
      await go('next');
      expect((await task()).status).toBe('done');
      const synced = await go('sync');
      expect(await status()).toBe('Merged');
      expect(synced).toContain('pulled: created 0, applied 0, not applied 0, failed 0');
    } finally {
      if (saved === undefined) delete process.env.FACTORY_ROOT; else process.env.FACTORY_ROOT = saved;
    }
  });
});
