# 以 ESM 为首选，保留 CJS 和独立 Worker

第二阶段采用 ESM 作为构建器消费首选，保留自包含 CJS 兼容入口和小程序独立 Worker，并移除 UMD 产物。既有原生宿主与 Taro 混合接入仍需要 CJS；仓库接入示例、README 和隔离消费者未使用 UMD，维护该额外格式的收益不足。

移除 UMD 是发布产物的兼容变化，需要在迁移说明中列出；仓库无引用不能证明外部绝无消费者。双格式发布本身不意味着消费者同时打包两份代码，ESM-only 也不直接保证更小的主包。体积优化以副作用审计、模块边界和实际小程序消费增量为依据，详见[设计原则](../design-principles.md)。

ESM 的 fflate 保持独立运行时依赖，利用该包自己的副作用声明让未启用 Replay 的消费者裁剪初始化代码。CJS 和独立 Worker 内置 fflate；官方 core 仍内置于根运行时，维持单 client 的关联。根包存在必要的 polyfill 初始化，不全局声明 `sideEffects: false`。具体消费验证与限制见[运行时迁移说明](../migrations/phase-two-runtime.md)。

原生小程序入口另以 `package.json` 的 `miniprogram` 字段发布在 `miniprogram_dist/`，内容是自包含 CJS 根入口的副本及其 sourcemap（`index.js` / `index.js.map`）。微信 `packNpmManually` 原样复制该目录；若只靠 `main`，它会包装文件但不复制原 map，留下指向不存在文件的 `sourceMappingURL`。这不是新格式：Taro 与构建器使用的 `exports`、`main`、`module` 不变，ESM 仍保留 fflate 包边界，原生打包通过 `getSentryMiniProgramNpmIgnores()` 跳过已内置的 core 与 fflate。
