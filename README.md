# @xumoses/sentry-taro

[English](./README.en.md)

作者：xumoses。面向 Taro 4.2.x + React 18 微信小程序的错误监控、性能监控与显式开启的 Session Replay，基于 `@sentry/core@10.66.0`。

**当前状态：第一阶段本地候选包集成验收已完成；npm 未发布。** 当前本地候选版本为 `0.1.0-beta.1`。候选 tarball 的本地接入及真实 Sentry 接收、关联与 Playback 已通过，具体范围及产物校验值见[验收记录](./docs/implementation/phase-one.md)。正式发布、依赖锁文件迁移及发布包 CI 安排到第二阶段，版本和标签届时决定。真机验收在第二阶段重构完成后进行，以 iOS 为准，Android 后续补充。不承诺未经验证的最低微信基础库版本。其他既有平台能力保留，但不据此宣称 Replay 已跨平台验收。

## 初始化

第一阶段从仓库运行 `pnpm pack --pack-destination .artifacts` 生成本地 tarball，再在应用中使用 `pnpm add /path/to/candidate.tgz` 试用；候选包接入不需要公网发布。后续 npm 发布版本与标签以正式发布说明为准。下面是纯 Taro 应用的入口片段，DSN 替换为自己的项目配置；错误监控可单独使用，省略 Replay integration 和页面生命周期接入即可。

```ts
// src/sentry.ts：整个应用仅初始化一次。
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration();
Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  environment: 'production',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [...Sentry.getDefaultIntegrations(), replay],
});
export { Sentry };
```

`replayIntegration()` 自动使用同包 SDK。默认遮罩文字和输入、遮挡媒体；不要直接将示例中的全量采样用于高流量生产环境。

## Taro 页面接入

推荐在 Taro 应用入口、页面创建之前安装一次生命周期适配：

```tsx
// src/app.tsx
import type { PropsWithChildren } from 'react';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

installTaroReplayPageLifecycle({ bridge: replay.bridge });
export default function App({ children }: PropsWithChildren) {
  return children;
}
```

```tsx
// 页面：只订阅状态，生命周期由应用入口管理。
import { Button, Text, View } from '@tarojs/components';
import { useTaroReplaySnapshot } from '@xumoses/sentry-taro/react/root';
import { replay, Sentry } from '../../sentry';

export default function ExamplePage() {
  const snapshot = useTaroReplaySnapshot({ bridge: replay.bridge });
  return <View>
    <Text>{snapshot.state}</Text>
    <Button onClick={() => Sentry.captureException(new Error('synthetic example error'))}>
      触发合成异常
    </Button>
  </View>;
}
```

也可逐页使用 `useTaroReplayRoot({ bridge })`；同一页面不要同时使用全局生命周期适配和 root hook。`/react` 的 `useTaroReplay` 是低层单次录制接口，hide/unload 后不自动恢复，不等同于连续会话接入。

原生宿主 + Taro 混合应用应在原生入口持有唯一 SDK/client/coordinator，通过应用自己的 bridge 将 `replay.bridge` 传入 Taro；Taro 侧仅导入 `/taro/lifecycle`、`/react/root` 等轻量入口，避免再引入完整 SDK。静态样式和图片由宿主构建提供，可通过 `getReplayStyles`、`getReplayImageSources` 回调交给生命周期适配；包不自动读取应用 CSS 或打包所有业务资源。

## 可选 Worker 压缩

宿主构建时复制独立资产，示例脚本为 CommonJS：

```js
const { copyFileSync, mkdirSync } = require('node:fs');
mkdirSync('workers', { recursive: true });
copyFileSync(require.resolve('@xumoses/sentry-taro/worker'), 'workers/sentry-replay.js');
```

在微信 `app.json` 中加入 `"workers": "workers"`，初始化时改为：

```ts
const replay = Sentry.replayIntegration({
  compression: { workerPath: 'workers/sentry-replay.js' },
});
```

Worker 创建、压缩或通信失败时降级为原始录制；这不取消录制限额或投递限制。独立脚本无需导入主线程 npm 包，分发时保留其许可通知。

## 接口与迁移

| 原导入 | 新导入 |
| --- | --- |
| `@xumoses/sentry-miniapp` | `@xumoses/sentry-taro` |
| `@xumoses/sentry-miniapp-replay-taro` | `@xumoses/sentry-taro` |
| Replay 的 `/react`、`/react/root`、`/taro/lifecycle`、`/worker`、`/devtools/server` | 新包的同名子路径 |

更新 manifest、锁文件、Worker 复制脚本及宿主 npm 构建规则，并删除旧运行时产物。`taroReplayIntegration` 保留为兼容入口，可省略 `sdk`；低层 recorder/React API 保留既有选项，不承诺所有入口都自动注入 SDK。

此包正在分期对齐官方 API，当前不宣称与官方浏览器/React Replay 完全兼容。`replay.bridge.flush()` 在 error-buffer 状态不主动发送缓冲录制；显式发送使用 `sendBufferedReplay()`。`Sentry.flush(timeout)` 则等待 SDK transport，并不会主动切分 recorder；需要主动排出当前会话分段时先调用 bridge.flush，再等待 Sentry.flush。`bridge.stop({ flush })` 停止录制，亦不等同于官方所有控制方法的行为。

附带 viewer 只展示 capture 摘要、事件与 JSON，不提供实际回放渲染。轻量 [接入示例](./examples/taro-react/README.md) 仅展示用法，不承担第一阶段验收职责。真实服务接收、Playback、CI 和真机结论需各自验证。

## 开发与许可

合并阶段统一 pnpm，暂保留 SDK 的 Jest 与 Replay 的 Vitest；最终使用 Vite、Vitest、Oxlint、Oxfmt。具体执行命令以根 `package.json` 为准。[方案与文档](./docs/README.md)记录阶段边界。

开发使用 `.node-version` 中的 Node.js `24.21.0` 和 pnpm `9.15.9`。消费者包的 Node.js engine 为 `>=20`，不等同于开发工具所需版本。当前根构建采用 Vite `6.4.1` / TypeScript `5.8.3`，SDK 测试使用 Jest `29.7.0`；Replay 暂用 Vite+ `0.2.6`、Vitest `4.1.10` 和 TypeScript `7.0.2`。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run verify:package
pnpm pack --pack-destination .artifacts
pnpm run verify:consumer --online
```

`pnpm pack` 会重新构建并检查产物，只生成本地 tarball。`verify:consumer` 默认读取 `.artifacts/xumoses-sentry-taro-0.1.0-beta.1.tgz`，也可传入其他 `.tgz` 路径；它在不安装 React/Taro 的临时消费者中检查严格类型和真实 SDK 行为。脚本默认离线，缓存完整时可省略 `--online`；新环境使用 `--online` 从公开 npm registry 拉取依赖，不发布包。

[第一阶段实施进度](./docs/implementation/phase-one.md)分别记录本地通过项、待完成的候选包真实集成验收，以及第二阶段的发布和设备验收安排。

本项目使用 [MIT](./LICENSE)。继承的上游和内嵌依赖声明见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)。
