# Pluck — Privacy Policy

**Effective date:** April 20, 2026 | **Last updated:** April 20, 2026

Pluck ("the extension") is a browser extension that lets you select text on any web page and send it to a large language model (LLM) provider of your choice. This policy explains what data the extension accesses, where it goes, and what is never collected.

## 1. Data the extension accesses

- **Page content you explicitly select** — text you click or drag-select on the current tab, plus the URL, title, and meta description of that tab. This is sent to the LLM provider only when you submit a query.

- **Your API key** — stored locally in Chrome's sync storage (`chrome.storage.sync`). It is included in API request headers sent directly to your chosen provider.

- **Conversation history** — stored locally in Chrome's IndexedDB on your device. Never transmitted anywhere except as context for your own queries.

## 2. What is sent to third-party providers

When you ask a question, the extension sends the following directly from your browser to the API endpoint of the provider you selected:

- The text you selected (Key / Context)
- The page URL, title, and meta description
- Your recent conversation history (up to 10 turns)
- Your question
- Your API key (in the `Authorization` header)

**Supported providers and their privacy policies:**

- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy)
- [DeepSeek Privacy Policy](https://www.deepseek.com/privacy_policy)
- [Anthropic Privacy Policy](https://www.anthropic.com/privacy)

All API calls are made **directly from your browser** to the provider. There is no intermediate server, proxy, or backend operated by the extension author.

## 3. What is never collected

- No data is sent to the extension developer at any time.
- No analytics, crash reporting, or telemetry of any kind.
- No browsing history, cookies, passwords, or personal identifiers.
- No data is collected from pages you visit without explicit user action.

## 4. Permissions used and why

- **activeTab** — read the current tab's URL and title to include page context in queries.
- **scripting** — inject the selection overlay into the active page.
- **storage** — save your API key, provider choice, and model preference locally.
- **sidePanel** — display the AI chat sidebar.
- **tabs** — open the settings page and read the current tab URL.
- **unlimitedStorage** — store conversation history in IndexedDB without hitting Chrome's 5 MB quota.
- **Host permissions (all URLs)** — the content script must be able to inject into any page the user is browsing so the selection overlay is available everywhere.

## 5. Data retention and deletion

All data (API keys, conversation history, settings) is stored locally on your device inside Chrome's storage. You can clear it at any time by:

- Opening the extension's Settings page and using the **RESET** option, or
- Removing the extension from `chrome://extensions`, which deletes all associated storage.

## 6. Children's privacy

The extension is not directed at children under 13 and does not knowingly collect any information from children.

## 7. Changes to this policy

If this policy is updated, the "Last updated" date above will change. Continued use of the extension after changes constitutes acceptance of the new policy.

## 8. Contact

For questions about this privacy policy, open an issue on the project's source repository or contact the developer via the Chrome Web Store developer contact form.

---

*Pluck · Chrome Extension · Privacy Policy*
