# Taro build plugin

This entry is available from `0.1.0-beta.3`, published on the npm `beta` channel.

`@xumoses/sentry-taro/taro-plugin` runs in Node.js at build time. For WeChat mini programs it generates Replay styles and static image assets, and it handles build identity, Webpack sourcemap repair and optional Worker preparation. It is released with the runtime SDK at the same version, and its parsers only live in this separate build entry. The final WeChat sourcemaps are uploaded during release through `uploadSourceMaps` from the same entry.

## Pure Taro apps

Currently supported: WeChat mini programs, Taro 4.2 and Webpack 5. Other compilers fail with an explicit error.

Add the plugin to your existing Taro config:

```ts
export default {
  plugins: [
    [
      '@xumoses/sentry-taro/taro-plugin',
      {
        release: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
      },
    ],
  ],
};
```

The plugin uses `ctx.paths.sourcePath` and `ctx.paths.outputPath` and generates `replay-assets.json` on every `onBuildFinish`, including watch rebuilds. The file contains compressed asset data, not executable code. It only exists after the build finishes, so never import it statically from app source.

Configure asset reading after the existing Replay initialization and before pages are created:

```ts
import { createReplayAssetProviders } from '@xumoses/sentry-taro';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

const assets = createReplayAssetProviders({
  readAssetFile: () =>
    wx.getFileSystemManager().readFileSync('replay-assets.json', 'utf8') as string,
  readPackagedImage: (path) => wx.getFileSystemManager().readFileSync(path, 'base64') as string,
});

installTaroReplayPageLifecycle({ bridge: replay.bridge, ...assets });
```

The readers decode lazily and cache successful results; images are read per page. A file that is temporarily unavailable can be retried on later calls, and failures never break app pages. The plugin does not enable Replay or change privacy settings.

## Hybrid native + Taro apps

If your build first copies Taro output into a subdirectory of the native app, call `generateReplayAssets` from the same entry after the copy finishes. Don't rely on the ordering of two independent `onBuildFinish` callbacks.

```ts
import { generateReplayAssets } from '@xumoses/sentry-taro/taro-plugin';

// Run after your existing output copy; paths are relative to the current build process directory.
generateReplayAssets({
  replay: {
    sourceRoot: './src',
    outputRoot: '../native/mini',
    appRoot: '../native',
    output: 'modules',
    imagePriority: ['assets/brand/logo.png'],
  },
});
```

`appRoot` must contain `outputRoot`; it is used to resolve the native shared `app.wxss` and in-package image paths. The default route prefix is the relative path between them; override the recorded route prefix with `routePrefix`, while physical image read paths are still determined by the real package directory. Image priority only reorders selection within the budget; it does not widen what is allowed.

`output: 'modules'` generates `replay-styles.js` and `replay-images.js`, preserving the form native hosts `require` directly:

```js
const { decodeReplayAssetData } = require('@xumoses/sentry-taro');
const getReplayStyles = require('./mini/replay-styles.js')(decodeReplayAssetData);
const getReplayImageSources = require('./mini/replay-images.js')(decodeReplayAssetData, (path) =>
  wx.getFileSystemManager().readFileSync(path, 'base64'),
);
```

Keep passing these two callbacks to the existing lifecycle adapter. Hybrid apps can also use the default JSON output and point `readAssetFile` at `mini/replay-assets.json`.

## Build identity and sourcemaps

Through Taro 4 / Webpack 5 hooks, the plugin enables `source-map` with column information and repairs the mappings after Taro inserts its `require()` prefix and moves strict directives. The repair only updates `.map` files and never touches app JS. Unknown rewrites abort by default; when `errorHandler` allows continuing, the broken map is removed. An existing `devtoolModuleFilenameTemplate` is kept; otherwise project-relative `webpack:///` paths are used.

`release.name` comes from explicit config first, then `SENTRY_RELEASE`, then detected CI/Git revisions. `release.dist` comes from explicit config first, then `SENTRY_DIST`. The plugin never composes app versions or timestamps itself. The identity is fixed when the current compiler instance is created, reused across watch rebuilds, and written to `sentry-build.json` in the output directory. The default `release.inject: true` provides release/dist defaults to this SDK through Webpack compile-time constants; explicit values in the app's `Sentry.init()` still win, so keep them identical to the uploaded identity. Native modules that bypass Webpack can read the CJS metadata below and pass it to `init` explicitly.

A hybrid host can generate the identity once in its own build entry and write it into the native package after copying output:

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
// Generates sentry-build.js (native require) and sentry-build.json (read-only for upload).
```

Native initialization:

```js
const { release, dist } = require('./mini/sentry-build.js');
Sentry.init({ release, dist /* other options */ });
```

The host sets `release.name/dist` for app names, version formats and CI job numbers. Before uploading, only read the build output; never call create/write again to regenerate the identity.

## Upload the final WeChat sourcemaps

Local Taro output is compiled again by WeChat, so it cannot replace the final sourcemaps. Keep the WeChat upload and `getDevSourceMap` download steps in the host, then call the function below. Uploads use the official `@sentry/cli`; it is an optional peer that only development/CI environments doing uploads need to install (3.6.2 verified):

```sh
npm install --save-dev @sentry/cli@^3.6.2
```

```js
const { readSentryBuildMetadata, uploadSourceMaps } = require('@xumoses/sentry-taro/taro-plugin');

// After the WeChat upload, read the metadata of the package that was uploaded.
const metadata = readSentryBuildMetadata({
  outputRoot: './native/mini',
  expected: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
});
if (!metadata.release) throw new Error('A release is required for the final sourcemap upload');

await uploadSourceMaps({
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: { name: metadata.release, dist: metadata.dist },
  wechat: { sourceMapPath: downloadedSourceMapZipPath },
});
```

`wechat.sourceMapPath` accepts the ZIP downloaded from WeChat or a directory that keeps its original structure. The function safely extracts/copies into a temporary directory, flattens `__APP__`, excludes `__FULL__` and keeps subpackages. A single leading `/` in ZIP entries means the archive root and is removed before extraction; path traversal, platform-special paths and post-normalization name collisions still fail. `app-service.js.map` and `workers.js.map` without real JS get a file containing only the matching sourceMappingURL; existing real JS is left as is. A missing main package, valid mappings or complete JS/map pairs fails the upload, and it never falls back to uploading the local project directory. Uploads always use `rewrite: false`, `validate: true` and `dedupe: true`, with a default URL prefix of `https://usr`. The temporary directory is cleaned up on success or failure, and inputs are never modified.

The SDK's default `rewriteFramesIntegration()` (the official core integration of the same name, with a mini-program default iteratee) rewrites device frames `https://usr/<path>` and `appservice/<path>` to `https://usr/<path>`, matching the uploaded file names: `https://usr/app-service.js` for the main package and `https://usr/<subpackage root>/app-service.js` for subpackages. DevTools frames `http://127.0.0.1:<port>/…` are kept as is, because that package differs from the mappings uploaded at the end. When you customize `wechat.urlPrefix`, pass the same prefix in `init`'s `integrations`:

```ts
Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  integrations: [Sentry.rewriteFramesIntegration({ prefix: 'https://runtime.example.test' })],
});
```

`0.1.0-beta.6` and earlier rewrote to `app:///…` by default, which did not match the upload prefix. If you are still on those versions, set `enableSourceMap: false` in `init` and add `new Sentry.Integrations.RewriteFrames({ prefix: 'https://usr/' })`. Remove both after upgrading; see the [runtime migration notes](https://github.com/xumoses/sentry-taro/blob/main/docs/migrations/phase-two-runtime.md#栈帧路径) (Chinese). Local tests cover consistent naming on both sides; confirm actual symbolication in Sentry with real events.

## Worker and native npm packaging

The standalone Worker is copied on demand; this does not enable compression or modify WeChat's `app.json`:

```js
const {
  writeReplayWorker,
  getSentryMiniProgramNpmIgnores,
} = require('@xumoses/sentry-taro/taro-plugin');

// Run after cleaning/packing the native npm output; resolves the Worker from the SDK installed in the host.
writeReplayWorker({ projectDir: process.cwd() }); // workers/sentry-replay.js
const ignores = getSentryMiniProgramNpmIgnores();
// Merge into the ignores of your existing packNpmManually configuration.
```

The pure Taro plugin can set `replay.worker: {}` to write to the Taro output's `workers` directory by default; `outputRoot` and a single `filename` are supported. The source must be non-empty, copies are byte-identical, and a failure removes the stale target. The host still has to declare the Worker directory in `app.json` and set the runtime `workerPath`.

The npm ignores helper is only for packaging setups where the native entry already bundles Sentry core, to avoid packing `@sentry/core` / `@sentry/conventions` twice. If your app or other dependencies use those packages directly, evaluate the exclusions yourself. Clearing the whole npm output, `miniprogram-ci` packaging and WeChat credentials remain the host's responsibility.

## Options and official alignment

The following fields follow the naming and control semantics of the [official Sentry webpack plugin](https://www.npmjs.com/package/@sentry/webpack-plugin); this is an explicit subset:

| Entry                            | Options                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Plugin, asset generation, upload | `disable` (default false), `silent` (false), `debug` (false), `errorHandler`       |
| Taro plugin                      | `release.name/dist/inject` (inject defaults to true), `sourcemaps.disable` (false) |
| Upload function                  | `org`, `project` (string or array), `authToken`, `url`, `headers`                  |
| Upload function                  | `release.name/dist/create/finalize` (create/finalize default to true)              |
| Upload function                  | `sourcemaps.disable/assets/ignore`                                                 |

By default errors abort the build or reject the upload; when `errorHandler` returns normally the caller may continue, and throwing still fails. `silent` suppresses plugin logs and takes precedence over `debug`, but never swallows errors. `disable` skips the entry entirely; `replay: false` only turns off Replay assets/Worker/MutationObserver preparation, while identity and sourcemaps keep working. The upload function's `sourcemaps.disable` skips the whole upload phase, including release creation and finalize. The build phase makes no Sentry network requests and reads no upload credentials.

Upload `assets/ignore` are globs relative to the normalized WeChat artifact root; you cannot pass a directory scan in place of `wechat.sourceMapPath`. JS and maps are selected by default; selecting one side explicitly adds its pair, and an ignore that excludes a paired file fails. `wechat.urlPrefix` is a WeChat extension. The build phase does not accept upload fields. `rewriteSources`, `resolveSourceMap`, `filesToDeleteAfterUpload`, `setCommits`, `deploy`, `telemetry` and Debug ID uploads are not implemented yet; unknown fields raise errors rather than being silently accepted.

`replay` asset options include `sourceRoot`, `outputRoot`, `appRoot`, `routePrefix`, `output` (default json), `compactAssets` (default true) and `imagePriority` (default empty array). Relative paths are resolved against the Taro project directory under the plugin, and against `process.cwd()` under `generateReplayAssets`. When the plugin enables Replay it also turns on Taro's `enableMutationObserver`; it does not start Replay or change privacy settings.

## Asset discovery and limits

- Scans SVGs across the whole `sourceRoot`, including page and component directories; directory and file symlinks are not followed.
- Selects assets by the compiled app, pages and their JavaScript dependencies; SVG content must match the source exactly. It never puts every image in the source directory into every page.
- Keeps inline raster images, local raster files in the build output and verified SVGs. Dynamic URLs, network images and SVGs that fail verification are not collected automatically.
- Each image data URI is capped at 128 KiB; each route's image budget is at most 64 KiB and also limited by style and snapshot space. Budget shortfalls and SVGs without a source match produce diagnostics without printing full image contents.
- WXSS mini-program tag selectors are converted to Replay selectors, local imports are expanded, and conditions, cascade order and dynamic rules are kept. Final pixel layout of WeChat native controls is not computed.
- The static asset manifest grants explicit recording permission to images. Keep only app static assets in the source directory, never user images or sensitive runtime data.

This migration keeps discovery based on static references in compiled output. Runtime-composed paths, images of custom native components that don't appear in the build dependency graph, and automatic rewriting of CSS background images are not newly supported. The plugin does not provide CDN or historical asset hosting.
