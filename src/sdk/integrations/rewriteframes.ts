import { rewriteFramesIntegration as coreRewriteFramesIntegration } from '@sentry/core';
import type { Event, Integration, StackFrame } from '@sentry/core';

import { appName, getSystemInfo } from '../crossPlatform';

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

/** The merged main-package script; subpackages keep their own path and are never shifted. */
const MAIN_PACKAGE_SCRIPT = 'https://usr/app-service.js';

/**
 * Lines desktop WeChat runs ahead of the main-package code that WeChat's final source map
 * describes, keyed by `<platform>/<WeChat client version>`. Columns are unaffected. Phones run
 * the main package exactly as mapped and are never listed. Each value is measured from events
 * of one build captured on both a phone and that desktop client; unlisted clients are left as is.
 */
export const DESKTOP_MAIN_PACKAGE_LINE_OFFSETS: Readonly<Record<string, number>> = {
  'mac/4.1.15.55': 1406,
};

/** The known main-package line offset of the running desktop WeChat client, if any. */
export function desktopMainPackageLineOffset(): number | undefined {
  try {
    if (appName() !== 'wechat') return undefined;
    const info = getSystemInfo();
    const platform = typeof info?.platform === 'string' ? info.platform.toLowerCase() : '';
    if (platform !== 'mac' && platform !== 'windows') return undefined;
    const offset = DESKTOP_MAIN_PACKAGE_LINE_OFFSETS[`${platform}/${String(info?.version)}`];
    return typeof offset === 'number' && offset > 0 ? offset : undefined;
  } catch {
    return undefined;
  }
}

/** Shifts desktop main-package frames back to the lines WeChat's final source map uses. */
function correctDesktopMainPackageLines(event: Event, offset: number): void {
  let corrected = false;
  for (const exception of event.exception?.values ?? []) {
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename !== MAIN_PACKAGE_SCRIPT) continue;
      if (typeof frame.lineno !== 'number' || frame.lineno <= offset) continue;
      frame.lineno -= offset;
      corrected = true;
    }
  }
  if (!corrected) return;
  // Marks corrected events so desktop symbolication can be audited per client version.
  event.contexts = {
    ...event.contexts,
    miniapp: { ...event.contexts?.['miniapp'], main_package_line_offset: offset },
  };
}

/**
 * Official `rewriteFramesIntegration` (same name and options) with a mini-program default iteratee,
 * so default frames match the WeChat source maps uploaded by `taro-plugin`. On desktop WeChat
 * clients listed in {@link DESKTOP_MAIN_PACKAGE_LINE_OFFSETS}, main-package line numbers are first
 * shifted to match the final map; see the FAQ for the WeChat-side cause.
 */
export function rewriteFramesIntegration(options: RewriteFramesOptions = {}): Integration {
  const integration = coreRewriteFramesIntegration({
    iteratee: options.iteratee ?? miniappFrameIteratee(options),
  });
  const processEvent = integration.processEvent;
  return {
    ...integration,
    processEvent(event, hint, client) {
      const offset = desktopMainPackageLineOffset();
      if (offset) correctDesktopMainPackageLines(event, offset);
      return processEvent ? processEvent.call(integration, event, hint, client) : event;
    },
  };
}
