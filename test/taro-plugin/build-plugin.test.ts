import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import {
  sentryTaroPlugin,
  type SentryTaroPluginOptions,
  type TaroPluginContext,
} from '../../src/taro-plugin';
import { PreserveTaroSourceMapOffsets } from '../../src/taro-plugin/source-maps';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(options: SentryTaroPluginOptions = { replay: false }) {
  const root = mkdtempSync(join(tmpdir(), 'sentry-build-hooks-'));
  roots.push(root);
  let runner!: Parameters<TaroPluginContext['modifyRunnerOpts']>[0];
  let configure!: Parameters<TaroPluginContext['modifyWebpackChain']>[0];
  let finish!: () => void;
  const ctx: TaroPluginContext = {
    paths: { appPath: root, sourcePath: join(root, 'src'), outputPath: join(root, 'dist') },
    modifyRunnerOpts(callback) {
      runner = callback;
    },
    modifyWebpackChain(callback) {
      configure = callback;
    },
    onBuildFinish(callback) {
      finish = callback;
    },
  };
  sentryTaroPlugin(ctx, options);
  const plugins = new Map<string, { plugin: unknown; args?: unknown[] }>();
  const output = new Map<string, unknown>();
  const devtool = vi.fn();
  const DefinePlugin = class {};
  return {
    root,
    runner,
    finish,
    plugins,
    output,
    devtool,
    DefinePlugin,
    configure: () =>
      configure({
        chain: {
          devtool,
          output: { get: (key) => output.get(key), set: (key, value) => output.set(key, value) },
          plugin: (name) => ({
            use(plugin, args) {
              plugins.set(name, { plugin, ...(args ? { args } : {}) });
            },
          }),
        },
        webpack: { DefinePlugin },
      }),
  };
}

test('enables column maps and uses compiler-owned repair even with Replay disabled', () => {
  const hook = setup();
  const opts = {
    enableSourceMap: false,
    sourceMapType: 'cheap-source-map',
    runtime: { enableMutationObserver: false },
  };
  hook.runner({ opts });
  hook.configure();
  expect(opts).toEqual({
    enableSourceMap: true,
    sourceMapType: 'source-map',
    runtime: { enableMutationObserver: false },
  });
  expect(hook.devtool).toHaveBeenCalledWith('source-map');
  expect(hook.plugins.get('sentry-taro-source-map-offsets')?.plugin).toBe(
    PreserveTaroSourceMapOffsets,
  );
  const sourceName = hook.output.get('devtoolModuleFilenameTemplate') as (info: {
    absoluteResourcePath: string;
  }) => string;
  expect(sourceName({ absoluteResourcePath: join(hook.root, 'src/page.ts') })).toBe(
    'webpack:///src/page.ts',
  );
  hook.finish();
  expect(JSON.parse(readFileSync(join(hook.root, 'dist/sentry-build.json'), 'utf8'))).toBeDefined();
});

test('freezes identity once for injection and artifact even if environment changes before build finish', () => {
  vi.stubEnv('SENTRY_RELEASE', 'synthetic@first');
  vi.stubEnv('SENTRY_DIST', 'build-7');
  const hook = setup();
  vi.stubEnv('SENTRY_RELEASE', 'synthetic@second');
  vi.stubEnv('SENTRY_DIST', 'build-8');
  hook.configure();
  hook.finish();
  const identity = hook.plugins.get('sentry-taro-build-identity');
  expect(identity?.plugin).toBe(hook.DefinePlugin);
  expect(identity?.args).toEqual([
    { __SENTRY_TARO_BUILD__: JSON.stringify({ release: 'synthetic@first', dist: 'build-7' }) },
  ]);
  expect(JSON.parse(readFileSync(join(hook.root, 'dist/sentry-build.json'), 'utf8'))).toMatchObject(
    { release: 'synthetic@first', dist: 'build-7' },
  );
});

test('preserves custom source paths and permits independent source map and injection opt-outs', () => {
  const hook = setup({
    replay: false,
    sourcemaps: { disable: true },
    release: { name: 'synthetic@1', inject: false },
  });
  const opts = { enableSourceMap: false };
  hook.runner({ opts });
  hook.configure();
  expect(opts).toEqual({ enableSourceMap: false });
  expect(hook.plugins.size).toBe(0);
  expect(hook.devtool).not.toHaveBeenCalled();
  const custom = setup();
  custom.output.set('devtoolModuleFilenameTemplate', 'custom/[resource-path]');
  custom.configure();
  expect(custom.output.get('devtoolModuleFilenameTemplate')).toBe('custom/[resource-path]');
});

test('enables the MutationObserver runtime prerequisite while retaining other runtime settings', () => {
  const hook = setup({});
  const opts = { runtime: { enableSizeAPIs: true } };
  hook.runner({ opts });
  expect(opts.runtime).toEqual({ enableSizeAPIs: true, enableMutationObserver: true });
});

test('rejects upload-only or unimplemented build options before registering hooks', () => {
  for (const options of [
    { release: { finalize: true } },
    { sourcemaps: { assets: '*.map' } },
    { authToken: 'example' },
    { telemetry: true },
  ]) {
    expect(() => setup(options as SentryTaroPluginOptions)).toThrow('Unsupported');
  }
  const errorHandler = vi.fn();
  const hook = setup({
    release: { inject: 'yes' } as unknown as NonNullable<SentryTaroPluginOptions['release']>,
    errorHandler,
  });
  expect(errorHandler).toHaveBeenCalledOnce();
  expect(hook.finish).toBeUndefined();
});

test('routes late hook errors through errorHandler and stops further plugin work', () => {
  const errorHandler = vi.fn();
  const hook = setup({ replay: false, errorHandler });
  hook.runner({ opts: { compiler: { type: 'vite' } } });
  expect(errorHandler).toHaveBeenCalledOnce();
  expect(errorHandler.mock.calls[0]?.[0].message).toContain('Webpack 5');
  hook.configure();
  hook.finish();
  expect(hook.plugins.size).toBe(0);
  expect(existsSync(join(hook.root, 'dist/sentry-build.json'))).toBe(false);
  const rejecting = setup();
  expect(() => rejecting.runner({ opts: { compiler: 'vite' } })).toThrow('Webpack 5');
});

test('reports a thrown Webpack chain operation once without writing an identity artifact', () => {
  const errorHandler = vi.fn();
  const hook = setup({ replay: false, errorHandler });
  hook.devtool.mockImplementation(() => {
    throw new Error('synthetic chain failure');
  });
  hook.configure();
  hook.finish();
  expect(errorHandler).toHaveBeenCalledOnce();
  expect(errorHandler.mock.calls[0]?.[0].message).toBe('synthetic chain failure');
  expect(existsSync(join(hook.root, 'dist/sentry-build.json'))).toBe(false);
});
