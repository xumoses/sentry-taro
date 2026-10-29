# 修复版 0.1.1 实施记录

更新时间：2026-10-29。对应[发布流程](../releases.md#常规-tag-发布)的候选验收与正式版准备。

## 候选发布

`0.1.1-beta.1` 于 2026-10-28 由 [Actions run 40679574340](https://github.com/xumoses/sentry-taro/actions/runs/40679574340) 发布到 npm `beta` 渠道，修复内容见 [CHANGELOG](../../CHANGELOG.md)。

- 源码：`659523e`；Git tag：`v0.1.1-beta.1`。
- registry `dist.integrity`：`sha512-K8dAorvv/x65arJzNT+xfAEJRuf2mAvs4YlUyL7dNsrC8I5tnGohm1rL3KqzwO/aoBeCsdmr0QgD+gt8zn9/mg==`。

## 体验版验收

首个验证项目改用 `0.1.1-beta.1` 后，在微信体验版上以真实 Sentry 服务端数据核验三项修复：

| 修复                                                            | 电脑微信（Mac）                           | 手机微信（iOS）                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `{ errMsg }` rejection 以 `Error: <errMsg>` 为标题，不带 SDK 帧 | 未自然触发                                | 通过：自然发生的 `hideLoading:fail toast can't be found`，0 帧，原对象在 `extra.__serialized__`，并关联 Replay |
| Replay 记录点击                                                 | 通过：11 次点击均有 `ui.click` 与 Click   | 通过：页面跳转点击均有完整 MouseInteraction 与 `ui.click`                                                      |
| 每个 segment 只上报新进入的页面                                 | 通过：18 段、7 个 URL，与实际页面序列一致 | 通过：首页 → 二级页面 → 首页往返为 3 个 URL                                                                    |

点击只覆盖 Taro 实际派发的事件：Taro 为只绑定 `onClick` 的 View 使用仅绑定 `tap` 的 `click-view` 模板，这类节点只有 Click 与 `ui.click`，没有 TouchStart/TouchEnd，与 CHANGELOG 中“只能观察到 Taro 实际派发的事件”一致。

验证项目的部署身份、事件与 Replay 标识、原始录制保存在公开仓库之外。

## 正式版准备

验收通过后，以 `0.1.1-beta.1` 的运行时源码准备 `0.1.1`：版本号与 `publishConfig.tag` 改为 `0.1.1` / `latest`，并更新 CHANGELOG、发布流程中的渠道现状和固定版本示例。`0.1.1` 的 tarball 需由 tag 工作流重新准备，经审批后发布；发布结果补记于本文。

## 已知问题

- reason 带 `errMsg` 但并非失败的对象（如业务代码 reject 的 `wx.request` 成功回调，`errMsg` 为 `request:ok`）同样以 `errMsg` 为标题，标题不含状态码，不同接口会合并为同一 issue。计划后续版本只对 `…:fail …` 使用 `errMsg` 标题。
- 内联样式中的 `url()` 会被过滤，以 CSS mask 绘制的图标（如 NutUI 图标）在 Playback 中不可见；节点与点击仍被记录。
- dead/rage click 计数仍为 0：尚未识别慢点击和连击。
- 全量快照内联整份样式表，长会话数据量较大。

## 未覆盖

Android 手机微信、Windows 电脑版、Mac 上自然发生的 `errMsg` rejection 及其他小程序平台不在本次验收范围内。
