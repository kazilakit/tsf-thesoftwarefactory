import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { localStoreDir, storeDirPath, parseStoreKind } from '../src/storeSelect.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'store-select-'));

describe('parseStoreKind', () => {
  test.each([['local'], ['file']])('parseStoreKind(%s) is the file store', (v) => {
    expect(parseStoreKind(v)).toBe('file');
  });
  test.each([['factory-app'], ['blocks']])('parseStoreKind(%s) is refused by name: that store is not in this build', (v) => {
    expect(() => parseStoreKind(v)).toThrow(`--store ${v}: the factory-app store is not part of this build; use local`);
  });
  test('anything else throws', () => {
    expect(() => parseStoreKind('nope')).toThrow('--store must be local (or file)');
    expect(() => parseStoreKind('')).toThrow('--store must be local (or file)');
  });
});

describe('localStoreDir', () => {
  test('defaults to <root>/.factory, created', () => {
    const root = tmp();
    expect(localStoreDir(root, {})).toBe(join(root, '.factory'));
    expect(existsSync(join(root, '.factory'))).toBe(true);
    expect(localStoreDir(root, { FACTORY_STORE_LOCAL_PATH: '' })).toBe(join(root, '.factory'));
  });
  test('a relative FACTORY_STORE_LOCAL_PATH is refused; an absolute one is created', () => {
    expect(() => localStoreDir(tmp(), { FACTORY_STORE_LOCAL_PATH: 'rel/dir' })).toThrow('FACTORY_STORE_LOCAL_PATH must be an absolute path');
    const abs = join(tmp(), 'a', 'b');
    expect(localStoreDir(tmp(), { FACTORY_STORE_LOCAL_PATH: abs })).toBe(abs);
    expect(existsSync(abs)).toBe(true);
  });
});

describe('storeDirPath', () => {
  test('resolves the same folder without creating it', () => {
    const root = tmp();
    expect(storeDirPath(root, {})).toBe(join(root, '.factory'));
    expect(existsSync(join(root, '.factory'))).toBe(false);
    const abs = join(tmp(), 'x');
    expect(storeDirPath(root, { FACTORY_STORE_LOCAL_PATH: abs })).toBe(abs);
    expect(existsSync(abs)).toBe(false);
    expect(() => storeDirPath(root, { FACTORY_STORE_LOCAL_PATH: 'rel' })).toThrow('FACTORY_STORE_LOCAL_PATH must be an absolute path');
  });
});
