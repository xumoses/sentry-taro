# @xumoses/sentry-taro

[English](./README.en.md)

作者：xumoses。面向 Taro 4.2.x + React 18 微信小程序的错误监控、性能监控与显式开启的 Session Replay，基于 `@sentry/core@10.76.2`。

**当前为 beta 阶段。第二阶段 10.76.2 运行时基线已通过本地检查、宿主 tarball 接入及真实 Sentry 错误接收、Replay 关联与 Playback 验证。** 首发目标为 `0.1.0-beta.1`、npm `beta` 标签，发布流程见[发包说明](./docs/releases.md)。准确校验值、合成场景与验收边界见[第二阶段记录](./docs/implementation/phase-two.md)。本次真实发送来自微信开发者工具，不能替代真机验收；第一阶段原 tarball 的证据保留在[原验收记录](./docs/implementation/phase-one.md)。正式依赖切换、发布包 CI 及设备验收继续分期推进。真机以 iOS 为准，Android 后续补充。不承诺未经验证的最低微信基础库版本。其他既有平台能力保留，但不据此宣称 Replay 已跨平台验收。

## 初始化

从仓库运行 `vp pm pack --pack-destination .artifacts` 生成本地 tarball，再在应用中使用 `pnpm add /path/to/candidate.tgz` 试用；候选包接入不需要公网发布。npm 发布后可使用 `pnpm add @xumoses/sentry-taro@0.1.0-beta.1` 固定版本，或使用 `@beta` 跟随测试版本；是否已发布以 npm registry 为准。下面是纯 Taro 应用的入口片段，DSN 替换为自己的项目配置；错误监控可单独使用，省略 Replay integration 和页面生命周期接入即可。

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
  integrations: [replay],
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
  return (
    <View>
      <Text>{snapshot.state}</Text>
      <Button onClick={() => Sentry.captureException(new Error('synthetic example error'))}>
        触发合成异常
      </Button>
    </View>
  );
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

| 原导入                                                                              | 新导入                 |
| ----------------------------------------------------------------------------------- | ---------------------- |
| `@xumoses/sentry-miniapp`                                                           | `@xumoses/sentry-taro` |
| `@xumoses/sentry-miniapp-replay-taro`                                               | `@xumoses/sentry-taro` |
| Replay 的 `/react`、`/react/root`、`/taro/lifecycle`、`/worker`、`/devtools/server` | 新包的同名子路径       |

更新 manifest、锁文件、Worker 复制脚本及宿主 npm 构建规则，并删除旧运行时产物。`taroReplayIntegration` 保留为兼容入口，可省略 `sdk`；低层 recorder/React API 保留既有选项，不承诺所有入口都自动注入 SDK。

`Sentry.getReplay()` 返回当前 client 注册的 Replay integration，可直接调用 `start()`、`startBuffering()`、`flush()`、`stop()`、`getReplayId()` 和 `getRecordingMode()`。`replay.flush()` 默认发送 error buffer 并继续 session 录制；`stop()` 默认发送 session 剩余数据、丢弃未发送 buffer。采样率为 0 时，已接入的可见页面也能手动开始录制。

`bridge` 继续承担 Taro 页面和视口接入，兼容 `bridge.flush()` 只发送 session 分段；显式发送 buffer 的旧入口 `bridge.sendBufferedReplay()` 保留。`Sentry.flush(timeout)` 只等待 SDK transport，主动发送录制时先 `await Sentry.getReplay()?.flush()`，再 `await Sentry.flush(timeout)`。

默认最短发送时长为 4,999 毫秒；此前 `flush()` 会安排延后发送并立即返回，显式停止则丢弃短录制。默认采用 60 秒滚动 buffer、60 分钟会话上限和 session 的 5 分钟空闲暂停、15 分钟空闲过期；字节和事件预算仍可能缩短实际保留窗口。Logs/Metrics 默认关闭，当前目标服务未支持。上游 API、平台扩展、beta 行为变化及未实现的浏览器选项见[运行时迁移说明](./docs/migrations/phase-two-runtime.md)，本包不宣称完整浏览器 Replay 兼容。

附带 viewer 只展示 capture 摘要、事件与 JSON，不提供实际回放渲染。轻量 [接入示例](./examples/taro-react/README.md) 仅展示用法，不承担第一阶段验收职责。真实服务接收、Playback、CI 和真机结论需各自验证。

## 开发与许可

第二阶段统一使用 Vite Plus `1.2.0` 管理 Vite、Vitest、Oxlint、Oxfmt 和库构建；SDK 与 Replay 测试共用 Vitest。开发使用 `.node-version` 固定的 Node.js `26.12.0`、根 `package.json` 固定的 pnpm `12.13.0` 和 TypeScript `7.0.2`。消费者包的 Node.js engine 仍为 `>=20`，开发工具版本不改变小程序产物的语法目标。

安装全局 `vp` 后，先运行 `vp env install`，再用 `vp env current --json`、`vp exec node --version` 和 `vp exec pnpm --version` 确认实际执行版本。已有 Vite Plus 若使用 `system_first`，项目版本声明不会覆盖 PATH 中的系统工具；[开发环境复现说明](./docs/implementation/phase-two.md#开发环境复现)提供只影响当前进程的处理方式。

```sh
vp install --frozen-lockfile
vp check
vp run typecheck
vp test run
vp run build
vp run verify:package
vp pm pack --pack-destination .artifacts
vp run verify:bundles
vp run verify:consumer --online
```

`vp pack` 负责库构建；`vp pm pack` 经 pnpm 运行 `prepack`，重新构建并检查产物后生成本地 tarball。`verify:consumer` 默认读取 `.artifacts/xumoses-sentry-taro-0.1.0-beta.1.tgz`，也可传入其他 `.tgz` 路径；它在不安装 React/Taro 的临时消费者中检查严格类型和真实 SDK 行为。脚本默认离线，缓存完整时可省略 `--online`；新环境使用 `--online` 从公开 npm registry 拉取依赖，不发布包。

[第二阶段实施进度](./docs/implementation/phase-two.md)记录本轮验证状态；[第一阶段记录](./docs/implementation/phase-one.md)保留原候选包证据。**npm 发布前暂停，等待用户确认。**

本项目使用 [MIT](./LICENSE)。继承的上游和内嵌依赖声明见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)。
