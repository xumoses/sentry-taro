import { describe, expect, test } from 'vite-plus/test';

import { boundReplayEvents } from '../../src/replay/coordinator/buffer';
import { utf8ByteLength } from '../../src/sdk/utf8';
import type { TaroReplayEvent } from '../../src/replay/types';

const event = (type: number, timestamp: number, value: string): TaroReplayEvent => ({
  type,
  timestamp,
  data: { value },
});

describe('Replay rolling buffer', () => {
  test('evicts old increments while retaining the baseline for recent navigation', () => {
    const events = [
      event(4, 0, 'old-meta'),
      event(2, 1, 'old-full'),
      event(3, 80, 'old-mutation'),
      event(4, 90, 'new-meta'),
      event(2, 91, 'new-full'),
      event(3, 95, 'recent-mutation'),
    ];

    expect(
      boundReplayEvents(events, {
        now: 100,
        windowMs: 10,
        maxEvents: 10,
        maxBytes: 10_000,
      }),
    ).toEqual([events[0], events[1], events[3], events[4], events[5]]);
  });

  test('retains recent navigation and its preceding playable root', () => {
    const newMeta = event(4, 90, 'new-meta');
    const newFull = event(2, 91, 'new-full');
    const newMutation = event(3, 92, 'new-mutation');
    expect(
      boundReplayEvents(
        [
          event(4, 70, 'old-meta'),
          event(2, 71, 'old-full'),
          event(3, 89, 'old-root-mutation'),
          newMeta,
          newFull,
          newMutation,
        ],
        { now: 100, windowMs: 30, maxEvents: 20, maxBytes: 10_000 },
      ),
    ).toEqual([
      event(4, 70, 'old-meta'),
      event(2, 71, 'old-full'),
      event(3, 89, 'old-root-mutation'),
      newMeta,
      newFull,
      newMutation,
    ]);
  });

  test('rolls by UTF-8 bytes and event count instead of stopping', () => {
    const checkpoint = [event(4, 90, 'meta'), event(2, 91, 'full')];
    const oldest = event(3, 92, '你好'.repeat(20));
    const newest = event(3, 93, 'small');
    const maxBytes =
      checkpoint.reduce((sum, item) => sum + utf8ByteLength(JSON.stringify(item)), 0) +
      utf8ByteLength(JSON.stringify(newest));

    expect(
      boundReplayEvents([...checkpoint, oldest, newest], {
        now: 100,
        windowMs: 30,
        maxEvents: 3,
        maxBytes,
      }),
    ).toEqual([...checkpoint, newest]);
  });
});
