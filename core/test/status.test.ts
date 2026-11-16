import { expect, test } from 'vitest';
import { IllegalMoveError, STEP_STATUS, assertMove, canMove } from '../src/status.js';

test('core moves follow spec §5', () => {
  for (const [f, t] of [['ready','spec'],['spec','spec_review'],['spec','plan'],['spec_review','plan'],['spec_review','spec'],
    ['plan','plan_review'],['plan','build'],['plan_review','build'],['plan_review','plan'],['build','verify'],
    ['verify','review'],['verify','build'],['review','pr_open'],['review','build'],['review','done'],
    ['pr_open','done'],['pr_open','build'],['blocked','build'],['blocked','verify'],['spec','blocked'],['pr_open','blocked']] as const)
    expect(canMove(f, t, 'core')).toBe(true);
});
test('core may move blocked to ready; you may not', () => {
  expect(canMove('blocked', 'ready', 'core')).toBe(true);
  expect(canMove('blocked', 'ready', 'you')).toBe(false);
});
test('core cannot skip stages or leave terminal states', () => {
  expect(canMove('ready','build','core')).toBe(false);
  expect(canMove('spec','build','core')).toBe(false);
  expect(canMove('build','pr_open','core')).toBe(false);
  expect(canMove('done','blocked','core')).toBe(false);
  expect(canMove('inbox','ready','core')).toBe(false);
  expect(() => assertMove('spec','build','core')).toThrow(IllegalMoveError);
});
test('you can only mark ready and cancel', () => {
  expect(canMove('inbox','ready','you')).toBe(true);
  expect(canMove('build','cancelled','you')).toBe(true);
  expect(canMove('done','cancelled','you')).toBe(false);
  expect(canMove('spec_review','plan','you')).toBe(false);
});
test('STEP_STATUS maps core steps to their column', () => {
  expect(STEP_STATUS.check).toBe('verify');
  expect(STEP_STATUS.ship).toBe('review');
});
