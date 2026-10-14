import { decodeBase64 } from './worker/base64';
import { finiteInteger } from './coordinator/limits';

export interface ReplayWorker {
  postMessage(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): void;
  onProcessKilled?(listener: () => void): void;
  onError?(listener: (error: unknown) => void): void;
  terminate(): void;
}
export interface ReplayCompressionOptions {
  /** Packaged script under the host app.json workers directory. */
  workerPath: string;
  /** Defaults to wx.createWorker. Injection permits hosts already owning a worker factory. */
  createWorker?: (path: string) => ReplayWorker;
  /** Bounds startup and each compression operation separately. Default 2000ms. */
  timeoutMs?: number;
}
export interface ReplayCompressionSnapshot {
  state: 'disabled' | 'idle' | 'ready' | 'fallback';
  compressedSegments: number;
  fallbackSegments: number;
  inputBytes: number;
  outputBytes: number;
}
declare const wx: { createWorker?: (path: string) => ReplayWorker } | undefined;

/** Owned by the serial delivery queue; workers never observe DOM or unsanitized inputs. */
export class ReplayCompression {
  readonly #options: ReplayCompressionOptions | undefined;
  #worker: ReplayWorker | undefined;
  #id = 0;
  #generation = 0;
  #pending:
    | { id: number; method: string; finish(message?: Record<string, unknown>): void }
    | undefined;
  #snapshot: ReplayCompressionSnapshot;

  constructor(options?: ReplayCompressionOptions) {
    this.#options = options ? { ...options } : undefined;
    this.#snapshot = {
      state: options ? 'idle' : 'disabled',
      compressedSegments: 0,
      fallbackSegments: 0,
      inputBytes: 0,
      outputBytes: 0,
    };
  }
  getSnapshot(): ReplayCompressionSnapshot {
    return { ...this.#snapshot };
  }
  get enabled(): boolean {
    return this.#options !== undefined;
  }

  reset(): void {
    this.#generation++;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.finish();
    const worker = this.#worker;
    this.#worker = undefined;
    try {
      worker?.terminate();
    } catch {
      /* The host may already have killed it. */
    }
    this.#snapshot.state = this.#options ? 'idle' : 'disabled';
  }
  #fail(): void {
    this.reset();
    this.#snapshot.state = 'fallback';
  }
  #request(method: string, data?: string): Promise<Record<string, unknown> | undefined> {
    const worker = this.#worker;
    if (!worker || this.#pending) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = ++this.#id;
      const timer = setTimeout(
        () => this.#fail(),
        finiteInteger(this.#options?.timeoutMs, 2000, 50, 10_000),
      );
      const finish = (message?: Record<string, unknown>): void => {
        clearTimeout(timer);
        if (this.#pending?.id === id) this.#pending = undefined;
        resolve(message);
      };
      this.#pending = { id, method, finish };
      try {
        worker.postMessage({ protocol: 1, id, method, ...(data === undefined ? {} : { data }) });
      } catch {
        this.#fail();
      }
    });
  }
  async #ready(): Promise<boolean> {
    if (!this.#options || this.#snapshot.state === 'fallback') return false;
    if (this.#snapshot.state === 'ready') return true;
    try {
      const factory =
        this.#options.createWorker ||
        (typeof wx !== 'undefined' && wx?.createWorker
          ? (path: string) => wx!.createWorker!(path)
          : undefined);
      if (!factory || !this.#options.workerPath) {
        this.#fail();
        return false;
      }
      const worker = factory(this.#options.workerPath);
      this.#worker = worker;
      worker.onMessage((message) => {
        if (this.#worker !== worker || !message || message['protocol'] !== 1) return;
        const pending = this.#pending;
        if (pending && message['id'] === pending.id && message['method'] === pending.method)
          pending.finish(message);
      });
      const fail = (): void => {
        if (this.#worker === worker) this.#fail();
      };
      worker.onProcessKilled?.(fail);
      worker.onError?.(fail);
      const reply = await this.#request('init');
      if (this.#worker !== worker || reply?.['success'] !== true) {
        if (this.#worker === worker) this.#fail();
        return false;
      }
      this.#snapshot.state = 'ready';
      return true;
    } catch {
      this.#fail();
      return false;
    }
  }

  async compress(events: string, inputBytes: number): Promise<Uint8Array | undefined> {
    const generation = this.#generation;
    let compressed: Uint8Array | undefined;
    if (await this.#ready()) {
      const reply = await this.#request('compress', events);
      if (generation !== this.#generation && this.#snapshot.state !== 'fallback') return undefined;
      if (reply?.['success'] === true && typeof reply['data'] === 'string') {
        compressed = decodeBase64(reply['data'], inputBytes + 64 * 1024);
        // Require a zlib header, no preset dictionary, and a useful size reduction.
        if (
          !compressed ||
          compressed.length < 6 ||
          compressed[0] !== 0x78 ||
          compressed[1]! & 32 ||
          ((compressed[0]! << 8) + compressed[1]!) % 31
        )
          compressed = undefined;
      }
      if (!compressed) this.#fail();
      else if (compressed.length >= inputBytes) compressed = undefined;
    }
    // A lifecycle reset invalidates in-flight messages; delivery also checks consent.
    if (generation !== this.#generation && this.#snapshot.state !== 'fallback') return undefined;
    this.#snapshot.inputBytes += inputBytes;
    this.#snapshot.outputBytes += compressed?.length ?? inputBytes;
    if (compressed) this.#snapshot.compressedSegments++;
    else this.#snapshot.fallbackSegments++;
    return compressed;
  }
}
