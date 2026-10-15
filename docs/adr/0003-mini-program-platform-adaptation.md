# 以官方 core 和小程序适配承载可选 Taro DOM Replay

本项目采用“官方 Sentry core + 小程序平台适配 + 可选 Taro DOM Replay”。平台无关的 SDK 语义优先复用官方实现，错误采集、网络、生命周期、存储和 Worker 由小程序适配层负责；Taro runtime DOM 是逻辑 UI 的录制数据源，而不是完整浏览器环境。

完整浏览器仿真会扩大维护范围，仍不能补齐微信视图层及原生组件的全部状态，因此不作为第二阶段路线。代价是本项目需要维护 recorder 和协议契约，并分别验证录制、投递、错误关联和实际 Playback；逻辑树可观察不构成像素还原承诺。默认策略和功能支持边界见[设计原则](../design-principles.md)。
