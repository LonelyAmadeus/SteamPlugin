# Steam 翻译助手

在 Windows 版 Steam 里读外语评测、看创意工坊说明，或用另一种语言回复好友，无须切换窗口。插件基于 [Millennium](https://github.com/SteamClientHomebrew/Millennium)，沿用旧版的右键菜单、输入框翻译和本地译文缓存。

**[下载 1.1.0 安装包](https://github.com/LonelyAmadeus/SteamPlugin/releases/download/v1.1.0/steamtranslator.star)** · [仓库内的安装包](./Steam-翻译助手-github/Steam-翻译助手.star?raw=true) · [更新记录](./CHANGELOG.md) · [插件源码](./Steam-翻译助手-github/) · [旧版 v1.0.0](https://github.com/LonelyAmadeus/SteamPlugin/releases/tag/v1.0.0)

## 安装或从 1.0 升级

1. 确认 Windows 版 Steam 已安装 Millennium，然后**完全退出 Steam**。
2. 升级前，将现有 `steamtranslator.star` 和 `millennium\config\` 里的 `ds-tr-config.json`、`ds-tr-cache.json`（如有）备份到插件目录之外。1.1 会读取旧配置并迁移旧缓存；备份用于回退。
3. 将下载的 `steamtranslator.star` 放入 `<Steam 安装目录>\millennium\plugins\`。若从仓库内下载，请先将 `Steam-翻译助手.star` 重命名为 `steamtranslator.star`。新旧包的插件 ID 都是 `steamtranslator`，此目录只保留一份。
4. 启动 Steam，在 **设置 → Millennium → 插件** 中启用 **Steam 翻译助手**。若要回退，退出 Steam，换回备份的旧包、配置和缓存。

## 第一次翻译

打开一篇英文创意工坊说明，在正文上右键选择 **API 设置…**。填入自己的 API Key 并保存；旧版用户可沿用已保存的 Key。再次右键，选择 **翻译此页**。

默认模型为 `deepseek-chat`，接口为 `https://api.deepseek.com/chat/completions`。使用其他兼容 OpenAI Chat Completions 的服务时，请填写**完整的接口地址**和模型名。远程接口使用 HTTPS，本机回环地址也可使用 HTTP。插件不附带 Key，翻译费用取决于所选服务。

| 场景 | 操作 |
| --- | --- |
| 读商店、社区、工坊或库详情 | 在支持的页面正文右键 **翻译此页**。可还原原文、恢复译文或重新翻译；工坊保留了悬停简介预热。 |
| 对照原文或只看一句 | 在 **API 设置… → 页面译文显示** 选择 **双语对照**；也可选中文字，右键 **翻译选中文本**，在独立窗口读、复制译文。 |
| 用外语回复好友 | 在支持的聊天输入框写草稿，选择目标语言，点 **译**。它不会自动发送消息。输入框默认译为英语，与页面默认的简体中文相互独立。 |
| 固定游戏与物品译名 | 在 **术语表** 中每行填一条 `源词=译词`，例如 `Workshop=创意工坊`。 |
| 只让特定页面自动翻译 | 设置全局默认、商店或工坊等页面规则，或用 Steam App ID 为可识别的游戏单独设置。自动翻译默认关闭。 |
| 复用译文或备份缓存 | 设置中可查看、导出、导入或清除当前翻译配置的缓存。接口、模型、页面目标语言或术语表不同，缓存分开保存。 |

按住 `Shift` 再右键可打开原生菜单。游戏库首页和好友列表不属于整页翻译范围；网页登录、注册、结账路径不接管。本版只翻译文本，不提供图片 OCR 或视频字幕。

## 隐私与反馈

- 需要翻译的文本会发往**你配置的 API 服务**，包括主动翻译的聊天内容。开启自动翻译后，符合规则的页面也会发送待翻译文本。
- 设置面板中已保存的 API Key 默认遮蔽，点眼睛才显示完整内容。**遮蔽不等于加密**：本机 `ds-tr-config.json` 仍以明文保存 Key。
- 缓存及导出文件可能含有原文和译文。反馈问题时，请附 Steam、Millennium 版本、页面类型及复现步骤，不要附带配置文件、原始缓存或带有明文 Key 的截图。

## 从源码构建

安装 [Bun](https://bun.com/) 后，在仓库根目录运行：

```powershell
cd 'Steam-翻译助手-github'
bun install --frozen-lockfile
bun run typecheck
bun run build
```

产物为该子目录下的 `Steam-翻译助手.star`。源码采用 [MIT 许可证](./Steam-翻译助手-github/LICENSE)。
