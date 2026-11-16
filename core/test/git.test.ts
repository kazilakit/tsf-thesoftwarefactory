import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ProtectedBranchError } from '../src/branchGuard.js';
import { LocalGitRepos } from '../src/git.js';
import type { FactoryRepo } from '../src/factories.js';
import { repoFixture } from './factoryFixtures.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();

describe('LocalGitRepos', () => {
  let tmp: string;
  let root: string;
  let bare: string;
  let cfg: FactoryRepo;
  let repos: LocalGitRepos;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gitrepos-'));
    bare = join(tmp, 'remote.git');
    root = join(tmp, 'factory');
    const seed = join(tmp, 'seed');
    git(tmp, 'init', '--bare', '-b', 'dev', bare);
    git(tmp, 'clone', bare, seed);
    git(seed, 'checkout', '-b', 'dev');
    git(seed, 'commit', '--allow-empty', '-m', 'init');
    git(seed, 'push', 'origin', 'dev');
    cfg = repoFixture('blocks', 'os', { remote: bare });
    repos = new LocalGitRepos(root);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test('ensureClone is idempotent and installs an executable hook', async () => {
    const a = await repos.ensureClone('blocks', cfg, ['dev', 'main']);
    const b = await repos.ensureClone('blocks', cfg, ['dev', 'main']);
    expect(a).toBe(join(root, '.clones', 'blocks', 'os'));
    expect(b).toBe(a);
    const hook = join(a, '.git', 'hooks', 'pre-push');
    expect(existsSync(hook)).toBe(true);
    accessSync(hook, constants.X_OK);
  });

  test('ensureClone writes the factory list the hook reads, and a changed list is rewritten', async () => {
    const clone = await repos.ensureClone('lists', repoFixture('lists', 'api', { remote: bare }), ['rel', 'main']);
    const file = join(clone, '.git', 'factory-protected-branches');
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual(['rel', 'main']);
    await repos.ensureClone('lists', repoFixture('lists', 'api', { remote: bare }), ['dev', 'main']);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual(['dev', 'main']);
  });

  test('the same repo id in two factories gets two clones', async () => {
    const api = repoFixture('a', 'api', { remote: bare });
    const a = await repos.ensureClone('a', api, ['main']);
    const b = await repos.ensureClone('b', { ...api, factoryId: 'b' }, ['main']);
    expect(a).toBe(join(root, '.clones', 'a', 'api'));
    expect(b).toBe(join(root, '.clones', 'b', 'api'));
    expect(existsSync(join(a, '.git'))).toBe(true);
    expect(existsSync(join(b, '.git'))).toBe(true);
  });

  test('clone passes the remote after -- so git never reads it as an option (M4)', async () => {
    const marker = join(tmp, 'upload-pack-ran');
    const r = new LocalGitRepos(join(tmp, 'dashes'));
    const err = await r.ensureClone('d', repoFixture('d', 'api', { remote: `--upload-pack=touch ${marker}` }), ['main']).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('git clone -- --upload-pack=');
    expect(existsSync(marker)).toBe(false);
  });

  describe('a clone whose origin is not the repo\'s remote (M4)', () => {
    let other: string;
    const MISMATCH = 'clone moved/api points at a different remote; remove it to re-clone';
    beforeAll(() => {
      other = join(tmp, 'other.git');
      git(tmp, 'clone', '--bare', bare, other);
    });

    test('ensureClone refuses it and leaves origin as it was', async () => {
      const api = repoFixture('moved', 'api', { remote: bare });
      const clone = await repos.ensureClone('moved', api, ['main']);
      await expect(repos.ensureClone('moved', { ...api, remote: other }, ['main'])).rejects.toThrow(MISMATCH);
      expect(git(clone, 'remote', 'get-url', 'origin').trim()).toBe(bare);
    });

    test('a reused worktree of that clone is refused too, so nothing is pushed to the old remote', async () => {
      const api = repoFixture('moved', 'api', { remote: bare });
      await repos.worktree('moved', api, 'T-40', 'factory/T-40-x', ['main']);
      await expect(repos.worktree('moved', { ...api, remote: other }, 'T-40', 'factory/T-40-x', ['main'])).rejects.toThrow(MISMATCH);
      expect(await repos.worktree('moved', api, 'T-40', 'factory/T-40-x', ['main'])).toBe(join(root, '.clones', 'worktrees', 'T-40'));
    });
  });

  test('worktree branches from origin/dev and is reused', async () => {
    const branch = 'factory/T-1-x';
    const wt = await repos.worktree('blocks', cfg, 'T-1', branch, ['dev', 'main']);
    expect(wt).toBe(join(root, '.clones', 'worktrees', 'T-1'));
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(git(wt, 'rev-parse', 'origin/dev').trim());
    expect(await repos.worktree('blocks', cfg, 'T-1', branch, ['dev', 'main'])).toBe(wt);
  });

  test('a reused worktree folder that is empty, even inside another repo, is refused before any write', async () => {
    const outer = join(tmp, 'outer');
    git(tmp, 'init', outer);
    const wtDir = join(outer, '.clones', 'worktrees', 'T-9');
    mkdirSync(wtDir, { recursive: true });
    const r = new LocalGitRepos(outer);
    await expect(r.worktree('blocks', cfg, 'T-9', 'factory/T-9-z', ['dev', 'main'])).rejects.toThrow(`worktree ${wtDir} is not a valid worktree`);
    expect(existsSync(join(outer, '.git', 'factory-protected-branches'))).toBe(false);
  });

  test('worktree reuses an existing local branch when its worktree folder is gone', async () => {
    const branch = 'factory/T-2-y';
    const wt = await repos.worktree('blocks', cfg, 'T-2', branch, ['dev', 'main']);
    git(wt, 'commit', '--allow-empty', '-m', 'kept work');
    const head = git(wt, 'rev-parse', 'HEAD').trim();
    rmSync(wt, { recursive: true, force: true }); // the folder was deleted; git still lists the worktree
    const again = await repos.worktree('blocks', cfg, 'T-2', branch, ['dev', 'main']);
    expect(again).toBe(wt);
    expect(git(again, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(git(again, 'rev-parse', 'HEAD').trim()).toBe(head);
  });

  test('isClean reflects uncommitted files', async () => {
    const wt = await repos.worktree('blocks', cfg, 'T-1', 'factory/T-1-x', ['dev', 'main']);
    expect(await repos.isClean(wt)).toBe(true);
    writeFileSync(join(wt, 'f.txt'), 'x');
    expect(await repos.isClean(wt)).toBe(false);
    rmSync(join(wt, 'f.txt'));
  });

  test('push publishes a task branch, refuses dev', async () => {
    const wt = await repos.worktree('blocks', cfg, 'T-1', 'factory/T-1-x', ['dev', 'main']);
    git(wt, 'commit', '--allow-empty', '-m', 'work');
    await repos.push(wt, 'factory/T-1-x');
    expect(git(tmp, 'ls-remote', bare, 'refs/heads/factory/T-1-x')).toContain('refs/heads/factory/T-1-x');
    const before = git(tmp, 'ls-remote', bare, 'refs/heads/dev');
    await expect(repos.push(wt, 'dev')).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(git(tmp, 'ls-remote', bare, 'refs/heads/dev')).toBe(before);
  });

  test('hook still guards when pushing a protected refspec via git directly with global hooksPath ignored', async () => {
    const wt = await repos.worktree('blocks', cfg, 'T-1', 'factory/T-1-x', ['dev', 'main']);
    expect(() =>
      execFileSync('git', ['-c', `core.hooksPath=${join(root, '.clones', 'blocks', 'os', '.git', 'hooks')}`, 'push', 'origin', 'HEAD:refs/heads/dev'], { cwd: wt, stdio: 'pipe' }),
    ).toThrow();
  });

  describe('git identity', () => {
    const OTHER = { ...process.env };
    let home: string;
    const globalConfig = () => execFileSync('git', ['config', '--global', '--list'], { env: { ...process.env, HOME: home }, stdio: 'pipe' }).toString();

    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), 'home-'));
      writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Owner\n\temail = owner@example.com\n');
      process.env.HOME = home;
      process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
    });
    afterAll(() => {
      process.env.HOME = OTHER.HOME;
      if (OTHER.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = OTHER.GIT_CONFIG_GLOBAL;
      rmSync(home, { recursive: true, force: true });
    });

    test('a factory identity is set on the worktree only; the global config is untouched', async () => {
      const before = globalConfig();
      const api = repoFixture('ident', 'api', { remote: bare });
      const identity = { gitName: 'Factory A', gitEmail: 'a@example.com' };
      const wt = await repos.worktree('ident', api, 'T-10', 'factory/T-10-x', ['dev', 'main'], identity);
      const read = (key: string) => execFileSync('git', ['config', '--worktree', key], { cwd: wt, stdio: 'pipe' }).toString().trim();
      expect(read('user.email')).toBe('a@example.com');
      expect(read('user.name')).toBe('Factory A');
      const clone = join(root, '.clones', 'ident', 'api');
      expect(execFileSync('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: clone, stdio: 'pipe' }).toString().trim()).toBe('true');
      const another = await repos.worktree('ident', api, 'T-11', 'factory/T-11-x', ['dev', 'main'], { gitName: '', gitEmail: 'b@example.com' });
      expect(execFileSync('git', ['config', '--worktree', 'user.email'], { cwd: another, stdio: 'pipe' }).toString().trim()).toBe('b@example.com');
      expect(read('user.email')).toBe('a@example.com');
      expect(globalConfig()).toBe(before);
    });

    test('on reuse a changed identity is rewritten, a cleared one is unset, and the list is refreshed', async () => {
      const api = repoFixture('reuse', 'api', { remote: bare });
      const read = (wt: string, key: string) => {
        try { return execFileSync('git', ['config', '--worktree', key], { cwd: wt, stdio: 'pipe' }).toString().trim(); } catch { return ''; }
      };
      const wt = await repos.worktree('reuse', api, 'T-20', 'factory/T-20-x', ['dev', 'main'], { gitName: 'N', gitEmail: 'one@example.com' });
      expect(read(wt, 'user.email')).toBe('one@example.com');
      await repos.worktree('reuse', api, 'T-20', 'factory/T-20-x', ['rel', 'main'], { gitName: 'N', gitEmail: 'two@example.com' });
      expect(read(wt, 'user.email')).toBe('two@example.com');
      expect(readFileSync(join(root, '.clones', 'reuse', 'api', '.git', 'factory-protected-branches'), 'utf8')).toBe('rel\nmain\n');
      await repos.worktree('reuse', api, 'T-20', 'factory/T-20-x', ['rel', 'main'], { gitName: '', gitEmail: '' });
      expect(read(wt, 'user.email')).toBe('');
      expect(read(wt, 'user.name')).toBe('');
    });

    test('reuse of a worktree whose clone is in the old layout writes into that clone, not .clones/<f>/<r>', async () => {
      const old = join(root, '.clones', 'oldrepo');
      git(root, 'clone', bare, old);
      const wt = join(root, '.clones', 'worktrees', 'T-30');
      git(old, 'worktree', 'add', '-b', 'factory/T-30-x', wt, 'origin/dev');
      const api = repoFixture('newf', 'api', { remote: bare });
      expect(existsSync(join(root, '.clones', 'newf'))).toBe(false);
      expect(await repos.worktree('newf', api, 'T-30', 'factory/T-30-x', ['rel', 'main'], { gitName: 'O', gitEmail: 'old@example.com' })).toBe(wt);
      expect(readFileSync(join(old, '.git', 'factory-protected-branches'), 'utf8')).toBe('rel\nmain\n');
      expect(execFileSync('git', ['config', '--worktree', 'user.email'], { cwd: wt, stdio: 'pipe' }).toString().trim()).toBe('old@example.com');
      expect(existsSync(join(root, '.clones', 'newf'))).toBe(false);
    });

    test('without an identity nothing is written and worktreeConfig stays off', async () => {
      const wt = await repos.worktree('plain', repoFixture('plain', 'api', { remote: bare }), 'T-12', 'factory/T-12-x', ['dev', 'main'], { gitName: '', gitEmail: '' });
      expect(existsSync(join(wt, '.git'))).toBe(true);
      const clone = join(root, '.clones', 'plain', 'api');
      expect(() => execFileSync('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: clone, stdio: 'pipe' })).toThrow();
    });
  });
});
