import type { MiniappOptions } from './types';

// Replaced by the consuming Taro build, not while publishing the SDK package.
// A lexical constant avoids writing to globalThis in isolated mini-program runtimes.
declare const __SENTRY_TARO_BUILD__: unknown;

/** Apply the same release/dist selected for source-map upload unless init overrides them. */
export function applyBuildMetadataDefaults(options: MiniappOptions): MiniappOptions {
  if (typeof __SENTRY_TARO_BUILD__ === 'undefined') return options;
  const metadata = __SENTRY_TARO_BUILD__;
  if (!metadata || typeof metadata !== 'object') return options;

  const defaults: Pick<MiniappOptions, 'release' | 'dist'> = {};
  if (
    options.release === undefined &&
    'release' in metadata &&
    typeof metadata.release === 'string'
  ) {
    defaults.release = metadata.release;
  }
  if (options.dist === undefined && 'dist' in metadata && typeof metadata.dist === 'string') {
    defaults.dist = metadata.dist;
  }
  // Preserve the existing option shape when no values were injected or both were overridden.
  if (Object.keys(defaults).length === 0) return options;
  return { ...options, ...defaults };
}
