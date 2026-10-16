/** Native swiper, scroll-view and picker-view listeners that record state Taro DOM does not mutate. */

import type { TaroReplayNodeLike } from '../types';
import { isCanvasContainer, isInsideCanvas } from './canvas';
import { idFor, nextTimestamp, type RecorderContext } from './context';
import { addEvent } from './events';
import {
  currentSwiperIndex,
  getPickerValues,
  getScrollPosition,
  isPickerView,
  isScrollView,
  isSwiper,
  normalisePickerValues,
  pickerColumns,
  pickerValues,
  rawAttributeValue,
  scrollCoordinate,
  scrollPositions,
  swiperIndex,
  swiperValues,
  toArray,
  type TaroReplayScrollEventLike,
} from './nodes';
import { RrwebEventType, RrwebIncrementalSource } from './rrweb';
import { currentAttributeValue, readAttributes } from './serializer';

export function attachScrollSubtree(ctx: RecorderContext, node: TaroReplayNodeLike): void {
  const { privacy, swiperListeners, scrollListeners, pickerListeners } = ctx;
  if (
    ctx.stopped ||
    privacy.isBlocked(node) ||
    isCanvasContainer(ctx, node) ||
    isInsideCanvas(ctx, node)
  )
    return;
  if (
    isSwiper(node) &&
    node.addEventListener &&
    node.removeEventListener &&
    !swiperListeners.has(node)
  ) {
    const listener = (event: TaroReplayScrollEventLike): void => {
      if (
        ctx.stopped ||
        privacy.isBlocked(node) ||
        swiperListeners.get(node) !== listener ||
        event.detail?.current === undefined
      )
        return;
      const selected = swiperIndex(node, event.detail.current);
      if (selected === currentSwiperIndex(node)) return;
      swiperValues.set(node, { value: selected, propValue: rawAttributeValue(node, 'current') });
      addEvent(ctx, {
        type: RrwebEventType.IncrementalSnapshot,
        timestamp: nextTimestamp(ctx),
        data: {
          source: RrwebIncrementalSource.Mutation,
          texts: [],
          removes: [],
          adds: [],
          attributes: [
            {
              id: idFor(ctx, node),
              attributes: { style: currentAttributeValue(ctx, node, 'style') },
            },
          ],
        },
      });
    };
    try {
      node.addEventListener('change', listener);
      swiperListeners.set(node, listener);
    } catch {
      /* Optional native event surface. */
    }
  }
  if (
    isScrollView(node) &&
    node.addEventListener &&
    node.removeEventListener &&
    !scrollListeners.has(node)
  ) {
    const listener = (event: TaroReplayScrollEventLike): void => {
      if (ctx.stopped || privacy.isBlocked(node) || scrollListeners.get(node) !== listener) return;
      const previous = getScrollPosition(node);
      const position = {
        x: scrollCoordinate(event.detail?.scrollLeft) ?? previous.x,
        y: scrollCoordinate(event.detail?.scrollTop) ?? previous.y,
      };
      if (position.x === previous.x && position.y === previous.y) return;
      scrollPositions.set(node, position);
      addEvent(ctx, {
        type: RrwebEventType.IncrementalSnapshot,
        timestamp: nextTimestamp(ctx),
        data: { source: RrwebIncrementalSource.Scroll, id: idFor(ctx, node), ...position },
      });
    };
    try {
      node.addEventListener('scroll', listener);
      scrollListeners.set(node, listener);
    } catch {
      // An unsupported event surface must not affect page rendering.
    }
  }
  if (
    isPickerView(node) &&
    node.addEventListener &&
    node.removeEventListener &&
    !pickerListeners.has(node)
  ) {
    const listener = (event: TaroReplayScrollEventLike): void => {
      if (
        ctx.stopped ||
        privacy.isBlocked(node) ||
        pickerListeners.get(node) !== listener ||
        !Array.isArray(event.detail?.value)
      )
        return;
      const previous = getPickerValues(node);
      const selected = normalisePickerValues(node, event.detail.value);
      if (selected.every((value, index) => value === previous[index])) return;
      pickerValues.set(node, selected);
      addEvent(ctx, {
        type: RrwebEventType.IncrementalSnapshot,
        timestamp: nextTimestamp(ctx),
        data: {
          source: RrwebIncrementalSource.Mutation,
          texts: [],
          removes: [],
          adds: [],
          attributes: pickerColumns(node).map((column) => ({
            id: idFor(ctx, column),
            attributes: readAttributes(ctx, column),
          })),
        },
      });
    };
    try {
      node.addEventListener('change', listener);
      pickerListeners.set(node, listener);
    } catch {
      // Hosts without native picker events still retain the initial selected rows.
    }
  }
  for (const child of toArray(node.childNodes)) attachScrollSubtree(ctx, child);
}

export function detachScrollSubtree(ctx: RecorderContext, node: TaroReplayNodeLike): void {
  const swiperListener = ctx.swiperListeners.get(node);
  if (swiperListener) {
    try {
      node.removeEventListener?.('change', swiperListener);
    } catch {
      /* Safe native teardown. */
    }
    ctx.swiperListeners.delete(node);
  }
  ctx.canvasFrames.delete(node);
  ctx.serializedNodes.delete(node);
  const sid = node.sid || node.uid;
  if (sid && ctx.nodesBySid.get(sid) === node) {
    ctx.nodesBySid.delete(sid);
    ctx.idsBySid.delete(sid);
  }
  const listener = ctx.scrollListeners.get(node);
  if (listener) {
    try {
      node.removeEventListener?.('scroll', listener);
    } catch {
      // Preserve native lifecycle behavior if a platform cannot remove a listener.
    }
    ctx.scrollListeners.delete(node);
  }
  const pickerListener = ctx.pickerListeners.get(node);
  if (pickerListener) {
    try {
      node.removeEventListener?.('change', pickerListener);
    } catch {
      // Keep recorder teardown separate from application event handlers.
    }
    ctx.pickerListeners.delete(node);
  }
  for (const child of toArray(node.childNodes)) detachScrollSubtree(ctx, child);
}
