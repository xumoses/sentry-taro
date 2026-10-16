# 结构重构实施记录

更新时间：2026-10-16。对应[结构重构计划](../plans/structural-refactor.md)第一阶段。本文只记录本地实施和自动化验证；电脑微信验收、beta 发布和首个验证项目迁移尚未进行，不能据此标记阶段通过。

## 第一阶段：结构收敛

| 计划项                                                            | 状态             | 提交      |
| ----------------------------------------------------------------- | ---------------- | --------- |
| `rebase.ts` 分叉：补回归测试，只保留一份                          | 完成             | `6010bd0` |
| 合并 `network-details`、UTF-8 工具和 Replay 缓冲裁剪逻辑          | 完成             | `7d406e0` |
| 合并为单一源码树 `src/{sdk,replay,taro-plugin}`，测试移到 `test/` | 完成             | `8a0160f` |
| 移除 Replay 对 SDK 对象的外部注入                                 | 完成，见下文说明 | `60041f8` |
| 录制器移到 Replay 层，POC 名称改为正式名称并保留弃用别名          | 完成             | `fc7659e` |
| 拆分录制器模块级辅助代码                                          | 完成             | `5b8ebdc` |
| 拆分录制器主体闭包                                                | 完成             | `2703f08` |
| 从 `ReplayCoordinator` 抽出协作者                                 | 完成，见下文说明 | `a3baeb4` |

### 说明

- **rebase 分叉**：Replay 缓冲那份会把滚动位置写到嵌套文档节点上，录制器那份跳过所有文档节点。保留录制器的语义，并用回归测试覆盖。Taro DOM 没有嵌套文档，实际行为不受影响。
- **SDK 注入**：协调器默认使用本包的 core client、面包屑、SDK 标识和录制器，`replayIntegration()` 不再组装注入对象。`sdk` 选项仍可选：测试用它替换依赖，轻量的 `./react` 入口也靠它避免打包 core。删除该公共选项属于第三阶段。
- **POC 名称**：`SentryMiniappReplaySdk` 的方法名仍是 `startTaroDomReplayPoc`，因为它是注入接口的一部分；随第三阶段删除 `sdk` 选项一并处理。录制数据中的 marker 值保持 `TARO_DOM_REPLAY_POC`。
- **录制器主体**：原来约 1400 行的闭包里有约 25 个共享状态，其中 10 个会被重新赋值。现在全部收进显式的 `RecorderContext`（`recorder/context.ts`），闭包拆成接收它的普通函数模块：`events`（事件缓冲与分段）、`canvas` / `canvas-frames`、`serializer`、`widgets`（swiper、scroll-view、picker 监听）、`breadcrumbs`、`interactions`、`mutations` 和 `privacy-rules`。`recorder.ts` 只负责组装 context、启停、页面滚动和视口变化，从 1663 行降到 297 行。模块之间没有循环依赖。
- **代价**：闭包变量变成对象属性后，压缩器无法缩短属性名。合成的 Replay 产物从 237,029 B 增至 240,970 B（约 +3.9 KB，gzip 后约 +1 KB）；只用错误监控的产物不变。
- **协调器**：`ReplayCoordinator` 已经把投递、首段发送门控和会话策略委托给独立对象，剩下的是一个状态机。这次抽出了三块内聚的部分：`ReplayEventLinks`（待关联的错误、trace 和事务名）、`ReplayBufferHistory`（错误缓冲中早先页面的录制）、采样和页面根节点工具函数。原来分散在五处的清空逻辑各收敛为一次调用。状态机本身没有继续拆：它的各个方法共同读写十几个私有状态，再拆只会把这些状态暴露给更多对象。文件从 1052 行降到 950 行。

## 自动化验证

最后一次提交 `a3baeb4` 上本地执行：

- `vp check`、`vp run typecheck`：通过。
- `vp test run`：89 个文件、1213 项通过（比基线多 1 项 rebase 回归测试）。
- `vp run test:release`：68 项通过。
- `vp pm pack`（含 `verify:package`）：12 个 ES2015 产物、617 个 sourcemap 源文件、导出、声明和 Worker 校验通过。
- `vp run verify:bundles`：仅错误监控 156,434 B（与基线相同）；加 Replay 241,320 B（基线 237,048 B，增量来自录制器拆分，见上文）；加 Worker 241,385 + 8,709 B。
- `vp run verify:consumer --online`：隔离安装、严格声明、CJS/ESM 与 5 个子路径通过。

## 尚未进行

- 电脑微信验收：真实错误接收、Replay 关联和 Playback。
- 发布 beta，并让首个验证项目改用新名称（`startTaroReplayRecorder`、`TARO_REPLAY_CAPTURE_MARKER`）。
