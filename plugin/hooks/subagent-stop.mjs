import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHookInput, resolveFactoryRoot, readSession, replyTarget } from './lib.mjs';

try {
  const input = await readHookInput();
  const root = resolveFactoryRoot(process.env, os.homedir())?.root;
  const target = root ? replyTarget(input, { root, session: readSession(root, input.session_id) }) : null;
  if (target && typeof input.last_assistant_message === 'string') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.last_assistant_message);
  }
} catch (e) {
  process.stderr.write(`factory subagent-stop error: ${e?.message ?? e}\n`);
}
