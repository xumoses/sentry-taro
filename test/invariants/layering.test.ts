// ADR-0003 and ADR-0005: dependency direction between source layers and the
// third-party modules each layer may load.
import { describe, expect, test } from 'vite-plus/test';
import { importsOf, layerOf, packageName, sourceFiles } from './helpers';

const RUNTIME_PACKAGES = new Set([
  '@sentry/core',
  'fflate',
  '@tarojs/runtime',
  '@tarojs/taro',
  'react',
]);

function violations(dir: string, check: (file: string, specifier: string) => string | undefined) {
  const found: string[] = [];
  for (const file of sourceFiles(dir)) {
    for (const specifier of importsOf(file)) {
      const problem = check(file, specifier);
      if (problem) found.push(`${file}: ${specifier} (${problem})`);
    }
  }
  return found;
}

describe('layer dependency direction', () => {
  test('error monitoring (src/sdk) does not depend on Replay or the build plugin', () => {
    expect(
      violations('src/sdk', (file, specifier) => {
        const layer = layerOf(file, specifier);
        return layer && layer !== 'sdk' ? `imports ${layer}` : undefined;
      }),
    ).toEqual([]);
  });

  test('Replay depends only on itself and src/sdk', () => {
    expect(
      violations('src/replay', (file, specifier) => {
        const layer = layerOf(file, specifier);
        return layer && layer !== 'replay' && layer !== 'sdk' ? `imports ${layer}` : undefined;
      }),
    ).toEqual([]);
  });

  test('the build plugin does not import runtime layers', () => {
    expect(
      violations('src/taro-plugin', (file, specifier) => {
        const layer = layerOf(file, specifier);
        return layer && layer !== 'taro-plugin' ? `imports ${layer}` : undefined;
      }),
    ).toEqual([]);
  });
});

describe('runtime third-party modules', () => {
  test.each(['src/sdk', 'src/replay'])('%s loads only core, fflate, Taro and React', (dir) => {
    expect(
      violations(dir, (_file, specifier) => {
        const name = packageName(specifier);
        if (!name) return undefined;
        if (name === 'node:') return 'Node.js builtin in mini-program runtime';
        return RUNTIME_PACKAGES.has(name) ? undefined : 'not an allowed runtime package';
      }),
    ).toEqual([]);
  });
});
