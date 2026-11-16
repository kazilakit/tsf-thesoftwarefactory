import { describe, expect, it } from 'vitest';
import { createsCycle, DEP_FINISHED, normalizeDeps, unfinishedDeps } from '../src/dependencies.js';
import type { Status } from '../src/types.js';

const ALL: Status[] = [
  'inbox', 'ready', 'spec', 'spec_review', 'plan', 'plan_review', 'build',
  'verify', 'review', 'pr_open', 'done', 'blocked', 'cancelled',
];

describe('DEP_FINISHED', () => {
  it('is exactly pr_open, done and cancelled', () => {
    expect([...DEP_FINISHED].sort()).toEqual(['cancelled', 'done', 'pr_open']);
  });
});

describe('unfinishedDeps', () => {
  it.each(ALL)('reports a dependency in status %s unless it is finished', (status) => {
    const tasks = [{ taskId: 'T-1', status }];
    const expected = DEP_FINISHED.has(status) ? [] : ['T-1'];
    expect(unfinishedDeps({ dependsOn: ['T-1'] }, tasks)).toEqual(expected);
  });

  it('does not report an id with no stored task', () => {
    expect(unfinishedDeps({ dependsOn: ['T-9'] }, [])).toEqual([]);
  });

  it('follows the order of dependsOn', () => {
    const tasks = [
      { taskId: 'T-1', status: 'build' as Status },
      { taskId: 'T-2', status: 'ready' as Status },
      { taskId: 'T-3', status: 'done' as Status },
    ];
    expect(unfinishedDeps({ dependsOn: ['T-2', 'T-3', 'T-1'] }, tasks)).toEqual(['T-2', 'T-1']);
  });
});

describe('normalizeDeps', () => {
  it('dedupes and sorts by task number', () => {
    expect(normalizeDeps(['T-10', 'T-2', 'T-2'])).toEqual(['T-2', 'T-10']);
  });
});

describe('createsCycle', () => {
  it('is true for a self dependency', () => {
    expect(createsCycle('T-1', ['T-1'], [])).toBe(true);
  });

  it('is true when the stored task already depends back', () => {
    const tasks = [
      { taskId: 'T-1', dependsOn: ['T-2'] },
      { taskId: 'T-2', dependsOn: [] },
    ];
    expect(createsCycle('T-2', ['T-1'], tasks)).toBe(true);
  });

  it('is true for a longer chain back to the task', () => {
    const tasks = [
      { taskId: 'T-1', dependsOn: [] },
      { taskId: 'T-2', dependsOn: ['T-1'] },
      { taskId: 'T-3', dependsOn: ['T-2'] },
    ];
    expect(createsCycle('T-1', ['T-3'], tasks)).toBe(true);
  });

  it('is false for a diamond', () => {
    const tasks = [
      { taskId: 'T-1', dependsOn: [] },
      { taskId: 'T-2', dependsOn: ['T-1'] },
      { taskId: 'T-3', dependsOn: ['T-1'] },
      { taskId: 'T-4', dependsOn: ['T-2', 'T-3'] },
    ];
    expect(createsCycle('T-4', ['T-2', 'T-3'], tasks)).toBe(false);
    expect(createsCycle('T-5', ['T-4'], tasks)).toBe(false);
  });
});
