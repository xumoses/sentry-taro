import { describe, expect, test } from 'vite-plus/test';
import { boundReplayEvents } from '../src/coordinator/buffer';
import { utf8ByteLength } from '../src/envelope';
import type { TaroReplayEvent } from '../src/types';

const node = (
  id: number,
  childNodes: unknown[] = [],
  attributes: Record<string, unknown> = {},
) => ({ id, type: 2, tagName: 'div', attributes, childNodes });
const tree = () =>
  node(
    1,
    [
      node(2, [], { value: '' }),
      node(
        3,
        Array.from({ length: 12 }, (_, index) => node(index + 10)),
      ),
    ],
    { rr_scrollTop: 0 },
  );
const initial = (): TaroReplayEvent[] => [
  { type: 4, timestamp: 999, data: { width: 390, height: 844 } },
  { type: 2, timestamp: 1000, data: { node: tree(), initialOffset: { top: 0, left: 0 } } },
];
const mutation = (timestamp: number, data: Record<string, unknown>): TaroReplayEvent => ({
  type: 3,
  timestamp,
  data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data },
});
const bounds = { now: 130000, windowMs: 30000, maxEvents: 500, maxBytes: 512 * 1024 };
const snapshot = (events: TaroReplayEvent[]) => events[1]?.data['node'] as ReturnType<typeof tree>;

describe('Replay checkpoint rebasing', () => {
  test('retains a filtered input and deleted rows when their mutations age beyond 30 seconds', () => {
    const events = [
      ...initial(),
      mutation(6000, {
        attributes: [{ id: 2, attributes: { value: '700' } }],
        removes: Array.from({ length: 11 }, (_, index) => ({ parentId: 3, id: index + 11 })),
      }),
    ];
    const original = JSON.stringify(events);
    const result = boundReplayEvents(events, bounds);
    expect(snapshot(result).childNodes).toEqual([
      node(2, [], { value: '700' }),
      node(3, [node(10)]),
    ]);
    expect(result.map((event) => event.type)).toEqual([4, 2]);
    expect(result[0]?.timestamp).toBe((result[1]?.timestamp ?? 0) - 1);
    expect(result[1]?.timestamp).toBe(6000);
    expect(JSON.stringify(events)).toBe(original);
  });

  test('rebases add/text/attributes and scroll while leaving recent changes in chronological tail', () => {
    const initialEvents = initial();
    const events = [
      ...initialEvents,
      mutation(6000, {
        adds: [{ parentId: 3, nextId: 10, node: { id: 50, type: 3, textContent: 'old' } }],
        attributes: [{ id: 2, attributes: { value: 'first', removable: 'value' } }],
      }),
      mutation(7000, {
        texts: [{ id: 50, value: 'updated' }],
        attributes: [{ id: 2, attributes: { removable: null } }],
      }),
      { type: 3, timestamp: 8000, data: { source: 3, id: 1, x: 12, y: 420 } },
      mutation(120000, { attributes: [{ id: 2, attributes: { value: 'recent' } }] }),
    ];
    const result = boundReplayEvents(events, bounds);
    expect(snapshot(result).attributes).toEqual({ rr_scrollLeft: 12, rr_scrollTop: 420 });
    expect(snapshot(result).childNodes[0]).toEqual(node(2, [], { value: 'first' }));
    expect((snapshot(result).childNodes[1] as ReturnType<typeof node>).childNodes[0]).toEqual({
      id: 50,
      type: 3,
      textContent: 'updated',
    });
    expect(result.at(-1)).toBe(events.at(-1));
    expect(result.map((event) => event.timestamp)).toEqual([7999, 8000, 120000]);
    expect(initialEvents[1]?.data['node']).toEqual(tree());
  });

  test('rebases count/byte evictions and enforces a complete checkpoint size cap', () => {
    const events = [
      ...initial(),
      mutation(6000, { attributes: [{ id: 2, attributes: { value: 'first' } }] }),
      mutation(7000, { attributes: [{ id: 2, attributes: { value: 'second' } }] }),
    ];
    const count = boundReplayEvents(events, { ...bounds, now: 8000, maxEvents: 3 });
    expect(snapshot(count).childNodes[0]).toEqual(node(2, [], { value: 'first' }));
    expect(count.at(-1)).toBe(events.at(-1));
    const latest = boundReplayEvents(events, { ...bounds, maxEvents: 2 });
    expect(snapshot(latest).childNodes[0]).toEqual(node(2, [], { value: 'second' }));
    const byteLimit = latest.reduce((sum, event) => sum + utf8ByteLength(JSON.stringify(event)), 0);
    const byBytes = boundReplayEvents(events, { ...bounds, now: 8000, maxBytes: byteLimit });
    expect(byBytes.map((event) => event.type)).toEqual([4, 2]);
    expect(
      byBytes.reduce((sum, event) => sum + utf8ByteLength(JSON.stringify(event)), 0),
    ).toBeLessThanOrEqual(byteLimit);
    expect(boundReplayEvents(events, { ...bounds, maxBytes: byteLimit - 1 })).toEqual([]);
    expect(boundReplayEvents(events, { ...bounds, maxEvents: 1 })).toEqual([]);
  });
});
