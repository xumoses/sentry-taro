import * as Sentry from '@xumoses/sentry-taro';

const options: Sentry.ReplayIntegrationOptions = { replaysOnErrorSampleRate: 1 };
const integration: Sentry.TaroReplayIntegration = Sentry.replayIntegration(options);
const legacy: Sentry.TaroReplayIntegration = Sentry.taroReplayIntegration({ sdk: Sentry });
const node: Sentry.TaroReplayNodeLike = {
  nodeType: 1,
  nodeName: 'view',
  childNodes: [],
  addEventListener(_type, listener) {
    listener({ detail: { scrollTop: 0 } });
  },
  removeEventListener() {},
};
const runtime: Sentry.TaroReplayRuntime = {
  document: { getElementById: () => node },
  MutationObserver: class {
    observe(_target: Sentry.TaroReplayNodeLike) {}
    disconnect() {}
  },
  getCurrentInstance: () => ({ router: { path: 'pages/synthetic/index' } }),
};

Sentry.init({ integrations: [integration], replaysSessionSampleRate: 0 });
Sentry.captureException(new Error('Synthetic declaration consumer'));
void integration.bridge.getSnapshot();
void Sentry.createTaroReplay({ sdk: Sentry, runtime });
void legacy;
void node;
