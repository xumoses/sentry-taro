import {
  createNetworkHeaderPolicy,
  sanitizeNetworkDetailUrl,
  snapshotNetworkOptions,
} from '../sdk/network-details';
import type { Breadcrumb, BreadcrumbHint } from '@sentry/core';

import { sendReplayCapture } from './envelope';
import { mergeReplayContexts } from './metadata';
import { sanitizeBreadcrumb, sanitizeRecord, sanitizeUrl } from './privacy';
import type {
  CreateTaroReplayOptions,
  SentryReplayClient,
  TaroReplayCapture,
  TaroReplayContext,
  TaroReplayControllerView,
  TaroReplayHandle,
  TaroReplayMetadata,
  TaroReplayNodeLike,
} from './types';

const SYNTHETIC_ORIGIN = 'https://miniapp.local';

function normalizeRoute(value: string | undefined): string {
  const route = sanitizeUrl(value || 'unknown').replace(/^\/+/, '');
  return route || 'unknown';
}

function normalizePlatform(value: string | undefined): string {
  const key = (value || 'unknown').toLowerCase();
  const names: Record<string, string> = {
    weapp: 'wechat',
    wechat: 'wechat',
    alipay: 'alipay',
    swan: 'baidu',
    tt: 'bytedance',
    jd: 'jingdong',
    qq: 'qq',
  };
  return names[key] || key;
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function mergeMetadata(
  defaults: TaroReplayMetadata,
  custom: TaroReplayMetadata | undefined,
  allowUser: boolean,
): TaroReplayMetadata {
  const customWithoutUser = custom ? { ...custom } : undefined;
  if (customWithoutUser) delete customWithoutUser.user;
  const safeCustom = customWithoutUser
    ? (sanitizeRecord(customWithoutUser as Record<string, unknown>) as TaroReplayMetadata)
    : undefined;
  const result: TaroReplayMetadata = {
    ...defaults,
    ...safeCustom,
    ...(defaults.tags || safeCustom?.tags
      ? { tags: { ...defaults.tags, ...safeCustom?.tags } }
      : {}),
    ...(defaults.contexts || safeCustom?.contexts
      ? { contexts: mergeReplayContexts(defaults.contexts, safeCustom?.contexts, true) }
      : {}),
  };
  if (allowUser && custom?.user) result.user = sanitizeRecord(custom.user);
  else delete result.user;
  return result;
}

function shouldSendCapture(options: CreateTaroReplayOptions, reason: string | null): boolean {
  if (reason === 'startup-error') return false;
  if (reason === 'page-unload' || reason === 'dispose') return options.sendOnDispose === true;
  if (reason === 'duration') return options.sendOnDurationStop !== false;
  return options.sendOnManualStop !== false;
}

export function createTaroReplay(options: CreateTaroReplayOptions): TaroReplayHandle {
  const networkOptions = snapshotNetworkOptions(options);
  const networkPolicy = createNetworkHeaderPolicy(networkOptions);
  let controller: ReturnType<typeof options.sdk.startTaroReplayRecorder> | undefined;
  let lastCapture: TaroReplayCapture | undefined;
  let detachBreadcrumb: (() => void) | undefined;
  let finalization: Promise<void> | undefined;
  let terminal = false;
  let recordingClient: SentryReplayClient | undefined;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* Diagnostics cannot interrupt the host. */
    }
  };

  const recordBreadcrumb = (breadcrumb: Breadcrumb, hint?: BreadcrumbHint): boolean => {
    try {
      const details = hint?.['replayNetworkDetails'];
      let replayBreadcrumb = breadcrumb;
      if (details && typeof details === 'object' && !Array.isArray(details)) {
        const detailUrl = Object.getOwnPropertyDescriptor(details, 'url');
        const breadcrumbUrl = breadcrumb.data?.['url'];
        if (
          typeof breadcrumbUrl === 'string' &&
          detailUrl &&
          'value' in detailUrl &&
          detailUrl.value === sanitizeNetworkDetailUrl(breadcrumbUrl)
        ) {
          const data = { ...breadcrumb.data };
          for (const field of ['request_headers', 'response_headers'] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(details, field);
            if (descriptor && 'value' in descriptor) data[field] = descriptor.value;
          }
          replayBreadcrumb = { ...breadcrumb, data };
        }
      }
      return (
        controller?.addBreadcrumb(
          sanitizeBreadcrumb(replayBreadcrumb, {
            maskMessage: options.privacy?.maskAllText !== false,
            networkPolicy,
          }),
        ) ?? false
      );
    } catch (error) {
      // Core invokes this hook synchronously without catching consumer errors.
      reportError(error);
      return false;
    }
  };

  const detach = (): void => {
    detachBreadcrumb?.();
    detachBreadcrumb = undefined;
  };

  const finalize = (capture: TaroReplayCapture): Promise<void> => {
    lastCapture = capture;
    terminal = true;
    detach();
    if (finalization) return finalization;

    finalization = (async () => {
      try {
        await options.onCapture?.(capture);
      } catch (error) {
        reportError(error);
      }

      if (!shouldSendCapture(options, capture.stopReason)) return;
      const client = recordingClient;
      if (!client || typeof client.sendEnvelope !== 'function') {
        throw new Error('[@xumoses/sentry-taro] Cannot send Replay without an initialized client');
      }
      await sendReplayCapture(client, capture);
    })();
    void finalization.catch(reportError);
    return finalization;
  };

  const start = (): boolean => {
    if (controller) return !terminal;
    if (terminal) return false;

    try {
      const instance = options.runtime.getCurrentInstance();
      const rootId = instance.router?.$taroPath || instance.router?.path;
      const route = normalizeRoute(rootId);
      const root = rootId
        ? options.runtime.document.getElementById(rootId) ||
          options.runtime.document.getElementById(route)
        : null;
      if (!root) {
        throw new Error(`[@xumoses/sentry-taro] Mounted Taro root not found for route "${route}"`);
      }

      const client = options.sdk.getClient();
      recordingClient = client;
      const clientOptions = client?.getOptions?.();
      const platform = normalizePlatform(safely(() => options.runtime.getEnv?.()));
      const windowInfo = safely(() => options.runtime.getWindowInfo?.()) || {};
      const useLegacyDefaults =
        clientOptions?.enableSystemInfo !== false && !client?.getRuntimeContexts;
      const account = useLegacyDefaults
        ? safely(() => options.runtime.getAccountInfoSync?.())
        : undefined;
      const appBase = useLegacyDefaults
        ? safely(() => options.runtime.getAppBaseInfo?.())
        : undefined;
      const device = useLegacyDefaults
        ? safely(() => options.runtime.getDeviceInfo?.())
        : undefined;
      const simulator = device?.platform?.toLowerCase() === 'devtools';
      const system = device?.system?.match(/^([a-zA-Z][a-zA-Z ]*?)\s*([\d.]+)$/);
      const os = simulator
        ? { name: 'unknown' }
        : system
          ? { name: system[1]?.trim(), version: system[2] }
          : device?.system
            ? { name: device.system }
            : undefined;
      const href = sanitizeUrl(options.href?.(route) || `${SYNTHETIC_ORIGIN}/${route}`);
      const context: TaroReplayContext = {
        route,
        href,
        platform,
        ...(clientOptions?.environment ? { environment: clientOptions.environment } : {}),
        ...(clientOptions?.release ? { release: clientOptions.release } : {}),
      };
      const metadata = mergeMetadata(
        {
          ...(clientOptions?.environment ? { environment: clientOptions.environment } : {}),
          ...(clientOptions?.release ? { release: clientOptions.release } : {}),
          ...(clientOptions?.dist ? { dist: clientOptions.dist } : {}),
          sdk: {
            name: options.sdk.SDK_NAME || 'sentry.javascript.miniapp',
            version: options.sdk.SDK_VERSION || 'unknown',
          },
          tags: {
            'replay.adapter': 'taro',
            'miniapp.platform': platform,
            'page.route': route,
            ...(options.frameworkVersion ? { 'taro.version': options.frameworkVersion } : {}),
            ...(account?.miniProgram?.envVersion
              ? { 'miniapp.env_version': account.miniProgram.envVersion }
              : {}),
            ...(account?.miniProgram?.version
              ? { 'miniapp.version': account.miniProgram.version }
              : {}),
            ...(appBase?.SDKVersion ? { 'miniapp.base_library': appBase.SDKVersion } : {}),
          },
          contexts: {
            ...(device
              ? {
                  device: {
                    type: 'device',
                    ...(simulator
                      ? { simulator: true }
                      : {
                          ...(device.brand ? { brand: device.brand } : {}),
                          ...(device.model ? { model: device.model } : {}),
                        }),
                    ...(appBase?.language ? { language: appBase.language } : {}),
                    ...(!simulator && windowInfo.screenWidth && windowInfo.screenHeight
                      ? {
                          screen_resolution: `${windowInfo.screenWidth}x${windowInfo.screenHeight}`,
                        }
                      : {}),
                  },
                }
              : {}),
            ...(os ? { os: { type: 'os', ...os } } : {}),
            ...(useLegacyDefaults && platform === 'wechat'
              ? {
                  browser: {
                    type: 'browser',
                    name: simulator ? 'WeChat DevTools' : 'WeChat',
                    ...(!simulator && appBase?.version ? { version: appBase.version } : {}),
                  },
                }
              : {}),
            ...(simulator
              ? {
                  miniapp_simulator: {
                    ...(device?.brand ? { brand: device.brand } : {}),
                    ...(device?.model ? { model: device.model } : {}),
                    ...(device?.system ? { system: device.system } : {}),
                    ...(device?.platform ? { platform: device.platform } : {}),
                    ...(appBase?.version ? { version: appBase.version } : {}),
                    ...(windowInfo.screenWidth && windowInfo.screenHeight
                      ? {
                          screen_resolution: `${windowInfo.screenWidth}x${windowInfo.screenHeight}`,
                        }
                      : {}),
                  },
                }
              : {}),
            miniapp: {
              type: 'miniapp',
              platform,
              route,
              ...(account?.miniProgram?.envVersion
                ? { environment: account.miniProgram.envVersion }
                : {}),
              ...(account?.miniProgram?.version ? { version: account.miniProgram.version } : {}),
              ...(appBase?.SDKVersion ? { base_library: appBase.SDKVersion } : {}),
            },
          },
        },
        safely(() => options.getMetadata?.(context)),
        options.privacy?.allowUser === true,
      );
      const stylesheet = safely(() => options.runtime.getReplayStyles?.(context.route));
      const staticImageSources = safely(() =>
        options.runtime.getReplayImageSources?.(context.route),
      );

      controller = options.sdk.startTaroReplayRecorder({
        root,
        ...snapshotNetworkOptions(networkOptions),
        recordCanvas: options.recordCanvas === true,
        MutationObserver: options.runtime.MutationObserver,
        href,
        ...(windowInfo.windowWidth === undefined ? {} : { width: windowInfo.windowWidth }),
        ...(windowInfo.windowHeight === undefined ? {} : { height: windowInfo.windowHeight }),
        ...(stylesheet === undefined ? {} : { stylesheet }),
        ...(staticImageSources === undefined ? {} : { staticImageSources }),
        maskAllText: options.privacy?.maskAllText !== false,
        maskInputValues:
          (options.privacy?.maskAllInputs ?? options.privacy?.maskInputValues) !== false,
        ...(options.privacy?.maskAllInputs === undefined
          ? {}
          : { maskAllInputs: options.privacy.maskAllInputs }),
        ...(options.privacy?.blockAllMedia === undefined
          ? {}
          : { blockAllMedia: options.privacy.blockAllMedia }),
        ...(options.privacy?.maskAttributes
          ? { maskAttributes: options.privacy.maskAttributes }
          : {}),
        ...(options.replayId ? { replayId: options.replayId } : {}),
        ...options.limits,
        metadata,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(options.onBufferFull ? { onBufferFull: options.onBufferFull } : {}),
        ...(options.onBufferChange ? { onBufferChange: options.onBufferChange } : {}),
        onStop: (capture) => {
          void finalize(capture);
        },
      });

      if (controller.getCapture().stopReason) {
        void finalize(controller.getCapture());
        return false;
      }

      if (options.captureBreadcrumbs !== false && client?.on) {
        detachBreadcrumb = client.on('beforeAddBreadcrumb', recordBreadcrumb);
      }

      const navigation: Breadcrumb = {
        category: 'navigation',
        type: 'navigation',
        data: { to: href },
      };
      if (options.sdk.addBreadcrumb) options.sdk.addBreadcrumb(navigation);
      else controller.addBreadcrumb(navigation);
      return true;
    } catch (error) {
      detach();
      controller?.stop('startup-error');
      reportError(error);
      return false;
    }
  };

  const stop = async (reason = 'manual'): Promise<TaroReplayCapture | undefined> => {
    if (!controller) return lastCapture;
    const capture = terminal ? lastCapture || controller.getCapture() : controller.stop(reason);
    if (!terminal) await finalize(capture);
    else if (finalization) await finalization;
    return lastCapture || capture;
  };

  const getController = (): TaroReplayControllerView | undefined => {
    if (!controller) return undefined;
    return {
      addBreadcrumb: (breadcrumb) => recordBreadcrumb(breadcrumb),
      get replayId() {
        return controller?.getCapture().replayId || lastCapture?.replayId || '';
      },
      getCapture: () => controller?.getCapture() || lastCapture!,
      ...(controller.recordCanvas
        ? {
            recordCanvas: (node: TaroReplayNodeLike, readFrame: () => string | undefined) =>
              !terminal &&
              options.recordCanvas === true &&
              controller!.recordCanvas!(node, readFrame),
          }
        : {}),
      ...(controller.takeSegment ? { takeSegment: () => controller!.takeSegment!() } : {}),
      ...(controller.promoteToSession
        ? { promoteToSession: (duration: number) => controller!.promoteToSession!(duration) }
        : {}),
      ...(controller.recordPageScroll
        ? {
            recordPageScroll: (position: { scrollTop?: number; scrollLeft?: number }) =>
              controller!.recordPageScroll!(position),
          }
        : {}),
      ...(controller.recordViewport
        ? {
            recordViewport: (size: { width: number; height: number }) =>
              controller!.recordViewport!(size),
          }
        : {}),
    };
  };

  const dispose = (): void => {
    detach();
    if (controller && !terminal) controller.stop('page-unload');
  };

  return { start, stop, getController, dispose };
}
