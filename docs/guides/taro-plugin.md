# Taro 构建插件

`@xumoses/sentry-taro/taro-plugin` 在 Node.js 构建阶段为微信小程序生成
Replay 样式和静态图片资源，并负责构建身份、Webpack sourcemap 修复和可选 Worker
准备。它与运行时 SDK 同版本发布，解析器只进入独立构建入口。微信最终
sourcemap 通过同入口的 `uploadSourceMaps` 在发布流程中上传。

## 纯 Taro 应用

当前支持微信小程序、Taro 4.2 与 Webpack 5；其他 compiler 会明确报错。

在现有 Taro 配置中添加插件：

```ts
export default {
  plugins: [
    [
      '@xumoses/sentry-taro/taro-plugin',
      {
        release: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
      },
    ],
  ],
};
```

插件使用 `ctx.paths.sourcePath` 和 `ctx.paths.outputPath`，在每次
`onBuildFinish`（包括 watch 重建）生成 `replay-assets.json`。文件包含压缩
资源数据，不包含可执行代码。它在构建结束后才存在，不要从应用源码静态 import。

在已有 Replay 初始化后、页面创建前配置资源读取：

```ts
import { createReplayAssetProviders } from '@xumoses/sentry-taro';
import { installTaroReplayPageLifecycle } from '@xumoses/sentry-taro/taro/lifecycle';
import { replay } from './sentry';

const assets = createReplayAssetProviders({
  readAssetFile: () =>
    wx.getFileSystemManager().readFileSync('replay-assets.json', 'utf8') as string,
  readPackagedImage: (path) => wx.getFileSystemManager().readFileSync(path, 'base64') as string,
});

installTaroReplayPageLifecycle({ bridge: replay.bridge, ...assets });
```

读取器惰性解码并缓存成功结果；图片按页面读取。暂不可用的文件可以在之后的
调用中重试，失败不会中断业务页面。插件不会自动开启 Replay 或改变隐私设置。

## 原生与 Taro 混合应用

如果现有构建流程先把 Taro 输出复制到原生应用子目录，在复制完成后调用同一
入口的 `generateReplayAssets`。不要依赖两个独立 `onBuildFinish` 回调的先后顺序。

```ts
import { generateReplayAssets } from '@xumoses/sentry-taro/taro-plugin';

// 在现有输出复制步骤完成后执行；示例路径相对于当前构建进程目录。
generateReplayAssets({
  replay: {
    sourceRoot: './src',
    outputRoot: '../native/mini',
    appRoot: '../native',
    output: 'modules',
    imagePriority: ['assets/brand/logo.png'],
  },
});
```

`appRoot` 必须包含 `outputRoot`，用于解析原生共享 `app.wxss` 和包内图片路径。
默认路由前缀是两者的相对路径；可用 `routePrefix` 覆盖录制路由前缀，物理图片
读取路径仍由真实包目录决定。图片优先级只调整预算内选取顺序，不扩大允许范围。

`output: 'modules'` 生成 `replay-styles.js` 和 `replay-images.js`，保留原生宿主
直接 require 的形式：

```js
const { decodeReplayAssetData } = require('@xumoses/sentry-taro');
const getReplayStyles = require('./mini/replay-styles.js')(decodeReplayAssetData);
const getReplayImageSources = require('./mini/replay-images.js')(decodeReplayAssetData, (path) =>
  wx.getFileSystemManager().readFileSync(path, 'base64'),
);
```

继续把这两个回调接入现有生命周期适配。混合应用也可以使用默认 JSON 输出，
将 `readAssetFile` 改为读取 `mini/replay-assets.json`。

## 构建身份与 sourcemap

插件通过 Taro 4 / Webpack 5 hooks 开启含列信息的 `source-map`，在 Taro 插入
`require()` 前缀、移动 strict 指令之后修复映射。修复只更新 `.map`，不改业务 JS。
遇到未知改写默认中止；`errorHandler` 允许继续时会删除该错误映射。
已有 `devtoolModuleFilenameTemplate` 保留，否则使用项目相对的 `webpack:///` 路径。

`release.name` 优先使用显式配置，其次 `SENTRY_RELEASE`，然后探测 CI/Git revision；
`release.dist` 优先显式配置，其次 `SENTRY_DIST`。插件不自行拼接业务版本或时间编号。
身份在当前编译器实例创建时确定，watch 重建沿用，并写入输出目录 `sentry-build.json`。
默认 `release.inject: true` 通过 Webpack 编译常量给本 SDK 提供 release/dist 默认值；
应用 `Sentry.init()` 的显式值仍优先，因此须与发布上传的身份保持一致。
不经 Webpack 的原生模块可以读取下面的 CJS metadata 并显式传给 `init`。

混合宿主可在自己的构建入口生成一次身份，复制输出后写入原生包：

```js
const {
  createSentryBuildMetadata,
  writeSentryBuildMetadata,
} = require('@xumoses/sentry-taro/taro-plugin');

const metadata = createSentryBuildMetadata({
  projectDir: process.cwd(),
  release: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
});
writeSentryBuildMetadata({ metadata, outputRoot: './native/mini', format: 'module' });
// 生成 sentry-build.js（原生 require）及 sentry-build.json（上传只读）。
```

原生初始化：

```js
const { release, dist } = require('./mini/sentry-build.js');
Sentry.init({ release, dist /* 其余配置 */ });
```

业务项目名称、版本格式和 CI job 编号由宿主设置 `release.name/dist`。上传前只读取
构建产物，不能再调用 create/write 重新生成身份。

## 上传微信最终 sourcemap

本地 Taro 输出还会经过微信编译，不能直接替代最终 sourcemap。宿主保留微信上传和
`getDevSourceMap` 下载步骤，然后调用以下函数。上传使用官方 `@sentry/cli`；它是
可选 peer，只有需要上传的开发/CI 环境才需安装（已验证 3.6.2）：

```sh
npm install --save-dev @sentry/cli@^3.6.2
```

```js
const { readSentryBuildMetadata, uploadSourceMaps } = require('@xumoses/sentry-taro/taro-plugin');

// 在微信上传后，读取被上传的那份包的 metadata。
const metadata = readSentryBuildMetadata({
  outputRoot: './native/mini',
  expected: { name: process.env.SENTRY_RELEASE, dist: process.env.SENTRY_DIST },
});
if (!metadata.release) throw new Error('A release is required for the final sourcemap upload');

await uploadSourceMaps({
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: { name: metadata.release, dist: metadata.dist },
  wechat: { sourceMapPath: downloadedSourceMapZipPath },
});
```

`wechat.sourceMapPath` 接受微信下载 ZIP 或保留其原始结构的目录。函数在临时目录中
安全解包/复制、展平 `__APP__`、排除 `__FULL__` 并保留子包。缺失真实 JS 的
`app-service.js.map` 会配一个仅含 sourceMappingURL 的文件；已有真实 JS 保持原样。
缺少主包、有效映射或完整 JS/map 配对会失败，不回退上传本地项目目录。
上传固定使用 `rewrite: false`、`validate: true`、`dedupe: true`；默认 URL 前缀
`https://usr` 与 SDK 微信栈帧规范化相匹配。完成或失败后清理临时目录，不修改输入。

## Worker 与原生 npm 打包

独立 Worker 按需拷贝，不自动启用压缩或修改微信 `app.json`：

```js
const {
  writeReplayWorker,
  getSentryMiniProgramNpmIgnores,
} = require('@xumoses/sentry-taro/taro-plugin');

// 在清理/打包原生 npm 输出之后执行，从宿主安装的 SDK 解析 Worker。
writeReplayWorker({ projectDir: process.cwd() }); // workers/sentry-replay.js
const ignores = getSentryMiniProgramNpmIgnores();
// 合并到现有 packNpmManually 配置的 ignores。
```

纯 Taro 插件可设置 `replay.worker: {}`，默认写到 Taro 输出的 `workers` 目录；
支持 `outputRoot` 和单个 `filename`。源文件须非空，复制保持字节一致，失败清除旧目标。
宿主仍须在 `app.json` 声明 Worker 目录并设置运行时 `workerPath`。

npm ignores 辅助函数仅用于原生入口已经内置 Sentry core 的打包方式，避免重复打包
`@sentry/core` / `@sentry/conventions`。如果应用或其他依赖直接使用这些包，应自行
评估排除范围。清空整个 npm 输出、`miniprogram-ci` 打包和微信凭据仍由宿主负责。

## 配置与官方对齐

以下字段沿用 [官方 Sentry webpack 插件](https://www.npmjs.com/package/@sentry/webpack-plugin)
的命名和控制语义；这是明确的功能子集：

| 入口                 | 配置                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| 插件、资源生成与上传 | `disable`（默认 false）、`silent`（false）、`debug`（false）、`errorHandler`  |
| Taro 插件            | `release.name/dist/inject`（inject 默认 true）、`sourcemaps.disable`（false） |
| 上传函数             | `org`、`project`（字符串或数组）、`authToken`、`url`、`headers`               |
| 上传函数             | `release.name/dist/create/finalize`（create/finalize 默认 true）              |
| 上传函数             | `sourcemaps.disable/assets/ignore`                                            |

默认错误会中断构建或 reject 上传；`errorHandler` 正常返回则允许调用方继续，抛错仍失败。
`silent` 抑制插件日志，优先于 `debug`，不吞异常。`disable` 完全跳过该入口；
`replay: false` 仅关闭 Replay 资源/Worker/MutationObserver 准备，身份和 sourcemap 仍工作。
上传函数 `sourcemaps.disable` 跳过整个上传阶段（包括 release 创建和 finalize）。
插件构建阶段没有 Sentry 网络请求或上传凭据读取。

上传的 `assets/ignore` 为相对规范化微信产物根目录的 glob，不能直接传目录扫描替代
`wechat.sourceMapPath`。默认选取 JS/maps；显式选取一端时另一端会配对加入，ignore
排除配对文件会失败。`wechat.urlPrefix` 是微信扩展。构建阶段不接受上传字段。
`rewriteSources`、`resolveSourceMap`、`filesToDeleteAfterUpload`、`setCommits`、`deploy`、
`telemetry`、Debug ID 上传尚未实现，未知字段会报错，不是静默兼容。

`replay` 资源选项包含 `sourceRoot`、`outputRoot`、`appRoot`、`routePrefix`、
`output`（默认 json）、`compactAssets`（默认 true）、`imagePriority`（默认空数组）。
相对路径在插件下相对于 Taro 项目目录，在 `generateReplayAssets` 下相对于
`process.cwd()`。插件启用 Replay 时同时开启 Taro `enableMutationObserver`，
不自动启动 Replay 或调整隐私设置。

## 资源发现与限制

- 扫描整个 `sourceRoot` 的 SVG，包括页面和组件目录；不跟随目录或文件符号链接。
- 根据编译后 app、页面及其 JavaScript 依赖筛选资源；SVG 内容必须与源码完全一致。
  不会把源目录中的所有图片都放进每个页面。
- 保留内联 raster 图片、构建产物里的本地 raster 文件及经校验的 SVG。动态 URL、
  网络图片和未通过校验的 SVG 不会被自动采集。
- 每图 data URI 上限 128 KiB；每路由图片预算最多 64 KiB，且受样式与快照空间约束。
  预算不足或 SVG 无源码匹配会输出诊断，不输出完整图片内容。
- WXSS 的小程序标签选择器转换为 Replay 选择器，展开本地 imports，保留条件、
  层叠顺序和动态规则。不会计算微信原生控件的最终像素布局。
- 静态资源清单为图片提供显式录制许可；只把应用静态资源放入源码目录，
  不要混入用户图片或运行时敏感数据。

这次迁移保留基于编译产物静态引用的发现方式。运行时拼接路径、未体现在构建
依赖图中的自定义原生组件图片，以及 CSS 背景图片的自动重写不属于新增支持。
插件也不提供 CDN 或历史资源托管。
