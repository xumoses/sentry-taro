# 从旧 SDK 和 Replay 包迁移

`@xumoses/sentry-taro` 将错误监控 SDK 与 Taro Replay 放入同一个包。新项目直接从[快速开始](./getting-started)接入；本文面向使用以下旧包的应用。

使用 Claude Code、Cursor 等工具时，可以安装仓库的 [Agent Skill](./getting-started#ai-辅助接入) 并让 Agent 按[英文迁移清单](https://github.com/xumoses/sentry-taro/blob/main/skills/sentry-taro/references/migration.md)完成检索、替换和检查；迁移结果仍需按本文最后一节验证。

## 替换依赖与导入

| 原导入                                                | 新导入                                 |
| ----------------------------------------------------- | -------------------------------------- |
| `@xumoses/sentry-miniapp`                             | `@xumoses/sentry-taro`                 |
| `@xumoses/sentry-miniapp-replay-taro`                 | `@xumoses/sentry-taro`                 |
| `@xumoses/sentry-miniapp-replay-taro/react`           | `@xumoses/sentry-taro/react`           |
| `@xumoses/sentry-miniapp-replay-taro/react/root`      | `@xumoses/sentry-taro/react/root`      |
| `@xumoses/sentry-miniapp-replay-taro/taro/lifecycle`  | `@xumoses/sentry-taro/taro/lifecycle`  |
| `@xumoses/sentry-miniapp-replay-taro/worker`          | `@xumoses/sentry-taro/worker`          |
| `@xumoses/sentry-miniapp-replay-taro/devtools/server` | `@xumoses/sentry-taro/devtools/server` |

在应用目录中安装新包。替换完导入并确认其他代码不再使用旧依赖后，再移除旧包：

```sh
pnpm add @xumoses/sentry-taro@beta
```

```sh
pnpm remove @xumoses/sentry-miniapp @xumoses/sentry-miniapp-replay-taro
```

按实际使用的包管理器更新 manifest 和锁文件。同步修改 Worker 复制脚本、原生 npm 构建规则和子路径导入，清理旧构建产物后重新构建。

## 合并初始化

统一使用根入口的 `replayIntegration()`，它默认使用同包 SDK，无需传入 `sdk`：

```ts
import * as Sentry from '@xumoses/sentry-taro';

export const replay = Sentry.replayIntegration();

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});
```

`taroReplayIntegration` 作为兼容名称保留，也可省略 `sdk`。低层 recorder 和 React API 保留各自选项，不应假定所有入口都自动注入 SDK。

整个应用保留一套初始化。原生宿主持有 SDK 的应用，将它的 `replay.bridge` 传给 Taro，具体见[混合宿主指南](./hybrid-apps.md)。

## 检查页面与控制逻辑

- 应用入口安装 `installTaroReplayPageLifecycle({ bridge: replay.bridge })`，或者逐页使用 `useTaroReplayRoot`；同一页面选择一种生命周期所有者。
- 仅展示状态的页面使用 `useTaroReplaySnapshot`。低层 `useTaroReplay` 是单次录制接口，不负责 hide/unload 后自动恢复。
- 使用 `Sentry.getReplay()` 取得当前 integration。它的注册名称为 `Replay`，旧名称查找逻辑需要更新。
- 新接入使用 `replay.flush()` 发送 buffer 并继续 session；旧 `bridge.flush()` 仍只发送 session 分段。
- 默认最短发送时长约 5 秒，短录制可能延后发送或在显式停止时丢弃。完整语义见 [API 与配置](./api.md)。

## 检查构建与升级结果

推荐消费 ESM，包也保留 CJS 和独立 Worker。当前版本不提供 UMD。开启 Worker 的应用应从新包重新复制资产，并保留其许可通知，见 [Worker 指南](./worker.md)。

升级后用合成页面检查错误接收、Replay 关联、页面切换、文本遮罩及 Worker 投递；在应用自己的 CI、目标设备和上传包中验证构建与体积。

从较早 Beta 版本升级时，还应核对[运行时迁移说明](https://github.com/xumoses/sentry-taro/blob/main/docs/migrations/phase-two-runtime.md)中的配置类型、默认集成、会话策略和平台字段变化，以及 [CHANGELOG](https://github.com/xumoses/sentry-taro/blob/main/CHANGELOG.md)。
