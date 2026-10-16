import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

export interface SentryBuildIdentity {
  name?: string;
  dist?: string;
}

/** Public build identity only. Credentials and upload configuration are never serialized. */
export interface SentryBuildMetadata {
  release?: string;
  dist?: string;
  commit?: string;
}

export interface CreateSentryBuildMetadataOptions {
  projectDir: string;
  release?: SentryBuildIdentity;
  env?: Record<string, string | undefined>;
  /** Optional revision provider for build systems that do not have the Git executable. */
  readRevision?: () => string | undefined;
}

export interface WriteSentryBuildMetadataOptions {
  metadata: SentryBuildMetadata;
  outputRoot: string;
  /** Modules also write JSON so upload tooling never executes generated JavaScript. */
  format?: 'json' | 'module';
}

export interface ReadSentryBuildMetadataOptions {
  outputRoot: string;
  expected?: SentryBuildIdentity;
}

export interface WriteReplayWorkerOptions {
  /** Resolve the installed SDK from this application, not the build tool's own dependencies. */
  projectDir: string;
  /** Defaults to projectDir/workers. Relative paths are resolved against projectDir. */
  outputRoot?: string;
  /** A single file name within outputRoot. Defaults to sentry-replay.js. */
  filename?: string;
}

function directory(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty directory path`);
  }
  return resolve(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateIdentity(value: unknown, label: 'release' | 'dist'): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    hasControlCharacters(value) ||
    (label === 'release' &&
      (value.length > 200 || /[/\\]/.test(value) || value === '.' || value === '..'))
  ) {
    throw new Error(`Invalid Sentry ${label} identity`);
  }
}

function validateCommit(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) {
    throw new Error('Sentry build metadata requires an exact Git commit SHA');
  }
}

function validateBuildIdentity(value: unknown): asserts value is SentryBuildIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sentry build identity must be an options object');
  }
  const identity = value as Record<string, unknown>;
  for (const key of Object.keys(identity)) {
    if (key !== 'name' && key !== 'dist') {
      throw new Error('Sentry build identity contains an unsupported field');
    }
  }
  if (identity.name !== undefined) validateIdentity(identity.name, 'release');
  if (identity.dist !== undefined) validateIdentity(identity.dist, 'dist');
}

function metadataCopy(value: unknown): SentryBuildMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sentry build metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['release', 'dist', 'commit'].includes(key)) {
      throw new Error('Sentry build metadata contains an unsupported field');
    }
  }
  const result: SentryBuildMetadata = {};
  if (record.release !== undefined) {
    validateIdentity(record.release, 'release');
    result.release = record.release;
  }
  if (record.dist !== undefined) {
    validateIdentity(record.dist, 'dist');
    result.dist = record.dist;
  }
  if (record.commit !== undefined) {
    validateCommit(record.commit);
    result.commit = record.commit;
  }
  return result;
}

function optionalRevision(read: () => string | undefined): string | undefined {
  try {
    return read()?.trim() || undefined;
  } catch {
    // Like official bundler plugins, absence of a Git checkout does not prevent a build.
    return undefined;
  }
}

/** Resolve once per artifact. Uploads must read the saved metadata instead of resolving again. */
export function createSentryBuildMetadata(
  options: CreateSentryBuildMetadataOptions,
): SentryBuildMetadata {
  const projectDir = directory(options.projectDir, 'projectDir');
  if (options.release !== undefined) validateBuildIdentity(options.release);
  const env = options.env || process.env;
  const commit =
    env.CI_COMMIT_SHA ||
    env.GITHUB_SHA ||
    env.CIRCLE_SHA1 ||
    env.BITBUCKET_COMMIT ||
    env.BUILD_SOURCEVERSION ||
    optionalRevision(
      options.readRevision ||
        (() =>
          execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: projectDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })),
    );
  const release = options.release?.name ?? (env.SENTRY_RELEASE || commit);
  const dist = options.release?.dist ?? (env.SENTRY_DIST || undefined);
  return metadataCopy({
    ...(release !== undefined ? { release } : {}),
    ...(dist !== undefined ? { dist } : {}),
    ...(commit !== undefined ? { commit } : {}),
  });
}

function assertRegularTarget(path: string): void {
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error('Sentry build output must be a regular file, not a directory or symlink');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function writeAtomically(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Save the exact identity consumed by runtime and subsequent source-map upload. */
export function writeSentryBuildMetadata(
  options: WriteSentryBuildMetadataOptions,
): SentryBuildMetadata {
  const metadata = metadataCopy(options.metadata);
  const outputRoot = directory(options.outputRoot, 'outputRoot');
  if (options.format !== undefined && !['json', 'module'].includes(options.format)) {
    throw new Error('Sentry build metadata format must be json or module');
  }
  const jsonPath = join(outputRoot, 'sentry-build.json');
  const modulePath = join(outputRoot, 'sentry-build.js');
  assertRegularTarget(jsonPath);
  assertRegularTarget(modulePath);
  mkdirSync(outputRoot, { recursive: true });
  // JSON permits literal Unicode line separators, while older mini-program JS parsers do not.
  const serialized = JSON.stringify(metadata)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  if (options.format === 'module') {
    writeAtomically(
      modulePath,
      `// Generated for this artifact; shared by runtime and source-map upload.\nmodule.exports = ${serialized};\n`,
    );
  } else {
    // Switching formats must not leave a module containing an older build identity.
    rmSync(modulePath, { force: true });
  }
  writeAtomically(jsonPath, `${serialized}\n`);
  return metadata;
}

/** Read data only; never require() generated build output during an upload. */
export function readSentryBuildMetadata(
  options: ReadSentryBuildMetadataOptions,
): SentryBuildMetadata {
  if (options.expected !== undefined) validateBuildIdentity(options.expected);
  const path = join(directory(options.outputRoot, 'outputRoot'), 'sentry-build.json');
  assertRegularTarget(path);
  const metadata = metadataCopy(JSON.parse(readFileSync(path, 'utf8')));
  for (const [option, field] of [
    ['name', 'release'],
    ['dist', 'dist'],
  ] as const) {
    const expected = options.expected?.[option];
    if (expected === undefined) continue;
    validateIdentity(expected, field);
    if (metadata[field] !== expected) {
      throw new Error(`Sentry ${field} does not match the identity saved in the build artifact`);
    }
  }
  return metadata;
}

/** Copy the application's exact installed Worker, without loading the main-thread npm bundle. */
export function writeReplayWorker(options: WriteReplayWorkerOptions): string {
  const projectDir = directory(options.projectDir, 'projectDir');
  const outputRoot =
    options.outputRoot === undefined
      ? join(projectDir, 'workers')
      : directory(resolve(projectDir, options.outputRoot), 'outputRoot');
  if (options.outputRoot !== undefined && !options.outputRoot.trim()) {
    throw new Error('outputRoot must be a nonempty directory path');
  }
  const filename = options.filename ?? 'sentry-replay.js';
  if (
    typeof filename !== 'string' ||
    !filename.trim() ||
    filename === '.' ||
    filename === '..' ||
    /[/\\:]/.test(filename) ||
    hasControlCharacters(filename)
  ) {
    throw new Error('Replay Worker filename must be a single file name within outputRoot');
  }
  const target = join(outputRoot, filename);
  assertRegularTarget(target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let sourceIsTarget = false;
  try {
    const source = createRequire(join(projectDir, 'package.json')).resolve(
      '@xumoses/sentry-taro/worker',
    );
    let existingTarget: string | undefined;
    try {
      existingTarget = realpathSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    sourceIsTarget = realpathSync(source) === existingTarget;
    if (sourceIsTarget)
      throw new Error('Replay Worker output must not replace its installed source');
    if (!readFileSync(source, 'utf8').trim()) throw new Error('Replay compression Worker is empty');
    mkdirSync(outputRoot, { recursive: true });
    copyFileSync(source, temporary);
    renameSync(temporary, target);
    return target;
  } catch (error) {
    // A failed rebuild cannot leave an older SDK's Worker in an otherwise new artifact.
    if (!sourceIsTarget) rmSync(target, { force: true });
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * For miniprogram-ci packNpmManually when using the SDK's self-contained native entry.
 * Do not apply globally when the application separately imports these Sentry packages.
 */
export function getSentryMiniProgramNpmIgnores(): string[] {
  return [
    'node_modules/@sentry/core/**',
    'node_modules/@sentry/conventions/**',
    'node_modules/@xumoses/sentry-taro/node_modules/@sentry/core/**',
  ];
}
