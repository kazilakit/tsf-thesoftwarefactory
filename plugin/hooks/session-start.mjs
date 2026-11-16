import fs from 'node:fs';
import os from 'node:os';
import { readHookInput, resolveFactoryRoot, claimantFor } from './lib.mjs';

// Escapes the characters that stay special inside double quotes.
const shellQuoted = (s) => s.replace(/[\\"$`]/g, '\\$&');

// Exports the factory env to this session's Bash calls, only when a factory root resolves.
// HUSKY=0 only in project mode: elsewhere it would leak into normal work, so the skills
// prefix the factory's own commands instead.
try {
  const input = await readHookInput();
  const found = resolveFactoryRoot(process.env, os.homedir());
  if (found) {
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (!envFile) {
      process.stderr.write('factory session-start: CLAUDE_ENV_FILE is not set; skipping env export\n');
    } else {
      const lines = [
        `export FACTORY_ROOT="${shellQuoted(found.root)}"`,
        `export FACTORY_CLAIMANT=${claimantFor(input.session_id, os.hostname())}`,
        'export FACTORY_STORE="${FACTORY_STORE:-local}"',
      ];
      if (found.projectMode) lines.push('export HUSKY=0');
      fs.appendFileSync(envFile, lines.join('\n') + '\n');
    }
  }
} catch (e) {
  process.stderr.write(`factory session-start error: ${e?.message ?? e}\n`);
}
