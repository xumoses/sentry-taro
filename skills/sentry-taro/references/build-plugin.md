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

- `wechat.sourceMapPath` accepts the WeChat ZIP or an extracted directory preserving its structure. `__APP__` is flattened, `__FULL__` excluded, subpackages kept.
- **Frame paths must match the upload prefix.** Uploads default to the URL prefix `https://usr` (artifacts named `https://usr/app-service.js`, subpackages `https://usr/<root>/app-service.js`). Versions after `0.1.0-beta.6` install `rewriteFramesIntegration()` by default, which writes device frames (`https://usr/...`, `appservice/...`) to exactly those names and leaves DevTools `http://127.0.0.1:<port>/...` frames unchanged. No extra config is needed with the default prefix. If `wechat.urlPrefix` is customized, pass the same value to the SDK:

  ```ts
  Sentry.init({
    // ...
    integrations: [Sentry.rewriteFramesIntegration({ prefix: 'https://runtime.example.test' })],
  });
  ```

  On `0.1.0-beta.6` or earlier the default writes `app:///...`, which does not match. Either upgrade, or add `enableSourceMap: false` plus `new Sentry.Integrations.RewriteFrames({ prefix: 'https://usr/' })`; remove both after upgrading. When migrating a host that normalized frames itself in `beforeSend` (often with `enableSourceMap: false`), that code can be dropped. Verify on a real event that business frames resolve to source before relying on it.

- **Runtime frames pointing at an unrelated business file** (for example every React/Taro runtime frame resolving to one page's line 11) mean WeChat dropped a chunk's map from the final map. Up to `0.1.0-rc.1` the plugin could emit maps with null or empty `sourcesContent` entries or `../` sources (typically `taro.js`), which WeChat drops whole. From `0.1.0-rc.2` the plugin renames such sources to `__external__/...` and fills missing content with a placeholder comment; rebuild and re-upload after upgrading.
- **Main-package frames wrong only on desktop WeChat** (phones and subpackages fine) come from a WeChat-side line offset: the desktop client runs extra lines ahead of the mapped main-package code; columns are correct. From `0.1.0-rc.3` the default `rewriteFramesIntegration()` corrects known clients (currently Mac WeChat `4.1.15.55`, 1406 lines) and marks events with `contexts.miniapp.main_package_line_offset`. Unlisted desktop versions are left unchanged; do not add a manual offset in `beforeSend`, and report the client version instead.

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
