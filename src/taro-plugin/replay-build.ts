import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildReplayAssets } from './assets';

/** Taro-only resource preparation; these settings do not upload assets to Sentry. */
export interface ReplayBuildOptions {
  /** JSON for source-level SDK readers; modules for native-host require(). Defaults to json. */
  output?: 'json' | 'modules';
  /** Source directory containing trusted static assets. Defaults to Taro's source path. */
  sourceRoot?: string;
  /** Compiled mini-program directory. Defaults to Taro's output path. */
  outputRoot?: string;
  /** Native mini-program root, including its app.wxss. Defaults to outputRoot. */
  appRoot?: string;
  /** Runtime subpackage prefix, such as "mini/". Inferred from appRoot/outputRoot. */
  routePrefix?: string;
  /** Keep resource data compressed and read packaged images lazily. Defaults to true. */
  compactAssets?: boolean;
  /** Static image keys or path suffixes to prioritize before other images. */
  imagePriority?: string[];
}

export interface ReplayAssetsOptions {
  /** Disable all plugin functionality. Same convention as Sentry bundler plugins. */
  disable?: boolean;
  /** Suppress all plugin logs. Does not suppress thrown errors or caller logs. */
  silent?: boolean;
  /** Print resource counts and budget information. Defaults to false. */
  debug?: boolean;
  /** By default errors stop the build. Returning normally from this callback permits it. */
  errorHandler?: (error: Error) => void;
  /** Taro-specific Replay resources. Set false to skip resource generation. */
  replay?: ReplayBuildOptions | false;
}

export type ReplayAssetsBuildResult = ReturnType<typeof buildReplayAssets>;

const commonKeys = new Set(['disable', 'silent', 'debug', 'errorHandler', 'replay']);
const replayKeys = new Set([
  'output',
  'sourceRoot',
  'outputRoot',
  'appRoot',
  'routePrefix',
  'compactAssets',
  'imagePriority',
]);

export function validateReplayAssetsOptions(options: ReplayAssetsOptions): void {
  for (const key of Object.keys(options)) {
    if (!commonKeys.has(key)) throw new Error(`Unsupported Sentry Taro plugin option: ${key}`);
  }
  for (const key of ['disable', 'silent', 'debug'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean`);
    }
  }
  if (options.errorHandler !== undefined && typeof options.errorHandler !== 'function') {
    throw new Error('errorHandler must be a function');
  }
  if (options.replay === undefined || options.replay === false) return;
  if (!options.replay || typeof options.replay !== 'object' || Array.isArray(options.replay)) {
    throw new Error('replay must be an options object or false');
  }
  for (const key of Object.keys(options.replay)) {
    if (!replayKeys.has(key)) throw new Error(`Unsupported Replay build option: ${key}`);
  }
  if (options.replay.output !== undefined && !['json', 'modules'].includes(options.replay.output)) {
    throw new Error('replay.output must be json or modules');
  }
  for (const key of ['sourceRoot', 'outputRoot', 'appRoot', 'routePrefix'] as const) {
    const value = options.replay[key];
    if (value !== undefined && (typeof value !== 'string' || (key !== 'routePrefix' && !value))) {
      throw new Error(`replay.${key} must be a ${key === 'routePrefix' ? '' : 'nonempty '}string`);
    }
  }
  if (
    options.replay.compactAssets !== undefined &&
    typeof options.replay.compactAssets !== 'boolean'
  ) {
    throw new Error('replay.compactAssets must be a boolean');
  }
  const priority = options.replay.imagePriority;
  if (
    priority !== undefined &&
    (!Array.isArray(priority) || priority.some((key) => typeof key !== 'string' || !key))
  ) {
    throw new Error('replay.imagePriority must be an array of nonempty strings');
  }
}

export function generateReplayAssetsForBuild(
  options: ReplayAssetsOptions,
  defaults: { cwd: string; sourceRoot: string; outputRoot: string },
): ReplayAssetsBuildResult | undefined {
  // As with the official plugin, a disabled integration performs no work.
  if (options.disable === true) return;
  try {
    validateReplayAssetsOptions(options);
    if (options.replay === false) return;
    const replay = options.replay || {};
    const sourceDir = resolve(defaults.cwd, replay.sourceRoot || defaults.sourceRoot);
    const outputDir = resolve(defaults.cwd, replay.outputRoot || defaults.outputRoot);
    const appRoot = replay.appRoot ? resolve(defaults.cwd, replay.appRoot) : outputDir;
    const result = buildReplayAssets({
      sourceDir,
      outputDir,
      appRoot,
      ...(replay.routePrefix !== undefined ? { routePrefix: replay.routePrefix } : {}),
      ...(replay.compactAssets !== undefined ? { compactAssets: replay.compactAssets } : {}),
      ...(replay.imagePriority !== undefined ? { imagePriority: replay.imagePriority } : {}),
      onDiagnostic: (message) => {
        if (!options.silent) console.warn(`[sentry-taro] ${message}`);
      },
    });
    if (replay.output !== 'modules' || replay.compactAssets !== false) {
      const data = JSON.parse(result.assetData) as {
        styles: { byteLength: number };
        images: { byteLength: number };
      };
      const maxBytes = 2 * 1024 * 1024;
      if (
        Buffer.byteLength(result.assetData) > maxBytes ||
        data.styles.byteLength > maxBytes ||
        data.images.byteLength > maxBytes
      ) {
        throw new Error('Replay resource data exceeds the runtime decoder limit of 2 MiB');
      }
    }
    if (replay.output === 'modules') {
      writeFileSync(join(outputDir, 'replay-styles.js'), result.source);
      writeFileSync(join(outputDir, 'replay-images.js'), result.images.source);
    } else {
      writeFileSync(join(outputDir, 'replay-assets.json'), result.assetData);
    }
    if (options.debug && !options.silent) {
      console.log(
        `[sentry-taro] Prepared Replay resources for ${Object.keys(result.pages).length} routes.`,
      );
      for (const [route, budget] of Object.entries(result.images.budgets)) {
        console.log(
          `[sentry-taro] ${route}: ${budget.count} images, ${budget.imageSrcBudgetBytes}/${budget.budget} bytes.`,
        );
      }
    }
    return result;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (typeof options.errorHandler === 'function') options.errorHandler(error);
    else throw error;
  }
}

/** Generate after any custom output copy step. Relative paths use process.cwd(). */
export function generateReplayAssets(
  options: ReplayAssetsOptions = {},
): ReplayAssetsBuildResult | undefined {
  return generateReplayAssetsForBuild(options, {
    cwd: process.cwd(),
    sourceRoot: 'src',
    outputRoot: 'dist',
  });
}
