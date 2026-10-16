import { rewriteFramesIntegration as coreRewriteFramesIntegration } from '@sentry/core';
import type { Event, Integration, Exception, StackFrame } from '@sentry/core';

/** Same origin `taro-plugin` uploads WeChat final maps under (`wechat.urlPrefix` default). */
export const DEFAULT_FRAME_PREFIX = 'https://usr/';

const WECHAT_PACKAGE_ORIGIN = 'https://usr/';
const WECHAT_APP_SERVICE = /^(?:appservice|app-service)\/(.+)$/i;
// Frozen platforms keep their pre-0.1.0-beta.7 `app:///` names (no upload counterpart here).
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

/**
 * Legacy class kept with its 0.1.0-beta.6 output (`app:///…`).
 *
 * @deprecated Use `rewriteFramesIntegration()`; it is installed by default and its default output
 * matches the `taro-plugin` upload prefix. Will be removed in a later beta.
 */
export class RewriteFrames implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'RewriteFrames';

  /**
   * @inheritDoc
   */
  public name: string = RewriteFrames.id;

  /**
   * Optional prefix to append to the normalized path. Defaults to 'app:///'
   */
  private readonly _prefix: string;

  public constructor(options: { prefix?: string } = {}) {
    this._prefix = options.prefix || 'app:///';
  }

  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    // In Sentry v10, we usually use addGlobalEventProcessor or similar to add an event processor
    // For integrations, we can just return the processor in processEvent or register it globally.
    // However, the cleanest way in v10 is to use `processEvent`.
  }

  /**
   * @inheritDoc
   */
  public processEvent(event: Event): Event {
    if (event.exception && event.exception.values) {
      event.exception.values.forEach((exception: Exception) => {
        if (exception.stacktrace && exception.stacktrace.frames) {
          exception.stacktrace.frames.forEach((frame: StackFrame) => {
            if (frame.filename) {
              frame.filename = this._normalizeFilename(frame.filename);
            }
          });
        }
      });
    }
    return event;
  }

  /**
   * Normalizes a filename from various miniapp platforms
   */
  private _normalizeFilename(filename: string): string {
    let normalized = filename;

    // Remove common platform prefixes
    // WeChat: appservice/, app-service/, WAService.js
    // Alipay: https://appx/...
    // ByteDance: tt://...
    normalized = normalized
      .replace(/^(appservice|app-service|WAService)\//i, '')
      .replace(/^https?:\/\/[^/]+\//i, '') // Remove alipay http(s) protocol and domain
      .replace(/^[a-z]+:\/\//i, '') // Remove other protocols like tt://, swan://
      .replace(/^\//, ''); // Remove leading slash if any

    // Prevent double prefixing if it's already an absolute path
    if (normalized.startsWith(this._prefix)) {
      return normalized;
    }

    return `${this._prefix}${normalized}`;
  }
}
