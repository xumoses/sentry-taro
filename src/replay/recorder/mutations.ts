/** Turns MutationObserver batches into rrweb mutations, or a FullSnapshot when layout state changes. */

import type { TaroReplayMutationRecordLike, TaroReplayNodeLike } from '../types';
import { INPUT_MASK_ATTRIBUTE_NAMES, maskValue } from './attributes';
import { isCanvasContainer, isCanvasProtected, isInsideCanvas } from './canvas';
import {
  idFor,
  isInCurrentRoot,
  nextTimestamp,
  type AttributeValue,
  type RecorderContext,
} from './context';
import { addEvent } from './events';
import {
  containsRootPortal,
  hasNodeAncestor,
  isInputNode,
  isPickerView,
  isRootPortal,
  isSwiper,
  pickerValues,
  rawAttributeValue,
  swiperValues,
  toArray,
} from './nodes';
import { RrwebEventType, RrwebIncrementalSource, type SerializedNode } from './rrweb';
import { currentAttributeValue, fullSnapshot, serializeNode } from './serializer';
import { attachScrollSubtree, detachScrollSubtree } from './widgets';

export function handleMutations(
  ctx: RecorderContext,
  records: TaroReplayMutationRecordLike[],
): void {
  const { capture, options, privacy, lastAttributeValues } = ctx;
  if (ctx.stopped) return;
  if (records.length > ctx.mutationLimit) {
    ctx.stop('mutation-limit');
    return;
  }
  records = records.filter(
    (record) =>
      !isInsideCanvas(ctx, record.target) &&
      !(record.type === 'childList' && isCanvasContainer(ctx, record.target)),
  );
  if (!records.length) return;
  let batchMutationCount = 0;
  for (const [node, state] of ctx.canvasFrames) {
    if (
      !isCanvasContainer(ctx, node) ||
      isCanvasProtected(ctx, node) ||
      !isInCurrentRoot(ctx, node) ||
      records.some(
        (record) =>
          record.type === 'attributes' &&
          (/^data-sentry-(?:canvas|mask|block|ignore)$/i.test(record.attributeName ?? '') ||
            (/^(?:class|classname)$/i.test(record.attributeName ?? '') &&
              /sentry-(?:mask|block|ignore)/.test(
                String(rawAttributeValue(record.target, record.attributeName!) ?? '') +
                  String(lastAttributeValues.get(record.target)?.get(record.attributeName!) ?? ''),
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
      ...ctx.scrollListeners.keys(),
      ...ctx.pickerListeners.keys(),
      ...ctx.swiperListeners.keys(),
    ]) {
      if (privacy.isBlocked(node) || isInsideCanvas(ctx, node)) detachScrollSubtree(ctx, node);
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
        for (const node of toArray(record.removedNodes)) detachScrollSubtree(ctx, node);
        for (const node of toArray(record.addedNodes)) attachScrollSubtree(ctx, node);
      } else if (
        record.type === 'attributes' &&
        isPickerView(record.target) &&
        ['value', 'defaultvalue'].includes(record.attributeName?.toLowerCase() ?? '')
      ) {
        pickerValues.delete(record.target);
      }
    }
    addEvent(ctx, {
      type: RrwebEventType.FullSnapshot,
      timestamp: nextTimestamp(ctx),
      data: {
        node: fullSnapshot(ctx),
        initialOffset: { top: ctx.pagePosition.y, left: ctx.pagePosition.x },
      },
    });
    attachScrollSubtree(ctx, options.root);
    if (!ctx.stopped) capture.stats.mutationCount += batchMutationCount;
    capture.warnings = Array.from(ctx.warnings);
    return;
  }
  const texts: Array<{ id: number; value: string }> = [];
  const attributes: Array<{
    id: number;
    attributes: Record<string, AttributeValue>;
  }> = [];
  const removes: Array<{ parentId: number; id: number }> = [];
  const adds: Array<{ parentId: number; nextId: number | null; node: SerializedNode }> = [];
  const inputs: Array<{ id: number; text: string }> = [];
  const addedNodes = new Set<TaroReplayNodeLike>();
  const removedIds = new Set<string>();

  for (const record of records) {
    if (privacy.isBlocked(record.target)) continue;
    batchMutationCount++;
    if (record.type === 'characterData') {
      const value = privacy.shouldMaskText(record.target)
        ? maskValue(record.target.textContent)
        : String(record.target.textContent ?? '');
      if (ctx.lastTextValues.get(record.target) === value) continue;
      ctx.lastTextValues.set(record.target, value);
      texts.push({
        id: idFor(ctx, record.target),
        value,
      });
    } else if (record.type === 'attributes' && record.attributeName) {
      const value = currentAttributeValue(ctx, record.target, record.attributeName);
      let remembered = lastAttributeValues.get(record.target);
      if (!remembered) {
        remembered = new Map<string, AttributeValue>();
        lastAttributeValues.set(record.target, remembered);
      }
      const changedAttributes: Record<string, AttributeValue> = {};
      if (!remembered.has(record.attributeName) || remembered.get(record.attributeName) !== value) {
        remembered.set(record.attributeName, value);
        const playbackName = record.attributeName === 'className' ? 'class' : record.attributeName;
        changedAttributes[playbackName] = value;
      }
      if (
        isInputNode(record.target) &&
        INPUT_MASK_ATTRIBUTE_NAMES.has(record.attributeName.toLowerCase())
      ) {
        // Changing an input into a password can require masking its existing value,
        // even when Taro does not emit a separate value mutation.
        const inputValue = currentAttributeValue(ctx, record.target, 'value');
        if (!remembered.has('value') || remembered.get('value') !== inputValue) {
          remembered.set('value', inputValue);
          changedAttributes['value'] = inputValue;
        }
      }
      if (!Object.keys(changedAttributes).length) continue;
      attributes.push({ id: idFor(ctx, record.target), attributes: changedAttributes });
      if (
        isInputNode(record.target) &&
        Object.prototype.hasOwnProperty.call(changedAttributes, 'value')
      ) {
        const text = String(changedAttributes['value'] ?? '');
        if (ctx.lastInputValues.get(record.target) !== text) {
          ctx.lastInputValues.set(record.target, text);
          inputs.push({ id: idFor(ctx, record.target), text });
        }
      }
    } else if (record.type === 'childList') {
      const parentId = ctx.idsByNode.get(record.target);
      for (const removedNode of toArray(record.removedNodes)) {
        const id = ctx.idsByNode.get(removedNode);
        const key = `${parentId}:${id}`;
        // A node added and removed within this batch was never in the mirror.
        if (
          parentId !== undefined &&
          id !== undefined &&
          ctx.serializedNodes.has(removedNode) &&
          !removedIds.has(key)
        ) {
          removes.push({ parentId, id });
          removedIds.add(key);
        }
        // A same-batch move keeps the existing mirror ID and native listeners.
        if (!isInCurrentRoot(ctx, removedNode)) detachScrollSubtree(ctx, removedNode);
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
      !isInCurrentRoot(ctx, node) ||
      privacy.isBlocked(parent) ||
      isInsideCanvas(ctx, node) ||
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
      addSubtree(serializeNode(ctx, node), idFor(ctx, parent), next ? idFor(ctx, next) : null);
      attachScrollSubtree(ctx, node);
    }
  }

  if (!texts.length && !attributes.length && !removes.length && !adds.length) return;
  capture.warnings = Array.from(ctx.warnings);
  addEvent(ctx, {
    type: RrwebEventType.IncrementalSnapshot,
    timestamp: nextTimestamp(ctx),
    data: {
      source: RrwebIncrementalSource.Mutation,
      texts,
      attributes,
      removes,
      adds,
    },
  });
  if (!ctx.stopped) capture.stats.mutationCount += batchMutationCount;
  for (const input of inputs)
    addEvent(ctx, {
      type: RrwebEventType.IncrementalSnapshot,
      timestamp: nextTimestamp(ctx),
      data: { source: RrwebIncrementalSource.Input, ...input, isChecked: false },
    });
}
