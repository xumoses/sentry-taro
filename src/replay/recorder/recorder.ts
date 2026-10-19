/**
 * Taro runtime DOM -> rrweb-compatible event recorder.
 * The historical POC names remain deprecated aliases; the capture marker value is a data contract.
 * This opt-in module owns serialization, privacy and bounded recording; sampling,
 * idle policy, Replay identity and delivery belong to the Replay coordinator.
 * The recorder's subsystems share one RecorderContext; see ./context.ts.
 */

import { uuid4 } from '@sentry/core';

import { createNetworkHeaderPolicy } from '../../sdk/network-details';
import type {
  StartTaroReplayRecorderOptions,
  TaroReplayCapture,
  TaroReplayRecorder,
} from '../types';
import { sanitizeUrl } from './attributes';
import { addBreadcrumb } from './breadcrumbs';
import { recordCanvas } from './canvas-frames';
import { REPLAY_BUFFER_WINDOW_MS, REPLAY_MAX_DURATION_MS } from './constants';
import { boundedInteger, cloneCapture, nextTimestamp, type RecorderContext } from './context';
import { addEvent, promoteToSession, takeSegment } from './events';
import { attachInteractions } from './interactions';
import { handleMutations } from './mutations';
import { pageScrollPositions, scrollCoordinate } from './nodes';
import { createPrivacyRules } from './privacy-rules';
import { RrwebEventType, RrwebIncrementalSource } from './rrweb';
import { fullSnapshot } from './serializer';
import { normalizeReplayRpx, TARO_REPLAY_BASE_STYLESHEET } from './styles';
import { attachScrollSubtree } from './widgets';

export type {
  StartTaroReplayRecorderOptions,
  TaroReplayCapture,
  TaroReplayEvent,
  TaroReplayMetadata,
  TaroReplayMutationObserverConstructor,
  TaroReplayMutationObserverLike,
  TaroReplayMutationRecordLike,
  TaroReplayNodeLike,
  TaroReplayRecorder,
} from '../types';
export type { TaroReplayScrollEventLike } from './nodes';

/** Capture marker. The value keeps its historical spelling because tools match it in data. */
export const TARO_REPLAY_CAPTURE_MARKER = 'TARO_DOM_REPLAY_POC';

const SYNTHETIC_NODE_MAX_ID = 9;

/**
 * Starts the low-level Taro DOM recorder. Call this after the Taro page root is
 * mounted (for example in useReady), and call stop from useUnload.
 */
export function startTaroReplayRecorder(
  options: StartTaroReplayRecorderOptions,
): TaroReplayRecorder {
  const networkHeaderPolicy = createNetworkHeaderPolicy(options);
  if (!options.root || typeof options.root !== 'object') {
    throw new Error('[sentry-miniapp replay POC] A mounted Taro root node is required');
  }

  const now = options.now || Date.now;
  const startedAt = now();
  const privacy = createPrivacyRules(options);
  const viewportWidth = boundedInteger(options.width, 375, 1, 100_000);
  const ctx: RecorderContext = {
    options,
    now,
    networkHeaderPolicy,
    privacy,
    maxDurationMs: boundedInteger(
      options.maxDurationMs,
      REPLAY_MAX_DURATION_MS,
      1,
      REPLAY_MAX_DURATION_MS,
    ),
    maxEvents: boundedInteger(options.maxEvents, 500, 1, 100_000),
    maxBytes: boundedInteger(options.maxBytes, 512 * 1024, 1, 20 * 1024 * 1024),
    mutationLimit: boundedInteger(options.mutationLimit, 10_000, 1, 100_000),
    rollingWindowMs:
      options.rollingWindowMs === undefined
        ? undefined
        : boundedInteger(
            options.rollingWindowMs,
            REPLAY_BUFFER_WINDOW_MS,
            0,
            REPLAY_BUFFER_WINDOW_MS,
          ),
    viewportWidth,
    viewportHeight: boundedInteger(options.height, 667, 1, 100_000),
    stylesheet: normalizeReplayRpx(
      `${TARO_REPLAY_BASE_STYLESHEET}\n${options.stylesheet || ''}`,
      viewportWidth,
    ),
    pagePosition: pageScrollPositions.get(options.root) ?? { x: 0, y: 0 },
    stopped: false,
    draining: false,
    lastEventTimestamp: startedAt - 1,
    nextNodeId: SYNTHETIC_NODE_MAX_ID + 1,
    capture: {
      marker: TARO_REPLAY_CAPTURE_MARKER,
      version: 1,
      replayId: options.replayId || uuid4(),
      href: sanitizeUrl(options.href || 'https://miniapp.local/replay-poc'),
      startedAt,
      endedAt: null,
      stopReason: null,
      events: [],
      metadata: options.metadata,
      stats: {
        eventCount: 0,
        mutationCount: 0,
        breadcrumbCount: 0,
        networkCount: 0,
        approximateBytes: 0,
      },
      warnings: [],
    },
    warnings: new Set(),
    idsBySid: new Map(),
    nodesBySid: new Map(),
    idsByNode: new WeakMap(),
    serializedNodes: new WeakSet(),
    lastTextValues: new WeakMap(),
    lastAttributeValues: new WeakMap(),
    lastInputValues: new WeakMap(),
    byteSizes: new WeakMap(),
    scrollListeners: new Map(),
    pickerListeners: new Map(),
    swiperListeners: new Map(),
    rootListeners: new Map(),
    canvasFrames: new Map(),
    canvasCheckpoint: undefined,
    canvasCheckpointUpperBytes: 0,
    resources: {},
    stop,
  };
  const { capture } = ctx;

  function recordPageScroll(position: { scrollTop?: number; scrollLeft?: number }): boolean {
    if (ctx.stopped) return false;
    const next = {
      x: scrollCoordinate(position.scrollLeft) ?? ctx.pagePosition.x,
      y: scrollCoordinate(position.scrollTop) ?? ctx.pagePosition.y,
    };
    if (next.x === ctx.pagePosition.x && next.y === ctx.pagePosition.y) return false;
    ctx.pagePosition = next;
    pageScrollPositions.set(options.root, next);
    return addEvent(ctx, {
      type: RrwebEventType.IncrementalSnapshot,
      timestamp: nextTimestamp(ctx),
      data: { source: RrwebIncrementalSource.Scroll, id: 1, ...next },
    });
  }

  function recordViewport(size: { width: number; height: number }): boolean {
    if (
      ctx.stopped ||
      !Number.isFinite(size.width) ||
      size.width <= 0 ||
      !Number.isFinite(size.height) ||
      size.height <= 0 ||
      (size.width === ctx.viewportWidth && size.height === ctx.viewportHeight)
    )
      return false;
    ctx.viewportWidth = size.width;
    ctx.viewportHeight = size.height;
    ctx.stylesheet = normalizeReplayRpx(
      `${TARO_REPLAY_BASE_STYLESHEET}\n${options.stylesheet || ''}`,
      ctx.viewportWidth,
    );
    if (
      !addEvent(ctx, {
        type: RrwebEventType.IncrementalSnapshot,
        timestamp: nextTimestamp(ctx),
        data: {
          source: RrwebIncrementalSource.ViewportResize,
          width: ctx.viewportWidth,
          height: ctx.viewportHeight,
        },
      })
    )
      return false;
    return addEvent(ctx, {
      type: RrwebEventType.FullSnapshot,
      timestamp: nextTimestamp(ctx),
      data: {
        node: fullSnapshot(ctx),
        initialOffset: { top: ctx.pagePosition.y, left: ctx.pagePosition.x },
      },
    });
  }

  function stop(reason = 'manual'): TaroReplayCapture {
    if (ctx.stopped) return cloneCapture(capture);
    ctx.stopped = true;
    if (ctx.resources.timer) clearTimeout(ctx.resources.timer);
    ctx.resources.observer?.disconnect();
    for (const [name, listener] of ctx.rootListeners) {
      try {
        options.root.removeEventListener?.(name, listener);
      } catch {
        /* Safe native teardown. */
      }
    }
    ctx.rootListeners.clear();
    ctx.nodesBySid.clear();
    ctx.idsBySid.clear();
    ctx.canvasFrames.clear();
    ctx.canvasCheckpoint = undefined;
    ctx.serializedNodes = new WeakSet();
    for (const [node, listener] of ctx.swiperListeners) {
      try {
        node.removeEventListener?.('change', listener);
      } catch {
        /* Safe native teardown. */
      }
    }
    ctx.swiperListeners.clear();
    for (const [node, listener] of ctx.pickerListeners) {
      try {
        node.removeEventListener?.('change', listener);
      } catch {
        /* Safe platform fallback. */
      }
    }
    ctx.pickerListeners.clear();
    for (const [node, listener] of ctx.scrollListeners) {
      try {
        node.removeEventListener?.('scroll', listener);
      } catch {
        // Cleanup never changes the host's unload result.
      }
    }
    ctx.scrollListeners.clear();
    capture.endedAt = Math.max(now(), ctx.lastEventTimestamp);
    capture.stopReason = reason;
    capture.warnings = Array.from(ctx.warnings);
    const result = cloneCapture(capture);
    options.onStop?.(result);
    return result;
  }

  const controller: TaroReplayRecorder = {
    addBreadcrumb: (breadcrumb) => addBreadcrumb(ctx, breadcrumb),
    getCapture: () => cloneCapture(capture),
    stop,
    takeSegment: () => takeSegment(ctx),
    promoteToSession: (durationMs) => promoteToSession(ctx, durationMs),
    recordPageScroll,
    recordViewport,
    recordCanvas: (node, readFrame) => recordCanvas(ctx, node, readFrame),
  };

  addEvent(ctx, {
    type: RrwebEventType.Meta,
    timestamp: nextTimestamp(ctx, startedAt),
    data: {
      href: capture.href,
      width: ctx.viewportWidth,
      height: ctx.viewportHeight,
    },
  });
  addEvent(ctx, {
    type: RrwebEventType.FullSnapshot,
    timestamp: nextTimestamp(ctx, startedAt),
    data: {
      node: fullSnapshot(ctx),
      initialOffset: { top: ctx.pagePosition.y, left: ctx.pagePosition.x },
    },
  });

  capture.warnings = Array.from(ctx.warnings);
  // A very small maxEvents/maxBytes can stop while the initial snapshot is
  // being appended. Do not create live resources after that terminal state.
  if (ctx.stopped) return controller;

  ctx.resources.observer = new options.MutationObserver((records) => handleMutations(ctx, records));
  ctx.resources.observer.observe(options.root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  attachScrollSubtree(ctx, options.root);
  attachInteractions(ctx);
  ctx.resources.timer = setTimeout(() => stop('duration'), ctx.maxDurationMs);

  return controller;
}
