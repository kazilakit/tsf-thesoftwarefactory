import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readHookInput, resolveFactoryRoot, readSession, isFactoryAgent, shouldRenew, renewFile, renewCommand } from './lib.mjs';

try {
  const input = await readHookInput();
  if (isFactoryAgent(input)) {
    const root = resolveFactoryRoot(process.env, os.homedir())?.root;
    const session = root ? readSession(root, input.session_id) : null;
    if (session?.taskId && session.mode) {
      const marker = renewFile(root, input.session_id);
      let last = null;
      try { last = fs.statSync(marker).mtimeMs; } catch {}
      const now = Date.now();
      if (shouldRenew(last, now)) {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.closeSync(fs.openSync(marker, 'a'));
        fs.utimesSync(marker, new Date(now), new Date(now));
        const cmd = renewCommand({ root, session, sessionId: input.session_id, host: os.hostname() });
        if (!cmd) {
          process.stderr.write('factory renew: FACTORY_STORE must be local (or file); renewal skipped\n');
        } else {
          fs.mkdirSync(path.dirname(cmd.log), { recursive: true });
          const out = fs.openSync(cmd.log, 'a');
          const child = spawn(cmd.file, cmd.args, { env: cmd.env, detached: true, stdio: ['ignore', out, out] });
          child.on('error', () => {});
          child.unref();
        }
      }
    }
  }
} catch (e) {
  process.stderr.write(`factory renew error: ${e?.message ?? e}\n`);
}
