# API 与配置

本文介绍日常接入使用的 SDK API 和 Replay 控制。首次安装见[快速开始](../../README.md#快速开始)，页面录制接入见 [Replay 指南](./replay.md)。

## 初始化与上下文

在应用启动时调用一次 `Sentry.init()`，早于 App 和 Page 注册。常用配置如下：

| 配置                       | 用途                                           |
| -------------------------- | ---------------------------------------------- |
| `dsn`                      | Sentry 项目的接收地址                          |
| `environment`              | 区分开发、测试和生产环境                       |
| `release`                  | 应用版本标识，例如 `my-miniapp@1.0.0`          |
| `sampleRate`               | 错误事件采样率；与性能、Replay 采样分别配置    |
| `beforeSend`               | 发送前修改或过滤错误事件；返回 `null` 丢弃事件 |
| `beforeBreadcrumb`         | 修改或过滤面包屑；返回 `null` 丢弃该条记录     |
| `sendDefaultPii`           | 控制上游默认个人信息采集；建议显式设为 `false` |
| `traceNetworkBody`         | 请求和响应正文采集，默认关闭                   |
| `enableConsoleBreadcrumbs` | Console 面包屑，默认关闭                       |

默认集成包含全局异常、未处理的 Promise rejection、页面和网络面包屑，以及会话和系统信息。Replay 需另行添加 integration。

以下代码可在初始化后的页面或业务模块使用：

```ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.setTag('feature', 'demo');
Sentry.setContext('screen', { name: 'example', mode: 'preview' });
Sentry.addBreadcrumb({
  category: 'ui.action',
  message: 'Opened example panel',
  level: 'info',
});

Sentry.captureException(new Error('Synthetic example error'));
Sentry.captureMessage('Synthetic diagnostic message');
```

只附加排查需要且适合发送的数据。`sendDefaultPii: false` 和 Replay 遮罩不会自动清理你主动传入的异常文本、标签或自定义上下文。

## 错误采集集成

`captureConsoleIntegration` 和 `httpClientIntegration` 与官方 `@sentry/core` / `@sentry/browser` 10.76.2 同名、同参数、同默认值，均默认不启用，需在 `integrations` 中显式添加。宿主无需再自行包装 `console.error` 或请求回调：

```ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  integrations: [
    Sentry.captureConsoleIntegration({ levels: ['error'] }),
    Sentry.httpClientIntegration({ failedRequestStatusCodes: [[500, 599]] }),
  ],
});
```

`captureConsoleIntegration` 直接重导出 core 实现，行为不变：

| 选项      | 默认值                                                     | 说明                                   |
| --------- | ---------------------------------------------------------- | -------------------------------------- |
| `levels`  | `debug`、`info`、`warn`、`error`、`log`、`assert`、`trace` | 要上报的 console 级别                  |
| `handled` | `true`                                                     | 写入 `mechanism.handled`，可设为 false |

参数中有 `Error` 时按异常上报，否则把参数拼接为消息，`level` 取对应级别、`logger` 为 `console`，原始参数放在 `extra.arguments`；对象按官方规则拼接为 `[object Object]`。mechanism 为 `auto.core.capture_console`。已被全局异常处理上报过的同一 `Error` 对象不会重复上报。`levels` 含 `warn` 时，SDK 初始化等环节直接输出的少量 `console.warn` 提示也会被上报；离线缓存写入失败的提示已绕过 console 包装，不会形成循环。

`httpClientIntegration` 对平台请求 API（`wx.request`、`Taro.request`、支付宝 `my.request` / `my.httpRequest` 等）收到的 HTTP 响应生成错误事件：

| 选项                       | 默认值         | 说明                                             |
| -------------------------- | -------------- | ------------------------------------------------ |
| `failedRequestStatusCodes` | `[[500, 599]]` | `[起, 止]`（含两端）区间与单个状态码，可混合使用 |
| `failedRequestTargets`     | `[/.*/]`       | 字符串（子串）或正则，匹配调用方传入的完整 URL   |

事件结构与官方一致：消息与异常值为 `HTTP Client Error with status code: <状态码>`，`request` 含 `url`、`method`，`contexts.response` 含 `status_code`；`mechanism.handled` 为 `false`。请求头、响应头和 cookie 仅在 `sendDefaultPii: true` 或 `dataCollection` 允许时附带，敏感字段按 core 规则替换为 `[Filtered]`。Sentry 自身的上报请求不会触发事件。

与官方实现的差异：

- `request.url` 去除账号密码、query 和 fragment，与网络面包屑及 Replay 网络详情的 URL 策略一致；官方保留完整 URL。`failedRequestTargets` 仍按官方语义匹配完整 URL，匹配只在本地进行。
- mechanism 类型为 `auto.http.client.request`；官方按来源为 `auto.http.client.fetch` 或 `auto.http.client.xhr`。
- 只处理收到 HTTP 响应的请求（进入 `success` 回调）；超时、断网等进入 `fail` 回调的请求不生成事件，对应官方 fetch 失败时不上报。
- 请求头取调用方传入的 `header` / `headers`，不含 SDK 注入的 `sentry-trace` / `baggage`；响应 cookie 先读 `Set-Cookie` 响应头，没有时读微信的 `cookies` 数组。
- 复用默认集成 `NetworkBreadcrumbs` 对请求 API 的同一处包装，不重复修改平台方法。使用 `defaultIntegrations: false` 时需同时添加 `new Sentry.Integrations.NetworkBreadcrumbs()`，否则不会生成事件。

两项集成已有本地 core 管线测试，微信开发者工具与桌面微信的端到端验证待完成。

## 性能监控

在现有 `init` 配置中设置 `tracesSampleRate` 或 `tracesSampler`。下面示例对 trace 按 10% 采样，并将追踪头的传播范围限定到示例 API；请替换为自己的后端地址。

```ts
import * as Sentry from '@xumoses/sentry-taro';

Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  sendDefaultPii: false,
  traceNetworkBody: false,
  tracesSampleRate: 0.1,
  tracePropagationTargets: [/^https:\/\/api\.example\.com\//],
});
```

配置 trace 采样后，SDK 默认启用页面加载和切换的生命周期追踪，并对平台请求创建 `http.client` span。可用 `enablePageTracing: false` 关闭页面追踪。平台性能 API 提供的额外指标取决于实际运行环境。

`tracesSampler` 的优先级高于 `tracesSampleRate`。`tracePropagationTargets` 控制向哪些请求添加追踪头，设为 `[]` 可禁止传播；它不会关闭本地请求 span。

使用 `startSpan` 包裹需要计时的操作：

```ts
import * as Sentry from '@xumoses/sentry-taro';

const result = Sentry.startSpan({ name: 'prepare-demo-data', op: 'function' }, () => {
  return ['alpha', 'beta', 'gamma'].map((value) => value.toUpperCase());
});
```

## Replay 控制

添加 `replayIntegration()` 并完成页面接入后，可通过 `Sentry.getReplay()` 取得当前 client 的 integration；未添加时返回 `undefined`。

| 方法                                  | 行为                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `start()`                             | 手动开始 session 录制；自动采样率为 0 时也可调用                   |
| `startBuffering()`                    | 手动开始本地缓冲，等待异常触发或主动发送                           |
| `flush()`                             | 发送 session 分段；在 buffer 模式发送缓冲，并默认继续 session 录制 |
| `flush({ continueRecording: false })` | 发送 buffer 后停止继续录制，保留 buffer 身份                       |
| `stop()`                              | 停止录制；默认发送 session 剩余数据、丢弃未发送的 buffer           |
| `stop({ flush: true })`               | 停止录制，并尝试发送 session 或 buffer 剩余数据                    |
| `getReplayId()`                       | 获取当前 Replay 身份；停止或禁用时返回 `undefined`                 |
| `getRecordingMode()`                  | 返回 `session`、`buffer` 或 `undefined`                            |

手动开始也需要已接入的可见页面。处于活动的 session 或 buffer 时，`start()` / `startBuffering()` 不会新建身份或切换模式。`flush()` 在未启动时会尝试开始 session；需要彻底停止时调用 `stop()`。

`continueRecording: false` 仅影响 buffer；session 模式会忽略此选项并继续录制。保留的 buffer 身份可能在过期后的活动中重新采样。若要立即开启新一轮录制，先 `await replay.stop()`，再调用 `replay.start()` 或 `replay.startBuffering()`。

主动发送录制和 SDK 事件时，按以下顺序调用：

```ts
import * as Sentry from '@xumoses/sentry-taro';

async function flushMonitoring() {
  await Sentry.getReplay()?.flush();
  return Sentry.flush(2000);
}
```

`Sentry.flush(timeout)` 只等待 SDK 传输，不会主动排出录制器中的数据。默认最短录制时长为 4,999 毫秒；到龄前的 Replay `flush()` 会安排延后发送并返回，紧接着调用 SDK `flush()` 也不能提前上传。此时显式停止会丢弃短录制。

Replay 的公开 `flush()` / `stop()` 不会将传输错误作为 Promise rejection 抛出。可通过 integration 的 `onError` 或 `replay.bridge.getSnapshot()` 检查诊断，最终接收和播放结果应在 Sentry 中确认。

`bridge` 用于页面和视口适配。旧 `bridge.flush()` 只发送 session 分段，`bridge.sendBufferedReplay()` 才会显式发送 buffer；新接入优先使用上表的 integration 方法。

## 会话默认值

| 配置或行为            | 默认值                                |
| --------------------- | ------------------------------------- |
| `minReplayDuration`   | 4,999 毫秒，允许配置 0–50,000 毫秒    |
| 错误前缓冲窗口        | 60 秒，字节和事件预算可能缩短实际窗口 |
| `maxReplayDuration`   | 60 分钟，可配置更短时长               |
| `sessionIdlePauseMs`  | session 无操作 5 分钟后暂停录制       |
| `sessionIdleExpireMs` | session 无操作 15 分钟后过期          |

错误前的本地 buffer 使用滚动窗口，不套用 full-session 的空闲策略。缓冲、分段队列和重试均有资源限制；详见 [Replay 指南](./replay.md)。

## 导入入口与能力边界

| 入口                                   | 用途                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `@xumoses/sentry-taro`                 | SDK、`replayIntegration` 和公开类型                                           |
| `@xumoses/sentry-taro/taro/lifecycle`  | 全局 Taro 页面生命周期接入                                                    |
| `@xumoses/sentry-taro/react/root`      | `useTaroReplaySnapshot` 和逐页 `useTaroReplayRoot`                            |
| `@xumoses/sentry-taro/react`           | 低层单次录制 hook；hide/unload 后不自动恢复                                   |
| `@xumoses/sentry-taro/taro-plugin`     | Node 构建插件、产物准备与最终 sourcemap 上传，见 [插件指南](./taro-plugin.md) |
| `@xumoses/sentry-taro/worker`          | 构建时复制的独立 Worker 资产                                                  |
| `@xumoses/sentry-taro/devtools/server` | 本地 capture 查看工具的服务端入口                                             |

附带 viewer 只展示 capture 摘要、事件与 JSON，不渲染实际回放。实际 Playback 使用 Sentry。

本包不提供完整浏览器 DOM/BOM、浏览器 Replay selector 选项或反馈弹窗。`showReportDialog()` 是兼容空操作；`captureFeedback()` 提交反馈数据，不创建 UI。

Logs/Metrics 导出保留，默认关闭；是否可用还取决于你的接收服务，当前验证范围不包含这些功能。版本间的 API 和默认行为差异见[运行时迁移说明](../migrations/phase-two-runtime.md)。
