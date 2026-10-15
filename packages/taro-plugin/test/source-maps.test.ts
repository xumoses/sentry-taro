import { createRequire } from 'node:module';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import {
  PreserveTaroSourceMapOffsets,
  mapAfterPrefixInjection,
  type PreserveTaroSourceMapOptions,
  type SourceMapCompilation,
  type SourceMapCompiler,
  type TaroSourceMap,
  type WebpackMapSources,
} from '../src/source-maps';

// Exercise the real Webpack implementation, while production gets it from compiler.webpack.
const require = createRequire(import.meta.url);
const sources = require('webpack-sources') as WebpackMapSources;
const originalCode = '"use strict";throw new Error("example");';
const originalSource = '// original source\nthrow new Error("example");';
const sourcePath = 'webpack://example/src/page.ts';
const assetName = 'pages/example/index.js';

afterEach(() => vi.restoreAllMocks());

function sourceMap(column = 13): TaroSourceMap {
  // A single mapping: generated column -> source index 0, original line 2, column 0.
  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let value = column * 2;
  let generatedColumn = '';
  do {
    let digit = value & 31;
    value >>>= 5;
    if (value > 0) digit |= 32;
    generatedColumn += base64[digit];
  } while (value > 0);
  return {
    version: 3,
    file: assetName,
    sources: [sourcePath],
    sourcesContent: [originalSource],
    names: [],
    mappings: `${generatedColumn}ACA`,
  };
}

function expectOriginal(map: TaroSourceMap, line: number, column: number): void {
  expect(originalPositionFor(new TraceMap(JSON.stringify(map)), { line, column })).toEqual({
    source: sourcePath,
    line: 2,
    column: 0,
    name: null,
  });
}

function harness(options: PreserveTaroSourceMapOptions = {}) {
  const listeners: ((compilation: SourceMapCompilation) => void)[] = [];
  const compiler: SourceMapCompiler = {
    webpack: {
      Compilation: { PROCESS_ASSETS_STAGE_SUMMARIZE: 1000, PROCESS_ASSETS_STAGE_REPORT: 5000 },
      sources,
    },
    hooks: { thisCompilation: { tap: (_name, callback) => listeners.push(callback) } },
  };
  new PreserveTaroSourceMapOffsets(options).apply(compiler);
  function compile(input: Record<string, string>) {
    const assets = new Map(
      Object.entries(input).map(([name, value]) => [
        name,
        { name, source: new sources.RawSource(value) },
      ]),
    );
    const stages: { stage: number; callback: () => void }[] = [];
    const compilation: SourceMapCompilation = {
      hooks: {
        processAssets: { tap: ({ stage }, callback) => stages.push({ stage, callback }) },
      },
      getAssets: () => [...assets.values()],
      getAsset: (name) => assets.get(name),
      updateAsset: vi.fn((name, source) => assets.set(name, { name, source })),
      deleteAsset: vi.fn((name) => assets.delete(name)),
    };
    for (const listener of listeners) listener(compilation);
    return {
      stages,
      compilation,
      run: (stage: number) => {
        for (const callback of stages.filter((item) => item.stage === stage)) callback.callback();
      },
      write: (name: string, code: string) =>
        assets.set(name, { name, source: new sources.RawSource(code) }),
      read: (name: string) => assets.get(name)?.source.source().toString(),
      map: () =>
        JSON.parse(assets.get(`${assetName}.map`)!.source.source().toString()) as TaroSourceMap,
    };
  }
  return { compile };
}

describe('Taro source map offset repair', () => {
  test('preserves original columns and source content when Taro inserts dependency requires', () => {
    const requires = 'require("./one");require("./two");';
    const finalCode = `"use strict";${requires}${originalCode.slice(13)}`;
    const map = mapAfterPrefixInjection(originalCode, finalCode, sourceMap(), sources);
    expectOriginal(map, 1, 13 + requires.length);
    expect(map.sourcesContent).toEqual([originalSource]);
    expect(map.file).toBe(assetName);
    // The injected dependency code did not exist in the original source.
    expect(
      originalPositionFor(new TraceMap(JSON.stringify(map)), { line: 1, column: 0 }).source,
    ).toBeNull();
  });

  test('preserves line mappings for a dependency prefix containing a newline', () => {
    const finalCode = `"use strict";require("./one");\n${originalCode.slice(13)}`;
    expectOriginal(mapAfterPrefixInjection(originalCode, finalCode, sourceMap(), sources), 2, 0);
  });

  test('handles a plain prefix without removing a strict directive that remains in place', () => {
    const prefix = 'require("./one");';
    const finalCode = `${prefix}${originalCode}`;
    const map = mapAfterPrefixInjection(originalCode, finalCode, sourceMap(), sources);
    expectOriginal(map, 1, prefix.length + 13);
  });

  test('handles prefixes for scripts without a strict directive', () => {
    const code = 'throw new Error("example");';
    const prefix = 'require("./one");\n';
    expectOriginal(mapAfterPrefixInjection(code, prefix + code, sourceMap(0), sources), 2, 0);
  });

  test('relocates a module strict directive without losing the original throw position', () => {
    const moduleCode = 'function page(){"use strict";throw new Error("example");}';
    const finalCode = `"use strict";require("./one");${moduleCode.replace('"use strict";', '')}`;
    const map = mapAfterPrefixInjection(
      moduleCode,
      finalCode,
      sourceMap(moduleCode.indexOf('throw')),
      sources,
    );
    expectOriginal(map, 1, finalCode.indexOf('throw'));
  });

  test('fails closed for unknown late rewrites', () => {
    expect(() =>
      mapAfterPrefixInjection(originalCode, 'throw new Error("changed");', sourceMap(), sources),
    ).toThrow('Unexpected Taro JavaScript rewrite');
  });

  test('verifies repair recreates the exact emitted JavaScript before accepting a mapping', () => {
    class InvalidReplaceSource extends sources.ReplaceSource {
      override source() {
        return 'unexpected code';
      }
    }
    expect(() =>
      mapAfterPrefixInjection(originalCode, `require("./one");${originalCode}`, sourceMap(), {
        ...sources,
        ReplaceSource: InvalidReplaceSource,
      }),
    ).toThrow('repair changed generated JavaScript');
  });

  test('does not accept an implementation that loses all mapping data', () => {
    class UnmappedReplaceSource extends sources.ReplaceSource {
      override map() {
        return null;
      }
    }
    expect(() =>
      mapAfterPrefixInjection(originalCode, `require("./one");${originalCode}`, sourceMap(), {
        ...sources,
        ReplaceSource: UnmappedReplaceSource,
      }),
    ).toThrow('repair produced no mapping');
  });
});

describe('Webpack compilation integration', () => {
  test('snapshots before ANALYSE, repairs at REPORT, and never changes JavaScript', () => {
    const compilation = harness().compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
      'unmapped.js': 'module.exports = {};',
      'app.wxss': 'page{color:red}',
    });
    expect(compilation.stages.map((item) => item.stage)).toEqual([1000, 5000]);
    compilation.run(1000);
    const finalCode = `require("./one");\n${originalCode}`;
    compilation.write(assetName, finalCode);
    compilation.run(5000);
    expectOriginal(compilation.map(), 2, 13);
    expect(compilation.read(assetName)).toBe(finalCode);
    expect(compilation.compilation.updateAsset).toHaveBeenCalledTimes(1);
    expect(compilation.compilation.updateAsset).toHaveBeenCalledWith(
      `${assetName}.map`,
      expect.anything(),
    );
    expect(compilation.compilation.deleteAsset).not.toHaveBeenCalled();
  });

  test('does not rewrite maps when generated JavaScript is unchanged', () => {
    const map = JSON.stringify(sourceMap());
    const compilation = harness().compile({ [assetName]: originalCode, [`${assetName}.map`]: map });
    compilation.run(1000);
    compilation.run(5000);
    expect(compilation.read(`${assetName}.map`)).toBe(map);
    expect(compilation.compilation.updateAsset).not.toHaveBeenCalled();
  });

  test('isolates snapshots for subsequent watch compilations', () => {
    const plugin = harness();
    const first = plugin.compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
    });
    first.run(1000);
    first.write(assetName, `require("./one");${originalCode}`);
    first.run(5000);
    const second = plugin.compile({ 'another.js': 'module.exports = {};' });
    second.run(1000);
    second.run(5000);
    expect(second.compilation.updateAsset).not.toHaveBeenCalled();
  });

  test('ignores assets removed after snapshot without recreating them', () => {
    const compilation = harness().compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
    });
    compilation.run(1000);
    compilation.compilation.deleteAsset(assetName);
    compilation.run(5000);
    expect(compilation.compilation.updateAsset).not.toHaveBeenCalled();
  });

  test('fails the build on an unknown late rewrite by default', () => {
    const compilation = harness().compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
    });
    compilation.run(1000);
    compilation.write(assetName, 'throw new Error("changed");');
    expect(() => compilation.run(5000)).toThrow(
      `PreserveTaroSourceMapOffsets: ${assetName}: Unexpected Taro`,
    );
  });

  test('a returning errorHandler removes only the failed map and preserves other mappings', () => {
    const errorHandler = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const compilation = harness({ errorHandler }).compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
      'other.js': originalCode,
      'other.js.map': JSON.stringify({ ...sourceMap(), file: 'other.js' }),
    });
    compilation.run(1000);
    const changedCode = 'throw new Error("changed");';
    compilation.write(assetName, changedCode);
    compilation.write('other.js', `require("./one");${originalCode}`);
    expect(() => compilation.run(5000)).not.toThrow();
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(compilation.read(`${assetName}.map`)).toBeUndefined();
    expect(compilation.read(assetName)).toBe(changedCode);
    expect(compilation.read('other.js.map')).toBeDefined();
    expect(compilation.compilation.updateAsset).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  test('allows errorHandler to deliberately stop a build', () => {
    const error = new Error('reject compilation');
    const compilation = harness({
      errorHandler: () => {
        throw error;
      },
    }).compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
    });
    compilation.run(1000);
    compilation.write(assetName, 'changed();');
    expect(() => compilation.run(5000)).toThrow(error);
  });

  test.each([
    '{',
    '{"version":3,"sections":[]}',
    '{"version":3,"sources":[],"names":[],"mappings":"","file":10}',
  ])('rejects invalid or indexed maps before collecting a snapshot: %s', (map) => {
    const compilation = harness().compile({ [assetName]: originalCode, [`${assetName}.map`]: map });
    expect(() => compilation.run(1000)).toThrow();
  });

  test('a returning handler also removes malformed maps discovered during snapshot', () => {
    const errorHandler = vi.fn();
    const compilation = harness({ errorHandler, silent: true }).compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: '{',
    });
    compilation.run(1000);
    compilation.run(5000);
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(compilation.read(`${assetName}.map`)).toBeUndefined();
    expect(compilation.read(assetName)).toBe(originalCode);
  });

  test('silent suppresses diagnostics while preserving the caller errorHandler', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorHandler = vi.fn();
    const compilation = harness({ debug: true, silent: true, errorHandler }).compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
    });
    compilation.run(1000);
    compilation.write(assetName, 'changed();');
    compilation.run(5000);
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test('debug reports repaired counts without including JavaScript or map contents', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const compilation = harness({ debug: true }).compile({
      [assetName]: originalCode,
      [`${assetName}.map`]: JSON.stringify(sourceMap()),
    });
    compilation.run(1000);
    compilation.write(assetName, `require("./one");${originalCode}`);
    compilation.run(5000);
    expect(log).toHaveBeenCalledWith('[sentry-taro] Repaired 1 Taro source maps.');
    expect(JSON.stringify(log.mock.calls)).not.toContain(originalSource);
  });
});
