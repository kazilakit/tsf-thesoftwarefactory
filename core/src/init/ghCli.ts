// The gh CLI calls the wizard needs. Logins only: no token is read here.
import { spawn } from 'node:child_process';
import { realExecFile, type ExecFile } from '../secrets.js';

export interface GhCli {
  /** The github.com logins gh holds with a working token, as gh spells them. */
  logins(): Promise<string[]>;
  /** `gh auth login`, interactive; resolves when gh exits. */
  login(): Promise<void>;
  /** `gh auth refresh -s project` for this login, interactive. */
  refreshProjectScope(login: string): Promise<void>;
}

/** Runs gh with the terminal attached; resolves with its exit code. */
export type RunInteractive = (args: string[]) => Promise<number>;

const runInherit: RunInteractive = (args) =>
  new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });

const HOST = ['--hostname', 'github.com'];

interface Accounts { logins: string[]; active: string | null }

/** Logins from `gh auth status --json hosts` whose state is success, and the active one; empty when gh fails or prints something unreadable. */
async function readAccounts(exec: ExecFile): Promise<Accounts> {
  const none: Accounts = { logins: [], active: null };
  try {
    const { code, stdout } = await exec('gh', ['auth', 'status', ...HOST, '--json', 'hosts']);
    if (code !== 0) return none;
    const accounts = (JSON.parse(stdout) as { hosts?: Record<string, unknown> } | null)?.hosts?.['github.com'];
    if (!Array.isArray(accounts)) return none;
    const out: Accounts = { logins: [], active: null };
    for (const a of accounts as Array<{ login?: unknown; state?: unknown; active?: unknown } | null>) {
      if (typeof a?.login === 'string' && a.state === 'success' && !out.logins.includes(a.login)) out.logins.push(a.login);
      if (typeof a?.login === 'string' && a.active === true) out.active = a.login;
    }
    return out;
  } catch {
    return none;
  }
}

const readLogins = async (exec: ExecFile): Promise<string[]> => (await readAccounts(exec)).logins;

/**
 * The real gh. Login and refresh run with stdio inherited. When gh has several logins and another one is active, the
 * refresh switches to the login first and back to the previously active account afterwards, also when the refresh fails.
 */
export function realGhCli(exec: ExecFile = realExecFile, run: RunInteractive = runInherit): GhCli {
  return {
    logins: () => readLogins(exec),
    async login() {
      await run(['auth', 'login', ...HOST]);
    },
    async refreshProjectScope(login) {
      const { logins, active } = await readAccounts(exec);
      const refresh = () => run(['auth', 'refresh', ...HOST, '-s', 'project']);
      if (logins.length <= 1 || active === login) return void (await refresh());
      await exec('gh', ['auth', 'switch', ...HOST, '--user', login]);
      try {
        await refresh();
      } finally {
        if (active !== null) await exec('gh', ['auth', 'switch', ...HOST, '--user', active]);
      }
    },
  };
}
