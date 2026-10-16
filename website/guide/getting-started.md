# 快速开始

`@xumoses/sentry-taro` 基于官方 `@sentry/core`，公共 API 与默认行为沿用 Sentry 的名称和语义。

## 支持范围

| 环境     | 当前接入范围                                            |
| -------- | ------------------------------------------------------- |
| 框架     | Taro 4.2.x、React 18                                    |
| 平台     | 微信小程序；Replay 的支持范围不包含 H5 或其他小程序平台 |
| 安装环境 | Node.js ≥ 20；已有的 Taro React 项目                    |

::: warning 当前为 Beta
错误接收与 Replay 播放已在微信开发者工具中验证，真机验收尚未完成。使用前请在自己的服务和目标设备上验证。
:::

## 安装

```sh
npm install @xumoses/sentry-taro@beta
```

## 初始化

整个应用只初始化一次，并在应用入口顶部导入：

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

```ts
// src/app.tsx
import './sentry';
```

在页面中调用 `Sentry.captureException(new Error('My first Sentry error'))`，然后在 Sentry 项目的 Issues 中查看。

## 下一步

- [开启 Session Replay](https://github.com/xumoses/sentry-taro/blob/main/docs/guides/replay.md)
- [API 与配置](https://github.com/xumoses/sentry-taro/blob/main/docs/guides/api.md)
- [Taro 构建插件](https://github.com/xumoses/sentry-taro/blob/main/docs/guides/taro-plugin.md)
- [从旧 SDK 迁移](https://github.com/xumoses/sentry-taro/blob/main/docs/migrations/legacy-packages.md)
