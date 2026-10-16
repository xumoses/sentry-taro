/** Taro node inspection and per-node widget state shared across recorder instances. */

import type { TaroReplayNodeLike } from '../types';

export interface TaroReplayScrollEventLike {
  detail?: { scrollTop?: unknown; scrollLeft?: unknown; value?: unknown; current?: unknown };
  target?: { nodeType?: number; sid?: string; id?: string; dataset?: { sid?: string } };
  touches?: Array<{ clientX?: number; clientY?: number; pageX?: number; pageY?: number }>;
  changedTouches?: Array<{ clientX?: number; clientY?: number; pageX?: number; pageY?: number }>;
}

export interface ScrollPosition {
  x: number;
  y: number;
}

// A still-mounted page retains its native offset when the buffer promotes and
// creates a new recorder. Weak keys release the offset with the virtual node.
export const scrollPositions = new WeakMap<TaroReplayNodeLike, ScrollPosition>();
export const pickerValues = new WeakMap<TaroReplayNodeLike, number[]>();
export const swiperValues = new WeakMap<
  TaroReplayNodeLike,
  { value: number; propValue: unknown }
>();
export const pageScrollPositions = new WeakMap<TaroReplayNodeLike, ScrollPosition>();
export const inputValues = new WeakMap<
  TaroReplayNodeLike,
  { value: unknown; propValue: unknown }
>();
// A mounted input remains sensitive across buffer promotion and page reattachment.
// Object identity avoids retaining unmounted nodes or inheriting a reused sid.
export const sensitiveInputs = new WeakSet<TaroReplayNodeLike>();

export function isRootPortal(node: TaroReplayNodeLike): boolean {
  return normaliseNodeName(node) === 'root-portal';
}

export function portalEnabled(node: TaroReplayNodeLike): boolean {
  const value = rawAttributeValue(node, 'enable');
  return isRootPortal(node) && value !== false && value !== 'false' && value !== 0;
}

export function isPickerView(node: TaroReplayNodeLike): boolean {
  return normaliseNodeName(node) === 'picker-view';
}

export function isSwiper(node: TaroReplayNodeLike): boolean {
  return normaliseNodeName(node) === 'swiper';
}

export function swiperItems(node: TaroReplayNodeLike): TaroReplayNodeLike[] {
  return toArray(node.childNodes).filter((child) => normaliseNodeName(child) === 'swiper-item');
}

export function swiperIndex(node: TaroReplayNodeLike, value: unknown): number {
  const numeric = Number(value);
  return Math.min(
    Math.max(0, swiperItems(node).length - 1),
    Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0,
  );
}

export function currentSwiperIndex(node: TaroReplayNodeLike): number {
  const propValue = rawAttributeValue(node, 'current');
  const observed = swiperValues.get(node);
  return swiperIndex(
    node,
    observed && observed.propValue === propValue ? observed.value : propValue,
  );
}

export function pickerColumns(node: TaroReplayNodeLike): TaroReplayNodeLike[] {
  return toArray(node.childNodes).filter(
    (child) => normaliseNodeName(child) === 'picker-view-column',
  );
}

export function pickerRows(node: TaroReplayNodeLike): TaroReplayNodeLike[] {
  return toArray(node.childNodes).filter((child) => child.nodeType === 1);
}

export function normalisePickerValues(node: TaroReplayNodeLike, value: unknown): number[] {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return pickerColumns(node).map((column, index) => {
    const numeric = Number(values[index]);
    const selected = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    return Math.min(selected, Math.max(0, pickerRows(column).length - 1));
  });
}

export function getPickerValues(node: TaroReplayNodeLike): number[] {
  return normalisePickerValues(
    node,
    pickerValues.get(node) ??
      rawAttributeValue(node, 'value') ??
      rawAttributeValue(node, 'defaultvalue'),
  );
}

export function hasNodeAncestor(
  node: TaroReplayNodeLike,
  predicate: (node: TaroReplayNodeLike) => boolean,
): boolean {
  for (
    let current: TaroReplayNodeLike | null | undefined = node;
    current;
    current = current.parentNode
  ) {
    if (predicate(current)) return true;
  }
  return false;
}

export function containsRootPortal(node: TaroReplayNodeLike): boolean {
  return isRootPortal(node) || toArray(node.childNodes).some(containsRootPortal);
}

export function isScrollView(node: TaroReplayNodeLike): boolean {
  const name = normaliseNodeName(node);
  return name === 'scroll-view' || name === 'scrollview';
}

export function scrollCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function getScrollPosition(node: TaroReplayNodeLike): ScrollPosition {
  const remembered = scrollPositions.get(node);
  if (remembered) return remembered;
  return {
    x:
      scrollCoordinate(rawAttributeValue(node, 'scrollLeft')) ??
      scrollCoordinate(rawAttributeValue(node, 'scroll-left')) ??
      0,
    y:
      scrollCoordinate(rawAttributeValue(node, 'scrollTop')) ??
      scrollCoordinate(rawAttributeValue(node, 'scroll-top')) ??
      0,
  };
}

export function toArray<T>(value: T[] | ArrayLike<T> | undefined): T[] {
  return value ? Array.from(value) : [];
}

export function normaliseNodeName(node: TaroReplayNodeLike): string {
  return (node.nodeName || node.tagName || 'unknown').toLowerCase();
}

export function isInputNode(node: TaroReplayNodeLike): boolean {
  const nodeName = normaliseNodeName(node);
  return nodeName === 'input' || nodeName === 'textarea';
}

export function rawAttributeValue(node: TaroReplayNodeLike, name: string): unknown {
  const attribute = toArray(node.attributes).find(
    (item) => item && typeof item.name === 'string' && item.name.toLowerCase() === name,
  );
  if (attribute) return attribute.value;
  if (node.hasAttribute && !node.hasAttribute(name)) return undefined;
  const value = node.getAttribute?.(name);
  return !node.hasAttribute && value === '' ? undefined : value;
}
