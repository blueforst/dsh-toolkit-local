# DSH Toolkit Local

直接安装到已有 DSH 的轻量增强插件：**OpenCode Go 月额度**与 **Pi 会话费用**。

本机浏览器和 Computer Use 完全沿用 DSH 原生能力。本项目不安装或替换浏览器、CUA provider、驱动、Docker、虚拟桌面或后台采集服务，也不修改模型、浏览器、CUA 的用户配置。

| 功能 | 显示位置与行为 |
| --- | --- |
| OpenCode Go 月额度 | 侧边栏；显示官方返回的本月已使用整数百分比，60 秒刷新与共享缓存 |
| Pi 会话费用 | 输入框统计行最前；点击查看输入、输出、缓存读与实际产生的缓存写费用 |

浏览器页面不可见、侧栏折叠时暂停额度轮询。侧栏会分别提示缺少 Go API Key 和暂时无法读取额度。会话费用复用当前 DSH 安装的 Pi 模型目录，不安装第二份 SDK，也不是供应商实际账单。

## 直接安装

插件可安装到 DSH 的 `web` 或官方桌面版的 `desktop` profile。Web CLI 需要 Node.js `24.9` 或更高版本。会话费用界面兼容 DSH `0.2.2-alpha.2` 和 `0.2.2-rc.2` 的定位接口。macOS 桌面版使用应用自带的 CLI。

从本仓库 [Actions](https://github.com/blueforst/dsh-toolkit-local/actions) 的成功检查运行中下载 `dsh-toolkit-local-0.1.1` 构建产物，解压得到 `forst-dsh-toolkit-local-0.1.1.tgz`。在该文件所在目录运行：

```sh
dsh plugin --profile web add --ignore-scripts --save-exact ./forst-dsh-toolkit-local-0.1.1.tgz
```

然后重启此 profile 的 DSH 进程。此命令也可在 PowerShell 使用；文件不在当前目录时改成实际路径。不要同时在同一个 profile 中安装服务器版 `@forst/dsh-toolkit`，两者会注册相同的额度路由和费用投影。

macOS 桌面版先完全退出应用，再安装到 `desktop` profile，安装后重新打开应用：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add --ignore-scripts --save-exact ./forst-dsh-toolkit-local-0.1.1.tgz
```

额度监控通过 DSH 凭据服务读取 `OPENCODE_GO_API_KEY`，可以复用在 DSH「设置 → 模型 → OpenCode Go」保存的密钥。也支持在启动 DSH 的进程环境中提供同名变量。缺少此密钥时仍可使用会话费用功能。

如果该 profile 原来已安装旧服务器版或旧独立模块，先备份 profile 的 `package.json`、锁文件及 Cordis 配置，再用 DSH 原生插件命令移除实际安装的旧包后安装本机版。不要清空 profile 或删除历史会话。

## 升级与卸载

升级时使用同一条 `dsh plugin ... add` 命令安装新版本完整包，并重启 DSH。保留上一个 `.tgz` 可用于回退。

```sh
dsh plugin --profile web remove @forst/dsh-toolkit-local
```

卸载后重启 DSH。浏览器、CUA、模型配置及历史会话不需要更改或删除。

## 两个项目的边界

- 本仓库是额度、费用和对应 UI 的唯一维护源。
- [DSH Toolkit 服务器版](https://github.com/blueforst/dsh-toolkit) 固定复用本仓库的版本快照，另加 Linux 资源监控及现有服务器部署配方。
- 服务器版成品已包含这部分代码，服务器用户不需要再装本机包；两个产品各自安装一个包即可。
- Magic Context 仍是独立项目，不随本包安装。

## 开发与检查

运行时没有额外 npm 依赖。源码已经提交构建好的客户端文件，普通安装不需要在用户电脑执行构建。

```sh
npm run build
npm run check
npm test
npm pack
```

单元测试与真实 SDK 验证分开执行。真实验证需要指定已安装 DSH 的 CLI 入口：

```sh
DSH_ENTRYPOINT=/absolute/path/to/@deepseek-ai/dsh/lib/bin.js node --test tests/*.integration.mjs
```

该环境变量只供测试使用，正常运行自动定位 DSH 使用的 Pi。跨系统的 Node 单元测试不等同于对应系统已完成真实 DSH 安装验收；实际完成情况记录在 [验收记录](docs/验收记录.md)。

费用口径见 [费用说明](docs/费用说明.md)，代码来源见 [NOTICE](NOTICE.md)。MIT License。
