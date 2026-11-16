import { execFile } from 'node:child_process';
import { DEFAULT_GH_USER, NO_GH_LOGIN_HINT } from './validated.js';

/** `stdin`, when given, is written to the child's standard input (never put it on the command line). */
export type ExecFile = (file: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Real implementation: never rejects on a non-zero exit, returns the code instead. */
export const realExecFile: ExecFile = (file, args, stdin) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (r: { code: number; stdout: string; stderr: string }) => {
      if (!settled) { settled = true; resolve(r); }
    };
    const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      done({ code, stdout, stderr });
    });
    // A spawn failure or a closed pipe (EPIPE) resolves with a failure code instead of crashing the process.
    child.on('error', () => done({ code: 1, stdout: '', stderr: '' }));
    child.stdin?.on('error', () => done({ code: 1, stdout: '', stderr: '' }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export class SecretMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretMissingError';
  }
}

/** A factory's gh login is not logged in on this machine (no token from `gh auth token`). */
export class GhLoginMissingError extends SecretMissingError {
  constructor(public readonly user: string) {
    super(user === DEFAULT_GH_USER ? NO_GH_LOGIN_HINT : `gh account ${user} is not logged in (run: gh auth login)`);
    this.name = 'GhLoginMissingError';
  }
}

/** Reads the GitHub token of a gh CLI login (`gh auth token`). Error messages never include command output. */
export async function readGhToken(user: string, exec: ExecFile = realExecFile): Promise<string> {
  if (user === DEFAULT_GH_USER) throw new GhLoginMissingError(user);
  const { code, stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com', '--user', user]);
  const token = stdout.trim();
  if (code !== 0 || !token) throw new GhLoginMissingError(user);
  return token;
}

/**
 * The gh CLI logins on github.com whose state is `success`, lower-cased, from `gh auth status --json hosts` (no token is
 * read). Empty when gh fails or prints something unreadable, so every login counts as not logged in.
 */
export async function ghLoggedInUsers(exec: ExecFile = realExecFile): Promise<Set<string>> {
  const users = new Set<string>();
  try {
    const { code, stdout } = await exec('gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
    if (code !== 0) return users;
    const accounts = (JSON.parse(stdout) as { hosts?: Record<string, unknown> } | null)?.hosts?.['github.com'];
    if (!Array.isArray(accounts)) return users;
    for (const a of accounts as Array<{ login?: unknown; state?: unknown } | null>) {
      if (typeof a?.login === 'string' && a.state === 'success') users.add(a.login.toLowerCase());
    }
  } catch {
    users.clear();
  }
  return users;
}

/** True when `ghUser` is among `users` (from `ghLoggedInUsers`), ignoring case. */
export const isGhLoggedIn = (users: ReadonlySet<string>, ghUser: string): boolean => users.has(ghUser.toLowerCase());
