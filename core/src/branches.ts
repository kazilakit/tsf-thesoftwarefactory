// Pure branch rules (no Node API): gates.ts needs isProtected.
export const PROTECTED_BRANCHES = ['dev', 'stg', 'main'] as const;

export class ProtectedBranchError extends Error {
  constructor(public readonly branch: string) {
    super(`push to ${branch} refused (protected branch)`);
    this.name = 'ProtectedBranchError';
  }
}

/**
 * True when the ref names a protected branch (`refs/heads/`, `refs/remotes/origin/`, `remotes/origin/` and `origin/` prefixes
 * are ignored). `main` always counts, whatever the list says.
 */
export function isProtected(ref: string, protectedBranches: readonly string[] = PROTECTED_BRANCHES): boolean {
  const name = ref.replace(/^refs\/heads\//, '').replace(/^(?:refs\/)?remotes\/origin\//, '').replace(/^origin\//, '');
  return name === 'main' || protectedBranches.includes(name);
}

/** A base or branch name as typed: trimmed, lowercased, without a `refs/heads/` or `origin/` prefix. */
export function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

/** True when the ref names `main` in any form (`Main`, `origin/main`, `refs/heads/main`). `main` is never a task base. */
export function isMainRef(ref: string): boolean {
  return normalizeRef(ref) === 'main';
}

export function assertPushAllowed(branch: string, protectedBranches: readonly string[] = PROTECTED_BRANCHES): void {
  if (isProtected(branch, protectedBranches)) throw new ProtectedBranchError(branch);
}

/** Task branch name: `factory/<taskId>-<slug>`, slug lowercase a-z0-9- and at most 40 chars. */
export function branchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `factory/${taskId}-${slug}`;
}
