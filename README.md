# Sentry for Taro

[![npm beta](https://img.shields.io/npm/v/%40xumoses%2Fsentry-taro/beta)](https://www.npmjs.com/package/@xumoses/sentry-taro)
[![CI](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.en.md) · [文档](https://sentry-taro.pages.dev/guide/getting-started) · [核心概念](https://sentry-taro.pages.dev/guide/concepts) · [问题反馈](https://github.com/xumoses/sentry-taro/issues)

`@xumoses/sentry-taro` 是面向 **Taro React 微信小程序**的社区 Sentry SDK，基于官方 `@sentry/core`，提供错误监控、性能监控和可选的 Session Replay。

- **错误监控**：捕获异常，附带页面、网络请求和设备上下文。
- **性能监控**：按采样追踪页面加载、网络请求和自定义操作。
- **Session Replay**：可选开启，录制 Taro 页面并与错误关联；文本和输入默认遮罩，媒体默认遮挡。

当前支持 Taro 4.2.x + React 18 + 微信小程序，仍为 **Beta**：错误接收与 Replay 播放已在微信开发者工具中验证，真机验收尚未完成。

## 快速开始

```sh
npm install @xumoses/sentry-taro@beta
```

```ts
// src/sentry.ts，在 src/app.tsx 顶部 import './sentry'
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
});
```

完整步骤、Replay 接入和配置见[文档](https://sentry-taro.pages.dev/guide/getting-started)。也可以安装 [Agent Skill](./skills/sentry-taro/SKILL.md)，让 Claude Code、Cursor 等工具完成接入或旧包迁移：

```sh
npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro
```

## 文档

| 主题                                                             | 内容                                       |
| ---------------------------------------------------------------- | ------------------------------------------ |
| [快速开始](https://sentry-taro.pages.dev/guide/getting-started)  | 安装、初始化、上报第一条异常、开启 Replay  |
| [核心概念](https://sentry-taro.pages.dev/guide/concepts)         | 设计理念、关键术语与能力边界               |
| [Session Replay](https://sentry-taro.pages.dev/guide/replay)     | 页面接入、采样、隐私、手动控制与排查       |
| [Taro 构建插件](https://sentry-taro.pages.dev/guide/taro-plugin) | Replay 资源、release 身份与 sourcemap 上传 |
| [API 与配置](https://sentry-taro.pages.dev/guide/api)            | 初始化选项、集成、性能监控、Replay 控制    |
| [从旧包迁移](https://sentry-taro.pages.dev/guide/migration)      | 从 `@xumoses/sentry-miniapp` 系列包迁移    |

文档站点为 [sentry-taro.pages.dev](https://sentry-taro.pages.dev/)，源码在 [`website/`](./website/)，版本变化见 [CHANGELOG](./CHANGELOG.md)，设计决策见 [docs/](./docs/README.md)。

## 反馈与贡献

问题请提交 [Issue](https://github.com/xumoses/sentry-taro/issues)，附上版本、复现步骤和不含敏感数据的最小示例。开发环境与检查命令见[贡献指南](./CONTRIBUTING.md)。

## 许可证

由 [xumoses](https://github.com/xumoses) 维护，使用 [MIT](./LICENSE) 许可证。继承及内嵌依赖的声明见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)。
