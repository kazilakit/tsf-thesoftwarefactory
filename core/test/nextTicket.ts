import type { Engine } from '../src/engine.js';
import type { Ticket } from '../src/engine.js';

/** `engine.next(...)` as a ticket, or null when nothing was claimed. */
export async function nextTicket(engine: Engine, taskId?: string, filter?: string[]): Promise<Ticket | null> {
  const o = await engine.next(taskId, filter);
  return o.kind === 'ticket' ? o.ticket : null;
}
