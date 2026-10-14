import type { DsnComponents, ReplayEnvelope, ReplayEvent, SdkInfo } from '@sentry/core';

import { mergeReplayContexts } from './metadata';
import type { SentryReplayClient, TaroReplayCapture } from './types';

/** Counts UTF-8 bytes without TextEncoder, which is absent in some mini program runtimes. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function serializeReplayRecording(capture: TaroReplayCapture, segmentId = 0): string {
  return `${JSON.stringify({ segment_id: segmentId })}\n${JSON.stringify(capture.events)}`;
}

export function serializeDsn(dsn: DsnComponents): string {
  // Match @sentry/core dsnToString(dsn): private/password material is omitted by default.
  const auth = dsn.publicKey ? `${encodeURIComponent(dsn.publicKey)}@` : '';
  const path = dsn.path ? `/${dsn.path.replace(/^\/+|\/+$/g, '')}` : '';
  const port = dsn.port ? `:${dsn.port}` : '';
  return `${dsn.protocol}://${auth}${dsn.host}${port}${path}/${dsn.projectId}`;
}

export interface ReplayEnvelopeOptions {
  dsn?: string;
  sdk?: SdkInfo;
  errorIds?: string[];
  traceIds?: string[];
  segmentNames?: string[];
  replayType?: 'session' | 'buffer';
  segmentId?: number;
  replayStartTimestamp?: number;
  /** Prepared recording bytes, with the uncompressed segment header already prepended. */
  recording?: string | Uint8Array;
}

export interface ReplaySendResult {
  status: 'accepted' | 'handed-off' | 'rejected' | 'cancelled';
  statusCode?: number;
}

export function createReplayEnvelope(
  capture: TaroReplayCapture,
  options: ReplayEnvelopeOptions = {},
): ReplayEnvelope {
  const endedAt = capture.endedAt ?? capture.startedAt;
  const metadata = capture.metadata || {};
  // `segment_names` became required after @sentry/core 10.63. Keep it in the
  // payload while using an intersection so the adapter also compiles on 10.63.
  const replayEvent: ReplayEvent & { segment_names: string[] } = {
    event_id: capture.replayId,
    type: 'replay_event',
    timestamp: endedAt / 1_000,
    start_timestamp: capture.startedAt / 1_000,
    replay_start_timestamp: (options.replayStartTimestamp ?? capture.startedAt) / 1_000,
    replay_id: capture.replayId,
    segment_id: options.segmentId || 0,
    replay_type: options.replayType || 'session',
    platform: 'javascript',
    urls: [capture.href],
    error_ids: options.errorIds || [],
    trace_ids: options.traceIds || [],
    segment_names: options.segmentNames || [],
    ...(metadata.environment ? { environment: metadata.environment } : {}),
    ...(metadata.release ? { release: metadata.release } : {}),
    ...(metadata.dist ? { dist: metadata.dist } : {}),
    ...(metadata.sdk ? { sdk: metadata.sdk } : {}),
    ...(metadata.user ? { user: metadata.user } : {}),
    ...(metadata.tags ? { tags: metadata.tags } : {}),
    ...(metadata.contexts ? { contexts: mergeReplayContexts({}, metadata.contexts) } : {}),
  };
  const recording = options.recording ?? serializeReplayRecording(capture, options.segmentId || 0);

  return [
    {
      event_id: capture.replayId,
      sent_at: new Date(endedAt).toISOString(),
      ...(options.dsn ? { dsn: options.dsn } : {}),
      ...(options.sdk ? { sdk: options.sdk } : {}),
    },
    [
      [{ type: 'replay_event' }, replayEvent],
      [
        {
          type: 'replay_recording',
          length: typeof recording === 'string' ? utf8ByteLength(recording) : recording.length,
        },
        recording,
      ],
    ],
  ];
}

export async function sendReplayCapture(
  client: SentryReplayClient,
  capture: TaroReplayCapture,
  options: ReplayEnvelopeOptions = {},
  shouldSend: () => boolean = () => true,
): Promise<ReplaySendResult> {
  if (client.getRuntimeContexts && client.getOptions?.().enableSystemInfo !== false) {
    // The client owns the deadline/cache. Empty or unavailable defaults are
    // authoritative: never replace them with a simulated phone's wx metadata.
    try {
      const defaults = await client.getRuntimeContexts();
      capture = {
        ...capture,
        metadata: {
          ...capture.metadata,
          contexts: mergeReplayContexts(defaults, capture.metadata?.contexts),
        },
      };
    } catch {
      // Metadata failure must not prevent delivery or enable a second probe.
    }
  }
  // Reset/consent may change while the shared provider is pending.
  if (!shouldSend()) return { status: 'cancelled' };
  const dsnComponents = client.getDsn?.();
  const dsn = dsnComponents ? serializeDsn(dsnComponents) : undefined;
  const envelope = createReplayEnvelope(capture, {
    ...(dsn ? { dsn } : {}),
    ...(capture.metadata?.sdk ? { sdk: capture.metadata.sdk } : {}),
    ...options,
  });
  const response = await Promise.resolve(client.sendEnvelope(envelope));
  const statusCode =
    response &&
    typeof response === 'object' &&
    'statusCode' in response &&
    typeof response.statusCode === 'number'
      ? response.statusCode
      : undefined;
  // Core catches transport rejections and offline queues may return {}. Neither is an ingestion acknowledgment.
  if (statusCode === undefined || statusCode === 0) return { status: 'handed-off' };
  return { status: statusCode >= 200 && statusCode < 300 ? 'accepted' : 'rejected', statusCode };
}
