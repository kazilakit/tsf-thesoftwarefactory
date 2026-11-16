import { describe, expect, test } from 'vitest';
import { GhLoginMissingError, ghLoggedInUsers, isGhLoggedIn, readGhToken, SecretMissingError, type ExecFile } from '../src/secrets.js';

describe('readGhToken', () => {
  test('asks gh for the named account on github.com and trims the newline', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFile = async (file, args) => {
      calls.push([file, args]);
      return { code: 0, stdout: 'gho_abc\n', stderr: '' };
    };
    expect(await readGhToken('octo-user', exec)).toBe('gho_abc');
    const unset = await readGhToken('(not set)', exec).catch((e: unknown) => e);
    expect((unset as Error).message).toBe('no GitHub login is set for this factory (run: ./factory init)');
    expect(calls).toHaveLength(1);
    expect(calls).toEqual([['gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'octo-user']]]);
  });

  test('a failed or empty gh answer rejects with the exact message and leaks no output', async () => {
    for (const r of [{ code: 1, stdout: 'SECRET-LEAK', stderr: 'SECRET-LEAK' }, { code: 0, stdout: '\n', stderr: '' }]) {
      const err = await readGhToken('octo-user', async () => r).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SecretMissingError);
      expect((err as Error).message).toBe('gh account octo-user is not logged in (run: gh auth login)');
      expect((err as Error).message).not.toContain('SECRET-LEAK');
    }
  });
});

describe('GhLoginMissingError', () => {
  test('is a SecretMissingError naming the login, with the readGhToken text (R16)', () => {
    const e = new GhLoginMissingError('octocat');
    expect(e).toBeInstanceOf(SecretMissingError);
    expect(e.user).toBe('octocat');
    expect(e.name).toBe('GhLoginMissingError');
    expect(e.message).toBe('gh account octocat is not logged in (run: gh auth login)');
  });

  test('readGhToken rejects with it', async () => {
    const err = await readGhToken('octocat', async () => ({ code: 1, stdout: '', stderr: '' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhLoginMissingError);
    expect(err).toMatchObject({ user: 'octocat' });
  });
});

describe('ghLoggedInUsers', () => {
  test('lists the github.com logins in state success, lower-cased, from gh auth status (R16)', async () => {
    const calls: Array<[string, string[]]> = [];
    const stdout = JSON.stringify({ hosts: { 'github.com': [{ login: 'Octo-User', state: 'success' }, { login: 'other', state: 'timeout' }, null] } });
    const users = await ghLoggedInUsers(async (file, args) => { calls.push([file, args]); return { code: 0, stdout, stderr: '' }; });
    expect(calls).toEqual([['gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']]]);
    expect([...users]).toEqual(['octo-user']);
    expect(isGhLoggedIn(users, 'OCTO-user')).toBe(true);
    expect(isGhLoggedIn(users, 'other')).toBe(false);
  });

  test('a gh that cannot be run is an empty list, not an error', async () => {
    expect((await ghLoggedInUsers(async () => { throw new Error('spawn gh ENOENT'); })).size).toBe(0);
  });
});
