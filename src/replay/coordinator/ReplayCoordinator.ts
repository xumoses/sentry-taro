import { withNetworkOptionsSnapshot } from '../network-config';
import { snapshotNetworkOptions } from '../../sdk/network-details';
import type { FeedbackEvent } from '@sentry/core';
import { createTaroReplay } from '../createTaroReplay';
import type {
  TaroReplayCapture,
  TaroReplayHandle,
  TaroReplayLimitOptions,
  TaroReplayNodeLike,
  TaroReplayRuntime,
} from '../types';
import { ReplayBufferHistory } from './buffer';
import { associateReplay, ReplayEventLinks } from './links';
import { belongsToRoot, currentRoot } from './roots';
import { clampRate, createReplayId, sampled } from './sampling';
import { finiteInteger } from './limits';
import { ReplayDelivery } from './delivery';
import { ReplayInitialSendGate, type PendingReplaySegment } from './send-gate';
import { observeRootActivity, ReplaySessionPolicy } from './session';
import { REPLAY_BUFFER_WINDOW_MS } from '../recorder/constants';
import { defaultReplaySdk } from './default-sdk';
import type {
  ReplayAwareEvent,
  ReplayCoordinatorOptions,
  ReplayCoordinatorSnapshot,
  ReplayCoordinatorState,
  SendBufferedReplayOptions,
  TaroReplayBridge,
} from './types';

const DEFAULT_LIMITS = {
  maxEvents: 500,
  mutationLimit: 10_000,
  maxBytes: 512 * 1024,
  rollingWindowMs: REPLAY_BUFFER_WINDOW_MS,
};
const errorValue = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** Owns exactly one visible root; transport completion never changes recording ownership. */
export class ReplayCoordinator implements TaroReplayBridge {
  readonly #options: ReplayCoordinatorOptions;
  readonly #listeners = new Set<(snapshot: ReplayCoordinatorSnapshot) => void>();
  readonly #random: () => number;
  readonly #sampledMode: 'session' | 'buffer' | 'disabled';
  readonly #delivery: ReplayDelivery;
  readonly #sendGate: ReplayInitialSendGate;
  readonly #session: ReplaySessionPolicy;
  #state: ReplayCoordinatorState = 'disabled';
  #replayId: string | undefined;
  #replayStartedAt: number | undefined;
  #bufferRecordingStopped = false;
  #handle: TaroReplayHandle | undefined;
  #rootRuntime: TaroReplayRuntime | undefined;
  #canvasRoot: TaroReplayNodeLike | undefined;
  #rootVersion = 0;
  #generation = 0;
  #destroyed = false;
  readonly #history = new ReplayBufferHistory({
    now: () => this.#now(),
    limits: () => this.#limits(),
    replayId: () => this.#replayId,
  });
  readonly #links = new ReplayEventLinks();
  #errorEventId: string | undefined;
  #sentReplayId: string | undefined;
  #error: Error | undefined;
  #detachErrorHook: (() => void) | undefined;
  #detachFeedbackHook: (() => void) | undefined;
  #detachActivity: (() => void) | undefined;
  #segmentId = 0;
  #segmentTimer: ReturnType<typeof setTimeout> | undefined;
  #sessionTimer: ReturnType<typeof setTimeout> | undefined;
  #lastDelivery: Promise<void> = Promise.resolve();

  constructor(options: ReplayCoordinatorOptions) {
    this.#options = withNetworkOptionsSnapshot(options);
    this.#random = options.random || Math.random;
    const maxDurationMs = options.maxReplayDuration ?? options.limits?.maxDurationMs;
    this.#session = new ReplaySessionPolicy({
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      ...(options.sessionIdlePauseMs === undefined
        ? {}
        : { idlePauseMs: options.sessionIdlePauseMs }),
      ...(options.sessionIdleExpireMs === undefined
        ? {}
        : { idleExpireMs: options.sessionIdleExpireMs }),
    });
    this.#sampledMode = this.#sampleMode();
    this.#delivery = new ReplayDelivery(options.client, {
      ...options.delivery,
      ...(options.compression ? { compression: options.compression } : {}),
      onChange: () => this.#notify(),
      isEnabled: () => this.refreshEnabled(),
    });
    this.#sendGate = new ReplayInitialSendGate({
      ...options.delivery,
      ...(options.minReplayDuration === undefined
        ? {}
        : { minReplayDuration: options.minReplayDuration }),
      now: () => this.#now(),
      getPending: () => this.#delivery.getSnapshot(),
      onReady: () => {
        if (!this.refreshEnabled() || (this.#state !== 'session' && this.#state !== 'buffer')) {
          this.#sendGate.clear();
          this.#notify();
          return;
        }
        const replayId = this.#replayId;
        if (!this.#checkSession() || replayId !== this.#replayId) return;
        // Match the upstream flush guard for a configuration whose minimum
        // exceeds its maximum, including an unsent buffer which never expires.
        if (
          this.#replayStartedAt !== undefined &&
          this.#now() - this.#replayStartedAt > this.#session.maxDuration + 5000
        ) {
          this.#sendGate.clear();
          this.#notify();
          return;
        }
        this.#sendInitialSegments();
        if (this.#state === 'session') this.#flushSegment();
        this.#notify();
      },
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

  #sampleMode(): 'session' | 'buffer' | 'disabled' {
    return this.#enabled()
      ? sampled(clampRate(this.#options.replaysSessionSampleRate), this.#random)
        ? 'session'
        : clampRate(this.#options.replaysOnErrorSampleRate) > 0
          ? 'buffer'
          : 'disabled'
      : 'disabled';
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
      maxDurationMs: this.#session.maxDuration,
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

  #clearSessionTimer(): void {
    if (this.#sessionTimer) clearTimeout(this.#sessionTimer);
    this.#sessionTimer = undefined;
  }

  #armSessionTimer(): void {
    this.#clearSessionTimer();
    if (!this.#rootRuntime || !this.#handle) return;
    const delay = this.#session.nextCheck(this.#now());
    if (delay === undefined) return;
    const owner = this.#rootVersion;
    this.#sessionTimer = setTimeout(() => {
      this.#sessionTimer = undefined;
      if (owner !== this.#rootVersion || !this.refreshEnabled()) return;
      this.#checkSession();
      this.#armSessionTimer();
    }, delay);
  }

  #observeActivity(runtime: TaroReplayRuntime): void {
    this.#detachActivity?.();
    this.#detachActivity = undefined;
    try {
      const root = currentRoot(runtime);
      if (root)
        this.#detachActivity = observeRootActivity(
          root,
          () => {
            if (this.#rootRuntime === runtime) this.#userActivity();
          },
          runtime.observeEvents,
        );
    } catch (cause) {
      this.#reportError(cause);
    }
  }

  #userActivity(): void {
    if (
      !this.refreshEnabled() ||
      !this.#rootRuntime ||
      (this.#state !== 'session' && this.#state !== 'buffer')
    )
      return;
    const wasPaused = this.#session.paused;
    if (this.#session.isExpired(this.#now())) this.#refreshSession();
    if (this.#state !== 'session' && this.#state !== 'buffer') return;
    if (this.#bufferRecordingStopped) return;
    this.#session.activity(this.#now());
    if (!this.#handle && wasPaused) this.#startRoot(this.#rootRuntime);
    this.#armSessionTimer();
  }

  #checkSession(): boolean {
    if (this.#state !== 'session' && this.#state !== 'buffer') return false;
    // Pause before checking expiry: background changes must not create a new
    // full-session recording after the user has become inactive.
    if (this.#session.shouldPause(this.#now())) {
      const capture = this.#releaseRoot();
      this.#session.paused = true;
      if (capture) this.#enqueue({ ...capture, stopReason: 'idle-pause' });
      this.#notify();
      return false;
    }
    if (this.#session.paused) return false;
    if (this.#session.isExpired(this.#now())) {
      this.#refreshSession();
      return false;
    }
    return true;
  }

  #refreshSession(): void {
    this.#releaseRoot();
    const mode = this.#sampleMode();
    if (mode === 'disabled') {
      this.#sendGate.clear();
      this.#state = 'disabled';
      this.#replayId = undefined;
      this.#history.clear();
      this.#detachActivity?.();
      this.#detachActivity = undefined;
      this.#notify();
      return;
    }
    this.#newReplay(mode);
    if (this.#rootRuntime) this.#startRoot(this.#rootRuntime);
    this.#notify();
  }

  #newReplay(mode: 'session' | 'buffer'): void {
    this.#sendGate.clear();
    this.#replayId = createReplayId(this.#random);
    this.#replayStartedAt = undefined;
    this.#session.reset(mode);
    this.#segmentId = 0;
    this.#state = mode;
    this.#bufferRecordingStopped = false;
    this.#history.clear();
    this.#links.clear();
    this.#errorEventId = undefined;
  }

  attachRoot(runtime: TaroReplayRuntime): boolean {
    if (!this.#enabled()) return this.refreshEnabled();
    if (this.#state !== 'session' && this.#state !== 'buffer') {
      this.#rootRuntime = runtime;
      return false;
    }
    this.detachRoot();
    this.#rootRuntime = runtime;
    if (this.#session.isExpired(this.#now())) {
      const mode = this.#sampleMode();
      if (mode === 'disabled') {
        this.#state = 'disabled';
        this.#replayId = undefined;
        return false;
      }
      this.#newReplay(mode);
    }
    this.#observeActivity(runtime);
    if (this.#bufferRecordingStopped) return false;
    this.#session.activity(this.#now());
    return this.#startRoot(runtime);
  }

  #startRoot(runtime: TaroReplayRuntime): boolean {
    if (
      this.#handle ||
      !this.refreshEnabled() ||
      !this.#rootRuntime ||
      this.#session.paused ||
      this.#bufferRecordingStopped ||
      (this.#state !== 'session' && this.#state !== 'buffer')
    )
      return false;
    const owner = ++this.#rootVersion;
    try {
      this.#canvasRoot = this.#options.recordCanvas === true ? currentRoot(runtime) : undefined;
      this.#session.start(this.#now());
      const handle = createTaroReplay({
        sdk: this.#options.sdk ?? defaultReplaySdk,
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
          if (owner === this.#rootVersion && this.#state === 'session') this.#flushSegment(true);
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
        if (this.#history.length) {
          const initial = handle.getController()?.getCapture();
          if (initial) this.#boundBufferedHistory(initial.stats);
        }
        this.#error = undefined;
        this.#armSegmentTimer();
        this.#armSessionTimer();
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
      maxDurationMs: this.#session.remainingDuration(this.#now()),
    };
  }

  #releaseRoot(): TaroReplayCapture | undefined {
    this.#clearTimer();
    this.#clearSessionTimer();
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
    this.#detachActivity?.();
    this.#detachActivity = undefined;
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
      if (this.#checkSession()) this.#flushSegment();
      this.#armSegmentTimer();
    }, interval);
  }

  #flushSegment(forceDrain = false): void {
    if (this.#state !== 'session' || !this.#handle) return;
    // Upstream keeps collecting before the minimum instead of creating a new
    // delivery segment on every scheduled flush. Resource-pressure drains stay
    // synchronous and remain bounded by the shared delivery capacity.
    if (
      !forceDrain &&
      this.#sendGate.getSnapshot().pendingSegments > 0 &&
      !this.#sendGate.isReady(this.#replayStartedAt)
    )
      return;
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
    if (this.#checkSession()) this.#flushSegment();
    await this.#lastDelivery;
  }

  /** Official integration flush; bridge.flush deliberately remains session-only. */
  async flushReplay(options: SendBufferedReplayOptions = {}): Promise<void> {
    if (!this.#enabled()) {
      this.refreshEnabled();
      return;
    }
    if (this.#state !== 'session' && this.#state !== 'buffer') {
      this.start();
      return;
    }
    if (this.#state === 'session') return this.flush();
    return this.sendBufferedReplay(options);
  }

  async sendBufferedReplay({
    continueRecording = true,
  }: SendBufferedReplayOptions = {}): Promise<void> {
    if (!this.refreshEnabled() || this.#state !== 'buffer' || !this.#handle || !this.#rootRuntime)
      return;
    const capture = this.#history.merge(this.#handle.getController()!.getCapture());
    if (!capture) return;
    this.#promote(capture, continueRecording);
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
    if (this.#rootRuntime) {
      this.#observeActivity(this.#rootRuntime);
      this.#startRoot(this.#rootRuntime);
    }
    this.#notify();
    return true;
  }

  async stop({ flush = this.#state === 'session' }: { flush?: boolean } = {}): Promise<void> {
    if (this.#state !== 'session' && this.#state !== 'buffer') return;
    const generation = this.#generation;
    const stoppedReplayId = this.#replayId;
    const mode = this.#state;
    const buffered =
      mode === 'buffer' && flush
        ? this.#history.merge(this.#handle?.getController()?.getCapture())
        : undefined;
    const capture = this.#releaseRoot();
    const startedAt = this.#replayStartedAt ?? buffered?.startedAt ?? capture?.startedAt;
    const shouldFlush = flush && this.#enabled() && this.#sendGate.isReady(startedAt);
    if (shouldFlush) this.#sendInitialSegments();
    else this.#sendGate.clear();
    this.#state = 'stopped';
    this.#history.clear();
    if (shouldFlush && mode === 'buffer' && buffered) this.#enqueue(buffered, 'buffer');
    else if (capture && shouldFlush && mode === 'session') this.#enqueue(capture);
    if (!shouldFlush) {
      this.#generation++;
      this.#delivery.cancel();
    }
    this.#detachActivity?.();
    this.#detachActivity = undefined;
    this.#links.clear();
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
    this.#sendGate.clear();
    this.#rootRuntime = undefined;
    this.#detachActivity?.();
    this.#detachActivity = undefined;
    this.#releaseRoot();
    this.#delivery.cancel();
    this.#history.clear();
    this.#links.clear();
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
      this.#sendGate.clear();
      this.#rootRuntime = undefined;
      this.#detachActivity?.();
      this.#detachActivity = undefined;
      this.#releaseRoot();
      this.#history.clear();
      this.#links.clear();
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

  getReplayId(_onlyIfSampled?: boolean): string | undefined {
    return this.#state === 'session' || this.#state === 'buffer' ? this.#replayId : undefined;
  }
  getRecordingMode(): 'session' | 'buffer' | undefined {
    return this.#state === 'session' || this.#state === 'buffer' ? this.#state : undefined;
  }
  recordPageScroll(position: { scrollTop?: number; scrollLeft?: number }): void {
    this.#userActivity();
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
    if (!this.#checkSession()) return;
    if (
      !this.refreshEnabled() ||
      !this.#rootRuntime ||
      !this.#handle ||
      (this.#state !== 'buffer' && this.#state !== 'session') ||
      !event.event_id
    )
      return;
    if (event.type === 'transaction') {
      this.#links.addTrace(event);
      if (this.#state === 'session') associateReplay(event, this.#replayId);
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
      prepared = this.#history.merge(current);
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
    associateReplay(event, this.#replayId);
    if (!prepared)
      this.#handle
        .getController()
        ?.addBreadcrumb?.({ category: 'sentry.error', data: { event_id: event.event_id } });
    this.#links.addError(event.event_id);
    this.#links.addTrace(event);
    if (prepared) this.#promote(prepared);
    this.#notify();
  }

  #beforeSendFeedback(event: FeedbackEvent, includeReplay: boolean): void {
    if (!this.#checkSession()) return;
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
      const capture = this.#history.merge(current);
      if (!capture) return;
      event.contexts.feedback.replay_id = this.#replayId;
      this.#promote(capture);
    } else {
      event.contexts.feedback.replay_id = this.#replayId;
      this.#handle.getController()?.addBreadcrumb?.({ category: 'sentry.feedback' });
      this.#flushSegment();
    }
  }

  #promote(prepared: TaroReplayCapture, continueRecording = true): void {
    this.#session.promote(prepared.startedAt, this.#now());
    const duration = this.#session.remainingDuration(this.#now());
    if (!continueRecording) {
      this.#releaseRoot();
      this.#replayStartedAt = prepared.startedAt;
      this.#history.clear();
      this.#bufferRecordingStopped = true;
      this.#enqueue({ ...prepared, endedAt: this.#now(), stopReason: 'flush' }, 'buffer');
      this.#notify();
      return;
    }
    const promoted = this.#handle?.getController()?.promoteToSession?.(duration) === true;
    if (!promoted) this.#releaseRoot();
    this.#replayStartedAt = prepared.startedAt;
    this.#enqueue({ ...prepared, endedAt: this.#now(), stopReason: 'error' }, 'buffer');
    if (this.#state === 'error') return;
    this.#history.clear();
    this.#state = 'session';
    if (promoted) {
      this.#armSegmentTimer();
      this.#armSessionTimer();
    } else if (this.#rootRuntime) this.#startRoot(this.#rootRuntime);
  }

  #enqueue(capture: TaroReplayCapture, replayType: 'session' | 'buffer' = 'session'): void {
    if (!capture.events.length || !this.#enabled()) return;
    if (this.#segmentId === 0 && !capture.events.some((event) => event.type === 2)) return;
    this.#replayStartedAt ??= capture.startedAt;
    const { errorIds, traceIds, segmentNames, urls } = this.#links.take(capture);
    const segment: PendingReplaySegment = {
      capture,
      options: {
        replayType,
        segmentId: this.#segmentId++,
        errorIds,
        traceIds,
        segmentNames,
        urls,
        replayStartTimestamp: this.#replayStartedAt,
      },
    };
    try {
      if (this.#sendGate.defer(segment, this.#replayStartedAt)) {
        this.#notify();
        return;
      }
      this.#sendInitialSegments();
      this.#queueDelivery(segment);
    } catch (cause) {
      this.#options.client.recordDroppedEvent?.('queue_overflow', 'replay');
      this.#failRecording(cause);
    }
  }

  #sendInitialSegments(): void {
    const segments = this.#sendGate.take();
    const last = segments[segments.length - 1];
    // Official Replay timestamps a delayed flush when it runs, including while
    // the document is hidden. Its minimum duration measures replay age.
    if (last) last.capture = { ...last.capture, endedAt: this.#now() };
    for (const segment of segments) this.#queueDelivery(segment);
  }

  #failRecording(cause: unknown): void {
    this.#releaseRoot();
    this.#sendGate.clear();
    this.#history.clear();
    this.#links.clear();
    this.#state = 'error';
    this.#delivery.cancel();
    this.#reportError(cause);
  }

  #queueDelivery({ capture, options }: PendingReplaySegment): void {
    const generation = this.#generation;
    const id = capture.replayId;
    if (id === this.#replayId && options.segmentId === 0) {
      this.#session.markSent();
      this.#armSessionTimer();
    }
    const sent = this.#delivery.enqueue(capture, options);
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
        this.#failRecording(cause);
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
    this.#clearSessionTimer();
    this.#handle = undefined;
    if (capture.stopReason === 'buffer-drain') {
      this.#sendGate.clear();
      this.#history.clear();
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
      if (this.#state !== 'session') return;
      if (capture.stopReason === 'duration') {
        if (this.#session.shouldPause(this.#now())) {
          this.#session.paused = true;
          this.#notify();
          return;
        }
        const mode = this.#sampleMode();
        if (mode === 'disabled') {
          this.#state = 'disabled';
          this.#replayId = undefined;
          this.#notify();
          return;
        }
        this.#newReplay(mode);
      }
    } else return;
    // Defer only resource restart so synchronous SDK startup limits cannot re-enter start().
    void Promise.resolve().then(() => {
      if (owner === this.#rootVersion && this.#rootRuntime && !this.#handle)
        this.#startRoot(this.#rootRuntime);
    });
  }

  #boundBufferedHistory(
    current: Pick<TaroReplayCapture['stats'], 'eventCount' | 'approximateBytes'>,
  ): void {
    if (this.#state === 'buffer') this.#history.bound(current);
  }

  #storeBufferedCapture(capture: TaroReplayCapture): void {
    this.#history.store(capture);
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
    const captures = this.#history.list();
    const current = this.#handle?.getController()?.getCapture();
    if (current) captures.push(current);
    const delivery = this.#delivery.getSnapshot();
    const deferred = this.#sendGate.getSnapshot();
    return {
      state: this.#state,
      ...(this.#replayId ? { replayId: this.#replayId } : {}),
      ...(this.#errorEventId ? { errorEventId: this.#errorEventId } : {}),
      ...(this.#sentReplayId ? { sentReplayId: this.#sentReplayId } : {}),
      eventCount: captures.reduce((sum, capture) => sum + capture.events.length, 0),
      approximateBytes: captures.reduce((sum, capture) => sum + capture.stats.approximateBytes, 0),
      recording: Boolean(this.#handle),
      paused: this.#session.paused || this.#bufferRecordingStopped,
      delivery: {
        ...delivery,
        pendingSegments: delivery.pendingSegments + deferred.pendingSegments,
        pendingBytes: delivery.pendingBytes + deferred.pendingBytes,
      },
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
