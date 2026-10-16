import {
  REPLAY_MAX_DURATION_MS,
  REPLAY_SESSION_IDLE_EXPIRE_MS,
  REPLAY_SESSION_IDLE_PAUSE_MS,
} from '../../sdk/replay-constants';
import type { TaroReplayNodeLike } from '../types';
import { finiteInteger } from './limits';

export type ReplayRecordingMode = 'session' | 'buffer';

/** Identity lifetime is independent of recorder segments and visible page roots. */
export class ReplaySessionPolicy {
  readonly maxDuration: number;
  readonly idlePause: number;
  readonly idleExpire: number;
  #startedAt: number | undefined;
  #lastActivity: number | undefined;
  #sampledMode: ReplayRecordingMode = 'buffer';
  #hasSentBuffer = false;
  paused = false;

  constructor(options: { maxDurationMs?: number; idlePauseMs?: number; idleExpireMs?: number }) {
    this.maxDuration = finiteInteger(
      options.maxDurationMs,
      REPLAY_MAX_DURATION_MS,
      1,
      REPLAY_MAX_DURATION_MS,
    );
    this.idlePause = finiteInteger(
      options.idlePauseMs,
      REPLAY_SESSION_IDLE_PAUSE_MS,
      1,
      REPLAY_MAX_DURATION_MS,
    );
    this.idleExpire = finiteInteger(
      options.idleExpireMs,
      REPLAY_SESSION_IDLE_EXPIRE_MS,
      1,
      REPLAY_MAX_DURATION_MS,
    );
  }

  reset(mode: ReplayRecordingMode): void {
    this.#sampledMode = mode;
    this.#startedAt = undefined;
    this.#lastActivity = undefined;
    this.#hasSentBuffer = false;
    this.paused = false;
  }

  start(now: number): void {
    this.#startedAt ??= now;
    this.#lastActivity ??= now;
  }

  activity(now: number): void {
    this.start(now);
    this.#lastActivity = now;
    this.paused = false;
  }

  promote(startedAt: number, now: number): void {
    this.#startedAt = startedAt;
    this.activity(now);
  }

  markSent(): void {
    this.#hasSentBuffer = true;
  }

  isExpired(now: number): boolean {
    // Sentry 10.76.2 keeps an unsent error buffer alive indefinitely. Its
    // recording window is bounded separately, so inactivity must not lose it.
    if (this.#sampledMode === 'buffer' && !this.#hasSentBuffer) return false;
    return (
      this.#startedAt !== undefined &&
      this.#lastActivity !== undefined &&
      (now - this.#startedAt >= this.maxDuration || now - this.#lastActivity >= this.idleExpire)
    );
  }

  shouldPause(now: number): boolean {
    // Error-triggered sessions retain sampled='buffer' upstream and do not use
    // the full-session idle pause rule.
    return (
      this.#sampledMode === 'session' &&
      !this.paused &&
      this.#lastActivity !== undefined &&
      now - this.#lastActivity >= this.idlePause
    );
  }

  remainingDuration(now: number): number {
    return Math.max(1, this.maxDuration - (now - (this.#startedAt ?? now)));
  }

  nextCheck(now: number): number | undefined {
    if (
      this.paused ||
      this.#startedAt === undefined ||
      this.#lastActivity === undefined ||
      (this.#sampledMode === 'buffer' && !this.#hasSentBuffer)
    )
      return undefined;
    const deadline = Math.min(
      this.#startedAt + this.maxDuration,
      this.#lastActivity + this.idleExpire,
      this.#sampledMode === 'session' ? this.#lastActivity + this.idlePause : Infinity,
    );
    return Math.max(1, deadline - now);
  }
}

/** Observe only the fact of interaction; never read event values or retain payloads. */
export function observeRootActivity(root: TaroReplayNodeLike, activity: () => void): () => void {
  if (!root.addEventListener || !root.removeEventListener) return () => {};
  const names = ['tap', 'touchstart', 'touchend', 'touchmove', 'input', 'change', 'scroll'];
  const attached: string[] = [];
  for (const name of names) {
    try {
      root.addEventListener(name, activity, false);
      attached.push(name);
    } catch {
      // Incomplete runtime event support cannot interrupt the host.
    }
  }
  return () => {
    for (const name of attached) {
      try {
        root.removeEventListener?.(name, activity, false);
      } catch {
        /* Best-effort cleanup. */
      }
    }
  };
}
