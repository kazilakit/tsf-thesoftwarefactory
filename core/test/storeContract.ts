import { describe, expect, test } from 'vitest';
import { ForbiddenError, NotFoundError, OwnerOnlyError, VersionConflictError, type BoardStore, type StoreIdentity } from '../src/store.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { defFixture, repoFixture } from './factoryFixtures.js';

/**
 * Behaviour every BoardStore must share. Assertions follow the interface, not one store's internals.
 * `make(identity)` builds a store for the owner or the core; with none, one that checks nothing.
 */
export function runStoreContract(
  name: string, make: (identity?: StoreIdentity) => BoardStore | Promise<BoardStore>,
): void {
  const mk = (s: BoardStore, title = 'a') => s.createTask({ factoryId: 'blocks', title, description: '', repo: 'data' });

  describe(`${name} (store contract)`, () => {
    test('createTask assigns T-1, T-2 with defaults', async () => {
      const s = await make();
      const a = await mk(s);
      const b = await mk(s, 'b');
      expect([a.taskId, b.taskId]).toEqual(['T-1', 'T-2']);
      expect(a).toMatchObject({ baseBranch: 'dev', status: 'inbox', stage: null, attempt: 0, gateOverrides: {}, dependsOn: [], costUsd: 0, version: 1, claimBy: null });
      expect(await s.getTask('T-1')).toEqual(a);
      expect((await s.listTasks()).map((t) => t.taskId)).toEqual(['T-1', 'T-2']);
    });
    test('dependsOn defaults to [], is stored as given, and updates round-trip', async () => {
      const s = await make();
      const a = await mk(s);
      expect(a.dependsOn).toEqual([]);
      const b = await s.createTask({ factoryId: 'blocks', title: 'b', description: '', repo: 'data', dependsOn: ['T-1'] });
      expect((await s.getTask(b.taskId)).dependsOn).toEqual(['T-1']);
      const u = await s.updateTask(a.taskId, 1, { dependsOn: ['T-2'] });
      expect(u.dependsOn).toEqual(['T-2']);
      expect((await s.getTask(a.taskId)).dependsOn).toEqual(['T-2']);
    });
    test('createTask with status ready inserts a ready task; the default is inbox', async () => {
      const s = await make();
      const r = await s.createTask({ factoryId: 'blocks', title: 'r', description: '', repo: 'data', status: 'ready' });
      const i = await s.createTask({ factoryId: 'blocks', title: 'i', description: '', repo: 'data', status: 'inbox' });
      expect([r.status, i.status]).toEqual(['ready', 'inbox']);
      expect((await s.getTask(r.taskId)).status).toBe('ready');
    });
    test('createTask refuses a start status other than inbox or ready', async () => {
      const s = await make();
      for (const status of ['done', 'blocked', 'cancelled']) {
        await expect(s.createTask({ factoryId: 'blocks', title: 'x', description: '', repo: 'data', status } as never)).rejects.toThrow('a new task starts in inbox or ready');
      }
      expect(await s.listTasks()).toEqual([]);
    });
    test('getTask throws NotFoundError', async () => {
      await expect((await make()).getTask('T-9')).rejects.toBeInstanceOf(NotFoundError);
    });
    test('updateTask bumps version; stale version throws', async () => {
      const s = await make();
      const t = await mk(s);
      const u = await s.updateTask(t.taskId, 1, { status: 'ready' });
      expect(u.version).toBe(2);
      expect(u.status).toBe('ready');
      await expect(s.updateTask(t.taskId, 1, { status: 'spec' })).rejects.toBeInstanceOf(VersionConflictError);
    });
    test('updateTask on a missing task throws NotFoundError', async () => {
      await expect((await make()).updateTask('T-9', 1, { status: 'ready' })).rejects.toBeInstanceOf(NotFoundError);
    });
    test('updateTask round-trips every field type', async () => {
      const s = await make();
      const t = await mk(s);
      const patch = {
        stage: 'build' as const, branch: 'b', prUrl: null, attempt: 2, gateOverrides: { spec: false }, costUsd: 0.1 + 0.2,
        claimBy: 'w', claimUntil: '2026-01-01T00:00:00.000Z',
      };
      const u = await s.updateTask(t.taskId, 1, patch);
      expect(u).toMatchObject(patch);
      expect(await s.getTask(t.taskId)).toEqual(u);
    });
    test('updateTask clears nullable fields with null', async () => {
      const s = await make();
      const t = await mk(s);
      const set = { stage: 'build' as const, branch: 'b', prUrl: 'u', blockedReason: 'r', question: 'q', answer: 'a', claimBy: 'w', claimUntil: '2026-01-01T00:00:00.000Z' };
      const u = await s.updateTask(t.taskId, 1, set);
      const cleared = Object.fromEntries(Object.keys(set).map((k) => [k, null]));
      expect(await s.updateTask(t.taskId, u.version, cleared)).toMatchObject(cleared);
      expect(await s.getTask(t.taskId)).toMatchObject(cleared);
    });
    test('updateTask rejects taskId/version in patch', async () => {
      const s = await make();
      const t = await mk(s);
      await expect(s.updateTask(t.taskId, 1, { version: 9 })).rejects.toThrow();
    });
    test('returned tasks are copies', async () => {
      const s = await make();
      const t = await mk(s);
      t.title = 'x';
      expect((await s.getTask('T-1')).title).toBe('a');
    });
    test('addDoc versions and supersedes', async () => {
      const s = await make();
      const d1 = await s.addDoc('T-1', 'spec', 'one', 'me');
      const d2 = await s.addDoc('T-1', 'spec', 'two', 'me');
      expect([d1.version, d2.version]).toEqual([1, 2]);
      expect(await s.currentDoc('T-1', 'spec')).toEqual({ taskId: 'T-1', kind: 'spec', version: 2, body: 'two', author: 'me', status: 'current' });
      expect(await s.currentDoc('T-1', 'plan')).toBeUndefined();
    });
    test('listDocs lists every version ascending; only the highest is current', async () => {
      const s = await make();
      await s.addDoc('T-1', 'spec', 'one', 'me');
      await s.addDoc('T-1', 'plan', 'p', 'me');
      await s.addDoc('T-1', 'spec', 'two', 'you');
      await s.addDoc('T-2', 'spec', 'other', 'me');
      expect(await s.listDocs('T-1', 'spec')).toEqual([
        { taskId: 'T-1', kind: 'spec', version: 1, body: 'one', author: 'me', status: 'superseded' },
        { taskId: 'T-1', kind: 'spec', version: 2, body: 'two', author: 'you', status: 'current' },
      ]);
      expect(await s.listDocs('T-1', 'review')).toEqual([]);
    });
    test('approvals get a timestamp', async () => {
      const s = await make();
      const a = await s.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
      expect(a.at).toMatch(/^\d{4}-/);
      expect(await s.listApprovals('T-1')).toEqual([a]);
      expect(await s.listApprovals('T-2')).toHaveLength(0);
    });
    test('addApproval with the same approvalId twice records one approval', async () => {
      const s = await make();
      const a = { taskId: 'T-1', gate: 'spec' as const, docVersion: 1, decision: 'approve' as const, comment: '', approvalId: 'x-1' };
      const first = await s.addApproval(a);
      expect(first).not.toHaveProperty('approvalId');
      expect(await s.addApproval(a)).toEqual(first);
      expect(await s.listApprovals('T-1')).toEqual([first]);
    });
    test('empty store settings are defaults', async () => {
      expect(await (await make()).getSettings()).toEqual({ factories: {} });
    });
    test('setSettings roundtrip', async () => {
      const s = await make();
      const stored = { factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } } };
      await s.setSettings(stored);
      expect(await s.getSettings()).toEqual(stored);
      const next = { factories: { blocks: { factory: { ...DEFAULT_SETTINGS, maxParallel: 4 }, repos: { os: { gates: { pr: false } } } } } };
      await s.setSettings(next);
      expect(await s.getSettings()).toEqual(next);
    });
    test('updateSettingsScope writes only its scope; null removes a repo scope', async () => {
      const s = await make();
      await s.updateSettingsScope('blocks/data', undefined, { maxParallel: 1 });
      await s.updateSettingsScope('blocks/os', undefined, { gates: { pr: false } });
      expect(await s.getSettings()).toEqual({
        factories: { blocks: { factory: DEFAULT_SETTINGS, repos: { data: { maxParallel: 1 }, os: { gates: { pr: false } } } } },
      });
      await s.updateSettingsScope('blocks', DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, paused: true });
      // `before` compares as canonical JSON: key order does not matter.
      await s.updateSettingsScope('blocks/os', { gates: { pr: false } }, { gates: { pr: false }, paused: true });
      await s.updateSettingsScope('blocks/data', { maxParallel: 1 }, null);
      expect(await s.getSettings()).toEqual({
        factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { os: { gates: { pr: false }, paused: true } } } },
      });
      const reordered = { paused: true, gates: { spec: true, pr: true, plan: false }, maxCostPerTaskUsd: 5, maxTurnsPerStage: 60, maxParallel: 2 };
      await s.updateSettingsScope('blocks', reordered, DEFAULT_SETTINGS);
      expect((await s.getSettings()).factories.blocks!.factory).toEqual(DEFAULT_SETTINGS);
    });
    test('updateSettingsScope refuses a lost update and keeps the first write', async () => {
      const s = await make();
      await s.updateSettingsScope('blocks', DEFAULT_SETTINGS, DEFAULT_SETTINGS);
      const a = (await s.getSettings()).factories.blocks!;
      const b = (await s.getSettings()).factories.blocks!;
      await s.updateSettingsScope('blocks/data', a.repos.data, { maxParallel: 2 });
      await expect(s.updateSettingsScope('blocks/data', b.repos.data, { maxParallel: 3 })).rejects.toBeInstanceOf(VersionConflictError);
      await s.updateSettingsScope('blocks', a.factory, { ...a.factory, maxParallel: 4 });
      await expect(s.updateSettingsScope('blocks', b.factory, { ...b.factory, paused: true })).rejects.toBeInstanceOf(VersionConflictError);
      // Another scope read in the same old snapshot is not a conflict.
      await s.updateSettingsScope('blocks/os', b.repos.os, { paused: true });
      expect(await s.getSettings()).toEqual({
        factories: { blocks: { factory: { ...DEFAULT_SETTINGS, maxParallel: 4 }, repos: { data: { maxParallel: 2 }, os: { paused: true } } } },
      });
      await expect(s.updateSettingsScope('blocks/data', undefined, null)).rejects.toBeInstanceOf(VersionConflictError);
      expect((await s.getSettings()).factories.blocks!.repos.data).toEqual({ maxParallel: 2 });
    });
    // Run ids are store-specific (MemoryStore: R-<n>), so only the returned id is used.
    test('runs: start, open, finish', async () => {
      const s = await make();
      const r = await s.startRun({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer' });
      expect(r).toMatchObject({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer', endedAt: null, result: null, turns: null, costUsd: null });
      expect(r.runId).toMatch(/^R-/);
      expect(await s.openRun('T-1', 'build')).toEqual(r);
      expect(await s.openRun('T-1', 'spec')).toBeUndefined();
      await s.finishRun(r.runId, { result: 'done', turns: 3, costUsd: 0.5 });
      expect(await s.openRun('T-1', 'build')).toBeUndefined();
    });
    test('listRuns lists a task\'s runs by start time, finished ones too', async () => {
      const s = await make();
      const a = await s.startRun({ taskId: 'T-1', step: 'spec', mode: 'sdk', agent: 'spec-writer' });
      await new Promise((r) => setTimeout(r, 5));
      const other = await s.startRun({ taskId: 'T-2', step: 'spec', mode: 'sdk', agent: 'spec-writer' });
      await new Promise((r) => setTimeout(r, 5));
      const b = await s.startRun({ taskId: 'T-1', step: 'plan', mode: 'loop', agent: 'planner' });
      await s.finishRun(a.runId, { result: 'done', turns: 4, costUsd: 0.25 });
      const runs = await s.listRuns('T-1');
      expect(runs.map((r) => r.runId)).toEqual([a.runId, b.runId]);
      expect(runs[0]).toMatchObject({ step: 'spec', result: 'done', turns: 4, costUsd: 0.25 });
      expect(runs[0]!.endedAt).toMatch(/^\d{4}-/);
      expect(runs[1]).toEqual(b);
      expect((await s.listRuns('T-2')).map((r) => r.runId)).toEqual([other.runId]);
      expect(await s.listRuns('T-3')).toEqual([]);
    });
    test('finishRun on a missing run throws NotFoundError', async () => {
      await expect((await make()).finishRun('R-missing', { result: 'done', turns: null, costUsd: null })).rejects.toBeInstanceOf(NotFoundError);
    });
    test('events append and filter', async () => {
      const s = await make();
      const e = { factoryId: 'blocks', actor: 'x', action: 'set' as const, field: 'stage', from: null, to: 'a', reason: '', at: 't' };
      await s.addEvents([{ taskId: 'T-1', ...e }, { taskId: 'T-2', ...e }]);
      expect(await s.listEvents()).toHaveLength(2);
      expect(await s.listEvents('T-2')).toEqual([{ taskId: 'T-2', ...e }]);
    });

    describe('factories', () => {
      const def = defFixture('delta');
      const repo = repoFixture('delta', 'api');

      test('an owner saves a def and lists it back; a stale before is a VersionConflictError', async () => {
        const s = await make('owner');
        const stored = await s.saveFactoryDef(null, def);
        expect(stored).toEqual({ ...def, version: 1 });
        expect(await s.listFactoryDefs()).toEqual([stored]);
        const renamed = await s.saveFactoryDef(stored, { ...stored, name: 'Delta 2' });
        expect(renamed).toMatchObject({ name: 'Delta 2', version: 2 });
        await expect(s.saveFactoryDef(stored, { ...stored, name: 'Delta 3' })).rejects.toBeInstanceOf(VersionConflictError);
        await expect(s.saveFactoryDef(null, def)).rejects.toBeInstanceOf(VersionConflictError);
        expect(await s.listFactoryDefs()).toEqual([renamed]);
      });
      test('a def with agentModels round-trips', async () => {
        const s = await make('owner');
        const withModels = defFixture('delta', { agentModels: { build: 'sonnet' } });
        await s.saveFactoryDef(null, withModels);
        expect(await s.listFactoryDefs()).toEqual([{ ...withModels, version: 1 }]);
      });
      test('an owner saves a repo with the same compare-and-set; listFactoryRepos filters by factory', async () => {
        const s = await make('owner');
        const api = await s.saveFactoryRepo(null, repo);
        const other = await s.saveFactoryRepo(null, repoFixture('mods', 'api'));
        expect((await s.listFactoryRepos('delta')).map((r) => `${r.factoryId}/${r.repoId}`)).toEqual(['delta/api']);
        expect(await s.listFactoryRepos()).toHaveLength(2);
        expect(other.factoryId).toBe('mods');
        const next = await s.saveFactoryRepo(api, { ...api, baseBranch: 'stg' });
        expect(next).toMatchObject({ baseBranch: 'stg', version: 2 });
        await expect(s.saveFactoryRepo(api, { ...api, baseBranch: 'x' })).rejects.toBeInstanceOf(VersionConflictError);
      });
      test('the core may not save a def or a repo', async () => {
        const s = await make('core');
        await expect(s.saveFactoryDef(null, def)).rejects.toBeInstanceOf(OwnerOnlyError);
        await expect(s.saveFactoryRepo(null, repo)).rejects.toBeInstanceOf(OwnerOnlyError);
        expect(await s.listFactoryDefs()).toEqual([]);
      });
      test('health is set by the core and listed; the owner may not set it', async () => {
        const core = await make('core');
        const h = { factoryId: 'delta', ghLoggedIn: true, checkedAt: '2026-11-10T00:00:00.000Z' };
        await core.setFactoryHealth(h);
        await core.setFactoryHealth({ ...h, ghLoggedIn: false });
        expect(await core.listFactoryHealth()).toEqual([{ ...h, ghLoggedIn: false }]);
        await expect((await make('owner')).setFactoryHealth(h)).rejects.toBeInstanceOf(ForbiddenError);
      });
      test('tasks in two factories with the same repo id keep their factoryId', async () => {
        const s = await make();
        const a = await s.createTask({ factoryId: 'delta', title: 'a', description: '', repo: 'api' });
        const b = await s.createTask({ factoryId: 'mods', title: 'b', description: '', repo: 'api' });
        expect((await s.listTasks()).map((t) => [t.taskId, t.factoryId, t.repo])).toEqual([['T-1', 'delta', 'api'], ['T-2', 'mods', 'api']]);
        expect((await s.getTask(b.taskId)).factoryId).toBe('mods');
        expect(a.factoryId).toBe('delta');
      });
      test('updateSettingsScope on a repo scope changes only that scope', async () => {
        const s = await make();
        await s.updateSettingsScope('delta/api', undefined, { maxParallel: 1 });
        await s.updateSettingsScope('mods/api', undefined, { maxParallel: 3 });
        expect(await s.getSettings()).toEqual({
          factories: {
            delta: { factory: DEFAULT_SETTINGS, repos: { api: { maxParallel: 1 } } },
            mods: { factory: DEFAULT_SETTINGS, repos: { api: { maxParallel: 3 } } },
          },
        });
        await s.updateSettingsScope('delta', DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, paused: true });
        expect((await s.getSettings()).factories.mods!.factory).toEqual(DEFAULT_SETTINGS);
      });
      test('events keep their factoryId', async () => {
        const s = await make();
        const e = { taskId: '-', factoryId: 'delta', actor: 'you', action: 'set' as const, field: 'def.name', from: 'a', to: 'b', reason: '', at: 't' };
        await s.addEvents([e]);
        expect(await s.listEvents()).toEqual([e]);
      });
    });
  });
}
