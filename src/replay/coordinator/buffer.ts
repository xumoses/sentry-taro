import { boundReplayEvents, type ReplayBufferBounds } from '../recorder/buffer';
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

interface BufferHistoryContext {
  now(): number;
  limits(): { rollingWindowMs: number; maxEvents: number; maxBytes: number };
  replayId(): string | undefined;
}

/** Error-buffer captures from earlier visible roots, kept within the buffer bounds. */
export class ReplayBufferHistory {
  readonly #context: BufferHistoryContext;
  #captures: TaroReplayCapture[] = [];

  constructor(context: BufferHistoryContext) {
    this.#context = context;
  }

  get length(): number {
    return this.#captures.length;
  }

  list(): TaroReplayCapture[] {
    return [...this.#captures];
  }

  clear(): void {
    this.#captures = [];
  }

  /** One bounded, playable capture from the history plus the live root's capture. */
  merge(current?: TaroReplayCapture): TaroReplayCapture | undefined {
    const limits = this.#context.limits();
    return mergeBufferedCaptures(
      [...this.#captures, ...(current ? [current] : [])],
      {
        now: this.#context.now(),
        windowMs: limits.rollingWindowMs,
        maxEvents: limits.maxEvents,
        maxBytes: limits.maxBytes,
      },
      this.#context.replayId(),
    );
  }

  store(capture: TaroReplayCapture): void {
    const bounded = this.merge(capture);
    this.#captures = bounded ? [bounded] : [];
  }

  /** Drop older page history when it and the live root together exceed the bounds. */
  bound(current: Pick<TaroReplayCapture['stats'], 'eventCount' | 'approximateBytes'>): void {
    if (!this.#captures.length) return;
    const limits = this.#context.limits();
    const historyBytes = this.#captures.reduce(
      (sum, capture) => sum + capture.stats.approximateBytes,
      0,
    );
    const historyEvents = this.#captures.reduce((sum, capture) => sum + capture.events.length, 0);
    if (
      historyBytes + current.approximateBytes > limits.maxBytes ||
      historyEvents + current.eventCount > limits.maxEvents
    ) {
      // A new visible root has its own playable baseline. Under pressure, drop
      // older page history as a whole instead of retaining two near-limit DOMs.
      this.#captures = [];
    }
  }
}
