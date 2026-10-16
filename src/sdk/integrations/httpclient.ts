import {
  _INTERNAL_filterCookies,
  _INTERNAL_filterKeyValueData,
  addExceptionMechanism,
  captureEvent,
  debug,
  defineIntegration,
  getClient,
  isSentryRequestUrl,
} from '@sentry/core';
import type { Client, Event, IntegrationFn } from '@sentry/core';
import { readNetworkDataField, sanitizeNetworkDetailUrl } from '../network-details';
import {
  addMiniappRequestInstrumentationHandler,
  NetworkBreadcrumbs,
  type MiniappRequestHandlerData,
} from './networkbreadcrumbs';

const INTEGRATION_NAME = 'HttpClient';

export type HttpStatusCodeRange = [number, number] | number;
export type HttpRequestTarget = string | RegExp;

export interface HttpClientOptions {
  /**
   * HTTP status codes that should be considered failed.
   * This array can contain tuples of `[begin, end]` (both inclusive),
   * single status codes, or a combination of both.
   *
   * Example: [[500, 505], 507]
   * Default: [[500, 599]]
   */
  failedRequestStatusCodes: HttpStatusCodeRange[];
  /**
   * Targets to track for failed requests, matched against the full request URL.
   * This array can contain strings or regular expressions.
   *
   * Example: ['http://localhost', /api\/.*\/]
   * Default: [/.*\/]
   */
  failedRequestTargets: HttpRequestTarget[];
}

type DataCollectionSettings = {
  cookies: Parameters<typeof _INTERNAL_filterCookies>[1];
  requestHeaders: Parameters<typeof _INTERNAL_filterKeyValueData>[1];
  responseHeaders: Parameters<typeof _INTERNAL_filterKeyValueData>[1];
};

const _httpClientIntegration = ((options: Partial<HttpClientOptions> = {}) => {
  const _options: HttpClientOptions = {
    failedRequestStatusCodes: [[500, 599]],
    failedRequestTargets: [/.*/],
    ...options,
  };

  let removeHandler: (() => void) | undefined;

  return {
    name: INTEGRATION_NAME,
    setup(client: Client): void {
      removeHandler?.();
      removeHandler = addMiniappRequestInstrumentationHandler((data) => {
        if (getClient() !== client) {
          return;
        }
        _requestResponseHandler(_options, data);
      });
    },
    /** Called by `MiniappClient.close()`; unsubscribes so closed clients leave no handler behind. */
    cleanup(): void {
      removeHandler?.();
      removeHandler = undefined;
    },
    afterAllSetup(client: Client): void {
      if (!client.getIntegrationByName(NetworkBreadcrumbs.id)) {
        debug.warn(
          `[${INTEGRATION_NAME}] requires the default ${NetworkBreadcrumbs.id} integration to observe requests.`,
        );
      }
    },
  };
}) satisfies IntegrationFn;

/**
 * Create events for failed client side HTTP requests made with the platform `request` API
 * (`wx.request`, `Taro.request`, `my.request` / `my.httpRequest`, ...).
 *
 * Mirrors `httpClientIntegration` from `@sentry/browser`; not enabled by default.
 */
export const httpClientIntegration = defineIntegration(_httpClientIntegration);

function _requestResponseHandler(
  options: HttpClientOptions,
  { method, url, statusCode, requestHeaders, response, virtualError }: MiniappRequestHandlerData,
): void {
  if (statusCode === undefined || !_shouldCaptureResponse(options, statusCode, url)) {
    return;
  }

  let requestCookies: Record<string, string> | undefined;
  let responseCookies: Record<string, string> | undefined;
  let filteredRequestHeaders: Record<string, string> | undefined;
  let filteredResponseHeaders: Record<string, string> | undefined;
  const dc = _getDataCollectionSettings();
  const rawRequestHeaders = _toStringRecord(requestHeaders);
  const rawResponseHeaders = _readResponseHeaders(response);

  if (dc.requestHeaders !== false) {
    filteredRequestHeaders = _INTERNAL_filterKeyValueData(rawRequestHeaders, dc.requestHeaders);
  }
  if (dc.responseHeaders !== false) {
    filteredResponseHeaders = _INTERNAL_filterKeyValueData(rawResponseHeaders, dc.responseHeaders);
  }
  if (dc.cookies !== false) {
    const requestCookieString = _getHeader(rawRequestHeaders, 'cookie');
    if (requestCookieString) {
      const filtered = _INTERNAL_filterCookies(requestCookieString, dc.cookies);
      if (typeof filtered === 'object') {
        requestCookies = filtered;
      }
    }
    const responseCookieString =
      _getHeader(rawResponseHeaders, 'set-cookie') || _readResponseCookies(response);
    if (responseCookieString) {
      const filtered = _INTERNAL_filterCookies(responseCookieString, dc.cookies);
      if (typeof filtered === 'object') {
        responseCookies = filtered;
      }
    }
  }

  captureEvent(
    _createEvent({
      // Same URL policy as breadcrumbs and Replay network details: no userinfo, query or fragment.
      url: sanitizeNetworkDetailUrl(url),
      method,
      status: statusCode,
      requestHeaders: filteredRequestHeaders,
      responseHeaders: filteredResponseHeaders,
      requestCookies,
      responseCookies,
      error: virtualError,
    }),
  );
}

function _shouldCaptureResponse(options: HttpClientOptions, status: number, url: string): boolean {
  return (
    _isInGivenStatusRanges(options.failedRequestStatusCodes, status) &&
    _isInGivenRequestTargets(options.failedRequestTargets, url) &&
    !isSentryRequestUrl(url, getClient())
  );
}

function _isInGivenStatusRanges(
  failedRequestStatusCodes: HttpStatusCodeRange[],
  status: number,
): boolean {
  return failedRequestStatusCodes.some((range) => {
    if (typeof range === 'number') {
      return range === status;
    }
    return status >= range[0] && status <= range[1];
  });
}

function _isInGivenRequestTargets(
  failedRequestTargets: HttpRequestTarget[],
  target: string,
): boolean {
  return failedRequestTargets.some((givenRequestTarget) => {
    if (typeof givenRequestTarget === 'string') {
      return target.includes(givenRequestTarget);
    }
    return givenRequestTarget.test(target);
  });
}

function _createEvent(data: {
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string> | undefined;
  responseHeaders: Record<string, string> | undefined;
  requestCookies: Record<string, string> | undefined;
  responseCookies: Record<string, string> | undefined;
  error: unknown;
}): Event {
  const client = getClient();
  const virtualStackTrace =
    client && data.error && data.error instanceof Error ? data.error.stack : undefined;
  const stack =
    virtualStackTrace && client
      ? client.getOptions().stackParser(virtualStackTrace, 0, 1)
      : undefined;
  const message = `HTTP Client Error with status code: ${data.status}`;

  const bodySize = _getResponseSizeFromHeaders(data.responseHeaders);

  // Same shape as the official event; undefined fields are omitted (exactOptionalPropertyTypes).
  const event: Event = {
    message,
    exception: {
      values: [
        {
          type: 'Error',
          value: message,
          ...(stack ? { stacktrace: { frames: stack } } : {}),
        },
      ],
    },
    request: {
      url: data.url,
      method: data.method,
      ...(data.requestHeaders ? { headers: data.requestHeaders } : {}),
      ...(data.requestCookies ? { cookies: data.requestCookies } : {}),
    },
    contexts: {
      response: {
        status_code: data.status,
        ...(data.responseHeaders ? { headers: data.responseHeaders } : {}),
        ...(data.responseCookies ? { cookies: data.responseCookies } : {}),
        ...(bodySize !== undefined ? { body_size: bodySize } : {}),
      },
    },
  };

  addExceptionMechanism(event, {
    type: 'auto.http.client.request',
    handled: false,
  });

  return event;
}

function _getDataCollectionSettings(): DataCollectionSettings {
  const client = getClient();
  if (!client) {
    return { cookies: false, requestHeaders: false, responseHeaders: false };
  }
  const options = client.getOptions();
  if (options.dataCollection == null) {
    const enabled = Boolean(options.sendDefaultPii);
    return { cookies: enabled, requestHeaders: enabled, responseHeaders: enabled };
  }
  const { cookies, httpHeaders } = client.getDataCollectionOptions();
  return { cookies, requestHeaders: httpHeaders.request, responseHeaders: httpHeaders.response };
}

function _readResponseHeaders(response: unknown): Record<string, string> {
  return {
    ..._toStringRecord(readNetworkDataField(response, 'headers')),
    ..._toStringRecord(readNetworkDataField(response, 'header')),
  };
}

/** WeChat reports response cookies separately as `cookies: string[]`. */
function _readResponseCookies(response: unknown): string | undefined {
  const cookies = readNetworkDataField(response, 'cookies');
  if (!Array.isArray(cookies)) {
    return undefined;
  }
  const values = cookies.filter((cookie): cookie is string => typeof cookie === 'string');
  return values.length ? values.join('; ') : undefined;
}

function _toStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }
  for (const key of Object.keys(value)) {
    const field = readNetworkDataField(value, key);
    if (
      typeof field === 'string' ||
      typeof field === 'boolean' ||
      (typeof field === 'number' && Number.isFinite(field))
    ) {
      result[key] = String(field);
    } else if (Array.isArray(field)) {
      const values = field.filter((item): item is string => typeof item === 'string');
      if (values.length) result[key] = values.join(', ');
    }
  }
  return result;
}

function _getHeader(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((header) => header.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function _getResponseSizeFromHeaders(
  headers: Record<string, string> | undefined,
): number | undefined {
  if (headers) {
    const contentLength = headers['Content-Length'] || headers['content-length'];
    if (contentLength) {
      return parseInt(contentLength, 10);
    }
  }
  return undefined;
}
