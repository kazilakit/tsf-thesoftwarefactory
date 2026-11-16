import fs from 'node:fs';
import path from 'node:path';
import { isFactoryAgent } from './lib.mjs';

// git, then any global options (-C dir, -c k=v, --flag[=v]), then whitespace before the subcommand
const G = 'git(?:\\s+(?:-C|-c)\\s+\\S+|\\s+--?[\\w-]+(?:=\\S+)?)*\\s+';
const KEYCHAIN_SUB = '(?:find-|add-|delete-|dump-|export|import|unlock-|set-|create-|default-|list-keychains|login-keychain|show-keychain)';
const BASH_DENY = [
  // `security`, any flags, then a Keychain subcommand; `grep -r security` stays allowed (R6).
  [new RegExp(`\\bsecurity(?:\\s+-\\S+)*\\s+${KEYCHAIN_SUB}`), 'Keychain access'],
  [/find-(generic|internet)-password|dump-keychain/, 'Keychain access'],
  // Linux: `secret-tool` (any flags) then a subcommand, and the Secret Service over D-Bus; `grep secret-tool` stays allowed.
  [/\bsecret-tool(?:\s+-\S+)*\s+(?:lookup|search|store|clear|lock|unlock)\b/, 'keyring access'],
  [/org\.freedesktop\.secrets/, 'keyring access'],
  [/(^|[\s;&|(])gh\s/, 'gh CLI'],
  [new RegExp(`${G}push`), 'git push'],
  [new RegExp(`${G}remote\\s+(add|set-url|remove|rename)`), 'git remote change'],
  [new RegExp(`${G}config\\s+(?!--get)`), 'git config change'],
  [/(^|[\s;&|(])ssh\s/, 'ssh'],
  [/\.ssh\b/, '.ssh access'],
  [/GH_TOKEN|GITHUB_TOKEN/, 'token variable'],
  [/api\.github\.com/, 'GitHub API'],
  [/\.git\/hooks|hooksPath|--no-verify/, 'git hooks'],
];
const BASH_DENY_AGENT = [
  [new RegExp(`${G}(switch|rebase|merge|branch\\s+(-[dDmMcC]|[^-\\s])|checkout\\s+-b)`), 'branch-changing git command'],
  [/\bgit\b[^;&|\n]*\bpush\b/, 'git push'],
  [/(^|[\s;&|(])factory\s/, 'factory CLI'],
  [/core\/(dist|src)\//, 'factory core'],
];
// git subcommands that change the checkout or its history; factory agents run them only in the step worktree
const GIT_STATE = /\bgit\b[^;&|\n]*?\s(add|commit|reset|stash|restore|checkout|rm|mv|clean|cherry-pick|revert|am|apply)(?=$|[\s;&|)])/;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const deny = (rule) => ({ deny: true, reason: `factory guard: ${rule}` });
const inside = (dir, p) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Resolves symlinks in the deepest existing ancestor of an absolute path; the missing tail is kept as is. */
export function realish(p, realpath = fs.realpathSync) {
  const abs = path.resolve(p);
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpath(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return abs;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

/** True when the command names the worktree or a subfolder as `cd "<wt>"`, `cd <wt>/sub` (no `.` or `..` segments), `-C "<wt>"` or `-C <wt>`. */
function namesWorktree(cmd, wt) {
  const re = new RegExp(`(?:\\bcd|(?:^|\\s)-C)\\s+(["']?)${escapeRe(wt)}(?:\\/(?!\\.{1,2}(?:[\\/\\s"';&|)]|$))[^\\s"';&|)\\/]+)*\\/?\\1(?=$|[\\s;&|)])`);
  return re.test(cmd);
}

/** ctx.active false means no factory work is under way (see guard.mjs): allow everything. */
export function decide(input, ctx) {
  if (ctx.active === false) return { deny: false };
  const { root, session } = ctx;
  const real = (p) => realish(p, ctx.realpath);
  const tool = input?.tool_name;
  if (typeof tool !== 'string' || !tool) return deny('no tool name');
  const agent = isFactoryAgent(input);
  const ti = input.tool_input ?? {};

  if (tool === 'Bash') {
    const cmd = String(ti.command ?? '');
    for (const [re, rule] of BASH_DENY) if (re.test(cmd)) return deny(`Bash denied (${rule})`);
    if (agent) {
      for (const [re, rule] of BASH_DENY_AGENT) if (re.test(cmd)) return deny(`Bash denied for factory agents (${rule})`);
      const m = cmd.match(GIT_STATE);
      if (m) {
        const wt = session?.worktree;
        const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : null;
        const ok = wt && (namesWorktree(cmd, wt) || (cwd && inside(real(wt), real(cwd))));
        if (!ok) return deny(`git ${m[1]} must run in the step worktree`);
      }
    }
    return { deny: false };
  }

  if (WRITE_TOOLS.has(tool)) {
    const raw = ti.file_path ?? ti.notebook_path;
    if (typeof raw !== 'string' || !raw) return deny(`${tool} without a file path`);
    if (!path.isAbsolute(raw)) return deny(`${tool} needs an absolute path`);
    const target = path.resolve(raw);
    // A symlink inside an allowed folder must not lead out of it: compare resolved paths.
    const target2 = real(target);
    if (agent) {
      if (!session?.worktree) return deny('no active factory step');
      if (!inside(real(session.worktree), target2)) return deny('factory agents may write only inside the step worktree');
      return { deny: false };
    }
    if (inside(real(path.join(root, 'runs')), target2) || inside(real(path.join(root, '.clones', 'worktrees')), target2)) return { deny: false };
    return deny('the main session may write only under runs/ and .clones/worktrees/');
  }

  return { deny: false };
}
