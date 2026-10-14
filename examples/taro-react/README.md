# 轻量 Taro React 接入 demo

这些片段展示 Taro 4.2.x + React 18 微信小程序如何初始化统一包、接入页面生命周期和订阅 Replay 状态。第一阶段本地候选包集成验收已完成，npm 尚未发布；具体范围见[验收记录](../../docs/implementation/phase-one.md)。本目录不是完整应用脚手架，也不承担验收职责。

将 `src/sentry.ts`、`src/app.tsx` 和 `src/pages/replay/index.tsx` 的接入方式合入自己的 Taro 工程，并在自己的 `app.config.ts` 中注册 `pages/replay/index`。现有应用入口仍需保留自己的样式和启动逻辑。

示例使用虚构 DSN 与内存 transport，只收集合成页面产生的 envelope，不向外部服务发送数据，无需 Sentry 账号。页面展示合成计数、Replay 状态和本地 envelope 数量；点击合成异常后触发错误缓冲提升。计数本身由 React 渲染，与 transport 收集不同。

内存 transport 的成功返回只表示本地收集完成，不证明网络请求、服务接收或真实 Playback。使用真实服务时将 `transport` 换为默认配置并设置自己的 DSN；不要把示例的遮罩关闭选项带入真实业务页面。

全局 lifecycle adapter 已管理录制根，因此页面仅用 `useTaroReplaySnapshot` 订阅；不要同时加入 `useTaroReplayRoot`。混合原生宿主应用应从宿主取得 bridge，Taro 侧不再初始化完整 SDK。Worker 和静态样式/图片接入见[主 README](../../README.md)。
