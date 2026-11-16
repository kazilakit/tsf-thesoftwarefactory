import type { Status } from './types.js';

// What was last pushed to GitHub for a task. Pure (no Node API).

/** The values the last successful push wrote to GitHub. */
export interface PushedState {
  status: Status | null; option: string | null; title: string | null; bodyHash: string | null; label: string | null;
  docs: { spec: number; plan: number }; blocked: string | null; closed: boolean;
  /** `createdAt` of the comments the pusher posted, so pull reads only later replies. */
  docAt: { spec: string | null; plan: string | null }; blockedAt: string | null;
}

/** One task's link to its GitHub issue and Project item, with the last pushed state. */
export interface GitHubLink {
  taskId: string; factoryId: string;
  /** "owner/repo" of the issue's repo. */
  repo: string;
  issueNumber: number | null; issueNodeId: string | null;
  /** "owner/number" of the Project the item is on. */
  project: string | null; itemId: string | null;
  pushed: PushedState;
  error: { message: string; attempts: number; nextAttemptAt: string } | null;
  lease: { by: string; until: string } | null;
  /** Edits already reported as not applied (at most 20, oldest dropped). */
  reported: string[];
  version: number;
}

export const emptyPushed = (): PushedState => ({
  status: null, option: null, title: null, bodyHash: null, label: null, docs: { spec: 0, plan: 0 }, blocked: null, closed: false,
  docAt: { spec: null, plan: null }, blockedAt: null,
});

/** The link with every field stage 2 did not have filled in, so older saved links load. */
export const withLinkDefaults = (l: GitHubLink): GitHubLink => ({ ...l, pushed: { ...emptyPushed(), ...l.pushed }, reported: l.reported ?? [] });
