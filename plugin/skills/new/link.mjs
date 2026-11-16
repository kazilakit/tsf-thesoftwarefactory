#!/usr/bin/env node
// Builds the Board link that opens the New task form pre-filled (/factory:new), for a Board page at FACTORY_BOARD_URL.
// No Board page ships with this repository: without FACTORY_BOARD_URL there is no link to build.
// Usage: node link.mjs <draft.json>   (draft: {title, description, factory, repo, base})
// Plain Node, no dependencies. The caps are the New task form's limits.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NO_BOARD = 'factory: no Board link (FACTORY_BOARD_URL is not set)';
// Factory and repo ids: the same shape the core uses. The Board checks that the repo is in the factory.
const ID = /^[a-z][a-z0-9-]{0,39}$/;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 8000;
const MAX_LINK = 8000;

const text = (value) => (typeof value === 'string' ? value : '');

export function buildLink(draft, boardUrl) {
  const repo = text(draft?.repo).trim();
  const factory = text(draft?.factory).trim();
  if (!ID.test(factory)) throw new Error(`factory: unknown factory ${text(draft?.factory)}`);
  if (!ID.test(repo)) throw new Error(`factory: unknown repo ${text(draft?.repo)}`);
  const base = text(draft?.base).trim();
  if (base === 'main') throw new Error('factory: the factory never targets main');
  const title = text(draft?.title);
  if (title.trim() === '') throw new Error('factory: title must not be blank');
  const params = new URLSearchParams({
    new: '1',
    title: title.slice(0, TITLE_MAX),
    description: text(draft?.description).slice(0, DESCRIPTION_MAX),
    factory,
    repo,
    base,
  });
  return `${boardUrl.replace(/\/+$/, '')}/?${params.toString()}`;
}

function main(file) {
  try {
    if (!file) throw new Error('factory: usage: node link.mjs <draft.json>');
    let draft;
    try {
      draft = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`factory: cannot read the draft: ${error.message}`);
    }
    const board = (process.env.FACTORY_BOARD_URL || '').trim();
    const link = buildLink(draft, board); // checks the draft first, so its errors come before the missing Board
    if (board === '') throw new Error(NO_BOARD);
    if (link.length > MAX_LINK) process.stderr.write('factory: long link; some browsers or proxies may refuse it — shorten the description\n');
    process.stdout.write(`${link}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main(process.argv[2]);
