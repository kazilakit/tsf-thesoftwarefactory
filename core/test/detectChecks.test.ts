import { describe, expect, test } from 'vitest';
import { normaliseChecks } from '../src/checksSchema.js';
import { detectChecks } from '../src/detectChecks.js';

const readOf = (files: Record<string, string>) => async (p: string) => files[p] ?? null;

describe('detectChecks', () => {
  test('npm with a lockfile: npm ci then the scripts that exist, in order', async () =>
    expect(await detectChecks(['package.json', 'package-lock.json'], readOf({ 'package.json': '{"scripts":{"test":"v","lint":"e","build":"b"}}' }))).toEqual([
      { name: 'install', cwd: '.', run: 'npm ci' }, { name: 'lint', cwd: '.', run: 'npm run lint', needs: 'install' },
      { name: 'test', cwd: '.', run: 'npm run test', needs: 'install' }, { name: 'build', cwd: '.', run: 'npm run build', needs: 'install' }]));

  test.each([
    ['pnpm-lock.yaml', 'pnpm i --frozen-lockfile', 'pnpm run test'],
    ['yarn.lock', 'yarn --frozen-lockfile', 'yarn test'],
    [null, 'npm install', 'npm run test'],
  ])('lockfile %s', async (lock, install, test_) =>
    expect(await detectChecks(['package.json', ...(lock ? [lock] : [])], readOf({ 'package.json': '{"scripts":{"test":"v"}}' }))).toEqual([
      { name: 'install', cwd: '.', run: install }, { name: 'test', cwd: '.', run: test_, needs: 'install' }]));

  test('monorepo with server (dotnet) and client (pnpm) gets prefixed names and cwds', async () =>
    expect(await detectChecks(['server/api.csproj', 'client/package.json', 'client/pnpm-lock.yaml', 'client/src/a.ts', 'README.md'],
      readOf({ 'client/package.json': '{"scripts":{"lint":"x"}}' }))).toEqual([
      { name: 'server.build', cwd: 'server', run: 'dotnet build' }, { name: 'server.test', cwd: 'server', run: 'dotnet test', needs: 'server.build' },
      { name: 'client.install', cwd: 'client', run: 'pnpm i --frozen-lockfile' }, { name: 'client.lint', cwd: 'client', run: 'pnpm run lint', needs: 'client.install' }]));

  test.each([
    ['go.mod', 'go build ./...', 'go test ./...'], ['Cargo.toml', 'cargo build', 'cargo test'], ['api.sln', 'dotnet build', 'dotnet test'],
  ])('%s gives build then test', async (f, b, t) =>
    expect(await detectChecks([f], readOf({}))).toEqual([{ name: 'build', cwd: '.', run: b }, { name: 'test', cwd: '.', run: t, needs: 'build' }]));

  test('pytest only when mentioned; make test only when nothing else matched', async () => {
    expect(await detectChecks(['pyproject.toml'], readOf({ 'pyproject.toml': 'dependencies = ["pytest"]' }))).toEqual([{ name: 'test', cwd: '.', run: 'pytest' }]);
    expect(await detectChecks(['requirements.txt'], readOf({ 'requirements.txt': 'flask' }))).toEqual([]);
    expect(await detectChecks(['Makefile'], readOf({ Makefile: 'build:\n\tx\ntest:\n\ty\n' }))).toEqual([{ name: 'test', cwd: '.', run: 'make test' }]);
    expect(await detectChecks(['Makefile', 'go.mod'], readOf({ Makefile: 'test:\n\ty\n' }))).toHaveLength(2);
  });

  test('nothing found is an empty list; deeper folders are ignored', async () => {
    expect(await detectChecks(['README.md', 'a/b/go.mod'], readOf({}))).toEqual([]);
    expect(await detectChecks(['package.json'], readOf({ 'package.json': 'not json' }))).toEqual([]);
  });

  test('a folder with several stacks gets unique names, and needs point at the right one', async () => {
    const out = await detectChecks(['package.json', 'go.mod', 'pyproject.toml'], readOf({ 'package.json': '{"scripts":{"test":"v","build":"b"}}', 'pyproject.toml': 'pytest' }));
    expect(out.map((c) => c.name)).toEqual(['npm-install', 'npm-test', 'npm-build', 'go-build', 'go-test', 'pytest-test']);
    expect(out.find((c) => c.name === 'go-test')?.needs).toBe('go-build');
    expect(out.find((c) => c.name === 'npm-build')?.needs).toBe('npm-install');
    expect(normaliseChecks(out).ok).toBe(true);
  });

  test.each([['.config'], ['my app'], ['@scope'], ['a'.repeat(40)], ['x'.repeat(40) + ' y']])('folder %j gives valid names', async (dir) => {
    const out = await detectChecks([`${dir}/go.mod`, `${dir}/package.json`], readOf({ [`${dir}/package.json`]: '{"scripts":{"typecheck":"t"}}' }));
    expect(out.length).toBeGreaterThan(0);
    expect(normaliseChecks(out).ok).toBe(true);
  });

  test('folders that sanitize to the same prefix or to nothing are left out', async () => {
    const out = await detectChecks(['my app/go.mod', 'my-app/go.mod', '...//x'], readOf({}));
    expect(out.map((c) => c.cwd)).toEqual(['my app', 'my app']);
    expect(await detectChecks(['@@/go.mod'], readOf({}))).toEqual([]);
  });
});
