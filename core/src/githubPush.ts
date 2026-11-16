import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ProjectRef, GitHubSettings } from './githubConfig.js';
import { emptyPushed, type GitHubLink } from './githubLink.js';
import type { Doc, Gate, Task } from './types.js';

// Pure planner (no Node API, no credential): what to do on GitHub so it matches the task.

export const markerOf = (taskId: string, factoryId: string): string => `<!-- tsf:task=${taskId} factory=${factoryId} -->`;

/** GitHub allows 65,536 characters in an issue or comment body; stay under it. */
export const MAX_BODY = 65_000;
export const TRUNCATED = '\n\n… (truncated; the full text is in tsf)';

/** `text` cut to `max` characters, with the truncation note at the end, when it is longer. */
export function capText(text: string, max: number = MAX_BODY): string {
  return text.length <= max ? text : text.slice(0, max - TRUNCATED.length) + TRUNCATED;
}

/** The description as written on GitHub: trailing space trimmed and capped to leave room for the marker. */
export function issueText(description: string, taskId: string, factoryId: string): string {
  return capText(description.trimEnd(), MAX_BODY - markerOf(taskId, factoryId).length - 2);
}

/** The issue body: the visible text, then the marker that ties the issue to its task, always last. */
export function issueBody(description: string, taskId: string, factoryId: string): string {
  const d = issueText(description, taskId, factoryId);
  const marker = markerOf(taskId, factoryId);
  return d === '' ? marker : `${d}\n\n${marker}`;
}

const MARKER_RE = /<!-- tsf:task=(\S+) factory=(\S+) -->/g;

/** A body as comparable text: CRLF to LF, every marker removed, trailing space trimmed. */
export const stripMarker = (body: string): string => body.replace(/\r\n/g, '\n').replace(MARKER_RE, '').trimEnd();

/** The last marker in a body, or null. */
export function markerIn(body: string): { taskId: string; factoryId: string } | null {
  const all = [...body.matchAll(MARKER_RE)];
  const m = all[all.length - 1];
  return m ? { taskId: m[1]!, factoryId: m[2]! } : null;
}

export const bodyHash = (description: string): string => bytesToHex(sha256(new TextEncoder().encode(description)));

export const projectKey = (p: ProjectRef): string => `${p.owner}/${p.number}`;

/** Identifies one block (reason and question); null when the task is not blocked. */
export function blockedKey(t: Task): string | null {
  return t.status === 'blocked' ? `${t.blockedReason ?? ''}\n${t.question ?? ''}` : null;
}

export type PushAction =
  | { kind: 'create'; title: string; body: string; labels: string[] }
  | { kind: 'addToProject' }
  | { kind: 'setStatus'; option: string }
  | { kind: 'addLabel'; label: string }
  | { kind: 'updateIssue'; title: string; body: string }
  | { kind: 'comment'; about: 'spec' | 'plan'; version: number; body: string }
  | { kind: 'comment'; about: 'blocked'; key: string; body: string }
  | { kind: 'close'; reason: 'completed' | 'not_planned' };

export interface PushInput {
  task: Task; link: GitHubLink | undefined; settings: GitHubSettings; docs: { spec?: Doc; plan?: Doc }; gates: Record<Gate, boolean>;
}

function docComment(kind: 'spec' | 'plan', doc: Doc, i: PushInput): PushAction {
  const name = kind === 'spec' ? 'Spec' : 'Plan';
  const reply = i.gates[kind] ? '\n\n---\nReply `/approve` to approve, or `/changes <what to change>` to send it back.' : '';
  const body = capText(`## ${name} v${doc.version}\n\n${doc.body}`, MAX_BODY - reply.length) + reply;
  return { kind: 'comment', about: kind, version: doc.version, body };
}

/** The ordered GitHub actions that bring the issue up to date with the task. */
export function planPush(i: PushInput): PushAction[] {
  const { task, link, settings } = i;
  const created = link?.issueNumber != null;
  const done = task.status === 'done' || task.status === 'cancelled';
  if (!created && done) return [];
  const p = { ...emptyPushed(), ...link?.pushed };
  const out: PushAction[] = [];
  const text = issueText(task.description, task.taskId, task.factoryId);
  const body = issueBody(task.description, task.taskId, task.factoryId);
  if (!created) {
    out.push({ kind: 'create', title: task.title, body, labels: settings.label === '' ? [] : [settings.label] });
    p.title = task.title; p.bodyHash = bodyHash(text); p.label = settings.label === '' ? null : settings.label;
  }
  const open = !(link?.pushed.closed ?? false);
  const readd = !created || link?.itemId == null || link.project !== projectKey(settings.project);
  if (open && readd) out.push({ kind: 'addToProject' });
  const option = settings.statusMap[task.status];
  if (open && (readd || option !== p.option)) out.push({ kind: 'setStatus', option });
  if (open && settings.label !== '' && settings.label !== p.label) out.push({ kind: 'addLabel', label: settings.label });
  if (open && (task.title !== p.title || bodyHash(text) !== p.bodyHash)) out.push({ kind: 'updateIssue', title: task.title, body });
  for (const kind of ['spec', 'plan'] as const) {
    const doc = i.docs[kind];
    if (doc && doc.version > p.docs[kind]) out.push(docComment(kind, doc, i));
  }
  const key = blockedKey(task);
  if (key !== null && key !== p.blocked) {
    let text = `**Blocked:** ${task.blockedReason ?? 'no reason given'}`;
    if (task.question) text += `\n\n**Question:** ${task.question}`;
    const reply = task.question ? '\n\nReply `/answer <text>` to answer, or `/unblock` to resume.' : '\n\nReply `/unblock` to resume.';
    text = capText(text, MAX_BODY - reply.length) + reply;
    out.push({ kind: 'comment', about: 'blocked', key, body: text });
  }
  if (done && !p.closed) out.push({ kind: 'close', reason: task.status === 'done' ? 'completed' : 'not_planned' });
  return out;
}
