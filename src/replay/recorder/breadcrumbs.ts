/** Converts SDK breadcrumbs into rrweb breadcrumb and network performance-span events. */

import type { Breadcrumb } from '@sentry/core';

import { readNetworkDataField, type NetworkHeaderPolicy } from '../../sdk/network-details';
import type { TaroReplayEvent } from '../types';
import { sanitizeUrl } from './attributes';
import { nextTimestamp, type RecorderContext } from './context';
import { addEvent } from './events';
import { RrwebEventType } from './rrweb';

function breadcrumbTimestampMs(ctx: RecorderContext, breadcrumb: Breadcrumb): number {
  const timestamp = breadcrumb.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ctx.now();
  return timestamp > 9_999_999_999 ? timestamp : timestamp * 1_000;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function networkRequestOrResponse(
  policy: NetworkHeaderPolicy,
  size: unknown,
  headers: unknown,
  allowed: boolean,
  direction: 'request' | 'response',
): Record<string, unknown> {
  const byteSize = finiteNumber(size);
  return {
    headers: allowed ? policy.filterHeaders(headers, direction) : {},
    ...(byteSize === undefined ? {} : { size: byteSize }),
    _meta: { warnings: allowed ? [] : ['URL_SKIPPED'] },
  };
}

export function addBreadcrumb(ctx: RecorderContext, breadcrumb: Breadcrumb): boolean {
  if (ctx.stopped || !breadcrumb || typeof breadcrumb.category !== 'string') return false;

  const policy = ctx.networkHeaderPolicy;
  const timestampMs = breadcrumbTimestampMs(ctx, breadcrumb);
  const data = breadcrumb.data || {};
  const isNetwork =
    (breadcrumb.category === 'xhr' || breadcrumb.category === 'fetch') &&
    typeof data['url'] === 'string';
  let event: TaroReplayEvent;

  if (isNetwork) {
    const allowed = policy.isAllowed(data['url']);
    const endTimestamp = timestampMs / 1_000;
    const duration = finiteNumber(data['duration']) ?? 0;
    event = {
      type: RrwebEventType.Custom,
      timestamp: nextTimestamp(ctx, timestampMs),
      data: {
        tag: 'performanceSpan',
        payload: {
          op: `resource.${breadcrumb.category}`,
          description: sanitizeUrl(data['url'] as string),
          startTimestamp: Math.max(0, endTimestamp - duration / 1_000),
          endTimestamp,
          data: {
            method: typeof data['method'] === 'string' ? data['method'] : 'GET',
            statusCode: finiteNumber(data['status_code']) ?? 0,
            request: networkRequestOrResponse(
              policy,
              data['request_body_size'] ?? data['request_size'],
              allowed ? readNetworkDataField(data, 'request_headers') : undefined,
              allowed,
              'request',
            ),
            response: networkRequestOrResponse(
              policy,
              data['response_body_size'] ?? data['response_size'],
              allowed ? readNetworkDataField(data, 'response_headers') : undefined,
              allowed,
              'response',
            ),
          },
        },
      },
    };
  } else {
    event = {
      type: RrwebEventType.Custom,
      timestamp: nextTimestamp(ctx, timestampMs),
      data: {
        tag: 'breadcrumb',
        payload: {
          ...breadcrumb,
          timestamp: timestampMs / 1_000,
        },
      },
    };
  }

  if (!addEvent(ctx, event)) return false;
  if (isNetwork) ctx.capture.stats.networkCount++;
  else ctx.capture.stats.breadcrumbCount++;
  return true;
}
