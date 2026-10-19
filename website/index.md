---
layout: home

hero:
  name: Sentry for Taro
  text: 小程序里的 Sentry
  tagline: 面向 Taro React 微信小程序的社区 SDK，提供错误监控、性能监控和可选的 Session Replay。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 核心概念
      link: /guide/concepts
    - theme: alt
      text: GitHub
      link: https://github.com/xumoses/sentry-taro

features:
  - title: 错误监控
    details: 捕获异常与未处理的 Promise rejection，附带页面、网络请求和设备上下文。
    link: /guide/api
    linkText: API 与配置
  - title: 性能监控
    details: 按采样追踪页面加载、网络请求和自定义操作的耗时。
    link: /guide/api#性能监控
    linkText: 配置采样
  - title: Session Replay
    details: 可选开启，按会话或错误采样录制 Taro 页面；文本和输入默认遮罩，媒体默认遮挡。
    link: /guide/replay
    linkText: 接入 Replay
  - title: 官方语义
    details: 基于官方 @sentry/core 10.76.2，公共 API 与默认行为沿用 Sentry 的名称和语义。
    link: /guide/concepts
    linkText: 设计理念
  - title: 构建插件
    details: 在 Taro 构建阶段准备 Replay 样式与图片、release 身份，并上传微信最终 sourcemap。
    link: /guide/taro-plugin
    linkText: 配置插件
  - title: AI 辅助接入
    details: 提供 Agent Skill，让 Claude Code、Cursor 等工具完成接入、Replay 配置与旧包迁移。
    link: /guide/getting-started#ai-辅助接入
    linkText: 安装 Skill
---
