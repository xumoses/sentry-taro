/** Reads explicitly marked Canvas frames into the recording within the frame and size budget. */

import { utf8ByteLength } from '../../sdk/utf8';
import type { TaroReplayEvent, TaroReplayNodeLike } from '../types';
import { isCanvasContainer, isCanvasProtected } from './canvas';
import { isInCurrentRoot, nextTimestamp, type RecorderContext } from './context';
import { addEvent, eventSize, makeEventRoom } from './events';
import { CANVAS_FRAME_INTERVAL_MS, MAX_CANVAS_FRAME_BYTES, isCanvasFrame } from './media';
import { createCheckpointRebaser } from './rebase';
import { RrwebEventType, RrwebIncrementalSource } from './rrweb';

function canRecordCanvas(ctx: RecorderContext, node: TaroReplayNodeLike): boolean {
  return (
    !ctx.stopped &&
    isCanvasContainer(ctx, node) &&
    ctx.serializedNodes.has(node) &&
    isInCurrentRoot(ctx, node) &&
    !isCanvasProtected(ctx, node)
  );
}

export function recordCanvas(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
  readFrame: () => string | undefined,
): boolean {
  const { canvasFrames } = ctx;
  if (!canRecordCanvas(ctx, node)) {
    const previous = canvasFrames.get(node);
    if (previous) delete previous.frame;
    return false;
  }
  const state = canvasFrames.get(node);
  if (!state) return false;
  const readAt = ctx.now();
  if (readAt - state.lastReadAt < CANVAS_FRAME_INTERVAL_MS) return false;
  state.lastReadAt = readAt;
  let frame: string | undefined;
  try {
    frame = readFrame();
  } catch {
    return false;
  }
  if (!canRecordCanvas(ctx, node) || canvasFrames.get(node) !== state) {
    delete state.frame;
    return false;
  }
  if (!isCanvasFrame(frame) || frame === state.frame) return false;
  const event: TaroReplayEvent = {
    type: RrwebEventType.IncrementalSnapshot,
    timestamp: nextTimestamp(ctx),
    data: {
      source: RrwebIncrementalSource.Mutation,
      texts: [],
      adds: [],
      removes: [],
      attributes: [{ id: state.imageId, attributes: { src: frame } }],
    },
  };
  const retainedBytes =
    [...canvasFrames.values()].reduce(
      (total, candidate) => total + (candidate.frame?.length ?? 0),
      0,
    ) -
    (state.frame?.length ?? 0) +
    frame.length;
  // Use only committed rrweb data. Serializing the live VDOM here would consume
  // pending mutation values, even when this optional frame is ultimately rejected.
  const futureCheckpoint =
    ctx.canvasCheckpoint && createCheckpointRebaser(ctx.canvasCheckpoint.getSnapshot());
  futureCheckpoint?.apply(event);
  const metaBytes = utf8ByteLength(
    JSON.stringify({
      type: RrwebEventType.Meta,
      timestamp: event.timestamp - 1,
      data: { href: ctx.capture.href, width: ctx.viewportWidth, height: ctx.viewportHeight },
    }),
  );
  if (
    retainedBytes > Math.min(MAX_CANVAS_FRAME_BYTES, Math.floor(ctx.maxBytes / 4)) ||
    !futureCheckpoint ||
    utf8ByteLength(JSON.stringify(futureCheckpoint.getSnapshot())) + metaBytes > ctx.maxBytes ||
    !makeEventRoom(ctx, eventSize(ctx, event))
  ) {
    ctx.warnings.add('Canvas frame skipped: recording budget exceeded');
    ctx.capture.warnings = Array.from(ctx.warnings);
    return false;
  }
  state.frame = frame;
  try {
    addEvent(ctx, event);
  } catch {
    // User onEvent callbacks must not interrupt the chart's render callback.
  }
  // A rolling buffer may fold the event straight into its baseline.
  return !ctx.stopped;
}
