# 快速开始

`@xumoses/sentry-taro` 是面向 **Taro React 微信小程序**的社区 Sentry SDK，提供错误监控、性能监控和可选的 Session Replay。它基于官方 `@sentry/core`，公共 API 与默认行为沿用 Sentry 的名称和语义；设计取舍见[核心概念](./concepts)。

## 支持范围

| 环境     | 当前接入范围                                            |
| -------- | ------------------------------------------------------- |
| 框架     | Taro 4.2.x、React 18                                    |
| 平台     | 微信小程序；Replay 的支持范围不包含 H5 或其他小程序平台 |
| 安装环境 | Node.js ≥ 20；已有的 Taro React 项目                    |

::: tip 验证范围
错误上报、Replay 播放与栈帧还原已在电脑微信上验收；手机微信待验证。使用前请在自己的服务和目标设备上验证；当前未承诺最低微信基础库版本。
:::

## 1. 安装

::: code-group

```sh [npm]
npm install @xumoses/sentry-taro
```

```sh [pnpm]
pnpm add @xumoses/sentry-taro
```

```sh [yarn]
yarn add @xumoses/sentry-taro
```

:::

需要锁定版本时，在包名后加上具体版本号，例如 `@xumoses/sentry-taro@0.1.0`。

## 2. 初始化错误监控

从你的 Sentry 项目取得 DSN，创建以下模块。整个应用只初始化一次。

```ts
// src/sentry.ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  environment: 'production',
  sendDefaultPii: false,
  traceNetworkBody: false,
});

export { Sentry };
```

在现有应用入口顶部导入，保留原有的样式和启动逻辑：

```ts
// src/app.tsx
import './sentry';
```

::: tip 合法域名
真机只能请求小程序后台配置过的域名。请把 Sentry 接收地址的域名加入微信公众平台的 `request` 合法域名，否则开发者工具里能收到的事件在真机上不会发送。
:::

## 3. 上报第一条异常

在测试页面的按钮回调中调用：

```ts
import { Sentry } from '../../sentry';

Sentry.captureException(new Error('My first Sentry error'));
```

在 Sentry 项目的 Issues 中查看该异常。若没有收到，先检查 DSN、环境筛选和小程序的请求是否成功。性能采样、上下文和更多配置见 [API 与配置](./api)。

## 4. 开启 Session Replay（可选）

Replay 需要显式开启。将上面的 `src/sentry.ts` 替换为以下配置：

```ts
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

然后在应用入口、页面创建之前安装一次生命周期适配，保留原有的 App 组件：

```ts
// src/app.tsx
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

installTaroReplayPageLifecycle({ bridge: replay.bridge });
```

该示例在本地缓冲操作，并在捕获异常时按 100% 的错误采样率尝试上传；请根据流量调整采样。默认录制至少约 5 秒才发送，测试时先操作页面，再触发异常。

默认遮罩用于保护页面内容；你主动附加的异常文本和上下文仍需自行检查。回放的样式和图片可由 [Taro 构建插件](./taro-plugin) 自动准备，完整配置、隐私选项及排查方法见 [Session Replay](./replay)。

## AI 辅助接入

仓库提供适用于 Claude Code、Cursor 等工具的 Agent Skill（英文），覆盖新项目接入、Replay、构建插件，以及从 `@xumoses/sentry-miniapp` / `@xumoses/sentry-miniapp-replay-taro` 迁移：

```sh
npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro
```

安装后让 Agent“为这个 Taro 应用接入 Sentry”或“从 sentry-miniapp 迁移”即可。Skill 源文件见 [`skills/sentry-taro`](https://github.com/xumoses/sentry-taro/blob/main/skills/sentry-taro/SKILL.md)。

## 下一步

| 你想做什么                             | 文档                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 了解设计取舍和能力边界                 | [核心概念](./concepts)                                                                            |
| 设置上下文、性能采样或手动控制 Replay  | [API 与配置](./api)                                                                               |
| 接入页面、调整采样和隐私、排查回放     | [Session Replay](./replay)                                                                        |
| 准备 Replay 资源、构建身份和 sourcemap | [Taro 构建插件](./taro-plugin)                                                                    |
| 配置 Worker 压缩                       | [Worker 压缩](./worker)                                                                           |
| 接入原生小程序与 Taro 混合应用         | [混合应用](./hybrid-apps)                                                                         |
| 从旧 SDK 和 Replay 包迁移              | [旧包迁移](./migration)                                                                           |
| 参考接入代码                           | [Taro React 示例](https://github.com/xumoses/sentry-taro/blob/main/examples/taro-react/README.md) |
