import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { ReplayDelivery } from '../src/coordinator/delivery';
import { makeCapture } from './fixtures';

const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe('Replay delivery queue', () => {
  test('serializes segments and differentiates server acceptance from transport handoff', async () => {
    let finish!: (value: unknown) => void;
    const sendEnvelope = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({});
    const q = new ReplayDelivery({ sendEnvelope }, { isEnabled: () => true, onChange: () => {} });
    const first = q.enqueue(makeCapture(), { segmentId: 0 });
    const second = q.enqueue(makeCapture(), { segmentId: 1 });
    expect(sendEnvelope).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().pendingSegments).toBe(2);
    finish({ statusCode: 200 });
    await first;
    await second;
    expect(sendEnvelope).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot()).toMatchObject({
      pendingSegments: 0,
      pendingBytes: 0,
      acceptedSegments: 1,
      handedOffSegments: 1,
      lastStatus: 'handed-off',
    });
  });

  test('retries thrown failures with the same segment id and cancels retry timers', async () => {
    vi.useFakeTimers();
    const sendEnvelope = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ statusCode: 200 });
    const q = new ReplayDelivery(
      { sendEnvelope },
      { isEnabled: () => true, onChange: () => {}, retryDelayMs: 10 },
    );
    const done = q.enqueue(makeCapture(), { segmentId: 7 });
    await settle();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(sendEnvelope.mock.calls.map((call) => call[0][1][0][1].segment_id)).toEqual([7, 7]);
    expect(q.getSnapshot()).toMatchObject({ retryCount: 1, acceptedSegments: 1 });
    sendEnvelope.mockRejectedValue(new Error('network'));
    const cancelled = q.enqueue(makeCapture(), { segmentId: 8 });
    await settle();
    q.cancel();
    await cancelled;
    await vi.advanceTimersByTimeAsync(100);
    expect(sendEnvelope).toHaveBeenCalledTimes(3);
  });

  test.each([400, 429, 500])('does not retry HTTP %s or label it accepted', async (statusCode) => {
    const sendEnvelope = vi.fn().mockResolvedValue({ statusCode });
    const q = new ReplayDelivery({ sendEnvelope }, { isEnabled: () => true, onChange: () => {} });
    await expect(q.enqueue(makeCapture(), {})).rejects.toThrow(`${statusCode}`);
    expect(sendEnvelope).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot()).toMatchObject({
      acceptedSegments: 0,
      droppedSegments: 1,
      lastStatus: 'rejected',
      lastStatusCode: statusCode,
    });
  });

  test('bounds queued bytes and segments including the in-flight request', async () => {
    let finish!: (value: unknown) => void;
    const recordDroppedEvent = vi.fn();
    const sendEnvelope = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const q = new ReplayDelivery(
      { sendEnvelope, recordDroppedEvent },
      { isEnabled: () => true, onChange: () => {}, maxPendingSegments: 1 },
    );
    const pending = q.enqueue(makeCapture(), {});
    await expect(q.enqueue(makeCapture(), {})).rejects.toThrow('queue limit');
    expect(recordDroppedEvent).toHaveBeenCalledWith('queue_overflow', 'replay');
    q.cancel();
    await pending;
    finish({ statusCode: 200 });
    await settle();
    expect(q.getSnapshot()).toMatchObject({
      acceptedSegments: 0,
      pendingSegments: 0,
      pendingBytes: 0,
      lastStatus: 'cancelled',
    });
  });
  test('non-finite retry and capacity options retain finite defaults', async () => {
    vi.useFakeTimers();
    const sendEnvelope = vi.fn().mockRejectedValue(new Error('offline'));
    const q = new ReplayDelivery(
      { sendEnvelope },
      {
        isEnabled: () => true,
        onChange: () => {},
        maxRetries: NaN,
        retryDelayMs: Infinity,
        maxPendingSegments: NaN,
        maxPendingBytes: Infinity,
      },
    );
    const result = q.enqueue(makeCapture(), {}).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(Error);
    expect(sendEnvelope).toHaveBeenCalledTimes(3);
    expect(q.getSnapshot()).toMatchObject({
      pendingSegments: 0,
      retryCount: 2,
      droppedSegments: 1,
    });
    const never = new ReplayDelivery(
      { sendEnvelope: () => new Promise(() => {}) },
      {
        isEnabled: () => true,
        onChange: () => {},
        maxPendingSegments: NaN,
        maxPendingBytes: Infinity,
      },
    );
    for (let index = 0; index < 4; index++) void never.enqueue(makeCapture(), {});
    await expect(never.enqueue(makeCapture(), {})).rejects.toThrow('queue limit');
    never.cancel();
  });

  test('a rejected predecessor prevents queued dependent segments from sending', async () => {
    let finish!: (value: unknown) => void;
    const sendEnvelope = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const q = new ReplayDelivery({ sendEnvelope }, { isEnabled: () => true, onChange: () => {} });
    const results = Promise.allSettled([
      q.enqueue(makeCapture(), { segmentId: 0 }),
      q.enqueue(makeCapture(), { segmentId: 1 }),
    ]);
    finish({ statusCode: 400 });
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(sendEnvelope).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().pendingSegments).toBe(0);
  });
});
