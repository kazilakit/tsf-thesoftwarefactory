import type { FactoryEvent, Task } from './types.js';

const FIELDS = ['status', 'stage', 'branch', 'prUrl', 'attempt', 'blockedReason', 'question', 'answer', 'claimBy', 'costUsd'] as const;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function diffEvents(before: Task, after: Task, actor: string, reason: string, at: string): FactoryEvent[] {
  const events: FactoryEvent[] = [];
  for (const field of FIELDS) {
    if (before[field] === after[field]) continue;
    events.push({
      taskId: after.taskId,
      factoryId: after.factoryId,
      actor,
      action: field === 'status' ? 'move' : 'set',
      field,
      from: str(before[field]),
      to: str(after[field]),
      reason,
      at,
    });
  }
  return events;
}
