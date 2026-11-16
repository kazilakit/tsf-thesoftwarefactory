import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FOR } from '../../core/src/defaults.ts';
import { parseAgentReply } from '../../core/src/agentReply.ts';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(pluginDir, rel), 'utf8');

/** Small YAML subset: `key: value` lines, with `[a, b]` inline lists. */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('no frontmatter');
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    out[kv[1]] = v.startsWith('[') ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : v;
  }
  return out;
}

// The same line is in the run skill (run-skill.test.mjs).
const GROUND_RULES = "Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.";

const READ_ONLY = ['Read', 'Grep', 'Glob'];
const TOOLS = {
  'spec-writer': READ_ONLY,
  planner: READ_ONLY,
  verifier: READ_ONLY,
  reviewer: READ_ONLY,
  implementer: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
};
const skillDir = (name) => name.replace(/^factory:/, '');

describe('stage agents', () => {
  for (const [step, agent] of Object.entries(AGENT_FOR)) {
    describe(agent, () => {
      const fm = frontmatter(read(`agents/${agent}.md`));
      it('has the core agent name, description, model and turn limit', () => {
        expect(fm.name).toBe(agent);
        expect(fm.description).toBeTruthy();
        expect(fm.model).toBe('inherit');
        expect(fm.maxTurns).toBe('60');
      });
      it('has exactly the stage tools', () => {
        expect(fm.tools.split(',').map((t) => t.trim())).toEqual(TOOLS[agent]);
      });
      it('preloads its stage skill and reply-format, both existing', () => {
        expect(fm.skills).toEqual([skillDir(step), 'reply-format'].map((s) => s));
        for (const s of fm.skills) expect(fs.existsSync(path.join(pluginDir, 'skills', skillDir(s), 'SKILL.md'))).toBe(true);
      });
    });
    describe(`${step} skill`, () => {
      const text = read(`skills/${step}/SKILL.md`);
      const fm = frontmatter(text);
      it('is hidden from users and names the reply format', () => {
        expect(fm.name).toBe(step);
        expect(fm['user-invocable']).toBe('false');
        expect(text).toMatch(/reply-format|factory-result/);
      });
      it('has the ground-rules line', () => {
        expect(text).toContain(GROUND_RULES);
      });
    });
  }
});

describe('stage skills work in the worktree (I2)', () => {
  for (const step of Object.keys(AGENT_FOR)) {
    it(`${step} names the worktree for Grep, Glob and Read`, () => {
      const text = read(`skills/${step}/SKILL.md`);
      expect(text).toContain('path: "<worktree>"');
      expect(text).toMatch(/Read[^\n]*absolute paths/);
      expect(text).toContain('You do not start in the worktree; your session may start in the factory folder or elsewhere');
      expect(text).not.toMatch(/start in the factory root/);
    });
  }
  it('build runs every Bash command in the worktree with a long timeout (I1)', () => {
    const text = read('skills/build/SKILL.md');
    expect(text).toContain('cd "<worktree>" &&');
    expect(text).toContain('git -C "<worktree>"');
    expect(text).toMatch(/`timeout`[^\n]*`600000`/);
  });
  it('build commits with the HUSKY=0 prefix in the worktree', () => {
    const text = read('skills/build/SKILL.md');
    expect(text).toContain('`cd "<worktree>" && HUSKY=0 git commit');
  });
  it('build runs every check command with HUSKY=0 exported in the worktree', () => {
    const text = read('skills/build/SKILL.md');
    expect(text).toContain('`cd "<worktree>" && export HUSKY=0 && <check>`');
  });
  it('review reads the worktree read-only, matching the dispatch prompt (I3)', () => {
    const text = read('skills/review/SKILL.md');
    expect(text).toMatch(/spec, the diff[^\n]*worktree path/);
    expect(text).toContain('origin/');
  });
  it('spec reads the docs folder the prompt gives, if any, and reports an unreadable one (I6)', () => {
    const text = read('skills/spec/SKILL.md');
    expect(text).not.toContain('~/');
    expect(text).toMatch(/docs folder the prompt gives, if any/);
    expect(text).toMatch(/cannot be read[^\n]*summary[^\n]*spec/);
  });
  it('spec returns blocked when the answer asks to cancel, and writes no spec', () => {
    const text = read('skills/spec/SKILL.md');
    expect(text).toMatch(/asks to cancel or drop the task[^\n]*`blocked`[^\n]*The answer asks to cancel; please cancel T-n on the Board[^\n]*(no|don't write a|do not write a) spec/i);
  });
});

describe('reply-format skill', () => {
  const text = read('skills/reply-format/SKILL.md');
  const examples = [...text.matchAll(/```reply-example (\w+)\n([\s\S]*?)\n```/g)].map((m) => ({ step: m[1], body: m[2] }));

  it('has a reply example for spec, verify, review and build', () => {
    expect(examples.map((e) => e.step).sort()).toEqual(['build', 'review', 'spec', 'verify']);
    expect(text).not.toMatch(/```reply-example\n/);
  });
  for (const { step, body } of examples) {
    it(`the ${step} example parses as done`, () => {
      expect(Object.keys(AGENT_FOR)).toContain(step);
      const r = parseAgentReply(body, step);
      expect(r.status).toBe('done');
      if (step === 'build') expect(r.doc).toBeUndefined();
      else expect(r.doc).toBeTruthy();
      if (step === 'verify') expect(r.verdict).toBe('pass');
      if (step === 'review') expect(r.verdict).toBe('changes');
    });
  }
  it('says at most one doc block everywhere, never exactly one', () => {
    expect(text).not.toMatch(/exactly one `<factory-doc>`/);
    expect(text).not.toMatch(/exactly one doc/i);
    expect(text).toMatch(/at most one `<factory-doc>` block/);
  });
});
