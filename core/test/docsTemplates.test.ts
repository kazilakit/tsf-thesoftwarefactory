import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { normaliseFactoryYaml } from '../src/factoryYaml.js';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'setup', 'factory-yaml.md');

/** The bodies of the fenced yaml blocks. */
function yamlBlocks(md: string): string[] {
  return [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

describe('docs/setup/factory-yaml.md', () => {
  test('each template in the doc normalises', () => {
    const blocks = yamlBlocks(readFileSync(DOC, 'utf8'));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const r = normaliseFactoryYaml(parse(block));
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  test('the templates are titled, and none uses the factory-app store', () => {
    const md = readFileSync(DOC, 'utf8');
    for (const t of ['Local + GitHub', 'Local, no board']) expect(md).toContain(`### ${t}`);
    for (const block of yamlBlocks(md)) expect(block).not.toContain('factory-app');
  });
});
