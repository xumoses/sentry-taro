import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { parse } from 'acorn';
import postcss, { type Root } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { IMAGES_RUNTIME, ROUTE_RUNTIME, STYLES_RUNTIME } from './runtime';

export interface ReplayAssetsBuildOptions {
  sourceDir: string;
  outputDir: string;
  appRoot: string;
  routePrefix?: string;
  compactAssets?: boolean;
  /** Exact image keys or path suffixes, in descending priority. */
  imagePriority?: string[];
  onDiagnostic?: (message: string) => void;
}

export type StyleReference = number | { index: number };

export interface ReplayImageBudget {
  budget: number;
  mapJSONBytes: number;
  imageSrcBudgetBytes: number;
  count: number;
}

export interface ReplayEncodedAssetData {
  encoded: string;
  byteLength: number;
}

export interface ReplayImageAssets {
  source: string;
  sources: Record<string, string>;
  pages: Record<string, string[]>;
  budgets: Record<string, ReplayImageBudget>;
  packedData: ReplayEncodedAssetData;
}

export interface ReplayAssets {
  source: string;
  /** Versioned JSON container for runtime filesystem providers. */
  assetData: string;
  chunks: string[];
  app: StyleReference[];
  pages: Record<string, StyleReference[]>;
  images: ReplayImageAssets;
}

interface BuildContext {
  root: string;
  outputDir: string;
  prefix: string;
  packagePrefix: string;
  routes: string[];
}

interface PackagedImage {
  path: string;
  mime: string;
  bytes: number;
}

interface ScriptReferences {
  dependencies: string[];
  sources: Set<string>;
}

type StylePart = { chunk: number } | { path: string; media: string };
type ImageEntry = [string] | [string, string | PackagedImage];
type AstNode = { type: string; [key: string]: unknown };

const MINIAPP_TAGS = new Set([
  'view',
  'text',
  'scroll-view',
  'image',
  'button',
  'input',
  'textarea',
  'navigator',
  'swiper',
  'swiper-item',
  'form',
  'label',
  'picker',
  'picker-view',
  'picker-view-column',
  'checkbox',
  'checkbox-group',
  'radio',
  'radio-group',
  'switch',
  'slider',
  'progress',
  'canvas',
  'video',
  'audio',
  'map',
  'web-view',
  'cover-view',
  'cover-image',
  'rich-text',
  'movable-area',
  'movable-view',
  'block',
  'icon',
  'ad',
  'ad-custom',
  'editor',
  'official-account',
  'live-player',
  'live-pusher',
  'page-container',
  'root-portal',
  'match-media',
]);

const IMAGE_MIME: Record<string, string> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  avif: 'avif',
};
const MAX_IMAGE_URI_BYTES = 128 * 1024;
const MAX_ROUTE_IMAGE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const SNAPSHOT_STRUCTURE_RESERVE_BYTES = 128 * 1024;
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

function insideRoot(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function normalizedPrefix(value: string): string {
  const prefix = value
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  if (
    prefix &&
    (/[?#\0:]/.test(prefix) || prefix.split('/').some((part) => part === '.' || part === '..'))
  ) {
    throw new Error('Replay routePrefix must be a relative mini program route prefix');
  }
  return prefix ? `${prefix}/` : '';
}

function buildContext(options: ReplayAssetsBuildOptions): BuildContext {
  const root = realpathSync(options.appRoot);
  const outputDir = realpathSync(options.outputDir);
  if (
    !statSync(root).isDirectory() ||
    !statSync(outputDir).isDirectory() ||
    !insideRoot(root, outputDir)
  ) {
    throw new Error('Replay outputDir must be a directory inside appRoot');
  }
  const packagePrefix = normalizedPrefix(relative(root, outputDir).split(sep).join('/'));
  const prefix =
    options.routePrefix === undefined ? packagePrefix : normalizedPrefix(options.routePrefix);
  const config = JSON.parse(readFileSync(join(outputDir, 'app.json'), 'utf8')) as {
    pages?: string[];
    subpackages?: { root: string; pages?: string[] }[];
    subPackages?: { root: string; pages?: string[] }[];
  };
  const routes = [...(config.pages || [])];
  for (const subpackage of config.subpackages || config.subPackages || []) {
    for (const page of subpackage.pages || []) routes.push(`${subpackage.root}/${page}`);
  }
  for (const route of routes) {
    if (
      typeof route !== 'string' ||
      /[\\\0?#:]/.test(route) ||
      route.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('Replay app.json contains an invalid page route');
    }
  }
  return { root, outputDir, prefix, packagePrefix, routes: [...new Set(routes)] };
}

export function replaySelector(selector: string): string {
  return selectorParser((selectors) => {
    selectors.walkTags((tag) => {
      if (tag.value === 'page') tag.value = 'body';
      else if (MINIAPP_TAGS.has(tag.value)) {
        tag.replaceWith(
          selectorParser.attribute({
            attribute: 'data-taro-node',
            operator: '=',
            value: tag.value,
            quoteMark: '"',
            raws: {},
          }),
        );
      }
    });
  }).processSync(selector);
}

export function importTarget(params: string): { target: string; media: string } | null {
  const nodes = valueParser(params).nodes;
  const targetIndex = nodes.findIndex((node) => node.type !== 'space' && node.type !== 'comment');
  const first = nodes[targetIndex];
  let target: string | undefined;
  if (first?.type === 'string') target = first.value;
  else if (first?.type === 'function' && first.value.toLowerCase() === 'url') {
    const values = first.nodes.filter((node) => node.type !== 'space' && node.type !== 'comment');
    if (values.length === 1 && (values[0].type === 'string' || values[0].type === 'word'))
      target = values[0].value;
  }
  if (
    !target ||
    /^[a-z][\w+.-]*:/i.test(target) ||
    target.startsWith('//') ||
    /[?#\0\\]/.test(target)
  )
    return null;
  return { target, media: valueParser.stringify(nodes.slice(targetIndex + 1)).trim() };
}

// Never fetch external imports or allow an import to leave the application root.
function localStylePath(root: string, path: string, from: string): string | null {
  const candidate = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(from), path);
  if (!insideRoot(root, candidate) || !candidate.endsWith('.wxss') || !existsSync(candidate))
    return null;
  const realPath = realpathSync(candidate);
  return insideRoot(root, realPath) && statSync(realPath).isFile() ? realPath : null;
}

export function dedupeStyleReferences(references: StyleReference[], chunks: string[]): number[] {
  const seen = new Set<number>();
  const kept: number[] = [];
  for (let position = references.length - 1; position >= 0; position--) {
    const reference = references[position];
    const index = typeof reference === 'number' ? reference : reference.index;
    // Conditional imports and cascade-layer declarations retain their boundaries.
    const mayDedupe = typeof reference === 'number' && !/@layer\b/i.test(chunks[index]);
    if (!mayDedupe || !seen.has(index)) kept.push(index);
    if (mayDedupe) seen.add(index);
  }
  return kept.reverse();
}

function compressedReplayData(value: unknown): ReplayEncodedAssetData {
  const json = Buffer.from(JSON.stringify(value));
  return {
    encoded: deflateSync(json, { level: 9 }).toString('base64'),
    byteLength: json.byteLength,
  };
}

// Compact formatting only: retain dynamic rules, custom-property whitespace,
// declaration values, and the order in which at-rules affect the cascade.
function compactReplayStylesheet(stylesheet: Root): void {
  stylesheet.walk((node) => {
    node.raws.before = '';
    if ('nodes' in node && node.nodes) {
      node.raws.between = '';
      node.raws.after = '';
      node.raws.semicolon = false;
    } else if (node.type === 'decl' && !node.prop.startsWith('--')) node.raws.between = ':';
  });
  stylesheet.raws.after = '';
}

// SVGs are trusted source assets, not sanitized runtime XML. Recurse through
// all source directories, including page/component assets, without symlinks.
function sourceSvgImages(sourceDir: string): Map<string, string> {
  const sources = new Map<string, string>();
  if (!existsSync(sourceDir)) return sources;
  const sourceRoot = realpathSync(sourceDir);
  if (!statSync(sourceRoot).isDirectory()) return sources;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const realPath = realpathSync(path);
      if (!insideRoot(sourceRoot, realPath)) continue;
      if (entry.isDirectory()) visit(realPath);
      else if (
        entry.isFile() &&
        /\.svg$/i.test(entry.name) &&
        statSync(realPath).size <= MAX_IMAGE_URI_BYTES * 0.75
      ) {
        const svg = readFileSync(realPath);
        const uri = `data:image/svg+xml;base64,${svg.toString('base64')}`;
        if (Buffer.byteLength(uri) <= MAX_IMAGE_URI_BYTES)
          sources.set(createHash('sha256').update(svg).digest('hex'), uri);
      }
    }
  };
  visit(sourceRoot);
  return sources;
}

function svgDataBytes(value: string): Buffer | null {
  const base64 = value.match(
    /^data:image\/svg\+xml(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]+={0,2})$/i,
  )?.[1];
  if (base64) {
    const bytes = Buffer.from(base64, 'base64');
    return bytes.toString('base64') === base64 ? bytes : null;
  }
  const encoded = value.match(/^data:image\/svg\+xml(?:;charset=utf-8)?,(.+)$/i)?.[1];
  if (!encoded) return null;
  try {
    return Buffer.from(decodeURIComponent(encoded), 'utf8');
  } catch {
    return null;
  }
}

function localBuiltPath(outputDir: string, path: string): string | null {
  const candidate = resolve(outputDir, path);
  if (!insideRoot(outputDir, candidate) || !existsSync(candidate)) return null;
  const realPath = realpathSync(candidate);
  return insideRoot(outputDir, realPath) && statSync(realPath).isFile() ? realPath : null;
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

function stringLiteral(value: unknown): string | undefined {
  return isAstNode(value) && value.type === 'Literal' && typeof value.value === 'string'
    ? value.value
    : undefined;
}

function scriptLiterals(source: string): { literals: string[]; required: string[] } {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
  });
  const pending: AstNode[] = [ast as unknown as AstNode];
  const literals: string[] = [];
  const required: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    const literal = stringLiteral(node);
    if (literal !== undefined) literals.push(literal);
    if (
      node.type === 'CallExpression' &&
      isAstNode(node.callee) &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      Array.isArray(node.arguments) &&
      node.arguments.length === 1
    ) {
      const target = stringLiteral(node.arguments[0]);
      if (target !== undefined) required.push(target);
    } else if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ImportExpression'
    ) {
      const target = stringLiteral(node.source);
      if (target !== undefined) required.push(target);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (isAstNode(child)) pending.push(child);
      } else if (isAstNode(value)) pending.push(value);
    }
  }
  return { literals, required };
}

/** Internal builder; the public plugin writes its returned modules after a build. */
export function buildReplayImageSources(
  options: ReplayAssetsBuildOptions & { stylesheetBytes?: Record<string, number> },
): ReplayImageAssets {
  const { root, outputDir, prefix, packagePrefix, routes } = buildContext(options);
  const { compactAssets = true, stylesheetBytes = {}, imagePriority = [], onDiagnostic } = options;
  const files = new Map<string, ScriptReferences>();
  const images = new Map<string, string>();
  const packagedImages = new Map<string, PackagedImage>();
  const sourceSvgs = sourceSvgImages(options.sourceDir);
  const svgUri = (bytes: Buffer): string | undefined =>
    sourceSvgs.get(createHash('sha256').update(bytes).digest('hex'));
  const describeImage = (value: string): string =>
    value.startsWith('data:')
      ? `inline image ${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
      : value;
  const report = (reason: string, path: string, value: string): void => {
    onDiagnostic?.(
      `${reason}: ${describeImage(value)} (${relative(outputDir, path).split(sep).join('/')})`,
    );
  };
  const inspectFile = (path: string): ScriptReferences => {
    const cached = files.get(path);
    if (cached) return cached;
    const { literals, required } = scriptLiterals(readFileSync(path, 'utf8'));
    const dependencies: string[] = [];
    const sources = new Set<string>();
    for (const target of required) {
      if (!target.startsWith('.') || /[?#\0\\]/.test(target)) continue;
      const dependency = localBuiltPath(
        outputDir,
        relative(outputDir, resolve(dirname(path), target)),
      );
      const script = dependency?.endsWith('.js')
        ? dependency
        : localBuiltPath(outputDir, relative(outputDir, resolve(dirname(path), `${target}.js`)));
      if (script?.endsWith('.js')) dependencies.push(script);
    }
    for (const value of literals) {
      if (/^data:image\/svg\+xml[;,]/i.test(value)) {
        if (Buffer.byteLength(value) > MAX_IMAGE_URI_BYTES)
          report('Replay image exceeds the per-image budget', path, value);
        else {
          const bytes = svgDataBytes(value);
          const uri = bytes && svgUri(bytes);
          if (uri) {
            images.set(value, uri);
            sources.add(value);
          } else report('Replay SVG has no exact source match', path, value);
        }
        continue;
      }
      if (RASTER_DATA_URI.test(value)) {
        if (Buffer.byteLength(value) <= MAX_IMAGE_URI_BYTES) {
          images.set(value, value);
          sources.add(value);
        } else report('Replay image exceeds the per-image budget', path, value);
        continue;
      }
      const extension = value.match(/\.(png|jpe?g|gif|webp|avif|svg)$/i)?.[1]?.toLowerCase();
      if (
        !extension ||
        /^[a-z][\w+.-]*:/i.test(value) ||
        value.startsWith('//') ||
        /[?#\0\\]/.test(value)
      )
        continue;
      const absolutePrefix = `/${packagePrefix}`;
      const assetReference = value.startsWith(absolutePrefix)
        ? value.slice(absolutePrefix.length)
        : value;
      if (assetReference.startsWith('/')) continue;
      const assetPath = localBuiltPath(outputDir, assetReference);
      if (!assetPath) continue;
      if (statSync(assetPath).size > MAX_IMAGE_URI_BYTES * 0.75) {
        report('Replay image exceeds the per-image budget', path, value);
        continue;
      }
      const key = `/${packagePrefix}${assetReference}`;
      const asset = readFileSync(assetPath);
      const uri =
        extension === 'svg'
          ? svgUri(asset)
          : `data:image/${IMAGE_MIME[extension]};base64,${asset.toString('base64')}`;
      if (!uri) {
        report('Replay SVG has no exact source match', path, value);
        continue;
      }
      if (Buffer.byteLength(uri) > MAX_IMAGE_URI_BYTES) {
        report('Replay image exceeds the per-image budget', path, value);
        continue;
      }
      images.set(key, uri);
      packagedImages.set(key, {
        path: relative(root, assetPath).split(sep).join('/'),
        mime: uri.slice('data:'.length, uri.indexOf(';base64,')),
        bytes: asset.byteLength,
      });
      sources.add(key);
    }
    const result = { dependencies, sources };
    files.set(path, result);
    return result;
  };
  const collect = (path: string | null, seen: Set<string>, sources: Set<string>): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    const file = inspectFile(path);
    for (const key of file.sources) sources.add(key);
    for (const dependency of file.dependencies) collect(dependency, seen, sources);
  };
  const pages: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const budgets: Record<string, ReplayImageBudget> = Object.create(null) as Record<
    string,
    ReplayImageBudget
  >;
  const priority = (key: string): number => {
    const configured = imagePriority.findIndex(
      (candidate) =>
        key === candidate ||
        (!key.startsWith('data:') && key.endsWith(`/${candidate.replace(/^\/+/, '')}`)),
    );
    if (configured !== -1) return configured;
    return (
      imagePriority.length +
      (images.get(key)!.startsWith('data:image/svg+xml;') ? 2 : key.startsWith('data:') ? 0 : 1)
    );
  };
  for (const route of routes) {
    const sources = new Set<string>();
    const seen = new Set<string>();
    collect(localBuiltPath(outputDir, 'app.js'), seen, sources);
    collect(localBuiltPath(outputDir, `${route}.js`), seen, sources);
    const budget = Math.max(
      0,
      Math.min(
        MAX_ROUTE_IMAGE_BYTES,
        MAX_SNAPSHOT_BYTES - (stylesheetBytes[route] || 0) - SNAPSHOT_STRUCTURE_RESERVE_BYTES,
      ),
    );
    const selected: Record<string, string> = {};
    let imageSrcBudgetBytes = 0;
    let rejected = 0;
    // The map is outside the recording. Budget one serialized src per entry;
    // repeated DOM references remain subject to the recorder's snapshot cap.
    for (const key of [...sources].sort((a, b) => priority(a) - priority(b))) {
      const uri = images.get(key)!;
      const bytes = Buffer.byteLength(JSON.stringify({ src: uri }));
      if (imageSrcBudgetBytes + bytes <= budget) {
        selected[key] = uri;
        imageSrcBudgetBytes += bytes;
      } else rejected++;
    }
    if (rejected)
      onDiagnostic?.(
        `Replay route ${route} omitted ${rejected} image(s): ${budget}-byte image budget`,
      );
    pages[route] = Object.keys(selected);
    budgets[route] = {
      budget,
      mapJSONBytes: Buffer.byteLength(JSON.stringify(selected)),
      imageSrcBudgetBytes,
      count: pages[route].length,
    };
  }
  const used = new Set(Object.values(pages).flat());
  const sources = Object.fromEntries([...images].filter(([key]) => used.has(key)));
  const entries: ImageEntry[] = Object.entries(sources).map(([key, value]) => {
    if (!compactAssets) return [key, value];
    const packaged = packagedImages.get(key);
    return packaged ? [key, packaged] : key === value ? [key] : [key, value];
  });
  const indexes = new Map(entries.map(([key], index) => [key, index]));
  const indexedPages = Object.fromEntries(
    Object.entries(pages).map(([route, keys]) => [route, keys.map((key) => indexes.get(key))]),
  );
  const manifest = { entries, pages: indexedPages, prefix, packagePrefix };
  const compressed = compressedReplayData(manifest);
  const source = [
    '// Generated from built image references and source-backed SVGs; rebuild instead of editing.',
    ROUTE_RUNTIME,
    IMAGES_RUNTIME,
    'module.exports = function createReplayImageSources(decodeReplayAssetData, readPackagedImage) {',
    compactAssets
      ? `  return createReplayImagesRuntime(${JSON.stringify(compressed.encoded)}, ${compressed.byteLength}, decodeReplayAssetData, readPackagedImage);`
      : `  return createReplayImagesRuntime("", 0, function () { return ${JSON.stringify(manifest)}; });`,
    '};',
    '',
  ].join('\n');
  return { source, sources, pages, budgets, packedData: compressed };
}

export function buildReplayAssets(options: ReplayAssetsBuildOptions): ReplayAssets {
  const { root, outputDir, prefix, routes } = buildContext(options);
  const { compactAssets = true } = options;
  const chunks: string[] = [];
  const chunkIndexes = new Map<string, number>();
  const parsedFiles = new Map<string, StylePart[]>();
  const references = new Map<string, StyleReference[]>();
  const addChunk = (css: string): number => {
    const existing = chunkIndexes.get(css);
    if (existing !== undefined) return existing;
    const index = chunks.length;
    chunks.push(css);
    chunkIndexes.set(css, index);
    return index;
  };
  const parseFile = (path: string): StylePart[] => {
    const cached = parsedFiles.get(path);
    if (cached) return cached;
    const stylesheet = postcss.parse(readFileSync(path, 'utf8'), { from: path });
    stylesheet.walkComments((comment) => {
      comment.remove();
    });
    stylesheet.walkAtRules('charset', (rule) => {
      rule.remove();
    });
    stylesheet.walkRules((rule) => {
      rule.selector = replaySelector(rule.selector);
    });
    compactReplayStylesheet(stylesheet);
    const parts: StylePart[] = [];
    let buffer: string[] = [];
    const flush = (): void => {
      if (buffer.length) parts.push({ chunk: addChunk(buffer.join('')) });
      buffer = [];
    };
    for (const node of stylesheet.nodes) {
      if (node.type === 'atrule' && node.name.toLowerCase() === 'import') {
        flush();
        const imported = importTarget(node.params);
        const importedPath = imported && localStylePath(root, imported.target, path);
        if (imported && importedPath) parts.push({ path: importedPath, media: imported.media });
      } else {
        // PostCSS only adds statement at-rule semicolons when printing a parent.
        buffer.push(`${node.toString()}${node.type === 'atrule' && !node.nodes ? ';' : ''}`);
      }
    }
    flush();
    parsedFiles.set(path, parts);
    return parts;
  };
  const expandFile = (path: string, stack = new Set<string>()): StyleReference[] => {
    if (stack.has(path)) return [];
    const nextStack = new Set(stack).add(path);
    const result: StyleReference[] = [];
    for (const part of parseFile(path)) {
      if ('chunk' in part) result.push(part.chunk);
      else {
        const imported = expandFile(part.path, nextStack);
        if (part.media && imported.length) {
          result.push(
            { index: addChunk(`@media ${part.media}{`) },
            ...imported.map((reference) =>
              typeof reference === 'number' ? { index: reference } : reference,
            ),
            { index: addChunk('}') },
          );
        } else result.push(...imported);
      }
    }
    return result;
  };
  const appPath =
    localStylePath(root, 'app.wxss', join(root, 'app.wxss')) ||
    localStylePath(root, 'app.wxss', join(outputDir, 'app.wxss'));
  const app = appPath ? expandFile(appPath) : [];
  for (const route of routes) {
    const pagePath = localStylePath(root, `${route}.wxss`, join(outputDir, 'app.json'));
    references.set(route, pagePath ? expandFile(pagePath) : []);
  }
  const pages = Object.fromEntries(references);
  const manifest = { chunks, app, pages, prefix };
  const compressed = compressedReplayData(manifest);
  const source = [
    '// Generated from application and built WXSS; rebuild instead of editing.',
    ROUTE_RUNTIME,
    STYLES_RUNTIME,
    'module.exports = function createReplayStyles(decodeReplayAssetData) {',
    compactAssets
      ? `  return createReplayStylesRuntime(${JSON.stringify(compressed.encoded)}, ${compressed.byteLength}, decodeReplayAssetData);`
      : `  return createReplayStylesRuntime("", 0, function () { return ${JSON.stringify(manifest)}; });`,
    '};',
    '',
  ].join('\n');
  const stylesheetBytes = Object.fromEntries(
    routes.map((route) => [
      route,
      Buffer.byteLength(
        JSON.stringify(
          dedupeStyleReferences(app.concat(pages[route] || []), chunks)
            .map((index) => chunks[index])
            .join('\n'),
        ),
      ),
    ]),
  );
  const images = buildReplayImageSources({ ...options, stylesheetBytes });
  const assetData = JSON.stringify({ version: 1, styles: compressed, images: images.packedData });
  return { source, assetData, chunks, app, pages, images };
}
