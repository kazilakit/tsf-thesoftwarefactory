#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { parseAgentReply } from './agentReply.js';
import { NO_FACTORIES, UnknownFactoryError, type Engine } from './engine.js';
import { GATE_DOC } from './gates.js';
import * as owner from './owner.js';
import { ghLoggedInUsers, isGhLoggedIn, realExecFile, type ExecFile } from './secrets.js';
import { DEFAULT_GH_USER, isValidId } from './factories.js';
import { FileStore, type BoardStore } from './store.js';
import type { AgentStep, Gate, Mode, RepoId } from './types.js';
import { doctor, redactSecrets } from './doctor.js';
import { GitHubPusher, type PushResult } from './githubPusher.js';
import { GitHubPuller, type PullLock, type PullResult, type RebuildResult } from './githubPuller.js';
import { fileLock } from './pullLock.js';
import { lazyGitHubSetupFor, type GitHubSetupFor } from './githubSetup.js';
import type { GitHubFor } from './github.js';
import type { GitHubBoardFor } from './githubBoard.js';
import { localStoreDir, parseStoreKind, storeDirPath } from './storeSelect.js';
import { realGhCli } from './init/ghCli.js';
import { runInit } from './init/menu.js';
import { readlinePrompter } from './init/prompts.js';
import type { InitDeps } from './init/shared.js';
import { findRoot, lazyGitHubBoardFor, lazyGitHubFor, wire, type WireOptions } from './wire.js';

export type { WireOptions } from './wire.js';

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}
export type MakeEngine = (o: WireOptions) => Promise<{ engine: Engine; store: BoardStore }>;

class CliExit extends Error {
  constructor(
    message: string,
    public readonly code: number,
    /** Print the message as it is, without `error: `. */
    public readonly plain = false,
  ) {
    super(message);
  }
}

const STEPS = ['spec', 'plan', 'build', 'verify', 'review'];
const MODES = ['sdk', 'loop', 'session'];

function choice<T extends string>(what: string, value: string, allowed: readonly string[]): T {
  if (!allowed.includes(value)) throw new CliExit(`${what} must be one of ${allowed.join(', ')}`, 1);
  return value as T;
}

function factoryId(value: string): string {
  if (!isValidId(value)) throw new CliExit('--factory must be a factory id (lowercase letters, digits and hyphens)', 1);
  return value;
}

function repoId(what: string, value: string): RepoId {
  if (!isValidId(value)) throw new CliExit(`${what} must be a repo id (lowercase letters, digits and hyphens)`, 1);
  return value;
}

/** `--factory` as given, or the only active factory; otherwise exit 1 naming the active ones. */
async function pickFactory(store: BoardStore, given: string | undefined): Promise<string> {
  if (given !== undefined) return factoryId(given);
  const active = (await store.listFactoryDefs()).filter((d) => d.active).map((d) => d.factoryId);
  if (active.length === 1) return active[0]!;
  throw new CliExit(`--factory is required (active: ${active.join(', ') || 'none'})`, 1);
}

const collect = (v: string, prev: string[] | undefined): string[] => [...(prev ?? []), v];

function factoryFilter(ids: string[] | undefined): string[] | undefined {
  if (!ids) return undefined;
  return ids.map(factoryId);
}

export interface CliDeps {
  /** Runs `gh auth status` (the login check of `status` and `doctor`). Tests pass a fake. */
  exec?: ExecFile;
  /** GitHub client per gh login (`factory doctor`). Default: the real one over the gh logins. Tests pass a fake. */
  githubBoardFor?: GitHubBoardFor;
  /** Setup client per login (`factory doctor` repo and base branch checks). Default: the real one over the logins. Tests pass a fake. */
  githubSetupFor?: GitHubSetupFor;
  /** GitHub client per login for the pull (reviews, comments, PR state). Default: the real one over the gh logins. Tests pass a fake. */
  githubFor?: GitHubFor;
  /** One pull per factory at a time. Default: a lock file in the local store dir (`<root>/.factory/`, or FACTORY_STORE_LOCAL_PATH). Tests pass an in-memory lock. */
  pullLock?: PullLock;
  /** True while a factory's pull runs; the push then skips it. Default: the lock file's probe (none with an injected `pullLock`). */
  pullBusy?: (factoryId: string) => boolean;
  /** Waits between `factory sync --watch` passes. Default: a real timer. Tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
  /** `factory sync --watch` stops after this many passes. Default: run until SIGINT or SIGTERM. Tests set it. */
  watchTicks?: number;
  /** The `factory init` wizard. Default: the real one over the terminal. Tests pass a fake. */
  runInit?: (d: InitDeps) => Promise<number>;
}

/** The printable lines of one factory's pull: created, applied, not applied and failed items. */
function pullLines(r: PullResult): string[] {
  return [
    ...r.created.map((c) => `${c.taskId} created from ${c.issue} (${c.status})`),
    ...r.applied.map((a) => `${a.taskId} ${a.issue}: ${a.change}`),
    ...r.notApplied.map((n) => `NOT APPLIED ${n.taskId ?? '-'} ${n.issue}: ${n.change} (${n.reason})`),
    ...r.errors.map((e) => `PULL FAIL ${e.taskId ?? '-'} ${e.issue ?? '-'}: ${e.message}`),
  ];
}

const firstLine = (e: unknown): string => redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
/** Waits `ms`, or less when `wake` resolves first; the real timer is cleared either way so the process can exit. */
function waitOrWake(ms: number, wake: Promise<void>, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (sleep) return Promise.race([sleep(ms), wake]);
  let timer: NodeJS.Timeout;
  return Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), wake]).finally(() => clearTimeout(timer));
}

export async function run(argv: string[], io: IO, makeEngine: MakeEngine = (o) => wire(o), deps: CliDeps = {}): Promise<number> {
  const exec = deps.exec ?? realExecFile;
  const program = new Command();
  program
    .name('factory')
    .description('Drive the software factory engine')
    .option('--mode <mode>', 'sdk | loop | session', 'session')
    .option('--store <store>', 'local (alias file): the only store in this build', process.env.FACTORY_STORE || 'local')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.replace(/\n$/, '')), writeErr: (s) => io.err(s.replace(/\n$/, '')) });

  const open = async (cmd: Command) => {
    const g = cmd.optsWithGlobals() as { mode: string; store: string };
    const mode = choice<Mode>('--mode', g.mode, MODES);
    parseStoreKind(g.store); // refuses factory-app (and anything else) with a one-line error
    return makeEngine({ root: findRoot(), mode, log: io.err });
  };

  const boardFor = deps.githubBoardFor ?? lazyGitHubBoardFor(undefined, undefined, exec);
  const lockFile = fileLock(() => storeDirPath(findRoot()));
  const pullLock = deps.pullLock ?? lockFile;
  const pullBusy = deps.pullBusy ?? (deps.pullLock ? undefined : lockFile.held);
  const pusherFor = (store: BoardStore) =>
    new GitHubPusher({ store, boardFor, now: () => new Date(), claimant: `cli:${hostname()}`, ...(pullBusy ? { pullBusy } : {}) });
  const githubFor = deps.githubFor ?? lazyGitHubFor(undefined, undefined, exec);
  const pullerFor = (store: BoardStore) => new GitHubPuller({ store, boardFor, githubFor, now: () => new Date(), lock: pullLock });
  /** Pulls GitHub changes before `next`. Never throws and never changes the exit code; lines go to stderr so stdout stays the ticket. */
  const pullBefore = async (store: BoardStore, factories: string[] | undefined): Promise<void> => {
    try {
      for (const r of await pullerFor(store).pull(factories)) for (const l of pullLines(r)) io.err(`github: ${l}`);
    } catch (e) {
      io.err(`github: pull failed (${firstLine(e)})`);
    }
  };

  /** Pushes the touched task to GitHub (GitHub-only factories). Catches everything: prints one stderr line on failure, never changes the exit code. */
  const pushAfter = async (store: BoardStore, taskId: string): Promise<PushResult | null> => {
    try {
      const r = await pusherFor(store).pushTask(taskId);
      if (r.error !== null) io.err(`github: ${taskId} not pushed (${r.error}); factory sync retries`);
      return r;
    } catch (e) {
      io.err(`github: ${taskId} not pushed (${firstLine(e)}); factory sync retries`);
      return null;
    }
  };

  /** Pushes every GitHub-only task (next also moves other tasks while it syncs). Same never-fail, stderr-only behaviour as pushAfter. */
  const pushAllAfter = async (store: BoardStore, factories: string[] | undefined): Promise<void> => {
    try {
      for (const r of await pusherFor(store).pushAll(factories)) {
        if (r.error !== null) io.err(`github: ${r.taskId} not pushed (${r.error}); factory sync retries`);
      }
    } catch (e) {
      io.err(`github: not pushed (${firstLine(e)}); factory sync retries`);
    }
  };

  const depends = (v?: string) => (v === undefined ? {} : { dependsOn: v.split(',').map((x) => x.trim()).filter(Boolean) });
  const printJson = (v: unknown) => io.out(JSON.stringify(v, null, 2));

  program
    .command('next [task]')
    .description('claim the next piece of work and print its ticket')
    .option('--factory <id>', 'only this factory (repeat for several)', collect, undefined)
    .option('--json', 'print JSON')
    .option('--peek', 'only check: print "work <task>" and exit 0 if there is work, else the reason and exit 1; claims nothing')
    .action(async (task: string | undefined, o: { json?: boolean; peek?: boolean; factory?: string[] }, cmd: Command) => {
      if (o.peek && o.json) throw new CliExit('--peek prints one line; leave out --json', 1);
      const { engine, store } = await open(cmd);
      await pullBefore(store, factoryFilter(o.factory));
      const outcome = await engine.next(task, factoryFilter(o.factory), { peek: o.peek === true }).catch((e: unknown) => {
        throw e instanceof UnknownFactoryError ? new CliExit(e.message, 1, true) : e;
      });
      if (outcome.kind === 'work') return io.out(`work ${outcome.taskId}`);
      // Paused and inactive factories also return no ticket: say so, so a loop's owner is not left guessing.
      if (outcome.kind === 'none') {
        if (!o.peek) await pushAllAfter(store, factoryFilter(o.factory)); // next moved other tasks while it synced
        const line = outcome.reason === 'waiting' ? `${outcome.taskId} is waiting on ${outcome.waitingOn.join(', ')}`
          : outcome.reason === 'no-factories' ? NO_FACTORIES : outcome.reason;
        io.out(line);
        // A peek's exit code is its answer: 1 means do not start a session. The line is already on stdout.
        if (o.peek) throw new CliExit('', 1, true);
        return;
      }
      const { ticket } = outcome;
      await pushAllAfter(store, factoryFilter(o.factory));
      if (o.json) return printJson(ticket);
      io.out(`${ticket.taskId} ${ticket.step} (worktree ${ticket.worktree})`);
    });

  program
    .command('complete <task> <step>')
    .description('report an agent step result')
    .option('--result <file>', 'path of the agent result JSON')
    .option('--reply <file>', 'path of the agent reply text (<factory-result> and <factory-doc> blocks)')
    .option('--factory <id>', "the task's factory")
    .action(async (task: string, step: string, o: { result?: string; reply?: string; factory?: string }, cmd: Command) => {
      if (o.factory !== undefined) factoryId(o.factory);
      const agentStep = choice<AgentStep>('step', step, STEPS);
      if ((o.result === undefined) === (o.reply === undefined)) throw new CliExit('pass exactly one of --result or --reply', 1);
      const { engine, store } = await open(cmd);
      const updated =
        o.reply !== undefined
          ? await engine.completeWith(task, agentStep, parseAgentReply(readOrUndefined(o.reply), agentStep))
          : await engine.complete(task, agentStep, readOrUndefined(o.result!));
      await pushAfter(store, updated.taskId);
      io.out(`${updated.taskId} ${updated.status}`);
    });

  program
    .command('check <task>')
    .description('run the repo checks')
    .option('--factory <id>', "the task's factory")
    .action(async (task: string, o: { factory?: string }, cmd: Command) => {
      if (o.factory !== undefined) factoryId(o.factory);
      const { engine, store } = await open(cmd);
      const updated = await engine.check(task);
      await pushAfter(store, updated.taskId);
      io.out(`${updated.taskId} ${updated.status}`);
    });

  program
    .command('ship <task>')
    .description('push the branch and open (or merge) the PR')
    .option('--factory <id>', "the task's factory")
    .action(async (task: string, o: { factory?: string }, cmd: Command) => {
      if (o.factory !== undefined) factoryId(o.factory);
      const { engine, store } = await open(cmd);
      const updated = await engine.ship(task);
      await pushAfter(store, updated.taskId);
      io.out(`${updated.taskId} ${updated.status}${updated.prUrl ? ` ${updated.prUrl}` : ''}`);
    });

  program
    .command('renew <task>')
    .description('extend your claim on a task by 10 minutes')
    .option('--factory <id>', "the task's factory")
    .action(async (task: string, o: { factory?: string }, cmd: Command) => {
      if (o.factory !== undefined) factoryId(o.factory);
      const { engine } = await open(cmd);
      const renewed = await engine.renew(task);
      io.out(`${renewed.taskId} claimed until ${renewed.claimUntil}`);
    });

  program
    .command('status')
    .description('counts per status and active claims')
    .option('--factory <id>', 'only this factory (repeat for several)', collect, undefined)
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean; factory?: string[] }, cmd: Command) => {
      const { engine, store } = await open(cmd);
      const s = await engine.status(factoryFilter(o.factory));
      // Check each factory's gh login with one `gh auth status` (no token is read) and record it for the Board page.
      const loggedIn = new Map<string, boolean>();
      const loaded = new Map(s.factories.map((f) => [f.factoryId, f]));
      const users = await ghLoggedInUsers(exec);
      for (const d of await store.listFactoryDefs()) {
        const f = loaded.get(d.factoryId);
        if (!f) continue;
        const ok = isGhLoggedIn(users, f.ghUser);
        loggedIn.set(d.factoryId, ok);
        try {
          await store.setFactoryHealth({ factoryId: d.factoryId, ghLoggedIn: ok, checkedAt: new Date().toISOString() });
        } catch (e) {
          io.err(`health of ${d.factoryId} not written: ${firstLine(e)}`);
        }
      }
      for (const f of s.factories) f.ghLoggedIn = loggedIn.get(f.factoryId) ?? f.ghLoggedIn;
      const wanted = factoryFilter(o.factory);
      const githubOnly = new Set((await store.listFactoryDefs()).filter((d) => d.github?.mode === 'github-only').map((d) => d.factoryId));
      const githubErrors = (await store.listGitHubLinks())
        .filter((l) => l.error !== null && githubOnly.has(l.factoryId) && (!wanted || wanted.includes(l.factoryId)))
        .map((l) => ({ taskId: l.taskId, message: l.error!.message, attempts: l.error!.attempts, nextAttemptAt: l.error!.nextAttemptAt }));
      if (o.json) return printJson(githubErrors.length > 0 ? { ...s, githubErrors } : s);
      io.out(`paused: ${s.paused}`);
      for (const f of s.factories) {
        const counts = Object.entries(f.counts).filter(([, n]) => n > 0).map(([status, n]) => `${status}=${n}`);
        io.out(`factory ${f.factoryId}: ${f.active ? 'active' : 'inactive'}, paused ${f.paused}, ${f.ghUser === DEFAULT_GH_USER ? 'gh login not set' : `gh ${f.ghUser} ${f.ghLoggedIn === null ? 'unknown' : f.ghLoggedIn ? 'logged in' : 'not logged in'}`}${counts.map((c) => `, ${c}`).join('')}`);
      }
      for (const [status, n] of Object.entries(s.counts)) io.out(`${status}: ${n}`);
      for (const a of s.active) io.out(`active: ${a.taskId} ${a.step ?? '-'} by ${a.claimBy ?? '-'} until ${a.claimUntil ?? '-'}`);
      for (const t of s.tasks.filter((x) => x.status === 'blocked')) {
        const reason = t.blockedReason ? ` (${t.blockedReason})` : '';
        io.out(`blocked: ${t.taskId} at ${t.stage ?? '-'}${reason}, question: ${t.question ?? '-'}`);
      }
      for (const e of githubErrors) io.out(`github: ${e.taskId} push failing (${e.message}), attempt ${e.attempts}, next try ${e.nextAttemptAt}`);
    });

  program
    .command('new')
    .description('create a task in the Board (run by the owner from their session; inbox unless --ready)')
    .option('--factory <id>', 'factory id (required unless exactly one factory is active)')
    .requiredOption('--repo <id>', 'repo id')
    .requiredOption('--title <title>', 'task title')
    .option('--description <text>', 'task description')
    .option('--description-file <path>', 'file with the task description')
    .option('--base <branch>', 'base branch (default dev; never main)')
    .option('--ready', 'start in ready instead of inbox')
    .option('--depends-on <ids>', 'comma-separated task ids this task waits for')
    .option('--json', 'print the task as JSON')
    .action(async (o: { factory?: string; repo: string; title: string; description?: string; descriptionFile?: string; base?: string; ready?: boolean; dependsOn?: string; json?: boolean }, cmd: Command) => {
      if ((o.description === undefined) === (o.descriptionFile === undefined)) {
        throw new CliExit('pass exactly one of --description or --description-file', 1);
      }
      const repo = repoId('--repo', o.repo);
      let description = o.description ?? '';
      if (o.descriptionFile !== undefined) {
        try {
          description = readFileSync(o.descriptionFile, 'utf8');
        } catch {
          throw new CliExit(`cannot read --description-file ${o.descriptionFile}`, 1);
        }
      }
      const { store } = await open(cmd);
      const t = await owner.createTaskAsCore(store, () => new Date(), {
        factoryId: await pickFactory(store, o.factory), title: o.title, description, repo, ...(o.base ? { baseBranch: o.base } : {}), ready: o.ready === true, ...depends(o.dependsOn),
      });
      const pushed = await pushAfter(store, t.taskId);
      if (o.json) return printJson(t);
      io.out(`${t.taskId} created in ${t.status}`);
      if (pushed?.issue && pushed.done.includes('created')) io.out(`${t.taskId} issue ${pushed.issue}`);
    });

  program
    .command('factories')
    .description('list the factories and their repos (no secrets)')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }, cmd: Command) => {
      const { store } = await open(cmd);
      const [defs, repos] = await Promise.all([store.listFactoryDefs(), store.listFactoryRepos()]);
      const list = defs.map((d) => ({ ...d, repos: repos.filter((r) => r.factoryId === d.factoryId).map(({ factoryId: _f, ...r }) => r) }));
      if (o.json) return printJson({ factories: list });
      for (const f of list) {
        io.out(`${f.factoryId} (${f.name}) ${f.active ? 'active' : 'inactive'}: ${f.repos.map((r) => r.repoId).join(', ') || 'no repos'}`);
      }
    });

  program
    .command('init')
    .description('set up a factory by answering questions (first run), or change its settings (later runs); always the local store')
    .action(async () => {
      const root = findRoot();
      const prompt = readlinePrompter();
      const openStore = async () =>
        new FileStore(join(localStoreDir(root), 'board.json'), { factoriesDir: join(root, 'factories'), log: io.err });
      const setupFor = deps.githubSetupFor ?? lazyGitHubSetupFor(undefined, exec);
      const initDeps: InitDeps = {
        root, prompt, gh: realGhCli(exec), boardFor, setupFor,
        // A client per call: after `gh auth refresh` a cached client would still hold the old token.
        freshBoardFor: (login) => lazyGitHubBoardFor(undefined, undefined, exec)(login),
        openStore,
        doctor: async (id) => {
          const store = await openStore();
          const [defs, repos] = await Promise.all([store.listFactoryDefs(), store.listFactoryRepos()]);
          return doctor({
            defs, repos, loggedIn: await ghLoggedInUsers(exec), boardFor: lazyGitHubBoardFor(undefined, undefined, exec),
            setupFor, fileProblems: store.factoryFileProblems(), only: [id],
          });
        },
        platform: process.platform, now: () => new Date(),
      };
      try {
        const code = await (deps.runInit ?? runInit)(initDeps);
        if (code !== 0) throw new CliExit('', code, true);
      } finally {
        prompt.close();
      }
    });

  program
    .command('doctor')
    .description('check each factory\'s gh login and GitHub setup (reads only; exit 1 when a check fails)')
    .option('--factory <id>', 'only this factory (repeat for several)', collect, undefined)
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean; factory?: string[] }, cmd: Command) => {
      const only = factoryFilter(o.factory);
      const { store } = await open(cmd);
      const [defs, repos] = await Promise.all([store.listFactoryDefs(), store.listFactoryRepos()]);
      const unknown = (only ?? []).filter((id) => !defs.some((d) => d.factoryId === id));
      if (unknown.length > 0) throw new CliExit(`unknown factory: ${unknown.join(', ')}`, 1);
      const checks = await doctor({
        defs, repos, loggedIn: await ghLoggedInUsers(exec), boardFor: deps.githubBoardFor ?? lazyGitHubBoardFor(undefined, undefined, exec),
        setupFor: deps.githubSetupFor ?? lazyGitHubSetupFor(undefined, exec),
        ...(store instanceof FileStore ? { fileProblems: store.factoryFileProblems() } : {}),
        ...(only ? { only } : {}),
      });
      if (o.json) printJson({ checks });
      else for (const c of checks) io.out(`${c.ok ? 'ok' : 'FAIL'} ${c.factoryId} ${c.check}: ${c.detail}`);
      if (checks.some((c) => !c.ok)) throw new CliExit('', 1, true);
    });

  program
    .command('sync')
    .description('pull GitHub changes, then push every task of the GitHub-only factories (exit 1 when a pull or push fails)')
    .option('--factory <id>', 'only this factory (repeat for several)', collect, undefined)
    .option('--watch', 'keep pulling and pushing until Ctrl-C')
    .option('--rebuild', 'restore an empty GitHub-only factory\'s board from its marked issues, then push (runs once)')
    .option('--interval <seconds>', 'seconds between passes with --watch (1 to 3600)', '5')
    .action(async (o: { factory?: string[]; watch?: boolean; rebuild?: boolean; interval: string }, cmd: Command) => {
      const only = factoryFilter(o.factory);
      if (!/^\d+$/.test(o.interval) || Number(o.interval) < 1 || Number(o.interval) > 3600) throw new CliExit('--interval must be a whole number from 1 to 3600', 1);
      const interval = Number(o.interval);
      if (o.rebuild && o.watch) throw new CliExit('--rebuild runs once; leave out --watch', 1);
      const { store } = await open(cmd);
      const pusher = pusherFor(store);
      const puller = pullerFor(store);
      const printed = new Set<string>();
      /** One pull. Prints its lines (watch: items only, NOT APPLIED once per process) and returns whether it failed. */
      const pullPass = async (watching: boolean): Promise<boolean> => {
        let failed = false;
        const results = await puller.pull(only);
        const total = { created: 0, applied: 0, notApplied: 0, failed: 0 };
        for (const r of results) {
          if (r.skipped === 'busy') io.out(`github: pull of ${r.factoryId} skipped (another pull is running)`);
          for (const l of pullLines(r)) {
            if (watching && l.startsWith('NOT APPLIED')) {
              if (printed.has(l)) continue;
              printed.add(l);
            }
            io.out(l);
          }
          total.created += r.created.length;
          total.applied += r.applied.length;
          total.notApplied += r.notApplied.length;
          total.failed += r.errors.length;
        }
        if (total.failed > 0) failed = true;
        if (!watching) io.out(`pulled: created ${total.created}, applied ${total.applied}, not applied ${total.notApplied}, failed ${total.failed}`);
        return failed;
      };
      const rebuildLines = (results: RebuildResult[]): boolean => {
        let failed = false;
        let n = 0;
        for (const r of results) {
          for (const b of r.rebuilt) io.out(`${b.taskId} rebuilt from ${b.issue} (${b.status})`);
          for (const k of r.skipped) io.out(`skipped ${k.issue}: ${k.reason}`);
          if (r.error !== null) { io.out(`FAIL rebuild ${r.factoryId}: ${r.error}`); failed = true; }
          n += r.rebuilt.length;
        }
        for (const id of only ?? []) {
          if (!results.some((r) => r.factoryId === id)) { io.out(`FAIL rebuild ${id}: not a GitHub-only factory`); failed = true; }
        }
        io.out(`rebuilt ${n}`);
        return failed;
      };
      const lines = (results: PushResult[]) => {
        for (const r of results) {
          if (r.done.length > 0) io.out(`${r.taskId} ${r.issue ?? '-'}: ${r.done.join(', ')}`);
          if (r.error !== null) io.out(`FAIL ${r.taskId}: ${r.error}`);
        }
      };
      if (o.rebuild) {
        const rebuilt = await puller.rebuild(only);
        if (rebuilt.length === 0 && !only) {
          io.out('no factory uses GitHub-only mode');
          throw new CliExit('', 1, true);
        }
        const failed = rebuildLines(rebuilt);
        const pushed = await pusher.pushAll(only, { ignoreBackoff: true });
        lines(pushed);
        if (failed || pushed.some((r) => r.error !== null)) throw new CliExit('', 1, true);
        return;
      }
      if (!o.watch) {
        const defs = await store.listFactoryDefs();
        if (!defs.some((d) => d.github?.mode === 'github-only' && (!only || only.includes(d.factoryId)))) return io.out('no factory uses GitHub-only mode');
        const pullFailed = await pullPass(false);
        const results = await pusher.pushAll(only, { ignoreBackoff: true });
        lines(results);
        const failed = results.filter((r) => r.error !== null).length;
        io.out(`pushed ${results.filter((r) => r.done.length > 0).length}, failed ${failed}`);
        if (failed > 0 || pullFailed) throw new CliExit('', 1, true);
        return;
      }
      let noticed = false;
      let stop = false;
      let wakeUp: () => void = () => {};
      const wake = new Promise<void>((resolve) => { wakeUp = resolve; });
      const onSignal = () => { stop = true; wakeUp(); };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      try {
        for (let tick = 1; !stop; tick++) {
          try {
            if (!noticed) {
              const defs = await store.listFactoryDefs();
              noticed = true;
              if (!defs.some((d) => d.github?.mode === 'github-only' && (!only || only.includes(d.factoryId)))) io.out('no factory uses GitHub-only mode');
            }
            await pullPass(true);
            lines(await pusher.pushAll(only));
          } catch (e) {
            io.out(`error: ${firstLine(e)}`);
          }
          if (stop || (deps.watchTicks !== undefined && tick >= deps.watchTicks)) break;
          await waitOrWake(interval * 1000, wake, deps.sleep);
        }
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    });

  const dev = program.command('dev').description('owner actions by hand: add, ready, approve, answer, cancel (as on a Board page)');
  const openDev = async (cmd: Command): Promise<BoardStore> => (await open(cmd)).store;
  const now = () => new Date();

  dev
    .command('add')
    .option('--factory <id>', 'factory id (required unless exactly one factory is active)')
    .requiredOption('--repo <id>', 'repo id')
    .requiredOption('--title <title>', 'task title')
    .option('--description <text>', 'task description', '')
    .option('--base <branch>', 'base branch')
    .option('--depends-on <ids>', 'comma-separated task ids this task waits for')
    .action(async (o: { factory?: string; repo: string; title: string; description: string; base?: string; dependsOn?: string }, cmd: Command) => {
      const repo = repoId('--repo', o.repo);
      const store = await openDev(cmd);
      const t = await owner.createTask(store, now, {
        factoryId: await pickFactory(store, o.factory), title: o.title, description: o.description, repo, ...(o.base ? { baseBranch: o.base } : {}), ...depends(o.dependsOn),
      });
      await pushAfter(store, t.taskId);
      io.out(t.taskId);
    });

  dev
    .command('ready <task>')
    .action(async (id: string, _o: object, cmd: Command) => {
      const store = await openDev(cmd);
      await owner.markReady(store, now, id);
      await pushAfter(store, id);
      io.out(`${id} ready`);
    });

  dev
    .command('approve <task> <gate>')
    .option('--changes <comment>', 'ask for changes instead of approving')
    .action(async (id: string, gate: string, o: { changes?: string }, cmd: Command) => {
      const g = choice<Gate>('gate', gate, ['spec', 'plan', 'pr']);
      const store = await openDev(cmd);
      await store.getTask(id);
      const kind = GATE_DOC[g];
      const doc = await store.currentDoc(id, kind);
      if (!doc) throw new CliExit(`no current ${kind} doc for ${id}`, 1);
      const decision = o.changes === undefined ? 'approve' : 'changes';
      await owner.decideGate(store, now, id, g, decision, doc.version, o.changes ?? '');
      await pushAfter(store, id);
      io.out(`${id} ${g} ${decision} v${doc.version}`);
    });

  dev
    .command('answer <task> <text>')
    .action(async (id: string, text: string, _o: object, cmd: Command) => {
      const store = await openDev(cmd);
      await owner.answerTask(store, now, id, text, (await store.getTask(id)).version);
      await pushAfter(store, id);
      io.out(`${id} answered`);
    });

  dev
    .command('cancel <task>')
    .action(async (id: string, _o: object, cmd: Command) => {
      const store = await openDev(cmd);
      await owner.cancelTask(store, now, id);
      await pushAfter(store, id);
      io.out(`${id} cancelled`);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    if (e instanceof CliExit) {
      if (e.message !== '') io.err(e.code === 2 || e.plain ? e.message : `error: ${e.message}`);
      return e.code;
    }
    io.err(`error: ${firstLine(e)}`);
    return 1;
  }
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await run(process.argv.slice(2), { out: console.log, err: console.error });
}
