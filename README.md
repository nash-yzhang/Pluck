# Pluck — AI Sidebar for Any Web Page

> A interest driven spontaneous project to build a lightweight AI assistant that can be summoned on any web page, without leaving the tab or copying and pasting text into a separate app. Designed by me (nash-yzhang @ github) and implemented with Claude's aid.
> Select any text or element on any page → ask an AI question about it → get an answer in a sidebar.  
> No copy-pasting. No new tabs. No intermediate server. **Your API key, your data.**

---

## What it does

Pluck adds a lightweight AI chat sidebar to Chrome. Activate the overlay with **Alt+1**, click or drag-select content on the page, type your question — the answer streams back instantly in the sidebar while you stay on the same tab.

Every API call goes **directly from your browser** to the LLM provider you choose. Nothing passes through an external server or proxy.

---

## Quick start

1. **Get an API key** from one of the supported providers:
   - OpenAI — https://platform.openai.com/api-keys
   - DeepSeek — https://platform.deepseek.com/api_keys
   - Anthropic (Claude) — https://console.anthropic.com/settings/keys

2. **Install the extension**
   - *Chrome Web Store:* install directly (link above)
   - *From source:* open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder

3. **Enter your API key**
   - Click the Pluck toolbar icon → **OPEN SETTINGS**
   - Choose your provider, paste the key, pick a default model → **SAVE SETTINGS**

---

## Usage

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+1` | Enter visual selection mode (toggle) |
| `Alt+`` | Toggle the overlay on/off |
| `Esc` | Close overlay / cancel |

### Selecting content

| Action | Result |
|---|---|
| Click an element | Captures the full text of that element |
| Drag to select text | Captures selected text as **Key**, parent element as **Context** |
| `Shift` + click or drag | Appends to existing selections |
| Hover a selection → copy icon | Copy selection text to clipboard |
| **CLEAR ALL** | Remove all selections |

The sidebar sends **Key** (what you focused on) and **Context** (the surrounding element) so the model understands the full picture without receiving unnecessary HTML.

### Presets — type `@name` in the input

| Preset | What it does |
|---|---|
| `@sum` | Summarise into bare key points |
| `@extract` | Extract all data points and facts |
| `@explain` | Explain in plain language |
| `@translate` | Translate to English (or specify target language) |
| `@rephrase` | 3–5 alternative phrasings |
| `@grammar` | List grammatical errors with corrections |
| `@keywords` | Generate search keyword candidates |
| `@find` | Fuzzy-search for something in the selected text |
| `@define` | Define a term or concept |
| `@outline` | Convert content to a hierarchical outline |

### Custom skills — type `/name` in the input

Define your own prompt shortcuts in Settings (⚙ button). Any `/name` you register expands to its full prompt before the query is sent.

### Model cycling

Click the **model badge** in the sidebar header to cycle through all models for the active provider without leaving the page.

---

## Supported providers and models

| Provider | Models |
|---|---|
| **OpenAI** | `gpt-4o-mini` (default) · `gpt-4o` · `gpt-5-mini` |
| **DeepSeek** | `deepseek-chat` · `deepseek-reasoner` |
| **Anthropic Claude** | `claude-3-5-haiku-latest` · `claude-3-5-sonnet-latest` |

Switch providers any time in Settings. Each provider stores its own key independently.

---

## Privacy

- API calls go **directly** from your browser to the provider — no proxy, no Pluck server.
- Your API key is stored locally in Chrome's sync storage.
- Page content is sent to the provider **only** when you explicitly submit a query.
- No analytics, no telemetry, no data is ever sent to the extension developer.

Full policy: [privacy.html](privacy.html)

---

## Uninstall

Remove from `chrome://extensions`. No registry entries or native hosts to clean up.

---

## For developers

### Project structure

```
extension/
  background.js      — MV3 service worker; LLM API relay
  providers.js       — Provider config (endpoints, models, key format)
  content.js         — Selection overlay injected into pages
  sidepanel.js/html  — Main AI chat sidebar
  options.js/html    — Settings page
  popup.js/html      — Toolbar popup (status display)
  pdf-extract.js     — PDF text extraction helper
  config.json        — Built-in preset definitions
  icons/             — Extension icons (16, 32, 48, 128 px)
```

### Adding a new provider

1. Add an entry to `CWA_PROVIDER_CONFIG` in `extension/providers.js`
2. If the provider uses the OpenAI-compatible chat completions format, set `requestType: 'openai-compatible'`; otherwise implement a streaming handler in `background.js` alongside `streamAnthropic()`
3. Add the API endpoint to `host_permissions` in `manifest.json`

### Build / package

```powershell
Compress-Archive -Path extension\* -DestinationPath pluck-2.0.0.zip -Force
```

Upload `pluck-2.0.0.zip` to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

### CWS permission justifications

| Permission | Reason |
|---|---|
| `activeTab` | Read current tab URL and title for page context |
| `scripting` | Inject selection overlay into active page |
| `storage` | Persist API keys, provider, model preference |
| `sidePanel` | Display the AI chat sidebar |
| `tabs` | Open settings page; read tab URL |
| `unlimitedStorage` | Full conversation history in IndexedDB (avoids 5 MB quota) |
| `https://api.openai.com/*` | Direct calls to OpenAI API |
| `https://api.deepseek.com/*` | Direct calls to DeepSeek API |
| `https://api.anthropic.com/*` | Direct calls to Anthropic API |
| `https://*/*`, `http://*/*` | Content script must inject into any page the user browses |

