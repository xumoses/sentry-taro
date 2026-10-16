import { withNetworkOptionsSnapshot } from '../network-config';
import { snapshotNetworkOptions } from '../../sdk/network-details';
import type { Integration } from '@sentry/core';

import type { SentryReplayClient } from '../types';
import { ReplayCoordinator } from './ReplayCoordinator';
import type {
  ReplayCoordinatorOptions,
  ReplayCoordinatorSnapshot,
  ReplayRecordingMode,
  SendBufferedReplayOptions,
  TaroReplayBridge,
} from './types';

export interface TaroReplayIntegrationOptions extends Omit<
  ReplayCoordinatorOptions,
  'client' | 'replaysSessionSampleRate' | 'replaysOnErrorSampleRate'
> {
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
  /** Official privacy options; top-level values take precedence over privacy.*. */
  maskAllText?: boolean;
  maskAllInputs?: boolean;
  blockAllMedia?: boolean;
}

export interface TaroReplayIntegration extends Integration {
  readonly bridge: TaroReplayBridge;
  start(): void;
  startBuffering(): void;
  stop(options?: { flush?: boolean }): Promise<void>;
  flush(options?: SendBufferedReplayOptions): Promise<void>;
  getReplayId(onlyIfSampled?: boolean): string | undefined;
  getRecordingMode(): ReplayRecordingMode | undefined;
  cleanup(): void;
}

export function taroReplayIntegration(
  options: TaroReplayIntegrationOptions = {},
): TaroReplayIntegration {
  const networkOptions = snapshotNetworkOptions(options);
  const privacy = {
    ...options.privacy,
    ...(options.maskAllText === undefined ? {} : { maskAllText: options.maskAllText }),
    ...(options.maskAllInputs === undefined ? {} : { maskAllInputs: options.maskAllInputs }),
    ...(options.blockAllMedia === undefined ? {} : { blockAllMedia: options.blockAllMedia }),
  };
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
    getReplayId: (onlyIfSampled) => coordinator?.getReplayId(onlyIfSampled),
    getRecordingMode: () => coordinator?.getRecordingMode(),
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
    name: 'Replay',
    bridge,
    start: () => {
      coordinator?.start();
    },
    startBuffering: () => {
      coordinator?.startBuffering();
    },
    // Official controls resolve after transport errors; the coordinator reports
    // the failure through its diagnostics. The compatibility bridge keeps its
    // existing promise contract for callers that explicitly handle rejection.
    stop: (options) => coordinator?.stop(options).catch(() => {}) || Promise.resolve(),
    flush: (options) => coordinator?.flushReplay(options).catch(() => {}) || Promise.resolve(),
    getReplayId: (onlyIfSampled) => coordinator?.getReplayId(onlyIfSampled),
    getRecordingMode: () => coordinator?.getRecordingMode(),
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
        privacy,
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
