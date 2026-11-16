import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentReply } from '../../core/src/agentReply.ts';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(pluginDir, rel), 'utf8');
const rf = read('skills/reply-format/SKILL.md');
const blockedHeading = '## When to return `blocked`';

describe('reply-format question shape', () => {
  it('gives 2 to 4 lettered options', () => {
    expect(rf).toMatch(/2 to 4/);
    expect(rf).toMatch(/lettered/);
    expect(rf).toMatch(/A\./);
  });
  it('marks exactly one option (recommended), listed first', () => {
    expect(rf).toMatch(/exactly one/i);
    expect(rf).toMatch(/\(recommended\)/);
    expect(rf).toMatch(/listed first/);
  });
  it('owner may answer with a letter or free text', () => {
    expect(rf).toMatch(/option letter/i);
    expect(rf).toMatch(/own words|free text/i);
  });
  it('has a worked example', () => {
    const m = rf.match(/Question example[^\n]*\n+```text\n([\s\S]*?)\n```/);
    expect(m).not.toBeNull();
    const ex = m[1];
    const opts = ex.match(/^[A-D]\. /gm) || [];
    expect(opts.length).toBeGreaterThanOrEqual(2);
    expect(opts.length).toBeLessThanOrEqual(4);
    const rec = ex.split('\n').filter((l) => l.includes('(recommended)'));
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatch(/^A\. /);
    expect(ex).not.toMatch(/factory-result|factory-doc/);
  });
  it('still one question and no doc', () => {
    expect(rf).toMatch(/one question/);
    expect(rf).toMatch(/A `blocked` reply needs no doc\./);
  });
});

describe('stage skills point to the shape', () => {
  for (const stage of ['spec', 'plan', 'build', 'verify', 'review']) {
    it(`${stage} blocked section`, () => {
      const t = read(`skills/${stage}/SKILL.md`);
      const sec = t.split(blockedHeading)[1] || '';
      expect(sec).toMatch(/reply-format/);
      expect(sec).toMatch(/options/);
      expect(sec).toMatch(/recommend/i);
    });
  }
  it('spec cancel question unchanged and exempt', () => {
    const t = read('skills/spec/SKILL.md');
    expect(t).toContain('reply `blocked` with the question "The answer asks to cancel; please cancel T-n on the Board"');
    const sec = t.split(blockedHeading)[1] || '';
    expect(sec).toMatch(/exempt/i);
  });
});

describe('core schema', () => {
  it('parses a multi-line blocked question', () => {
    const open = '<factory-' + 'result>';
    const close = '</factory-' + 'result>';
    const body = open + '\n{"status":"blocked","summary":"s","question":"Q?\\nA. x (recommended)\\nB. y"}\n' + close;
    const r = parseAgentReply(body, 'spec');
    expect(r.status).toBe('blocked');
    expect(r.question).toBe('Q?\nA. x (recommended)\nB. y');
  });
});
