# Sentry for Taro

[![npm rc](https://img.shields.io/npm/v/%40xumoses%2Fsentry-taro/rc)](https://www.npmjs.com/package/@xumoses/sentry-taro)
[![CI](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.en.md) · 文档：[sentry-taro.pages.dev](https://sentry-taro.pages.dev/)

面向 **Taro React 微信小程序**的社区 Sentry SDK，基于官方 `@sentry/core`。

- **错误监控**：捕获异常，附带页面、网络请求和设备上下文。
- **性能监控**：按采样追踪页面加载、网络请求和自定义操作。
- **Session Replay**：可选开启，录制 Taro 页面并与错误关联；文本和输入默认遮罩，媒体默认遮挡。

## 快速开始

```sh
npm install @xumoses/sentry-taro@rc
```

初始化、Replay 接入、构建插件和全部配置见[文档站点](https://sentry-taro.pages.dev/guide/getting-started)。也可以安装 [Agent Skill](./skills/sentry-taro/SKILL.md)，让 Claude Code、Cursor 等工具完成接入或旧包迁移：

```sh
npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro
```
