import { CLAIM_MS } from './defaults.js';
import { updateHeld, VersionConflictError, type BoardStore } from './store.js';
import type { Task } from './types.js';

export function claimExpired(t: Task, now: Date): boolean {
  return t.claimUntil === null || new Date(t.claimUntil).getTime() <= now.getTime();
}

const until = (now: Date) => new Date(now.getTime() + CLAIM_MS).toISOString();

async function tryUpdate(store: BoardStore, t: Task, patch: Partial<Task>): Promise<Task | null> {
  try {
    return await updateHeld(store, t, patch);
  } catch (e) {
    if (e instanceof VersionConflictError) return null;
    throw e;
  }
}

export async function claim(store: BoardStore, t: Task, claimant: string, now: Date): Promise<Task | null> {
  if (t.claimBy !== null && t.claimBy !== claimant && !claimExpired(t, now)) return null;
  return tryUpdate(store, t, { claimBy: claimant, claimUntil: until(now) });
}

export function release(store: BoardStore, t: Task): Promise<Task> {
  return updateHeld(store, t, { claimBy: null, claimUntil: null });
}

export async function renew(store: BoardStore, t: Task, claimant: string, now: Date): Promise<Task | null> {
  if (t.claimBy !== claimant) return null;
  return tryUpdate(store, t, { claimUntil: until(now) });
}
