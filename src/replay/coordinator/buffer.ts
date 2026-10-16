import { boundReplayEvents, type ReplayBufferBounds } from '../../sdk/replay-buffer';
import { utf8ByteLength } from '../../sdk/utf8';
import type { TaroReplayCapture, TaroReplayEvent } from '../types';

export { boundReplayEvents, type ReplayBufferBounds };

function eventBytes(event: TaroReplayEvent): number {
  return utf8ByteLength(JSON.stringify(event));
}

/** Prepare one bounded, playable upload across visible page roots. */
export function mergeBufferedCaptures(
  captures: readonly TaroReplayCapture[],
  bounds: ReplayBufferBounds,
  replayId?: string,
): TaroReplayCapture | undefined {
  const last = captures[captures.length - 1];
  if (!last) return undefined;
  const events = boundReplayEvents(
    captures.flatMap((capture) => capture.events),
    bounds,
  );
  if (!events.length) return undefined;
  const cutoff = bounds.now - Math.max(0, bounds.windowMs);
  const checkpoint = events.findIndex((event) => event.type === 2);
  const snapshot = events[checkpoint];
  if (snapshot && snapshot.timestamp < cutoff) {
    // An unchanged DOM still needs a playable baseline, but its original
    // creation time must not turn a 60s error buffer into an hours-long replay.
    events[checkpoint] = { ...snapshot, timestamp: cutoff };
    if (checkpoint > 0 && events[checkpoint - 1]?.type === 4) {
      events[checkpoint - 1] = { ...events[checkpoint - 1]!, timestamp: cutoff - 1 };
    }
  }
  const approximateBytes = events.reduce((sum, event) => sum + eventBytes(event), 0);
  if (approximateBytes > bounds.maxBytes) return undefined;
  return {
    ...last,
    replayId: replayId || last.replayId,
    startedAt: events[0]?.timestamp ?? last.startedAt,
    endedAt: bounds.now,
    stopReason: 'error',
    events,
    stats: { ...last.stats, eventCount: events.length, approximateBytes },
  };
}
