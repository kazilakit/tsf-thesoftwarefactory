import { describe, expect, test } from 'vitest';
import { parseAgentReply } from '../src/agentReply.js';

const result = (o: object) => `<factory-result>\n${JSON.stringify(o)}\n</factory-result>`;
const doc = (d: string) => `<factory-doc>\n${d}\n</factory-doc>`;

describe('parseAgentReply', () => {
  test('a done spec reply with a doc block carries the trimmed doc', () => {
    const r = parseAgentReply(`${result({ status: 'done', summary: 's' })}\n${doc('# Spec\n\nbody')}`, 'spec');
    expect(r).toEqual({ status: 'done', summary: 's', doc: '# Spec\n\nbody' });
  });

  test('text before and after the tags still parses', () => {
    const r = parseAgentReply(`Here you go.\n${result({ status: 'done', summary: 's' })}\n${doc('# P')}\nThanks!`, 'plan');
    expect(r).toMatchObject({ status: 'done', doc: '# P' });
  });

  test('a build reply needs no doc block', () => {
    expect(parseAgentReply(result({ status: 'done', summary: 'built' }), 'build')).toEqual({ status: 'done', summary: 'built' });
  });

  test('a missing result block fails', () => {
    const r = parseAgentReply('just prose', 'spec');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/^invalid agent result: no <factory-result> block/);
  });

  test('broken JSON fails', () => {
    const r = parseAgentReply('<factory-result>{nope</factory-result>', 'spec');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/not valid JSON/);
  });

  test('doc inside the JSON fails', () => {
    const r = parseAgentReply(result({ status: 'done', summary: 's', doc: 'x' }), 'spec');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/doc belongs in <factory-doc>/);
  });

  test('a done review with an empty doc block fails', () => {
    const r = parseAgentReply(`${result({ status: 'done', summary: 's', verdict: 'approve' })}\n<factory-doc>\n \n</factory-doc>`, 'review');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/done review result needs a doc/);
  });

  test('a blocked reply keeps its question', () => {
    expect(parseAgentReply(result({ status: 'blocked', summary: 's', question: 'which API?' }), 'spec')).toEqual({
      status: 'blocked', summary: 's', question: 'which API?',
    });
  });

  test('two result blocks fail', () => {
    const r = parseAgentReply(`${result({ status: 'done', summary: 'a' })}${result({ status: 'done', summary: 'b' })}`, 'build');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/more than one <factory-result> block/);
  });

  test('undefined fails', () => {
    expect(parseAgentReply(undefined, 'spec').status).toBe('failed');
  });
});
