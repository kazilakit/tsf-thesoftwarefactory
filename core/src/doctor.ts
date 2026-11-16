import type { GitHubSetupFor } from './githubSetup.js';
import type { FactoryDef, FactoryRepo } from './factories.js';
import { githubConfigProblems } from './githubConfig.js';
import type { GitHubBoardFor, ProjectInfo } from './githubBoard.js';
import { parseRemote } from './remote.js';
import { isGhLoggedIn } from './secrets.js';
import { ALL_STATUSES } from './status.js';
import { DEFAULT_GH_USER, NO_GH_LOGIN_HINT } from './validated.js';

export interface DoctorCheck { factoryId: string; check: string; ok: boolean; detail: string }

const TOKEN = /\b(?:gh[opsur]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g;
/** Replaces GitHub tokens in a message. */
export const redactSecrets = (s: string): string => s.replace(TOKEN, '[redacted]');
const firstLine = (e: unknown): string => redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Checks each factory's gh login and, with a `github` block, its GitHub setup. Reads only; a client error becomes a failing check. */
export async function doctor(o: {
  defs: FactoryDef[]; repos: FactoryRepo[]; loggedIn: ReadonlySet<string>; boardFor: GitHubBoardFor;
  /** Only these factories are checked; config problems are still found across all of them. */
  only?: string[];
  /** With this, each repo's access and base branch are checked (after the login check passes). */
  setupFor?: GitHubSetupFor;
  /** factory.yaml files that failed to load; each is a failing `config file` check, even for a factory with no def. */
  fileProblems?: { factoryId: string; file: string; reason: string }[];
}): Promise<DoctorCheck[]> {
  const problems = githubConfigProblems(o.defs, o.repos);
  const out: DoctorCheck[] = [];
  const fileChecks = (factoryId: string) => {
    for (const p of (o.fileProblems ?? []).filter((x) => x.factoryId === factoryId))
      out.push({ factoryId, check: 'config file', ok: false, detail: redactSecrets(`${p.file}: ${p.reason}; fix the file or run ./factory init`) });
  };
  for (const def of o.defs.filter((d) => !o.only || o.only.includes(d.factoryId))) {
    const factoryId = def.factoryId;
    fileChecks(factoryId);
    const add = (check: string, ok: boolean, detail: string): boolean => { out.push({ factoryId, check, ok, detail: redactSecrets(detail) }); return ok; };
    /** Runs a check; a thrown error fails it with the first line of the message. */
    const attempt = async <T>(check: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try { return await fn(); } catch (e) { add(check, false, firstLine(e)); return undefined; }
    };

    // An inactive factory does no work, so it is not checked unless named with --factory.
    if (!def.active && !o.only) {
      add('active', true, 'skipped: the factory is inactive (name it with --factory to check it)');
      continue;
    }
    // A factory with no GitHub board and no repos uses no gh login: its ghUser may only be the "not set" default, so it is not named.
    const myRepoCount = o.repos.filter((r) => r.factoryId === factoryId).length;
    if (!def.github && myRepoCount === 0) {
      add('gh login', true, 'not needed: nothing in this factory uses GitHub');
      continue;
    }
    if (def.ghUser === DEFAULT_GH_USER) {
      add('gh login', false, NO_GH_LOGIN_HINT);
      continue;
    }
    if (!isGhLoggedIn(o.loggedIn, def.ghUser)) {
      add('gh login', false, `${def.ghUser} is not logged in (run: gh auth login --hostname github.com)`);
      continue;
    }
    add('gh login', true, `${def.ghUser} logged in`);
    const myRepos = o.repos.filter((r) => r.factoryId === factoryId).sort((a, b) => byId(a.repoId, b.repoId));
    if (o.setupFor) await repoChecks(def.ghUser, myRepos, o.setupFor(def.ghUser), add, attempt);
    const github = def.github;
    if (!github) continue;

    const mine = problems.filter((p) => p.factoryId === factoryId);
    if (mine.length === 0) add('config', true, 'ok');
    for (const p of mine) add(p.repoId ? `config ${p.repoId}` : 'config', false, p.message);

    const board = await attempt('scope', async () => o.boardFor(def.ghUser));
    if (!board) continue;
    const scopes = await attempt('scope', () => board.tokenScopes());
    const scopeOk = scopes !== undefined && (scopes === null
      ? add('scope', false, 'the gh login token has no OAuth scopes (fine-grained or app token); log in with gh auth login to get a token with the project scope')
      : scopes.includes('project')
        ? add('scope', true, 'project scope present')
        : add('scope', false, 'the gh login needs the project scope (run: gh auth refresh -s project)'));
    if (scopeOk) {
      const ref = github.project;
      const info: ProjectInfo | null | undefined = await attempt('project', () => board.project(ref));
      if (info === null) add('project', false, `project ${ref.owner}/${ref.number} not found or not visible to ${def.ghUser}`);
      else if (info) {
        add('project', true, `${ref.owner}/${ref.number} found`);
        const have = new Set(info.options.map((x) => x.name));
        const missing: string[] = [];
        for (const s of ALL_STATUSES) {
          const name = github.statusMap[s];
          if (!have.has(name) && !missing.includes(name)) missing.push(name);
        }
        if (missing.length === 0) add('status options', true, `all ${ALL_STATUSES.length} statuses map to existing options`);
        else add('status options', false, `missing on the Project: ${missing.join(', ')}`);
      }
    }
    for (const repo of myRepos) {
      let remote: { owner: string; repo: string };
      try { remote = parseRemote(repo.remote); } catch { continue; }
      const check = `label ${repo.repoId}`;
      if (github.label === '') { add(check, true, 'no label filter'); continue; }
      const exists = await attempt(check, () => board.labelExists(remote, github.label));
      if (exists !== undefined) add(check, true, exists ? 'exists' : 'missing; created on first push');
    }
  }
  const defIds = new Set(o.defs.map((d) => d.factoryId));
  const orphans = [...new Set((o.fileProblems ?? []).map((p) => p.factoryId))].filter((id) => !defIds.has(id) && (!o.only || o.only.includes(id)));
  for (const id of orphans.sort(byId)) fileChecks(id);
  return out;
}

/** `repo <id>` and `base <id>` per repo; an unreachable repo skips its base check. */
async function repoChecks(
  login: string, repos: FactoryRepo[], setup: ReturnType<GitHubSetupFor>,
  add: (check: string, ok: boolean, detail: string) => boolean,
  attempt: <T>(check: string, fn: () => Promise<T>) => Promise<T | undefined>,
): Promise<void> {
  for (const repo of repos) {
    let ref: { owner: string; repo: string };
    try { ref = parseRemote(repo.remote); } catch { add(`repo ${repo.repoId}`, false, 'remote is not a GitHub repo (only GitHub is supported)'); continue; }
    const name = `${ref.owner}/${ref.repo}`;
    const info = await attempt(`repo ${repo.repoId}`, () => setup.repo(ref));
    if (info === undefined) continue;
    if (info === null) { add(`repo ${repo.repoId}`, false, `${name} not found or not visible to ${login}`); continue; }
    add(`repo ${repo.repoId}`, true, `${name} reachable as ${login}`);
    const exists = await attempt(`base ${repo.repoId}`, () => setup.branchExists(ref, repo.baseBranch));
    if (exists === undefined) continue;
    if (exists) add(`base ${repo.repoId}`, true, `${repo.baseBranch} exists`);
    else add(`base ${repo.repoId}`, false, `base branch ${repo.baseBranch} not found on ${name}`);
  }
}
