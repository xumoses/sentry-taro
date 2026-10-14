import { encodeUtf8 } from '../src/worker/utf8';
import { inflateSync } from 'node:zlib';
import { strToU8, zlibSync } from 'fflate';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { ReplayCompression, type ReplayWorker } from '../src/compression';
import { encodeBase64 } from '../src/worker/base64';
import { ReplayDelivery } from '../src/coordinator/delivery';
import { makeCapture } from './fixtures';

const settle = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};
function mockWorker({ silent = '', invalid = false } = {}) {
  let listener: (message: Record<string, unknown>) => void = () => {};
  let killed: () => void = () => {};
  let error: (cause: unknown) => void = () => {};
  const messages: Record<string, unknown>[] = [];
  const worker: ReplayWorker = {
    postMessage: vi.fn((message) => {
      messages.push(message);
      if (message['method'] === silent) return;
      const response =
        message['method'] === 'compress'
          ? {
              data: invalid
                ? 'invalid'
                : encodeBase64(zlibSync(strToU8(message['data'] as string))),
            }
          : {};
      listener({
        protocol: 1,
        id: message['id'],
        method: message['method'],
        success: true,
        ...response,
      });
    }),
    onMessage: (callback) => {
      listener = callback;
    },
    onProcessKilled: (callback) => {
      killed = callback;
    },
    onError: (callback) => {
      error = callback;
    },
    terminate: vi.fn(),
  };
  return {
    worker,
    messages,
    receive: (message: Record<string, unknown>) => listener(message),
    killed: () => killed(),
    error: () => error(new Error('synthetic')),
  };
}
const events = JSON.stringify([{ type: 2, data: { text: '掩码✅'.repeat(1000) } }]);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WeChat Replay compression worker', () => {
  test('UTF-8 preserves supplementary characters and replaces malformed surrogates', () => {
    for (const value of ['', 'A汉字🙂𝄞', '\ud800', '\udc00', '\ud800A', '\ud800\ud800\udc00']) {
      expect(Buffer.from(encodeUtf8(value))).toEqual(Buffer.from(value, 'utf8'));
    }
  });

  test('the shipped worker handler compresses Unicode events without DOM or network globals', async () => {
    let handler!: (message: Record<string, unknown>) => void;
    const postMessage = vi.fn();
    vi.stubGlobal('worker', {
      onMessage(callback: typeof handler) {
        handler = callback;
      },
      postMessage,
    });
    await import('../src/worker/replay-compression');
    handler({ protocol: 1, id: 1, method: 'init' });
    handler({ protocol: 1, id: 2, method: 'compress', data: events });
    const result = postMessage.mock.calls[1]![0];
    expect(result).toMatchObject({ protocol: 1, id: 2, method: 'compress', success: true });
    expect(inflateSync(Buffer.from(result.data, 'base64')).toString()).toBe(events);
  });

  test('negotiates a JSON-safe protocol and produces independent zlib streams', async () => {
    const f = mockWorker();
    const createWorker = vi.fn(() => f.worker);
    const c = new ReplayCompression({ workerPath: 'workers/replay.js', createWorker });
    for (let index = 0; index < 2; index++) {
      const compressed = await c.compress(events, Buffer.byteLength(events));
      expect(inflateSync(compressed!).toString()).toBe(events);
    }
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledWith('workers/replay.js');
    expect(f.messages.map((message) => message['method'])).toEqual([
      'init',
      'compress',
      'compress',
    ]);
    expect(c.getSnapshot()).toMatchObject({
      state: 'ready',
      compressedSegments: 2,
      fallbackSegments: 0,
    });
    c.reset();
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });
  test('uses wx.createWorker with its receiver and does not require browser Worker or TextEncoder', async () => {
    const f = mockWorker();
    const wx = {
      createWorker(this: unknown) {
        expect(this).toBe(wx);
        return f.worker;
      },
    };
    vi.stubGlobal('wx', wx);
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('TextEncoder', undefined);
    const c = new ReplayCompression({ workerPath: 'workers/replay.js' });
    expect(inflateSync((await c.compress(events, Buffer.byteLength(events)))!).toString()).toBe(
      events,
    );
    c.reset();
  });
  test.each(['init', 'compress'])(
    'times out %s and falls back without blocking future segments',
    async (silent) => {
      vi.useFakeTimers();
      const f = mockWorker({ silent });
      const c = new ReplayCompression({
        workerPath: 'workers/replay.js',
        createWorker: () => f.worker,
        timeoutMs: 50,
      });
      const result = c.compress(events, Buffer.byteLength(events));
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toBeUndefined();
      expect(await c.compress(events, Buffer.byteLength(events))).toBeUndefined();
      expect(c.getSnapshot()).toMatchObject({ state: 'fallback', fallbackSegments: 2 });
      expect(f.worker.terminate).toHaveBeenCalledOnce();
    },
  );
  test.each(['killed', 'error'] as const)(
    'falls back after worker %s and can restart after reset',
    async (failure) => {
      const f = mockWorker({ silent: 'compress' });
      const c = new ReplayCompression({
        workerPath: 'workers/replay.js',
        createWorker: () => f.worker,
      });
      const pending = c.compress(events, Buffer.byteLength(events));
      await settle();
      f[failure]();
      expect(await pending).toBeUndefined();
      expect(c.getSnapshot().state).toBe('fallback');
      c.reset();
      expect(c.getSnapshot().state).toBe('idle');
    },
  );
  test('unavailable workers, factory failure, and malformed output safely retain the raw recording', async () => {
    vi.stubGlobal('wx', undefined);
    const factories = [
      undefined,
      () => {
        throw new Error('worker quota');
      },
      () => mockWorker({ invalid: true }).worker,
    ];
    for (const createWorker of factories) {
      const c = new ReplayCompression({
        workerPath: 'workers/replay.js',
        ...(createWorker ? { createWorker } : {}),
      });
      expect(await c.compress(events, Buffer.byteLength(events))).toBeUndefined();
      expect(c.getSnapshot()).toMatchObject({ state: 'fallback', fallbackSegments: 1 });
    }
  });
  test('reset resolves pending work and ignores a late success from the previous worker', async () => {
    const f = mockWorker({ silent: 'compress' });
    const c = new ReplayCompression({
      workerPath: 'workers/replay.js',
      createWorker: () => f.worker,
    });
    const pending = c.compress(events, Buffer.byteLength(events));
    await settle();
    const request = f.messages.at(-1)!;
    c.reset();
    f.receive({ ...request, success: true, data: encodeBase64(zlibSync(strToU8(events))) });
    expect(await pending).toBeUndefined();
    expect(c.getSnapshot()).toMatchObject({
      state: 'idle',
      compressedSegments: 0,
      fallbackSegments: 0,
    });
  });
  test('small incompressible segments use raw data without disabling a healthy worker', async () => {
    const f = mockWorker();
    const c = new ReplayCompression({
      workerPath: 'workers/replay.js',
      createWorker: () => f.worker,
    });
    expect(await c.compress('[]', 2)).toBeUndefined();
    expect(c.getSnapshot()).toMatchObject({ state: 'ready', fallbackSegments: 1 });
    expect(await c.compress(events, Buffer.byteLength(events))).toBeInstanceOf(Uint8Array);
    c.reset();
  });
});

describe('compressed Replay delivery', () => {
  test('keeps the segment header clear, computes binary length and reuses compression on retry', async () => {
    vi.useFakeTimers();
    const f = mockWorker();
    const sendEnvelope = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ statusCode: 200 });
    const q = new ReplayDelivery(
      { sendEnvelope },
      {
        isEnabled: () => true,
        onChange() {},
        retryDelayMs: 10,
        compression: { workerPath: 'workers/replay.js', createWorker: () => f.worker },
      },
    );
    const capture = makeCapture();
    capture.events.push({ type: 5, timestamp: 2, data: { text: 'masked'.repeat(1000) } });
    const pending = q.enqueue(capture, { segmentId: 7 });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    const [header, recording] = sendEnvelope.mock.calls[0]![0][1][1];
    const bytes = Buffer.from(recording);
    const separator = bytes.indexOf(10);
    expect(bytes.subarray(0, separator).toString()).toBe('{"segment_id":7}');
    expect(JSON.parse(inflateSync(bytes.subarray(separator + 1)).toString())).toEqual(
      capture.events,
    );
    expect(header.length).toBe(bytes.length);
    expect(f.messages.filter((message) => message['method'] === 'compress')).toHaveLength(1);
    expect(sendEnvelope.mock.calls[1]![0][1][1][1]).toBe(recording);
    q.cancel();
  });
  test('consent cancellation during compression never reaches Client.sendEnvelope', async () => {
    const f = mockWorker({ silent: 'compress' });
    const sendEnvelope = vi.fn();
    let enabled = true;
    const q = new ReplayDelivery(
      { sendEnvelope },
      {
        isEnabled: () => enabled,
        onChange() {},
        compression: { workerPath: 'workers/replay.js', createWorker: () => f.worker },
      },
    );
    const pending = q.enqueue(makeCapture(), { segmentId: 0 });
    await settle();
    enabled = false;
    q.cancel();
    await pending;
    await settle();
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(q.getSnapshot().pendingSegments).toBe(0);
  });
});
