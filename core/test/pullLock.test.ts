import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fileLock } from '../src/pullLock.js';

describe('fileLock', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'factory-lock-'));

  test('acquires, is held for a second taker, and is free after release', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    const release = await lock('f');
    expect(release).not.toBeNull();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(true);
    expect(await lock('f')).toBeNull();
    expect(await lock('g')).not.toBeNull();
    release!();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(false);
    expect(await lock('f')).not.toBeNull();
  });

  test('takes a lock older than 120 s', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    await lock('f');
    const old = new Date(Date.now() - 121_000);
    utimesSync(join(root, '.factory', 'pull-f.lock'), old, old);
    expect(await lock('f')).not.toBeNull();
  });

  test('a fresh lock is not stale', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    await lock('f');
    const recent = new Date(Date.now() - 100_000);
    utimesSync(join(root, '.factory', 'pull-f.lock'), recent, recent);
    expect(await lock('f')).toBeNull();
  });
});

describe('fileLock races', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'factory-lock-'));
  const aged = (root: string) => { const old = new Date(Date.now() - 121_000); utimesSync(join(root, '.factory', 'pull-f.lock'), old, old); };

  test('two takers on one stale lock: exactly one gets it', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    await lock('f');
    aged(root);
    const got = await Promise.all([lock('f'), lock('f')]);
    expect(got.filter((r) => r !== null)).toHaveLength(1);
  });

  test('release after another holder took over does not delete the new lock', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    const first = await lock('f');
    aged(root);
    const second = await lock('f');
    expect(second).not.toBeNull();
    first!();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(true);
    expect(await lock('f')).toBeNull();
    second!();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(false);
  });

  test('a takeover leaves no stray files behind', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    await lock('f');
    aged(root);
    (await lock('f'))!();
    expect(readdirSync(join(root, '.factory'))).toEqual([]);
  });
});

describe('fileLock held probe and heartbeat', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'factory-lock-'));
  const file = (root: string) => join(root, '.factory', 'pull-f.lock');
  const age = (root: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(file(root), t, t); };

  test('held is true only while a non-stale lock file exists, and never takes the lock', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    expect(lock.held('f')).toBe(false);
    const release = await lock('f');
    expect(lock.held('f')).toBe(true);
    expect(lock.held('g')).toBe(false);
    age(root, 121_000);
    expect(lock.held('f')).toBe(false);
    expect(existsSync(file(root))).toBe(true);
    age(root, 0);
    release!();
    expect(lock.held('f')).toBe(false);
    expect(readdirSync(join(root, '.factory'))).toEqual([]);
  });

  test('touch refreshes the lock so a long pull is not taken over as stale', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    const release = await lock('f');
    age(root, 100_000);
    expect(release!.touch!()).toBe(true);
    expect(Date.now() - statSync(file(root)).mtimeMs).toBeLessThan(5_000);
    expect(await lock('f')).toBeNull();
  });

  test('touch after another holder took over leaves the new lock alone', async () => {
    const root = dir();
    const lock = fileLock(() => join(root, '.factory'));
    const first = await lock('f');
    age(root, 121_000);
    const second = await lock('f');
    expect(second).not.toBeNull();
    age(root, 50_000);
    const before = statSync(file(root)).mtimeMs;
    expect(first!.touch!()).toBe(false);
    expect(statSync(file(root)).mtimeMs).toBe(before);
  });
});

describe('fileLock store dir', () => {
  test('the pull lock lives in the store dir', async () => {
    const storeDir = join(mkdtempSync(join(tmpdir(), 'factory-lock-')), 'custom', 'store');
    const lock = fileLock(() => storeDir);
    const release = await lock('f');
    expect(existsSync(join(storeDir, 'pull-f.lock'))).toBe(true);
    expect(lock.held('f')).toBe(true);
    release!();
    expect(existsSync(join(storeDir, 'pull-f.lock'))).toBe(false);
  });
});
