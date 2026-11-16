// Task dependency rules. Pure: no Node-only API, no credential.
import type { Status, Task } from './types.js';

/** Statuses that count as finished for a dependency. */
export const DEP_FINISHED: ReadonlySet<Status> = new Set<Status>(['pr_open', 'done', 'cancelled']);

/** Ids in `task.dependsOn` order whose stored task exists and is not finished. */
export function unfinishedDeps(task: Pick<Task, 'dependsOn'>, tasks: readonly Pick<Task, 'taskId' | 'status'>[]): string[] {
  const statusById = new Map(tasks.map((t) => [t.taskId, t.status] as const));
  return task.dependsOn.filter((id) => {
    const status = statusById.get(id);
    return status !== undefined && !DEP_FINISHED.has(status);
  });
}

/** Task number of an id like `T-12`; unparseable ids give 0. Mirrors engine.ts. */
const taskNum = (id: string): number => Number(id.slice(id.indexOf('-') + 1)) || 0;

/** Dedupe, then sort by task number (ties and unparseable ids by string). */
export function normalizeDeps(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => taskNum(a) - taskNum(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * True when following `dependsOn` from `dependsOn` reaches `taskId`. Other tasks use their
 * stored lists; `taskId` uses the given list. Iterative DFS with a visited set.
 */
export function createsCycle(
  taskId: string,
  dependsOn: readonly string[],
  tasks: readonly Pick<Task, 'taskId' | 'dependsOn'>[],
): boolean {
  const depsById = new Map(tasks.map((t) => [t.taskId, t.dependsOn] as const));
  depsById.set(taskId, [...dependsOn]);
  const visited = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === taskId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of depsById.get(id) ?? []) stack.push(next);
  }
  return false;
}
