/** Per-recorder mutable state shared by the serializer, event log and native listeners. */

import type { NetworkHeaderPolicy } from '../../sdk/network-details';
import type {
  StartTaroReplayRecorderOptions,
  TaroReplayCapture,
  TaroReplayEvent,
  TaroReplayMutationObserverLike,
  TaroReplayNodeLike,
} from '../types';
import { toArray, type ScrollPosition, type TaroReplayScrollEventLike } from './nodes';
import type { PrivacyRules } from './privacy-rules';
import type { createCheckpointRebaser } from './rebase';

export type AttributeValue = string | number | true | null;
export type NodeListener = (event: TaroReplayScrollEventLike) => void;

export interface CanvasFrameState {
  imageId: number;
  frame?: string;
  lastReadAt: number;
}

export interface RecorderContext {
  readonly options: StartTaroReplayRecorderOptions;
  readonly now: () => number;
  readonly networkHeaderPolicy: NetworkHeaderPolicy;
  readonly privacy: PrivacyRules;
  readonly maxDurationMs: number;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly mutationLimit: number;
  /** Rolling error-buffer window; cleared when the buffer is promoted to a session. */
  rollingWindowMs: number | undefined;
  viewportWidth: number;
  viewportHeight: number;
  stylesheet: string;
  pagePosition: ScrollPosition;
  stopped: boolean;
  draining: boolean;
  lastEventTimestamp: number;
  nextNodeId: number;
  readonly capture: TaroReplayCapture;
  readonly warnings: Set<string>;
  readonly idsBySid: Map<string, number>;
  readonly nodesBySid: Map<string, TaroReplayNodeLike>;
  readonly idsByNode: WeakMap<object, number>;
  serializedNodes: WeakSet<TaroReplayNodeLike>;
  readonly lastTextValues: WeakMap<object, string>;
  readonly lastAttributeValues: WeakMap<object, Map<string, AttributeValue>>;
  readonly lastInputValues: WeakMap<TaroReplayNodeLike, string>;
  readonly byteSizes: WeakMap<TaroReplayEvent, number>;
  readonly scrollListeners: Map<TaroReplayNodeLike, NodeListener>;
  readonly pickerListeners: Map<TaroReplayNodeLike, NodeListener>;
  readonly swiperListeners: Map<TaroReplayNodeLike, NodeListener>;
  readonly rootListeners: Map<string, NodeListener>;
  readonly canvasFrames: Map<TaroReplayNodeLike, CanvasFrameState>;
  canvasCheckpoint: ReturnType<typeof createCheckpointRebaser<TaroReplayEvent>> | undefined;
  canvasCheckpointUpperBytes: number;
  readonly resources: {
    timer?: ReturnType<typeof setTimeout>;
    observer?: TaroReplayMutationObserverLike;
  };
  stop(reason?: string): TaroReplayCapture;
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

export function cloneCapture(capture: TaroReplayCapture): TaroReplayCapture {
  return {
    ...capture,
    events: JSON.parse(JSON.stringify(capture.events)) as TaroReplayEvent[],
    metadata: capture.metadata
      ? {
          ...capture.metadata,
          ...(capture.metadata.sdk ? { sdk: { ...capture.metadata.sdk } } : {}),
          ...(capture.metadata.user ? { user: { ...capture.metadata.user } } : {}),
          ...(capture.metadata.tags ? { tags: { ...capture.metadata.tags } } : {}),
          ...(capture.metadata.contexts
            ? { contexts: JSON.parse(JSON.stringify(capture.metadata.contexts)) }
            : {}),
        }
      : undefined,
    stats: { ...capture.stats },
    warnings: capture.warnings.slice(),
  };
}

export function idFor(ctx: RecorderContext, node: TaroReplayNodeLike): number {
  const sid = node.sid || node.uid;
  if (sid) {
    ctx.nodesBySid.set(sid, node);
    const existing = ctx.idsBySid.get(sid);
    if (existing !== undefined) {
      ctx.idsByNode.set(node, existing);
      return existing;
    }
    const id = ctx.nextNodeId++;
    ctx.idsBySid.set(sid, id);
    ctx.idsByNode.set(node, id);
    return id;
  }

  const existing = ctx.idsByNode.get(node);
  if (existing !== undefined) return existing;
  const id = ctx.nextNodeId++;
  ctx.idsByNode.set(node, id);
  return id;
}

export function nextTimestamp(ctx: RecorderContext, candidate = ctx.now()): number {
  ctx.lastEventTimestamp = Math.max(candidate, ctx.lastEventTimestamp + 1);
  return ctx.lastEventTimestamp;
}

export function isInCurrentRoot(ctx: RecorderContext, node: TaroReplayNodeLike): boolean {
  const visited = new Set<TaroReplayNodeLike>();
  let current = node;
  while (current !== ctx.options.root) {
    if (visited.has(current)) return false;
    visited.add(current);
    const parent = current.parentNode;
    if (!parent || !toArray(parent.childNodes).includes(current)) return false;
    current = parent;
  }
  return true;
}
