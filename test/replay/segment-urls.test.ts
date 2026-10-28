import type { Event } from '@sentry/core';
import { describe, expect, test, vi } from 'vite-plus/test';

import { ReplayCoordinator } from '../../src/replay/coordinator/ReplayCoordinator';
import { makeRuntime, makeSdk } from './fixtures';

const HOME = 'https://miniapp.local/pages/home/index';
const DETAIL = 'https://miniapp.local/pages/detail/index';

function page(path: string) {
  const runtime = makeRuntime();
  runtime.getCurrentInstance = () => ({ router: { $taroPath: path } });
  return runtime;
}

function replayEvents(sendEnvelope: ReturnType<typeof makeSdk>['sendEnvelope']) {
  return sendEnvelope.mock.calls.map((call) => (call as any[])[0][1][0][1]);
}

// Official Replay sends only the pages entered during a segment; Sentry sums
// every segment's `urls` into the replay's page list and `count_urls`.
describe('Replay segment urls', () => {
  test('full session reports each page once when it is entered', async () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysSessionSampleRate: 1,
      random: () => 0.25,
    });

    coordinator.attachRoot(page('pages/home/index'));
    await coordinator.flush();
    await coordinator.flush();
    coordinator.attachRoot(page('pages/detail/index?id=1'));
    await coordinator.flush();
    coordinator.attachRoot(page('pages/home/index'));
    coordinator.detachRoot();
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(6));

    expect(
      replayEvents(fixture.sendEnvelope).map(({ segment_id, urls }) => [segment_id, urls]),
    ).toEqual([
      [0, [HOME]],
      [1, []],
      [2, []],
      [3, [DETAIL]],
      [4, []],
      [5, [HOME]],
    ]);
    coordinator.destroy();
  });

  test('a retried segment resends the same urls without advancing later segments', async () => {
    const fixture = makeSdk();
    fixture.sendEnvelope
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ statusCode: 200 });
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysSessionSampleRate: 1,
      random: () => 0.25,
      delivery: { retryDelayMs: 0 },
    });

    coordinator.attachRoot(page('pages/home/index'));
    await coordinator.flush();
    await coordinator.flush();
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(3));

    expect(
      replayEvents(fixture.sendEnvelope).map(({ segment_id, urls }) => [segment_id, urls]),
    ).toEqual([
      [0, [HOME]],
      [0, [HOME]],
      [1, []],
    ]);
    coordinator.destroy();
  });

  test('a promoted error buffer reports the buffered pages, then only new pages', async () => {
    const fixture = makeSdk();
    const coordinator = new ReplayCoordinator({
      minReplayDuration: 0,
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      random: () => 0.25,
      now: () => 1_700_000_002_000,
    });

    coordinator.attachRoot(page('pages/home/index'));
    coordinator.attachRoot(page('pages/detail/index'));
    await coordinator.flush();
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();

    const error: Event = {
      event_id: 'e'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    };
    fixture.emitBeforeSend(error);
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(1));
    await coordinator.flush();
    coordinator.attachRoot(page('pages/home/index'));
    coordinator.detachRoot();
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(4));

    expect(
      replayEvents(fixture.sendEnvelope).map(({ segment_id, replay_type, urls }) => [
        segment_id,
        replay_type,
        urls,
      ]),
    ).toEqual([
      [0, 'buffer', [HOME, DETAIL]],
      [1, 'session', []],
      [2, 'session', []],
      [3, 'session', [HOME]],
    ]);
    coordinator.destroy();
  });
});
