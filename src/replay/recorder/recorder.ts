/**
 * Taro runtime DOM -> rrweb-compatible event recorder.
 * The historical POC names remain deprecated aliases; the capture marker value is a data contract.
 * This opt-in module owns serialization, privacy and bounded recording; sampling,
 * idle policy, Replay identity and delivery belong to the Replay coordinator.
 */

import { uuid4, type Breadcrumb } from '@sentry/core';

import { REPLAY_BUFFER_WINDOW_MS, REPLAY_MAX_DURATION_MS } from './constants';
import { normalizeReplayRpx, sanitizeReplayStyle, TARO_REPLAY_BASE_STYLESHEET } from './styles';
import { boundReplayEvents } from './buffer';
import { utf8ByteLength } from '../../sdk/utf8';
import { createCheckpointRebaser } from './rebase';
import {
  TAG_MAP,
  SELF_CLOSING_TAGS,
  URL_ATTRIBUTE_NAMES,
  INPUT_MASK_ATTRIBUTE_NAMES,
  sanitizeUrl,
  maskValue,
  hasMaskingFlag,
  privacyMarker,
  sanitizeAttributeValue,
} from './attributes';
import {
  MEDIA_NODE_NAMES,
  MAX_STATIC_IMAGE_SOURCE_BYTES,
  MAX_CANVAS_FRAME_BYTES,
  CANVAS_FRAME_INTERVAL_MS,
  isStaticImageDataUri,
  isCanvasFrame,
} from './media';
import {
  scrollPositions,
  pickerValues,
  swiperValues,
  pageScrollPositions,
  inputValues,
  sensitiveInputs,
  isRootPortal,
  portalEnabled,
  isPickerView,
  isSwiper,
  swiperItems,
  swiperIndex,
  currentSwiperIndex,
  pickerColumns,
  pickerRows,
  normalisePickerValues,
  getPickerValues,
  hasNodeAncestor,
  containsRootPortal,
  isScrollView,
  scrollCoordinate,
  getScrollPosition,
  toArray,
  normaliseNodeName,
  isInputNode,
  rawAttributeValue,
  type TaroReplayScrollEventLike,
} from './nodes';
import { createNetworkHeaderPolicy, readNetworkDataField } from '../../sdk/network-details';
import type {
  StartTaroReplayRecorderOptions,
  TaroReplayCapture,
  TaroReplayEvent,
  TaroReplayMutationObserverLike,
  TaroReplayMutationRecordLike,
  TaroReplayNodeLike,
  TaroReplayRecorder,
} from '../types';

export type {
  StartTaroDomReplayPocOptions,
  StartTaroReplayRecorderOptions,
  TaroDomReplayPocController,
  TaroReplayMutationObserverConstructor,
  TaroReplayMutationObserverLike,
  TaroReplayMutationRecordLike,
  TaroReplayNodeLike,
  TaroReplayPocCapture,
  TaroReplayPocEvent,
  TaroReplayPocMetadata,
  TaroReplayRecorder,
} from '../types';
export type { TaroReplayScrollEventLike } from './nodes';

/** Capture marker. The value keeps its historical spelling because tools match it in data. */
export const TARO_REPLAY_CAPTURE_MARKER = 'TARO_DOM_REPLAY_POC';
/** @deprecated Use TARO_REPLAY_CAPTURE_MARKER. */
export const TARO_DOM_REPLAY_POC_MARKER = TARO_REPLAY_CAPTURE_MARKER;

const enum RrwebEventType {
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5,
}

const enum RrwebNodeType {
  Document = 0,
  Element = 2,
  Text = 3,
  Comment = 5,
}

const enum RrwebIncrementalSource {
  Mutation = 0,
  MouseInteraction = 2,
  Scroll = 3,
  ViewportResize = 4,
  Input = 5,
  TouchMove = 6,
}

interface SerializedNodeBase {
  id: number;
  type: RrwebNodeType;
}

interface SerializedDocumentNode extends SerializedNodeBase {
  type: RrwebNodeType.Document;
  childNodes: SerializedNode[];
}

interface SerializedElementNode extends SerializedNodeBase {
  type: RrwebNodeType.Element;
  tagName: string;
  attributes: Record<string, string | number | true | null>;
  childNodes: SerializedNode[];
}

interface SerializedTextNode extends SerializedNodeBase {
  type: RrwebNodeType.Text | RrwebNodeType.Comment;
  textContent: string;
}

type SerializedNode = SerializedDocumentNode | SerializedElementNode | SerializedTextNode;

const SYNTHETIC_NODE_MAX_ID = 9;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function cloneCapture(capture: TaroReplayCapture): TaroReplayCapture {
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
  const maxDurationMs = boundedInteger(
    options.maxDurationMs,
    REPLAY_MAX_DURATION_MS,
    1,
    REPLAY_MAX_DURATION_MS,
  );
  const maxEvents = boundedInteger(options.maxEvents, 500, 1, 100_000);
  const maxBytes = boundedInteger(options.maxBytes, 512 * 1024, 1, 20 * 1024 * 1024);
  const mutationLimit = boundedInteger(options.mutationLimit, 10_000, 1, 100_000);
  let rollingWindowMs =
    options.rollingWindowMs === undefined
      ? undefined
      : boundedInteger(
          options.rollingWindowMs,
          REPLAY_BUFFER_WINDOW_MS,
          0,
          REPLAY_BUFFER_WINDOW_MS,
        );
  const maskAllText = options.maskAllText !== false;
  const maskInputValues = options.maskAllInputs ?? options.maskInputValues !== false;
  const blockAllMedia = options.blockAllMedia !== false;
  const maskAttributes = new Set(
    (options.maskAttributes ?? ['title', 'placeholder', 'aria-label']).map((name) =>
      name.toLowerCase(),
    ),
  );
  let viewportWidth = boundedInteger(options.width, 375, 1, 100_000);
  let viewportHeight = boundedInteger(options.height, 667, 1, 100_000);
  let stylesheet = normalizeReplayRpx(
    `${TARO_REPLAY_BASE_STYLESHEET}\n${options.stylesheet || ''}`,
    viewportWidth,
  );

  function shouldMaskInputValues(node: TaroReplayNodeLike): boolean {
    if (!isInputNode(node)) return false;
    if (
      hasMaskingFlag(node, 'password') ||
      String(rawAttributeValue(node, 'type') ?? '').toLowerCase() === 'password' ||
      hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'mask'))
    ) {
      // A password reveal toggle must not turn this mounted input into clear text.
      sensitiveInputs.add(node);
    }
    return maskInputValues || sensitiveInputs.has(node);
  }
  const isBlocked = (node: TaroReplayNodeLike): boolean =>
    hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'block'));
  const isMasked = (node: TaroReplayNodeLike): boolean =>
    hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'mask'));
  const isUnmasked = (node: TaroReplayNodeLike): boolean =>
    hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'unmask'));
  const shouldMaskText = (node: TaroReplayNodeLike): boolean =>
    isMasked(node) || (maskAllText && !isUnmasked(node));
  const shouldBlockMedia = (node: TaroReplayNodeLike): boolean =>
    blockAllMedia && !hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'unblock'));
  const warnings = new Set<string>();
  const idsBySid = new Map<string, number>();
  const nodesBySid = new Map<string, TaroReplayNodeLike>();
  const idsByNode = new WeakMap<object, number>();
  const lastTextValues = new WeakMap<object, string>();
  const lastAttributeValues = new WeakMap<object, Map<string, string | number | true | null>>();
  const scrollListeners = new Map<TaroReplayNodeLike, (event: TaroReplayScrollEventLike) => void>();
  const pickerListeners = new Map<TaroReplayNodeLike, (event: TaroReplayScrollEventLike) => void>();
  const swiperListeners = new Map<TaroReplayNodeLike, (event: TaroReplayScrollEventLike) => void>();
  let lastEventTimestamp = startedAt - 1;
  let nextNodeId = SYNTHETIC_NODE_MAX_ID + 1;
  let stopped = false;
  let draining = false;
  let pagePosition = pageScrollPositions.get(options.root) ?? { x: 0, y: 0 };
  const rootListeners = new Map<string, (event: TaroReplayScrollEventLike) => void>();
  const lastInputValues = new WeakMap<TaroReplayNodeLike, string>();
  const byteSizes = new WeakMap<TaroReplayEvent, number>();
  const canvasFrames = new Map<
    TaroReplayNodeLike,
    { imageId: number; frame?: string; lastReadAt: number }
  >();
  let serializedNodes = new WeakSet<TaroReplayNodeLike>();
  let canvasCheckpoint: ReturnType<typeof createCheckpointRebaser<TaroReplayEvent>> | undefined;
  let canvasCheckpointUpperBytes = 0;
  const eventSize = (event: TaroReplayEvent): number => {
    const cached = byteSizes.get(event);
    if (cached !== undefined) return cached;
    const bytes = utf8ByteLength(JSON.stringify(event));
    byteSizes.set(event, bytes);
    return bytes;
  };
  const resources: {
    timer?: ReturnType<typeof setTimeout>;
    observer?: TaroReplayMutationObserverLike;
  } = {};

  const capture: TaroReplayCapture = {
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
  };

  function idFor(node: TaroReplayNodeLike): number {
    const sid = node.sid || node.uid;
    if (sid) {
      nodesBySid.set(sid, node);
      const existing = idsBySid.get(sid);
      if (existing !== undefined) {
        idsByNode.set(node, existing);
        return existing;
      }
      const id = nextNodeId++;
      idsBySid.set(sid, id);
      idsByNode.set(node, id);
      return id;
    }

    const existing = idsByNode.get(node);
    if (existing !== undefined) return existing;
    const id = nextNodeId++;
    idsByNode.set(node, id);
    return id;
  }

  function isCanvasContainer(node: TaroReplayNodeLike): boolean {
    const marker = rawAttributeValue(node, 'data-sentry-canvas');
    return (
      options.recordCanvas === true &&
      ['canvas', 'view'].includes(normaliseNodeName(node)) &&
      (marker === true || marker === 'true')
    );
  }

  function isCanvasProtected(node: TaroReplayNodeLike): boolean {
    return (
      isMasked(node) ||
      isBlocked(node) ||
      hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'ignore'))
    );
  }

  function isInsideCanvas(node: TaroReplayNodeLike): boolean {
    return Boolean(node.parentNode && hasNodeAncestor(node.parentNode, isCanvasContainer));
  }

  function isInCurrentRoot(node: TaroReplayNodeLike): boolean {
    const visited = new Set<TaroReplayNodeLike>();
    let current = node;
    while (current !== options.root) {
      if (visited.has(current)) return false;
      visited.add(current);
      const parent = current.parentNode;
      if (!parent || !toArray(parent.childNodes).includes(current)) return false;
      current = parent;
    }
    return true;
  }

  function canRecordCanvas(node: TaroReplayNodeLike): boolean {
    return (
      !stopped &&
      isCanvasContainer(node) &&
      serializedNodes.has(node) &&
      isInCurrentRoot(node) &&
      !isCanvasProtected(node)
    );
  }

  function recordCanvas(node: TaroReplayNodeLike, readFrame: () => string | undefined): boolean {
    if (!canRecordCanvas(node)) {
      const previous = canvasFrames.get(node);
      if (previous) delete previous.frame;
      return false;
    }
    const state = canvasFrames.get(node);
    if (!state) return false;
    const readAt = now();
    if (readAt - state.lastReadAt < CANVAS_FRAME_INTERVAL_MS) return false;
    state.lastReadAt = readAt;
    let frame: string | undefined;
    try {
      frame = readFrame();
    } catch {
      return false;
    }
    if (!canRecordCanvas(node) || canvasFrames.get(node) !== state) {
      delete state.frame;
      return false;
    }
    if (!isCanvasFrame(frame) || frame === state.frame) return false;
    const event: TaroReplayEvent = {
      type: RrwebEventType.IncrementalSnapshot,
      timestamp: nextTimestamp(),
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
      canvasCheckpoint && createCheckpointRebaser(canvasCheckpoint.getSnapshot());
    futureCheckpoint?.apply(event);
    const metaBytes = utf8ByteLength(
      JSON.stringify({
        type: RrwebEventType.Meta,
        timestamp: event.timestamp - 1,
        data: { href: capture.href, width: viewportWidth, height: viewportHeight },
      }),
    );
    if (
      retainedBytes > Math.min(MAX_CANVAS_FRAME_BYTES, Math.floor(maxBytes / 4)) ||
      !futureCheckpoint ||
      utf8ByteLength(JSON.stringify(futureCheckpoint.getSnapshot())) + metaBytes > maxBytes ||
      !makeEventRoom(eventSize(event))
    ) {
      warnings.add('Canvas frame skipped: recording budget exceeded');
      capture.warnings = Array.from(warnings);
      return false;
    }
    state.frame = frame;
    try {
      addEvent(event);
    } catch {
      // User onEvent callbacks must not interrupt the chart's render callback.
    }
    // A rolling buffer may fold the event straight into its baseline.
    return !stopped;
  }

  function updateCanvasCheckpoint(event: TaroReplayEvent, bytes: number): void {
    if (!options.recordCanvas) return;
    if (event.type === RrwebEventType.FullSnapshot) {
      canvasCheckpoint = createCheckpointRebaser(event);
      canvasCheckpointUpperBytes = bytes;
    } else if (
      canvasCheckpoint &&
      event.type === RrwebEventType.IncrementalSnapshot &&
      [
        RrwebIncrementalSource.Mutation,
        RrwebIncrementalSource.Scroll,
        RrwebIncrementalSource.Input,
      ].includes(event.data['source'] as number)
    ) {
      canvasCheckpoint.apply(event);
      canvasCheckpointUpperBytes += bytes;
      if (canvasCheckpointUpperBytes > maxBytes) {
        canvasCheckpointUpperBytes = utf8ByteLength(JSON.stringify(canvasCheckpoint.getSnapshot()));
        // Bound the optional mirror even across repeatedly drained sessions.
        // A later normal FullSnapshot can make Canvas capture eligible again.
        if (canvasCheckpointUpperBytes > maxBytes) canvasCheckpoint = undefined;
      }
    }
  }

  function attachScrollSubtree(node: TaroReplayNodeLike): void {
    if (stopped || isBlocked(node) || isCanvasContainer(node) || isInsideCanvas(node)) return;
    if (
      isSwiper(node) &&
      node.addEventListener &&
      node.removeEventListener &&
      !swiperListeners.has(node)
    ) {
      const listener = (event: TaroReplayScrollEventLike): void => {
        if (
          stopped ||
          isBlocked(node) ||
          swiperListeners.get(node) !== listener ||
          event.detail?.current === undefined
        )
          return;
        const selected = swiperIndex(node, event.detail.current);
        if (selected === currentSwiperIndex(node)) return;
        swiperValues.set(node, { value: selected, propValue: rawAttributeValue(node, 'current') });
        addEvent({
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(),
          data: {
            source: RrwebIncrementalSource.Mutation,
            texts: [],
            removes: [],
            adds: [],
            attributes: [
              { id: idFor(node), attributes: { style: currentAttributeValue(node, 'style') } },
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
        if (stopped || isBlocked(node) || scrollListeners.get(node) !== listener) return;
        const previous = getScrollPosition(node);
        const position = {
          x: scrollCoordinate(event.detail?.scrollLeft) ?? previous.x,
          y: scrollCoordinate(event.detail?.scrollTop) ?? previous.y,
        };
        if (position.x === previous.x && position.y === previous.y) return;
        scrollPositions.set(node, position);
        addEvent({
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(),
          data: { source: RrwebIncrementalSource.Scroll, id: idFor(node), ...position },
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
          stopped ||
          isBlocked(node) ||
          pickerListeners.get(node) !== listener ||
          !Array.isArray(event.detail?.value)
        )
          return;
        const previous = getPickerValues(node);
        const selected = normalisePickerValues(node, event.detail.value);
        if (selected.every((value, index) => value === previous[index])) return;
        pickerValues.set(node, selected);
        addEvent({
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(),
          data: {
            source: RrwebIncrementalSource.Mutation,
            texts: [],
            removes: [],
            adds: [],
            attributes: pickerColumns(node).map((column) => ({
              id: idFor(column),
              attributes: readAttributes(column),
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
    for (const child of toArray(node.childNodes)) attachScrollSubtree(child);
  }

  function detachScrollSubtree(node: TaroReplayNodeLike): void {
    const swiperListener = swiperListeners.get(node);
    if (swiperListener) {
      try {
        node.removeEventListener?.('change', swiperListener);
      } catch {
        /* Safe native teardown. */
      }
      swiperListeners.delete(node);
    }
    canvasFrames.delete(node);
    serializedNodes.delete(node);
    const sid = node.sid || node.uid;
    if (sid && nodesBySid.get(sid) === node) {
      nodesBySid.delete(sid);
      idsBySid.delete(sid);
    }
    const listener = scrollListeners.get(node);
    if (listener) {
      try {
        node.removeEventListener?.('scroll', listener);
      } catch {
        // Preserve native lifecycle behavior if a platform cannot remove a listener.
      }
      scrollListeners.delete(node);
    }
    const pickerListener = pickerListeners.get(node);
    if (pickerListener) {
      try {
        node.removeEventListener?.('change', pickerListener);
      } catch {
        // Keep recorder teardown separate from application event handlers.
      }
      pickerListeners.delete(node);
    }
    for (const child of toArray(node.childNodes)) detachScrollSubtree(child);
  }

  function replayAttributeValue(
    node: TaroReplayNodeLike,
    name: string,
    value: unknown,
    maskNodeInputValues: boolean,
  ): string | number | true | null {
    if (value === null || value === undefined) return null;
    if (/^on/i.test(name)) return null;
    const lowerName = name.toLowerCase();
    // Taro Image has one src, not a browser srcset. Never bypass its media policy with unknown candidates.
    if (lowerName === 'srcset') return null;
    if (lowerName.endsWith('style') && typeof value === 'string') {
      return sanitizeReplayStyle(value, sanitizeUrl, shouldBlockMedia(node));
    }
    if (
      (isMasked(node) && ['title', 'placeholder', 'aria-label', 'alt'].includes(lowerName)) ||
      (maskAttributes.has(lowerName) && !isUnmasked(node))
    )
      return maskValue(value);
    if (
      normaliseNodeName(node) === 'image' &&
      name.toLowerCase() === 'src' &&
      typeof value === 'string'
    ) {
      const sources = options.staticImageSources;
      const trusted =
        sources && Object.prototype.hasOwnProperty.call(sources, value)
          ? sources[value]
          : undefined;
      if (
        typeof trusted === 'string' &&
        trusted.length <= MAX_STATIC_IMAGE_SOURCE_BYTES &&
        isStaticImageDataUri(trusted)
      )
        return trusted;
      if (shouldBlockMedia(node)) return null;
    }
    if (
      MEDIA_NODE_NAMES.has(normaliseNodeName(node)) &&
      shouldBlockMedia(node) &&
      URL_ATTRIBUTE_NAMES.has(lowerName)
    )
      return null;
    return sanitizeAttributeValue(node, name, value, maskNodeInputValues);
  }

  function currentInputValue(node: TaroReplayNodeLike): unknown {
    const propValue = rawAttributeValue(node, 'value');
    const observed = inputValues.get(node);
    return observed && observed.propValue === propValue ? observed.value : propValue;
  }

  function safeInputValue(node: TaroReplayNodeLike, value: unknown): string {
    return shouldMaskInputValues(node) ? maskValue(value) : String(value ?? '');
  }

  function swiperPlaybackStyle(node: TaroReplayNodeLike, original: unknown): string {
    const declaration = isSwiper(node)
      ? `--taro-replay-swiper-current:${currentSwiperIndex(node)}`
      : `--taro-replay-swiper-index:${swiperItems(node.parentNode!).indexOf(node)}`;
    return [typeof original === 'string' ? original : '', declaration].filter(Boolean).join(';');
  }

  function pickerPlaybackStyle(node: TaroReplayNodeLike, original: unknown): string {
    const declarations = [typeof original === 'string' ? original : ''];
    if (isPickerView(node)) {
      const indicator = sanitizeReplayStyle(
        String(rawAttributeValue(node, 'indicatorstyle') ?? ''),
        sanitizeUrl,
        shouldBlockMedia(node),
      );
      const height = /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(indicator)?.[1] ?? '34px';
      declarations.push(
        `--taro-replay-picker-item-height:${normalizeReplayRpx(height, viewportWidth)}`,
      );
    } else if (
      normaliseNodeName(node) === 'picker-view-column' &&
      node.parentNode &&
      isPickerView(node.parentNode)
    ) {
      const index = pickerColumns(node.parentNode).indexOf(node);
      declarations.push(
        `--taro-replay-picker-selected:${getPickerValues(node.parentNode)[index] ?? 0}`,
      );
    } else if (node.parentNode && normaliseNodeName(node.parentNode) === 'picker-view-column') {
      declarations.push(`--taro-replay-picker-row:${pickerRows(node.parentNode).indexOf(node)}`);
    }
    return declarations.filter(Boolean).join(';');
  }

  function readAttributes(node: TaroReplayNodeLike): Record<string, string | number | true | null> {
    const result: Record<string, string | number | true | null> = {
      'data-taro-node': normaliseNodeName(node),
    };
    const remembered = new Map<string, string | number | true | null>();
    const maskNodeInputValues = shouldMaskInputValues(node);

    for (const attribute of toArray(node.attributes)) {
      if (!attribute || !attribute.name || /^on/i.test(attribute.name)) continue;
      let value = replayAttributeValue(node, attribute.name, attribute.value, maskNodeInputValues);
      if (attribute.name === 'style' && typeof value === 'string') {
        value = normalizeReplayRpx(value, viewportWidth);
      }
      const playbackName = attribute.name === 'className' ? 'class' : attribute.name;
      result[playbackName] = value;
      remembered.set(attribute.name, value);
    }
    if (isInputNode(node)) {
      result['value'] = safeInputValue(node, currentInputValue(node));
      remembered.set('value', result['value']);
      lastInputValues.set(node, String(result['value']));
    }
    if (
      isSwiper(node) ||
      (normaliseNodeName(node) === 'swiper-item' && node.parentNode && isSwiper(node.parentNode))
    ) {
      result['style'] = swiperPlaybackStyle(node, result['style']);
    }
    if (isScrollView(node)) {
      const position = getScrollPosition(node);
      result['rr_scrollTop'] = position.y;
      result['rr_scrollLeft'] = position.x;
    }
    if (
      isPickerView(node) ||
      normaliseNodeName(node) === 'picker-view-column' ||
      normaliseNodeName(node.parentNode ?? node) === 'picker-view-column'
    ) {
      result['style'] = pickerPlaybackStyle(node, result['style']);
      if (normaliseNodeName(node.parentNode ?? node) === 'picker-view-column')
        result['data-taro-picker-row'] = true;
    }
    lastAttributeValues.set(node, remembered);

    return result;
  }

  function serializeChildren(
    node: TaroReplayNodeLike,
    portals?: SerializedElementNode[],
  ): SerializedNode[] {
    const children: SerializedNode[] = [];
    for (const child of toArray(node.childNodes)) {
      const serialized = serializeNode(child, portals);
      if (portals && portalEnabled(child)) portals.push(serialized as SerializedElementNode);
      else children.push(serialized);
    }
    return children;
  }

  function serializeNode(
    node: TaroReplayNodeLike,
    portals?: SerializedElementNode[],
  ): SerializedNode {
    serializedNodes.add(node);
    const nodeName = normaliseNodeName(node);
    if (isBlocked(node)) {
      return {
        id: idFor(node),
        type: RrwebNodeType.Element,
        tagName: 'div',
        attributes: { 'data-taro-node': nodeName, 'data-sentry-blocked': true },
        childNodes: [],
      };
    }
    if (node.nodeType === 3 || nodeName === '#text' || nodeName === 'comment') {
      const comment = nodeName === 'comment';
      const textContent = shouldMaskText(node)
        ? maskValue(node.textContent)
        : String(node.textContent ?? '');
      lastTextValues.set(node, textContent);
      return {
        id: idFor(node),
        type: comment ? RrwebNodeType.Comment : RrwebNodeType.Text,
        textContent,
      };
    }

    const tagName = TAG_MAP[nodeName] || 'div';
    if (!TAG_MAP[nodeName] && !isCanvasContainer(node))
      warnings.add(`unsupported Taro node rendered as placeholder: ${nodeName}`);
    const attributes = readAttributes(node);
    if (isCanvasContainer(node)) {
      let state = canvasFrames.get(node);
      if (!state) {
        state = { imageId: nextNodeId++, lastReadAt: -Infinity };
        canvasFrames.set(node, state);
      }
      if (isCanvasProtected(node)) delete state.frame;
      return {
        id: idFor(node),
        type: RrwebNodeType.Element,
        tagName: 'div',
        attributes,
        childNodes: [
          {
            id: state.imageId,
            type: RrwebNodeType.Element,
            tagName: 'img',
            attributes: {
              'data-sentry-canvas-frame': true,
              style: 'display:block;width:100%;height:100%;object-fit:fill;pointer-events:none',
              ...(state.frame ? { src: state.frame } : {}),
            },
            childNodes: [],
          },
        ],
      };
    }
    if (!TAG_MAP[nodeName]) attributes['data-taro-unsupported'] = nodeName;

    return {
      id: idFor(node),
      type: RrwebNodeType.Element,
      tagName,
      attributes,
      childNodes: SELF_CLOSING_TAGS.has(tagName) ? [] : serializeChildren(node, portals),
    };
  }

  function fullSnapshot(): SerializedDocumentNode {
    serializedNodes = new WeakSet();
    const styleText: SerializedTextNode = {
      id: 6,
      type: RrwebNodeType.Text,
      textContent: stylesheet,
    };
    const style: SerializedElementNode = {
      id: 5,
      type: RrwebNodeType.Element,
      tagName: 'style',
      attributes: {},
      childNodes: [styleText],
    };
    const head: SerializedElementNode = {
      id: 3,
      type: RrwebNodeType.Element,
      tagName: 'head',
      attributes: {},
      childNodes: [style],
    };
    const portals: SerializedElementNode[] = [];
    const root = serializeNode(options.root, portals);
    for (const node of canvasFrames.keys()) {
      if (!serializedNodes.has(node) || !isCanvasContainer(node)) canvasFrames.delete(node);
    }
    const body: SerializedElementNode = {
      id: 4,
      type: RrwebNodeType.Element,
      tagName: 'body',
      attributes: {},
      childNodes: [root, ...portals],
    };
    const html: SerializedElementNode = {
      id: 2,
      type: RrwebNodeType.Element,
      tagName: 'html',
      attributes: {},
      childNodes: [head, body],
    };
    return {
      id: 1,
      type: RrwebNodeType.Document,
      childNodes: [html],
    };
  }

  function makeEventRoom(eventBytes: number): boolean {
    const fits = (): boolean =>
      capture.events.length < maxEvents && capture.stats.approximateBytes + eventBytes <= maxBytes;
    if (
      !fits() &&
      rollingWindowMs === undefined &&
      resources.observer &&
      eventBytes <= maxBytes &&
      capture.events.length &&
      !draining &&
      options.onBufferFull
    ) {
      draining = true;
      try {
        options.onBufferFull();
      } catch {
        // A failed upload scheduler must not break the application's observer callback.
        warnings.add('Session buffer drain failed');
        // The hook may already have detached the prefix before its queue rejects it.
        // Never continue with increments whose delivery baseline is now uncertain.
        stop('buffer-drain');
      } finally {
        draining = false;
      }
    }
    return !stopped && fits();
  }

  function notifyBufferChange(): void {
    options.onBufferChange?.({
      eventCount: capture.stats.eventCount,
      approximateBytes: capture.stats.approximateBytes,
    });
  }

  function addEvent(event: TaroReplayEvent): boolean {
    if (stopped) return false;
    const eventBytes = eventSize(event);
    if (rollingWindowMs !== undefined) {
      const meta = capture.events[0];
      if (event.type === RrwebEventType.FullSnapshot && meta?.type === RrwebEventType.Meta) {
        const alignedMeta = {
          ...meta,
          timestamp: event.timestamp - 1,
          data: { ...meta.data, width: viewportWidth, height: viewportHeight },
        };
        const checkpointBytes = utf8ByteLength(JSON.stringify(alignedMeta)) + eventBytes;
        if (checkpointBytes > maxBytes || maxEvents < 2) {
          stop('limit');
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
          updateCanvasCheckpoint(event, eventBytes);
          notifyBufferChange();
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
          windowMs: rollingWindowMs,
          maxEvents,
          maxBytes,
          eventBytes: eventSize,
        });
        if (!bounded.length) {
          capture.events = previousEvents;
          capture.stats = previousStats;
          stop('limit');
          return false;
        }
        capture.events = bounded;
        capture.startedAt = bounded[0]?.timestamp ?? capture.startedAt;
        capture.stats.approximateBytes = bounded.reduce(
          (total, candidate) => total + eventSize(candidate),
          0,
        );
      }
      capture.stats.eventCount = capture.events.length;
      updateCanvasCheckpoint(event, eventBytes);
      notifyBufferChange();
      options.onEvent?.(JSON.parse(JSON.stringify(event)) as TaroReplayEvent);
      return capture.events.includes(event);
    }
    if (!makeEventRoom(eventBytes)) {
      stop('limit');
      return false;
    }

    capture.events.push(event);
    capture.stats.eventCount = capture.events.length;
    capture.stats.approximateBytes += eventBytes;
    updateCanvasCheckpoint(event, eventBytes);
    notifyBufferChange();
    options.onEvent?.(JSON.parse(JSON.stringify(event)) as TaroReplayEvent);
    return true;
  }

  function nextTimestamp(candidate = now()): number {
    lastEventTimestamp = Math.max(candidate, lastEventTimestamp + 1);
    return lastEventTimestamp;
  }

  function breadcrumbTimestampMs(breadcrumb: Breadcrumb): number {
    const timestamp = breadcrumb.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return now();
    return timestamp > 9_999_999_999 ? timestamp : timestamp * 1_000;
  }

  function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  function networkRequestOrResponse(
    size: unknown,
    headers: unknown,
    allowed: boolean,
    direction: 'request' | 'response',
  ): Record<string, unknown> {
    const byteSize = finiteNumber(size);
    return {
      headers: allowed ? networkHeaderPolicy.filterHeaders(headers, direction) : {},
      ...(byteSize === undefined ? {} : { size: byteSize }),
      _meta: { warnings: allowed ? [] : ['URL_SKIPPED'] },
    };
  }

  function addBreadcrumb(breadcrumb: Breadcrumb): boolean {
    if (stopped || !breadcrumb || typeof breadcrumb.category !== 'string') return false;

    const timestampMs = breadcrumbTimestampMs(breadcrumb);
    const data = breadcrumb.data || {};
    const isNetwork =
      (breadcrumb.category === 'xhr' || breadcrumb.category === 'fetch') &&
      typeof data['url'] === 'string';
    let event: TaroReplayEvent;

    if (isNetwork) {
      const allowed = networkHeaderPolicy.isAllowed(data['url']);
      const endTimestamp = timestampMs / 1_000;
      const duration = finiteNumber(data['duration']) ?? 0;
      event = {
        type: RrwebEventType.Custom,
        timestamp: nextTimestamp(timestampMs),
        data: {
          tag: 'performanceSpan',
          payload: {
            op: `resource.${breadcrumb.category}`,
            description: sanitizeUrl(data['url'] as string),
            startTimestamp: Math.max(0, endTimestamp - duration / 1_000),
            endTimestamp,
            data: {
              method: typeof data['method'] === 'string' ? data['method'] : 'GET',
              statusCode: finiteNumber(data['status_code']) ?? 0,
              request: networkRequestOrResponse(
                data['request_body_size'] ?? data['request_size'],
                allowed ? readNetworkDataField(data, 'request_headers') : undefined,
                allowed,
                'request',
              ),
              response: networkRequestOrResponse(
                data['response_body_size'] ?? data['response_size'],
                allowed ? readNetworkDataField(data, 'response_headers') : undefined,
                allowed,
                'response',
              ),
            },
          },
        },
      };
    } else {
      event = {
        type: RrwebEventType.Custom,
        timestamp: nextTimestamp(timestampMs),
        data: {
          tag: 'breadcrumb',
          payload: {
            ...breadcrumb,
            timestamp: timestampMs / 1_000,
          },
        },
      };
    }

    if (!addEvent(event)) return false;
    if (isNetwork) capture.stats.networkCount++;
    else capture.stats.breadcrumbCount++;
    return true;
  }

  function recordPageScroll(position: { scrollTop?: number; scrollLeft?: number }): boolean {
    if (stopped) return false;
    const next = {
      x: scrollCoordinate(position.scrollLeft) ?? pagePosition.x,
      y: scrollCoordinate(position.scrollTop) ?? pagePosition.y,
    };
    if (next.x === pagePosition.x && next.y === pagePosition.y) return false;
    pagePosition = next;
    pageScrollPositions.set(options.root, next);
    return addEvent({
      type: RrwebEventType.IncrementalSnapshot,
      timestamp: nextTimestamp(),
      data: { source: RrwebIncrementalSource.Scroll, id: 1, ...next },
    });
  }

  function recordViewport(size: { width: number; height: number }): boolean {
    if (
      stopped ||
      !Number.isFinite(size.width) ||
      size.width <= 0 ||
      !Number.isFinite(size.height) ||
      size.height <= 0 ||
      (size.width === viewportWidth && size.height === viewportHeight)
    )
      return false;
    viewportWidth = size.width;
    viewportHeight = size.height;
    stylesheet = normalizeReplayRpx(
      `${TARO_REPLAY_BASE_STYLESHEET}\n${options.stylesheet || ''}`,
      viewportWidth,
    );
    if (
      !addEvent({
        type: RrwebEventType.IncrementalSnapshot,
        timestamp: nextTimestamp(),
        data: {
          source: RrwebIncrementalSource.ViewportResize,
          width: viewportWidth,
          height: viewportHeight,
        },
      })
    )
      return false;
    return addEvent({
      type: RrwebEventType.FullSnapshot,
      timestamp: nextTimestamp(),
      data: { node: fullSnapshot(), initialOffset: { top: pagePosition.y, left: pagePosition.x } },
    });
  }

  function takeSegment(): TaroReplayCapture {
    const segment = cloneCapture(capture);
    if (stopped || rollingWindowMs !== undefined) return segment;
    segment.endedAt = Math.max(now(), lastEventTimestamp);
    segment.stopReason = 'segment';
    clearSegment(segment.endedAt);
    return segment;
  }

  function clearSegment(start: number): void {
    capture.startedAt = start;
    capture.events = [];
    capture.stats = {
      eventCount: 0,
      mutationCount: 0,
      breadcrumbCount: 0,
      networkCount: 0,
      approximateBytes: 0,
    };
    notifyBufferChange();
  }

  function promoteToSession(durationMs: number): boolean {
    if (stopped || rollingWindowMs === undefined) return false;
    rollingWindowMs = undefined;
    clearSegment(Math.max(now(), lastEventTimestamp));
    if (resources.timer) clearTimeout(resources.timer);
    resources.timer = setTimeout(
      () => stop('duration'),
      boundedInteger(durationMs, maxDurationMs, 1, REPLAY_MAX_DURATION_MS),
    );
    return true;
  }

  function attachInteractions(): void {
    const root = options.root;
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
        if (stopped) return;
        const target = event.target;
        const sid = target?.dataset?.sid ?? target?.sid ?? target?.id;
        const node = target?.nodeType
          ? (target as TaroReplayNodeLike)
          : sid
            ? nodesBySid.get(sid)
            : undefined;
        if (
          !node ||
          !idsByNode.has(node) ||
          !serializedNodes.has(node) ||
          isInsideCanvas(node) ||
          isBlocked(node) ||
          hasNodeAncestor(node, (ancestor) => privacyMarker(ancestor, 'ignore'))
        )
          return;
        if (name === 'input' || name === 'change') {
          if (!isInputNode(node) || event.detail?.value === undefined) return;
          const value = event.detail.value;
          // A native value may precede its controlled prop update. Never write application props.
          inputValues.set(node, { value, propValue: rawAttributeValue(node, 'value') });
          const text = safeInputValue(node, value);
          if (lastInputValues.get(node) === text) return;
          lastInputValues.set(node, text);
          lastAttributeValues.get(node)?.set('value', text);
          addEvent({
            type: RrwebEventType.IncrementalSnapshot,
            timestamp: nextTimestamp(),
            data: { source: RrwebIncrementalSource.Input, id: idFor(node), text, isChecked: false },
          });
          return;
        }
        const touch = event.changedTouches?.[0] ?? event.touches?.[0];
        const x =
          touch?.clientX ??
          (typeof touch?.pageX === 'number' ? touch.pageX - pagePosition.x : undefined);
        const y =
          touch?.clientY ??
          (typeof touch?.pageY === 'number' ? touch.pageY - pagePosition.y : undefined);
        if (name === 'touchmove') {
          if (!Number.isFinite(x) || !Number.isFinite(y) || now() - lastTouchMoveAt < 50) return;
          lastTouchMoveAt = now();
          addEvent({
            type: RrwebEventType.IncrementalSnapshot,
            timestamp: nextTimestamp(),
            data: {
              source: RrwebIncrementalSource.TouchMove,
              positions: [{ id: idFor(node), x, y, timeOffset: 0 }],
            },
          });
          return;
        }
        // Focus/blur do not need coordinates. Other interactions use only real platform coordinates.
        if (name !== 'focus' && name !== 'blur' && (!Number.isFinite(x) || !Number.isFinite(y)))
          return;
        addEvent({
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(),
          data: {
            source: RrwebIncrementalSource.MouseInteraction,
            type: interactions[name],
            id: idFor(node),
            ...(typeof x === 'number' && typeof y === 'number' ? { x, y } : {}),
          },
        });
        if (name === 'tap')
          addBreadcrumb({
            category: 'ui.click',
            message: normaliseNodeName(node),
            data: { nodeId: idFor(node) },
          });
      };
      try {
        root.addEventListener(name, listener);
        rootListeners.set(name, listener);
      } catch {
        /* Unsupported native events are optional. */
      }
    }
  }

  function currentAttributeValue(
    node: TaroReplayNodeLike,
    attributeName: string,
  ): string | number | true | null {
    // Taro keeps inline styles in Style.cssText rather than Element.props, so
    // hasAttribute('style') is false even while getAttribute('style') is valid.
    if (attributeName !== 'style' && node.hasAttribute && !node.hasAttribute(attributeName)) {
      return null;
    }
    const raw = node.getAttribute
      ? node.getAttribute(attributeName)
      : rawAttributeValue(node, attributeName);
    if (
      attributeName === 'style' &&
      (isSwiper(node) ||
        (normaliseNodeName(node) === 'swiper-item' && node.parentNode && isSwiper(node.parentNode)))
    ) {
      return swiperPlaybackStyle(
        node,
        normalizeReplayRpx(
          sanitizeReplayStyle(String(raw ?? ''), sanitizeUrl, shouldBlockMedia(node)),
          viewportWidth,
        ),
      );
    }
    if (
      attributeName === 'style' &&
      (isPickerView(node) ||
        normaliseNodeName(node) === 'picker-view-column' ||
        normaliseNodeName(node.parentNode ?? node) === 'picker-view-column')
    ) {
      return pickerPlaybackStyle(
        node,
        normalizeReplayRpx(
          sanitizeReplayStyle(String(raw ?? ''), sanitizeUrl, shouldBlockMedia(node)),
          viewportWidth,
        ),
      );
    }
    if (attributeName === 'style' && (raw === null || raw === undefined || raw === '')) return null;
    const value = replayAttributeValue(node, attributeName, raw, shouldMaskInputValues(node));
    return attributeName === 'style' && typeof value === 'string'
      ? normalizeReplayRpx(value, viewportWidth)
      : value;
  }

  function handleMutations(records: TaroReplayMutationRecordLike[]): void {
    if (stopped) return;
    if (records.length > mutationLimit) {
      stop('mutation-limit');
      return;
    }
    records = records.filter(
      (record) =>
        !isInsideCanvas(record.target) &&
        !(record.type === 'childList' && isCanvasContainer(record.target)),
    );
    if (!records.length) return;
    let batchMutationCount = 0;
    for (const [node, state] of canvasFrames) {
      if (
        !isCanvasContainer(node) ||
        isCanvasProtected(node) ||
        !isInCurrentRoot(node) ||
        records.some(
          (record) =>
            record.type === 'attributes' &&
            (/^data-sentry-(?:canvas|mask|block|ignore)$/i.test(record.attributeName ?? '') ||
              (/^(?:class|classname)$/i.test(record.attributeName ?? '') &&
                /sentry-(?:mask|block|ignore)/.test(
                  String(rawAttributeValue(record.target, record.attributeName!) ?? '') +
                    String(
                      lastAttributeValues.get(record.target)?.get(record.attributeName!) ?? '',
                    ),
                ))) &&
            hasNodeAncestor(node, (ancestor) => ancestor === record.target),
        )
      )
        delete state.frame;
    }
    const visualCheckpoint = records.some(
      (record) =>
        (record.type === 'attributes' &&
          ((isRootPortal(record.target) && record.attributeName?.toLowerCase() === 'enable') ||
            // An ancestor marker changes descendant privacy without an input mutation.
            ['data-sentry-unmask', 'data-sentry-block', 'data-sentry-unblock'].includes(
              record.attributeName?.toLowerCase() ?? '',
            ) ||
            (options.recordCanvas === true &&
              ['data-sentry-canvas', 'data-sentry-ignore'].includes(
                record.attributeName?.toLowerCase() ?? '',
              )) ||
            (record.attributeName?.toLowerCase() === 'data-sentry-mask' &&
              !isInputNode(record.target)) ||
            (['class', 'classname'].includes(record.attributeName?.toLowerCase() ?? '') &&
              /sentry-(?:mask|unmask|block|unblock|ignore)/.test(
                String(rawAttributeValue(record.target, record.attributeName!) ?? '') +
                  String(lastAttributeValues.get(record.target)?.get(record.attributeName!) ?? ''),
              )) ||
            (isSwiper(record.target) && record.attributeName?.toLowerCase() === 'current') ||
            (isPickerView(record.target) &&
              ['value', 'defaultvalue', 'indicatorstyle'].includes(
                record.attributeName?.toLowerCase() ?? '',
              )))) ||
        (record.type === 'childList' &&
          (hasNodeAncestor(record.target, isRootPortal) ||
            hasNodeAncestor(record.target, isPickerView) ||
            isSwiper(record.target) ||
            [...toArray(record.addedNodes), ...toArray(record.removedNodes)].some(
              containsRootPortal,
            ))),
    );
    if (visualCheckpoint) {
      for (const node of [
        ...scrollListeners.keys(),
        ...pickerListeners.keys(),
        ...swiperListeners.keys(),
      ]) {
        if (isBlocked(node) || isInsideCanvas(node)) detachScrollSubtree(node);
      }
      for (const record of records) {
        batchMutationCount++;
        if (
          record.type === 'attributes' &&
          isSwiper(record.target) &&
          record.attributeName?.toLowerCase() === 'current'
        )
          swiperValues.delete(record.target);
        if (record.type === 'childList') {
          for (const node of toArray(record.removedNodes)) detachScrollSubtree(node);
          for (const node of toArray(record.addedNodes)) attachScrollSubtree(node);
        } else if (
          record.type === 'attributes' &&
          isPickerView(record.target) &&
          ['value', 'defaultvalue'].includes(record.attributeName?.toLowerCase() ?? '')
        ) {
          pickerValues.delete(record.target);
        }
      }
      addEvent({
        type: RrwebEventType.FullSnapshot,
        timestamp: nextTimestamp(),
        data: {
          node: fullSnapshot(),
          initialOffset: { top: pagePosition.y, left: pagePosition.x },
        },
      });
      attachScrollSubtree(options.root);
      if (!stopped) capture.stats.mutationCount += batchMutationCount;
      capture.warnings = Array.from(warnings);
      return;
    }
    const texts: Array<{ id: number; value: string }> = [];
    const attributes: Array<{
      id: number;
      attributes: Record<string, string | number | true | null>;
    }> = [];
    const removes: Array<{ parentId: number; id: number }> = [];
    const adds: Array<{ parentId: number; nextId: number | null; node: SerializedNode }> = [];
    const inputs: Array<{ id: number; text: string }> = [];
    const addedNodes = new Set<TaroReplayNodeLike>();
    const removedIds = new Set<string>();

    for (const record of records) {
      if (isBlocked(record.target)) continue;
      batchMutationCount++;
      if (record.type === 'characterData') {
        const value = shouldMaskText(record.target)
          ? maskValue(record.target.textContent)
          : String(record.target.textContent ?? '');
        if (lastTextValues.get(record.target) === value) continue;
        lastTextValues.set(record.target, value);
        texts.push({
          id: idFor(record.target),
          value,
        });
      } else if (record.type === 'attributes' && record.attributeName) {
        const value = currentAttributeValue(record.target, record.attributeName);
        let remembered = lastAttributeValues.get(record.target);
        if (!remembered) {
          remembered = new Map<string, string | number | true | null>();
          lastAttributeValues.set(record.target, remembered);
        }
        const changedAttributes: Record<string, string | number | true | null> = {};
        if (
          !remembered.has(record.attributeName) ||
          remembered.get(record.attributeName) !== value
        ) {
          remembered.set(record.attributeName, value);
          const playbackName =
            record.attributeName === 'className' ? 'class' : record.attributeName;
          changedAttributes[playbackName] = value;
        }
        if (
          isInputNode(record.target) &&
          INPUT_MASK_ATTRIBUTE_NAMES.has(record.attributeName.toLowerCase())
        ) {
          // Changing an input into a password can require masking its existing value,
          // even when Taro does not emit a separate value mutation.
          const inputValue = currentAttributeValue(record.target, 'value');
          if (!remembered.has('value') || remembered.get('value') !== inputValue) {
            remembered.set('value', inputValue);
            changedAttributes['value'] = inputValue;
          }
        }
        if (!Object.keys(changedAttributes).length) continue;
        attributes.push({ id: idFor(record.target), attributes: changedAttributes });
        if (
          isInputNode(record.target) &&
          Object.prototype.hasOwnProperty.call(changedAttributes, 'value')
        ) {
          const text = String(changedAttributes['value'] ?? '');
          if (lastInputValues.get(record.target) !== text) {
            lastInputValues.set(record.target, text);
            inputs.push({ id: idFor(record.target), text });
          }
        }
      } else if (record.type === 'childList') {
        const parentId = idsByNode.get(record.target);
        for (const removedNode of toArray(record.removedNodes)) {
          const id = idsByNode.get(removedNode);
          const key = `${parentId}:${id}`;
          // A node added and removed within this batch was never in the mirror.
          if (
            parentId !== undefined &&
            id !== undefined &&
            serializedNodes.has(removedNode) &&
            !removedIds.has(key)
          ) {
            removes.push({ parentId, id });
            removedIds.add(key);
          }
          // A same-batch move keeps the existing mirror ID and native listeners.
          if (!isInCurrentRoot(removedNode)) detachScrollSubtree(removedNode);
        }
        for (const addedNode of toArray(record.addedNodes)) addedNodes.add(addedNode);
      }
    }

    const parents = new Set<TaroReplayNodeLike>();
    const addSubtree = (node: SerializedNode, parentId: number, nextId: number | null): void => {
      const children = 'childNodes' in node ? node.childNodes : [];
      // rrweb rebuilds incremental additions with skipChild:true. Each descendant
      // therefore needs its own add, including synthetic Canvas image nodes.
      adds.push({
        parentId,
        nextId,
        node: 'childNodes' in node ? { ...node, childNodes: [] } : node,
      });
      for (let index = children.length - 1; index >= 0; index--)
        addSubtree(children[index]!, node.id, children[index + 1]?.id ?? null);
    };
    for (const node of addedNodes) {
      const parent = node.parentNode;
      if (
        !parent ||
        !isInCurrentRoot(node) ||
        isBlocked(parent) ||
        isInsideCanvas(node) ||
        hasNodeAncestor(parent, (ancestor) => addedNodes.has(ancestor))
      ) {
        continue;
      }
      parents.add(parent);
    }
    for (const parent of parents) {
      const children = toArray(parent.childNodes);
      // Use final sibling order, not stale MutationRecord.nextSibling. Emit the
      // right sibling first so every nextId exists when rrweb applies the add.
      for (let index = children.length - 1; index >= 0; index--) {
        const node = children[index]!;
        if (!addedNodes.has(node)) continue;
        const next = children[index + 1];
        addSubtree(serializeNode(node), idFor(parent), next ? idFor(next) : null);
        attachScrollSubtree(node);
      }
    }

    if (!texts.length && !attributes.length && !removes.length && !adds.length) return;
    capture.warnings = Array.from(warnings);
    addEvent({
      type: RrwebEventType.IncrementalSnapshot,
      timestamp: nextTimestamp(),
      data: {
        source: RrwebIncrementalSource.Mutation,
        texts,
        attributes,
        removes,
        adds,
      },
    });
    if (!stopped) capture.stats.mutationCount += batchMutationCount;
    for (const input of inputs)
      addEvent({
        type: RrwebEventType.IncrementalSnapshot,
        timestamp: nextTimestamp(),
        data: { source: RrwebIncrementalSource.Input, ...input, isChecked: false },
      });
  }

  function stop(reason = 'manual'): TaroReplayCapture {
    if (stopped) return cloneCapture(capture);
    stopped = true;
    if (resources.timer) clearTimeout(resources.timer);
    resources.observer?.disconnect();
    for (const [name, listener] of rootListeners) {
      try {
        options.root.removeEventListener?.(name, listener);
      } catch {
        /* Safe native teardown. */
      }
    }
    rootListeners.clear();
    nodesBySid.clear();
    idsBySid.clear();
    canvasFrames.clear();
    canvasCheckpoint = undefined;
    serializedNodes = new WeakSet();
    for (const [node, listener] of swiperListeners) {
      try {
        node.removeEventListener?.('change', listener);
      } catch {
        /* Safe native teardown. */
      }
    }
    swiperListeners.clear();
    for (const [node, listener] of pickerListeners) {
      try {
        node.removeEventListener?.('change', listener);
      } catch {
        /* Safe platform fallback. */
      }
    }
    pickerListeners.clear();
    for (const [node, listener] of scrollListeners) {
      try {
        node.removeEventListener?.('scroll', listener);
      } catch {
        // Cleanup never changes the host's unload result.
      }
    }
    scrollListeners.clear();
    capture.endedAt = Math.max(now(), lastEventTimestamp);
    capture.stopReason = reason;
    capture.warnings = Array.from(warnings);
    const result = cloneCapture(capture);
    options.onStop?.(result);
    return result;
  }

  const controller: TaroReplayRecorder = {
    addBreadcrumb,
    getCapture: () => cloneCapture(capture),
    stop,
    takeSegment,
    promoteToSession,
    recordPageScroll,
    recordViewport,
    recordCanvas,
  };

  addEvent({
    type: RrwebEventType.Meta,
    timestamp: nextTimestamp(startedAt),
    data: {
      href: capture.href,
      width: viewportWidth,
      height: viewportHeight,
    },
  });
  addEvent({
    type: RrwebEventType.FullSnapshot,
    timestamp: nextTimestamp(startedAt),
    data: {
      node: fullSnapshot(),
      initialOffset: { top: pagePosition.y, left: pagePosition.x },
    },
  });

  capture.warnings = Array.from(warnings);
  // A very small maxEvents/maxBytes can stop while the initial snapshot is
  // being appended. Do not create live resources after that terminal state.
  if (stopped) return controller;

  resources.observer = new options.MutationObserver(handleMutations);
  resources.observer.observe(options.root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  attachScrollSubtree(options.root);
  attachInteractions();
  resources.timer = setTimeout(() => stop('duration'), maxDurationMs);

  return controller;
}

/** @deprecated Use startTaroReplayRecorder. */
export const startTaroDomReplayPoc = startTaroReplayRecorder;
