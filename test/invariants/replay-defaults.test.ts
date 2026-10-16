// ADR-0002: Replay defaults start from the fixed official 10.76.2 values. A
// platform difference needs a documented, configurable and tested exception.
import { describe, expect, test } from 'vite-plus/test';
import { ReplayInitialSendGate } from '../../src/replay/coordinator/send-gate';
import {
  REPLAY_BUFFER_WINDOW_MS,
  REPLAY_MAX_DURATION_MS,
  REPLAY_SESSION_IDLE_EXPIRE_MS,
  REPLAY_SESSION_IDLE_PAUSE_MS,
} from '../../src/replay/recorder/constants';

describe('Replay defaults match Sentry JavaScript 10.76.2', () => {
  test('time policies', () => {
    expect(REPLAY_BUFFER_WINDOW_MS).toBe(60_000);
    expect(REPLAY_MAX_DURATION_MS).toBe(60 * 60_000);
    expect(REPLAY_SESSION_IDLE_PAUSE_MS).toBe(5 * 60_000);
    expect(REPLAY_SESSION_IDLE_EXPIRE_MS).toBe(15 * 60_000);
  });

  test('minimum replay duration before the first upload', () => {
    const gate = new ReplayInitialSendGate({
      now: () => 0,
      onReady: () => {},
      getPending: () => ({ pendingSegments: 0, pendingBytes: 0 }),
    });
    expect(gate.minimumDuration).toBe(4999);
  });
});
