import * as Sentry from '@xumoses/sentry-taro';
import sentryTaroPlugin, {
  generateReplayAssets,
  uploadSourceMaps,
  createSentryBuildMetadata,
  readSentryBuildMetadata,
  writeSentryBuildMetadata,
  writeReplayWorker,
  getSentryMiniProgramNpmIgnores,
  type SourceMapUploadOptions,
  type SentryTaroPluginOptions,
} from '@xumoses/sentry-taro/taro-plugin';

const pluginOptions: SentryTaroPluginOptions = {
  disable: true,
  replay: { sourceRoot: 'src', outputRoot: 'dist', imagePriority: ['brand.svg'] },
  errorHandler(error: Error) {
    throw error;
  },
};
generateReplayAssets(pluginOptions);
sentryTaroPlugin(
  {
    paths: { appPath: '.', sourcePath: 'src', outputPath: 'dist' },
    onBuildFinish(_callback) {},
    modifyRunnerOpts(_callback) {},
    modifyWebpackChain(_callback) {},
  },
  pluginOptions,
);

const buildMetadata = createSentryBuildMetadata({
  projectDir: '.',
  release: { name: 'synthetic@1', dist: 'build-1' },
});
writeSentryBuildMetadata({ metadata: buildMetadata, outputRoot: 'dist', format: 'module' });
const savedMetadata = readSentryBuildMetadata({
  outputRoot: 'dist',
  expected: { name: 'synthetic@1' },
});
writeReplayWorker({ projectDir: '.', filename: 'sentry-replay.js' });
const uploadOptions: SourceMapUploadOptions = {
  disable: true,
  release: { name: savedMetadata.release || 'synthetic@1', create: false, finalize: false },
  sourcemaps: { assets: '**/*.map', ignore: ['ignored/**'] },
  wechat: { sourceMapPath: 'final.zip' },
};
void uploadSourceMaps(uploadOptions);
void getSentryMiniProgramNpmIgnores();

const options: Sentry.ReplayIntegrationOptions = {
  replaysOnErrorSampleRate: 1,
  minReplayDuration: 4999,
  maxReplayDuration: 60 * 60_000,
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
};
const integration: Sentry.TaroReplayIntegration = Sentry.replayIntegration(options);
const legacy: Sentry.TaroReplayIntegration = Sentry.taroReplayIntegration({ sdk: Sentry });
const activeReplay: Sentry.TaroReplayIntegration | undefined = Sentry.getReplay();
const recordingMode: Sentry.ReplayRecordingMode | undefined = activeReplay?.getRecordingMode();
const flushOptions: Sentry.SendBufferedReplayOptions = { continueRecording: true };
void activeReplay?.flush(flushOptions);
void activeReplay?.getReplayId(true);
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
void activeReplay;
void recordingMode;
void node;
