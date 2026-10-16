import { utf8ByteLength } from '../sdk/utf8';
import { decodeReplayAssetData } from './replay-assets';

export interface ReplayAssetProviderOptions {
  /** Read replay-assets.json as UTF-8 from the mini program's code package. */
  readAssetFile: () => string;
  /** Read a build-audited code-package image as base64; never receives DOM src. */
  readPackagedImage?: (path: string) => string;
}

export interface ReplayAssetProviders {
  getReplayStyles(route: string): string;
  getReplayImageSources(route: string): Record<string, string>;
}

type StyleReference = number | { index: number };

interface StyleManifest {
  prefix: string;
  chunks: string[];
  app: StyleReference[];
  pages: Record<string, StyleReference[]>;
}

interface PackagedImage {
  path: string;
  mime: string;
  bytes: number;
}

type ImageEntry = [string] | [string, string | PackagedImage];

interface ImageManifest {
  prefix: string;
  packagePrefix: string;
  entries: ImageEntry[];
  pages: Record<string, number[]>;
}

interface AssetManifests {
  styles: StyleManifest;
  images: ImageManifest;
}

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_URI_BYTES = 128 * 1024;
const MAX_IMAGE_FILE_BYTES = 96 * 1024;
const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/;
const IMAGE_URI = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/]*={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPackagePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !/[\\\0?#:]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function isPrefix(value: unknown): value is string {
  return (
    value === '' ||
    (typeof value === 'string' && value.endsWith('/') && isPackagePath(value.slice(0, -1)))
  );
}

function isIndex(value: unknown, count: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count;
}

function isStyleReference(value: unknown, count: number): value is StyleReference {
  return isIndex(value, count) || (isRecord(value) && isIndex(value.index, count));
}

function isStyleManifest(value: unknown): value is StyleManifest {
  if (
    !isRecord(value) ||
    !isPrefix(value.prefix) ||
    !Array.isArray(value.chunks) ||
    !value.chunks.every((chunk) => typeof chunk === 'string') ||
    !Array.isArray(value.app) ||
    !isRecord(value.pages)
  )
    return false;
  const count = value.chunks.length;
  return (
    value.app.every((reference) => isStyleReference(reference, count)) &&
    Object.entries(value.pages).every(
      ([route, references]) =>
        isPackagePath(route) &&
        Array.isArray(references) &&
        references.every((reference) => isStyleReference(reference, count)),
    )
  );
}

function isImageUri(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_IMAGE_URI_BYTES && IMAGE_URI.test(value);
}

function isImageKey(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_URI_BYTES) return false;
  if (/^data:/i.test(value)) {
    // Original percent-encoded SVG keys are preserved, while their values use
    // canonical source-backed base64. No runtime URL is fetched or parsed.
    return (
      isImageUri(value) ||
      (/^data:image\/svg\+xml[;,]/i.test(value) && utf8ByteLength(value) <= MAX_IMAGE_URI_BYTES)
    );
  }
  // Lookup keys preserve the literal src, including ./ or ../ segments. They
  // are never passed to the file reader; only the separately audited descriptor
  // path is read. Rejecting a valid literal here would discard the entire map.
  return value.startsWith(`/${prefix}`) && !value.startsWith('//') && !/[\\\0?#:]/.test(value);
}

function isPackagedImage(value: unknown, prefix: string): value is PackagedImage {
  return (
    isRecord(value) &&
    isPackagePath(value.path) &&
    value.path.startsWith(prefix) &&
    typeof value.mime === 'string' &&
    IMAGE_MIME.test(value.mime) &&
    typeof value.bytes === 'number' &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0 &&
    value.bytes <= MAX_IMAGE_FILE_BYTES
  );
}

function isImageManifest(value: unknown): value is ImageManifest {
  if (
    !isRecord(value) ||
    !isPrefix(value.prefix) ||
    !isPrefix(value.packagePrefix) ||
    !Array.isArray(value.entries) ||
    !isRecord(value.pages)
  )
    return false;
  const prefix = value.packagePrefix;
  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (
      !Array.isArray(entry) ||
      (entry.length !== 1 && entry.length !== 2) ||
      !isImageKey(entry[0], prefix) ||
      keys.has(entry[0])
    )
      return false;
    keys.add(entry[0]);
    if (
      entry.length === 1
        ? !isImageUri(entry[0])
        : !isImageUri(entry[1]) && !isPackagedImage(entry[1], prefix)
    )
      return false;
  }
  const count = value.entries.length;
  return Object.entries(value.pages).every(
    ([route, indexes]) =>
      isPackagePath(route) &&
      Array.isArray(indexes) &&
      indexes.every((index) => isIndex(index, count)),
  );
}

function decodeManifest(value: unknown): unknown {
  if (!isRecord(value) || typeof value.encoded !== 'string' || typeof value.byteLength !== 'number')
    return undefined;
  return decodeReplayAssetData(value.encoded, value.byteLength);
}

function normalizedRoute(route: string, prefix: string): string {
  const normalized = String(route || '')
    .split(/[?#]/)[0]!
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  return prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function stylesheetForRoute(styles: StyleManifest, route: string): string {
  const normalized = normalizedRoute(route, styles.prefix);
  const page = Object.prototype.hasOwnProperty.call(styles.pages, normalized)
    ? styles.pages[normalized]!
    : [];
  const references = styles.app.concat(page);
  const seen = new Set<number>();
  const kept: number[] = [];
  for (let position = references.length - 1; position >= 0; position--) {
    const reference = references[position]!;
    const index = typeof reference === 'number' ? reference : reference.index;
    const mayDedupe = typeof reference === 'number' && !/@layer\b/i.test(styles.chunks[index]!);
    if (!mayDedupe || !seen.has(index)) kept.push(index);
    if (mayDedupe) seen.add(index);
  }
  return kept
    .reverse()
    .map((index) => styles.chunks[index]!)
    .join('\n');
}

function isPackagedImageBase64(value: unknown, byteLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== 4 * Math.ceil(byteLength / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((value.length / 4) * 3 - padding !== byteLength) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(value[value.length - padding - 1]!);
  return padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0;
}

/**
 * Consume the build plugin's JSON artifact without importing generated files.
 * Nothing is read until a route requests resources. A successful load is cached;
 * unavailable or invalid artifacts and unavailable package images can be retried.
 */
export function createReplayAssetProviders(
  options: ReplayAssetProviderOptions,
): ReplayAssetProviders {
  let data: AssetManifests | undefined;
  const imageCache = new Map<number, string>();
  const load = (): AssetManifests | undefined => {
    if (data) return data;
    try {
      const source = options.readAssetFile();
      if (
        typeof source !== 'string' ||
        source.length > MAX_ASSET_BYTES ||
        utf8ByteLength(source) > MAX_ASSET_BYTES
      )
        return undefined;
      const manifest: unknown = JSON.parse(source);
      if (!isRecord(manifest) || manifest.version !== 1) return undefined;
      const styles = decodeManifest(manifest.styles);
      const images = decodeManifest(manifest.images);
      if (!isStyleManifest(styles) || !isImageManifest(images)) return undefined;
      data = { styles, images };
      return data;
    } catch {
      return undefined;
    }
  };
  return {
    getReplayStyles(route) {
      const current = load();
      return current ? stylesheetForRoute(current.styles, route) : '';
    },
    getReplayImageSources(route) {
      const selected: Record<string, string> = {};
      const current = load();
      if (!current) return selected;
      const images = current.images;
      const normalized = normalizedRoute(route, images.prefix);
      const indexes = Object.prototype.hasOwnProperty.call(images.pages, normalized)
        ? images.pages[normalized]!
        : [];
      for (const index of indexes) {
        const [key, source] = images.entries[index]!;
        if (source === undefined || typeof source === 'string') {
          selected[key] = source === undefined ? key : source;
          continue;
        }
        const cached = imageCache.get(index);
        if (cached !== undefined) {
          selected[key] = cached;
          continue;
        }
        if (!options.readPackagedImage) continue;
        try {
          const base64 = options.readPackagedImage(source.path);
          if (!isPackagedImageBase64(base64, source.bytes)) continue;
          const uri = `data:${source.mime};base64,${base64}`;
          imageCache.set(index, uri);
          selected[key] = uri;
        } catch {
          // A subpackage image may become readable after its package loads.
        }
      }
      return selected;
    },
  };
}
