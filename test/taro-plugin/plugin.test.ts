import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { createReplayAssetProviders } from '../../src/replay/replay-asset-providers';
import sentryTaroPlugin, {
  generateReplayAssets,
  type SentryTaroPluginOptions,
  type ReplayAssetsOptions,
  type TaroPluginContext,
} from '../../src/taro-plugin';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>) {
  for (const [path, source] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
}

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'sentry-taro-plugin-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  write(root, files);
  return root;
}

function context(root: string) {
  const callbacks: (() => void)[] = [];
  const ctx: TaroPluginContext = {
    paths: { appPath: root, sourcePath: join(root, 'src'), outputPath: join(root, 'dist') },
    modifyRunnerOpts: vi.fn(),
    modifyWebpackChain: vi.fn(),
    onBuildFinish: vi.fn((callback) => {
      callbacks.push(callback);
    }),
  };
  return {
    ctx,
    finish: () => {
      for (const callback of callbacks) callback();
    },
  };
}

function decode(encoded: string, bytes: number): unknown {
  const value = inflateSync(Buffer.from(encoded, 'base64'));
  expect(value.byteLength).toBe(bytes);
  return JSON.parse(value.toString('utf8'));
}

function loadStyles(path: string) {
  const sandbox = { module: { exports: {} } };
  runInNewContext(readFileSync(path, 'utf8'), sandbox);
  const factory = sandbox.module.exports as (decoder: typeof decode) => (route: string) => string;
  return factory(decode);
}

function loadImages(path: string, appRoot: string) {
  const sandbox = { module: { exports: {} } };
  runInNewContext(readFileSync(path, 'utf8'), sandbox);
  const factory = sandbox.module.exports as (
    decoder: typeof decode,
    read: (path: string) => string,
  ) => (route: string) => Record<string, string>;
  return factory(decode, (path) => readFileSync(join(appRoot, path), 'base64'));
}

function loadProviders(outputRoot: string, appRoot = outputRoot) {
  return createReplayAssetProviders({
    readAssetFile: () => readFileSync(join(outputRoot, 'replay-assets.json'), 'utf8'),
    readPackagedImage: (path) => readFileSync(join(appRoot, path), 'base64'),
  });
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2H0z"/></svg>';
const inline = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;

describe('public Taro plugin API', () => {
  test('registers the build callback and creates usable JSON without an import from output', () => {
    const root = fixture({
      'dist/app.json': '{"pages":["pages/Gallery/index"]}',
      'dist/app.wxss': 'page{color:blue}',
      'dist/pages/Gallery/index.js': JSON.stringify(inline),
      'src/pages/Gallery/assets/icon.svg': SVG,
    });
    const { ctx, finish } = context(root);
    const read = vi.fn(() => readFileSync(join(root, 'dist/replay-assets.json'), 'utf8'));
    // Runtime providers can be constructed before the first build has created its output.
    const providers = createReplayAssetProviders({ readAssetFile: read });
    sentryTaroPlugin(ctx);
    expect(ctx.onBuildFinish).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'dist/replay-assets.json'))).toBe(false);
    finish();
    expect(providers.getReplayStyles('pages/Gallery/index')).toBe('body{color:blue}');
    expect(providers.getReplayImageSources('pages/Gallery/index')).toEqual({ [inline]: inline });
    expect(read).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, 'dist/replay-styles.js'))).toBe(false);
    expect(existsSync(join(root, 'dist/replay-images.js'))).toBe(false);
  });

  test('rebuilds the source allowlist and generated JSON after a watch update', () => {
    const root = fixture({
      'dist/app.json': '{"pages":["pages/Gallery/index"]}',
      'dist/app.wxss': '.gallery{color:blue}',
      'dist/pages/Gallery/index.js': 'module.exports={};',
    });
    const { ctx, finish } = context(root);
    sentryTaroPlugin(ctx);
    finish();
    const output = join(root, 'dist');
    expect(loadProviders(output).getReplayImageSources('pages/Gallery/index')).toEqual({});
    write(root, {
      'src/components/Badge/assets/icon.svg': SVG,
      'dist/pages/Gallery/index.js': JSON.stringify(inline),
      'dist/app.wxss': '.gallery{color:red}',
    });
    finish();
    expect(loadProviders(output).getReplayImageSources('pages/Gallery/index')).toEqual({
      [inline]: inline,
    });
    expect(loadProviders(output).getReplayStyles('pages/Gallery/index')).toBe(
      '.gallery{color:red}',
    );
  });

  test('generates after a custom copy step and infers mixed-app prefixes from relative roots', () => {
    const root = fixture({
      'native/app.wxss': '.host{color:purple}',
      'native/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'native/mini/app.wxss': 'page{color:blue}',
      'native/mini/pages/Gallery/index.js': '"assets/logo.png";',
      'native/mini/assets/logo.png': 'logo',
    });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const result = generateReplayAssets({
      replay: {
        sourceRoot: 'src',
        outputRoot: 'native/mini',
        appRoot: 'native',
        output: 'modules',
      },
    });
    expect(result).toBeDefined();
    expect(
      loadStyles(join(root, 'native/mini/replay-styles.js'))('/mini/pages/Gallery/index'),
    ).toContain('.host{color:purple}');
    expect(
      loadImages(
        join(root, 'native/mini/replay-images.js'),
        join(root, 'native'),
      )('/mini/pages/Gallery/index'),
    ).toEqual({ '/mini/assets/logo.png': 'data:image/png;base64,bG9nbw==' });
    expect(existsSync(join(root, 'native/mini/replay-assets.json'))).toBe(false);
  });

  test('resolves plugin overrides against appPath without relying on the invoking working directory', () => {
    const root = fixture({
      'alternate/app.json': '{"pages":["pages/Gallery/index"]}',
      'alternate/app.wxss': 'view{color:red}',
      'alternate/pages/Gallery/index.js': JSON.stringify(inline),
      'source-components/Icon/icon.svg': SVG,
    });
    const { ctx, finish } = context(root);
    sentryTaroPlugin(ctx, { replay: { sourceRoot: 'source-components', outputRoot: 'alternate' } });
    finish();
    expect(existsSync(join(root, 'dist/replay-assets.json'))).toBe(false);
    expect(
      loadProviders(join(root, 'alternate')).getReplayImageSources('pages/Gallery/index'),
    ).toEqual({ [inline]: inline });
  });

  test.each([{ disable: true }] as SentryTaroPluginOptions[])(
    'skips work when disabled through %j',
    (options) => {
      const root = fixture({});
      const { ctx, finish } = context(root);
      sentryTaroPlugin(ctx, options);
      expect(ctx.onBuildFinish).not.toHaveBeenCalled();
      expect(() => finish()).not.toThrow();
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      expect(generateReplayAssets(options)).toBeUndefined();
      expect(existsSync(join(root, 'dist'))).toBe(false);
    },
  );

  test('fails unsupported options explicitly instead of pretending to upload sourcemaps or releases', () => {
    const root = fixture({ 'dist/app.json': '{"pages":[]}' });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    for (const key of ['authToken', 'sourcemaps', 'release', 'org', 'project']) {
      expect(() => generateReplayAssets({ [key]: 'example' } as ReplayAssetsOptions)).toThrow(
        `Unsupported Sentry Taro plugin option: ${key}`,
      );
    }
    expect(() =>
      generateReplayAssets({ replay: { assetUpload: true } } as unknown as SentryTaroPluginOptions),
    ).toThrow('Unsupported Replay build option: assetUpload');
    expect(() =>
      generateReplayAssets({ replay: { output: 'script' } } as unknown as SentryTaroPluginOptions),
    ).toThrow();
    expect(existsSync(join(root, 'dist/replay-assets.json'))).toBe(false);
  });

  test('stops builds by default and lets errorHandler continue or deliberately rethrow', () => {
    const root = fixture({});
    const { ctx, finish } = context(root);
    sentryTaroPlugin(ctx);
    expect(() => finish()).toThrow();
    const handled = vi.fn();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    expect(generateReplayAssets({ errorHandler: handled })).toBeUndefined();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(() =>
      generateReplayAssets({
        errorHandler: (error) => {
          throw error;
        },
      }),
    ).toThrow();
  });

  test('rejects oversized decoded resources before writing JSON even when errorHandler continues', () => {
    const root = fixture({
      'dist/app.json': '{"pages":[]}',
      // Highly compressible CSS stays small on disk but exceeds the runtime decode limit.
      'dist/app.wxss': `.oversized{content:"${'a'.repeat(2 * 1024 * 1024)}"}`,
    });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const artifact = join(root, 'dist/replay-assets.json');
    expect(() => generateReplayAssets()).toThrow('runtime decoder limit of 2 MiB');
    expect(existsSync(artifact)).toBe(false);
    const errorHandler = vi.fn();
    expect(generateReplayAssets({ errorHandler })).toBeUndefined();
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0]?.[0]).toMatchObject({
      message: 'Replay resource data exceeds the runtime decoder limit of 2 MiB',
    });
    expect(existsSync(artifact)).toBe(false);
    // Uncompressed compatibility modules do not pass through the bounded JSON decoder.
    expect(
      generateReplayAssets({ replay: { output: 'modules', compactAssets: false } }),
    ).toBeDefined();
    expect(existsSync(join(root, 'dist/replay-styles.js'))).toBe(true);
    expect(existsSync(join(root, 'dist/replay-images.js'))).toBe(true);
    expect(existsSync(artifact)).toBe(false);
  });

  test('reports omissions without embedding image data, with silent taking precedence over debug', () => {
    const privateSvg = '<svg><text>private-image-content</text></svg>';
    const privateUri = `data:image/svg+xml;base64,${Buffer.from(privateSvg).toString('base64')}`;
    const root = fixture({
      'dist/app.json': '{"pages":["pages/Gallery/index"]}',
      'dist/pages/Gallery/index.js': JSON.stringify(privateUri),
    });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    generateReplayAssets({ debug: true });
    expect(warn).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    const diagnostics = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(diagnostics).not.toContain(privateUri);
    expect(diagnostics).not.toContain('private-image-content');
    expect(diagnostics).not.toContain(Buffer.from(privateSvg).toString('base64'));
    warn.mockClear();
    log.mockClear();
    generateReplayAssets({ debug: true, silent: true });
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
