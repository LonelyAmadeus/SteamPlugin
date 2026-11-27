# Steam 翻译助手 · 插件源码

[安装、升级与使用说明](../README.md) · [更新记录](../CHANGELOG.md) · [下载本目录的插件包](./Steam-翻译助手.star?raw=true)

这里是 `steamtranslator` 的源码目录。Windows 上安装 [Bun](https://bun.com/) 后，在本目录运行：

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run build
```

推荐使用 Bun 1.3.14，与仓库的发布流程一致。构建产物为 `Steam-翻译助手.star`；运行 `bun run inspect` 可查看包内容。构建不会安装插件或修改 Steam 配置。

| 入口 | 职责 |
| --- | --- |
| [millennium.toml](./millennium.toml) | 插件 ID、版本、入口与打包配置 |
| [frontend/library.tsx](./frontend/library.tsx) | Steam 客户端内的游戏库、聊天界面 |
| [webview/preload.ts](./webview/preload.ts) | Steam 商店、社区及创意工坊网页 |
| [shared/](./shared/) | 右键菜单、设置、选区翻译、自动翻译规则和缓存调用 |
| [backend/rpc_functions.lua](./backend/rpc_functions.lua) | 配置读写、模型请求、术语和译文持久化 |

本目录不需要 API Key 即可构建。不要把本机的 `ds-tr-config.json`、缓存或日志放进仓库。源码采用 [MIT 许可证](./LICENSE)。
