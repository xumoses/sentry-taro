// ADR-0004: library build formats and the mini-program syntax floor.
import { describe, expect, test } from 'vite-plus/test';
import { pack } from '../../config/pack';

const formatsOf = (config: (typeof pack)[number]): string[] =>
  [config.format ?? []].flat().map(String);

describe('ADR-0004: library build', () => {
  test('only builds ESM and CJS, never UMD or IIFE', () => {
    for (const config of pack) {
      for (const format of formatsOf(config)) {
        expect(['esm', 'cjs'], `${config.name}: ${format}`).toContain(format);
      }
    }
  });

  test('mini-program runtime bundles target ES2015', () => {
    const runtime = pack.filter((config) => config.platform !== 'node');
    expect(runtime.map((config) => config.name).sort()).toEqual(['adapters', 'sdk-cjs', 'sdk-esm']);
    for (const config of runtime) expect(config.target, config.name).toBe('es2015');
  });

  test('the ESM root keeps fflate external and the CJS root is self-contained', () => {
    const esm = pack.find((config) => config.name === 'sdk-esm');
    const cjs = pack.find((config) => config.name === 'sdk-cjs');
    expect(esm?.deps?.onlyImport).toEqual(['fflate']);
    expect(cjs?.deps?.alwaysBundle).toEqual(expect.arrayContaining(['@sentry/core', 'fflate']));
  });
});
