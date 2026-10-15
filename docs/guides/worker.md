# Worker 压缩

Replay 可以使用独立的微信小程序 Worker 压缩录制分段。Worker 是可选能力；省略 `compression` 时会发送未压缩录制。它只处理已生成的录制数据，不负责读取页面 DOM。

接入前先完成 [Replay 初始化和页面生命周期](./replay.md)。

## 1. 将 Worker 加入宿主构建产物

包的 `@xumoses/sentry-taro/worker` 导出指向独立脚本，不能仅通过在主线程 `import` 它来完成接入。宿主构建需要将文件复制到最终小程序目录。

在宿主项目创建下面的 CommonJS 脚本：

```js
// scripts/copy-sentry-worker.cjs
const { copyFileSync, mkdirSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

// 传入最终小程序目录；本例默认使用 dist。
const appOutput = resolve(process.argv[2] || 'dist');
const workerOutput = join(appOutput, 'workers');
const source = require.resolve('@xumoses/sentry-taro/worker');

mkdirSync(workerOutput, { recursive: true });
copyFileSync(source, join(workerOutput, 'sentry-replay.js'));
copyFileSync(join(dirname(source), 'fflate.LICENSE'), join(workerOutput, 'fflate.LICENSE'));
```

在宿主构建完成后、开发者工具打开或上传产物之前运行：

```sh
node scripts/copy-sentry-worker.cjs dist
```

将命令接入现有构建流程，确保每次清理输出目录后都会重新复制。也可以使用宿主构建器的资源复制配置，最终应存在 `dist/workers/sentry-replay.js`。如果小程序根目录不是 `dist`，传入实际输出路径。

## 2. 声明 Worker 目录

最终微信小程序的 `app.json` 需要包含：

```json
{
  "workers": "workers"
}
```

Taro 应用应在生成 `app.json` 的应用配置中设置 `workers: 'workers'`，例如 `src/app.config.ts`。原生宿主直接修改其应用配置。如果已有 Worker 目录，沿用现有目录并同时调整复制目标与下一步的 `workerPath`。

## 3. 开启压缩

在原有初始化代码中配置路径：

```ts
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration({
  compression: {
    workerPath: 'workers/sentry-replay.js',
  },
});

// 将 replay 传给现有 Sentry.init 的 integrations，并继续接入页面生命周期。
```

`workerPath` 相对于最终小程序根目录，不是宿主源码目录或 npm 包路径。默认通过 `wx.createWorker` 创建 Worker；已有 Worker 工厂的宿主可以提供 `compression.createWorker`，函数签名及返回对象要求见 [ReplayCompressionOptions 和 ReplayWorker](../../packages/replay/src/compression.ts)。

## 降级和验证

Worker 创建、握手、压缩或通信失败时，投递降级为未压缩数据。压缩结果不比原数据更小时，也使用原数据。启动和每次压缩默认各有 2 秒超时，可用 `compression.timeoutMs` 配置。

压缩不改变采样、隐私、最短发送时长、录制预算或投递队列限制，也不保证小程序上传包符合平台体积限制。

验证时检查最终产物中的文件路径与 `app.json` 一致，再在宿主运行一次录制发送。`replay.bridge.getSnapshot().delivery` 可用于观察投递状态；最终以服务实际接收和 Playback 为准。开发者工具验证与目标设备验证应分别进行。

独立 Worker 已内置所需压缩代码，无需在 Worker 中再次加载主线程 npm 包。复制、二次构建或分发时保留脚本内的许可证注释和附带的 `fflate.LICENSE`，并遵循包的 [LICENSE](../../LICENSE) 与 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES)。

继续阅读：[Replay 指南](./replay.md) · [混合应用](./hybrid-apps.md) · [旧包迁移](../migrations/legacy-packages.md)
