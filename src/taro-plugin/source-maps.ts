const PLUGIN_NAME = 'PreserveTaroSourceMapOffsets';

/** The flat version 3 maps emitted by Webpack's SourceMapDevToolPlugin. */
export interface TaroSourceMap {
  version: number;
  sources: string[];
  names: string[];
  mappings: string;
  file?: string;
  sourceRoot?: string;
  sourcesContent?: (string | null)[];
}

interface AssetSource {
  // Structural binary output keeps Node globals out of the public declaration graph.
  source(): string | { toString(): string };
}

interface MappedSource extends AssetSource {
  map(options?: { columns?: boolean }): TaroSourceMap | null;
}

interface ReplaceableSource extends MappedSource {
  replace(start: number, end: number, replacement: string): void;
  insert(position: number, insertion: string): void;
}

/** Uses the compiler's own sources implementation without importing Webpack at runtime. */
export interface WebpackMapSources<
  TSource extends MappedSource = MappedSource,
  TRawSource extends AssetSource = AssetSource,
> {
  SourceMapSource: new (code: string, name: string, sourceMap: string) => TSource;
  ReplaceSource: new (source: TSource) => ReplaceableSource;
  RawSource: new (code: string) => TRawSource;
}

interface CompilationAsset<TSource extends AssetSource = AssetSource> {
  name: string;
  info?: { minimized?: boolean };
  source: TSource;
}

export interface SourceMapCompilation<TRawSource extends AssetSource = AssetSource> {
  hooks: {
    processAdditionalAssets?: {
      tap(
        options: { name: string; before: string },
        callback: (assets: Record<string, AssetSource>) => void,
      ): void;
    };
    processAssets: {
      tap(options: { name: string; stage: number }, callback: () => void): void;
    };
  };
  getAssets(): CompilationAsset<TRawSource>[];
  getAsset(name: string): CompilationAsset<TRawSource> | undefined;
  updateAsset(name: string, source: TRawSource, info?: { minimized?: boolean }): void;
  deleteAsset(name: string): void;
}

/** Structural subset of a Webpack 5 compiler accepted by the Taro runner. */
export interface SourceMapCompiler<
  TSource extends MappedSource = MappedSource,
  TRawSource extends AssetSource = AssetSource,
> {
  webpack: {
    Compilation: {
      PROCESS_ASSETS_STAGE_SUMMARIZE: number;
      PROCESS_ASSETS_STAGE_REPORT: number;
    };
    sources: WebpackMapSources<TSource, TRawSource>;
  };
  hooks: {
    thisCompilation: {
      tap(
        name: string,
        callback: (compilation: SourceMapCompilation<NoInfer<TRawSource>>) => void,
      ): void;
    };
  };
}

export interface PreserveTaroSourceMapOptions {
  debug?: boolean;
  silent?: boolean;
  /** Stop the build by default. A returning handler discards the failed map and continues. */
  errorHandler?: (error: Error) => void;
}

function parseSourceMap(value: string): TaroSourceMap {
  const map: unknown = JSON.parse(value);
  if (
    !map ||
    typeof map !== 'object' ||
    !('version' in map) ||
    map.version !== 3 ||
    !('mappings' in map) ||
    typeof map.mappings !== 'string' ||
    !('sources' in map) ||
    !Array.isArray(map.sources) ||
    map.sources.some((source: unknown) => typeof source !== 'string') ||
    !('names' in map) ||
    !Array.isArray(map.names) ||
    map.names.some((name: unknown) => typeof name !== 'string')
  ) {
    throw new Error('Expected a flat version 3 Webpack source map');
  }
  if ('file' in map && typeof map.file !== 'string') {
    throw new Error('Expected a string source map file name');
  }
  return map as TaroSourceMap;
}

/** Repair only Taro's known prefix insertion and first strict-directive relocation. */
export function mapAfterPrefixInjection<TSource extends MappedSource>(
  originalCode: string,
  finalCode: string,
  originalMap: TaroSourceMap,
  sources: WebpackMapSources<TSource>,
): TaroSourceMap {
  const strict = '"use strict";';
  const strictOffset = originalCode.indexOf(strict);
  const withoutStrict = originalCode.replace(strict, '');
  const removeStrict =
    !finalCode.endsWith(originalCode) && strictOffset >= 0 && finalCode.endsWith(withoutStrict);
  const suffix = removeStrict ? withoutStrict : originalCode;
  if (!finalCode.endsWith(suffix)) {
    throw new Error('Unexpected Taro JavaScript rewrite after source-map emission');
  }
  const prefix = finalCode.slice(0, finalCode.length - suffix.length);
  const mapped = new sources.SourceMapSource(
    originalCode,
    originalMap.file || 'bundle.js',
    JSON.stringify(originalMap),
  );
  const updated = new sources.ReplaceSource(mapped);
  // Taro may move the first strict directive even when it starts inside a module function.
  if (removeStrict) updated.replace(strictOffset, strictOffset + strict.length - 1, '');
  updated.insert(0, prefix);
  if (updated.source().toString() !== finalCode) {
    throw new Error('Taro source-map repair changed generated JavaScript');
  }
  const updatedMap = updated.map({ columns: true });
  if (!updatedMap) throw new Error('Taro source-map repair produced no mapping');
  return { ...updatedMap, ...(originalMap.file === undefined ? {} : { file: originalMap.file }) };
}

const SOURCE_PREFIX = /^([a-z][a-z\d+.-]*:\/\/[^/]*\/)?(.*)$/i;
/** Marks sources that Webpack named relative to an input map outside the project root. */
export const EXTERNAL_SOURCE_DIR = '__external__';
/** WeChat turns empty content into null, so a missing source needs non-empty text. */
export const UNAVAILABLE_SOURCE_CONTENT = '/* sentry-taro: original source unavailable */';

function normalizeSourcePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  let escapes = 0;
  while (parts[escapes] === '..') escapes += 1;
  const inside = parts.slice(escapes).join('/');
  return escapes ? `${EXTERNAL_SOURCE_DIR}/${inside}` : inside;
}

/**
 * Prepares a map for WeChat's final compilation, which drops a file's whole map when any
 * `sourcesContent` entry is null or empty, and collapses `../` source names (merging or
 * emptying sources). Escaping names become unique `__external__/…` names; missing content
 * becomes a placeholder comment.
 */
export function prepareSourceMapForWeChat(map: TaroSourceMap): TaroSourceMap | undefined {
  const used = new Set<string>();
  let changed = false;
  const sources = map.sources.map((source) => {
    const [, prefix = '', path = ''] = SOURCE_PREFIX.exec(source) ?? [];
    const query = path.search(/[?#]/);
    const pathname = query < 0 ? path : path.slice(0, query);
    const suffix = query < 0 ? '' : path.slice(query);
    let name = `${prefix}${normalizeSourcePath(pathname)}${suffix}`;
    for (let index = 2; used.has(name); index += 1) {
      name = `${prefix}${normalizeSourcePath(pathname)}${suffix || '?'}${suffix ? '&' : ''}${index}`;
    }
    used.add(name);
    if (name !== source) changed = true;
    return name;
  });
  const content = map.sourcesContent;
  // Webpack omits the whole array when every entry is null; treat that like null entries.
  const sourcesContent = map.sources.map(
    (_, index) => content?.[index] || UNAVAILABLE_SOURCE_CONTENT,
  );
  if (
    !content ||
    content.length !== sources.length ||
    content.some((value) => typeof value !== 'string' || value === '')
  ) {
    changed = true;
  }
  if (!changed) return undefined;
  return { ...map, sources, sourcesContent };
}

/** Keep maps aligned after Taro's MiniSplitChunksPlugin rewrites emitted JavaScript. */
export class PreserveTaroSourceMapOffsets {
  constructor(private readonly options: PreserveTaroSourceMapOptions = {}) {}

  private handleFailure(
    compilation: Pick<SourceMapCompilation, 'deleteAsset'>,
    name: string,
    cause: unknown,
  ): void {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`${PLUGIN_NAME}: ${name}: ${detail}`);
    if (!this.options.errorHandler) throw error;
    this.options.errorHandler(error);
    // A permitted build must not retain an inaccurate map for a later upload step.
    compilation.deleteAsset(`${name}.map`);
    if (!this.options.silent)
      console.warn(`[sentry-taro] Discarded invalid source map: ${name}.map`);
  }

  apply<TSource extends MappedSource, TRawSource extends AssetSource>(
    compiler: SourceMapCompiler<TSource, TRawSource>,
  ): void {
    const { Compilation, sources } = compiler.webpack;
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      // This state is compilation-local so watch rebuilds cannot reuse stale JavaScript or maps.
      const snapshots = new Map<
        string,
        { code: string; map: TaroSourceMap; mapText: string; minimized: boolean }
      >();
      // MiniSplitChunksPlugin copies sub-common assets by direct assignment. Webpack
      // then treats them as new assets; the lost minimized flag makes Terser run
      // again after map emission. Restore that flag only for byte-identical JS/map
      // pairs, before the minimizer's additional-assets callback can see them.
      compilation.hooks.processAdditionalAssets?.tap(
        { name: PLUGIN_NAME, before: 'TerserPlugin' },
        (assets) => {
          for (const name of Object.keys(assets)) {
            const start = name.lastIndexOf('/sub-common/');
            if (start < 0 || !name.endsWith('.js')) continue;
            const snapshot = snapshots.get(name.slice(start + 1));
            if (!snapshot?.minimized) continue;
            const script = compilation.getAsset(name);
            const map = compilation.getAsset(`${name}.map`);
            if (
              !script ||
              !map ||
              script.source.source().toString() !== snapshot.code ||
              map.source.source().toString() !== snapshot.mapText
            )
              continue;
            compilation.updateAsset(name, script.source, { minimized: true });
          }
        },
      );
      compilation.hooks.processAssets.tap(
        { name: PLUGIN_NAME, stage: Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE },
        () => {
          for (const { name, source } of compilation.getAssets()) {
            if (!name.endsWith('.js')) continue;
            const map = compilation.getAsset(`${name}.map`);
            if (!map) continue;
            try {
              snapshots.set(name, {
                code: source.source().toString(),
                map: parseSourceMap(map.source.source().toString()),
                mapText: map.source.source().toString(),
                minimized: compilation.getAsset(name)?.info?.minimized === true,
              });
            } catch (cause) {
              this.handleFailure(compilation, name, cause);
            }
          }
        },
      );
      // MiniSplitChunksPlugin inserts require() calls at ANALYSE, after .map emission.
      compilation.hooks.processAssets.tap(
        { name: PLUGIN_NAME, stage: Compilation.PROCESS_ASSETS_STAGE_REPORT },
        () => {
          let repaired = 0;
          for (const [name, snapshot] of snapshots) {
            const script = compilation.getAsset(name);
            if (!script || !compilation.getAsset(`${name}.map`)) continue;
            try {
              const finalCode = script.source.source().toString();
              if (finalCode === snapshot.code) continue;
              const map = mapAfterPrefixInjection(snapshot.code, finalCode, snapshot.map, sources);
              compilation.updateAsset(`${name}.map`, new sources.RawSource(JSON.stringify(map)));
              repaired += 1;
            } catch (cause) {
              this.handleFailure(compilation, name, cause);
            }
          }
          if (this.options.debug && !this.options.silent) {
            console.log(`[sentry-taro] Repaired ${repaired} Taro source maps.`);
          }
        },
      );
      // After offset repair, so every emitted map reaches WeChat in a form it keeps.
      compilation.hooks.processAssets.tap(
        { name: PLUGIN_NAME, stage: Compilation.PROCESS_ASSETS_STAGE_REPORT + 1 },
        () => {
          let prepared = 0;
          for (const { name, source } of compilation.getAssets()) {
            if (!name.endsWith('.js.map')) continue;
            try {
              const map = prepareSourceMapForWeChat(parseSourceMap(source.source().toString()));
              if (!map) continue;
              compilation.updateAsset(name, new sources.RawSource(JSON.stringify(map)));
              prepared += 1;
            } catch (cause) {
              this.handleFailure(compilation, name.slice(0, -'.map'.length), cause);
            }
          }
          if (this.options.debug && !this.options.silent) {
            console.log(`[sentry-taro] Prepared ${prepared} source maps for WeChat.`);
          }
        },
      );
    });
  }
}
