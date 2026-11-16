import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { GhLoginMissingError, SecretMissingError, type ExecFile } from '../src/secrets.js';
import { FakeGitHub } from '../src/github.js';
import { FakeGitHubBoard, type GitHubBoard } from '../src/githubBoard.js';
import { lazyGitHubBoardFor, lazyGitHubFor, wire } from '../src/wire.js';

describe('findRoot', () => {
  const makeRoot = async (manifest: string | null) => {
    const { mkdtempSync, mkdirSync, realpathSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'findroot-')));
    mkdirSync(join(root, 'core', 'src'), { recursive: true });
    writeFileSync(join(root, 'core', 'package.json'), '{}');
    mkdirSync(join(root, 'plugin', '.claude-plugin'), { recursive: true });
    if (manifest !== null) writeFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), manifest);
    return { root, join };
  };
  test('a root has core/package.json and the factory plugin manifest; repos/ is not needed', async () => {
    const { findRoot } = await import('../src/wire.js');
    const { root, join } = await makeRoot('{"name":"factory"}');
    expect(findRoot(join(root, 'core', 'src'), {})).toBe(root);
  });
  test.each([
    ['no manifest', null],
    ['a manifest named something else', '{"name":"other"}'],
    ['a malformed manifest', '{not json'],
  ])('%s is not a root', async (_label, manifest) => {
    const { findRoot } = await import('../src/wire.js');
    const { root, join } = await makeRoot(manifest);
    expect(() => findRoot(join(root, 'core', 'src'), {})).toThrow(/factory root not found/);
  });
  test('FACTORY_ROOT still wins first', async () => {
    const { findRoot } = await import('../src/wire.js');
    expect(findRoot('/', { FACTORY_ROOT: '/some/where' })).toBe('/some/where');
  });
});

describe('lazyGitHubFor', () => {
  test('reads no secret until a call, then once per account, and one client per account', async () => {
    const reads: string[] = [];
    const made: string[] = [];
    const githubFor = lazyGitHubFor(async (acct) => { reads.push(acct); return `pat-${acct}`; }, (pat) => { made.push(pat); return new FakeGitHub(); });
    const a = githubFor('user-a');
    expect(githubFor('user-a')).toBe(a);
    expect(githubFor('user-b')).not.toBe(a);
    expect(reads).toEqual([]);
    await a.prState('https://github.com/o/r/pull/1').catch(() => undefined);
    await a.prState('https://github.com/o/r/pull/1').catch(() => undefined);
    expect(reads).toEqual(['user-a']);
    expect(made).toEqual(['pat-user-a']);
  });

  test('a 401 makes the next call read the token again; a 500 does not', async () => {
    const failFirst = (status: number) => {
      let first = true;
      return () => {
        const fake = new FakeGitHub();
        fake.prState = async () => {
          if (first) { first = false; throw Object.assign(new Error('Bad credentials'), { status }); }
          return 'open';
        };
        return fake;
      };
    };
    for (const [status, reads] of [[401, 2], [500, 1]] as const) {
      let n = 0;
      const client = lazyGitHubFor(async () => `pat-${++n}`, failFirst(status))('u');
      await expect(client.prState('https://github.com/o/r/pull/1')).rejects.toThrow('Bad credentials');
      await client.prState('https://github.com/o/r/pull/1').catch(() => undefined);
      expect(n).toBe(reads);
    }
  });

  test('a 401 on the board client also resets the token', async () => {
    let n = 0;
    const board = lazyGitHubBoardFor(async () => `pat-${++n}`, () => ({
      tokenScopes: async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }); },
    }) as unknown as GitHubBoard)('u');
    await expect(board.tokenScopes()).rejects.toThrow('Bad credentials');
    await board.tokenScopes().catch(() => undefined);
    expect(n).toBe(2);
  });

  test('a missing login becomes GhLoginMissingError with the gh text (R16)', async () => {
    const githubFor = lazyGitHubFor(async () => { throw new SecretMissingError('x not found'); }, () => new FakeGitHub());
    const err = await githubFor('user-a').ensureReady!().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhLoginMissingError);
    expect(err).toMatchObject({ user: 'user-a', message: 'gh account user-a is not logged in (run: gh auth login)' });
  });

  test('by default it reads the token of the factory login with gh auth token (R16)', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFile = async (file, args) => { calls.push([file, args]); return { code: 0, stdout: 'tok\n', stderr: '' }; };
    const made: string[] = [];
    const githubFor = lazyGitHubFor(undefined, (tok) => { made.push(tok); return new FakeGitHub(); }, exec);
    await githubFor('octocat').ensureReady!();
    expect(calls).toEqual([['gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'octocat']]]);
    expect(made).toEqual(['tok']);
  });

  test('blocks-credential is just a name now: no Keychain read, no reservation (R16)', async () => {
    const calls: string[] = [];
    const exec: ExecFile = async (file) => { calls.push(file); return { code: 1, stdout: '', stderr: '' }; };
    const githubFor = lazyGitHubFor(undefined, () => new FakeGitHub(), exec);
    const err = await githubFor('blocks-credential').ensureReady!().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhLoginMissingError);
    expect(calls).toEqual(['gh']);
  });

  test('a failed read is not cached', async () => {
    const read = vi.fn<(acct: string) => Promise<string>>().mockRejectedValueOnce(new Error('missing')).mockResolvedValue('t');
    const a = lazyGitHubFor(read, () => new FakeGitHub())('x');
    await expect(a.prState('https://github.com/o/r/pull/1')).rejects.toThrow('missing');
    await expect(a.prState('https://github.com/o/r/pull/1')).rejects.toThrow('unknown pull request');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('lazyGitHubBoardFor', () => {
  test('reads the token once per login, on the first call, with one client per login', async () => {
    const reads: string[] = [];
    const made: string[] = [];
    const boardFor = lazyGitHubBoardFor(async (u) => { reads.push(u); return `tok-${u}`; }, (tok) => { made.push(tok); return new FakeGitHubBoard(); });
    const a = boardFor('user-a');
    expect(boardFor('user-a')).toBe(a);
    expect(boardFor('user-b')).not.toBe(a);
    expect(reads).toEqual([]);
    await Promise.all([a.tokenScopes(), a.tokenScopes()]);
    await a.labelExists({ owner: 'o', repo: 'r' }, 'factory');
    expect(reads).toEqual(['user-a']);
    expect(made).toEqual(['tok-user-a']);
  });

  test('a missing login rejects with GhLoginMissingError and is read again on the next call', async () => {
    const read = vi.fn<(u: string) => Promise<string>>().mockRejectedValueOnce(new SecretMissingError('x not found')).mockResolvedValue('t');
    const b = lazyGitHubBoardFor(read, () => new FakeGitHubBoard())('user-a');
    const err = await b.tokenScopes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhLoginMissingError);
    expect(err).toMatchObject({ user: 'user-a' });
    await expect(b.tokenScopes()).resolves.toEqual(['repo', 'project']);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('wire local store path', () => {
  test('an absolute FACTORY_STORE_LOCAL_PATH holds board.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wire-root-'));
    const custom = join(mkdtempSync(join(tmpdir(), 'wire-store-')), 'data');
    const prev = process.env.FACTORY_STORE_LOCAL_PATH;
    process.env.FACTORY_STORE_LOCAL_PATH = custom;
    try {
      const { store } = await wire({ root, mode: 'session' });
      await store.setSettings(await store.getSettings());
      expect(existsSync(join(custom, 'board.json'))).toBe(true);
      expect(existsSync(join(root, '.factory', 'board.json'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_STORE_LOCAL_PATH; else process.env.FACTORY_STORE_LOCAL_PATH = prev;
    }
  });
});
