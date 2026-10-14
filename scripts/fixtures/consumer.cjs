const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');

// All data is synthetic. Transport capture stays in memory; no requests are sent.
globalThis.wx = {
  request() { throw new Error('The consumer fixture must never send a network request'); },
  getSystemInfoSync: () => ({ platform: 'ios', system: 'iOS 18.0', SDKVersion: '3.0.0' }),
};
const Sentry = require('@xumoses/sentry-taro');
const packageRequire = createRequire(require.resolve('@xumoses/sentry-taro/package.json'));
const core = packageRequire('@sentry/core');

async function main() {
  const envelopes = [];
  const integration = Sentry.replayIntegration({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 });
  const client = Sentry.init({
    dsn: 'https://public@ingest.example.test/1',
    defaultIntegrations: false,
    integrations: [integration],
    enableSystemInfo: false,
    enableAutoSessionTracking: false,
    enableNavigationBreadcrumbs: false,
    enableUserInteractionBreadcrumbs: false,
    enableNetworkStatusMonitoring: false,
    enableSourceMap: false,
    enableOfflineCache: false,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
  try {
    assert.equal(Sentry.SDK_VERSION, process.argv[2]);
    const esm = await import('@xumoses/sentry-taro');
    for (const api of [Sentry, esm, core]) {
      assert.equal(api.getClient(), client, 'CJS, ESM and core must share one active client');
      assert.equal(api.getCurrentScope(), Sentry.getCurrentScope(), 'Imports must share one scope');
    }
    const eventId = esm.captureException(new Error('Synthetic packed-package error'));
    await client.flush(2000);
    const items = () => envelopes.flatMap((envelope) => envelope[1]);
    const event = items().find(([header, payload]) => header.type === 'event' && payload.event_id === eventId)?.[1];
    assert.ok(event, 'The packed SDK must deliver the captured error through the supplied transport');
    assert.equal(event.sdk.name, 'sentry.javascript.taro');
    assert.equal(event.sdk.version, process.argv[2]);
    assert.ok(event.sdk.packages.some((entry) => entry.name === 'npm:@xumoses/sentry-taro'));

    const bridge = integration.bridge;
    assert.equal(bridge.startBuffering(), true);
    const root = { nodeType: 1, nodeName: 'view', attributes: [], childNodes: [] };
    assert.equal(bridge.attachRoot({
      document: { getElementById: () => root },
      MutationObserver: class { observe() {} disconnect() {} },
      getCurrentInstance: () => ({ router: { $taroPath: 'pages/synthetic/index' } }),
      getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844 }),
      getEnv: () => 'WEAPP',
    }), true);
    assert.equal(bridge.getSnapshot().state, 'buffer');
    assert.ok(bridge.getReplayId());
    await bridge.flush();
    assert.equal(items().filter(([header]) => header.type === 'replay_event').length, 0,
      'Ordinary buffer flush must retain its existing no-upload behavior');
    await bridge.sendBufferedReplay();
    const replay = items().find(([header]) => header.type === 'replay_event')?.[1];
    assert.ok(replay, 'Explicit buffer submission must deliver a Replay envelope');
    assert.equal(replay.replay_id, bridge.getReplayId());
    await bridge.stop({ flush: false });
    assert.equal(bridge.getSnapshot().state, 'stopped');

    for (const entry of ['worker', 'devtools/server', 'react', 'react/root', 'taro/lifecycle']) {
      assert.ok(fs.existsSync(require.resolve(`@xumoses/sentry-taro/${entry}`)), `Missing subpath: ${entry}`);
    }
    console.log('Consumer runtime passed: CJS/ESM/core identity, error capture, Replay buffer/send/stop, 5 subpaths.');
  } finally {
    integration.cleanup();
    await client.close(0);
    Sentry.getCurrentScope().clear();
    Sentry.getIsolationScope().clear();
    Sentry.getCurrentScope().setClient(undefined);
    delete globalThis.wx;
  }
}

main().catch((error) => {
  console.error(`Synthetic consumer failed: ${error.message}`);
  process.exitCode = 1;
});
