import { withNetworkOptionsSnapshot } from '../network-config';
import { snapshotNetworkOptions } from '../network-details';
import type { Integration } from '@sentry/core';

import type { SentryMiniappReplaySdk, SentryReplayClient } from '../types';
import { ReplayCoordinator } from './ReplayCoordinator';
import type {
  ReplayCoordinatorOptions,
  ReplayCoordinatorSnapshot,
  TaroReplayBridge,
} from './types';

export interface TaroReplayIntegrationOptions extends Omit<
  ReplayCoordinatorOptions,
  'client' | 'replaysSessionSampleRate' | 'replaysOnErrorSampleRate'
> {
  sdk: SentryMiniappReplaySdk;
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
}

export interface TaroReplayIntegration extends Integration {
  readonly bridge: TaroReplayBridge;
  cleanup(): void;
}

export function taroReplayIntegration(
  options: TaroReplayIntegrationOptions,
): TaroReplayIntegration {
  const networkOptions = snapshotNetworkOptions(options);
  let coordinator: ReplayCoordinator | undefined;
  const listeners = new Set<(snapshot: ReplayCoordinatorSnapshot) => void>();
  const coordinatorSubscriptions = new Map<
    (snapshot: ReplayCoordinatorSnapshot) => void,
    () => void
  >();
  const unavailable = (): ReplayCoordinatorSnapshot => ({
    state: 'disabled',
    eventCount: 0,
    approximateBytes: 0,
  });
  const bridge: TaroReplayBridge = {
    attachRoot: (runtime) => coordinator?.attachRoot(runtime) === true,
    detachRoot: () => coordinator?.detachRoot(),
    start: () => coordinator?.start() === true,
    startBuffering: () => coordinator?.startBuffering() === true,
    stop: (options) => coordinator?.stop(options) || Promise.resolve(),
    reset: () => coordinator?.reset(),
    destroy: () => coordinator?.destroy(),
    getReplayId: () => coordinator?.getReplayId(),
    sendBufferedReplay: () => coordinator?.sendBufferedReplay() || Promise.resolve(),
    recordPageScroll: (position) => coordinator?.recordPageScroll(position),
    recordViewport: (size) => coordinator?.recordViewport(size),
    recordCanvas: (id, readFrame) => coordinator?.recordCanvas(id, readFrame) === true,
    flush: () => coordinator?.flush() || Promise.resolve(),
    refreshEnabled: () => coordinator?.refreshEnabled() === true,
    getSnapshot: () => coordinator?.getSnapshot() || unavailable(),
    subscribe: (listener) => {
      listeners.add(listener);
      const detach = coordinator?.subscribe(listener);
      if (detach) coordinatorSubscriptions.set(listener, detach);
      if (!coordinator) listener(unavailable());
      return () => {
        listeners.delete(listener);
        coordinatorSubscriptions.get(listener)?.();
        coordinatorSubscriptions.delete(listener);
      };
    },
  };

  return {
    name: 'TaroReplay',
    bridge,
    cleanup() {
      coordinator?.destroy();
      coordinator = undefined;
    },
    setup(client) {
      const clientOptions = client.getOptions() as {
        replaysSessionSampleRate?: number;
        replaysOnErrorSampleRate?: number;
      };
      const sessionRate =
        options.replaysSessionSampleRate ?? clientOptions.replaysSessionSampleRate;
      const errorRate = options.replaysOnErrorSampleRate ?? clientOptions.replaysOnErrorSampleRate;
      coordinator?.destroy();
      for (const detach of coordinatorSubscriptions.values()) detach();
      coordinatorSubscriptions.clear();
      coordinator = new ReplayCoordinator({
        ...withNetworkOptionsSnapshot(options, networkOptions),
        client: client as SentryReplayClient,
        ...(sessionRate === undefined ? {} : { replaysSessionSampleRate: sessionRate }),
        ...(errorRate === undefined ? {} : { replaysOnErrorSampleRate: errorRate }),
      });
      for (const listener of listeners) {
        coordinatorSubscriptions.set(listener, coordinator.subscribe(listener));
      }
    },
  };
}
