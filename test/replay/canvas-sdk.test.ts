import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { taroReplayIntegration } from '../../src/replay/coordinator/integration';
import { makeRuntime, makeSdk } from './fixtures';
import type { SentryMiniappReplaySdk, TaroReplayNodeLike } from '../../src/replay/types';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6sAAAAASUVORK5CYII=';
afterEach(() => vi.useRealTimers());

describe('workspace Canvas SDK and public integration bridge', () => {
  test('only marked current-page pixels enter Replay while ordinary media stays private', async () => {
    vi.useFakeTimers();
    const { startTaroDomReplayPoc } = (await import('../../src/sdk/replay-poc')) as Pick<
      SentryMiniappReplaySdk,
      'startTaroDomReplayPoc'
    >;
    const f = makeSdk();
    f.sdk.startTaroDomReplayPoc = startTaroDomReplayPoc;
    const root: TaroReplayNodeLike = {
      nodeType: 1,
      nodeName: 'view',
      childNodes: [],
      attributes: [],
    };
    const chart: TaroReplayNodeLike = {
      nodeType: 1,
      nodeName: 'canvas',
      parentNode: root,
      childNodes: [],
      attributes: [
        { name: 'id', value: 'chart' },
        { name: 'data-sentry-canvas', value: true },
      ],
    };
    const unmarked: TaroReplayNodeLike = {
      nodeType: 1,
      nodeName: 'canvas',
      parentNode: root,
      childNodes: [],
      attributes: [{ name: 'id', value: 'unmarked' }],
    };
    const image: TaroReplayNodeLike = {
      nodeType: 1,
      nodeName: 'image',
      parentNode: root,
      attributes: [
        { name: 'src', value: 'https://media.example.test/private-photo.png?token=secret' },
      ],
    };
    root.childNodes!.push(chart, unmarked, image);
    const runtime = makeRuntime(root);
    runtime.document.getElementById = (id) =>
      id === 'chart' ? chart : id === 'unmarked' ? unmarked : root;
    const integration = taroReplayIntegration({
      minReplayDuration: 0,
      sdk: f.sdk,
      recordCanvas: true,
      replaysSessionSampleRate: 1,
    });
    integration.setup?.(f.sdk.getClient() as never);
    const bridge = integration.bridge;
    bridge.attachRoot(runtime);
    const privateRead = vi.fn(() => png);
    expect(bridge.recordCanvas?.('unmarked', privateRead)).toBe(false);
    expect(privateRead).not.toHaveBeenCalled();
    const read = vi.fn(() => png);
    expect(bridge.recordCanvas?.('chart', read)).toBe(true);
    expect(bridge.recordCanvas?.('chart', read)).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    await bridge.flush();
    const recording = f.sendEnvelope.mock.calls[0]![0][1][1][1];
    expect(recording).toContain(png);
    expect(recording).not.toContain('private-photo');
    expect(recording).not.toContain('token=secret');
    bridge.detachRoot();
    expect(bridge.recordCanvas?.('chart', read)).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    integration.cleanup();
  });
});
