import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(path.join(pluginDir, 'skills/new/SKILL.md'), 'utf8');
const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const fmText = m ? m[1] : '';
const body = m ? m[2] : '';
const GROUND_RULES = "Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.";
const fm = Object.fromEntries(
  fmText.split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((k) => [k[1], k[2].trim()]),
);

describe('new skill', () => {
  it('has the frontmatter', () => {
    expect(m).not.toBeNull();
    expect(fm.name).toBe('new');
    expect(fm.description).toBe("Draft a factory task from the user's words and create it on the Board (use only when the user runs /factory:new)");
    expect(fm['argument-hint']).toBe('[--ready] [--depends-on <ids>] [<factory>:] <what you want done>');
    expect(fm['allowed-tools']).toBe('Read, Write, Bash(node:*), Bash(HUSKY=0 node:*), Bash(printenv:*)');
  });

  it('is started only by the user', () => {
    expect(fm['disable-model-invocation']).toBe('true');
  });

  it('has the numbered steps 0 to 5', () => {
    for (let i = 0; i <= 5; i++) expect(body).toMatch(new RegExp(`^${i}\\. `, 'm'));
    expect(body).not.toMatch(/^6\. /m);
  });

  it('needs FACTORY_ROOT and FACTORY_STORE from the session env, with no fallback', () => {
    const step0 = body.match(/^0\. .*$/m)[0];
    expect(step0).toContain('`printenv FACTORY_ROOT`');
    expect(step0).toContain('`printenv FACTORY_STORE`');
    expect(step0).toContain('`factory: session env missing; start a new session`');
    expect(step0).toContain('create nothing');
    expect(text).not.toContain('printenv HOME');
    expect(body).not.toContain('--store');
  });

  it('learns the factories and repos from factories --json, not from repos/', () => {
    expect(body).toContain('HUSKY=0 node "<root>/core/dist/cli.js" --mode session factories --json');
    expect(text).not.toContain('repos/*.yaml');
    expect(text).not.toContain('.yaml');
    expect(body).toContain('baseBranch');
  });

  it('picks the factory from the prefix or the repo, and asks on no match or several', () => {
    const step2 = body.match(/^2\. [\s\S]*?(?=^3\. )/m)[0];
    expect(step2).toContain('`<factory>:`');
    expect(step2).toMatch(/prompt names/);
    expect(step2).toMatch(/no match/);
    expect(step2).toMatch(/more than one factory/);
    expect(step2).toMatch(/ask/);
    expect(step2).toContain('**factory:**');
  });

  it('passes --factory to new and puts factory in the draft', () => {
    expect(body.match(/^4\. .*$/m)[0]).toContain('new --factory "<factory>" --repo "<repo>"');
    expect(body.match(/^3\. .*$/m)[0]).toContain('"factory": ...');
  });

  it('drafts the fields', () => {
    for (const field of ['repo', 'base', 'title', 'description']) expect(body).toContain(`**${field}:**`);
    expect(body).toContain('$ARGUMENTS');
    expect(body).toContain('Acceptance criteria');
    expect(body).toContain('Open questions');
  });

  it('writes the draft under runs/.drafts and runs link.mjs', () => {
    expect(body).toContain('runs/.drafts/');
    expect(body).toContain('${CLAUDE_SESSION_ID}');
    expect(body).toContain('link.mjs');
    expect(body).toContain('${CLAUDE_SKILL_DIR}');
    expect(body).toMatch(/Create task/);
    expect(body).toMatch(/Mark ready/);
    expect(body).toContain('/factory:run');
  });

  it('creates the task with the CLI from a description file', () => {
    const step4 = body.match(/^4\. .*$/m)[0];
    expect(step4).toContain('HUSKY=0 node "<root>/core/dist/cli.js" --mode session new --factory "<factory>" --repo "<repo>" --base "<base>" --title "<title>" --description-file');
    expect(step4).toContain('runs/.drafts/${CLAUDE_SESSION_ID}.md');
    expect(step4).not.toContain('--store');
    expect(body.match(/^3\. .*$/m)[0]).toContain('${CLAUDE_SESSION_ID}.md');
  });

  it('adds --ready only when the user asked for it, and strips the flag from the prompt', () => {
    expect(body.match(/^2\. .*$/m)[0]).toMatch(/`\$ARGUMENTS` may start with the flags `--ready`[^\n]*remove them from the prompt/);
    expect(body.match(/^4\. .*$/m)[0]).toMatch(/Add `--ready`[^\n]*only if the user's arguments started with the `--ready` flag/);
    expect(body.match(/--ready/g).length).toBeGreaterThanOrEqual(3);
  });

  it('takes --depends-on with comma-separated task ids among the leading flags and strips it from the prompt', () => {
    const step2 = body.match(/^2\. [\s\S]*?(?=^3\. )/m)[0];
    expect(step2).toContain('`--depends-on <ids>`');
    expect(step2).toMatch(/in either order/);
    expect(step2).toContain('`^T-[0-9]+(,T-[0-9]+)*$`');
    expect(step2).toMatch(/does not match[^\n]*stop and ask/);
    expect(step2).toMatch(/remove them from the prompt/);
  });

  it('asks before turning dependencies written in words into --depends-on', () => {
    const step2 = body.match(/^2\. [\s\S]*?(?=^3\. )/m)[0];
    expect(step2).toMatch(/depends on or waits for[^\n]*no `--depends-on`[^\n]*ask/);
  });

  it('passes --depends-on to new only when the user gave ids', () => {
    const step4 = body.match(/^4\. .*$/m)[0];
    expect(step4).toMatch(/Add `--depends-on "<ids>"`[^\n]*only if/);
  });

  it('shows the dependencies and keeps them in the fallback', () => {
    const step5 = body.match(/^5\. .*$/m)[0];
    expect(step5).toMatch(/Depends on/);
    expect(step5).toMatch(/link[^\n]*\*\*Depends on\*\*/);
  });

  it('strips quote, backtick, dollar and backslash from the title', () => {
    expect(body).toContain('Strip every `"`, backtick, `$` and backslash from the title');
  });

  it('shows the CLI line and what to do next', () => {
    const step5 = body.match(/^5\. .*$/m)[0];
    expect(step5).toContain('`T-3 created in inbox`');
    expect(step5).toMatch(/inbox[^\n]*\*\*Mark ready\*\*[^\n]*\/factory:run/);
    expect(step5).toMatch(/in ready[^\n]*run `\/factory:run`/);
  });

  it('falls back to the Board link when the CLI fails', () => {
    const step5 = body.match(/^5\. .*$/m)[0];
    expect(step5).toMatch(/failed, show its one-line error/);
    expect(step5).toContain('link.mjs');
    expect(step5).toContain('${CLAUDE_SKILL_DIR}');
    expect(step5).toMatch(/Create task/);
  });

  it('limits the base to plain branch characters and asks otherwise', () => {
    expect(body).toContain('The base must match `[A-Za-z0-9._/-]+`');
    expect(body).toMatch(/does not, stop and ask/);
  });

  it('never targets main', () => {
    expect(body).toContain('never main');
    expect(body).toContain('never uses `main` as a task base');
    expect(body).toContain('`main` is always protected');
  });

  it('asks about an ambiguous repo instead of guessing', () => {
    expect(body).toMatch(/ambiguous[^\n]*ask/i);
  });

  it('has the ground-rules line', () => {
    expect(body).toContain(GROUND_RULES);
  });

  it('uses no shell variable expansion', () => {
    const stripped = text.replace(/\$\{CLAUDE_(SESSION_ID|SKILL_DIR)\}/g, '').replace(/\$ARGUMENTS/g, '');
    expect(stripped).not.toMatch(/\$[{(\w]/);
    expect(text).not.toContain('CLAUDE_PROJECT_DIR');
  });

  it('never mentions git push, security or gh', () => {
    expect(text).not.toContain('git push');
    expect(text.toLowerCase()).not.toContain('security');
    expect(text).not.toContain('gh ');
  });
});
