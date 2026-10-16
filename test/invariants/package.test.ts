// ADR-0001 single package, ADR-0004 artifact formats and the exact-pin
// toolchain policy. Changing any expectation here requires an ADR update first.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';
import { readJson, readText, root } from './helpers';

const pkg = readJson('package.json');
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe('ADR-0001: one published package', () => {
  test('publishes only @xumoses/sentry-taro', () => {
    expect(pkg.name).toBe('@xumoses/sentry-taro');
    expect(pkg.private).toBeUndefined();
  });

  test('keeps a single source tree without internal workspace packages', () => {
    expect(existsSync(join(root, 'packages'))).toBe(false);
    expect(readText('pnpm-workspace.yaml')).not.toMatch(/^packages\s*:/m);
  });
});

describe('official Sentry baseline', () => {
  test('pins @sentry/core to the 10.76.2 alignment baseline', () => {
    expect(pkg.dependencies['@sentry/core']).toBe('10.76.2');
  });

  test('runtime dependencies stay within core and fflate', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@sentry/core', 'fflate']);
  });
});

describe('ADR-0003: no browser emulation or browser Replay', () => {
  test.each(['@sentry/browser', '@sentry-internal/replay', 'rrweb', 'jsdom', 'happy-dom'])(
    '%s is not a runtime or peer dependency',
    (name) => {
      expect(pkg.dependencies[name]).toBeUndefined();
      expect(pkg.peerDependencies[name]).toBeUndefined();
    },
  );
});

describe('ADR-0004: ESM first, CJS compatible, standalone Worker, no UMD', () => {
  test('declares no UMD or browser-global entry fields', () => {
    for (const field of ['browser', 'unpkg', 'jsdelivr', 'umd:main']) {
      expect(pkg[field], field).toBeUndefined();
    }
    expect(JSON.stringify(pkg.exports)).not.toMatch(/umd|iife/i);
  });

  test('every module export offers types, ESM and CJS', () => {
    for (const [subpath, target] of Object.entries<any>(pkg.exports)) {
      if (typeof target === 'string') continue;
      expect(Object.keys(target), subpath).toEqual(['types', 'import', 'require']);
      expect(target.import, subpath).toMatch(/\.mjs$/);
      expect(target.require, subpath).toMatch(/\.cjs\.js$/);
    }
    expect(pkg.main).toMatch(/\.cjs\.js$/);
    expect(pkg.module).toMatch(/\.mjs$/);
  });

  test('ships the standalone Worker export', () => {
    expect(pkg.exports['./worker']).toBe('./dist/worker/replay-compression.js');
  });

  test('does not declare the root package side-effect free', () => {
    expect(pkg.sideEffects).not.toBe(false);
  });
});

describe('exact version pinning', () => {
  test.each(['dependencies', 'devDependencies'])('%s use exact versions', (field) => {
    for (const [name, version] of Object.entries<string>(pkg[field])) {
      const exact = version.replace(/^npm:(?:@[^/]+\/)?[^@]+@/, '');
      expect(exact, `${field}.${name}`).toMatch(EXACT_VERSION);
    }
  });

  test('pins the package manager and Node.js versions', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(readText('.node-version').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
