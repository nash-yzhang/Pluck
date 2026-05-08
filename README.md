# <img src="icons/pluck.png" alt="Pluck" width="40" valign="middle" /> Pluck — Privacy-first, source-grounded webpage assistant.

[English](#english) | [中文](#中文)

---

## English

> An interest-driven side project to build a lightweight AI assistant you can summon on any web page, without leaving the tab or copy-pasting text into another app.

Select text or an element on any page -> ask an AI question -> get answers in a sidebar.
No copy-paste. No new tabs. No proxy server. **Your API key, your data.**

### What it does

Pluck adds a lightweight AI chat sidebar to Chrome.
Use **Alt+K** to open it, select content on the page, ask your question, and stream answers without leaving the current tab.

All API calls go **directly from your browser** to your selected LLM provider.

### Quick Start

1. Get an API key:
   - OpenAI: https://platform.openai.com/api-keys
   - DeepSeek: https://platform.deepseek.com/api_keys
   - Anthropic: https://console.anthropic.com/settings/keys
2. Install extension:
   - Chrome Web Store: install directly
   - From source: open `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** -> select project folder
3. Configure:
   - Click Pluck toolbar icon -> **OPEN SETTINGS**
   - Choose provider, paste API key, choose default model -> **SAVE SETTINGS**

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+1` | Enter visual selection mode (also toggle sidebar) |
| `Alt+2` | Copy selected text |
| `Alt+K` | Toggle sidebar |

### Presets (`/name`)

`/sum`, `/extract`, `/explain`, `/translate`, `/rephrase`, `/grammar`, `/keywords`, `/find`, `/define`, `/outline`

You can add custom presets in Settings.

### Providers and models

- OpenAI: `gpt-4o-mini` (default), `gpt-5-nano`, `gpt-5-mini`, `gpt-4o`
- DeepSeek: `deepseek-v4-flash` (default), `deepseek-v4-pro`, `deepseek-chat`
- Anthropic: `claude-3-5-haiku-latest`, `claude-3-5-sonnet-latest`

### Privacy

- Direct provider API calls only (no Pluck proxy server)
- API keys stored locally in Chrome sync storage
- Page content sent only when you explicitly submit
- No analytics / telemetry

See: [PRIVACY.md](PRIVACY.md)

---

## 中文

> 这是一个兴趣驱动的轻量项目：在任何网页上直接唤起 AI 助手，无需离开当前标签页，也无需复制粘贴到其他应用。

在网页中选择文本或元素 -> 提问 -> 在侧边栏即时获得回答。
无需复制粘贴，无需新开标签页，无需中转服务器。**你的 API Key，你的数据。**

### 功能简介

Pluck 为 Chrome 提供轻量 AI 侧边栏。
按 **Alt+K** 打开侧边栏，选中网页内容后即可提问，回答会在当前页流式返回。

所有 API 请求都由浏览器 **直接发送到你选择的模型服务商**。

### 快速开始

1. 获取 API Key：
   - OpenAI: https://platform.openai.com/api-keys
   - DeepSeek: https://platform.deepseek.com/api_keys
   - Anthropic: https://console.anthropic.com/settings/keys
2. 安装扩展：
   - Chrome 应用商店：直接安装
   - 源码安装：打开 `chrome://extensions` -> 开启 **Developer mode** -> **Load unpacked** -> 选择项目目录
3. 配置：
   - 点击 Pluck 工具栏图标 -> **OPEN SETTINGS**
   - 选择服务商、粘贴 API Key、设置默认模型 -> **SAVE SETTINGS**

### 快捷键

| 快捷键 | 操作 |
|---|---|
| `Alt+1` | 进入可视化选择模式（也可切换侧边栏） |
| `Alt+2` | 复制选中文本 |
| `Alt+K` | 打开/关闭侧边栏 |

### 预设命令（`/name`）

`/sum`、`/extract`、`/explain`、`/translate`、`/rephrase`、`/grammar`、`/keywords`、`/find`、`/define`、`/outline`

你也可以在设置页自定义预设。

### 支持的服务商与模型

- OpenAI: `gpt-4o-mini`（默认）、`gpt-5-nano`、`gpt-5-mini`、`gpt-4o`
- DeepSeek: `deepseek-v4-flash`（默认）、`deepseek-v4-pro`、`deepseek-chat`
- Anthropic: `claude-3-5-haiku-latest`、`claude-3-5-sonnet-latest`

### 隐私

- 仅直连服务商 API（无 Pluck 中转服务器）
- API Key 保存在 Chrome 本地同步存储
- 仅在你主动提交时发送页面内容
- 无埋点、无遥测

详见：[PRIVACY.md](PRIVACY.md)
