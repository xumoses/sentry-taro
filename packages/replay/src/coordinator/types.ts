import type { ReplayCompressionOptions } from '../compression';
import type { ReplayDeliveryOptions, ReplayDeliverySnapshot } from './delivery';
import type { TaroReplayContext, TaroReplayMetadata } from '../types';
import type { Event } from '@sentry/core';

import type {
  SentryMiniappReplaySdk,
  SentryReplayClient,
  TaroReplayLimitOptions,
  TaroReplayNetworkOptions,
  TaroReplayPrivacyOptions,
  TaroReplayRuntime,
} from '../types';

export type ReplayCoordinatorState =
  | 'disabled'
  | 'session'
  | 'buffer'
  | 'promoted'
  | 'sent'
  | 'error'
  | 'stopped';

export interface ReplayCoordinatorSnapshot {
  state: ReplayCoordinatorState;
  replayId?: string;
  errorEventId?: string;
  sentReplayId?: string;
  eventCount: number;
  approximateBytes: number;
  error?: Error;
  delivery?: ReplayDeliverySnapshot;
  recording?: boolean;
}

export interface ReplayCoordinatorOptions extends TaroReplayNetworkOptions {
  sdk: SentryMiniappReplaySdk;
  client: SentryReplayClient;
  enabled?: boolean | (() => boolean);
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
  random?: () => number;
  now?: () => number;
  privacy?: TaroReplayPrivacyOptions;
  /** Default false. Requires the SDK's explicit per-canvas marker and pixel safeguards. */
  recordCanvas?: boolean;
  limits?: TaroReplayLimitOptions;
  /** Session segments are drained without replacing observers when supported by the SDK. */
  flushIntervalMs?: number;
  delivery?: ReplayDeliveryOptions;
  /** Optional WeChat worker. Omit to retain uncompressed Replay delivery. */
  compression?: ReplayCompressionOptions;
  beforeErrorSampling?: (event: ReplayAwareEvent) => boolean;
  getMetadata?: (context: TaroReplayContext) => TaroReplayMetadata | undefined;
  onError?: (error: Error) => void;
}

export interface TaroReplayBridge {
  attachRoot(runtime: TaroReplayRuntime): boolean;
  detachRoot(): void;
  flush(): Promise<void>;
  start?(): boolean;
  startBuffering?(): boolean;
  stop?(options?: { flush?: boolean }): Promise<void>;
  /** Discards the identity boundary and waits for the next visible page attach. */
  reset?(): void;
  destroy?(): void;
  getReplayId?(): string | undefined;
  /** Explicit operator action; ordinary buffer flush remains a no-op. */
  sendBufferedReplay?(): Promise<void>;
  recordPageScroll?(position: { scrollTop?: number; scrollLeft?: number }): void;
  recordViewport?(size: { width: number; height: number }): void;
  /** Resolves a canvas inside the visible root before the SDK may read its pixels. */
  recordCanvas?(id: string, readFrame: () => string | undefined): boolean;
  /** Re-evaluates a runtime kill switch and tears down immediately when disabled. */
  refreshEnabled(): boolean;
  getSnapshot(): ReplayCoordinatorSnapshot;
  subscribe(listener: (snapshot: ReplayCoordinatorSnapshot) => void): () => void;
}

export interface ReplayAwareEvent extends Event {
  event_id?: string;
}
