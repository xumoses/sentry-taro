import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import {
  captureFeedback as coreCaptureFeedback,
  Client,
  installedIntegrations,
  Scope,
  type Envelope,
  type Event,
  type Integration,
  type Options,
} from '@sentry/core';
import * as Sentry from '../src/index';
import { resetPlatformCache } from '../src/crossPlatform';
import { _resetAppLifecycle } from '../src/appLifecycle';

const globals = globalThis as any;
const originalFunctionToString = Function.prototype.toString;
let envelopes: Envelope[];

function initialize(options: Sentry.MiniappOptions = {}) {
  return Sentry.init({
    dsn: 'https://public@ingest.example.test/1',
    defaultIntegrations: false,
    enableOfflineCache: false,
    enableSystemInfo: false,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    ...options,
  })!;
}

function eventPayloads(): Event[] {
  return envelopes.flatMap((envelope) =>
    envelope[1]
      .filter((item) => ['event', 'feedback'].includes(item[0].type))
      .map((item) => item[1] as Event),
  );
}

beforeEach(() => {
  envelopes = [];
  installedIntegrations.length = 0;
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  globals.App = vi.fn((config) => config);
  globals.Page = vi.fn((config) => config);
  _resetAppLifecycle();
  resetPlatformCache();
});

afterEach(async () => {
  await Sentry.getClient()?.close(0);
  Sentry.getCurrentScope().setClient(undefined);
  Function.prototype.toString = originalFunctionToString;
  delete globals.App;
  delete globals.Page;
  _resetAppLifecycle();
});

test('default integration factory describes the complete platform defaults used by init', () => {
  const options: Sentry.MiniappOptions = {
    enableConsoleBreadcrumbs: true,
    enableAutoSessionTracking: false,
    enableNetworkStatusMonitoring: false,
    tracesSampleRate: 0,
  };
  const defaults = Sentry.getDefaultIntegrations(options);
  const client = initialize({ ...options, defaultIntegrations: defaults });
  expect(client.getOptions().integrations.map((integration) => integration.name)).toEqual(
    defaults.map((integration) => integration.name),
  );
  expect(defaults.map((integration) => integration.name)).toEqual(
    expect.arrayContaining([
      'Dedupe',
      'FunctionToString',
      'NetworkBreadcrumbs',
      'PageBreadcrumbs',
      'PageTracing',
      'ConsoleBreadcrumbs',
      'EventFilters',
    ]),
  );
  expect(defaults.map((integration) => integration.name)).not.toContain('Session');
});

test('integration callbacks run once and may remove supplied defaults', () => {
  const defaultIntegration: Integration = { name: 'CustomDefault', setup: vi.fn() };
  const integrations = vi.fn((defaults: Integration[]) => {
    expect(defaults).toEqual([defaultIntegration]);
    return [];
  });
  const client = initialize({ defaultIntegrations: [defaultIntegration], integrations });
  expect(integrations).toHaveBeenCalledTimes(1);
  expect(client.getOptions().integrations).toEqual([]);
  expect(defaultIntegration.setup).not.toHaveBeenCalled();
});

test('defaultIntegrations false prevents every implicit platform integration', () => {
  const custom = { name: 'Explicit' };
  const client = initialize({ integrations: [custom], tracesSampleRate: 1 });
  expect(client.getOptions().integrations).toEqual([custom]);
});

test('Logs and Metrics are disabled by default despite the new upstream defaults', async () => {
  const client = initialize();
  expect(client.getOptions().enableLogs).toBe(false);
  expect(client.getOptions().enableMetrics).toBe(false);
  Sentry.logger.info('should not enqueue');
  Sentry.metrics.count('should_not_enqueue');
  await client.flush(2000);
  expect(envelopes).toEqual([]);

  const standalone = new Sentry.MiniappClient({ enableOfflineCache: false });
  expect(standalone.getOptions().enableLogs).toBe(false);
  expect(standalone.getOptions().enableMetrics).toBe(false);
  await standalone.close(0);
});

test('explicit telemetry opt-ins and the legacy experiments retain core precedence', () => {
  const client = initialize({
    enableLogs: false,
    _experiments: { enableLogs: true, enableMetrics: true },
  });
  expect(client.getOptions().enableLogs).toBe(false);
  expect(client.getOptions().enableMetrics).toBe(true);
});

test('captureFeedback is the core function and honors an explicit scope and event hint', async () => {
  expect(Sentry.captureFeedback).toBe(coreCaptureFeedback);
  const client = initialize();
  const scope = new Scope();
  scope.setClient(client);
  scope.setTag('scope', 'explicit');
  const eventId = 'b'.repeat(32);
  expect(
    Sentry.captureFeedback(
      { message: 'feedback', tags: { nullable: null } },
      { event_id: eventId },
      scope,
    ),
  ).toBe(eventId);
  await client.flush(2000);
  expect(eventPayloads()[0]).toMatchObject({
    event_id: eventId,
    tags: { scope: 'explicit', nullable: null },
  });
});

test('captureFeedback allocates an event ID without a bound client', () => {
  expect(Sentry.captureFeedback({ message: 'not sent' }, {}, new Scope())).toMatch(
    /^[a-f0-9]{32}$/,
  );
  expect(envelopes).toEqual([]);
});

test('event preparation uses the isolation scope supplied by core', async () => {
  const client = initialize();
  Sentry.getIsolationScope().setTag('origin', 'ambient');
  const capturedIsolation = new Scope();
  capturedIsolation.setTag('origin', 'captured');
  const event = await client['_prepareEvent'](
    { message: 'scope contract' },
    {},
    new Scope(),
    capturedIsolation,
  );
  expect(event?.tags?.origin).toBe('captured');
});

test('miniapp platform labels do not replace the JavaScript event protocol platform', async () => {
  const client = initialize({ platform: 'alipay' });
  Sentry.captureMessage('platform contract');
  await client.flush(2000);
  expect(eventPayloads()[0]).toMatchObject({
    platform: 'javascript',
    contexts: { miniapp: { platform: 'alipay' } },
  });
});

test('LinkedErrors uses its owning client parser instead of the ambient client', () => {
  initialize({ stackParser: () => [{ filename: 'ambient.ts' }] });
  const owner = new Sentry.MiniappClient({ stackParser: () => [{ filename: 'owner.ts' }] });
  const original = Object.assign(new Error('outer'), { cause: new Error('inner') });
  const event = new Sentry.Integrations.LinkedErrors().processEvent(
    { exception: { values: [{ type: 'Error', value: 'outer' }] } },
    { originalException: original },
    owner,
  );
  expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe('owner.ts');
  void owner.close(0);
});

test('event preparation failures cannot bypass core event processors', async () => {
  const client = initialize();
  const failure = new Error('core preparation failed');
  const prepare = vi.spyOn(Client.prototype as any, '_prepareEvent').mockImplementation(() => {
    throw failure;
  });
  try {
    expect(() => client['_prepareEvent']({ message: 'must not be sent' }, {})).toThrow(failure);
    expect(envelopes).toEqual([]);
  } finally {
    prepare.mockRestore();
  }
});

test('wrap remains lazy, idempotent and captures one error through the real core pipeline', async () => {
  const client = initialize();
  const error = new Error('wrapped');
  const callback = vi.fn(() => {
    throw error;
  });
  const wrapped = Sentry.wrap(callback);
  expect(callback).not.toHaveBeenCalled();
  expect(Sentry.wrap(callback)).toBe(wrapped);
  expect(Sentry.wrap(wrapped)).toBe(wrapped);
  expect(() => wrapped()).toThrow(error);
  await client.flush(2000);
  expect(eventPayloads()).toHaveLength(1);
  expect(eventPayloads()[0]?.extra?.arguments).toBeUndefined();
});

test('closing a client does not reinstall core global instrumentation on the next init', async () => {
  const integration = Sentry.functionToStringIntegration();
  const client = initialize({ integrations: [integration] });
  const patched = Function.prototype.toString;
  await client.close(0);
  expect(installedIntegrations).toContain('FunctionToString');
  initialize({ integrations: [Sentry.functionToStringIntegration()] });
  expect(Function.prototype.toString).toBe(patched);
});

test('callback types and custom stack parser options follow the official core contract', async () => {
  const beforeSend: NonNullable<Options['beforeSend']> = (event, hint) => {
    expect(hint.event_id).toBeDefined();
    return event;
  };
  const tracesSampler: NonNullable<Options['tracesSampler']> = (context) =>
    context.inheritOrSampleWith(0);
  const client = initialize({
    beforeSend,
    tracesSampler,
    stackParser: [[1, () => ({ filename: 'custom.ts', function: 'parsed', lineno: 1, colno: 2 })]],
  });
  Sentry.captureException(new Error('parser'));
  await client.flush(2000);
  expect(eventPayloads()[0]?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe(
    'custom.ts',
  );
});
