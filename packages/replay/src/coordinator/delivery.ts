import {
  ReplayCompression,
  type ReplayCompressionOptions,
  type ReplayCompressionSnapshot,
} from '../compression';
import { sendReplayCapture, utf8ByteLength, type ReplayEnvelopeOptions } from '../envelope';
import { finiteInteger } from './limits';
import type { SentryReplayClient, TaroReplayCapture } from '../types';

export interface ReplayDeliverySnapshot {
  pendingSegments: number;
  pendingBytes: number;
  acceptedSegments: number;
  handedOffSegments: number;
  droppedSegments: number;
  retryCount: number;
  compression?: ReplayCompressionSnapshot;
  lastStatus?: 'accepted' | 'handed-off' | 'rejected' | 'cancelled';
  lastStatusCode?: number;
}
export interface ReplayDeliveryOptions {
  maxPendingSegments?: number;
  maxPendingBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}
interface PendingSegment {
  capture: TaroReplayCapture;
  options: ReplayEnvelopeOptions;
  bytes: number;
  generation: number;
  resolve(): void;
  reject(error: unknown): void;
}

/** One bounded delivery queue. Never bypasses the client's consent/offline transport. */
export class ReplayDelivery {
  readonly #client: SentryReplayClient;
  readonly #compression: ReplayCompression;
  readonly #onChange: () => void;
  readonly #isEnabled: () => boolean;
  readonly #limits: {
    maxPendingSegments: number;
    maxPendingBytes: number;
    maxRetries: number;
    retryDelayMs: number;
  };
  #queue: PendingSegment[] = [];
  #generation = 0;
  #running = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #cancelRetry: (() => void) | undefined;
  #snapshot: ReplayDeliverySnapshot = {
    pendingSegments: 0,
    pendingBytes: 0,
    acceptedSegments: 0,
    handedOffSegments: 0,
    droppedSegments: 0,
    retryCount: 0,
  };

  constructor(
    client: SentryReplayClient,
    options: ReplayDeliveryOptions & {
      compression?: ReplayCompressionOptions;
      onChange(): void;
      isEnabled(): boolean;
    },
  ) {
    this.#client = client;
    this.#compression = new ReplayCompression(options.compression);
    this.#onChange = options.onChange;
    this.#isEnabled = options.isEnabled;
    this.#limits = {
      maxPendingSegments: finiteInteger(options.maxPendingSegments, 4, 1, 32),
      maxPendingBytes: finiteInteger(options.maxPendingBytes, 2 * 1024 * 1024, 1, 16 * 1024 * 1024),
      maxRetries: finiteInteger(options.maxRetries, 2, 0, 3),
      retryDelayMs: finiteInteger(options.retryDelayMs, 1000, 0, 60_000),
    };
  }

  getSnapshot(): ReplayDeliverySnapshot {
    return { ...this.#snapshot, compression: this.#compression.getSnapshot() };
  }

  enqueue(capture: TaroReplayCapture, options: ReplayEnvelopeOptions): Promise<void> {
    if (!capture.events.length) return Promise.resolve();
    const bytes = utf8ByteLength(JSON.stringify(capture));
    if (
      this.#queue.length >= this.#limits.maxPendingSegments ||
      this.#snapshot.pendingBytes + bytes > this.#limits.maxPendingBytes
    ) {
      this.#snapshot.droppedSegments++;
      this.#snapshot.lastStatus = 'rejected';
      this.#client.recordDroppedEvent?.('queue_overflow', 'replay');
      this.#onChange();
      return Promise.reject(new Error('Replay delivery queue limit exceeded'));
    }
    const completion = new Promise<void>((resolve, reject) => {
      this.#queue.push({ capture, options, bytes, generation: this.#generation, resolve, reject });
      this.#snapshot.pendingSegments++;
      this.#snapshot.pendingBytes += bytes;
    });
    void this.#drain();
    return completion;
  }

  releaseWorker(): void {
    this.#compression.reset();
  }

  cancel(): void {
    this.releaseWorker();
    this.#generation++;
    for (const item of this.#queue) item.resolve();
    this.#queue = [];
    this.#snapshot.pendingBytes = 0;
    this.#snapshot.pendingSegments = 0;
    this.#snapshot.lastStatus = 'cancelled';
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length) {
        const item = this.#queue[0]!;
        try {
          if (this.#compression.enabled && !item.options.recording) {
            const events = JSON.stringify(item.capture.events);
            const compressed = await this.#compression.compress(events, utf8ByteLength(events));
            const header = `${JSON.stringify({ segment_id: item.options.segmentId || 0 })}\n`;
            if (compressed) {
              // segment_id is numeric: the recording header is always ASCII.
              const recording = new Uint8Array(header.length + compressed.length);
              for (let index = 0; index < header.length; index++)
                recording[index] = header.charCodeAt(index);
              recording.set(compressed, header.length);
              item.options = { ...item.options, recording };
            } else item.options = { ...item.options, recording: header + events };
          }
          for (let attempt = 0; ; attempt++) {
            if (item.generation !== this.#generation || !this.#isEnabled()) break;
            let result;
            try {
              result = await sendReplayCapture(
                this.#client,
                item.capture,
                item.options,
                () => item.generation === this.#generation && this.#isEnabled(),
              );
            } catch (error) {
              if (item.generation !== this.#generation) break;
              if (attempt >= this.#limits.maxRetries) throw error;
              this.#snapshot.retryCount++;
              await new Promise<void>((resolve) => {
                this.#cancelRetry = resolve;
                this.#retryTimer = setTimeout(resolve, this.#limits.retryDelayMs * (attempt + 1));
              });
              this.#retryTimer = undefined;
              this.#cancelRetry = undefined;
              continue;
            }
            if (item.generation !== this.#generation) break;
            this.#snapshot.lastStatus = result.status;
            if (result.statusCode !== undefined) this.#snapshot.lastStatusCode = result.statusCode;
            else delete this.#snapshot.lastStatusCode;
            if (result.status === 'cancelled') break;
            if (result.status === 'rejected')
              throw new Error(`Replay transport rejected segment (${result.statusCode})`);
            if (result.status === 'accepted') this.#snapshot.acceptedSegments++;
            else this.#snapshot.handedOffSegments++;
            break;
          }
          item.resolve();
        } catch (error) {
          if (item.generation === this.#generation) {
            this.#snapshot.droppedSegments++;
            this.#snapshot.lastStatus = 'rejected';
            // Later incremental segments depend on this one. Do not send a broken chain.
            const abandoned = this.#queue.splice(1);
            for (const later of abandoned) {
              this.#snapshot.pendingSegments--;
              this.#snapshot.pendingBytes -= later.bytes;
              this.#snapshot.droppedSegments++;
              later.reject(error);
            }
          }
          item.reject(error);
        } finally {
          if (this.#queue[0] === item) {
            this.#queue.shift();
            this.#snapshot.pendingSegments--;
            this.#snapshot.pendingBytes -= item.bytes;
          }
          this.#onChange();
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
