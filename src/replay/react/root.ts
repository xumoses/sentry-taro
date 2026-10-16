import { document, MutationObserver } from '@tarojs/runtime';
import Taro, {
  useDidHide,
  useDidShow,
  usePageScroll,
  useReady,
  useResize,
  useUnload,
} from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';

import type { ReplayCoordinatorSnapshot, TaroReplayBridge } from '../coordinator/types';
import type { TaroReplayRuntime } from '../types';

function createRuntime(): TaroReplayRuntime {
  const taro = Taro as unknown as {
    getCurrentInstance(): ReturnType<TaroReplayRuntime['getCurrentInstance']>;
    getWindowInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getWindowInfo']>>;
    getSystemInfoSync?(): { windowWidth?: number; windowHeight?: number };
    getEnv?(): string;
    getAccountInfoSync?(): ReturnType<NonNullable<TaroReplayRuntime['getAccountInfoSync']>>;
    getAppBaseInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getAppBaseInfo']>>;
    getDeviceInfo?(): ReturnType<NonNullable<TaroReplayRuntime['getDeviceInfo']>>;
  };
  return {
    document,
    MutationObserver: MutationObserver as unknown as TaroReplayRuntime['MutationObserver'],
    getCurrentInstance: () => taro.getCurrentInstance(),
    getWindowInfo: () => taro.getWindowInfo?.() || taro.getSystemInfoSync?.() || {},
    getEnv: () => taro.getEnv?.() || 'unknown',
    getAccountInfoSync: () => taro.getAccountInfoSync?.() || {},
    getAppBaseInfo: () => taro.getAppBaseInfo?.() || {},
    getDeviceInfo: () => taro.getDeviceInfo?.() || {},
  };
}

const rootOwners = new WeakMap<TaroReplayBridge, object>();

export interface UseTaroReplayRootOptions {
  bridge?: TaroReplayBridge;
}

/** Subscribes to coordinator state without owning a page root lifecycle. */
export function useTaroReplaySnapshot({
  bridge,
}: UseTaroReplayRootOptions): ReplayCoordinatorSnapshot {
  const [snapshot, setSnapshot] = useState<ReplayCoordinatorSnapshot>(
    () =>
      bridge?.getSnapshot() || {
        state: 'disabled',
        eventCount: 0,
        approximateBytes: 0,
      },
  );
  useEffect(() => {
    if (!bridge) return;
    return bridge.subscribe(setSnapshot);
  }, [bridge]);
  return snapshot;
}

/** Attaches only the visible Taro root to the native process-wide coordinator. */
export function useTaroReplayRoot(options: UseTaroReplayRootOptions): ReplayCoordinatorSnapshot {
  const { bridge } = options;
  const snapshot = useTaroReplaySnapshot(options);
  const owner = useRef({});
  const hidden = useRef(false);
  const attached = useRef(false);
  const attach = () => {
    if (!bridge || hidden.current || (rootOwners.get(bridge) === owner.current && attached.current))
      return;
    attached.current = bridge.attachRoot(createRuntime());
    // A visible root is also needed by manual start when automatic sampling is off.
    // Keep failed recording attaches retryable, but always release visibility on hide.
    rootOwners.set(bridge, owner.current);
  };
  const detach = () => {
    hidden.current = true;
    attached.current = false;
    if (bridge && rootOwners.get(bridge) === owner.current) {
      rootOwners.delete(bridge);
      bridge.detachRoot();
    }
  };
  useReady(attach);
  useDidShow(() => {
    hidden.current = false;
    attach();
  });
  usePageScroll((event) => {
    if (bridge && rootOwners.get(bridge) === owner.current) bridge.recordPageScroll?.(event);
  });
  useResize((event) => {
    if (bridge && rootOwners.get(bridge) === owner.current)
      bridge.recordViewport?.({ width: event.size.windowWidth, height: event.size.windowHeight });
  });
  useDidHide(detach);
  useUnload(detach);
  useEffect(() => detach, [bridge]);
  return snapshot;
}

export type { ReplayCoordinatorSnapshot, TaroReplayBridge } from '../coordinator/types';
