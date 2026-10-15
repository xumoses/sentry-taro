import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import picomatch from 'picomatch';

export interface SourceMapUploadOptions {
  org?: string;
  project?: string | string[];
  authToken?: string;
  url?: string;
  headers?: Record<string, string>;
  disable?: boolean;
  silent?: boolean;
  debug?: boolean;
  /** Returning normally permits the caller to continue; errors otherwise reject. */
  errorHandler?: (error: Error) => void;
  /** Use the exact identity already written into the uploaded mini-program. */
  release: { name: string; dist?: string; create?: boolean; finalize?: boolean };
  sourcemaps?: {
    /** Globs relative to the normalized final archive; selected JS/map pairs stay together. */
    assets?: string | string[];
    /** Excluded companions cause an error instead of uploading an unusable pair. */
    ignore?: string | string[];
    disable?: boolean;
  };
  /** Only final artifacts downloaded from WeChat, never local intermediate build output. */
  wechat: { sourceMapPath: string; urlPrefix?: string };
}

export interface SourceMapUploadResult {
  release: string;
  dist?: string;
  files: string[];
  sourceMaps: number;
  generatedCompanions: string[];
}

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const ROOT_KEYS = [
  'org',
  'project',
  'authToken',
  'url',
  'headers',
  'disable',
  'silent',
  'debug',
  'errorHandler',
  'release',
  'sourcemaps',
  'wechat',
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an options object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported ${label} option: ${key}`);
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || hasControlCharacters(value)) {
    throw new Error(`${label} must be a nonempty string without control characters`);
  }
}

function boolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
}

function patterns(value: unknown, label: string): string[] {
  const result = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(result)) throw new Error(`${label} must be a string or an array of strings`);
  for (const pattern of result) {
    text(pattern, label);
    if (
      pattern.startsWith('/') ||
      pattern.includes('\\') ||
      /^[a-z]:/i.test(pattern) ||
      pattern.split('/').includes('..') ||
      pattern.startsWith('!')
    ) {
      throw new Error(`${label} must contain relative globs without parent traversal or negation`);
    }
  }
  return result;
}

function validate(options: SourceMapUploadOptions): void {
  const root = object(options, 'Source-map upload');
  keys(root, ROOT_KEYS, 'source-map upload');
  for (const key of ['disable', 'silent', 'debug'] as const) boolean(options[key], key);
  for (const key of ['org', 'authToken', 'url'] as const) {
    if (options[key] !== undefined) text(options[key], key);
  }
  if (options.project !== undefined) {
    const projects = Array.isArray(options.project) ? options.project : [options.project];
    if (!projects.length) throw new Error('project must contain at least one project');
    for (const project of projects) text(project, 'project');
  }
  if (options.headers !== undefined) {
    for (const [key, value] of Object.entries(object(options.headers, 'headers'))) {
      if (
        !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(key) ||
        typeof value !== 'string' ||
        /[\r\n\0]/.test(value)
      ) {
        throw new Error('headers must contain valid HTTP header names and string values');
      }
    }
  }
  if (options.errorHandler !== undefined && typeof options.errorHandler !== 'function') {
    throw new Error('errorHandler must be a function');
  }
  keys(object(options.release, 'release'), ['name', 'dist', 'create', 'finalize'], 'release');
  text(options.release.name, 'release.name');
  if (options.release.name.startsWith('-'))
    throw new Error('release.name must not begin with a dash');
  if (options.release.dist !== undefined) text(options.release.dist, 'release.dist');
  boolean(options.release.create, 'release.create');
  boolean(options.release.finalize, 'release.finalize');
  if (options.sourcemaps !== undefined) {
    keys(object(options.sourcemaps, 'sourcemaps'), ['assets', 'ignore', 'disable'], 'sourcemaps');
    boolean(options.sourcemaps.disable, 'sourcemaps.disable');
    if (options.sourcemaps.assets !== undefined)
      patterns(options.sourcemaps.assets, 'sourcemaps.assets');
    if (options.sourcemaps.ignore !== undefined)
      patterns(options.sourcemaps.ignore, 'sourcemaps.ignore');
  }
  keys(object(options.wechat, 'wechat'), ['sourceMapPath', 'urlPrefix'], 'wechat');
  text(options.wechat.sourceMapPath, 'wechat.sourceMapPath');
  if (options.wechat.urlPrefix !== undefined) text(options.wechat.urlPrefix, 'wechat.urlPrefix');
}

function safePath(name: string): string {
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  const unsafePart = path
    .split('/')
    .some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes(':') ||
        /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
  if (!path || path.includes('\\') || hasControlCharacters(path) || unsafePart) {
    throw new Error('Unsafe path in final WeChat source-map artifacts');
  }
  return path;
}

/** Copy rather than follow links; the caller's download is never edited. */
function copyDirectory(source: string, destination: string): void {
  let bytes = 0;
  function visit(directory: string, relative = ''): void {
    for (const name of readdirSync(directory).sort()) {
      const path = safePath(relative ? `${relative}/${name}` : name);
      const from = join(source, path);
      const info = lstatSync(from);
      if (info.isSymbolicLink())
        throw new Error('Symbolic links are not allowed in source-map artifacts');
      if (info.isDirectory()) visit(from, path);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > MAX_EXTRACTED_BYTES)
          throw new Error('Final source-map artifacts exceed 512 MiB');
        const to = join(destination, path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to, constants.COPYFILE_EXCL);
      } else
        throw new Error('Only regular files and directories are allowed in source-map artifacts');
    }
  }
  visit(source);
}

function extractArchive(source: string, destination: string): void {
  if (lstatSync(source).size > MAX_ARCHIVE_BYTES)
    throw new Error('Final source-map ZIP exceeds 256 MiB');
  const entries = new AdmZip(readFileSync(source)).getEntries();
  const names = new Set<string>();
  let bytes = 0;
  for (const entry of entries) {
    const path = safePath(entry.entryName);
    if (names.has(path)) throw new Error('Duplicate path in final source-map ZIP');
    names.add(path);
    const kind = (entry.attr >>> 16) & 0xf000;
    if (kind === 0xa000) throw new Error('Symbolic links are not allowed in source-map artifacts');
    if (kind !== 0 && kind !== (entry.isDirectory ? 0x4000 : 0x8000)) {
      throw new Error('Only regular files and directories are allowed in source-map artifacts');
    }
    bytes += entry.header.size;
    if (bytes > MAX_EXTRACTED_BYTES) throw new Error('Final source-map artifacts exceed 512 MiB');
  }
  for (const entry of entries) {
    const to = join(destination, safePath(entry.entryName));
    if (entry.isDirectory) mkdirSync(to, { recursive: true });
    else {
      const data = entry.getData();
      if (data.length !== entry.header.size)
        throw new Error('Invalid size in final source-map ZIP');
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data, { flag: 'wx' });
    }
  }
}

function filesUnder(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative))
    .sort()
    .flatMap((name) => {
      const path = relative ? `${relative}/${name}` : name;
      return lstatSync(join(root, path)).isDirectory() ? filesUnder(root, path) : [path];
    });
}

function prepare(source: string, extracted: string, normalized: string): string[] {
  const info = lstatSync(source);
  if (info.isSymbolicLink())
    throw new Error('Symbolic links are not allowed in source-map artifacts');
  if (info.isDirectory()) copyDirectory(source, extracted);
  else if (info.isFile()) extractArchive(source, extracted);
  else throw new Error('wechat.sourceMapPath must be a final WeChat ZIP or directory');
  const paths = filesUnder(extracted);
  if (!paths.includes('__APP__/app-service.js.map')) {
    throw new Error(
      'Final WeChat artifacts must contain __APP__/app-service.js.map; local build maps are not accepted',
    );
  }
  const targets = new Set<string>();
  for (const path of paths) {
    if (path.startsWith('__FULL__/')) continue;
    const target = path.startsWith('__APP__/') ? path.slice('__APP__/'.length) : path;
    if (targets.has(target))
      throw new Error('Conflicting paths while flattening the WeChat main package');
    targets.add(target);
    const to = join(normalized, target);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(extracted, path), to, constants.COPYFILE_EXCL);
  }
  const companions: string[] = [];
  for (const path of targets) {
    if (basename(path) !== 'app-service.js.map') continue;
    const companion = path.slice(0, -4);
    if (!targets.has(companion)) {
      writeFileSync(join(normalized, companion), '//# sourceMappingURL=app-service.js.map\n', {
        flag: 'wx',
      });
      companions.push(companion);
    }
  }
  return companions.sort();
}

function select(normalized: string, upload: string, options: SourceMapUploadOptions): string[] {
  const paths = filesUnder(normalized).filter((path) => /\.(?:js|map)$/.test(path));
  const available = new Set(paths);
  const match = picomatch(
    options.sourcemaps?.assets === undefined
      ? ['**/*']
      : patterns(options.sourcemaps.assets, 'sourcemaps.assets'),
    { dot: true },
  );
  const ignore = picomatch(
    options.sourcemaps?.ignore === undefined
      ? []
      : patterns(options.sourcemaps.ignore, 'sourcemaps.ignore'),
    { dot: true },
  );
  const selected = new Set(paths.filter((path) => match(path) && !ignore(path)));
  for (const path of selected) {
    const companion = path.endsWith('.map') ? path.slice(0, -4) : `${path}.map`;
    if (path.endsWith('.map') && (!companion.endsWith('.js') || !available.has(companion))) {
      throw new Error(`Selected source map has no JavaScript companion: ${path}`);
    }
    if (available.has(companion)) {
      if (ignore(companion))
        throw new Error(`A selected source-map pair has an ignored companion: ${companion}`);
      selected.add(companion);
    }
  }
  const result = [...selected].sort();
  const maps = result.filter((path) => path.endsWith('.map'));
  if (!maps.length) throw new Error('No final WeChat source maps match sourcemaps.assets/ignore');
  for (const path of maps) {
    let map: unknown;
    try {
      map = JSON.parse(readFileSync(join(normalized, path), 'utf8'));
    } catch {
      // JSON parse errors can include source text. Keep diagnostics to artifact names.
      throw new Error(`Invalid final source map: ${path}`);
    }
    const record = object(map, 'Source map');
    const basic =
      typeof record.mappings === 'string' &&
      Array.isArray(record.sources) &&
      record.sources.every((value) => typeof value === 'string');
    if (record.version !== 3 || (!basic && !Array.isArray(record.sections))) {
      throw new Error(`Invalid final source map: ${path}`);
    }
  }
  for (const path of result) {
    const to = join(upload, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(normalized, path), to, constants.COPYFILE_EXCL);
  }
  return result;
}

function redact(message: string, options: SourceMapUploadOptions): string {
  const secrets: unknown[] = [options?.authToken, process.env.SENTRY_AUTH_TOKEN];
  if (options?.headers && typeof options.headers === 'object')
    secrets.push(...Object.values(options.headers));
  let result = message;
  for (const value of secrets) {
    if (typeof value === 'string' && value.length) result = result.split(value).join('[redacted]');
  }
  return result;
}

/** Explicit post-WeChat-upload stage. Never contacts WeChat or scans local build maps. */
export async function uploadSourceMaps(
  options: SourceMapUploadOptions,
): Promise<SourceMapUploadResult | undefined> {
  if (options?.disable === true) return;
  let temporary: string | undefined;
  try {
    validate(options);
    if (options.sourcemaps?.disable === true) return;
    temporary = mkdtempSync(join(tmpdir(), 'sentry-taro-sourcemaps-'));
    const extracted = join(temporary, 'extracted');
    const normalized = join(temporary, 'normalized');
    const upload = join(temporary, 'upload');
    for (const path of [extracted, normalized, upload]) mkdirSync(path);
    const generatedCompanions = prepare(
      resolve(options.wechat.sourceMapPath),
      extracted,
      normalized,
    );
    const files = select(normalized, upload, options);
    const projects =
      options.project === undefined
        ? undefined
        : typeof options.project === 'string'
          ? [options.project]
          : options.project;
    // This optional dependency is loaded only after final artifact validation.
    const { SentryCli } = await import('@sentry/cli');
    const cli = new SentryCli(null, {
      ...(options.org !== undefined ? { org: options.org } : {}),
      ...(typeof options.project === 'string' ? { project: options.project } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.url !== undefined ? { url: options.url } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      // CLI may log request headers or include them in errors. Emit bounded plugin diagnostics instead.
      silent: true,
    });
    if (options.debug && !options.silent) {
      console.log(
        redact(
          `[sentry-taro] Uploading ${files.length} final artifacts: ${files.join(', ')}`,
          options,
        ),
      );
    }
    if (options.release.create !== false)
      await cli.releases.new(options.release.name, projects ? { projects } : {});
    await cli.releases.uploadSourceMaps(options.release.name, {
      include: [upload],
      ...(projects ? { projects } : {}),
      ...(options.release.dist !== undefined ? { dist: options.release.dist } : {}),
      rewrite: false,
      validate: true,
      dedupe: true,
      urlPrefix: options.wechat.urlPrefix ?? 'https://usr',
    });
    if (options.release.finalize !== false) await cli.releases.finalize(options.release.name);
    if (!options.silent) console.log('[sentry-taro] Final WeChat source maps uploaded.');
    return {
      release: options.release.name,
      ...(options.release.dist !== undefined ? { dist: options.release.dist } : {}),
      files,
      sourceMaps: files.filter((path) => path.endsWith('.map')).length,
      generatedCompanions: generatedCompanions.filter((path) => files.includes(path)),
    };
  } catch (cause) {
    const error = new Error(
      redact(cause instanceof Error ? cause.message : String(cause), options),
    );
    if (typeof options?.errorHandler === 'function') options.errorHandler(error);
    else throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
