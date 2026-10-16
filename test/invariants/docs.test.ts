// Keeps the always-loaded agent rules connected to the decision records.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';
import { readText, root } from './helpers';

const adrs = readdirSync(join(root, 'docs/adr'))
  .filter((name) => /^\d{4}-.+\.md$/.test(name))
  .sort();

describe('decision records stay discoverable', () => {
  test('ADRs exist', () => {
    expect(adrs.length).toBeGreaterThan(0);
  });

  test.each(adrs)('%s is linked from docs/README.md and AGENTS.md', (name) => {
    expect(readText('docs/README.md')).toContain(`./adr/${name}`);
    expect(readText('AGENTS.md')).toContain(`./docs/adr/${name}`);
  });

  test('CLAUDE.md loads AGENTS.md', () => {
    expect(readText('CLAUDE.md')).toMatch(/^@AGENTS\.md$/m);
  });
});
