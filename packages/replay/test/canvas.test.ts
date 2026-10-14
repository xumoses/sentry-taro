import { afterEach, expect, test, vi } from 'vite-plus/test';
import { taroReplayIntegration } from '../src/coordinator/integration';
import { ReplayCoordinator } from '../src/coordinator/ReplayCoordinator';
import { makeCapture, makeRuntime, makeSdk } from './fixtures';
import type { TaroReplayNodeLike } from '../src/types';

afterEach(() => vi.useRealTimers());

test('an opted-in bridge delegates a current-page canvas read to its recorder', () => {
  vi.useFakeTimers();
  const f = makeSdk();
  const root: TaroReplayNodeLike = { nodeType: 1, nodeName: 'view', childNodes: [] };
  const canvas: TaroReplayNodeLike = { nodeType: 1, nodeName: 'canvas', parentNode: root };
  root.childNodes!.push(canvas);
  const runtime = makeRuntime(root);
  runtime.document.getElementById = (id) => (id === 'chart' ? canvas : root);
  const start = f.sdk.startTaroDomReplayPoc;
  let insideRecorder = false;
  f.sdk.startTaroDomReplayPoc = (options) => ({
    ...start(options),
    recordCanvas: (node, read) => {
      if (options.recordCanvas !== true || node !== canvas) return false;
      insideRecorder = true;
      const frame = read();
      insideRecorder = false;
      return frame === 'synthetic-frame';
    },
  });
  const coordinator = new ReplayCoordinator({
    sdk: f.sdk,
    client: f.sdk.getClient()!,
    replaysSessionSampleRate: 1,
    recordCanvas: true,
  });
  coordinator.attachRoot(runtime);
  const read = vi.fn(() => {
    expect(insideRecorder).toBe(true);
    return 'synthetic-frame';
  });
  expect(coordinator.recordCanvas('chart', read)).toBe(true);
  expect(read).toHaveBeenCalledOnce();
  coordinator.destroy();
});

test('pixels from a foreign, detached, or replaced page root are never read', () => {
  vi.useFakeTimers();
  const f = makeSdk();
  const root: TaroReplayNodeLike = { nodeType: 1, nodeName: 'view', childNodes: [] };
  const foreignRoot: TaroReplayNodeLike = { nodeType: 1, nodeName: 'view' };
  const canvas: TaroReplayNodeLike = { nodeType: 1, nodeName: 'canvas', parentNode: foreignRoot };
  const runtime = makeRuntime(root);
  let currentRoot = root;
  runtime.document.getElementById = (id) => (id === 'chart' ? canvas : currentRoot);
  const start = f.sdk.startTaroDomReplayPoc;
  f.sdk.startTaroDomReplayPoc = (options) => ({
    ...start(options),
    recordCanvas: (_node, read) => Boolean(read()),
  });
  const c = new ReplayCoordinator({
    sdk: f.sdk,
    client: f.sdk.getClient()!,
    replaysOnErrorSampleRate: 1,
    recordCanvas: true,
  });
  c.attachRoot(runtime);
  const read = vi.fn(() => 'pixels');
  expect(c.recordCanvas('chart', read)).toBe(false);
  canvas.parentNode = null;
  expect(c.recordCanvas('chart', read)).toBe(false);
  canvas.parentNode = canvas;
  expect(c.recordCanvas('chart', read)).toBe(false);
  canvas.parentNode = root;
  // A stale parent pointer alone does not make the detached node part of the root.
  expect(c.recordCanvas('chart', read)).toBe(false);
  root.childNodes!.push(canvas);
  currentRoot = foreignRoot;
  expect(c.recordCanvas('chart', read)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  c.destroy();
});

test.each([
  'default-off',
  'disabled',
  'kill-switch',
  'hidden',
  'stopped',
  'reset',
  'destroyed',
  'old-sdk',
  'paused',
] as const)('%s rejects pixels before even resolving an element', async (mode) => {
  vi.useFakeTimers();
  const f = makeSdk();
  const root: TaroReplayNodeLike = { nodeType: 1, nodeName: 'view' };
  const canvas: TaroReplayNodeLike = { nodeType: 1, nodeName: 'canvas', parentNode: root };
  const runtime = makeRuntime(root);
  const lookup = vi.fn((id: string) => (id === 'chart' ? canvas : root));
  runtime.document.getElementById = lookup;
  const start = f.sdk.startTaroDomReplayPoc;
  if (mode !== 'old-sdk')
    f.sdk.startTaroDomReplayPoc = (options) => ({
      ...start(options),
      recordCanvas: (_node, read) => Boolean(read()),
    });
  let enabled = mode !== 'disabled';
  const c = new ReplayCoordinator({
    sdk: f.sdk,
    client: f.sdk.getClient()!,
    replaysOnErrorSampleRate: 1,
    enabled: () => enabled,
    ...(mode === 'default-off' ? {} : { recordCanvas: true }),
  });
  c.attachRoot(runtime);
  if (mode === 'kill-switch') enabled = false;
  if (mode === 'hidden') c.detachRoot();
  if (mode === 'stopped') await c.stop({ flush: false });
  if (mode === 'reset') c.reset();
  if (mode === 'destroyed') c.destroy();
  if (mode === 'paused')
    f.getStartOptions().onStop?.({ ...makeCapture(), stopReason: 'mutation-limit' });
  lookup.mockClear();
  const read = vi.fn(() => 'private pixels');
  expect(c.recordCanvas('chart', read)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  c.destroy();
});

test('ownership is checked again when the SDK asks for pixels', () => {
  vi.useFakeTimers();
  const f = makeSdk();
  const root: TaroReplayNodeLike = { nodeType: 1, nodeName: 'view' };
  const canvas: TaroReplayNodeLike = { nodeType: 1, nodeName: 'canvas', parentNode: root };
  const runtime = makeRuntime(root);
  runtime.document.getElementById = (id) => (id === 'chart' ? canvas : root);
  const start = f.sdk.startTaroDomReplayPoc;
  f.sdk.startTaroDomReplayPoc = (options) => ({
    ...start(options),
    recordCanvas: (_node, read) => {
      c.detachRoot();
      return Boolean(read());
    },
  });
  const c = new ReplayCoordinator({
    sdk: f.sdk,
    client: f.sdk.getClient()!,
    replaysOnErrorSampleRate: 1,
    recordCanvas: true,
  });
  c.attachRoot(runtime);
  const read = vi.fn(() => 'private pixels');
  expect(c.recordCanvas('chart', read)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  c.destroy();
});

test('integration subscribers can capture a previously drawn canvas after each visible attach', () => {
  vi.useFakeTimers();
  const f = makeSdk();
  const root: TaroReplayNodeLike = { nodeType: 1, nodeName: 'view' };
  const canvas: TaroReplayNodeLike = { nodeType: 1, nodeName: 'canvas', parentNode: root };
  const runtime = makeRuntime(root);
  runtime.document.getElementById = (id) => (id === 'chart' ? canvas : root);
  const start = f.sdk.startTaroDomReplayPoc;
  f.sdk.startTaroDomReplayPoc = (options) => ({
    ...start(options),
    recordCanvas: (_node, read) => Boolean(read()),
  });
  const integration = taroReplayIntegration({
    sdk: f.sdk,
    recordCanvas: true,
    replaysOnErrorSampleRate: 1,
  });
  const bridge = integration.bridge;
  const read = vi.fn(() => 'already drawn');
  expect(bridge.recordCanvas?.('chart', read)).toBe(false);
  integration.setup?.(f.sdk.getClient() as never);
  const unsubscribe = bridge.subscribe((snapshot) => {
    if (snapshot.recording) bridge.recordCanvas?.('chart', read);
  });
  bridge.attachRoot(runtime);
  expect(read).toHaveBeenCalledTimes(1);
  bridge.detachRoot();
  expect(bridge.recordCanvas?.('chart', read)).toBe(false);
  bridge.attachRoot(runtime);
  expect(read).toHaveBeenCalledTimes(2);
  unsubscribe();
  integration.cleanup();
  expect(bridge.recordCanvas?.('chart', read)).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
});

test.each(['buffer-duration', 'error-promotion', 'segment-restart'] as const)(
  '%s notifies subscribers to refresh pixels when the recorder changes with the same Replay ID',
  async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_001_000);
    const f = makeSdk();
    const root: TaroReplayNodeLike = { nodeType: 1, nodeName: 'view' };
    const canvas: TaroReplayNodeLike = { nodeType: 1, nodeName: 'canvas', parentNode: root };
    const runtime = makeRuntime(root);
    runtime.document.getElementById = (id) => (id === 'chart' ? canvas : root);
    const start = f.sdk.startTaroDomReplayPoc;
    let recorder = 0;
    const capturedBy: number[] = [];
    f.sdk.startTaroDomReplayPoc = (options) => {
      const owner = ++recorder;
      return {
        ...start(options),
        recordCanvas: (_node, read) => {
          if (!read()) return false;
          capturedBy.push(owner);
          return true;
        },
      };
    };
    const integration = taroReplayIntegration({
      sdk: f.sdk,
      recordCanvas: true,
      replaysSessionSampleRate: mode === 'segment-restart' ? 1 : 0,
      replaysOnErrorSampleRate: 1,
    });
    integration.setup?.(f.sdk.getClient() as never);
    const bridge = integration.bridge;
    const unsubscribe = bridge.subscribe((snapshot) => {
      if (snapshot.recording) bridge.recordCanvas?.('chart', () => 'already drawn');
    });
    bridge.attachRoot(runtime);
    const replayId = bridge.getReplayId?.();
    expect(capturedBy).toEqual([1]);
    if (mode === 'buffer-duration') {
      f.getStartOptions().onStop?.(
        makeCapture({
          replayId: replayId!,
          stopReason: 'duration',
          events: [{ type: 2, timestamp: 1_700_000_000_001, data: { node: {} } }],
        }),
      );
      await Promise.resolve();
    } else if (mode === 'error-promotion') {
      f.emitBeforeSend({
        event_id: 'a'.repeat(32),
        exception: { values: [{ type: 'Error', value: 'test' }] },
      });
    } else {
      await bridge.flush();
    }
    expect(bridge.getReplayId?.()).toBe(replayId);
    expect(recorder).toBe(2);
    expect(capturedBy).toContain(2);
    unsubscribe();
    integration.cleanup();
  },
);
