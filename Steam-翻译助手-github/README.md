# Steam 翻译助手

Steam 客户端翻译插件（Millennium）。把商店、社区、创意工坊、游戏库详情、聊天页面翻成中文，输入框也能一键翻译。

默认使用 DeepSeek，也可换成任意 OpenAI 兼容接口。

## 下载安装

1. 关闭 Steam；
2. 到 [Releases](../../releases) 下载最新的 `Steam-翻译助手-vX.Y.Z.star`；
3. 放到 `Steam\millennium\plugins\steamtranslator.star`；
4. 启动 Steam，在 `设置 → Millennium → 插件` 确认已启用；
5. 在页面右键 → `API 设置…` 填入你的 API Key。

> 没有预置 API Key。插件本身不收费，翻译费用由你使用的接口承担。

## 功能

- **整页翻译**：商店、社区、创意工坊、库详情、聊天窗口
- **自动翻译**：勾选后进页面自动翻译；勾选状态跨启动保存
- **还原原文 / 还原翻译 / 重新翻译**：随时切换回原文、瞬时恢复译文、或清缓存重翻
- **悬停简介预热**：工坊列表悬停时简介直接是中文，不等 API
- **输入框翻译**：语言下拉 + 一键翻译，整页翻译不会动输入框内容
- **本地缓存**：译文落盘（`ds-tr-cache.json`），重复访问几乎不产生 API 调用；面板里可查看大小并一键清空
- **右键只在支持的页面接管**：库首页、好友列表保留 Steam 原生菜单

## 配置

右键任意支持的页面 → `API 设置…`：

| 字段 | 默认值 |
|---|---|
| API Key | 空（必填） |
| 接口地址 | `https://api.deepseek.com/chat/completions` |
| 模型 | `deepseek-chat` |

保存后立即生效，无需重启。

## 从源码构建

需要 [Bun](https://bun.com/) >= 1.0。

```bash
bun install
bun run build
```

产物是 `Steam-翻译助手.star`，复制到 `Steam\millennium\plugins\steamtranslator.star` 即可。

## 隐私

- 翻译请求会把你当前页面上的可见文本发送到**你配置的 API**；
- API Key 明文保存在 `Steam\millennium\config\ds-tr-config.json`，不要分享该文件；
- 译文缓存 `ds-tr-cache.json` 只含原文与译文，不含 Key；
- 日志 `ds-tr.log` 只记录状态与错误，不记录页面正文，超过 2 MB 自动清空。

## 已知限制

- 页面翻译目标语言固定为简体中文；输入框翻译支持多语言；
- 依赖 Steam 的 DOM 结构，Steam 大版本更新后可能需要适配；
- 未在 Steam 插件商店上架，仅提供手动安装。

## License

MIT
