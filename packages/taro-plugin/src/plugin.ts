import { relative, resolve } from 'node:path';
import {
  createSentryBuildMetadata,
  writeReplayWorker,
  writeSentryBuildMetadata,
} from './build-artifacts';
import {
  generateReplayAssetsForBuild,
  validateReplayAssetsOptions,
  type ReplayAssetsOptions,
  type ReplayBuildOptions,
} from './replay-build';
import { PreserveTaroSourceMapOffsets } from './source-maps';

export interface SentryTaroPluginOptions extends Omit<ReplayAssetsOptions, 'replay'> {
  /** Build identity. Defaults to SENTRY_RELEASE or the detected revision, and SENTRY_DIST. */
  release?: { name?: string; dist?: string; inject?: boolean };
  /** Generate column mappings and repair Taro's final Webpack prefix insertion. */
  sourcemaps?: { disable?: boolean };
  replay?:
    | (ReplayBuildOptions & {
        /** Optional independent Worker copy. Configure app.json/workers separately. */
        worker?: false | { outputRoot?: string; filename?: string };
      })
    | false;
}

interface WebpackChain {
  devtool(value: string): unknown;
  output: {
    get(key: string): unknown;
    set(key: string, value: unknown): unknown;
  };
  plugin(name: string): { use(plugin: unknown, args?: unknown[]): unknown };
}

/** Structural subset of Taro 4's context; no runtime dependency on Taro or Webpack. */
export interface TaroPluginContext {
  paths: { appPath: string; sourcePath: string; outputPath: string };
  modifyRunnerOpts(callback: (args: { opts: Record<string, any> }) => void): void;
  modifyWebpackChain(
    callback: (args: { chain: WebpackChain; webpack: { DefinePlugin: unknown } }) => void,
  ): void;
  onBuildFinish(callback: () => void): void;
}

function objectOptions(
  value: unknown,
  name: string,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an options object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Unsupported ${name} option: ${key}`);
  }
}

function validate(options: SentryTaroPluginOptions): void {
  objectOptions(options, 'Sentry Taro plugin', [
    'disable',
    'silent',
    'debug',
    'errorHandler',
    'release',
    'sourcemaps',
    'replay',
  ]);
  for (const key of ['disable', 'silent', 'debug'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      throw new Error(`${key} must be a boolean`);
  }
  if (options.errorHandler !== undefined && typeof options.errorHandler !== 'function')
    throw new Error('errorHandler must be a function');
  if (options.release !== undefined) {
    objectOptions(options.release, 'release', ['name', 'dist', 'inject']);
    if (options.release.inject !== undefined && typeof options.release.inject !== 'boolean')
      throw new Error('release.inject must be a boolean');
  }
  if (options.sourcemaps !== undefined) {
    objectOptions(options.sourcemaps, 'sourcemaps', ['disable']);
    if (options.sourcemaps.disable !== undefined && typeof options.sourcemaps.disable !== 'boolean')
      throw new Error('sourcemaps.disable must be a boolean');
  }
  if (options.replay !== undefined && options.replay !== false) {
    objectOptions(options.replay, 'replay', [
      'sourceRoot',
      'outputRoot',
      'appRoot',
      'routePrefix',
      'output',
      'compactAssets',
      'imagePriority',
      'worker',
    ]);
    const worker = options.replay.worker;
    if (worker !== undefined && worker !== false) {
      objectOptions(worker, 'replay.worker', ['outputRoot', 'filename']);
      for (const key of ['outputRoot', 'filename'] as const) {
        if (worker[key] !== undefined && (typeof worker[key] !== 'string' || !worker[key]))
          throw new Error(`replay.worker.${key} must be a nonempty string`);
      }
    }
  }
}

/** Taro build preparation. Final WeChat sourcemaps are uploaded separately after WeChat compilation. */
export function sentryTaroPlugin(
  ctx: TaroPluginContext,
  options: SentryTaroPluginOptions = {},
): void {
  if (options.disable === true) return;
  const handleError = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (typeof options.errorHandler === 'function') options.errorHandler(error);
    else throw error;
  };
  try {
    validate(options);
    const metadata = createSentryBuildMetadata({
      projectDir: ctx.paths.appPath,
      ...(options.release
        ? {
            release: {
              ...(options.release.name !== undefined ? { name: options.release.name } : {}),
              ...(options.release.dist !== undefined ? { dist: options.release.dist } : {}),
            },
          }
        : {}),
    });
    const mapsEnabled = options.sourcemaps?.disable !== true;
    const replay = options.replay === false ? false : options.replay || {};
    const { worker, ...resourceOptions } = replay || {};
    validateReplayAssetsOptions({ replay: replay === false ? false : resourceOptions });
    let active = true;
    const guardedHook =
      <T>(callback: (args: T) => void) =>
      (args: T) => {
        if (!active) return;
        try {
          callback(args);
        } catch (cause) {
          active = false;
          handleError(cause);
        }
      };
    ctx.modifyRunnerOpts(
      guardedHook(({ opts }) => {
        const compiler = typeof opts.compiler === 'string' ? opts.compiler : opts.compiler?.type;
        if (compiler !== undefined && compiler !== 'webpack5')
          throw new Error('Sentry Taro plugin requires the Taro 4 Webpack 5 compiler');
        // modifyRunnerOpts receives the platform-resolved Taro config, before runner creation.
        if (mapsEnabled) {
          opts.enableSourceMap = true;
          opts.sourceMapType = 'source-map';
        }
        if (replay !== false) {
          opts.runtime = { ...opts.runtime, enableMutationObserver: true };
        }
      }),
    );
    ctx.modifyWebpackChain(
      guardedHook(({ chain, webpack }) => {
        if (mapsEnabled) {
          chain.devtool('source-map');
          if (!chain.output.get('devtoolModuleFilenameTemplate')) {
            chain.output.set(
              'devtoolModuleFilenameTemplate',
              (info: { absoluteResourcePath: string }) =>
                `webpack:///${relative(ctx.paths.appPath, info.absoluteResourcePath).replace(/\\/g, '/')}`,
            );
          }
          chain.plugin('sentry-taro-source-map-offsets').use(PreserveTaroSourceMapOffsets, [
            {
              ...(options.debug !== undefined ? { debug: options.debug } : {}),
              ...(options.silent !== undefined ? { silent: options.silent } : {}),
              ...(options.errorHandler ? { errorHandler: options.errorHandler } : {}),
            },
          ]);
        }
        if (options.release?.inject !== false) {
          chain.plugin('sentry-taro-build-identity').use(webpack.DefinePlugin, [
            {
              __SENTRY_TARO_BUILD__: JSON.stringify({
                release: metadata.release,
                dist: metadata.dist,
              }),
            },
          ]);
        }
      }),
    );
    ctx.onBuildFinish(() => {
      if (!active) return;
      try {
        // Frozen once for this compiler/watch session; upload reads this artifact instead of re-deriving it.
        writeSentryBuildMetadata({ metadata, outputRoot: ctx.paths.outputPath });
        if (worker)
          writeReplayWorker({
            projectDir: ctx.paths.appPath,
            outputRoot: resolve(
              ctx.paths.appPath,
              worker.outputRoot || resolve(ctx.paths.outputPath, 'workers'),
            ),
            ...(worker.filename ? { filename: worker.filename } : {}),
          });
        if (replay !== false)
          generateReplayAssetsForBuild(
            {
              replay: resourceOptions,
              ...(options.silent !== undefined ? { silent: options.silent } : {}),
              ...(options.debug !== undefined ? { debug: options.debug } : {}),
            },
            {
              cwd: ctx.paths.appPath,
              sourceRoot: ctx.paths.sourcePath,
              outputRoot: ctx.paths.outputPath,
            },
          );
      } catch (cause) {
        handleError(cause);
      }
    });
  } catch (cause) {
    handleError(cause);
  }
}

export default sentryTaroPlugin;
