import { withNetworkOptionsSnapshot } from '../network-config';
import { snapshotNetworkOptions } from '../network-details';
import type { FeedbackEvent } from '@sentry/core';
import { sanitizeUrl } from '../privacy';
import { createTaroReplay } from '../createTaroReplay';
import { utf8ByteLength } from '../envelope';
import type {
  TaroReplayCapture,
  TaroReplayHandle,
  TaroReplayLimitOptions,
  TaroReplayNodeLike,
  TaroReplayRuntime,
} from '../types';
import { boundReplayEvents } from './buffer';
import { finiteInteger } from './limits';
import { ReplayDelivery } from './delivery';
import type {
  ReplayAwareEvent,
  ReplayCoordinatorOptions,
  ReplayCoordinatorSnapshot,
  ReplayCoordinatorState,
  TaroReplayBridge,
} from './types';

const DEFAULT_LIMITS = {
  maxDurationMs: 5 * 60_000,
  maxEvents: 500,
  mutationLimit: 10_000,
  maxBytes: 512 * 1024,
  rollingWindowMs: 30_000,
};
const clampRate = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value || 0)) : 0;
const sampled = (rate: number, random: () => number): boolean =>
  rate > 0 && (rate >= 1 || random() < rate);
const errorValue = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));
function replayId(random: () => number): string {
  let value = '';
  for (let index = 0; index < 32; index++) value += Math.floor(random() * 16).toString(16);
  return value;
}

function currentRoot(runtime: TaroReplayRuntime): TaroReplayNodeLike | undefined {
  const router = runtime.getCurrentInstance().router;
  const id = router?.$taroPath || router?.path;
  return id
    ? runtime.document.getElementById(id) ||
        runtime.document.getElementById(sanitizeUrl(id).replace(/^\/+/, '')) ||
        undefined
    : undefined;
}

function belongsToRoot(node: TaroReplayNodeLike, root: TaroReplayNodeLike): boolean {
  const visited = new Set<TaroReplayNodeLike>();
  let ancestor: TaroReplayNodeLike | null | undefined = node;
  while (ancestor && !visited.has(ancestor)) {
    if (ancestor === root) return true;
    visited.add(ancestor);
    const parent: TaroReplayNodeLike | null | undefined = ancestor.parentNode;
    if (parent?.childNodes && !parent.childNodes.includes(ancestor)) return false;
    ancestor = parent;
  }
  return false;
}

/** Owns exactly one visible root; transport completion never changes recording ownership. */
export class ReplayCoordinator implements TaroReplayBridge {
  readonly #options: ReplayCoordinatorOptions;
  readonly #listeners = new Set<(snapshot: ReplayCoordinatorSnapshot) => void>();
  readonly #random: () => number;
  readonly #sampledMode: 'session' | 'buffer' | 'disabled';
  readonly #delivery: ReplayDelivery;
  #state: ReplayCoordinatorState = 'disabled';
  #replayId: string | undefined;
  #replayStartedAt: number | undefined;
  #sessionDeadline: number | undefined;
  #errorMode = false;
  #handle: TaroReplayHandle | undefined;
  #rootRuntime: TaroReplayRuntime | undefined;
  #canvasRoot: TaroReplayNodeLike | undefined;
  #rootVersion = 0;
  #generation = 0;
  #destroyed = false;
  #captures: TaroReplayCapture[] = [];
  #pendingErrorIds: string[] = [];
  #pendingTraceIds: string[] = [];
  #pendingSegmentNames: string[] = [];
  #errorEventId: string | undefined;
  #sentReplayId: string | undefined;
  #error: Error | undefined;
  #detachErrorHook: (() => void) | undefined;
  #detachFeedbackHook: (() => void) | undefined;
  #segmentId = 0;
  #segmentTimer: ReturnType<typeof setTimeout> | undefined;
  #lastDelivery: Promise<void> = Promise.resolve();

  constructor(options: ReplayCoordinatorOptions) {
    this.#options = withNetworkOptionsSnapshot(options);
    this.#random = options.random || Math.random;
    this.#sampledMode = this.#enabled()
      ? sampled(clampRate(options.replaysSessionSampleRate), this.#random)
        ? 'session'
        : clampRate(options.replaysOnErrorSampleRate) > 0
          ? 'buffer'
          : 'disabled'
      : 'disabled';
    this.#delivery = new ReplayDelivery(options.client, {
      ...options.delivery,
      ...(options.compression ? { compression: options.compression } : {}),
      onChange: () => this.#notify(),
      isEnabled: () => this.refreshEnabled(),
    });
    if (this.#sampledMode !== 'disabled') this.#newReplay(this.#sampledMode);
    if (this.#state !== 'disabled') this.#attachErrorHook();
  }

  #enabled(): boolean {
    if (this.#destroyed) return false;
    try {
      return typeof this.#options.enabled === 'function'
        ? this.#options.enabled()
        : this.#options.enabled !== false;
    } catch (cause) {
      this.#error = errorValue(cause);
      return false;
    }
  }

  #attachErrorHook(): void {
    if (this.#detachErrorHook || !this.#enabled()) return;
    this.#detachErrorHook = this.#options.client.on?.('beforeSendEvent', (event) => {
      try {
        this.#beforeSendEvent(event);
      } catch (cause) {
        this.#reportError(cause);
      }
    });
    this.#detachFeedbackHook = this.#options.client.on?.('beforeSendFeedback', (event, options) => {
      try {
        this.#beforeSendFeedback(event, options?.includeReplay === true);
      } catch (cause) {
        this.#reportError(cause);
      }
    });
  }

  #now(): number {
    return (this.#options.now || Date.now)();
  }
  #limits(): Required<TaroReplayLimitOptions> {
    const limits = this.#options.limits;
    return {
      maxDurationMs: finiteInteger(
        limits?.maxDurationMs,
        DEFAULT_LIMITS.maxDurationMs,
        1,
        60 * 60_000,
      ),
      maxEvents: finiteInteger(limits?.maxEvents, DEFAULT_LIMITS.maxEvents, 1, 100_000),
      mutationLimit: finiteInteger(limits?.mutationLimit, DEFAULT_LIMITS.mutationLimit, 1, 100_000),
      maxBytes: finiteInteger(limits?.maxBytes, DEFAULT_LIMITS.maxBytes, 1, 20 * 1024 * 1024),
      rollingWindowMs: finiteInteger(
        limits?.rollingWindowMs,
        DEFAULT_LIMITS.rollingWindowMs,
        0,
        60_000,
      ),
    };
  }
  #clearTimer(): void {
    if (this.#segmentTimer) clearTimeout(this.#segmentTimer);
    this.#segmentTimer = undefined;
  }

  #newReplay(mode: 'session' | 'buffer'): void {
    this.#replayId = replayId(this.#random);
    this.#replayStartedAt = undefined;
    this.#sessionDeadline = undefined;
    this.#segmentId = 0;
    this.#state = mode;
    this.#errorMode = mode === 'buffer';
    this.#captures = [];
    this.#pendingErrorIds = [];
    this.#pendingTraceIds = [];
    this.#pendingSegmentNames = [];
    this.#errorEventId = undefined;
  }

  attachRoot(runtime: TaroReplayRuntime): boolean {
    if (!this.refreshEnabled() || (this.#state !== 'session' && this.#state !== 'buffer'))
      return false;
    this.detachRoot();
    this.#rootRuntime = runtime;
    if (
      this.#state === 'session' &&
      this.#sessionDeadline !== undefined &&
      this.#now() >= this.#sessionDeadline
    ) {
      this.#newReplay(this.#errorMode ? 'buffer' : 'session');
    }
    return this.#startRoot(runtime);
  }

  #startRoot(runtime: TaroReplayRuntime): boolean {
    if (
      this.#handle ||
      !this.refreshEnabled() ||
      !this.#rootRuntime ||
      (this.#state !== 'session' && this.#state !== 'buffer')
    )
      return false;
    const owner = ++this.#rootVersion;
    try {
      this.#canvasRoot = this.#options.recordCanvas === true ? currentRoot(runtime) : undefined;
      if (this.#state === 'session' && this.#sessionDeadline === undefined)
        this.#sessionDeadline = this.#now() + this.#limits().maxDurationMs;
      const handle = createTaroReplay({
        sdk: this.#options.sdk,
        runtime,
        ...snapshotNetworkOptions(this.#options),
        recordCanvas: this.#options.recordCanvas === true,
        ...(this.#replayId ? { replayId: this.#replayId } : {}),
        ...(this.#options.privacy ? { privacy: this.#options.privacy } : {}),
        ...(this.#options.getMetadata ? { getMetadata: this.#options.getMetadata } : {}),
        limits: this.#recordingLimits(),
        sendOnManualStop: false,
        sendOnDurationStop: false,
        sendOnDispose: false,
        onCapture: (capture) => this.#onCapture(capture, owner),
        onBufferChange: (stats) => {
          if (owner === this.#rootVersion) this.#boundBufferedHistory(stats);
        },
        onBufferFull: () => {
          // Drain synchronously before the pending event retries. No snapshot or
          // observer restart is needed; queued data remains bounded independently.
          if (owner === this.#rootVersion && this.#state === 'session') this.#flushSegment();
        },
        onError: (cause) => this.#reportError(cause),
      });
      this.#handle = handle;
      const attached = handle.start();
      if (!attached && this.#handle === handle) {
        this.#handle = undefined;
        handle.dispose();
      }
      if (attached) {
        if (this.#captures.length) {
          const initial = handle.getController()?.getCapture();
          if (initial) this.#boundBufferedHistory(initial.stats);
        }
        this.#error = undefined;
        this.#armSegmentTimer();
      }
      this.#notify();
      return attached;
    } catch (cause) {
      this.#reportError(cause);
      return false;
    }
  }

  #recordingLimits(): TaroReplayLimitOptions {
    const limits = this.#limits();
    if (this.#state === 'buffer') return limits;
    const { rollingWindowMs: _window, ...sessionLimits } = limits;
    return {
      ...sessionLimits,
      maxDurationMs: Math.max(
        1,
        (this.#sessionDeadline ?? this.#now() + limits.maxDurationMs) - this.#now(),
      ),
    };
  }

  #releaseRoot(): TaroReplayCapture | undefined {
    this.#clearTimer();
    this.#rootVersion++;
    this.#canvasRoot = undefined;
    const handle = this.#handle;
    this.#handle = undefined;
    if (!handle) return undefined;
    const capture = handle.getController()?.getCapture();
    handle.dispose();
    return capture ? { ...capture, endedAt: this.#now() } : undefined;
  }

  detachRoot(): void {
    this.#rootRuntime = undefined;
    const capture = this.#releaseRoot();
    if (capture) {
      if (this.#state === 'session') this.#enqueue({ ...capture, stopReason: 'root-detach' });
      else if (this.#state === 'buffer') this.#storeBufferedCapture(capture);
    }
    this.#notify();
  }

  #armSegmentTimer(): void {
    this.#clearTimer();
    if (this.#state !== 'session' || !this.#handle) return;
    const owner = this.#rootVersion;
    const interval = finiteInteger(this.#options.flushIntervalMs, 5000, 1000, 60 * 60_000);
    this.#segmentTimer = setTimeout(() => {
      this.#segmentTimer = undefined;
      if (owner !== this.#rootVersion || !this.refreshEnabled()) return;
      this.#flushSegment();
      this.#armSegmentTimer();
    }, interval);
  }

  #flushSegment(): void {
    if (this.#state !== 'session' || !this.#handle) return;
    const controller = this.#handle.getController();
    if (controller?.takeSegment) {
      this.#enqueue(controller.takeSegment());
    } else {
      const capture = this.#releaseRoot();
      if (capture) this.#enqueue({ ...capture, stopReason: 'segment' });
      if (this.#rootRuntime) this.#startRoot(this.#rootRuntime);
    }
  }

  async flush(): Promise<void> {
    if (!this.refreshEnabled() || this.#state !== 'session') return;
    this.#flushSegment();
    await this.#lastDelivery;
  }

  async sendBufferedReplay(): Promise<void> {
    if (!this.refreshEnabled() || this.#state !== 'buffer' || !this.#handle || !this.#rootRuntime)
      return;
    const capture = this.#mergeBufferedCaptures([
      ...this.#captures,
      this.#handle.getController()!.getCapture(),
    ]);
    if (!capture) return;
    this.#promote(capture);
    await this.#lastDelivery;
  }

  start(): boolean {
    return this.#manualStart('session');
  }
  startBuffering(): boolean {
    return this.#manualStart('buffer');
  }
  #manualStart(mode: 'session' | 'buffer'): boolean {
    if (!this.#enabled()) return false;
    if (this.#state === 'session' || this.#state === 'buffer') return true;
    this.#newReplay(mode);
    this.#attachErrorHook();
    if (this.#rootRuntime) this.#startRoot(this.#rootRuntime);
    this.#notify();
    return true;
  }

  async stop({ flush = true }: { flush?: boolean } = {}): Promise<void> {
    const generation = this.#generation;
    const stoppedReplayId = this.#replayId;
    const capture = this.#releaseRoot();
    const shouldFlush = flush && this.#state === 'session' && this.#enabled();
    this.#state = 'stopped';
    this.#captures = [];
    if (capture && shouldFlush) this.#enqueue(capture);
    if (!shouldFlush) {
      this.#generation++;
      this.#delivery.cancel();
    }
    this.#rootRuntime = undefined;
    this.#pendingErrorIds = [];
    this.#pendingTraceIds = [];
    this.#pendingSegmentNames = [];
    this.#detachErrorHook?.();
    this.#detachErrorHook = undefined;
    this.#detachFeedbackHook?.();
    this.#detachFeedbackHook = undefined;
    this.#notify();
    if (shouldFlush) await this.#lastDelivery;
    if (
      generation === this.#generation &&
      stoppedReplayId === this.#replayId &&
      this.#state === 'stopped'
    )
      this.#delivery.releaseWorker();
  }

  reset(): void {
    this.#generation++;
    this.#rootRuntime = undefined;
    this.#releaseRoot();
    this.#delivery.cancel();
    this.#captures = [];
    this.#pendingErrorIds = [];
    this.#pendingTraceIds = [];
    this.#pendingSegmentNames = [];
    this.#error = undefined;
    this.#sentReplayId = undefined;
    this.#errorEventId = undefined;
    if (this.#enabled() && this.#sampledMode !== 'disabled') {
      this.#newReplay(this.#sampledMode);
      this.#attachErrorHook();
    } else {
      this.#state = 'disabled';
      this.#replayId = undefined;
    }
    this.#notify();
  }

  destroy(): void {
    this.#destroyed = true;
    this.reset();
    this.#detachErrorHook?.();
    this.#detachErrorHook = undefined;
    this.#detachFeedbackHook?.();
    this.#detachFeedbackHook = undefined;
    this.#listeners.clear();
  }

  refreshEnabled(): boolean {
    if (this.#enabled()) return this.#state !== 'disabled';
    if (this.#state !== 'disabled' || this.#handle) {
      this.#generation++;
      this.#rootRuntime = undefined;
      this.#releaseRoot();
      this.#captures = [];
      this.#pendingErrorIds = [];
      this.#pendingTraceIds = [];
      this.#pendingSegmentNames = [];
      this.#delivery.cancel();
      this.#state = 'disabled';
      this.#detachErrorHook?.();
      this.#detachErrorHook = undefined;
      this.#detachFeedbackHook?.();
      this.#detachFeedbackHook = undefined;
      this.#notify();
    }
    return false;
  }

  getReplayId(): string | undefined {
    return this.#state === 'session' || this.#state === 'buffer' ? this.#replayId : undefined;
  }
  recordPageScroll(position: { scrollTop?: number; scrollLeft?: number }): void {
    if (this.#rootRuntime && this.refreshEnabled())
      this.#handle?.getController()?.recordPageScroll?.(position);
  }
  recordViewport(size: { width: number; height: number }): void {
    if (this.#rootRuntime && this.refreshEnabled())
      this.#handle?.getController()?.recordViewport?.(size);
  }
  recordCanvas(id: string, readFrame: () => string | undefined): boolean {
    if (
      this.#options.recordCanvas !== true ||
      !this.refreshEnabled() ||
      (this.#state !== 'session' && this.#state !== 'buffer')
    )
      return false;
    const runtime = this.#rootRuntime;
    const root = this.#canvasRoot;
    const handle = this.#handle;
    const owner = this.#rootVersion;
    const controller = handle?.getController();
    if (!runtime || !root || !controller?.recordCanvas) return false;
    try {
      const node = runtime.document.getElementById(id);
      if (!node || currentRoot(runtime) !== root || !belongsToRoot(node, root)) return false;
      return (
        controller.recordCanvas(node, () => {
          // The SDK decides when it is safe to read. Recheck ownership at that point,
          // including synchronous navigation or a runtime kill switch during resolution.
          try {
            const mayRead = (): boolean =>
              this.#rootVersion === owner &&
              this.#handle === handle &&
              this.#rootRuntime === runtime &&
              this.#canvasRoot === root &&
              this.#enabled() &&
              (this.#state === 'session' || this.#state === 'buffer') &&
              currentRoot(runtime) === root &&
              belongsToRoot(node, root);
            if (!mayRead()) return undefined;
            const frame = readFrame();
            return mayRead() ? frame : undefined;
          } catch {
            return undefined;
          }
        }) === true
      );
    } catch {
      // Frame capture is observational; a host or SDK reader must not break drawing.
      return false;
    }
  }

  #beforeSendEvent(event: ReplayAwareEvent): void {
    if (
      !this.refreshEnabled() ||
      !this.#rootRuntime ||
      !this.#handle ||
      (this.#state !== 'buffer' && this.#state !== 'session') ||
      !event.event_id
    )
      return;
    if (event.type === 'transaction') {
      this.#rememberTrace(event);
      if (this.#state === 'session') this.#associate(event);
      return;
    }
    if (!event.exception?.values?.length) return;
    if (
      this.#state === 'buffer' &&
      ((this.#options.beforeErrorSampling && !this.#options.beforeErrorSampling(event)) ||
        !sampled(clampRate(this.#options.replaysOnErrorSampleRate), this.#random))
    )
      return;
    let prepared: TaroReplayCapture | undefined;
    if (this.#state === 'buffer') {
      const current = this.#handle.getController()?.getCapture();
      prepared = this.#mergeBufferedCaptures([...this.#captures, ...(current ? [current] : [])]);
      if (!prepared) {
        if (event.contexts?.replay?.replay_id === this.#replayId) {
          event.contexts = { ...event.contexts };
          delete event.contexts.replay;
        }
        if (event.tags?.replayId === this.#replayId) {
          event.tags = { ...event.tags };
          delete event.tags.replayId;
        }
        this.#releaseRoot();
        this.#newReplay('buffer');
        this.#notify();
        return;
      }
    }
    this.#errorEventId = event.event_id;
    this.#associate(event);
    if (!prepared)
      this.#handle
        .getController()
        ?.addBreadcrumb?.({ category: 'sentry.error', data: { event_id: event.event_id } });
    if (this.#pendingErrorIds.length < 100 && !this.#pendingErrorIds.includes(event.event_id))
      this.#pendingErrorIds.push(event.event_id);
    this.#rememberTrace(event);
    if (prepared) this.#promote(prepared);
    this.#notify();
  }

  #associate(event: ReplayAwareEvent): void {
    event.contexts = {
      ...event.contexts,
      replay: { ...event.contexts?.replay, replay_id: this.#replayId },
    };
    event.tags = { ...event.tags, replayId: this.#replayId };
  }

  #rememberTrace(event: ReplayAwareEvent): void {
    const id = event.contexts?.trace?.trace_id;
    if (
      id &&
      /^[a-f0-9]{32}$/i.test(id) &&
      this.#pendingTraceIds.length < 100 &&
      !this.#pendingTraceIds.includes(id)
    )
      this.#pendingTraceIds.push(id);
    if (typeof event.transaction === 'string' && this.#pendingSegmentNames.length < 100) {
      const name = sanitizeUrl(event.transaction).slice(0, 200);
      if (name && !this.#pendingSegmentNames.includes(name)) this.#pendingSegmentNames.push(name);
    }
  }

  #beforeSendFeedback(event: FeedbackEvent, includeReplay: boolean): void {
    if (
      !includeReplay ||
      !this.#replayId ||
      !this.refreshEnabled() ||
      !this.#rootRuntime ||
      !this.#handle ||
      !event.contexts?.feedback ||
      (this.#state !== 'session' && this.#state !== 'buffer')
    )
      return;
    if (this.#state === 'buffer') {
      const current = this.#handle.getController()?.getCapture();
      const capture = this.#mergeBufferedCaptures([
        ...this.#captures,
        ...(current ? [current] : []),
      ]);
      if (!capture) return;
      event.contexts.feedback.replay_id = this.#replayId;
      this.#promote(capture);
    } else {
      event.contexts.feedback.replay_id = this.#replayId;
      this.#handle.getController()?.addBreadcrumb?.({ category: 'sentry.feedback' });
      this.#flushSegment();
    }
  }

  #promote(prepared: TaroReplayCapture): void {
    const duration = this.#limits().maxDurationMs;
    const promoted = this.#handle?.getController()?.promoteToSession?.(duration) === true;
    if (!promoted) this.#releaseRoot();
    this.#replayStartedAt = prepared.startedAt;
    this.#enqueue({ ...prepared, endedAt: this.#now(), stopReason: 'error' }, 'buffer');
    this.#captures = [];
    this.#state = 'session';
    this.#sessionDeadline = this.#now() + duration;
    if (promoted) this.#armSegmentTimer();
    else if (this.#rootRuntime) this.#startRoot(this.#rootRuntime);
  }

  #enqueue(capture: TaroReplayCapture, replayType: 'session' | 'buffer' = 'session'): void {
    if (!capture.events.length || !this.#enabled()) return;
    if (this.#segmentId === 0 && !capture.events.some((event) => event.type === 2)) return;
    const generation = this.#generation;
    const id = this.#replayId;
    this.#replayStartedAt ??= capture.startedAt;
    const errorIds = this.#pendingErrorIds.splice(0);
    const traceIds = this.#pendingTraceIds.splice(0);
    const segmentNames = this.#pendingSegmentNames.splice(0);
    const sent = this.#delivery.enqueue(capture, {
      replayType,
      segmentId: this.#segmentId++,
      errorIds,
      traceIds,
      segmentNames,
      replayStartTimestamp: this.#replayStartedAt,
    });
    this.#lastDelivery = sent;
    void sent
      .then(() => {
        if (generation !== this.#generation) return;
        if (this.#delivery.getSnapshot().lastStatus === 'accepted')
          this.#sentReplayId = capture.replayId;
        this.#notify();
      })
      .catch((cause) => {
        if (generation !== this.#generation || id !== this.#replayId) return;
        this.#releaseRoot();
        this.#captures = [];
        this.#pendingErrorIds = [];
        this.#pendingTraceIds = [];
        this.#pendingSegmentNames = [];
        this.#state = 'error';
        this.#delivery.cancel();
        this.#reportError(cause);
      });
  }

  #onCapture(capture: TaroReplayCapture, owner: number): void {
    if (
      owner !== this.#rootVersion ||
      (capture.stopReason !== 'buffer-drain' &&
        capture.stopReason !== 'duration' &&
        capture.stopReason !== 'limit' &&
        capture.stopReason !== 'mutation-limit')
    )
      return;
    this.#clearTimer();
    this.#handle = undefined;
    if (capture.stopReason === 'buffer-drain') {
      this.#captures = [];
      this.#delivery.cancel();
      this.#state = 'error';
      this.#reportError(new Error('Replay session buffer drain failed; recording stopped'));
      return;
    }
    if (capture.stopReason === 'mutation-limit') {
      if (this.#state === 'session') this.#enqueue(capture);
      else if (this.#state === 'buffer') this.#storeBufferedCapture(capture);
      this.#reportError(
        new Error(
          'Replay mutation limit reached; recording paused until the next visible page attach',
        ),
      );
      return;
    }
    if (this.#state === 'buffer') {
      this.#storeBufferedCapture(capture);
      if (capture.stopReason !== 'duration') {
        this.#notify();
        return;
      }
    } else if (this.#state === 'session') {
      if (
        capture.stopReason === 'limit' &&
        !capture.events.some((event) => event.type === 3 || event.type === 5)
      ) {
        this.#reportError(new Error('Replay checkpoint exhausted the recording limit'));
        return;
      }
      this.#enqueue(capture);
      if (capture.stopReason === 'duration')
        this.#newReplay(this.#errorMode ? 'buffer' : 'session');
    } else return;
    // Defer only resource restart so synchronous SDK startup limits cannot re-enter start().
    void Promise.resolve().then(() => {
      if (owner === this.#rootVersion && this.#rootRuntime && !this.#handle)
        this.#startRoot(this.#rootRuntime);
    });
  }

  #mergeBufferedCaptures(
    captures: readonly TaroReplayCapture[] = this.#captures,
  ): TaroReplayCapture | undefined {
    if (!captures.length) return undefined;
    const last = captures[captures.length - 1]!;
    const limits = this.#limits();
    const events = boundReplayEvents(
      captures.flatMap((capture) => capture.events),
      {
        now: this.#now(),
        windowMs: limits.rollingWindowMs,
        maxEvents: limits.maxEvents,
        maxBytes: limits.maxBytes,
      },
    );
    if (!events.length) return undefined;
    return {
      ...last,
      replayId: this.#replayId || last.replayId,
      startedAt: events[0]?.timestamp ?? last.startedAt,
      endedAt: this.#now(),
      stopReason: 'error',
      events,
      stats: {
        ...last.stats,
        eventCount: events.length,
        approximateBytes: events.reduce(
          (sum, event) => sum + utf8ByteLength(JSON.stringify(event)),
          0,
        ),
      },
    };
  }
  #boundBufferedHistory(
    current: Pick<TaroReplayCapture['stats'], 'eventCount' | 'approximateBytes'>,
  ): void {
    if (this.#state !== 'buffer' || !this.#captures.length) return;
    const limits = this.#limits();
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

  #storeBufferedCapture(capture: TaroReplayCapture): void {
    const bounded = this.#mergeBufferedCaptures([...this.#captures, capture]);
    this.#captures = bounded ? [bounded] : [];
  }
  #reportError(cause: unknown): void {
    this.#error = errorValue(cause);
    try {
      this.#options.onError?.(this.#error);
    } catch {
      /* Diagnostic hooks cannot affect the host. */
    }
    this.#notify();
  }

  getSnapshot(): ReplayCoordinatorSnapshot {
    const captures = [...this.#captures];
    const current = this.#handle?.getController()?.getCapture();
    if (current) captures.push(current);
    return {
      state: this.#state,
      ...(this.#replayId ? { replayId: this.#replayId } : {}),
      ...(this.#errorEventId ? { errorEventId: this.#errorEventId } : {}),
      ...(this.#sentReplayId ? { sentReplayId: this.#sentReplayId } : {}),
      eventCount: captures.reduce((sum, capture) => sum + capture.events.length, 0),
      approximateBytes: captures.reduce((sum, capture) => sum + capture.stats.approximateBytes, 0),
      recording: Boolean(this.#handle),
      delivery: this.#delivery.getSnapshot(),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
  subscribe(listener: (snapshot: ReplayCoordinatorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch {
      /* UI diagnostics are isolated. */
    }
    return () => this.#listeners.delete(listener);
  }
  #notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        /* UI diagnostics are isolated. */
      }
    }
  }
}
