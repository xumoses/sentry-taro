import { document, hooks, MutationObserver } from '@tarojs/runtime';
import Taro from '@tarojs/taro';

import type { TaroReplayBridge } from '../coordinator/types';
import type { TaroReplayRuntime } from '../types';

type PageLifecycle = (...args: unknown[]) => unknown;
type PageLifecycleConfig = Record<string, unknown> & {
  onReady?: PageLifecycle;
  onShow?: PageLifecycle;
  onHide?: PageLifecycle;
  onUnload?: PageLifecycle;
  onPageScroll?: PageLifecycle;
  onResize?: PageLifecycle;
};
type TaroPageInstance = {
  $taroPath?: string;
  route?: string;
  __route__?: string;
};

const installedBridges = new WeakSet<object>();
const readyPages = new WeakSet<object>();
const visiblePages = new WeakSet<object>();
const hiddenPages = new WeakSet<object>();
const attachedPages = new WeakSet<object>();
const scheduledPages = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function createRuntime(
  page: unknown,
  getReplayStyles?: TaroReplayRuntime['getReplayStyles'],
  getReplayImageSources?: TaroReplayRuntime['getReplayImageSources'],
): TaroReplayRuntime {
  const taro = Taro as unknown as {
    getCurrentInstance(): ReturnType<TaroReplayRuntime['getCurrentInstance']>;
    getWindowInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getWindowInfo']>>;
    getSystemInfoSync?(): { windowWidth?: number; windowHeight?: number };
    getEnv?(): string;
    getAccountInfoSync?(): ReturnType<NonNullable<TaroReplayRuntime['getAccountInfoSync']>>;
    getAppBaseInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getAppBaseInfo']>>;
    getDeviceInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getDeviceInfo']>>;
    nextTick?(callback: () => void): void;
  };
  const pageInstance = isObject(page) ? (page as TaroPageInstance) : undefined;
  const pagePath = pageInstance?.$taroPath || pageInstance?.route || pageInstance?.__route__;
  return {
    document,
    MutationObserver: MutationObserver as unknown as TaroReplayRuntime['MutationObserver'],
    getCurrentInstance: () =>
      pagePath
        ? {
            router: {
              ...(pageInstance?.$taroPath ? { $taroPath: pageInstance.$taroPath } : {}),
              path: pageInstance?.route || pageInstance?.__route__ || pagePath,
            },
          }
        : taro.getCurrentInstance(),
    getWindowInfo: () => taro.getWindowInfo?.() || taro.getSystemInfoSync?.() || {},
    ...(getReplayStyles ? { getReplayStyles } : {}),
    ...(getReplayImageSources ? { getReplayImageSources } : {}),
    getEnv: () => taro.getEnv?.() || 'unknown',
    getAccountInfoSync: () => taro.getAccountInfoSync?.() || {},
    getAppBaseInfo: () => taro.getAppBaseInfo?.() || {},
    getDeviceInfo: () => taro.getDeviceInfo?.() || {},
  };
}

function wrapLifecycle(
  original: PageLifecycle | undefined,
  replayLifecycle: (page: unknown, args: unknown[]) => void,
): PageLifecycle {
  return function wrappedLifecycle(this: unknown, ...args: unknown[]): unknown {
    try {
      return original?.apply(this, args);
    } finally {
      try {
        replayLifecycle(this, args);
      } catch {
        // Replay is diagnostic-only and must never alter Taro page navigation.
      }
    }
  };
}

/** Instruments every Taro page created after installation without changing page components. */
export function installTaroReplayPageLifecycle({
  bridge,
  getReplayStyles,
  getReplayImageSources,
}: {
  bridge?: TaroReplayBridge;
  getReplayStyles?: TaroReplayRuntime['getReplayStyles'];
  getReplayImageSources?: TaroReplayRuntime['getReplayImageSources'];
}): void {
  if (!bridge || installedBridges.has(bridge)) return;
  installedBridges.add(bridge);
  let activePage: unknown;

  hooks.tap('modifyPageObject', (pageConfig: PageLifecycleConfig) => {
    const scheduleAttach = (page: unknown) => {
      if (!isObject(page)) {
        bridge.attachRoot(createRuntime(page, getReplayStyles, getReplayImageSources));
        return;
      }
      if (
        !readyPages.has(page) ||
        !visiblePages.has(page) ||
        attachedPages.has(page) ||
        scheduledPages.has(page)
      ) {
        return;
      }
      scheduledPages.add(page);
      const attach = () => {
        scheduledPages.delete(page);
        if (!visiblePages.has(page) || attachedPages.has(page)) return;
        try {
          if (bridge.attachRoot(createRuntime(page, getReplayStyles, getReplayImageSources))) {
            attachedPages.add(page);
            activePage = page;
          }
        } catch {
          // Replay is diagnostic-only and must never alter Taro page navigation.
        }
      };
      const taro = Taro as unknown as { nextTick?(callback: () => void): void };
      if (taro.nextTick) taro.nextTick(attach);
      else setTimeout(attach, 0);
    };
    const show = (page: unknown) => {
      if (isObject(page)) {
        hiddenPages.delete(page);
        visiblePages.add(page);
      }
      scheduleAttach(page);
    };
    const ready = (page: unknown) => {
      if (isObject(page)) {
        readyPages.add(page);
        if (!hiddenPages.has(page)) visiblePages.add(page);
      }
      scheduleAttach(page);
    };
    const detach = (page: unknown, unload = false) => {
      if (isObject(page)) {
        visiblePages.delete(page);
        hiddenPages.add(page);
        scheduledPages.delete(page);
        if (unload) readyPages.delete(page);
        if (!attachedPages.delete(page)) return;
      }
      if (activePage !== page) return;
      activePage = undefined;
      bridge.detachRoot();
    };
    pageConfig.onReady = wrapLifecycle(pageConfig.onReady, ready);
    pageConfig.onShow = wrapLifecycle(pageConfig.onShow, show);
    pageConfig.onHide = wrapLifecycle(pageConfig.onHide, (page) => detach(page));
    pageConfig.onUnload = wrapLifecycle(pageConfig.onUnload, (page) => detach(page, true));
    pageConfig.onPageScroll = wrapLifecycle(pageConfig.onPageScroll, (page, args) => {
      if (activePage !== page || !isObject(page) || !visiblePages.has(page)) return;
      const event = args[0] as { scrollTop?: number; scrollLeft?: number } | undefined;
      if (event) bridge.recordPageScroll?.(event);
    });
    pageConfig.onResize = wrapLifecycle(pageConfig.onResize, (page, args) => {
      if (activePage !== page || !isObject(page) || !visiblePages.has(page)) return;
      const event = args[0] as
        | { size?: { windowWidth?: number; windowHeight?: number } }
        | undefined;
      const width = event?.size?.windowWidth;
      const height = event?.size?.windowHeight;
      if (typeof width === 'number' && typeof height === 'number')
        bridge.recordViewport?.({ width, height });
    });
  });
}

export type { TaroReplayBridge } from '../coordinator/types';
