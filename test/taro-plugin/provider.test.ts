import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { createReplayAssetProviders } from '../../src/replay/replay-asset-providers';
import { buildReplayAssets } from '../../src/taro-plugin/assets';

type Payload = { encoded: string; byteLength: number };
type AssetFile = { version: number; styles: Payload; images: Payload };
type ImageDescriptor = { path: string; mime: string; bytes: number };
type ImageManifest = { entries: [string, string | ImageDescriptor | undefined][] };
type StylesFactory = (decoder: typeof decode) => (route?: string) => string;
type ImagesFactory = (
  decoder: typeof decode,
  read: (path: string) => string,
) => (route?: string) => Record<string, string>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'sentry-taro-provider-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function buildFixture(mixed = false, compactAssets = true) {
  const output = mixed ? 'dist/mini' : 'dist';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2H0z"/></svg>';
  const inline = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const root = fixture({
    [`${output}/app.json`]: JSON.stringify({ pages: ['pages/Gallery/index', 'pages/Other/index'] }),
    [`${output}/app.wxss`]: '@import "./shared.wxss";page{color:blue}',
    [`${output}/shared.wxss`]: '.shared::before{content:"中文😀"}',
    [`${output}/pages/Gallery/index.wxss`]:
      '@import "../../shared.wxss" print;.gallery{padding:24rpx}',
    [`${output}/app.js`]: '"assets/logo.png";',
    [`${output}/assets/logo.png`]: 'logo',
    [`${output}/pages/Gallery/index.js`]: JSON.stringify(inline),
    'src/pages/Gallery/assets/icon.svg': svg,
  });
  const result = buildReplayAssets({
    sourceDir: join(root, 'src'),
    outputDir: join(root, output),
    appRoot: join(root, 'dist'),
    compactAssets,
  });
  return {
    root,
    result,
    output,
    inline,
    read: (path: string) => readFileSync(join(root, 'dist', path), 'base64'),
  };
}

function decode(encoded: string, byteLength: number): unknown {
  const bytes = inflateSync(Buffer.from(encoded, 'base64'));
  expect(bytes.byteLength).toBe(byteLength);
  return JSON.parse(bytes.toString('utf8'));
}

function encode(value: unknown): Payload {
  const bytes = Buffer.from(JSON.stringify(value));
  return { encoded: deflateSync(bytes).toString('base64'), byteLength: bytes.byteLength };
}

function factory<T>(source: string): T {
  const sandbox = { module: { exports: {} } };
  runInNewContext(source, sandbox);
  return sandbox.module.exports as T;
}

function alterImages(assetData: string, change: (manifest: ImageManifest) => void) {
  const file = JSON.parse(assetData) as AssetFile;
  const manifest = decode(file.images.encoded, file.images.byteLength) as ImageManifest;
  change(manifest);
  file.images = encode(manifest);
  return JSON.stringify(file);
}

describe('JSON Replay asset providers', () => {
  test('preserves dot-segment lookup keys while reading only canonical packaged paths', () => {
    const root = fixture({
      'dist/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'dist/mini/app.wxss': 'page{color:blue}',
      'dist/mini/pages/Gallery/index.js': '"./assets/logo.png";"assets/../logo.png";',
      'dist/mini/assets/logo.png': 'logo',
      'dist/mini/logo.png': 'root',
    });
    const result = buildReplayAssets({
      sourceDir: join(root, 'src'),
      outputDir: join(root, 'dist/mini'),
      appRoot: join(root, 'dist'),
    });
    const read = (path: string) => readFileSync(join(root, 'dist', path), 'base64');
    const readPackagedImage = vi.fn(read);
    const providers = createReplayAssetProviders({
      readAssetFile: () => result.assetData,
      readPackagedImage,
    });
    const generatedImages = factory<ImagesFactory>(result.images.source)(decode, read);
    expect(providers.getReplayStyles('/mini/pages/Gallery/index')).toBe('body{color:blue}');
    expect(providers.getReplayImageSources('/mini/pages/Gallery/index')).toEqual({
      '/mini/./assets/logo.png': 'data:image/png;base64,bG9nbw==',
      '/mini/assets/../logo.png': 'data:image/png;base64,cm9vdA==',
    });
    expect(providers.getReplayImageSources('/mini/pages/Gallery/index')).toEqual(
      generatedImages('/mini/pages/Gallery/index'),
    );
    expect(readPackagedImage.mock.calls.map(([path]) => path).sort()).toEqual([
      'mini/assets/logo.png',
      'mini/logo.png',
    ]);
  });

  test('preserves percent SVG keys and separates logical routes from packaged image paths', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h4v4H0z"/></svg>';
    const percent = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const canonical = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const root = fixture({
      'dist/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'dist/mini/app.wxss': 'page{color:blue}',
      'dist/mini/pages/Gallery/index.js': `${JSON.stringify(percent)};"assets/icon.svg";`,
      'dist/mini/assets/icon.svg': svg,
      'src/components/Icon/icon.svg': svg,
    });
    const result = buildReplayAssets({
      sourceDir: join(root, 'src'),
      outputDir: join(root, 'dist/mini'),
      appRoot: join(root, 'dist'),
      routePrefix: 'logical',
    });
    const readPackagedImage = vi.fn((path: string) =>
      readFileSync(join(root, 'dist', path), 'base64'),
    );
    const providers = createReplayAssetProviders({
      readAssetFile: () => result.assetData,
      readPackagedImage,
    });
    expect(providers.getReplayStyles('/logical/pages/Gallery/index')).toBe('body{color:blue}');
    expect(providers.getReplayImageSources('/logical/pages/Gallery/index')).toEqual({
      [percent]: canonical,
      '/mini/assets/icon.svg': canonical,
    });
    expect(readPackagedImage.mock.calls).toEqual([['mini/assets/icon.svg']]);
    expect(providers.getReplayImageSources('/mini/pages/Gallery/index')).toEqual({});
  });

  test.each([
    { mixed: false, compact: true },
    { mixed: true, compact: true },
    { mixed: false, compact: false },
    { mixed: true, compact: false },
  ])(
    'matches generated modules for $mixed mixed root and $compact compact mode',
    ({ mixed, compact }) => {
      const { result, read } = buildFixture(mixed, compact);
      const readAssetFile = vi.fn(() => result.assetData);
      const readPackagedImage = vi.fn(read);
      const providers = createReplayAssetProviders({ readAssetFile, readPackagedImage });
      const legacyStyles = factory<StylesFactory>(result.source)(decode);
      const legacyImages = factory<ImagesFactory>(result.images.source)(decode, read);
      expect(readAssetFile).not.toHaveBeenCalled();
      expect(readPackagedImage).not.toHaveBeenCalled();
      const prefix = mixed ? 'mini/' : '';
      for (const route of [
        'pages/Gallery/index',
        `/${prefix}pages/Gallery/index?ignored=value#fragment`,
        'pages/Other/index',
        'unknown',
        '__proto__',
        'constructor',
      ]) {
        expect(providers.getReplayStyles(route)).toBe(legacyStyles(route));
        expect(providers.getReplayImageSources(route)).toEqual(legacyImages(route));
      }
      const manifest = JSON.parse(result.assetData) as AssetFile;
      expect(manifest.version).toBe(1);
      expect(result.assetData).not.toContain('中文😀');
      expect(readAssetFile).toHaveBeenCalledTimes(1);
      expect(readPackagedImage.mock.calls).toEqual(compact ? [[`${prefix}assets/logo.png`]] : []);
    },
  );

  test('constructs before output exists and retries missing or temporarily invalid asset files', () => {
    const { result, root, read } = buildFixture();
    const output = join(root, 'dist/replay-assets.json');
    const readAssetFile = vi.fn(() => readFileSync(output, 'utf8'));
    const providers = createReplayAssetProviders({ readAssetFile, readPackagedImage: read });
    expect(readAssetFile).not.toHaveBeenCalled();
    expect(providers.getReplayStyles('pages/Gallery/index')).toBe('');
    writeFileSync(output, '{');
    expect(providers.getReplayImageSources('pages/Gallery/index')).toEqual({});
    writeFileSync(output, result.assetData);
    expect(providers.getReplayStyles('pages/Gallery/index')).toContain('body{color:blue}');
    expect(providers.getReplayImageSources('pages/Gallery/index')['/assets/logo.png']).toBe(
      'data:image/png;base64,bG9nbw==',
    );
    expect(readAssetFile).toHaveBeenCalledTimes(3);
  });

  test('rejects unsupported versions or corrupt payloads and retries a corrected file', () => {
    const { result, read } = buildFixture();
    const file = JSON.parse(result.assetData) as AssetFile;
    const corruptFiles = [
      JSON.stringify({ ...file, version: 0 }),
      JSON.stringify({ ...file, version: 2 }),
      JSON.stringify({ ...file, version: '1' }),
      JSON.stringify({
        ...file,
        styles: { ...file.styles, byteLength: file.styles.byteLength + 1 },
      }),
      JSON.stringify({ ...file, images: { ...file.images, encoded: 'AA==' } }),
    ];
    for (const corrupt of corruptFiles) {
      const readAssetFile = vi
        .fn<() => string>()
        .mockReturnValueOnce(corrupt)
        .mockReturnValue(result.assetData);
      const readPackagedImage = vi.fn(read);
      const providers = createReplayAssetProviders({ readAssetFile, readPackagedImage });
      expect(providers.getReplayImageSources('pages/Gallery/index')).toEqual({});
      expect(readPackagedImage).not.toHaveBeenCalled();
      expect(providers.getReplayStyles('pages/Gallery/index')).toContain('body{color:blue}');
      expect(providers.getReplayImageSources('pages/Gallery/index')['/assets/logo.png']).toBe(
        'data:image/png;base64,bG9nbw==',
      );
      expect(readAssetFile).toHaveBeenCalledTimes(2);
    }
  });

  test('does not read packaged files for styles or unknown routes and returns fresh image maps', () => {
    const { result, read } = buildFixture();
    const readPackagedImage = vi.fn(read);
    const providers = createReplayAssetProviders({
      readAssetFile: () => result.assetData,
      readPackagedImage,
    });
    providers.getReplayStyles('pages/Gallery/index');
    for (const route of ['unknown', '__proto__', 'constructor', '/assets/logo.png']) {
      expect(providers.getReplayImageSources(route)).toEqual({});
    }
    expect(readPackagedImage).not.toHaveBeenCalled();
    const first = providers.getReplayImageSources('pages/Gallery/index');
    first['/assets/logo.png'] = 'changed';
    expect(providers.getReplayImageSources('pages/Other/index')['/assets/logo.png']).toBe(
      'data:image/png;base64,bG9nbw==',
    );
    expect(readPackagedImage).toHaveBeenCalledTimes(1);
  });

  test('retries packaged read failures while keeping valid inline images usable', () => {
    const { result, inline } = buildFixture();
    for (const bad of ['', 'AA==', 'bG9nbw=', 'bG9nbx==', 'bG9nbwA=']) {
      const readPackagedImage = vi
        .fn<() => string>()
        .mockReturnValueOnce(bad)
        .mockReturnValue('bG9nbw==');
      const providers = createReplayAssetProviders({
        readAssetFile: () => result.assetData,
        readPackagedImage,
      });
      expect(providers.getReplayImageSources('pages/Gallery/index')).toEqual({ [inline]: inline });
      expect(providers.getReplayImageSources('pages/Gallery/index')['/assets/logo.png']).toBe(
        'data:image/png;base64,bG9nbw==',
      );
      providers.getReplayImageSources('pages/Other/index');
      expect(readPackagedImage).toHaveBeenCalledTimes(2);
    }
    const readPackagedImage = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error('subpackage unavailable');
      })
      .mockReturnValue('bG9nbw==');
    const providers = createReplayAssetProviders({
      readAssetFile: () => result.assetData,
      readPackagedImage,
    });
    expect(providers.getReplayImageSources('pages/Gallery/index')).toEqual({ [inline]: inline });
    expect(providers.getReplayImageSources('pages/Gallery/index')['/assets/logo.png']).toBe(
      'data:image/png;base64,bG9nbw==',
    );
    const withoutReader = createReplayAssetProviders({ readAssetFile: () => result.assetData });
    expect(withoutReader.getReplayImageSources('pages/Gallery/index')).toEqual({
      [inline]: inline,
    });
  });

  test('never invokes the packaged reader for unsafe decoded paths', () => {
    const { result, read } = buildFixture(true);
    for (const path of [
      'mini/../private.png',
      'mini/assets/./logo.png',
      'mini//logo.png',
      'https://example.com/a.png',
      'wxfile://a.png',
      '/mini/assets/logo.png',
      'mini/assets/logo.png?secret',
      'mini/assets\\logo.png',
      'mini/assets/\0logo.png',
      'other/assets/logo.png',
    ]) {
      const data = alterImages(result.assetData, (manifest) => {
        const descriptor = manifest.entries.find(
          (entry) => typeof entry[1] === 'object',
        )?.[1] as ImageDescriptor;
        descriptor.path = path;
      });
      const readPackagedImage = vi.fn(read);
      const providers = createReplayAssetProviders({
        readAssetFile: () => data,
        readPackagedImage,
      });
      const selected = providers.getReplayImageSources('pages/Gallery/index');
      expect(selected).not.toHaveProperty('/mini/assets/logo.png');
      expect(readPackagedImage).not.toHaveBeenCalled();
    }
  });
});
