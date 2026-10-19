import { makeDsn } from '@sentry/core';
import { type Mock, vi } from 'vite-plus/test';

import type {
  SentryMiniappReplaySdk,
  StartTaroReplayRecorderOptions,
  TaroReplayCapture,
  TaroReplayNodeLike,
  TaroReplayRecorderController,
  TaroReplayRuntime,
} from '../../src/replay/types';
import type { Breadcrumb, BreadcrumbHint, Event } from '@sentry/core';

export function makeCapture(overrides: Partial<TaroReplayCapture> = {}): TaroReplayCapture {
  return {
    marker: 'TARO_DOM_REPLAY_POC',
    version: 1,
    replayId: '123e4567-e89b-42d3-a456-426614174000',
    href: 'https://miniapp.local/pages/replay',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    stopReason: 'manual',
    events: [{ type: 4, timestamp: 1_700_000_000_000, data: { title: '你好' } }],
    metadata: {
      environment: 'test',
      release: 'demo@1.0.0',
      sdk: { name: 'sentry.javascript.miniapp', version: '1.13.1' },
      tags: { framework: 'taro' },
      contexts: { miniapp: { type: 'miniapp', platform: 'wechat' } },
    },
    stats: {
      eventCount: 1,
      mutationCount: 0,
      breadcrumbCount: 0,
      networkCount: 0,
      approximateBytes: 10,
    },
    warnings: [],
    ...overrides,
  };
}

export function makeRuntime(root: TaroReplayNodeLike | null = { nodeType: 1 }): TaroReplayRuntime {
  return {
    document: { getElementById: vi.fn(() => root) },
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    getCurrentInstance: () => ({ router: { $taroPath: 'pages/replay?secret=yes' } }),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844 }),
    getEnv: () => 'WEAPP',
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop', version: '2.3.4' } }),
    getAppBaseInfo: () => ({ SDKVersion: '3.6.2' }),
  };
}

export function makeSdk(): {
  sdk: SentryMiniappReplaySdk;
  sendEnvelope: Mock;
  addRecordedBreadcrumb: Mock;
  emitBreadcrumb(
    breadcrumb: Parameters<TaroReplayRecorderController['addBreadcrumb']>[0],
    hint?: BreadcrumbHint,
  ): void;
  emitBeforeSend(event: Event): void;
  getStartOptions(): StartTaroReplayRecorderOptions;
  getDetachCount(): number;
} {
  let startOptions: StartTaroReplayRecorderOptions | undefined;
  let breadcrumbHook:
    | ((
        breadcrumb: Parameters<TaroReplayRecorderController['addBreadcrumb']>[0],
        hint?: BreadcrumbHint,
      ) => void)
    | undefined;
  let beforeSendHook: ((event: Event) => void) | undefined;
  let detachCount = 0;
  let capture = makeCapture({ endedAt: null, stopReason: null, events: [] });
  const sendEnvelope = vi.fn(() => Promise.resolve({ statusCode: 200 }));
  const addRecordedBreadcrumb = vi.fn((breadcrumb: Breadcrumb) => {
    const event = {
      type: 5,
      timestamp: capture.startedAt + capture.events.length,
      data: { tag: 'breadcrumb', payload: breadcrumb },
    };
    capture = {
      ...capture,
      events: [...capture.events, event],
      stats: {
        ...capture.stats,
        eventCount: capture.events.length + 1,
        approximateBytes: capture.stats.approximateBytes + JSON.stringify(event).length,
      },
    };
    startOptions?.onEvent?.(event);
    return true;
  });
  const controller: TaroReplayRecorderController = {
    addBreadcrumb: addRecordedBreadcrumb,
    getCapture: () => ({ ...capture, events: [...capture.events] }),
    stop: (reason = 'manual') => {
      if (!capture.stopReason) {
        capture = { ...capture, endedAt: capture.startedAt + 1_000, stopReason: reason };
        startOptions?.onStop?.(capture);
      }
      return { ...capture, events: [...capture.events] };
    },
  };
  const sdk: SentryMiniappReplaySdk = {
    SDK_NAME: 'sentry.javascript.miniapp',
    SDK_VERSION: '1.13.1',
    getClient: () => ({
      getDsn: () => makeDsn('https://public@example.test/1'),
      getOptions: () => ({ environment: 'staging', release: 'app@2.3.4' }),
      on: (
        hook: 'beforeAddBreadcrumb' | 'beforeSendEvent' | 'beforeSendFeedback',
        callback: any,
      ) => {
        if (hook === 'beforeAddBreadcrumb') breadcrumbHook = callback;
        else if (hook === 'beforeSendEvent') beforeSendHook = callback;
        return () => {
          detachCount++;
          if (hook === 'beforeAddBreadcrumb') breadcrumbHook = undefined;
          else if (hook === 'beforeSendEvent') beforeSendHook = undefined;
        };
      },
      sendEnvelope,
    }),
    addBreadcrumb: (breadcrumb, hint) => breadcrumbHook?.(breadcrumb, hint),
    startTaroReplayRecorder: (options) => {
      startOptions = options;
      if (capture.stopReason) {
        capture = makeCapture({ endedAt: null, stopReason: null, events: [] });
      }
      capture = {
        ...capture,
        ...(options.replayId ? { replayId: options.replayId } : {}),
        href: options.href || capture.href,
        ...(options.metadata ? { metadata: options.metadata } : {}),
        events: [
          { type: 4, timestamp: capture.startedAt, data: { href: options.href || '' } },
          { type: 2, timestamp: capture.startedAt + 1, data: { node: {} } },
        ],
      };
      return controller;
    },
  };

  return {
    sdk,
    sendEnvelope,
    addRecordedBreadcrumb,
    emitBreadcrumb: (breadcrumb, hint) => breadcrumbHook?.(breadcrumb, hint),
    emitBeforeSend: (event) => beforeSendHook?.(event),
    getStartOptions: () => {
      if (!startOptions) throw new Error('Replay was not started');
      return startOptions;
    },
    getDetachCount: () => detachCount,
  };
}
