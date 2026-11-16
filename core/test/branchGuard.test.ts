import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  HOOK_PATH,
  ProtectedBranchError,
  assertPushAllowed,
  branchName,
  isMainRef,
  isProtected,
  normalizeRef,
} from '../src/branchGuard.js';
import { loadRepoConfig } from '../src/repoConfig.js';

const REPOS = fileURLToPath(new URL('./fixtures/repos', import.meta.url));

describe('branch guard', () => {
  test.each(['os', 'iam', 'monitor', 'logic', 'data', 'localization', 'release'].map((id) => loadRepoConfig(REPOS, id)))('$repo: protected branches refused', (cfg) => {
    for (const b of [cfg.baseBranch, 'stg', 'main', 'refs/heads/main', 'origin/dev'])
      expect(() => assertPushAllowed(b)).toThrow(ProtectedBranchError);
    expect(() => assertPushAllowed(branchName('T-12', 'Add retry to export'))).not.toThrow();
  });

  test('look-alike names are not protected', () => {
    expect(isProtected('dev2')).toBe(false);
    expect(isProtected('feature/main')).toBe(false);
  });

  test('remote-tracking ref forms are protected', () => {
    expect(isProtected('refs/remotes/origin/main')).toBe(true);
    expect(isProtected('remotes/origin/stg')).toBe(true);
    expect(isProtected('refs/remotes/origin/factory/T-1-x')).toBe(false);
  });

  test('normalizeRef trims, lowercases and drops refs/heads/ and origin/', () => {
    expect(normalizeRef(' Refs/Heads/Feature/X ')).toBe('feature/x');
    expect(normalizeRef('ORIGIN/dev')).toBe('dev');
  });

  test.each(['main', ' Main ', 'origin/main', 'refs/heads/main', 'ORIGIN/MAIN'])('isMainRef(%j) is true', (ref) => {
    expect(isMainRef(ref)).toBe(true);
  });

  test.each(['dev', 'feature/main', 'main2', ''])('isMainRef(%j) is false', (ref) => {
    expect(isMainRef(ref)).toBe(false);
  });

  test('branchName', () => {
    expect(branchName('T-12', 'Add retry: to Export!!')).toBe('factory/T-12-add-retry-to-export');
    expect(branchName('T-1', 'x'.repeat(80))).toHaveLength('factory/T-1-'.length + 40);
    expect(branchName('T-2', `${'a'.repeat(39)} b`)).toBe(`factory/T-2-${'a'.repeat(39)}`);
  });
});

describe('pre-push hook', () => {
  let root: string;
  let clone: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hook-'));
    const bare = join(root, 'bare.git');
    clone = join(root, 'clone');
    git(root, 'init', '--bare', bare);
    git(root, 'clone', bare, clone);
    git(clone, 'commit', '--allow-empty', '-m', 'init');
    mkdirSync(join(clone, '.git', 'hooks'), { recursive: true });
    copyFileSync(HOOK_PATH, join(clone, '.git', 'hooks', 'pre-push'));
    execFileSync('chmod', ['+x', join(clone, '.git', 'hooks', 'pre-push')]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const push = (ref: string) =>
    spawnSync('git', ['-c', 'core.hooksPath=.git/hooks', 'push', 'origin', `HEAD:refs/heads/${ref}`], {
      cwd: clone,
      encoding: 'utf8',
    });

  test.each(['dev', 'stg', 'main'])('refuses %s', (b) => {
    const r = push(b);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`factory: push to ${b} refused`);
  });

  test('allows task branches', () => {
    expect(push('factory/T-1-x').status).toBe(0);
  });

  describe('with the factory list file', () => {
    const file = () => join(clone, '.git', 'factory-protected-branches');
    afterEach(() => rmSync(file(), { force: true }));

    test('refuses the listed branches and main, allows dev', () => {
      writeFileSync(file(), 'rel\n');
      for (const b of ['rel', 'main']) {
        const r = push(b);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain(`factory: push to ${b} refused`);
      }
      expect(push('dev').status).toBe(0);
    });

    test('an unreadable list fails closed to dev, stg and main', () => {
      git(clone, 'commit', '--allow-empty', '-m', 'new work'); // else git skips the hook as up to date
      writeFileSync(file(), 'rel\n');
      chmodSync(file(), 0o000);
      try {
        for (const b of ['dev', 'stg', 'main']) {
          const r = push(b);
          expect(r.status, b).not.toBe(0);
          expect(r.stderr).toContain(`factory: push to ${b} refused`);
        }
      } finally {
        chmodSync(file(), 0o600);
      }
    });

    test('reads the file from a worktree through the common dir', () => {
      writeFileSync(file(), 'rel\n');
      const wt = join(root, 'wt');
      git(clone, 'worktree', 'add', '-b', 'task', wt);
      const r = spawnSync('git', ['-c', `core.hooksPath=${join(clone, '.git', 'hooks')}`, 'push', 'origin', 'HEAD:refs/heads/rel'], { cwd: wt, encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('factory: push to rel refused');
    });
  });
});
