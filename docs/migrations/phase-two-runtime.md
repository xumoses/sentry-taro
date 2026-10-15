# 第二阶段：10.76.2 运行时与 API 迁移

本轮将 `@sentry/core` 从 10.66.0 升级到精确版本 **10.76.2**，采用“官方 core + 小程序适配 + 可选 Taro DOM Replay”。以下描述本地实现和合成契约验证；目标服务、Playback、发布包 CI 和设备验收分别记录在[第二阶段进度](../implementation/phase-two.md)。npm 发布前暂停，版本号相同也不能延用旧 tarball 的验收结论。

## SDK 公共契约

- `MiniappOptions` 继承官方 core options，`beforeSend`、`beforeBreadcrumb`、`tracesSampler` 和 transport 使用其参数与返回值类型。平台扩展保持显式声明。
- `getDefaultIntegrations(options)` 返回与 `init` 一致的完整平台默认集成，包括官方 core 的 Dedupe 和 FunctionToString。一般接入直接使用 `integrations: [replayIntegration()]`，SDK 自动合并默认项；需要筛选时用 `integrations: defaults => defaults.filter(...)`。回调只执行一次，返回空数组现在会真正禁用全部默认项。
- `captureFeedback` 直接复用 core，支持第三个 scope 参数以及未初始化 client 时生成事件 ID。返回 ID 仅代表捕获标识，不代表服务已接受或展示反馈。
- 事件通过官方处理管线，保留传入的 isolation scope；处理失败不再回退为未经处理的事件。LinkedErrors 使用所属 client 的配置。
- `platform: 'wechat' | ...` 是小程序平台标签，写入 `contexts.miniapp.platform`。Sentry 协议的 `event.platform` 默认保持 `javascript`；曾依赖旧错误字段值的查询需调整。
- 新增 core 的 `setCurrentClient`、`createTransport`、`parameterize` 和 `dedupeIntegration` 导出。现有 `wrap(fn)` 仍返回包装回调，属于 beta 兼容扩展；固定版 browser 已不公开导出 `wrap`，不将旧版立即执行行为带入该接口。
- `logger`、`metrics` 继续重导出真实上游 API，但 `enableLogs`、`enableMetrics` 显式默认 `false`，不继承新版 core 的默认开启。显式开关仍保留，不能由此推断当前目标服务支持。

官方依据：[browser SDK](https://github.com/getsentry/sentry-javascript/blob/10.76.2/packages/browser/src/sdk.ts)、[公开导出](https://github.com/getsentry/sentry-javascript/blob/10.76.2/packages/browser/src/exports.ts)、[core feedback](https://github.com/getsentry/sentry-javascript/blob/10.76.2/packages/core/src/feedback.ts)、[core Client](https://github.com/getsentry/sentry-javascript/blob/10.76.2/packages/core/src/client.ts)。

## Replay 控制与平台 bridge

integration 的名称改为官方 `Replay`。`getReplay()` 每次从当前 client 查找它，未注册时返回 `undefined`，没有独立全局缓存。曾通过旧 integration 名称获取实例的代码应改用 `getReplay()`。

```ts
import * as Sentry from '@xumoses/sentry-taro';

const replay = Sentry.replayIntegration({
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
});
Sentry.init({
  dsn: 'https://PUBLIC_KEY@YOUR_SENTRY_HOST/PROJECT_ID',
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
  integrations: [replay],
});
// Taro 页面仍需通过生命周期适配接入 replay.bridge。
await Sentry.getReplay()?.flush();
await Sentry.flush(2000);
```

| 直接控制方法                                       | 行为                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `start(): void`                                    | 手动开始 session，不受自动采样率为 0 的限制；已开始时不另建身份                                                  |
| `startBuffering(): void`                           | 手动开始本地 buffer，已开始时不切换当前模式                                                                      |
| `flush({ continueRecording? }): Promise<void>`     | session 排出当前分段；buffer 默认发送并继续 session，传 `false` 则发送后停止录制；未启动时按上游行为启动 session |
| `stop({ flush? }): Promise<void>`                  | 默认发送 session 剩余数据；buffer 默认丢弃，可显式 `flush: true` 发送；停止后不会因页面 show 自动重启            |
| `getReplayId(onlyIfSampled?): string \| undefined` | 当前活动 Replay 身份，包含 buffer；停止或禁用后无 ID                                                             |
| `getRecordingMode()`                               | 当前为 `session`、`buffer`，或未启动的 `undefined`                                                               |

未达到 `minReplayDuration` 时，`flush()` 保留有界数据并安排延后发送，Promise 会立即完成；随后立即调用 `Sentry.flush()` 也不能提前越过此门槛。页面 hide 保留已排队的数据，按整段 Replay 的时间年龄到龄发送，不重新启动隐藏页 recorder；显式 stop 则销毁未达时长的数据。

`flush({ continueRecording: false })` 发送后仍保留 enabled buffer 身份，与官方一致；未过期时活动和页面 attach 不恢复 recorder，过期后新的活动或 attach 会重新按配置采样。若需立即开启新一轮录制，应先 `await replay.stop()` 再 `replay.start()` 或 `replay.startBuffering()`；需要彻底阻止自动恢复则使用 `stop()`。手动启动的 session 过期后也重新使用配置的采样率；双采样率为 0 时需要再次手动启动。

`bridge` 仍负责可见根、滚动、视口、Canvas 等小程序适配，并保留既有控制扩展。其 `flush()` **只发送 session 分段**，旧 `sendBufferedReplay()` 显式发送 buffer。需要官方控制语义时使用 integration 的直接方法。`Sentry.flush()` 只等待 SDK transport，不主动切分 recorder，也不能单独排出仍在压缩/排队的 Replay 数据。

页面所有权独立于采样结果：采样为 0 或手动停止时，适配层仍追踪当前可见根，支持随后手动开始；隐藏、卸载时释放根。旧页面的延迟 hide 不得拆除新页面的 recorder。隐藏期间没有可见 DOM，不能因调用控制 API 就声称已开始有效采集。

官方依据：[Replay integration](https://github.com/getsentry/sentry-javascript/blob/10.76.2/packages/replay-internal/src/integration.ts)、[getReplay](https://github.com/getsentry/sentry-javascript/blob/10.76.2/packages/replay-internal/src/util/getReplay.ts)、[Replay 会话实现](https://github.com/getsentry/sentry-javascript/blob/10.76.2/packages/replay-internal/src/replay.ts)。

## 默认会话与资源保护

| 行为                       | 新默认值及边界                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 最短上传时长               | 默认 4,999 毫秒，`minReplayDuration` 可设为 0–50,000 毫秒；活动中的短录制延后发送，显式 stop 会丢弃尚未达到最小时长的数据 |
| 出错前窗口                 | 60 秒，字节/事件预算可缩短实际保留时间                                                                                    |
| 单个已发送 Replay 最长时长 | 60 分钟，`maxReplayDuration` 可缩短，优先于兼容 `limits.maxDurationMs`                                                    |
| full-session 无用户活动    | 5 分钟暂停 recorder 并保留身份；15 分钟过期，之后活动重新采样并使用新身份                                                 |
| 尚未发送的 error buffer    | 保持有界滚动窗口，不因无活动或已有身份年龄而过期；是否上传在错误发生时采样                                                |
| error buffer 发送后        | 保留原本 buffer 的采样身份，不套用 full-session 的 5 分钟暂停；按已发送 Replay 的时长/过期策略处理                        |
| 活动来源                   | 可见 Taro 根的交互事件与显式页面滚动，只观察活动发生，不读取输入值；DOM 更新和网络流量不伪装成用户活动                    |
| 隐私                       | 文本、输入默认遮罩，媒体默认阻止；顶层官方隐私开关优先于兼容 `privacy.*`                                                  |

录制器与会话身份分开：切换页面、排出分段或空闲暂停并不自动创建新 Replay。低层 `startTaroDomReplayPoc` / React 单次录制接口保留兼容名称，默认最长时长也调整为 60 分钟，但不拥有协调器的完整会话策略。

原有保护继续保留：默认每个录制缓冲最多 500 个事件、512 KiB、10,000 次 mutation；投递队列最多 4 段、2 MiB、最多重试 2 次。录制窗口、内存预算、下载体积是不同维度。这些值是既有保守保护，尚未通过本轮设备测量证明为最优预算；不可将 60 秒表述为任何负载下都能保留的保证。

`sessionIdlePauseMs`、`sessionIdleExpireMs`、`limits`、`delivery` 和 `compression` 是明确的平台扩展。未实现浏览器 selector 配置或完整浏览器 recorder options，不在类型上假装支持；Taro DOM 不提供原生组件内部、浏览器计算样式与最终视图层时序。Canvas 仍受独立显式标记和像素隐私规则约束。

## 能力与验收状态

| 能力                                         | 本地实现状态                                                  | 目标服务状态                                                        |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| 错误、scope、breadcrumb、transport、默认集成 | 复用 core，平台采集有合成契约测试                             | 新候选受控错误接收与 Replay 双向关联通过；范围见第二阶段记录        |
| Tracing、Feedback 与 Replay 关联             | core/平台管线及内存 envelope 验证                             | 新候选待验收；反馈 API 不等于浏览器反馈 UI                          |
| Replay 录制、隐私、buffer/session、投递      | Taro DOM recorder 与协调器测试                                | 新候选已通过开发者工具真实发送、错误提升、选择性遮罩及实际 Playback |
| Logs、Metrics                                | 保留上游导出，默认关闭                                        | 当前目标服务未支持                                                  |
| 浏览器 DOM/BOM、浏览器反馈 UI                | 不提供完整浏览器仿真；兼容 `showReportDialog` 不产生浏览器 UI | 不列为支持能力                                                      |
| Worker、页面生命周期、原生/Taro 混合接入     | 平台扩展，独立产物与合成消费验证                              | 新候选宿主构建及开发者工具 Worker 压缩通过；真机待验收              |

第一阶段已验收能力的证据仍有效于它的原 tarball。本轮真实服务结论仅适用于第二阶段记录标识的候选及合成场景，不扩展为所有功能、设备或服务版本的兼容承诺。

## 打包与尺寸

优先消费 ESM，保留自包含 CJS；UMD 已移除。ESM 将 `fflate/browser` 保留为精确声明的运行时依赖边界，使消费者能够使用 fflate 的官方副作用声明裁剪压缩器；CJS 与独立 Worker 将它内置。core 仍内置于根运行时，避免 recorder/client 分裂。安装锁文件需随新增 runtime dependency 更新。

`vp run verify:bundles` 使用相同 Vite Plus 生产构建比较 errors-only、errors + Replay、errors + Replay + Worker，检查实际输出的源映射片段并记录原始字节。结果保存在忽略的 `.artifacts/consumer-bundles/report.json`，不使用整个 sourcemap 的 `sourcesContent` 列表冒充实际模块贡献。该合成验证证明模块裁剪边界，不代表宿主小程序主包/分包或上传包一定满足平台限制；生产宿主仍需测量。
