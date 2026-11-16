import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHookInput, resolveFactoryRoot, isFactoryRoot, readSession, sessionFile, isFactoryAgent } from './lib.mjs';
import { decide } from './decide.mjs';

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n');
}

/** The project dir, resolved through symlinks, when it is itself a factory root; else null. */
function factoryProjectDir(env) {
  if (!env.CLAUDE_PROJECT_DIR) return null;
  let dir = path.resolve(env.CLAUDE_PROJECT_DIR);
  try { dir = fs.realpathSync(dir); } catch {}
  return isFactoryRoot(dir) ? dir : null;
}

// The guard enforces only during factory work: for factory agents, in a session started in a
// factory folder (whatever FACTORY_ROOT says), and while this session's /factory:run step file
// exists. Anything else, such as normal work with a user-scoped install, is allowed without
// output. While enforcing, an error denies (fail closed).
let enforcing = false;

async function main() {
  const home = os.homedir();
  const found = resolveFactoryRoot(process.env, home);
  const project = factoryProjectDir(process.env);
  enforcing = Boolean(project);
  const input = await readHookInput();
  if (isFactoryAgent(input)) {
    enforcing = true;
    if (!found) return emitDeny('factory guard: factory root not found');
  }
  const stepFile = found && input?.session_id ? sessionFile(found.root, input.session_id) : null;
  const stepRunning = Boolean(stepFile && fs.existsSync(stepFile));
  // Name the step file when it alone turns the guard on, so a stale one is easy to find.
  const byStepFileOnly = !enforcing && stepRunning;
  enforcing ||= stepRunning;
  const root = found?.root ?? project;
  const session = root ? readSession(root, input?.session_id) : null;
  const result = decide(input, { root, home, session, active: enforcing });
  if (result.deny) emitDeny(byStepFileOnly ? `${result.reason} (step file ${stepFile} exists)` : result.reason);
}

try {
  await main();
} catch (e) {
  if (enforcing) emitDeny(`factory guard error: ${e?.message ?? e}`);
}
