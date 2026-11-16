import type { FactoryDef, FactoryRepo } from '../src/factories.js';

export const checksFixture = [
  { name: 'server.build', cwd: 'server', run: 'b' },
  { name: 'server.test', cwd: 'server', run: 't', needs: 'server.build' },
  { name: 'client.install', cwd: 'client', run: 'i' },
  { name: 'client.typecheck', cwd: 'client', run: 'tc', needs: 'client.install' },
  { name: 'client.lint', cwd: 'client', run: 'l', needs: 'client.install' },
  { name: 'client.test', cwd: 'client', run: 't', needs: 'client.install' },
];

export const defFixture = (factoryId: string, over: Partial<FactoryDef> = {}): FactoryDef => ({
  factoryId, name: factoryId, protectedBranches: ['dev', 'stg', 'main'], gitName: 'Factory', gitEmail: 'factory@example.com',
  docsPath: '/docs', ghUser: `gh-${factoryId}`, active: true, version: 1, ...over,
});

export const repoFixture = (factoryId: string, repoId: string, over: Partial<FactoryRepo> = {}): FactoryRepo => ({
  factoryId, repoId, remote: `git@github.com:org/${repoId}.git`, baseBranch: 'dev', checks: structuredClone(checksFixture) as never, version: 1, ...over,
});

/** One factory with the given repos, as the `factories` option of a store. */
export const seed = (factoryId = 'blocks', repos: string[] = ['data', 'iam', 'os']) => ({
  defs: [defFixture(factoryId)], repos: repos.map((r) => repoFixture(factoryId, r)),
});
