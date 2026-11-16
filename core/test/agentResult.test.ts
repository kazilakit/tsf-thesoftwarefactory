import { describe, expect, test } from 'vitest';
import { parseAgentResult } from '../src/agentResult.js';

describe('parseAgentResult', () => {
  test.each([
    [undefined, 'missing'],
    ['not json', 'JSON'],
    ['{"status":"ok","summary":"x"}', 'status'],
    ['{"status":"done","summary":"x"}', 'doc'],
    ['{"status":"done","summary":"x","doc":"d"}', 'verdict'],
  ])('bad input %s fails cleanly', (raw, reason) => {
    const r = parseAgentResult(raw, 'review');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(new RegExp(`^invalid agent result: .*${reason}`, 'i'));
  });

  test('valid review result passes through', () => {
    expect(
      parseAgentResult(
        '{"status":"done","summary":"ok","doc":"# Review","verdict":"approve","turns":12,"costUsd":0.4,"extra":1}',
        'review',
      ),
    ).toEqual({ status: 'done', summary: 'ok', doc: '# Review', verdict: 'approve', turns: 12, costUsd: 0.4 });
  });

  test('build done needs no doc or verdict', () => {
    expect(parseAgentResult('{"status":"done","summary":"3 commits"}', 'build').status).toBe('done');
  });

  test('review verdict pass is invalid', () => {
    const r = parseAgentResult('{"status":"done","summary":"x","doc":"d","verdict":"pass"}', 'review');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/^invalid agent result: .*verdict/i);
  });

  test('verify accepts pass/fail only', () => {
    const ok = parseAgentResult('{"status":"done","summary":"x","doc":"d","verdict":"fail"}', 'verify');
    expect(ok.status).toBe('done');
    const bad = parseAgentResult('{"status":"done","summary":"x","doc":"d","verdict":"approve"}', 'verify');
    expect(bad.status).toBe('failed');
  });

  test('spec and plan done need a doc', () => {
    expect(parseAgentResult('{"status":"done","summary":"x"}', 'spec').status).toBe('failed');
    expect(parseAgentResult('{"status":"done","summary":"x"}', 'plan').status).toBe('failed');
    expect(parseAgentResult('{"status":"done","summary":"x","doc":"d"}', 'plan').status).toBe('done');
  });

  test('blocked and failed need no doc; question is kept', () => {
    expect(parseAgentResult('{"status":"blocked","summary":"s","question":"why?"}', 'review')).toEqual({
      status: 'blocked',
      summary: 's',
      question: 'why?',
    });
    expect(parseAgentResult('{"status":"failed","summary":"s"}', 'verify').status).toBe('failed');
  });

  test.each([
    '{"status":"done","summary":"x","turns":-1}',
    '{"status":"done","summary":"x","costUsd":-0.1}',
    '{"status":"done","summary":"x","turns":"3"}',
    '{"status":"done","summary":"x","question":5}',
    '{"status":"done"}',
    '[]',
    'null',
    '"str"',
    '',
  ])('rejects malformed %s without throwing', (raw) => {
    const r = parseAgentResult(raw, 'build');
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/^invalid agent result: /);
  });
});
