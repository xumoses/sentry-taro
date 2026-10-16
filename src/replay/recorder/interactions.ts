/** Root-level tap, touch, focus and input listeners mapped to rrweb interaction events. */

import type { TaroReplayNodeLike } from '../types';
import { privacyMarker } from './attributes';
import { addBreadcrumb } from './breadcrumbs';
import { isInsideCanvas } from './canvas';
import { idFor, nextTimestamp, type RecorderContext } from './context';
import { addEvent } from './events';
import {
  hasNodeAncestor,
  inputValues,
  isInputNode,
  normaliseNodeName,
  rawAttributeValue,
  type TaroReplayScrollEventLike,
} from './nodes';
import { RrwebEventType, RrwebIncrementalSource } from './rrweb';
import { safeInputValue } from './serializer';

export function attachInteractions(ctx: RecorderContext): void {
  const root = ctx.options.root;
  if (!root.addEventListener || !root.removeEventListener) return;
  const interactions: Record<string, number> = {
    tap: 2,
    focus: 5,
    blur: 6,
    touchstart: 7,
    touchend: 9,
    touchcancel: 10,
  };
  let lastTouchMoveAt = -Infinity;
  for (const name of [...Object.keys(interactions), 'touchmove', 'input', 'change']) {
    const listener = (event: TaroReplayScrollEventLike): void => {
      if (ctx.stopped) return;
      const target = event.target;
      const sid = target?.dataset?.sid ?? target?.sid ?? target?.id;
      const node = target?.nodeType
        ? (target as TaroReplayNodeLike)
        : sid
          ? ctx.nodesBySid.get(sid)
          : undefined;
      if (
        !node ||
        !ctx.idsByNode.has(node) ||
        !ctx.serializedNodes.has(node) ||
        isInsideCanvas(ctx, node) ||
        ctx.privacy.isBlocked(node) ||
        hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'ignore'))
      )
        return;
      if (name === 'input' || name === 'change') {
        if (!isInputNode(node) || event.detail?.value === undefined) return;
        const value = event.detail.value;
        // A native value may precede its controlled prop update. Never write application props.
        inputValues.set(node, { value, propValue: rawAttributeValue(node, 'value') });
        const text = safeInputValue(ctx, node, value);
        if (ctx.lastInputValues.get(node) === text) return;
        ctx.lastInputValues.set(node, text);
        ctx.lastAttributeValues.get(node)?.set('value', text);
        addEvent(ctx, {
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(ctx),
          data: {
            source: RrwebIncrementalSource.Input,
            id: idFor(ctx, node),
            text,
            isChecked: false,
          },
        });
        return;
      }
      const touch = event.changedTouches?.[0] ?? event.touches?.[0];
      const x =
        touch?.clientX ??
        (typeof touch?.pageX === 'number' ? touch.pageX - ctx.pagePosition.x : undefined);
      const y =
        touch?.clientY ??
        (typeof touch?.pageY === 'number' ? touch.pageY - ctx.pagePosition.y : undefined);
      if (name === 'touchmove') {
        if (!Number.isFinite(x) || !Number.isFinite(y) || ctx.now() - lastTouchMoveAt < 50) return;
        lastTouchMoveAt = ctx.now();
        addEvent(ctx, {
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(ctx),
          data: {
            source: RrwebIncrementalSource.TouchMove,
            positions: [{ id: idFor(ctx, node), x, y, timeOffset: 0 }],
          },
        });
        return;
      }
      // Focus/blur do not need coordinates. Other interactions use only real platform coordinates.
      if (name !== 'focus' && name !== 'blur' && (!Number.isFinite(x) || !Number.isFinite(y)))
        return;
      addEvent(ctx, {
        type: RrwebEventType.IncrementalSnapshot,
        timestamp: nextTimestamp(ctx),
        data: {
          source: RrwebIncrementalSource.MouseInteraction,
          type: interactions[name],
          id: idFor(ctx, node),
          ...(typeof x === 'number' && typeof y === 'number' ? { x, y } : {}),
        },
      });
      if (name === 'tap')
        addBreadcrumb(ctx, {
          category: 'ui.click',
          message: normaliseNodeName(node),
          data: { nodeId: idFor(ctx, node) },
        });
    };
    try {
      root.addEventListener(name, listener);
      ctx.rootListeners.set(name, listener);
    } catch {
      /* Unsupported native events are optional. */
    }
  }
}
