# Sentry for Taro

[![npm beta](https://img.shields.io/npm/v/%40xumoses%2Fsentry-taro/beta)](https://www.npmjs.com/package/@xumoses/sentry-taro)
[![CI](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.en.md) · [快速开始](#快速开始) · [使用文档](./docs/README.md) · [示例](./examples/taro-react/README.md) · [问题反馈](https://github.com/xumoses/sentry-taro/issues)

`@xumoses/sentry-taro` 是面向 **Taro React 微信小程序**的社区 Sentry SDK，提供错误监控、性能监控和可选的 Session Replay，帮助你结合错误上下文与用户操作定位问题。

- **错误监控**：捕获异常，结合页面、网络请求和设备上下文排查问题，也可主动上报业务异常。
- **性能监控**：通过采样追踪页面加载、网络请求和自定义操作的耗时。
- **Session Replay**：按会话或错误采样录制 Taro 页面，在 Sentry 中查看关联回放；文本和输入默认遮罩，媒体默认遮挡。

## 支持范围

| 环境     | 当前接入范围                                            |
| -------- | ------------------------------------------------------- |
| 框架     | Taro 4.2.x、React 18                                    |
| 平台     | 微信小程序；Replay 的支持范围不包含 H5 或其他小程序平台 |
| 安装环境 | Node.js ≥ 20；已有的 Taro React 项目                    |

**当前为 Beta。** 错误接收与 Replay 播放已在微信开发者工具中验证，真机验收尚未完成。使用前请在自己的服务和目标设备上验证；当前未承诺最低微信基础库版本。

## 快速开始

### 1. 安装

```sh
npm install @xumoses/sentry-taro@beta
```

使用 pnpm 时运行 `pnpm add @xumoses/sentry-taro@beta`。需要锁定版本时，将 `beta` 替换为具体版本号。

### 2. 初始化错误监控

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

### 3. 上报第一条异常

在测试页面的按钮回调中调用：

```ts
import { Sentry } from '../../sentry';

Sentry.captureException(new Error('My first Sentry error'));
```

在 Sentry 项目的 Issues 中查看该异常。若没有收到，先检查 DSN、环境筛选和小程序的请求是否成功。性能采样及更多配置见 [API 与配置](./docs/guides/api.md)。

## 开启 Session Replay

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

然后在应用入口、页面创建之前安装一次生命周期适配。将下面的初始化语句合入现有入口，保留原有的 App 组件：

```ts
// src/app.tsx
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

installTaroReplayPageLifecycle({ bridge: replay.bridge });
```

该示例在本地缓冲操作，并在捕获异常时按 100% 的错误采样率尝试上传；请根据流量调整采样。默认录制至少约 5 秒才发送，测试时先操作页面，再触发异常。

默认遮罩用于保护页面内容；你主动附加的异常文本和上下文仍需自行检查。回放的样式和图片可由 [Taro 构建插件](./docs/guides/taro-plugin.md) 自动准备，完整配置、隐私选项及排查方法见 [Replay 指南](./docs/guides/replay.md)。

## 使用文档

| 你想做什么                            | 文档                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| 设置上下文、性能采样或手动控制 Replay | [API 与配置](./docs/guides/api.md)                                    |
| 接入页面、调整采样和隐私、排查回放    | [Replay 指南](./docs/guides/replay.md)                                |
| 配置 Worker 压缩                      | [Worker 指南](./docs/guides/worker.md)                                |
| 接入原生小程序与 Taro 混合应用        | [混合宿主指南](./docs/guides/hybrid-apps.md)                          |
| 从旧 SDK 和 Replay 包迁移             | [迁移指南](./docs/migrations/legacy-packages.md)                      |
| 参考接入代码或了解版本变化            | [示例](./examples/taro-react/README.md) · [CHANGELOG](./CHANGELOG.md) |

## 反馈与贡献

遇到问题请提交 [Issue](https://github.com/xumoses/sentry-taro/issues)，附上版本、复现步骤和不含敏感数据的最小示例。欢迎修正文档、补充复现或提交代码；开发环境和检查命令见 [贡献指南](./CONTRIBUTING.md)。

## 许可证

由 [xumoses](https://github.com/xumoses) 维护，使用 [MIT](./LICENSE) 许可证。基于 Sentry core，继承及内嵌依赖的声明见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)。
