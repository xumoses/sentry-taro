import { rewriteFramesIntegration as coreRewriteFramesIntegration } from '@sentry/core';
import type { Integration, StackFrame } from '@sentry/core';

/** Same origin `taro-plugin` uploads WeChat final maps under (`wechat.urlPrefix` default). */
export const DEFAULT_FRAME_PREFIX = 'https://usr/';

const WECHAT_PACKAGE_ORIGIN = 'https://usr/';
const WECHAT_APP_SERVICE = /^(?:appservice|app-service)\/(.+)$/i;
// Frozen platforms keep their legacy `app:///` names (no upload counterpart here).
const FROZEN_PLATFORM_FRAME = /^(?:https:\/\/appx\/|(?!https?:|app:)[a-z][a-z\d+.-]*:\/\/)(.*)$/i;

export interface RewriteFramesOptions {
  /** Prefix for rewritten WeChat package frames. Default `https://usr/`; use the same value as `wechat.urlPrefix`. */
  prefix?: string;
  /** Frames starting with `root` have it replaced by `prefix`, as in the official browser behavior. */
  root?: string;
  /** Replaces the default iteratee; `prefix` and `root` are then ignored, as in `@sentry/core`. */
  iteratee?: (frame: StackFrame) => StackFrame;
}

/**
 * Default iteratee: names WeChat package frames the way `taro-plugin` names uploaded artifacts.
 *
 * - `https://usr/<path>` (device) and `appservice/<path>` become `<prefix><path>`.
 * - DevTools `http://127.0.0.1:<port>/…` and other unknown frames stay unchanged; their bundles
 *   differ from the final upload, so renaming them would attach the wrong maps.
 */
export function miniappFrameIteratee(
  options: Pick<RewriteFramesOptions, 'prefix' | 'root'> = {},
): (frame: StackFrame) => StackFrame {
  const raw = options.prefix || DEFAULT_FRAME_PREFIX;
  const prefix = raw.endsWith('/') ? raw : `${raw}/`;
  const { root } = options;
  return (frame) => {
    const filename = frame.filename;
    if (!filename) return frame;
    if (root && filename.startsWith(root)) {
      frame.filename = `${prefix}${filename.slice(root.length).replace(/^\/+/, '')}`;
    } else if (filename.startsWith(WECHAT_PACKAGE_ORIGIN)) {
      frame.filename = `${prefix}${filename.slice(WECHAT_PACKAGE_ORIGIN.length)}`;
    } else {
      const appService = WECHAT_APP_SERVICE.exec(filename);
      const frozen = appService ? undefined : FROZEN_PLATFORM_FRAME.exec(filename);
      if (appService) frame.filename = `${prefix}${appService[1]}`;
      else if (frozen) frame.filename = `app:///${frozen[1]!.replace(/^\/+/, '')}`;
    }
    return frame;
  };
}

/**
 * Official `rewriteFramesIntegration` (same name and options) with a mini-program default iteratee,
 * so default frames match the WeChat source maps uploaded by `taro-plugin`.
 */
export function rewriteFramesIntegration(options: RewriteFramesOptions = {}): Integration {
  return coreRewriteFramesIntegration({
    iteratee: options.iteratee ?? miniappFrameIteratee(options),
  });
}
