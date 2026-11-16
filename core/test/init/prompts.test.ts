import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { PromptClosedError, readlinePrompter, scriptedPrompter } from '../../src/init/prompts.js';

describe('scriptedPrompter', () => {
  test('choose shows numbered options and re-asks on a bad number', async () => {
    const p = scriptedPrompter(['0', 'x', '3', '2']);
    const v = await p.choose('Pick one', [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]);
    expect(v).toBe('b');
    expect(p.transcript).toContain('  1. Alpha');
    expect(p.transcript).toContain('  2. Beta');
    expect(p.transcript.filter((l) => l === 'Enter a number from 1 to 2')).toHaveLength(3);
  });

  test('choose takes the default on an empty answer', async () => {
    const p = scriptedPrompter(['']);
    expect(await p.choose('Pick', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], { default: 'b' })).toBe('b');
  });

  test('ask re-asks with the validate message', async () => {
    const p = scriptedPrompter(['bad', 'good']);
    const v = await p.ask('Name', { validate: (x) => (x === 'good' ? null : 'must be good') });
    expect(v).toBe('good');
    expect(p.transcript).toContain('must be good');
  });

  test('ask takes the default on an empty answer and trims', async () => {
    const p = scriptedPrompter(['', '  hi  ']);
    expect(await p.ask('Id', { default: 'my-app' })).toBe('my-app');
    expect(await p.ask('Other')).toBe('hi');
  });

  test('confirm: empty is the default, y/n answers, anything else re-asks', async () => {
    const p = scriptedPrompter(['', 'maybe', 'n', 'YES']);
    expect(await p.confirm('Sure?', true)).toBe(true);
    expect(await p.confirm('Sure?', true)).toBe(false);
    expect(await p.confirm('Sure?', false)).toBe(true);
    expect(p.transcript).toContain('Answer y or n');
  });

  test('lines reads until an empty line', async () => {
    const p = scriptedPrompter(['a', ' b ', '']);
    expect(await p.lines('Links')).toEqual(['a', 'b']);
  });

  test('throws PromptClosedError when the answers run out', async () => {
    const p = scriptedPrompter([]);
    await expect(p.ask('Name')).rejects.toBeInstanceOf(PromptClosedError);
  });
});

describe('readlinePrompter', () => {
  test('reads answers from the input, including lines sent before the question', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = readlinePrompter(input, output);
    input.write('first\nsecond\n');
    expect(await p.ask('One')).toBe('first');
    expect(await p.ask('Two')).toBe('second');
    p.close();
  });

  test('readlinePrompter throws PromptClosedError when input ends', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = readlinePrompter(input, output);
    const pending = p.ask('Name');
    input.end();
    await expect(pending).rejects.toBeInstanceOf(PromptClosedError);
    await expect(p.ask('Again')).rejects.toBeInstanceOf(PromptClosedError);
  });

  test('close rejects a pending question', async () => {
    const input = new PassThrough();
    const p = readlinePrompter(input, new PassThrough());
    const pending = p.confirm('Sure?', true);
    p.close();
    await expect(pending).rejects.toBeInstanceOf(PromptClosedError);
  });

  test('on a terminal the question is the readline prompt, so a redraw (backspace) keeps it', async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    let out = '';
    output.on('data', (c: Buffer) => (out += c.toString()));
    const p = readlinePrompter(input, output);
    const pending = p.ask('Name');
    await new Promise((r) => setImmediate(r));
    input.write('ab');
    input.write('\x7f');
    input.write('c\r');
    expect(await pending).toBe('ac');
    const redraws = out.split('\x1b[1G\x1b[0J');
    expect(redraws.length).toBeGreaterThan(1);
    expect(redraws.at(-1)!.startsWith('Name: a')).toBe(true);
    p.close();
  });
});
