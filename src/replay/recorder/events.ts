/** Event log: size accounting, session drain, rolling error buffer and segment hand-off. */

import { utf8ByteLength } from '../../sdk/utf8';
import type { TaroReplayCapture, TaroReplayEvent } from '../types';
import { boundReplayEvents } from './buffer';
import { updateCanvasCheckpoint } from './canvas';
import { REPLAY_MAX_DURATION_MS } from './constants';
import { boundedInteger, cloneCapture, type RecorderContext } from './context';
import { RrwebEventType } from './rrweb';

export function eventSize(ctx: RecorderContext, event: TaroReplayEvent): number {
  const cached = ctx.byteSizes.get(event);
  if (cached !== undefined) return cached;
  const bytes = utf8ByteLength(JSON.stringify(event));
  ctx.byteSizes.set(event, bytes);
  return bytes;
}

export function makeEventRoom(ctx: RecorderContext, eventBytes: number): boolean {
  const { capture, options } = ctx;
  const fits = (): boolean =>
    capture.events.length < ctx.maxEvents &&
    capture.stats.approximateBytes + eventBytes <= ctx.maxBytes;
  if (
    !fits() &&
    ctx.rollingWindowMs === undefined &&
    ctx.resources.observer &&
    eventBytes <= ctx.maxBytes &&
    capture.events.length &&
    !ctx.draining &&
    options.onBufferFull
  ) {
    ctx.draining = true;
    try {
      options.onBufferFull();
    } catch {
      // A failed upload scheduler must not break the application's observer callback.
      ctx.warnings.add('Session buffer drain failed');
      // The hook may already have detached the prefix before its queue rejects it.
      // Never continue with increments whose delivery baseline is now uncertain.
      ctx.stop('buffer-drain');
    } finally {
      ctx.draining = false;
    }
  }
  return !ctx.stopped && fits();
}

function notifyBufferChange(ctx: RecorderContext): void {
  ctx.options.onBufferChange?.({
    eventCount: ctx.capture.stats.eventCount,
    approximateBytes: ctx.capture.stats.approximateBytes,
  });
}

export function addEvent(ctx: RecorderContext, event: TaroReplayEvent): boolean {
  if (ctx.stopped) return false;
  const { capture, options, maxBytes, maxEvents } = ctx;
  const eventBytes = eventSize(ctx, event);
  if (ctx.rollingWindowMs !== undefined) {
    const meta = capture.events[0];
    if (event.type === RrwebEventType.FullSnapshot && meta?.type === RrwebEventType.Meta) {
      const alignedMeta = {
        ...meta,
        timestamp: event.timestamp - 1,
        data: { ...meta.data, width: ctx.viewportWidth, height: ctx.viewportHeight },
      };
      const checkpointBytes = utf8ByteLength(JSON.stringify(alignedMeta)) + eventBytes;
      if (checkpointBytes > maxBytes || maxEvents < 2) {
        ctx.stop('limit');
        return false;
      }
      if (
        capture.events.length >= 2 &&
        (capture.stats.approximateBytes + eventBytes > maxBytes ||
          capture.events.length >= maxEvents)
      ) {
        // A complete new snapshot already contains the preceding DOM changes.
        // Replace the baseline instead of evicting that snapshot and keeping stale UI.
        capture.events = [alignedMeta, event];
        capture.startedAt = alignedMeta.timestamp;
        capture.stats.approximateBytes = checkpointBytes;
        capture.stats.eventCount = capture.events.length;
        updateCanvasCheckpoint(ctx, event, eventBytes);
        notifyBufferChange(ctx);
        options.onEvent?.(JSON.parse(JSON.stringify(event)) as TaroReplayEvent);
        return true;
      }
    }
    const previousEvents = capture.events.slice();
    const previousStats = { ...capture.stats };
    capture.events.push(event);
    capture.stats.approximateBytes += eventBytes;
    if (capture.events.some((candidate) => candidate.type === RrwebEventType.FullSnapshot)) {
      const bounded = boundReplayEvents(capture.events, {
        now: event.timestamp,
        windowMs: ctx.rollingWindowMs,
        maxEvents,
        maxBytes,
        eventBytes: (candidate) => eventSize(ctx, candidate),
      });
      if (!bounded.length) {
        capture.events = previousEvents;
        capture.stats = previousStats;
        ctx.stop('limit');
        return false;
      }
      capture.events = bounded;
      capture.startedAt = bounded[0]?.timestamp ?? capture.startedAt;
      capture.stats.approximateBytes = bounded.reduce(
        (total, candidate) => total + eventSize(ctx, candidate),
        0,
      );
    }
    capture.stats.eventCount = capture.events.length;
    updateCanvasCheckpoint(ctx, event, eventBytes);
    notifyBufferChange(ctx);
    options.onEvent?.(JSON.parse(JSON.stringify(event)) as TaroReplayEvent);
    return capture.events.includes(event);
  }
  if (!makeEventRoom(ctx, eventBytes)) {
    ctx.stop('limit');
    return false;
  }

  capture.events.push(event);
  capture.stats.eventCount = capture.events.length;
  capture.stats.approximateBytes += eventBytes;
  updateCanvasCheckpoint(ctx, event, eventBytes);
  notifyBufferChange(ctx);
  options.onEvent?.(JSON.parse(JSON.stringify(event)) as TaroReplayEvent);
  return true;
}

function clearSegment(ctx: RecorderContext, start: number): void {
  const { capture } = ctx;
  capture.startedAt = start;
  capture.events = [];
  capture.stats = {
    eventCount: 0,
    mutationCount: 0,
    breadcrumbCount: 0,
    networkCount: 0,
    approximateBytes: 0,
  };
  notifyBufferChange(ctx);
}

export function takeSegment(ctx: RecorderContext): TaroReplayCapture {
  const segment = cloneCapture(ctx.capture);
  if (ctx.stopped || ctx.rollingWindowMs !== undefined) return segment;
  segment.endedAt = Math.max(ctx.now(), ctx.lastEventTimestamp);
  segment.stopReason = 'segment';
  clearSegment(ctx, segment.endedAt);
  return segment;
}

export function promoteToSession(ctx: RecorderContext, durationMs: number): boolean {
  if (ctx.stopped || ctx.rollingWindowMs === undefined) return false;
  ctx.rollingWindowMs = undefined;
  clearSegment(ctx, Math.max(ctx.now(), ctx.lastEventTimestamp));
  if (ctx.resources.timer) clearTimeout(ctx.resources.timer);
  ctx.resources.timer = setTimeout(
    () => ctx.stop('duration'),
    boundedInteger(durationMs, ctx.maxDurationMs, 1, REPLAY_MAX_DURATION_MS),
  );
  return true;
}
