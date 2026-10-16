/** Canvas container rules and the committed-DOM mirror used to budget Canvas frames. */

import { utf8ByteLength } from '../../sdk/utf8';
import type { TaroReplayEvent, TaroReplayNodeLike } from '../types';
import { privacyMarker } from './attributes';
import type { RecorderContext } from './context';
import { hasNodeAncestor, normaliseNodeName, rawAttributeValue } from './nodes';
import { createCheckpointRebaser } from './rebase';
import { RrwebEventType, RrwebIncrementalSource } from './rrweb';

export function isCanvasContainer(ctx: RecorderContext, node: TaroReplayNodeLike): boolean {
  const marker = rawAttributeValue(node, 'data-sentry-canvas');
  return (
    ctx.options.recordCanvas === true &&
    ['canvas', 'view'].includes(normaliseNodeName(node)) &&
    (marker === true || marker === 'true')
  );
}

export function isCanvasProtected(ctx: RecorderContext, node: TaroReplayNodeLike): boolean {
  return (
    ctx.privacy.isMasked(node) ||
    ctx.privacy.isBlocked(node) ||
    hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'ignore'))
  );
}

export function isInsideCanvas(ctx: RecorderContext, node: TaroReplayNodeLike): boolean {
  return Boolean(
    node.parentNode &&
    hasNodeAncestor(node.parentNode, (ancestor) => isCanvasContainer(ctx, ancestor)),
  );
}

export function updateCanvasCheckpoint(
  ctx: RecorderContext,
  event: TaroReplayEvent,
  bytes: number,
): void {
  if (!ctx.options.recordCanvas) return;
  if (event.type === RrwebEventType.FullSnapshot) {
    ctx.canvasCheckpoint = createCheckpointRebaser(event);
    ctx.canvasCheckpointUpperBytes = bytes;
  } else if (
    ctx.canvasCheckpoint &&
    event.type === RrwebEventType.IncrementalSnapshot &&
    [
      RrwebIncrementalSource.Mutation,
      RrwebIncrementalSource.Scroll,
      RrwebIncrementalSource.Input,
    ].includes(event.data['source'] as number)
  ) {
    ctx.canvasCheckpoint.apply(event);
    ctx.canvasCheckpointUpperBytes += bytes;
    if (ctx.canvasCheckpointUpperBytes > ctx.maxBytes) {
      ctx.canvasCheckpointUpperBytes = utf8ByteLength(
        JSON.stringify(ctx.canvasCheckpoint.getSnapshot()),
      );
      // Bound the optional mirror even across repeatedly drained sessions.
      // A later normal FullSnapshot can make Canvas capture eligible again.
      if (ctx.canvasCheckpointUpperBytes > ctx.maxBytes) ctx.canvasCheckpoint = undefined;
    }
  }
}
