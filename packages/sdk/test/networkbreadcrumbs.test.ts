import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vite-plus/test';
const {
  mockSpanSetAttribute,
  mockSpanSetStatus,
  mockSpanEnd,
  mockSpan,
  mockStartInactiveSpan,
  mockGetTraceData,
  mockSetHttpStatus,
} = vi.hoisted(() => {
  const mockSpanSetAttribute = vi.fn();
  const mockSpanSetStatus = vi.fn();
  const mockSpanEnd = vi.fn();
  const mockSpan = {
    setAttribute: mockSpanSetAttribute,
    setStatus: mockSpanSetStatus,
    end: mockSpanEnd,
  };
  const mockStartInactiveSpan = vi.fn(() => mockSpan);
  const mockGetTraceData = vi.fn(() => ({
    'sentry-trace': 'trace-id-span-id-1',
    baggage: 'sentry-trace_id=trace-id,sentry-public_key=public-key,sentry-sampled=true',
  }));
  const mockSetHttpStatus = vi.fn((span, statusCode) => {
    span.setAttribute('http.response.status_code', statusCode);
    span.setStatus({ code: statusCode >= 400 ? 2 : 1 });
  });
  return {
    mockSpanSetAttribute,
    mockSpanSetStatus,
    mockSpanEnd,
    mockSpan,
    mockStartInactiveSpan,
    mockGetTraceData,
    mockSetHttpStatus,
  };
});

// Mock the core module to avoid redefine property errors

vi.mock('@sentry/core', () => {
  return {
    withActiveSpan: (_span: unknown, callback: () => unknown) => callback(),
    addBreadcrumb: vi.fn(),
    getClient: vi.fn(() => ({
      getOptions: () => ({ dsn: 'https://key@sentry.io/123' }),
    })),
    getTraceData: mockGetTraceData,
    setHttpStatus: mockSetHttpStatus,
    SPAN_STATUS_OK: 1,
    SPAN_STATUS_ERROR: 2,
    startInactiveSpan: mockStartInactiveSpan,
  };
});
import {
  addMiniappRequestInstrumentationHandler,
  NetworkBreadcrumbs,
} from '../src/integrations/networkbreadcrumbs';
import * as crossPlatform from '../src/crossPlatform';
import { addBreadcrumb, getClient } from '@sentry/core';

describe('NetworkBreadcrumbs Integration', () => {
  let requestMock: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    requestMock = vi.fn((options) => {
      if (options.success) {
        options.success({ statusCode: 200, data: { status: 'ok' } });
      }
    });

    vi.spyOn(crossPlatform, 'sdk').mockReturnValue({
      request: requestMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should patch request and add breadcrumb without body by default', () => {
    const integration = new NetworkBreadcrumbs();
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/users',
      method: 'POST',
      data: { userId: 1 },
    });

    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      type: 'http',
      category: 'xhr',
      level: 'info',
      data: {
        url: 'https://api.example.com/users',
        method: 'POST',
        status_code: 200,
        duration: 0,
      },
    });
    expect(mockStartInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'POST https://api.example.com/users',
        op: 'http.client',
        kind: 2,
        attributes: expect.objectContaining({
          'http.request.method': 'POST',
          'url.full': 'https://api.example.com/users',
          'server.address': 'api.example.com',
        }),
      }),
    );
    const requestOptions = requestMock.mock.calls[0]![0];
    expect(requestOptions.header).toEqual({
      'sentry-trace': 'trace-id-span-id-1',
      baggage: 'sentry-trace_id=trace-id,sentry-public_key=public-key,sentry-sampled=true',
    });
    expect(requestOptions.headers).toBe(requestOptions.header);
    expect(mockGetTraceData).toHaveBeenCalledWith({ span: mockSpan });
    expect(mockSetHttpStatus).toHaveBeenCalledWith(mockSpan, 200);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('http.response.status_code', 200);
    expect(mockSpanSetStatus).toHaveBeenCalledWith({ code: 1 });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('should sanitize query and fragment from request span name', () => {
    const integration = new NetworkBreadcrumbs();
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/users?token=secret#profile',
    });

    expect(mockStartInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'GET https://api.example.com/users',
        attributes: expect.objectContaining({
          'url.full': 'https://api.example.com/users',
        }),
      }),
    );
  });

  it('should include request and response body when traceNetworkBody is true', () => {
    const integration = new NetworkBreadcrumbs({ traceNetworkBody: true });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/users',
      method: 'POST',
      data: { userId: 1 },
    });

    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      type: 'http',
      category: 'xhr',
      level: 'info',
      data: {
        url: 'https://api.example.com/users',
        method: 'POST',
        status_code: 200,
        duration: 0,
        request_body: '{"userId":1}',
        request_size: 12,
        response_body: '{"status":"ok"}',
        response_size: 15,
      },
    });
  });

  it('should ignore sentry.io requests', () => {
    const integration = new NetworkBreadcrumbs({ traceNetworkBody: true });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://sentry.io/api/123/store/',
      method: 'POST',
    });

    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(mockStartInactiveSpan).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalled();
  });

  it('should NOT ignore URLs that merely contain sentry.io as substring', () => {
    const integration = new NetworkBreadcrumbs({ traceNetworkBody: true });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();

    // evil-sentry.io should NOT be filtered
    miniappSdk.request({
      url: 'https://evil-sentry.io/steal',
      method: 'POST',
    });
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // sentry.io.evil.com should NOT be filtered
    miniappSdk.request({
      url: 'https://sentry.io.evil.com/steal',
      method: 'POST',
    });
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it('should ignore subdomain of sentry.io', () => {
    const integration = new NetworkBreadcrumbs({ traceNetworkBody: true });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://o113510.ingest.sentry.io/api/123/envelope/',
      method: 'POST',
    });

    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(mockStartInactiveSpan).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalled();
  });

  it('should ignore self-hosted sentry requests based on DSN', () => {
    // Override the getClient mock for this test
    (getClient as Mock).mockReturnValueOnce({
      getOptions: () => ({ dsn: 'http://mykey@sentry.example.test:9000/1' }),
    });

    const integration = new NetworkBreadcrumbs({ traceNetworkBody: true });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'http://sentry.example.test:9000/api/1/store/',
      method: 'POST',
    });

    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(mockStartInactiveSpan).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalled();
  });

  it('should capture failure and add error breadcrumb', () => {
    const failRequestMock = vi.fn((options) => {
      if (options.fail) {
        options.fail({ errMsg: 'request:fail timeout' });
      }
    });

    vi.spyOn(crossPlatform, 'sdk').mockReturnValue({
      request: failRequestMock,
    });

    const integration = new NetworkBreadcrumbs();
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/timeout',
    });

    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      type: 'http',
      category: 'xhr',
      level: 'error',
      data: {
        url: 'https://api.example.com/timeout',
        method: 'GET',
        error: 'request:fail timeout',
        duration: 0,
      },
    });
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('error.message', 'request:fail timeout');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'request:fail timeout',
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('should not inject trace headers when trace propagation is disabled', () => {
    const integration = new NetworkBreadcrumbs({ enableTracePropagation: false });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/users',
    });

    const requestOptions = requestMock.mock.calls[0]![0];
    expect(requestOptions.header).toBeUndefined();
    expect(requestOptions.headers).toBeUndefined();
    expect(mockStartInactiveSpan).toHaveBeenCalledTimes(1);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('should only inject trace headers for matching tracePropagationTargets', () => {
    const integration = new NetworkBreadcrumbs({
      tracePropagationTargets: ['api.example.com'],
    });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://cdn.example.com/asset',
    });

    const requestOptions = requestMock.mock.calls[0]![0];
    expect(requestOptions.header).toBeUndefined();
    expect(requestOptions.headers).toBeUndefined();
    expect(mockStartInactiveSpan).toHaveBeenCalledTimes(1);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('should not let global tracePropagationTargets regexp lastIndex break repeated matches', () => {
    const integration = new NetworkBreadcrumbs({
      tracePropagationTargets: [/api\.example\.com/g],
    });
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/first',
    });
    miniappSdk.request({
      url: 'https://api.example.com/second',
    });

    expect(requestMock.mock.calls[0]![0].header).toEqual(
      expect.objectContaining({ 'sentry-trace': 'trace-id-span-id-1' }),
    );
    expect(requestMock.mock.calls[1]![0].header).toEqual(
      expect.objectContaining({ 'sentry-trace': 'trace-id-span-id-1' }),
    );
  });

  it('should finish request span from complete callback when success/fail are not called', () => {
    const completeOnlyRequestMock = vi.fn((options) => {
      if (options.complete) {
        options.complete({ statusCode: 204 });
      }
    });

    vi.spyOn(crossPlatform, 'sdk').mockReturnValue({
      request: completeOnlyRequestMock,
    });

    const integration = new NetworkBreadcrumbs();
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/complete-only',
    });

    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(mockSetHttpStatus).toHaveBeenCalledWith(mockSpan, 204);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('http.response.status_code', 204);
    expect(mockSpanSetStatus).toHaveBeenCalledWith({ code: 1 });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('should wrap Alipay httpRequest and create request span', () => {
    const httpRequestMock = vi.fn((options) => {
      if (options.success) {
        options.success({ status: 201, data: { status: 'ok' } });
      }
    });

    vi.spyOn(crossPlatform, 'sdk').mockReturnValue({
      request: vi.fn(),
      httpRequest: httpRequestMock,
    } as any);

    const integration = new NetworkBreadcrumbs();
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk() as any;
    miniappSdk.httpRequest!({
      url: 'https://api.example.com/alipay',
      method: 'POST',
    });

    expect(mockStartInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'POST https://api.example.com/alipay',
        op: 'http.client',
      }),
    );
    expect(mockSetHttpStatus).toHaveBeenCalledWith(mockSpan, 201);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('http.response.status_code', 201);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('should preserve existing non-Sentry baggage when injecting trace headers', () => {
    const integration = new NetworkBreadcrumbs();
    integration.setupOnce();

    const miniappSdk = crossPlatform.sdk();
    miniappSdk.request({
      url: 'https://api.example.com/users',
      header: {
        baggage: 'tenant=demo',
      },
    });

    const requestOptions = requestMock.mock.calls[0]![0];
    expect(requestOptions.header).toEqual({
      'sentry-trace': 'trace-id-span-id-1',
      baggage:
        'tenant=demo,sentry-trace_id=trace-id,sentry-public_key=public-key,sentry-sampled=true',
    });
  });
  it('sends permitted headers only in Replay hint for both platform aliases', () => {
    requestMock.mockImplementation((options) =>
      options.success({
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'cookie-canary',
          'X-Response-ID': 'response-id',
        },
        data: { hidden: 'body-canary' },
      }),
    );
    const integration = new NetworkBreadcrumbs({
      networkDetailAllowUrls: [/^https:\/\/api\.example\.com\//],
      networkRequestHeaders: ['X-Request-ID', 'Authorization'],
      networkResponseHeaders: ['X-Response-ID', 'Set-Cookie'],
    });
    integration.setupOnce();
    const options = {
      url: 'https://user:password@api.example.com/items?token=query-canary',
      header: { ACCEPT: 'application/json', Authorization: 'auth-canary' },
      headers: { 'X-Request-ID': 'request-id' },
    };
    const before = JSON.stringify(options);
    crossPlatform.sdk().request(options);
    const [breadcrumb, hint] = vi.mocked(addBreadcrumb).mock.calls[0]!;
    expect(hint).toEqual({
      replayNetworkDetails: {
        url: 'https://api.example.com/items',
        request_headers: { 'x-request-id': 'request-id', accept: 'application/json' },
        response_headers: { 'content-type': 'application/json', 'x-response-id': 'response-id' },
      },
    });
    expect(breadcrumb.data).not.toHaveProperty('request_headers');
    expect(breadcrumb.data).not.toHaveProperty('response_headers');
    expect(JSON.stringify(vi.mocked(addBreadcrumb).mock.calls)).not.toMatch(
      /auth-canary|cookie-canary|body-canary|query-canary|password/,
    );
    expect(JSON.stringify(options)).toBe(before);
  });

  it('captures Alipay httpRequest failure headers and preserves callbacks and return values', () => {
    const receiver = { native: true };
    const request = vi.fn((options) => {
      expect(
        options.fail.call(receiver, {
          errorMessage: 'failed',
          headers: { 'Content-Type': 'text/plain', 'X-Response-ID': 'failed-id' },
        }),
      ).toBe('failure-return');
      expect(options.complete.call(receiver, {})).toBe('complete-return');
      return 'request-task';
    });
    vi.mocked(crossPlatform.sdk).mockReturnValue({ request: requestMock, httpRequest: request });
    new NetworkBreadcrumbs({
      networkDetailAllowUrls: ['api.example.com'],
      networkResponseHeaders: ['X-Response-ID'],
    }).setupOnce();
    const fail = vi.fn(function (this: unknown) {
      expect(this).toBe(receiver);
      return 'failure-return';
    });
    const complete = vi.fn(function (this: unknown) {
      expect(this).toBe(receiver);
      return 'complete-return';
    });
    expect(
      crossPlatform.sdk().httpRequest!({
        url: 'https://api.example.com/a',
        headers: { Accept: '*/*' },
        fail,
        complete,
      }),
    ).toBe('request-task');
    expect(vi.mocked(addBreadcrumb).mock.calls[0]![1]).toEqual({
      replayNetworkDetails: {
        url: 'https://api.example.com/a',
        request_headers: { accept: '*/*' },
        response_headers: { 'content-type': 'text/plain', 'x-response-id': 'failed-id' },
      },
    });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('snapshots request headers at dispatch and safely ignores malformed header getters', () => {
    let nativeOptions: any;
    requestMock.mockImplementation((options) => {
      nativeOptions = options;
      return 'task';
    });
    new NetworkBreadcrumbs({ networkDetailAllowUrls: ['api.example.com'] }).setupOnce();
    const header = { accept: 'original' };
    const success = vi.fn(() => 'success-return');
    const options = { url: 'https://api.example.com/a', header, success };
    crossPlatform.sdk().request(options);
    header.accept = 'later';
    const getter = vi.fn(() => {
      throw new Error('getter');
    });
    const response = Object.defineProperty({ statusCode: 200 }, 'header', { get: getter });
    expect(nativeOptions.success(response)).toBe('success-return');
    expect(getter).not.toHaveBeenCalled();
    expect(vi.mocked(addBreadcrumb).mock.calls[0]![1]).toEqual({
      replayNetworkDetails: {
        url: options.url,
        request_headers: { accept: 'original' },
        response_headers: {},
      },
    });
    expect(() =>
      crossPlatform
        .sdk()
        .request(
          Object.defineProperty({ url: options.url }, 'header', { get: getter, enumerable: true }),
        ),
    ).not.toThrow();
    nativeOptions.success({ statusCode: 200 });
    expect(getter).not.toHaveBeenCalled();
    expect(vi.mocked(addBreadcrumb).mock.calls[1]![1]).toEqual({
      replayNetworkDetails: { url: options.url, request_headers: {}, response_headers: {} },
    });
  });

  it('keeps tracing injection working for frozen caller options without mutating them', () => {
    new NetworkBreadcrumbs({ networkDetailAllowUrls: ['api.example.com'] }).setupOnce();
    const header = Object.freeze({ accept: '*/*' });
    const options = Object.freeze({ url: 'https://api.example.com/a', header });
    crossPlatform.sdk().request(options);
    expect(requestMock.mock.calls[0][0].header['sentry-trace']).toBe('trace-id-span-id-1');
    expect(options.header).toEqual({ accept: '*/*' });
    expect(requestMock.mock.calls[0][0]).not.toBe(options);
  });

  it('notifies request handlers from the single patch, skipping Sentry requests', () => {
    const handler = vi.fn(() => {
      throw new Error('handler failure must not reach the caller');
    });
    const remove = addMiniappRequestInstrumentationHandler(handler);
    // Trace propagation merges nested header fields itself; isolate the handler's own reads.
    new NetworkBreadcrumbs({ enableTracePropagation: false }).setupOnce();
    const getter = vi.fn(() => ({}));
    const success = vi.fn();
    crossPlatform.sdk().request({
      url: 'https://api.example.com/a?x=1',
      method: 'post',
      header: Object.defineProperty({ accept: '*/*' }, 'x-lazy', { get: getter, enumerable: true }),
      success,
    });
    crossPlatform.sdk().request({ url: 'https://sentry.io/api/1/envelope/' });
    remove();
    crossPlatform.sdk().request({ url: 'https://api.example.com/b' });

    expect(success).toHaveBeenCalledTimes(1);
    expect(getter).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.example.com/a?x=1',
      statusCode: 200,
      requestHeaders: { accept: '*/*' },
      response: { statusCode: 200, data: { status: 'ok' } },
      virtualError: expect.any(Error),
    });
  });
});
