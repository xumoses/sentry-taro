/** Serializes Taro nodes into rrweb nodes and attribute values after privacy rules are applied. */

import type { TaroReplayNodeLike } from '../types';
import {
  SELF_CLOSING_TAGS,
  TAG_MAP,
  URL_ATTRIBUTE_NAMES,
  maskValue,
  sanitizeAttributeValue,
  sanitizeUrl,
} from './attributes';
import { isCanvasContainer, isCanvasProtected } from './canvas';
import { idFor, type AttributeValue, type RecorderContext } from './context';
import { MAX_STATIC_IMAGE_SOURCE_BYTES, MEDIA_NODE_NAMES, isStaticImageDataUri } from './media';
import {
  currentSwiperIndex,
  getPickerValues,
  getScrollPosition,
  inputValues,
  isInputNode,
  isPickerView,
  isScrollView,
  isSwiper,
  normaliseNodeName,
  pickerColumns,
  pickerRows,
  portalEnabled,
  rawAttributeValue,
  swiperItems,
  toArray,
} from './nodes';
import {
  RrwebNodeType,
  type SerializedDocumentNode,
  type SerializedElementNode,
  type SerializedNode,
  type SerializedTextNode,
} from './rrweb';
import { normalizeReplayRpx, sanitizeReplayStyle } from './styles';

function replayAttributeValue(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
  name: string,
  value: unknown,
  maskNodeInputValues: boolean,
): AttributeValue {
  const { privacy } = ctx;
  if (value === null || value === undefined) return null;
  if (/^on/i.test(name)) return null;
  const lowerName = name.toLowerCase();
  // Taro Image has one src, not a browser srcset. Never bypass its media policy with unknown candidates.
  if (lowerName === 'srcset') return null;
  if (lowerName.endsWith('style') && typeof value === 'string') {
    return sanitizeReplayStyle(value, sanitizeUrl, privacy.shouldBlockMedia(node));
  }
  if (
    (privacy.isMasked(node) && ['title', 'placeholder', 'aria-label', 'alt'].includes(lowerName)) ||
    (privacy.maskAttributes.has(lowerName) && !privacy.isUnmasked(node))
  )
    return maskValue(value);
  if (
    normaliseNodeName(node) === 'image' &&
    name.toLowerCase() === 'src' &&
    typeof value === 'string'
  ) {
    const sources = ctx.options.staticImageSources;
    const trusted =
      sources && Object.prototype.hasOwnProperty.call(sources, value) ? sources[value] : undefined;
    if (
      typeof trusted === 'string' &&
      trusted.length <= MAX_STATIC_IMAGE_SOURCE_BYTES &&
      isStaticImageDataUri(trusted)
    )
      return trusted;
    if (privacy.shouldBlockMedia(node)) return null;
  }
  if (
    MEDIA_NODE_NAMES.has(normaliseNodeName(node)) &&
    privacy.shouldBlockMedia(node) &&
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

export function safeInputValue(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
  value: unknown,
): string {
  return ctx.privacy.shouldMaskInputValues(node) ? maskValue(value) : String(value ?? '');
}

function swiperPlaybackStyle(node: TaroReplayNodeLike, original: unknown): string {
  const declaration = isSwiper(node)
    ? `--taro-replay-swiper-current:${currentSwiperIndex(node)}`
    : `--taro-replay-swiper-index:${swiperItems(node.parentNode!).indexOf(node)}`;
  return [typeof original === 'string' ? original : '', declaration].filter(Boolean).join(';');
}

function pickerPlaybackStyle(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
  original: unknown,
): string {
  const declarations = [typeof original === 'string' ? original : ''];
  if (isPickerView(node)) {
    const indicator = sanitizeReplayStyle(
      String(rawAttributeValue(node, 'indicatorstyle') ?? ''),
      sanitizeUrl,
      ctx.privacy.shouldBlockMedia(node),
    );
    const height = /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(indicator)?.[1] ?? '34px';
    declarations.push(
      `--taro-replay-picker-item-height:${normalizeReplayRpx(height, ctx.viewportWidth)}`,
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

export function readAttributes(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {
    'data-taro-node': normaliseNodeName(node),
  };
  const remembered = new Map<string, AttributeValue>();
  const maskNodeInputValues = ctx.privacy.shouldMaskInputValues(node);

  for (const attribute of toArray(node.attributes)) {
    if (!attribute || !attribute.name || /^on/i.test(attribute.name)) continue;
    let value = replayAttributeValue(
      ctx,
      node,
      attribute.name,
      attribute.value,
      maskNodeInputValues,
    );
    if (attribute.name === 'style' && typeof value === 'string') {
      value = normalizeReplayRpx(value, ctx.viewportWidth);
    }
    const playbackName = attribute.name === 'className' ? 'class' : attribute.name;
    result[playbackName] = value;
    remembered.set(attribute.name, value);
  }
  if (isInputNode(node)) {
    result['value'] = safeInputValue(ctx, node, currentInputValue(node));
    remembered.set('value', result['value']);
    ctx.lastInputValues.set(node, String(result['value']));
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
    result['style'] = pickerPlaybackStyle(ctx, node, result['style']);
    if (normaliseNodeName(node.parentNode ?? node) === 'picker-view-column')
      result['data-taro-picker-row'] = true;
  }
  ctx.lastAttributeValues.set(node, remembered);

  return result;
}

function serializeChildren(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
  portals?: SerializedElementNode[],
): SerializedNode[] {
  const children: SerializedNode[] = [];
  for (const child of toArray(node.childNodes)) {
    const serialized = serializeNode(ctx, child, portals);
    if (portals && portalEnabled(child)) portals.push(serialized as SerializedElementNode);
    else children.push(serialized);
  }
  return children;
}

export function serializeNode(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
  portals?: SerializedElementNode[],
): SerializedNode {
  ctx.serializedNodes.add(node);
  const nodeName = normaliseNodeName(node);
  if (ctx.privacy.isBlocked(node)) {
    return {
      id: idFor(ctx, node),
      type: RrwebNodeType.Element,
      tagName: 'div',
      attributes: { 'data-taro-node': nodeName, 'data-sentry-blocked': true },
      childNodes: [],
    };
  }
  if (node.nodeType === 3 || nodeName === '#text' || nodeName === 'comment') {
    const comment = nodeName === 'comment';
    const textContent = ctx.privacy.shouldMaskText(node)
      ? maskValue(node.textContent)
      : String(node.textContent ?? '');
    ctx.lastTextValues.set(node, textContent);
    return {
      id: idFor(ctx, node),
      type: comment ? RrwebNodeType.Comment : RrwebNodeType.Text,
      textContent,
    };
  }

  const tagName = TAG_MAP[nodeName] || 'div';
  if (!TAG_MAP[nodeName] && !isCanvasContainer(ctx, node))
    ctx.warnings.add(`unsupported Taro node rendered as placeholder: ${nodeName}`);
  const attributes = readAttributes(ctx, node);
  if (isCanvasContainer(ctx, node)) {
    let state = ctx.canvasFrames.get(node);
    if (!state) {
      state = { imageId: ctx.nextNodeId++, lastReadAt: -Infinity };
      ctx.canvasFrames.set(node, state);
    }
    if (isCanvasProtected(ctx, node)) delete state.frame;
    return {
      id: idFor(ctx, node),
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
    id: idFor(ctx, node),
    type: RrwebNodeType.Element,
    tagName,
    attributes,
    childNodes: SELF_CLOSING_TAGS.has(tagName) ? [] : serializeChildren(ctx, node, portals),
  };
}

export function fullSnapshot(ctx: RecorderContext): SerializedDocumentNode {
  ctx.serializedNodes = new WeakSet();
  const styleText: SerializedTextNode = {
    id: 6,
    type: RrwebNodeType.Text,
    textContent: ctx.stylesheet,
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
  const root = serializeNode(ctx, ctx.options.root, portals);
  for (const node of ctx.canvasFrames.keys()) {
    if (!ctx.serializedNodes.has(node) || !isCanvasContainer(ctx, node))
      ctx.canvasFrames.delete(node);
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

export function currentAttributeValue(
  ctx: RecorderContext,
  node: TaroReplayNodeLike,
  attributeName: string,
): AttributeValue {
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
        sanitizeReplayStyle(String(raw ?? ''), sanitizeUrl, ctx.privacy.shouldBlockMedia(node)),
        ctx.viewportWidth,
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
      ctx,
      node,
      normalizeReplayRpx(
        sanitizeReplayStyle(String(raw ?? ''), sanitizeUrl, ctx.privacy.shouldBlockMedia(node)),
        ctx.viewportWidth,
      ),
    );
  }
  if (attributeName === 'style' && (raw === null || raw === undefined || raw === '')) return null;
  const value = replayAttributeValue(
    ctx,
    node,
    attributeName,
    raw,
    ctx.privacy.shouldMaskInputValues(node),
  );
  return attributeName === 'style' && typeof value === 'string'
    ? normalizeReplayRpx(value, ctx.viewportWidth)
    : value;
}
