import {
  Client,
  type ClientOptions,
  type Event,
  type EventHint,
  type SeverityLevel,
} from '@sentry/core';
import { describe, expect, test, vi } from 'vite-plus/test';
import { ReplayCoordinator } from '../src/coordinator/ReplayCoordinator';
import { taroReplayIntegration } from '../src/coordinator/integration';
import { makeRuntime, makeSdk } from './fixtures';

class AcceptedClient extends Client {
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

describe('Replay promotion bounds', () => {
  test('rejects empty promotion synchronously and recovers with a new ID without associating the discarded error', async () => {
    const fixture = makeSdk();
    const limits = { maxEvents: 1 };
    let calls = 0;
    const coordinator = new ReplayCoordinator({
      sdk: fixture.sdk,
      client: fixture.sdk.getClient()!,
      replaysOnErrorSampleRate: 1,
      limits,
      random: () => (calls++ < 32 ? 0.25 : 0.5),
    });
    coordinator.attachRoot(makeRuntime());
    const oldId = coordinator.getSnapshot().replayId;
    const rejected: Event = {
      event_id: 'a'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'synthetic oversized checkpoint' }] },
    };
    fixture.emitBeforeSend(rejected);
    expect(rejected.contexts?.replay).toBeUndefined();
    expect(coordinator.getSnapshot().state).toBe('buffer');
    expect(coordinator.getSnapshot().replayId).not.toBe(oldId);
    expect(coordinator.getSnapshot().errorEventId).toBeUndefined();
    expect(fixture.sendEnvelope).not.toHaveBeenCalled();
    limits.maxEvents = 500;
    coordinator.detachRoot();
    coordinator.attachRoot(makeRuntime());
    const accepted: Event = {
      event_id: 'b'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'synthetic valid checkpoint' }] },
    };
    fixture.emitBeforeSend(accepted);
    expect(accepted.contexts?.replay?.replay_id).toBe(coordinator.getSnapshot().replayId);
    expect(accepted.contexts?.replay?.replay_id).not.toBe(oldId);
    await vi.waitFor(() => expect(fixture.sendEnvelope).toHaveBeenCalledTimes(1));
    const replayEvent = fixture.sendEnvelope.mock.calls[0]![0][1][0][1];
    expect(replayEvent.error_ids).toEqual(['b'.repeat(32)]);
    coordinator.detachRoot();
  });

  test('the real accepted-event hook precedes envelope construction and adds no Replay to an empty recording', async () => {
    const fixture = makeSdk();
    const envelopes: any[] = [];
    const acceptedHook = vi.fn();
    const client = new AcceptedClient({
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
      beforeSend: (event) => (event.tags?.['drop'] ? null : event),
    });
    const limits = { maxEvents: 1 };
    const integration = taroReplayIntegration({
      sdk: { ...fixture.sdk, getClient: () => client },
      replaysOnErrorSampleRate: 1,
      limits,
    });
    integration.setup?.(client);
    integration.bridge.attachRoot(makeRuntime());
    client.on('beforeSendEvent', acceptedHook);
    client.captureEvent({
      event_id: 'c'.repeat(32),
      tags: { drop: true },
      exception: { values: [{ type: 'Error', value: 'filtered synthetic event' }] },
    });
    client.captureEvent({
      event_id: 'd'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'accepted synthetic event' }] },
    });
    await client.flush(1000);
    expect(acceptedHook).toHaveBeenCalledTimes(1);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0][1][0][0].type).toBe('event');
    expect(envelopes[0][1][0][1].contexts?.replay).toBeUndefined();
    expect(Object.keys(envelopes[0][1][0][1].tags ?? {}).some((name) => /replay/i.test(name))).toBe(
      false,
    );
    expect(envelopes[0][1][0][1].request?.url).toBeUndefined();
    expect(JSON.stringify(envelopes[0][1][0][1])).not.toContain('/replays/');
    expect(envelopes[0][1][0][1].event_id).toBe('d'.repeat(32));
    expect(integration.bridge.getSnapshot().state).toBe('buffer');
    limits.maxEvents = 500;
    integration.bridge.detachRoot();
    expect(integration.bridge.attachRoot(makeRuntime())).toBe(true);
    const validId = integration.bridge.getSnapshot().replayId;
    client.captureEvent({
      event_id: 'e'.repeat(32),
      exception: { values: [{ type: 'Error', value: 'valid later synthetic event' }] },
    });
    await client.flush(1000);
    await vi.waitFor(() => expect(integration.bridge.getSnapshot().state).toBe('session'));
    const later = envelopes
      .flatMap((envelope) => envelope[1])
      .find((item) => item[0].type === 'event' && item[1].event_id === 'e'.repeat(32));
    expect(later[1].contexts.replay.replay_id).toBe(validId);
    const replay = envelopes
      .flatMap((envelope) => envelope[1])
      .find((item) => item[0].type === 'replay_event');
    expect(replay[1].error_ids).toEqual(['e'.repeat(32)]);
    integration.bridge.detachRoot();
    await client.close(0);
  });
});
