# Build plugin, release identity, sourcemaps, Worker

`@xumoses/sentry-taro/taro-plugin` runs in Node during the Taro build (WeChat target, Taro 4.2, Webpack 5 only — other compilers error out). It never sends network requests at build time and does not enable Replay or change privacy settings.

## Pure Taro app

Add to the `plugins` array of the Taro base config (usually in `config/index.ts`), keeping existing plugins and the file's existing `defineConfig`/merge structure:

```ts
const baseConfig = {
  // ...existing config
  plugins: [
    [
      '@xumoses/sentry-taro/taro-plugin',
      {
        release: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
        // replay: { worker: {} },   // also write workers/sentry-replay.js
        // replay: false,            // skip Replay assets/Worker; release + sourcemaps still work
      },
    ],
  ],
};
```

What it does on every build (including watch):

- Generates `replay-assets.json` in the output dir (styles + audited static images per route). Wire it with `createReplayAssetProviders` — see `replay.md` §5.
- Enables column `source-map` and repairs maps after Taro's `require()` prefix / strict-directive rewrites (only `.map` files change).
- Resolves release identity: `release.name` → `SENTRY_RELEASE` → CI/Git revision; `release.dist` → `SENTRY_DIST`. Writes `sentry-build.json` to the output and, with `release.inject` (default `true`), injects it as the SDK default. An explicit `release` in `Sentry.init()` still wins, so either omit it from `init` or keep it identical to the upload.
- With Replay enabled, turns on Taro `enableMutationObserver`.

Options aligned with `@sentry/webpack-plugin`: `disable`, `silent`, `debug`, `errorHandler`, `release.{name,dist,inject}`, `sourcemaps.disable`. Unknown options throw.

## Upload WeChat final sourcemaps

Local Taro output is recompiled by WeChat, so upload the **final** maps that WeChat returns (`getDevSourceMap` / CI download) after the WeChat upload step. Install the CLI only where uploads run:

```sh
pnpm add -D @sentry/cli@^3.6.2
```

```js
// scripts/upload-sourcemaps.cjs — run after the WeChat upload + sourcemap download
const { readSentryBuildMetadata, uploadSourceMaps } = require('@xumoses/sentry-taro/taro-plugin');

(async () => {
  const metadata = readSentryBuildMetadata({
    outputRoot: './dist',
    expected: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
  });
  if (!metadata.release) throw new Error('A release is required for sourcemap upload');

  await uploadSourceMaps({
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    // url: 'https://sentry.example.com/', // self-hosted
    release: { name: metadata.release, dist: metadata.dist },
    wechat: { sourceMapPath: process.env.WECHAT_SOURCEMAP_ZIP },
  });
})();
```

- `wechat.sourceMapPath` accepts the WeChat ZIP or an extracted directory preserving its structure. `__APP__` is flattened, `__FULL__` excluded, subpackages kept. Default URL prefix `https://usr` matches the SDK's WeChat frame normalization — don't change it unless the user changed stack normalization.
- Read metadata from the exact output that was uploaded to WeChat; never regenerate identity before upload.
- Credentials must come from CI secrets. Never write the auth token into files.
- Not implemented (unknown fields error): `rewriteSources`, `resolveSourceMap`, `filesToDeleteAfterUpload`, `setCommits`, `deploy`, `telemetry`, Debug ID upload.

## Worker

Pure Taro: `replay: { worker: {} }` writes `workers/sentry-replay.js` into the Taro output (`outputRoot` and `filename` are configurable). The host must still add `workers: 'workers'` to `src/app.config.ts` and set `compression.workerPath` at runtime.

Native/hybrid host, after the host's npm packing step:

```js
const {
  writeReplayWorker,
  getSentryMiniProgramNpmIgnores,
} = require('@xumoses/sentry-taro/taro-plugin');

writeReplayWorker({ projectDir: process.cwd() }); // workers/sentry-replay.js
const ignores = getSentryMiniProgramNpmIgnores(); // merge into existing packNpmManually ignores
```

Use the npm ignores helper only when the native entry already bundles Sentry core; otherwise it may exclude packages the app needs.

## Hybrid (native host + Taro output)

When the build copies Taro output into a native project, generate assets **after** the copy step instead of relying on plugin hook ordering:

```ts
import { generateReplayAssets } from '@xumoses/sentry-taro/taro-plugin';

generateReplayAssets({
  replay: {
    sourceRoot: './src',
    outputRoot: '../native/mini',
    appRoot: '../native', // must contain outputRoot
    output: 'modules', // replay-styles.js + replay-images.js; default 'json'
  },
});
```

With `output: 'modules'`, the native host consumes them:

```js
const { decodeReplayAssetData } = require('@xumoses/sentry-taro');
const getReplayStyles = require('./mini/replay-styles.js')(decodeReplayAssetData);
const getReplayImageSources = require('./mini/replay-images.js')(decodeReplayAssetData, (path) =>
  wx.getFileSystemManager().readFileSync(path, 'base64'),
);
```

Release identity for hybrid builds — create once, write into the native output, read at runtime:

```js
const {
  createSentryBuildMetadata,
  writeSentryBuildMetadata,
} = require('@xumoses/sentry-taro/taro-plugin');

const metadata = createSentryBuildMetadata({
  projectDir: process.cwd(),
  release: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
});
writeSentryBuildMetadata({ metadata, outputRoot: './native/mini', format: 'module' });
// native init: const { release, dist } = require('./mini/sentry-build.js');
```

In a hybrid app the native host owns `Sentry.init()` and the Replay integration, and exposes `replay.bridge` to Taro through the app's own host-communication layer. Taro pages call `installTaroReplayPageLifecycle({ bridge })` with that bridge and must not import the host init module (that would bundle a second SDK). Inspect the final main package and subpackages to confirm only one SDK runtime ships.
