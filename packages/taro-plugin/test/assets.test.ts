import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';
import { parse } from 'acorn';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { buildReplayAssets, buildReplayImageSources } from '../src/assets';

type Decode = (encoded: string, bytes: number) => unknown;
type ReadImage = (path: string) => unknown;
type StylesFactory = (decode?: Decode) => (route?: string) => string;
type ImagesFactory = (
  decode?: Decode,
  read?: ReadImage,
) => (route?: string) => Record<string, string>;

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string | Buffer>) {
  const root = mkdtempSync(join(tmpdir(), 'sentry-taro-assets-'));
  temporaryDirectories.push(root);
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function options(root: string, mixed = true) {
  return {
    sourceDir: join(root, 'src'),
    outputDir: join(root, mixed ? 'build/mini' : 'build'),
    appRoot: join(root, 'build'),
    routePrefix: mixed ? 'mini' : '',
  };
}

function decode(encoded: string, bytes: number): unknown {
  const decoded = inflateSync(Buffer.from(encoded, 'base64'));
  expect(decoded.byteLength).toBe(bytes);
  return JSON.parse(decoded.toString('utf8'));
}

function factory<T>(result: { source: string }): T {
  const sandbox = { module: { exports: {} } };
  // Generated modules also have to run on miniapp engines without Object.hasOwn.
  expect(() => parse(result.source, { ecmaVersion: 2015 })).not.toThrow();
  runInNewContext(`Object.hasOwn = undefined;\n${result.source}`, sandbox);
  return sandbox.module.exports as T;
}

function styles(result: { source: string }) {
  return factory<StylesFactory>(result)(decode);
}

function images(result: { source: string }, root: string) {
  return factory<ImagesFactory>(result)(decode, (path) =>
    readFileSync(join(root, 'build', path), 'base64'),
  );
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>';
function svgUri(source: string) {
  return `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
}

describe('Replay image preparation', () => {
  test('discovers all five page and component SVGs recursively without adding unrelated images', () => {
    const icons = Array.from({ length: 5 }, (_, index) => SVG.replace('h1', `h${index + 2}`));
    const files: Record<string, string> = {
      'build/mini/app.json': JSON.stringify({
        pages: ['pages/Gallery/index', 'pages/Other/index'],
      }),
      'build/mini/pages/Gallery/index.js': 'require("../../components/Badge/index");',
      'build/mini/components/Badge/index.js': icons
        .map((icon) => JSON.stringify(svgUri(icon)))
        .join(';'),
      'build/mini/pages/Other/index.js': 'module.exports={};',
      'src/assets/unreferenced.svg': SVG,
    };
    icons.forEach((icon, index) => {
      const directory = index < 3 ? 'pages/Gallery/assets/nested' : 'components/Badge/assets';
      files[`src/${directory}/icon-${index}.svg`] = icon;
    });
    const root = fixture(files);
    const result = buildReplayAssets(options(root));
    const get = images(result.images, root);

    expect(get('pages/Gallery/index')).toEqual(
      Object.fromEntries(icons.map((icon) => [svgUri(icon), svgUri(icon)])),
    );
    expect(get('pages/Other/index')).toEqual({});
    expect(Object.keys(result.images.sources)).toHaveLength(5);
    expect(readFileSync(join(root, 'build/mini/pages/Gallery/index.js'), 'utf8')).toBe(
      files['build/mini/pages/Gallery/index.js'],
    );
  });

  test('canonicalizes percent SVGs and preserves source-backed base64 and packaged SVGs', () => {
    const base64 = svgUri(SVG);
    const percent = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
    const root = fixture({
      'build/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/mini/pages/Gallery/index.js': `${JSON.stringify(base64)};${JSON.stringify(percent)};"assets/icon.svg";`,
      'build/mini/assets/icon.svg': SVG,
      'src/pages/Gallery/assets/icon.svg': SVG,
    });
    expect(images(buildReplayAssets(options(root)).images, root)('pages/Gallery/index')).toEqual({
      [base64]: base64,
      [percent]: base64,
      '/mini/assets/icon.svg': base64,
    });
  });

  test('follows app and route dependencies, cuts JS cycles, and supports subpackages', () => {
    const inline = 'data:image/png;base64,aWNvbg==';
    const root = fixture({
      'build/mini/app.json': JSON.stringify({
        pages: ['pages/Gallery/index'],
        subpackages: [{ root: 'packages/Details', pages: ['index'] }],
      }),
      'build/mini/app.js': 'require("./common");',
      'build/mini/common.js': 'module.exports="assets/logo.png";',
      'build/mini/assets/logo.png': 'logo',
      'build/mini/pages/Gallery/index.js': 'require("./icons");"pages/Gallery/banner.png";',
      'build/mini/pages/Gallery/icons.js': `require("./index.js");${JSON.stringify(inline)};`,
      'build/mini/pages/Gallery/banner.png': 'banner',
      'build/mini/packages/Details/index.js': '"packages/Details/detail.webp";',
      'build/mini/packages/Details/detail.webp': 'detail',
    });
    const result = buildReplayAssets(options(root));
    const get = images(result.images, root);
    expect(get('//mini//pages/Gallery/index?ignored=value#fragment')).toEqual({
      '/mini/assets/logo.png': 'data:image/png;base64,bG9nbw==',
      '/mini/pages/Gallery/banner.png': 'data:image/png;base64,YmFubmVy',
      [inline]: inline,
    });
    expect(get('packages/Details/index')).toEqual({
      '/mini/assets/logo.png': 'data:image/png;base64,bG9nbw==',
      '/mini/packages/Details/detail.webp': 'data:image/webp;base64,ZGV0YWls',
    });
    for (const route of ['unknown', '__proto__', 'constructor', 'https://example.com/image.png']) {
      expect(get(route)).toEqual({});
    }
  });

  test('rejects unbacked SVGs, malformed data URIs, external paths, and escaping symlinks', () => {
    const unbacked = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>';
    const root = fixture({
      'build/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/mini/pages/Gallery/index.js': [
        JSON.stringify(svgUri(SVG) + '='),
        '"data:image/svg+xml,%Q0"',
        JSON.stringify(svgUri(unbacked)),
        '"https://example.com/icon.png"',
        '"//example.com/icon.png"',
        '"assets/local.png?secret=value"',
        '"../outside.png"',
        '"assets/unbacked.svg"',
        '"assets/escape.png"',
        '"assets/escape.svg"',
        'require("../escape.js")',
      ].join(';'),
      'build/mini/assets/local.png': 'local',
      'build/mini/assets/unbacked.svg': unbacked,
      'src/assets/icon.svg': SVG,
    });
    const outside = fixture({
      'private.png': 'private',
      'private.svg': unbacked,
      'private.js': '"data:image/png;base64,cHJpdmF0ZQ==";',
    });
    symlinkSync(join(outside, 'private.png'), join(root, 'build/mini/assets/escape.png'));
    symlinkSync(join(outside, 'private.svg'), join(root, 'build/mini/assets/escape.svg'));
    symlinkSync(join(outside, 'private.js'), join(root, 'build/mini/pages/escape.js'));
    symlinkSync(join(outside, 'private.svg'), join(root, 'src/assets/escape.svg'));
    symlinkSync(outside, join(root, 'src/assets/escape-directory'));
    expect(images(buildReplayAssets(options(root)).images, root)('pages/Gallery/index')).toEqual(
      {},
    );
  });

  test('reserves snapshot room and prioritizes configured assets within the serialized src budget', () => {
    const inline = `data:image/png;base64,${'a'.repeat(40 * 1024)}`;
    const root = fixture({
      'build/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/mini/pages/Gallery/index.js': `${JSON.stringify(inline)};"assets/logo.png";"assets/large.png";"assets/oversized.svg";`,
      'build/mini/assets/logo.png': 'logo',
      'build/mini/assets/large.png': Buffer.alloc(60 * 1024),
      'build/mini/assets/oversized.svg': `<svg>${' '.repeat(128 * 1024)}</svg>`,
      'src/assets/oversized.svg': `<svg>${' '.repeat(128 * 1024)}</svg>`,
    });
    const result = buildReplayImageSources({
      ...options(root),
      imagePriority: ['assets/logo.png'],
    });
    const get = images(result, root);
    expect(get('pages/Gallery/index')).toEqual({
      '/mini/assets/logo.png': 'data:image/png;base64,bG9nbw==',
      [inline]: inline,
    });
    expect(result.budgets['pages/Gallery/index']?.budget).toBe(64 * 1024);
    expect(result.budgets['pages/Gallery/index']?.imageSrcBudgetBytes).toBe(
      Buffer.byteLength(JSON.stringify({ src: 'data:image/png;base64,bG9nbw==' })) +
        Buffer.byteLength(JSON.stringify({ src: inline })),
    );
    const exhausted = buildReplayImageSources({
      ...options(root),
      stylesheetBytes: { 'pages/Gallery/index': 384 * 1024 },
    });
    expect(exhausted.budgets['pages/Gallery/index']?.budget).toBe(0);
    expect(images(exhausted, root)('pages/Gallery/index')).toEqual({});
  });

  test('selects configured priority before other images when only one image fits', () => {
    const root = fixture({
      'build/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/pages/Gallery/index.js': '"assets/first.png";"assets/preferred.png";',
      'build/assets/first.png': Buffer.alloc(600, 1),
      'build/assets/preferred.png': Buffer.alloc(600, 2),
    });
    const constrained = {
      ...options(root, false),
      stylesheetBytes: { 'pages/Gallery/index': 384 * 1024 - 1024 },
    };
    for (const priority of ['assets/first.png', 'assets/preferred.png']) {
      const prioritized = buildReplayImageSources({ ...constrained, imagePriority: [priority] });
      expect(Object.keys(images(prioritized, root)('pages/Gallery/index'))).toEqual([
        `/${priority}`,
      ]);
      expect(prioritized.budgets['pages/Gallery/index']?.budget).toBe(1024);
    }
  });
});

describe('Replay stylesheet preparation', () => {
  test('preserves host and page import cascade while storing shared chunks once', () => {
    const root = fixture({
      'build/app.wxss': '@import "./mini/app.wxss";page{color:host}.theme{color:host}',
      'build/mini/app.json': JSON.stringify({
        pages: ['pages/Gallery/index'],
        subPackages: [{ root: 'packages/Details', pages: ['index'] }],
      }),
      'build/mini/app.wxss': '@import "./common.wxss";.theme{color:app}',
      'build/mini/common.wxss': 'view{display:flex}',
      'build/mini/pages/Gallery/index.wxss':
        '@import "./shared.wxss";@import "../../app.wxss";.header{padding:24rpx}',
      'build/mini/pages/Gallery/shared.wxss': '.theme{color:shared}',
      'build/mini/packages/Details/index.wxss': '.details{color:purple}',
    });
    const result = buildReplayAssets(options(root));
    const get = styles(result);
    const expected =
      'body{color:host}.theme{color:host}\n.theme{color:shared}\n[data-taro-node=view]{display:flex}\n.theme{color:app}\n.header{padding:24rpx}';
    expect(get('/mini/pages/Gallery/index?ignored=value')).toBe(expected);
    expect(get('//mini//pages/Gallery/index#fragment')).toBe(expected);
    expect(get('pages/Gallery/index')).toBe(expected);
    expect(result.chunks.filter((css) => css.includes('color:app'))).toHaveLength(1);
    expect(get('packages/Details/index')).toMatch(/\.details\{color:purple\}$/);
    expect(get('unknown')).toBe(
      '[data-taro-node=view]{display:flex}\n.theme{color:app}\nbody{color:host}.theme{color:host}',
    );
  });

  test('keeps media imports and repeated layer boundaries in their original order', () => {
    const root = fixture({
      'build/app.json': '{"pages":[]}',
      'build/app.wxss':
        '@import "./common.wxss";@import "./common.wxss" screen;@import "./common.wxss" print;@import "./layer.wxss";@layer later;@import "./layer.wxss";',
      'build/common.wxss': '.shared{color:blue}',
      'build/layer.wxss': '@layer base{.shared{color:red}}',
    });
    const css = styles(buildReplayAssets(options(root, false)))();
    expect(css.match(/\.shared\{color:blue\}/g)).toHaveLength(3);
    expect(css.match(/@layer base/g)).toHaveLength(2);
    expect(css).toContain('@media screen{\n.shared{color:blue}\n}');
    expect(css).toContain('@media print{\n.shared{color:blue}\n}');
    expect(css.lastIndexOf('@layer base')).toBeGreaterThan(css.indexOf('@layer later'));
  });

  test('converts miniapp tags without changing attribute literals, declarations, data URLs or custom property whitespace', () => {
    const root = fixture({
      'build/app.json': '{"pages":[]}',
      'build/app.wxss': `@charset "UTF-8";/* comment */
@font-face{font-family:page;src:url("data:font/woff2;base64,dmlldyBwYWdl")}
page view > text, .view .page, [title="view page"] image, :is(scroll-view, button) { color: red; }
page { --empty: ; --tokens:  red   blue; width: calc(100% - 2px); content: "a  b"; padding: 24rpx; }
.popup { color: red; }.popup { color: blue; }.popup { color: red; }`,
    });
    const css = styles(buildReplayAssets(options(root, false)))();
    expect(css).toContain(
      'body [data-taro-node=view] > [data-taro-node=text], .view .page, [title="view page"] [data-taro-node=image], :is([data-taro-node=scroll-view],[data-taro-node=button])',
    );
    expect(css).toContain(
      '@font-face{font-family:page;src:url("data:font/woff2;base64,dmlldyBwYWdl")}',
    );
    expect(css).toContain('--empty: ;--tokens:  red   blue;');
    expect(css).toContain('width:calc(100% - 2px);content:"a  b";padding:24rpx');
    expect(css).toMatch(/\.popup\{color:red\}\.popup\{color:blue\}\.popup\{color:red\}$/);
    expect(css).not.toContain('/*');
    expect(css).not.toContain('@charset');
  });

  test('cuts CSS cycles and rejects missing, network, parent-escaping and symlink-escaping imports', () => {
    const root = fixture({
      'build/app.json': '{"pages":[]}',
      'build/app.wxss':
        '@import "./cycle.wxss";@import "../outside.wxss";@import "./escape.wxss";@import "./missing.wxss";@import url("https://example.com/private.wxss");.host{color:red}',
      'build/cycle.wxss': '@import "./app.wxss";.cycle{color:blue}',
      'outside.wxss': '.outside{color:yellow}',
    });
    const outside = fixture({ 'private.wxss': '.secret{color:purple}' });
    symlinkSync(join(outside, 'private.wxss'), join(root, 'build/escape.wxss'));
    expect(styles(buildReplayAssets(options(root, false)))()).toBe(
      '.cycle{color:blue}\n.host{color:red}',
    );
  });

  test('resolves root-relative imports against appRoot and preserves media queries', () => {
    const root = fixture({
      'build/app.json': '{"pages":[]}',
      'build/app.wxss':
        '@import url("/common.wxss") screen and (min-width: 320px);.after{color:red}',
      'build/common.wxss': 'text{font-size:24rpx}',
    });
    expect(styles(buildReplayAssets(options(root, false)))()).toBe(
      '@media screen and (min-width: 320px){\n[data-taro-node=text]{font-size:24rpx}\n}\n.after{color:red}',
    );
  });
});

describe('generated miniapp modules', () => {
  test('normalizes logical route prefixes independently of actual package paths', () => {
    const root = fixture({
      'build/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/mini/app.wxss': 'page{color:blue}',
      'build/mini/pages/Gallery/index.js': '"assets/logo.png";',
      'build/mini/assets/logo.png': 'logo',
    });
    const result = buildReplayAssets({ ...options(root), routePrefix: 'logical' });
    expect(styles(result)('/logical/pages/Gallery/index')).toBe('body{color:blue}');
    const read = vi.fn((path: string) => readFileSync(join(root, 'build', path), 'base64'));
    const get = factory<ImagesFactory>(result.images)(decode, read);
    expect(get('/logical/pages/Gallery/index')).toEqual({
      '/mini/assets/logo.png': 'data:image/png;base64,bG9nbw==',
    });
    expect(read.mock.calls).toEqual([['mini/assets/logo.png']]);
    expect(get('/mini/pages/Gallery/index')).toEqual({});
  });

  test('never reads packaged files for unknown routes or unsafe decoded descriptors', () => {
    const root = fixture({
      'build/mini/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/mini/pages/Gallery/index.js': '"assets/logo.png";',
      'build/mini/assets/logo.png': 'logo',
    });
    const result = buildReplayAssets(options(root));
    const read = vi.fn(() => 'bG9nbw==');
    const get = factory<ImagesFactory>(result.images)(decode, read);
    for (const route of ['unknown', '__proto__', 'constructor', '/mini/assets/logo.png']) {
      expect(get(route)).toEqual({});
    }
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
    ]) {
      const altered = factory<ImagesFactory>(result.images)((encoded, bytes) => {
        const manifest = decode(encoded, bytes) as { entries: [string, { path: string }][] };
        manifest.entries[0]![1].path = path;
        return manifest;
      }, read);
      expect(altered('pages/Gallery/index')).toEqual({});
    }
    expect(read).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'supports lazy compression and package reads with mixed root = %s',
    (mixed) => {
      const output = mixed ? 'build/mini' : 'build';
      const prefix = mixed ? 'mini/' : '';
      const root = fixture({
        [`${output}/app.json`]: '{"pages":["pages/Gallery/index","pages/Other/index"]}',
        [`${output}/app.wxss`]: '.dynamic::before{content:"中文😀"}',
        [`${output}/app.js`]: `"assets/logo.png";${JSON.stringify(svgUri(SVG))};`,
        [`${output}/assets/logo.png`]: 'logo',
        'src/components/Badge/icon.svg': SVG,
      });
      const result = buildReplayAssets(options(root, mixed));
      const decodeSpy = vi.fn(decode);
      const readSpy = vi.fn((path: string) => readFileSync(join(root, 'build', path), 'base64'));
      const getStyles = factory<StylesFactory>(result)(decodeSpy);
      const getImages = factory<ImagesFactory>(result.images)(decodeSpy, readSpy);
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      expect(getStyles(`/${prefix}pages/Gallery/index`)).toBe('.dynamic::before{content:"中文😀"}');
      expect(getStyles('pages/Other/index')).toBe(getStyles('pages/Gallery/index'));
      expect(decodeSpy).toHaveBeenCalledTimes(1);
      const first = getImages(`/${prefix}pages/Gallery/index`);
      expect(first[`/${prefix}assets/logo.png`]).toBe('data:image/png;base64,bG9nbw==');
      first[`/${prefix}assets/logo.png`] = 'changed';
      expect(getImages('pages/Other/index')[`/${prefix}assets/logo.png`]).toBe(
        'data:image/png;base64,bG9nbw==',
      );
      expect(getImages('unknown')).toEqual({});
      expect(decodeSpy).toHaveBeenCalledTimes(2);
      expect(readSpy.mock.calls).toEqual([[`${prefix}assets/logo.png`]]);
      expect(result.source).not.toContain('中文😀');
      expect(JSON.stringify(decodeSpy.mock.results[1]?.value)).not.toContain('bG9nbw==');
    },
  );

  test('retries failed decodes and package reads without losing inline images', () => {
    const inline = 'data:image/png;base64,aWNvbg==';
    const root = fixture({
      'build/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/app.wxss': '.popup{color:blue}',
      'build/app.js': `"assets/home.png";${JSON.stringify(inline)};`,
      'build/assets/home.png': 'home',
    });
    const result = buildReplayAssets(options(root, false));
    const decodeSpy = vi.fn(decode).mockImplementationOnce(() => {
      throw new Error('decoder unavailable');
    });
    const getStyles = factory<StylesFactory>(result)(decodeSpy);
    expect(getStyles('pages/Gallery/index')).toBe('');
    expect(getStyles('pages/Gallery/index')).toBe('.popup{color:blue}');
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    for (const invalid of [
      undefined,
      new ArrayBuffer(4),
      '',
      'AA==',
      'aG9tZQ=',
      'aG9tZR==',
      'aG9tZQA=',
    ]) {
      const read = vi.fn<ReadImage>().mockReturnValueOnce(invalid).mockReturnValue('aG9tZQ==');
      const getImages = factory<ImagesFactory>(result.images)(decode, read);
      expect(getImages('pages/Gallery/index')).toEqual({ [inline]: inline });
      expect(getImages('pages/Gallery/index')['/assets/home.png']).toBe(
        'data:image/png;base64,aG9tZQ==',
      );
      getImages('pages/Gallery/index');
      expect(read).toHaveBeenCalledTimes(2);
    }
    const read = vi
      .fn<ReadImage>()
      .mockImplementationOnce(() => {
        throw new Error('file unavailable');
      })
      .mockReturnValue('aG9tZQ==');
    const getImages = factory<ImagesFactory>(result.images)(decode, read);
    expect(getImages('pages/Gallery/index')).toEqual({ [inline]: inline });
    expect(getImages('pages/Gallery/index')['/assets/home.png']).toBe(
      'data:image/png;base64,aG9tZQ==',
    );
  });

  test('noncompact modules produce equivalent output without a decoder or package reader', () => {
    const root = fixture({
      'build/app.json': '{"pages":["pages/Gallery/index"]}',
      'build/app.wxss': '.popup{color:blue}',
      'build/app.js': `"assets/home.png";${JSON.stringify(svgUri(SVG))};`,
      'build/assets/home.png': 'home',
      'src/assets/icon.svg': SVG,
    });
    const compact = buildReplayAssets(options(root, false));
    const expanded = buildReplayAssets({ ...options(root, false), compactAssets: false });
    const unexpected = () => {
      throw new Error('must not decode or read');
    };
    expect(factory<StylesFactory>(expanded)(unexpected)('pages/Gallery/index')).toBe(
      styles(compact)('pages/Gallery/index'),
    );
    expect(
      factory<ImagesFactory>(expanded.images)(unexpected, unexpected)('pages/Gallery/index'),
    ).toEqual(images(compact.images, root)('pages/Gallery/index'));
  });
});
