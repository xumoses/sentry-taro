import { makeDsn, type ReplayEnvelope } from '@sentry/core';
import { describe, expect, test, vi } from 'vite-plus/test';

import {
  createReplayEnvelope,
  sendReplayCapture,
  serializeDsn,
  serializeReplayRecording,
} from '../../src/replay/envelope';
import { utf8ByteLength } from '../../src/sdk/utf8';
import { makeCapture } from './fixtures';

describe('Sentry Replay envelope', () => {
  test('serializes DSN host/path/port without leaking the private password', () => {
    expect(
      serializeDsn({
        protocol: 'https',
        publicKey: 'public key',
        pass: 'private-secret',
        host: 'sentry.example.test',
        port: '8443',
        path: '/tenant/sentry/',
        projectId: '42',
      }),
    ).toBe('https://public%20key@sentry.example.test:8443/tenant/sentry/42');
  });

  test('serializes the segment header and rrweb events array in Sentry recording format', () => {
    const recording = serializeReplayRecording(makeCapture());
    const lines = recording.split('\n');

    expect(JSON.parse(lines[0]!)).toEqual({ segment_id: 0 });
    expect(JSON.parse(lines[1]!)).toEqual([
      expect.objectContaining({ type: 4, data: { title: '你好' } }),
    ]);
    expect(utf8ByteLength('A你好')).toBe(7);
  });

  test('creates the two required Replay items with an exact UTF-8 length', () => {
    const capture = makeCapture();
    const envelope = createReplayEnvelope(capture, {
      dsn: 'https://public@example.test/1',
      sdk: capture.metadata!.sdk!,
    });
    const recording = envelope[1][1][1];
    expect(typeof recording).toBe('string');

    expect(envelope[0]).toMatchObject({
      event_id: capture.replayId,
      dsn: 'https://public@example.test/1',
    });
    expect(envelope[1][0][0]).toEqual({ type: 'replay_event' });
    expect(envelope[1][0][1]).toMatchObject({
      type: 'replay_event',
      replay_id: capture.replayId,
      replay_type: 'session',
      segment_id: 0,
      environment: 'test',
      release: 'demo@1.0.0',
      urls: [capture.href],
    });
    expect(envelope[1][1][0]).toEqual({
      type: 'replay_recording',
      length: utf8ByteLength(recording as string),
    });
  });

  test('sends through the initialized SDK client instead of raw DSN fetch', async () => {
    const sendEnvelope = vi.fn((envelope: ReplayEnvelope) => Promise.resolve(envelope));
    await sendReplayCapture(
      {
        getDsn: () => makeDsn('https://public@example.test/1'),
        sendEnvelope,
      },
      makeCapture(),
    );

    expect(sendEnvelope).toHaveBeenCalledTimes(1);
    expect(sendEnvelope.mock.calls[0]![0][0]).toMatchObject({
      dsn: 'https://public@example.test/1',
    });
    expect(sendEnvelope.mock.calls[0]![0][1][0][0]).toEqual({ type: 'replay_event' });
  });
});
