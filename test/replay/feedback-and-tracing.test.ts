import {
  Client,
  Scope,
  captureFeedback,
  type ClientOptions,
  type Event,
  type EventHint,
  type SeverityLevel,
} from '@sentry/core';
import { describe, expect, test } from 'vite-plus/test';
import { ReplayCoordinator } from '../../src/replay/coordinator/ReplayCoordinator';
import { makeRuntime, makeSdk } from './fixtures';

class LocalClient extends Client {
  constructor(options: ClientOptions) {
    super(options);
  }
  eventFromException(_exception: unknown, _hint?: EventHint): PromiseLike<Event> {
    return Promise.resolve({});
  }
  eventFromMessage(
    _message: string,
    _level?: SeverityLevel,
    _hint?: EventHint,
  ): PromiseLike<Event> {
    return Promise.resolve({});
  }
}
function setup(mode: 'buffer' | 'session') {
  const envelopes: any[] = [];
  const client = new LocalClient({
    dsn: 'https://public@example.test/1',
    integrations: [],
    stackParser: () => [],
    transport: () => ({
      send: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }),
  });
  const f = makeSdk();
  const coordinator = new ReplayCoordinator({
    minReplayDuration: 0,
    sdk: { ...f.sdk, getClient: () => client },
    client,
    ...(mode === 'buffer' ? { replaysOnErrorSampleRate: 1 } : { replaysSessionSampleRate: 1 }),
  });
  const scope = new Scope();
  scope.setClient(client);
  return {
    coordinator,
    client,
    scope,
    envelopes,
    items: () => envelopes.flatMap((envelope) => envelope[1]),
  };
}

describe('actual Sentry core feedback and transaction hooks', () => {
  test('includeReplay explicitly promotes a visible buffer and synchronously associates feedback', async () => {
    const f = setup('buffer');
    f.coordinator.attachRoot(makeRuntime());
    captureFeedback(
      { message: 'synthetic feedback', source: 'api' },
      { includeReplay: false },
      f.scope,
    );
    await f.client.flush(1000);
    expect(f.items().some((item) => item[0].type === 'replay_event')).toBe(false);
    const first = f.items().find((item) => item[0].type === 'feedback');
    expect(first[1].contexts.feedback.replay_id).toBeUndefined();
    const id = f.coordinator.getReplayId();
    captureFeedback(
      { message: 'synthetic feedback with recording', source: 'api' },
      { includeReplay: true },
      f.scope,
    );
    await f.client.flush(1000);
    await Promise.resolve();
    const feedback = f
      .items()
      .filter((item) => item[0].type === 'feedback')
      .at(-1);
    expect(feedback[1].contexts.feedback.replay_id).toBe(id);
    const replay = f.items().find((item) => item[0].type === 'replay_event');
    expect(replay[1]).toMatchObject({ replay_id: id, error_ids: [] });
    expect(f.coordinator.getSnapshot().state).toBe('session');
    f.coordinator.destroy();
    await f.client.close(0);
  });

  test('native and disabled feedback cannot associate or promote', async () => {
    const f = setup('buffer');
    captureFeedback({ message: 'synthetic native feedback' }, { includeReplay: true }, f.scope);
    await f.client.flush(1000);
    expect(f.items()).toHaveLength(1);
    expect(f.items()[0][1].contexts.feedback.replay_id).toBeUndefined();
    f.coordinator.destroy();
    await f.client.close(0);
  });

  test('accepted session transactions carry Replay context and contribute official trace/segment fields', async () => {
    const f = setup('session');
    f.coordinator.attachRoot(makeRuntime());
    f.scope.captureEvent({
      type: 'transaction',
      event_id: 'a'.repeat(32),
      transaction: '/test-page?private=value',
      start_timestamp: 1,
      timestamp: 2,
      contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) } },
    });
    await f.client.flush(1000);
    await f.coordinator.flush();
    const transaction = f.items().find((item) => item[0].type === 'transaction');
    expect(transaction[1].contexts.replay.replay_id).toBe(f.coordinator.getReplayId());
    expect(transaction[1].tags.replayId).toBe(f.coordinator.getReplayId());
    const replay = f.items().find((item) => item[0].type === 'replay_event');
    expect(replay[1]).toMatchObject({
      trace_ids: ['b'.repeat(32)],
      segment_names: ['/test-page'],
      error_ids: [],
    });
    f.coordinator.destroy();
    await f.client.close(0);
  });

  test('buffer transactions neither promote nor tag an unsent replay but join a later accepted error', async () => {
    const f = setup('buffer');
    f.coordinator.attachRoot(makeRuntime());
    f.scope.captureEvent({
      type: 'transaction',
      event_id: 'a'.repeat(32),
      transaction: '/buffer-page',
      start_timestamp: 1,
      timestamp: 2,
      contexts: { trace: { trace_id: 'd'.repeat(32), span_id: 'c'.repeat(16) } },
    });
    await f.client.flush(1000);
    expect(f.items().some((item) => item[0].type === 'replay_event')).toBe(false);
    expect(f.items()[0][1].contexts.replay).toBeUndefined();
    f.scope.captureEvent({
      event_id: 'e'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'synthetic accepted' }] },
    });
    await f.client.flush(1000);
    await Promise.resolve();
    const replay = f.items().find((item) => item[0].type === 'replay_event');
    expect(replay[1]).toMatchObject({
      trace_ids: expect.arrayContaining(['d'.repeat(32)]),
      segment_names: ['/buffer-page'],
      error_ids: ['e'.repeat(32)],
    });
    f.coordinator.destroy();
    await f.client.close(0);
  });
});
