import { utf8ByteLength, type ReplayEnvelopeOptions } from '../envelope';
import type { TaroReplayCapture } from '../types';
import type { ReplayDeliveryOptions } from './delivery';
import { finiteInteger } from './limits';

export interface PendingReplaySegment {
  capture: TaroReplayCapture;
  options: ReplayEnvelopeOptions;
}

/** Keep the initial recording bounded until the replay is old enough to send. */
export class ReplayInitialSendGate {
  readonly minimumDuration: number;
  readonly #now: () => number;
  readonly #onReady: () => void;
  readonly #getPending: () => { pendingSegments: number; pendingBytes: number };
  readonly #maxSegments: number;
  readonly #maxBytes: number;
  #segments: PendingReplaySegment[] = [];
  #bytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    options: ReplayDeliveryOptions & {
      minReplayDuration?: number;
      now(): number;
      onReady(): void;
      getPending(): { pendingSegments: number; pendingBytes: number };
    },
  ) {
    this.minimumDuration = finiteInteger(options.minReplayDuration, 4999, 0, 50_000);
    this.#maxSegments = finiteInteger(options.maxPendingSegments, 4, 1, 32);
    this.#maxBytes = finiteInteger(options.maxPendingBytes, 2 * 1024 * 1024, 1, 16 * 1024 * 1024);
    this.#now = options.now;
    this.#onReady = options.onReady;
    this.#getPending = options.getPending;
  }

  isReady(startedAt: number | undefined): boolean {
    return startedAt !== undefined && this.#now() - startedAt >= this.minimumDuration;
  }

  defer(segment: PendingReplaySegment, startedAt: number): boolean {
    if (this.isReady(startedAt)) return false;
    const bytes = utf8ByteLength(JSON.stringify(segment.capture));
    const pending = this.#getPending();
    if (
      this.#segments.length + pending.pendingSegments >= this.#maxSegments ||
      this.#bytes + pending.pendingBytes + bytes > this.#maxBytes
    ) {
      throw new Error('Replay delivery queue limit exceeded before minimum duration');
    }
    this.#segments.push(segment);
    this.#bytes += bytes;
    if (this.#timer === undefined) {
      this.#timer = setTimeout(
        () => {
          this.#timer = undefined;
          this.#onReady();
        },
        Math.max(1, startedAt + this.minimumDuration - this.#now()),
      );
    }
    return true;
  }

  take(): PendingReplaySegment[] {
    const segments = this.#segments;
    this.clear();
    return segments;
  }

  clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#segments = [];
    this.#bytes = 0;
  }

  getSnapshot(): { pendingSegments: number; pendingBytes: number } {
    return { pendingSegments: this.#segments.length, pendingBytes: this.#bytes };
  }
}
