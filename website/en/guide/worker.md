# Worker compression

Replay can compress recording segments in a standalone WeChat mini-program Worker. The Worker is optional; without `compression`, recordings are sent uncompressed. It only processes recording data that has already been produced and never reads page DOM.

Complete [Replay initialization and the page lifecycle](./replay) first.

## 1. Add the Worker to the host build output

The package's `@xumoses/sentry-taro/worker` export points to a standalone script; importing it on the main thread does not set it up. The host build must copy the file into the final mini-program directory.

Create this CommonJS script in the host project:

```js
// scripts/copy-sentry-worker.cjs
const { copyFileSync, mkdirSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

// Pass the final mini-program directory; this example defaults to dist.
const appOutput = resolve(process.argv[2] || 'dist');
const workerOutput = join(appOutput, 'workers');
const source = require.resolve('@xumoses/sentry-taro/worker');

mkdirSync(workerOutput, { recursive: true });
copyFileSync(source, join(workerOutput, 'sentry-replay.js'));
copyFileSync(join(dirname(source), 'fflate.LICENSE'), join(workerOutput, 'fflate.LICENSE'));
```

Run it after the host build finishes and before opening DevTools or uploading:

```sh
node scripts/copy-sentry-worker.cjs dist
```

Hook the command into your existing build so it runs again every time the output directory is cleaned. You can also use the host bundler's asset-copy configuration; the result must include `dist/workers/sentry-replay.js`. If the mini-program root is not `dist`, pass the actual output path.

The [Taro build plugin](./taro-plugin#worker-and-native-npm-packaging) can also copy the Worker for you.

## 2. Declare the Worker directory

The final WeChat mini program's `app.json` must contain:

```json
{
  "workers": "workers"
}
```

Taro apps should set `workers: 'workers'` in the app config that generates `app.json`, such as `src/app.config.ts`. Native hosts edit their app config directly. If a Worker directory already exists, reuse it and adjust both the copy target and the `workerPath` in the next step.

## 3. Enable compression

Configure the path in your existing initialization:

```ts
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration({
  compression: {
    workerPath: 'workers/sentry-replay.js',
  },
});

// Pass replay to the integrations of your existing Sentry.init and keep the page lifecycle attached.
```

`workerPath` is relative to the final mini-program root, not to the host source directory or the npm package. Workers are created with `wx.createWorker` by default; hosts with an existing Worker factory can provide `compression.createWorker`. See [ReplayCompressionOptions and ReplayWorker](https://github.com/xumoses/sentry-taro/blob/main/src/replay/compression.ts) for the signature and return-object requirements.

## Fallback and verification

If creating the Worker, the handshake, compression or messaging fails, delivery falls back to uncompressed data. If the compressed result is not smaller than the original, the original is sent. Startup and each compression have a 2-second timeout by default, configurable with `compression.timeoutMs`.

Compression does not change sampling, privacy, the minimum send duration, recording budgets or delivery queue limits, and it does not guarantee that the uploaded mini-program package fits platform size limits.

To verify, check that the file path in the final output matches `app.json`, then run one recording delivery in the host. `replay.bridge.getSnapshot().delivery` shows the delivery state; actual ingestion and playback on the service are the final word. Verify in DevTools and on target devices separately.

The standalone Worker bundles the compression code it needs, so it never loads the main-thread npm package. When copying, rebuilding or redistributing, keep the license comment in the script and the accompanying `fflate.LICENSE`, and follow the package's [LICENSE](https://github.com/xumoses/sentry-taro/blob/main/LICENSE) and [THIRD_PARTY_NOTICES](https://github.com/xumoses/sentry-taro/blob/main/THIRD_PARTY_NOTICES).

Read next: [Session Replay](./replay) · [Hybrid apps](./hybrid-apps) · [Migration](./migration)
