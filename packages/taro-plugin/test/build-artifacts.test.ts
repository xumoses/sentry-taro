import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import {
  createSentryBuildMetadata,
  getSentryMiniProgramNpmIgnores,
  readSentryBuildMetadata,
  writeReplayWorker,
  writeSentryBuildMetadata,
} from '../src/build-artifacts';

const directories: string[] = [];
const commit = 'a'.repeat(40);
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sentry-taro-build-artifacts-'));
  directories.push(root);
  for (const [path, value] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }
  return root;
}

function installedWorker(source = 'worker.onMessage(() => {});\n'): string {
  return fixture({
    'package.json': '{}',
    'node_modules/@xumoses/sentry-taro/package.json': JSON.stringify({
      name: '@xumoses/sentry-taro',
      exports: { './worker': './worker.js' },
    }),
    'node_modules/@xumoses/sentry-taro/worker.js': source,
  });
}

describe('build identity', () => {
  test('resolves explicit identity before environment values without imposing a naming policy', () => {
    const release = Object.freeze({ name: 'sample@1.0.0', dist: 'build-12' });
    const env = Object.freeze({
      SENTRY_RELEASE: 'ignored',
      SENTRY_DIST: 'ignored',
      CI_COMMIT_SHA: commit,
    });
    const readRevision = vi.fn(() => 'b'.repeat(40));
    expect(
      createSentryBuildMetadata({ projectDir: fixture(), release, env, readRevision }),
    ).toEqual({
      release: 'sample@1.0.0',
      dist: 'build-12',
      commit,
    });
    expect(readRevision).not.toHaveBeenCalled();
  });

  test('uses environment identity, then CI or Git revision, without inventing dist', () => {
    const projectDir = fixture();
    expect(
      createSentryBuildMetadata({
        projectDir,
        env: { SENTRY_RELEASE: 'env-release', SENTRY_DIST: '42' },
        readRevision: () => commit,
      }),
    ).toEqual({ release: 'env-release', dist: '42', commit });
    expect(createSentryBuildMetadata({ projectDir, env: { CI_COMMIT_SHA: commit } })).toEqual({
      release: commit,
      commit,
    });
    expect(
      createSentryBuildMetadata({ projectDir, env: {}, readRevision: () => `${commit}\n` }),
    ).toEqual({ release: commit, commit });
    expect(createSentryBuildMetadata({ projectDir, env: { GITHUB_SHA: commit } })).toEqual({
      release: commit,
      commit,
    });
  });

  test('supports explicit releases outside a Git checkout and omits unresolvable identities', () => {
    const projectDir = fixture();
    const readRevision = () => {
      throw new Error('Git unavailable');
    };
    expect(createSentryBuildMetadata({ projectDir, env: {}, readRevision })).toEqual({});
    expect(
      createSentryBuildMetadata({ projectDir, release: { name: 'manual' }, env: {}, readRevision }),
    ).toEqual({ release: 'manual' });
    expect(
      createSentryBuildMetadata({ projectDir, env: {}, readRevision: () => undefined }),
    ).toEqual({});
  });

  test.each(['', '  ', '.', '..', 'bad/release', 'bad\\release', 'bad\nrelease', 'x'.repeat(201)])(
    'rejects invalid release identity %j rather than silently falling back',
    (name) => {
      expect(() =>
        createSentryBuildMetadata({
          projectDir: fixture(),
          release: { name },
          env: { CI_COMMIT_SHA: commit },
        }),
      ).toThrow('Invalid Sentry release');
    },
  );

  test('rejects invalid dist and abbreviated commit identities', () => {
    expect(() =>
      createSentryBuildMetadata({
        projectDir: fixture(),
        release: { dist: '\n' },
        env: { CI_COMMIT_SHA: commit },
      }),
    ).toThrow('Invalid Sentry dist');
    expect(() =>
      createSentryBuildMetadata({ projectDir: fixture(), env: { CI_COMMIT_SHA: 'abc123' } }),
    ).toThrow('exact Git commit');
  });

  test('rejects invalid explicit identity values instead of replacing them with environment defaults', () => {
    const projectDir = fixture();
    for (const release of [
      null,
      [],
      'invalid',
      { name: null },
      { dist: null },
      { typo: 'value' },
    ]) {
      expect(() =>
        createSentryBuildMetadata({
          projectDir,
          release: release as unknown as { name?: string; dist?: string },
          env: { SENTRY_RELEASE: 'must-not-fallback', SENTRY_DIST: '42' },
        }),
      ).toThrow();
    }
    const outputRoot = fixture();
    writeSentryBuildMetadata({ metadata: { release: 'saved' }, outputRoot });
    expect(() =>
      readSentryBuildMetadata({
        outputRoot,
        expected: { name: null } as unknown as { name: string },
      }),
    ).toThrow('Invalid Sentry release');
  });

  test('round-trips frozen identity through JSON and never evaluates a neighboring module', () => {
    const outputRoot = fixture();
    const metadata = Object.freeze({ release: 'sample@1.0.0', dist: '42', commit });
    expect(writeSentryBuildMetadata({ metadata, outputRoot })).toEqual(metadata);
    writeFileSync(join(outputRoot, 'sentry-build.js'), 'throw new Error("must not execute");');
    expect(
      readSentryBuildMetadata({
        outputRoot,
        expected: { name: metadata.release, dist: metadata.dist },
      }),
    ).toEqual(metadata);
    expect(() => readSentryBuildMetadata({ outputRoot, expected: { name: 'other' } })).toThrow(
      'does not match',
    );
    expect(() => readSentryBuildMetadata({ outputRoot, expected: { dist: '43' } })).toThrow(
      'does not match',
    );
    expect(metadata).toEqual({ release: 'sample@1.0.0', dist: '42', commit });
  });

  test('writes runtime CJS and JSON with the exact same identity, and removes a stale module when switching formats', () => {
    const outputRoot = join(fixture(), 'nested', 'dist');
    const metadata = { release: 'quoted-"release', dist: '7', commit };
    writeSentryBuildMetadata({ metadata, outputRoot, format: 'module' });
    const sandbox = { module: { exports: {} } };
    runInNewContext(readFileSync(join(outputRoot, 'sentry-build.js'), 'utf8'), sandbox);
    expect(sandbox.module.exports).toEqual(metadata);
    expect(readSentryBuildMetadata({ outputRoot })).toEqual(metadata);
    writeSentryBuildMetadata({ metadata: { release: 'next' }, outputRoot });
    expect(existsSync(join(outputRoot, 'sentry-build.js'))).toBe(false);
    expect(readSentryBuildMetadata({ outputRoot })).toEqual({ release: 'next' });
    expect(readdirSync(outputRoot)).toEqual(['sentry-build.json']);
  });

  test('requires expected dist even when absent from the artifact and does not regenerate from environment', () => {
    const outputRoot = fixture();
    writeSentryBuildMetadata({ metadata: { release: 'saved' }, outputRoot });
    vi.stubEnv('SENTRY_RELEASE', 'different-now');
    try {
      expect(readSentryBuildMetadata({ outputRoot })).toEqual({ release: 'saved' });
      expect(() => readSentryBuildMetadata({ outputRoot, expected: { dist: '42' } })).toThrow(
        'does not match',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('keeps Unicode identity data exact while producing syntax accepted by older mini-program parsers', () => {
    const outputRoot = fixture();
    const metadata = { release: 'sample\u2028build', dist: 'build\u2029number' };
    writeSentryBuildMetadata({ metadata, outputRoot, format: 'module' });
    const source = readFileSync(join(outputRoot, 'sentry-build.js'), 'utf8');
    expect(() => parse(source, { ecmaVersion: 2015 })).not.toThrow();
    const sandbox = { module: { exports: {} } };
    runInNewContext(source, sandbox);
    expect(sandbox.module.exports).toEqual(metadata);
    expect(readSentryBuildMetadata({ outputRoot })).toEqual(metadata);
  });

  test('rejects malformed metadata without serializing extra configuration or altering existing artifacts', () => {
    const outputRoot = fixture();
    writeSentryBuildMetadata({ metadata: { release: 'saved' }, outputRoot });
    const extra = { release: 'next', privateConfiguration: 'not public metadata' };
    expect(() => writeSentryBuildMetadata({ metadata: extra, outputRoot })).toThrow(
      'unsupported field',
    );
    expect(readSentryBuildMetadata({ outputRoot })).toEqual({ release: 'saved' });
    writeFileSync(join(outputRoot, 'sentry-build.json'), '["invalid"]');
    expect(() => readSentryBuildMetadata({ outputRoot })).toThrow('must be an object');
    writeFileSync(join(outputRoot, 'sentry-build.json'), '{"release":7}');
    expect(() => readSentryBuildMetadata({ outputRoot })).toThrow('Invalid Sentry release');
  });

  test('does not overwrite a symlink target or treat JavaScript as JSON metadata', () => {
    const outputRoot = fixture();
    const outside = join(fixture(), 'identity.json');
    writeFileSync(outside, '{"release":"outside"}');
    symlinkSync(outside, join(outputRoot, 'sentry-build.json'));
    expect(() => writeSentryBuildMetadata({ metadata: { release: 'new' }, outputRoot })).toThrow(
      'regular file',
    );
    expect(() => readSentryBuildMetadata({ outputRoot })).toThrow('regular file');
    expect(readFileSync(outside, 'utf8')).toBe('{"release":"outside"}');
    rmSync(join(outputRoot, 'sentry-build.json'));
    writeFileSync(join(outputRoot, 'sentry-build.json'), 'module.exports = {};');
    expect(() => readSentryBuildMetadata({ outputRoot })).toThrow();
  });
});

describe('standalone Worker artifacts', () => {
  test('copies the host-installed Worker byte for byte and refreshes it on rebuild', () => {
    const projectDir = installedWorker();
    const source = join(projectDir, 'node_modules/@xumoses/sentry-taro/worker.js');
    const target = writeReplayWorker({ projectDir });
    expect(target).toBe(join(projectDir, 'workers/sentry-replay.js'));
    expect(readFileSync(target)).toEqual(readFileSync(source));
    writeFileSync(source, 'worker.onMessage(() => "new version");');
    writeReplayWorker({ projectDir });
    expect(readFileSync(target)).toEqual(readFileSync(source));
    expect(readdirSync(dirname(target))).toEqual(['sentry-replay.js']);
  });

  test('supports a configured output root and filename', () => {
    const projectDir = installedWorker();
    expect(
      writeReplayWorker({ projectDir, outputRoot: 'dist/workers', filename: 'replay.js' }),
    ).toBe(join(projectDir, 'dist/workers/replay.js'));
  });

  test('removes a stale Worker if the installed source becomes empty', () => {
    const projectDir = installedWorker();
    const target = writeReplayWorker({ projectDir });
    writeFileSync(join(projectDir, 'node_modules/@xumoses/sentry-taro/worker.js'), ' \n');
    expect(() => writeReplayWorker({ projectDir })).toThrow('Worker is empty');
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dirname(target))).toEqual([]);
  });

  test('fails for a package without the Worker export and removes an older target', () => {
    const projectDir = fixture({
      'package.json': '{}',
      'node_modules/@xumoses/sentry-taro/package.json':
        '{"name":"@xumoses/sentry-taro","exports":{}}',
      'workers/sentry-replay.js': 'stale();',
    });
    expect(() => writeReplayWorker({ projectDir })).toThrow();
    expect(existsSync(join(projectDir, 'workers/sentry-replay.js'))).toBe(false);
  });

  test.each([
    '../outside.js',
    '/outside.js',
    'nested/replay.js',
    '..\\outside.js',
    '.',
    '..',
    '',
    'bad\0.js',
  ])('rejects escaping or invalid filenames %j before deleting anything', (filename) => {
    const projectDir = installedWorker();
    const outside = join(projectDir, 'outside.js');
    writeFileSync(outside, 'untouched();');
    expect(() => writeReplayWorker({ projectDir, filename })).toThrow('single file name');
    expect(readFileSync(outside, 'utf8')).toBe('untouched();');
  });

  test('rejects target symlinks and directories without touching their contents', () => {
    const projectDir = installedWorker();
    const outputRoot = join(projectDir, 'workers');
    mkdirSync(outputRoot);
    const outside = join(fixture(), 'outside.js');
    writeFileSync(outside, 'untouched();');
    symlinkSync(outside, join(outputRoot, 'sentry-replay.js'));
    expect(() => writeReplayWorker({ projectDir })).toThrow('regular file');
    expect(readFileSync(outside, 'utf8')).toBe('untouched();');
    rmSync(join(outputRoot, 'sentry-replay.js'));
    mkdirSync(join(outputRoot, 'sentry-replay.js'));
    writeFileSync(join(outputRoot, 'sentry-replay.js/keep'), 'keep');
    expect(() => writeReplayWorker({ projectDir })).toThrow('regular file');
    expect(readFileSync(join(outputRoot, 'sentry-replay.js/keep'), 'utf8')).toBe('keep');
  });

  test('refuses to overwrite or remove the installed source Worker', () => {
    const projectDir = installedWorker();
    const outputRoot = join(projectDir, 'node_modules/@xumoses/sentry-taro');
    expect(() => writeReplayWorker({ projectDir, outputRoot, filename: 'worker.js' })).toThrow(
      'installed source',
    );
    expect(readFileSync(join(outputRoot, 'worker.js'), 'utf8')).toBe(
      'worker.onMessage(() => {});\n',
    );
  });
});

test('returns isolated native packing ignores for the dependencies already bundled by the SDK', () => {
  const ignores = getSentryMiniProgramNpmIgnores();
  expect(ignores).toContain('node_modules/@sentry/core/**');
  expect(ignores).toContain('node_modules/@sentry/conventions/**');
  expect(ignores).toContain('node_modules/@xumoses/sentry-taro/node_modules/@sentry/core/**');
  ignores.push('caller-specific/**');
  expect(getSentryMiniProgramNpmIgnores()).not.toContain('caller-specific/**');
});
