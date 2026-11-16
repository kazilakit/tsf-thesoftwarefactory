// `factory init` when there is no factory yet (design section 7.2): questions first, then one write, then GitHub setup and doctor.
import { join } from 'node:path';
import { PROTECTED_BRANCHES } from '../branches.js';
import { DEFAULT_SETTINGS } from '../defaults.js';
import { AGENT_MODELS, AGENT_STEPS, type AgentModel, type AgentModels } from '../factories.js';
import { newFactoryFile, saveFactoryFile, type FactoryFile } from '../factoryFile.js';
import { DEFAULT_LABEL, DEFAULT_STATUS_MAP, STANDARD_STATUS_MAP, validateGitHubSettings, type ProjectRef } from '../githubConfig.js';
import { parseRemote } from '../remote.js';
import { ALL_STATUSES } from '../status.js';
import type { Gate, Status } from '../types.js';
import { GH_USER_PATTERN } from '../validated.js';
import { PromptClosedError } from './prompts.js';
import { askRepos, checkUntilClean, chooseLogin, factoriesDir, idFromName, idProblem, InitStopError, takenFactoryIds, type InitDeps } from './shared.js';

export const READY = 'Ready. Open Claude Code and run /factory:run.';
export const WINDOWS_NOTE = 'Note: the factory steps themselves (git worktrees, the guard hook, shell checks) have not been tested on Windows yet.';
export const CANCELLED = 'setup cancelled; nothing was written';
const NEW_PROJECT = '\u0000new';
const NEW_COLUMN = '\u0000column';

export type ProjectChoice = { kind: 'existing'; ref: ProjectRef } | { kind: 'new'; owner: string; title: string };

/** Step 3: one of the login's or its orgs' Projects, or a new one (created only at the write). */
async function askProject(d: InitDeps, login: string, name: string): Promise<ProjectChoice> {
  const setup = d.setupFor(login);
  const owners = [login, ...(await setup.viewer()).orgs];
  const projects = (await Promise.all(owners.map((o) => setup.listProjects(o)))).flat();
  const picked = await d.prompt.choose('Which GitHub Project is the board?', [
    ...projects.map((p) => ({ value: `${p.owner}/${p.number}`, label: `${p.owner}/${p.number}  ${p.title}` })),
    { value: NEW_PROJECT, label: 'Create a new Project' },
  ]);
  if (picked !== NEW_PROJECT) {
    const p = projects.find((x) => `${x.owner}/${x.number}` === picked)!;
    return { kind: 'existing', ref: { owner: p.owner, number: p.number } };
  }
  const owner = owners.length === 1 ? login : await d.prompt.choose('Who owns the new Project?', owners.map((o) => ({ value: o, label: o })));
  const title = await d.prompt.ask('Project title', { default: name });
  return { kind: 'new', owner, title };
}

export function approversProblem(v: string): string | null {
  const list = v.split(',').map((x) => x.trim()).filter(Boolean);
  if (list.length === 0) return 'Enter at least one GitHub login';
  const bad = list.find((x) => !GH_USER_PATTERN.test(x));
  return bad ? `${bad} is not a GitHub login` : null;
}

/** The map rules (inbox ≠ ready, …) as the config validates them; null when the map is fine. */
function mapProblem(map: Record<Status, string>, login: string): string | null {
  const r = validateGitHubSettings({ mode: 'github-only', project: `${login}/1`, statusMap: map }, login);
  return r.ok ? null : r.error;
}

/** Each status asked over the Project's columns plus "New column…", until the map passes the rules. */
async function askEachStatus(d: InitDeps, login: string, columns: string[]): Promise<Record<Status, string>> {
  for (;;) {
    const options = [...columns];
    const map = {} as Record<Status, string>;
    for (const s of ALL_STATUSES) {
      const def = DEFAULT_STATUS_MAP[s];
      const picked = await d.prompt.choose(`Project column for ${s}`, [
        ...options.map((o) => ({ value: o, label: o })), { value: NEW_COLUMN, label: 'New column…' },
      ], options.includes(def) ? { default: def } : {});
      if (picked === NEW_COLUMN) {
        const name = await d.prompt.ask('New column name', { validate: (v) => (v ? null : 'Enter a name') });
        if (!options.includes(name)) options.push(name);
        map[s] = name;
      } else map[s] = picked;
    }
    const problem = mapProblem(map, login);
    if (problem === null) return map;
    d.prompt.say(`${problem}; enter the map again.`);
  }
}

/** Step 5: null keeps the default map out of the file. */
export async function askStatusMap(d: InitDeps, login: string, project: ProjectChoice): Promise<Record<Status, string> | null> {
  if (project.kind === 'new') return { ...STANDARD_STATUS_MAP };
  const info = await d.boardFor(login).project(project.ref);
  const columns = info?.options.map((o) => o.name) ?? [];
  const defaults = [...new Set(Object.values(DEFAULT_STATUS_MAP))];
  if (defaults.every((c) => columns.includes(c)) && await d.prompt.confirm(`Use the default map (${defaults.join(', ')})?`, true)) return null;
  return askEachStatus(d, login, columns);
}

/** Step 6; `current` gives the defaults (the first run: spec on, plan off, PR on). */
export async function askGates(d: InitDeps, current: Record<Gate, boolean> = DEFAULT_SETTINGS.gates): Promise<Record<Gate, boolean>> {
  const spec = await d.prompt.confirm('Should a spec wait for your approval?', current.spec);
  const plan = await d.prompt.confirm('Should a plan wait for your approval?', current.plan);
  const pr = await d.prompt.confirm('Should a PR wait for your approval before merging?', current.pr);
  return { spec, plan, pr };
}

/**
 * Step 7: the session model, or one of opus/sonnet/haiku/fable per stage (session leaves the stage out). `current`
 * gives the defaults.
 */
export async function askModels(d: InitDeps, current: AgentModels = {}): Promise<AgentModels> {
  const mode = await d.prompt.choose('Models', [
    { value: 'session', label: 'Session model for every stage' }, { value: 'per', label: 'Choose per stage' },
  ], Object.keys(current).length > 0 ? { default: 'per' } : {});
  const models: AgentModels = {};
  if (mode === 'session') return models;
  for (const step of AGENT_STEPS) {
    const m = await d.prompt.choose(`Model for ${step}`, [
      { value: 'session', label: 'session default' }, ...AGENT_MODELS.map((x) => ({ value: x as string, label: x })),
    ], { default: current[step] ?? 'session' });
    if (m !== 'session') models[step] = m as AgentModel;
  }
  return models;
}

/**
 * Runs the first-run wizard: 0 ready, 1 stopped with failures, 130 cancelled. `login` (the one login other factories
 * already use) skips the login question.
 */
export async function firstRun(d: InitDeps, o: { login?: string } = {}): Promise<number> {
  const say = (t: string) => d.prompt.say(t);
  let written = false;
  try {
    const login = await chooseLogin(d, o.login);
    const taken = await takenFactoryIds(d);
    const name = await d.prompt.ask('Factory name', { validate: (v) => (v ? null : 'Enter a name') });
    const id = await d.prompt.ask('Factory id', { default: idFromName(name, taken), validate: (v) => idProblem(v, taken) });
    const project = await askProject(d, login, name);
    const approvers = (await d.prompt.ask('Approvers (comma-separated GitHub logins)', { default: login, validate: approversProblem }))
      .split(',').map((x) => x.trim()).filter(Boolean);
    const statusMap = await askStatusMap(d, login, project);
    const gates = await askGates(d);
    const models = await askModels(d);
    const protectedBranches = [...PROTECTED_BRANCHES];
    const repos = await askRepos(d, login, protectedBranches, []);

    // Step 9: nothing was created or written before this point. The file is checked (a placeholder number for a new
    // Project) before the Project is created, so a bad answer cannot leave an orphan Project behind.
    const setup = d.setupFor(login);
    const fileFor = (r: ProjectRef) => newFactoryFile(join(factoriesDir(d.root), id), {
      id, name, accounts: { github: login },
      board: { source: 'github', project: `${r.owner}/${r.number}`, label: DEFAULT_LABEL, approvers, statusMap },
      gates, models, protectedBranches, repos,
    });
    const precheck = fileFor(project.kind === 'existing' ? project.ref : { owner: project.owner, number: 1 });
    if (!precheck.ok) {
      say(precheck.error);
      return 1;
    }
    const ref: ProjectRef = project.kind === 'existing' ? project.ref : await setup.createProject(project.owner, project.title);
    const created = project.kind === 'new' ? `Created the Project ${ref.owner}/${ref.number}` : null;
    if (created) say(`${created}.`);
    let saved: FactoryFile;
    try {
      const file = fileFor(ref);
      if (!file.ok) throw new Error(file.error);
      saved = saveFactoryFile(file.value);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      say(created ? `${created}, but factory.yaml was not written: ${why}` : `factory.yaml was not written: ${why}`);
      return 1;
    }
    written = true;
    say(`Wrote ${saved.path}.`);

    // Step 10: the label in each repo and the map's columns on the Project.
    const board = d.boardFor(login);
    for (const r of repos) {
      const repoRef = parseRemote(r.remote);
      try {
        if (!(await board.labelExists(repoRef, DEFAULT_LABEL))) await board.createLabel(repoRef, DEFAULT_LABEL);
      } catch (e) {
        say(`Could not create the ${DEFAULT_LABEL} label in ${repoRef.owner}/${repoRef.repo}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      const added = await setup.ensureStatusOptions(ref, [...new Set(Object.values(statusMap ?? DEFAULT_STATUS_MAP))]);
      if (added.length) say(`Added Project columns: ${added.join(', ')}.`);
    } catch (e) {
      say(`Could not add the Project columns: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 11.
    if (!(await checkUntilClean(d, id))) {
      say('Fix the failures above, then run ./factory init and choose Re-check.');
      return 1;
    }
    say(READY);
    if (d.platform === 'win32') say(WINDOWS_NOTE);
    return 0;
  } catch (e) {
    if (e instanceof PromptClosedError) {
      say(written ? 'setup cancelled; factory.yaml was written. Run ./factory init and choose Re-check.' : CANCELLED);
      return 130;
    }
    if (e instanceof InitStopError) {
      say(e.message);
      return 1;
    }
    throw e;
  }
}
