# Taro React 接入示例

这些片段展示 Taro 4.2.x + React 18 微信小程序如何初始化 SDK、接入页面生命周期和订阅 Replay 状态。**本目录不是可独立运行的应用脚手架**，请将相关代码合入现有 Taro 工程。

## 合入现有工程

在自己的 Taro 工程中安装测试版：

```sh
pnpm add @xumoses/sentry-taro
```

需要固定版本时，在包名后加上具体版本（如 `@0.1.1`）；版本变化见 [CHANGELOG](../../CHANGELOG.md)。随后按下表接入：

| 文件                                       | 接入方式                                                             |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [`src/sentry.ts`](./src/sentry.ts)         | 初始化一次 SDK，并共享 Replay integration                            |
| [`src/app.tsx`](./src/app.tsx)             | 在页面创建前安装一次全局生命周期适配，保留现有应用的样式和启动逻辑   |
| [`src/pages/replay/`](./src/pages/replay/) | 复制合成页面，并在自己的 `app.config.ts` 中注册 `pages/replay/index` |

全局生命周期适配已管理页面录制，示例页面只用 `useTaroReplaySnapshot` 订阅状态。同一页面不要再加入 `useTaroReplayRoot`。

## 观察示例

示例使用虚构 DSN 与内存 transport，无需 Sentry 账号，也不会向外部服务发送数据。页面显示合成计数、Replay 状态和本地收集的 envelope 数量。

点击增加计数按钮可产生页面变化；点击合成异常按钮会捕获错误并触发错误缓冲提升。录制达到最短发送时长后才会发送 Replay 分段，具体发送行为见 [API 指南](../../website/guide/api.md)。

内存 transport 的成功返回只表示本地收集完成，不能证明网络发送、Sentry 接收或真实 Playback。页面上的计数由 React 渲染，本目录不提供回放播放器。

## 接入真实服务

将 DSN 换为自己的项目配置，并移除示例的自定义 `transport`，即可使用 SDK 默认传输。示例为便于观察合成文本设置了 `maskAllText: false`；接入真实业务时删除该设置，保留默认隐私遮罩，并按业务需要配置采样。

- [Replay 接入与隐私](../../website/guide/replay.md)：采样、遮罩、生命周期以及静态样式和图片接入。
- [Worker 压缩](../../website/guide/worker.md)：复制和启用独立压缩脚本。
- [原生与 Taro 混合应用](../../website/guide/hybrid-apps.md)：从宿主取得 bridge，复用唯一 SDK 实例。
