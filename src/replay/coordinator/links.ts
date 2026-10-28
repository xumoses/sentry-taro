import { sanitizeUrl } from '../privacy';
import type { TaroReplayCapture } from '../types';
import type { ReplayAwareEvent } from './types';

const MAX_LINKS = 100;

export interface ReplaySegmentLinks {
  errorIds: string[];
  traceIds: string[];
  segmentNames: string[];
  urls: string[];
}

/** Error, trace and transaction names collected for the next delivered Replay segment. */
export class ReplayEventLinks {
  #errorIds: string[] = [];
  #traceIds: string[] = [];
  #segmentNames: string[] = [];
  #lastUrl: string | undefined;

  addError(eventId: string): void {
    if (this.#errorIds.length < MAX_LINKS && !this.#errorIds.includes(eventId))
      this.#errorIds.push(eventId);
  }

  addTrace(event: ReplayAwareEvent): void {
    const id = event.contexts?.trace?.trace_id;
    if (
      id &&
      /^[a-f0-9]{32}$/i.test(id) &&
      this.#traceIds.length < MAX_LINKS &&
      !this.#traceIds.includes(id)
    )
      this.#traceIds.push(id);
    if (typeof event.transaction === 'string' && this.#segmentNames.length < MAX_LINKS) {
      const name = sanitizeUrl(event.transaction).slice(0, 200);
      if (name && !this.#segmentNames.includes(name)) this.#segmentNames.push(name);
    }
  }

  /**
   * Hand the collected links to one segment and start collecting for the next.
   * Like official Replay, `urls` holds only pages entered in this segment: each
   * visible root starts with a Meta event, and an unchanged page is not repeated.
   */
  take(capture: TaroReplayCapture): ReplaySegmentLinks {
    const urls: string[] = [];
    for (const event of capture.events) {
      const href = event.type === 4 ? event.data['href'] : undefined;
      if (typeof href !== 'string' || !href || href === this.#lastUrl) continue;
      urls.push(href);
      this.#lastUrl = href;
    }
    if (this.#lastUrl === undefined && capture.href) {
      urls.push(capture.href);
      this.#lastUrl = capture.href;
    }
    return {
      errorIds: this.#errorIds.splice(0),
      traceIds: this.#traceIds.splice(0),
      segmentNames: this.#segmentNames.splice(0),
      urls,
    };
  }

  clear(): void {
    this.#errorIds = [];
    this.#traceIds = [];
    this.#segmentNames = [];
    this.#lastUrl = undefined;
  }
}

/** Tag an event with the Replay it belongs to, as the official integration does. */
export function associateReplay(event: ReplayAwareEvent, replayId: string | undefined): void {
  event.contexts = {
    ...event.contexts,
    replay: { ...event.contexts?.replay, replay_id: replayId },
  };
  event.tags = { ...event.tags, replayId };
}
