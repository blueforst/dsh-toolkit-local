# 来源与授权

本项目从 [blueforst/dsh-toolkit](https://github.com/blueforst/dsh-toolkit) 的提交 `f4b3d12e3c67e4366cfb1b4ac5dfa5431e0b2426` 拆分，沿用 MIT 授权及原版权声明。

- Go 月额度：从 `server-metrics@0.1.6` 拆出额度请求、缓存、鉴权和 UI，不包含 Linux 资源采集。
- 会话费用：迁移 `session-billing@0.1.4` 的投影、运行时加载和客户端，计费口径不变。
- DeepSeek Harness：使用安装版本的 Cordis、原生插件管理、Web UI、请求认证、会话投影和 Pi 适配器。未复制 DSH 核心源码。
- Pi：模型目录与 `calculateCost()` 由 DSH 已安装的 `@earendil-works/pi-ai` 提供，不随本包复制价格表或安装第二份 SDK。

本仓库不提供浏览器、Computer Use、Docker 或系统桌面运行时。OpenCode Go 适配代码不包含账号、密钥或服务额度。
