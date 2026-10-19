# Sentry for Taro

[![npm rc](https://img.shields.io/npm/v/%40xumoses%2Fsentry-taro/rc)](https://www.npmjs.com/package/@xumoses/sentry-taro)
[![CI](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xumoses/sentry-taro/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文](./README.md) · Docs: [sentry-taro.pages.dev](https://sentry-taro.pages.dev/en/)

A community Sentry SDK for **Taro React WeChat mini programs**, built on the official `@sentry/core`.

- **Error monitoring**: capture exceptions with page, network and device context.
- **Performance monitoring**: sample traces for page loads, network requests and custom operations.
- **Session Replay**: opt-in recording of Taro pages linked to errors. Text and inputs are masked and media is blocked by default.

## Quick start

```sh
npm install @xumoses/sentry-taro@rc
```

See the [documentation site](https://sentry-taro.pages.dev/en/guide/getting-started) for initialization, Replay setup, the build plugin and all configuration. You can also install the [agent skill](./skills/sentry-taro/SKILL.md) and let Claude Code, Cursor and similar tools handle setup or legacy migration:

```sh
npx skills add https://github.com/xumoses/sentry-taro --skill sentry-taro
```
