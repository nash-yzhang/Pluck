// background.js — Pluck v2.0  (LLM API relay, MV3 service worker)
// No native host needed — fetch() calls the selected provider directly.
'use strict';

importScripts('providers.js');

const LOG = (...a) => console.log('[CWA-BG]', ...a);
const ERR = (...a) => console.error('[CWA-BG]', ...a);

// In-memory set of tabIds where the side panel is currently open.
// Kept in sync with cwaSpOpen in session storage, but readable synchronously
// so sidePanel.open() can be called without any async hop (preserves user-gesture context).
const spOpenTabs = new Set();

// When the sidepanel closes (pagehide → cwaSpOpen: false), clear the set.
// Since we don't know which tabId closed, clear all — they'll be re-added on next open.
chrome.storage.session.onChanged.addListener(changes => {
  if ('cwaSpOpen' in changes && !changes.cwaSpOpen.newValue) {
    spOpenTabs.clear();
  }
});

async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['cwaApiKey', 'cwaApiKeys', 'cwaModel', 'cwaProvider'], r => {
      const normalized = cwaNormalizeSettings({
        provider: r.cwaProvider,
        model: r.cwaModel,
        apiKeys: r.cwaApiKeys,
        apiKey: r.cwaApiKey,
      });
      resolve({
        provider: normalized.provider,
        apiKey: normalized.apiKeys[normalized.provider] || '',
        apiKeys: normalized.apiKeys,
        model: normalized.model,
      });
    });
  });
}

function buildMessages(payload, provider) {
  let baseSystem =
    'You are a browser-embedded web assistant. Be CONCISE and FAST.\n' +
    '- Lead with the answer, add detail only if essential.\n' +
    '- Use the page URL and title to infer context instantly.\n' +
    '- [Key] marks text the user highlighted — treat it as the primary focus.\n' +
    '- [Context] is the surrounding element/page content for reference.\n' +
    '- Answer in the same language the user writes in.\n' +
    '- When a web search would meaningfully help, include [SEARCH: specific query] anywhere in your reply.';

  if (payload.presetInstruction) {
    baseSystem += '\n\nUser-selected instruction (apply to this response): ' + payload.presetInstruction;
  }

  // Phase 0-C: prepend resume summary when available
  if (payload.resumeSummary) {
    baseSystem = '[Previous session summary]:\n' + payload.resumeSummary + '\n\n' + baseSystem;
  }

  const msgs = [];

  // Conversation history (raw Q&A pairs)
  (payload.messages || []).forEach(m => msgs.push(m));

  // Build current user message — page context lives in system, not here
  const parts = [];
  parts.push(`[Page: ${payload.url}]`);
  if (payload.meta && payload.meta.title)       parts.push(`[Title: ${payload.meta.title}]`);
  if (payload.meta && payload.meta.description) parts.push(`[Description: ${payload.meta.description}]`);

  if (payload.selections && payload.selections.length > 0) {
    payload.selections.forEach(function(sel, i) {
      const label = payload.selections.length > 1 ? ` [${i + 1}]` : '';
      parts.push(`\n[Key${label}]:\n${sel.text}`);
      if (sel.context !== sel.text) {
        parts.push(`\n[Context${label}]:\n${sel.context}`);
      }
    });
  }

  parts.push(`\nQuestion: ${payload.prompt}`);
  msgs.push({ role: 'user', content: parts.join('\n') });

  // Phase 0-B: build effective page context (base + delta)
  let effectivePageContext = payload.pageContext || null;
  if (effectivePageContext && payload.pageDelta) {
    effectivePageContext += '\n\n[Page Update]:\n' + payload.pageDelta;
  } else if (!effectivePageContext && payload.pageDelta) {
    effectivePageContext = payload.pageDelta;
  }

  // For Claude: explicit prompt caching — system as array of blocks with cache_control.
  if (provider === 'claude') {
    const blocks = [
      { type: 'text', text: baseSystem, cache_control: { type: 'ephemeral' } },
    ];
    if (effectivePageContext) {
      blocks.push({
        type: 'text',
        text: '[Full Page Content]:\n' + effectivePageContext,
        cache_control: { type: 'ephemeral' },
      });
    }
    return { system: blocks, messages: msgs };
  }

  // Other providers: flat string system
  const system = effectivePageContext
    ? baseSystem + '\n\n[Full Page Content]:\n' + effectivePageContext
    : baseSystem;
  return { system, messages: msgs };
}

async function parseProviderError(response, provider) {
  const rawText = await response.text();
  let message = provider + ' error ' + response.status;

  try {
    const data = JSON.parse(rawText);
    if (data.error && typeof data.error === 'object' && data.error.message) {
      message += ': ' + data.error.message;
    } else if (typeof data.error === 'string') {
      message += ': ' + data.error;
    } else if (data.message) {
      message += ': ' + data.message;
    } else {
      message += ': ' + rawText.slice(0, 200);
    }
  } catch (_) {
    message += ': ' + rawText.slice(0, 200);
  }

  return message;
}

async function streamOpenAICompatible(provider, apiKey, model, messages, onChunk) {
  const cfg = cwaGetProviderConfig(provider);
  const response = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok) throw new Error(await parseProviderError(response, cfg.label));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data);
        const delta = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
        if (delta) {
          fullText += delta;
          onChunk(delta);
        }
      } catch (_) {}
    }
  }

  return fullText;
}

async function streamAnthropic(apiKey, model, system, messages, onChunk) {
  const cfg = cwaGetProviderConfig('claude');
  const claudeHeaders = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // Enable prompt caching when system is an array of blocks with cache_control
  if (Array.isArray(system)) claudeHeaders['anthropic-beta'] = 'prompt-caching-2024-07-31';

  const response = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: claudeHeaders,
    body: JSON.stringify({
      model,
      system,
      messages,
      max_tokens: 4096,
      stream: true,
    }),
  });

  if (!response.ok) throw new Error(await parseProviderError(response, cfg.label));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop();

    for (const eventBlock of events) {
      const lines = eventBlock.split('\n');
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('data: ')) dataLine += line.slice(6);
      }
      if (!dataLine || dataLine === '[DONE]') continue;

      try {
        const obj = JSON.parse(dataLine);
        if (obj.type === 'content_block_delta' && obj.delta && obj.delta.text) {
          fullText += obj.delta.text;
          onChunk(obj.delta.text);
        }
        if (obj.type === 'error' && obj.error && obj.error.message) {
          throw new Error(obj.error.message);
        }
      } catch (e) {
        if (e && e.message) throw e;
      }
    }
  }

  return fullText;
}

async function streamProviderResponse(provider, apiKey, model, messageData, onChunk) {
  if (provider === 'claude') {
    return streamAnthropic(apiKey, model, messageData.system, messageData.messages, onChunk);
  }

  // Flatten array system (Claude format) to string for OpenAI-compatible providers
  const sysContent = Array.isArray(messageData.system)
    ? messageData.system.map(b => b.text).join('\n\n')
    : messageData.system;
  return streamOpenAICompatible(provider, apiKey, model, [{ role: 'system', content: sysContent }].concat(messageData.messages), onChunk);
}

async function requestOpenAICompatibleJson(provider, apiKey, body) {
  const cfg = cwaGetProviderConfig(provider);
  const response = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await parseProviderError(response, cfg.label));
  return response.json();
}

async function requestAnthropicJson(apiKey, body) {
  const response = await fetch(cwaGetProviderConfig('claude').endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await parseProviderError(response, 'Claude'));
  return response.json();
}

// ── Port-based streaming (QUERY) ───────────────────────────────────────────
chrome.runtime.onConnect.addListener(contentPort => {
  if (contentPort.name !== 'cwa') return;

  contentPort.onMessage.addListener(async msg => {
    if (msg.type !== 'QUERY') return;

    const { apiKey, model, provider } = await getConfig();
    if (!apiKey) {
      contentPort.postMessage({ error: 'No API key set. Click ⚙ to open settings.' });
      return;
    }

    const messageData = buildMessages(msg.payload, provider);
    const modelName = msg.payload.model || model;
    LOG('QUERY provider=', provider, 'model=', modelName, 'msgs=', messageData.messages.length + 1);

    try {
      const fullText = await streamProviderResponse(provider, apiKey, modelName, messageData, delta => {
        contentPort.postMessage({ type: 'CHUNK', chunk: delta });
      });

      contentPort.postMessage({ type: 'DONE', reply: fullText });
      LOG('DONE reply_len=', fullText.length);

    } catch (e) {
      ERR('fetch error:', e.message);
      contentPort.postMessage({ error: 'Request failed: ' + e.message });
    }
  });

  contentPort.onDisconnect.addListener(() => {
    LOG('content port disconnected');
  });
});

// ── One-shot messages ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'PING') { respond({ ok: true }); return false; }
  if (msg.type === 'CHECK') {
    getConfig().then(cfg => {
      respond({ ok: true, hasKey: !!cfg.apiKey, provider: cfg.provider, model: cfg.model });
    });
    return true;
  }
  // Phase 0-C: generate a short resume summary for a conversation with ≥4 messages
  if (msg.type === 'RESUME_SUMMARIZE') {
    (async () => {
      const { apiKey, model, provider } = await getConfig();
      if (!apiKey) { respond({ error: 'No API key set.' }); return; }
      const { messages } = msg.payload;
      const prompt = 'Summarize this conversation in ≤5 bullet points for context resumption. Be very concise.';
      const summaryMsgs = (messages || []).concat([{ role: 'user', content: prompt }]);
      try {
        let summary = '';
        if (provider === 'claude') {
          const data = await requestAnthropicJson(apiKey, {
            model, max_tokens: 300,
            system: 'Return a short bullet-point summary (≤5 bullets, ≤150 tokens).',
            messages: summaryMsgs,
          });
          summary = ((data.content || []).map(p => p.text || '').join('')).trim();
        } else {
          const data = await requestOpenAICompatibleJson(provider, apiKey, {
            model,
            messages: [{ role: 'system', content: 'Return a short bullet-point summary (≤5 bullets, ≤150 tokens).' }].concat(summaryMsgs),
            stream: false, max_completion_tokens: 300,
          });
          summary = (data.choices[0].message.content || '').trim();
        }
        respond({ summary });
      } catch(e) {
        ERR('RESUME_SUMMARIZE error:', e.message);
        respond({ error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'HISTORY_SAVE') {
    saveHistoryEntry(msg.payload)
      .then(() => respond({ ok: true }))
      .catch(e => { ERR('HISTORY_SAVE failed', e); respond({ ok: false }); });
    return true;
  }
  if (msg.type === 'TRACE_SAVE') {
    // Patch the latest assistant message for the given url with traceAttributions
    (async () => {
      const { url, aiReply, traceAttributions } = msg.payload;
      const normUrl = normalizeHistUrl(url);
      const hist = await histLGet(HISTORY_KEY) || { version: 1, entries: [] };
      const entry = hist.entries.find(e => e.url === normUrl);
      if (entry && entry.content) {
        // Find the most recent assistant message matching aiReply
        for (let i = entry.content.length - 1; i >= 0; i--) {
          if (entry.content[i].role === 'assistant' && entry.content[i].message === aiReply) {
            entry.content[i].traceAttributions = traceAttributions;
            break;
          }
        }
        await histLSet(HISTORY_KEY, hist);
      }
      respond({ ok: true });
    })();
    return true;
  }
  // Generic session-storage relay: content scripts on restricted pages can't write session storage directly
  if (msg.type === 'SET_SESSION') {
    if (msg.key && msg.value !== undefined) {
      chrome.storage.session.set({ [msg.key]: msg.value });
    }
    return false;
  }
  // content.js hotkey → open the sidebar and set the goChat flag for capture mode
  if (msg.type === 'OPEN_SIDE_PANEL') {
    // sidePanel.open() requires user-gesture context. We must NOT have any async hop
    // (storage.get, tabs.query) before calling it. Use sender.tab.id (synchronous) and
    // spOpenTabs (in-memory, synchronous) to decide whether to call open().
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) return false;

    // Write handoff to session storage (no gesture required for storage writes)
    if (msg.handoff) {
      chrome.storage.session.set({ cwaFloatHandoff: msg.handoff });
    }

    if (spOpenTabs.has(tabId)) {
      // Panel already open — storage.onChanged in the panel picks up the handoff.
      // Calling sidePanel.open() again would reload/reset the panel.
      LOG('OPEN_SIDE_PANEL: panel already open for tab', tabId, '— skipping; handoff=', !!msg.handoff);
    } else {
      chrome.sidePanel.open({ tabId })
        .then(() => {
          spOpenTabs.add(tabId);
          chrome.storage.session.set({ cwaSpOpen: true });
          if (!msg.handoff && msg.goChat) chrome.storage.session.set({ cwaGoChat: { t: Date.now() } });
        })
        .catch(e => ERR('sidePanel.open', e));
    }
    return false;
  }
  // Alt+` toggle path — open or close the sidebar based on current state
  if (msg.type === 'TOGGLE_SIDE_PANEL') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) return false;
    // Use spOpenTabs (in-memory) to avoid async storage read before sidePanel.open()
    if (spOpenTabs.has(tabId)) {
      chrome.windows.getCurrent(w => {
        chrome.sidePanel.close({ windowId: w.id }).catch(e => LOG('sidePanel.close error:', e.message));
        spOpenTabs.delete(tabId);
        chrome.storage.session.set({ cwaSpOpen: false });
      });
    } else {
      chrome.sidePanel.open({ tabId })
        .then(() => { spOpenTabs.add(tabId); chrome.storage.session.set({ cwaSpOpen: true }); })
        .catch(e => ERR('sidePanel.open TOGGLE_SIDE_PANEL', e));
    }
    return false;
  }
  // New context capture: relay to side panel
  if (msg.type === 'SEL_NEW') {
    chrome.storage.session.set({ cwaSelMsg: { type: 'SEL_NEW', payload: msg.payload, t: Date.now() } });
    return false;
  }
  // Legacy selection relay: forward to side panel via storage flag
  if (msg.type === 'SEL_SET' || msg.type === 'SEL_APPEND') {
    chrome.storage.session.set({ cwaSelMsg: { type: msg.type, payload: msg.payload, t: Date.now() } });
    return false;
  }
  // ── Post-hoc attribution trace ─────────────────────────────────────────
  if (msg.type === 'TRACE') {
    (async () => {
      const { apiKey, model, provider } = await getConfig();
      if (!apiKey) { respond({ error: 'No API key set.' }); return; }
      const { reply, sources, model: reqModel, priorAttributions } = msg.payload;
      const srcBlock = sources.map((s, i) =>
        `[${i}] ${s.title ? s.title + ' @ ' : ''}${s.url || 'source'}:\n${s.text.slice(0, 6000)}`
      ).join('\n\n');
      let prompt =
        'You are a citation attribution assistant. The AI reply and the source texts may be in DIFFERENT languages (e.g. reply in Chinese, sources in English). This is normal — the reply was generated from those sources via translation or paraphrase.\n\n' +
        'Task: go through the ENTIRE reply sentence by sentence, and for every factual claim or statement, find the passage in the numbered source texts that the claim was derived from.\n\n' +
        'You MUST cover ALL claims throughout the full reply — not just the first paragraph or first few sentences.\n\n' +
        'Return ONLY a valid JSON array (no markdown fences, no explanation):\n' +
        '[{"claim":"short phrase copied verbatim from the reply","src":0,"evidence":"exact verbatim substring copied from the source text — do NOT translate, do NOT paraphrase, must be findable by substring search in the source"}]\n\n' +
        'Critical rules:\n' +
        '- "evidence" MUST be a verbatim substring of the numbered source text. Copy it character-for-character.\n' +
        '- "evidence" is always in the SOURCE language, even if the reply is in a different language.\n' +
        '- "claim" is in the REPLY language, exactly as it appears in the reply.\n' +
        '- Cover claims from the beginning, middle, AND end of the reply.\n' +
        '- Only include claims with clear source support. If nothing is attributable, return [].\n' +
        '- src is the 0-based index of the source.\n\n' +
        'Reply:\n' + reply + '\n\nSources:\n' + srcBlock;
      if (priorAttributions && priorAttributions.length) {
        prompt +=
          '\n\nPrevious attribution attempt (keep valid entries, fix incorrect ones, add missing claims for better coverage):\n' +
          JSON.stringify(priorAttributions) +
          '\n\nReturn ONLY the improved JSON array in the same format.';
      }
      try {
        let raw = '';
        if (provider === 'claude') {
          const data = await requestAnthropicJson(apiKey, {
            model: reqModel || model,
            max_tokens: 4096,
            system: 'Return only valid JSON. No markdown fences, no explanation.',
            messages: [{ role: 'user', content: prompt }],
          });
          raw = ((data.content || []).map(part => part.text || '').join('') || '').trim();
        } else {
          const data = await requestOpenAICompatibleJson(provider, apiKey, {
            model: reqModel || model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            temperature: 0,
            max_completion_tokens: 4096,
          });
          raw = (data.choices[0].message.content || '').trim();
        }
        raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        const attributions = JSON.parse(raw);
        respond({ attributions });
      } catch(e) {
        ERR('TRACE error:', e.message);
        respond({ error: e.message });
      }
    })();
    return true;
  }

  // ── AI-powered on-page find (Alt+F panel fallback) ─────────────────────
  if (msg.type === 'FIND_ON_PAGE') {
    const tabId = sender.tab && sender.tab.id;
    const { query, pageText, mode, searchId } = msg.payload;
    respond({ started: true }); // release the sendMessage callback immediately
    // mode: 1=strict(scores 3-4), 2=related(2-4), 3=general(1-4), 4=broad(1-4)
    const modeInstructions = [
      '',
      'Return ONLY verbatim text with score 3 or 4. Only exact or very close matches to the query meaning.',
      'Return verbatim text semantically related to the query. Score 2-4.',
      'Return verbatim text generally related to the query topic. Score 1-4.',
      'Return anything on the page that could be broadly related. Score 1-4.',
    ];
    const safeMode = Math.max(1, Math.min(4, mode || 2));
    const prompt =
      'Find passages in the page text matching the user query.\n' +
      modeInstructions[safeMode] + '\n\n' +
      'Output one JSON object per line (NDJSON). No other text, no markdown:\n' +
      '{"text":"verbatim substring from page (10-120 chars)","score":4}\n' +
      'Scores: 4=exact match, 3=closely related, 2=generally related, 1=broad/tangential.\n' +
      'Max 12 results. Each "text" must be a verbatim substring of the page text.\n\n' +
      'User query: ' + query + '\n\nPage text:\n' + pageText;
    (async () => {
      const { apiKey, model, provider } = await getConfig();
      if (!apiKey) {
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'FIND_DONE', searchId }).catch(() => {});
        return;
      }
      const sendChunk = (text, score) => {
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'FIND_CHUNK', text, score, searchId }).catch(() => {});
      };
      let buffer = '';
      try {
        await streamProviderResponse(provider, apiKey, model, {
          system: 'Output NDJSON only. Each line: {"text":"verbatim quote","score":N}. No markdown, no extra text.',
          messages: [{ role: 'user', content: prompt }],
        }, delta => {
          buffer += delta;
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
              const obj = JSON.parse(line);
              if (obj && typeof obj.text === 'string' && typeof obj.score === 'number') {
                sendChunk(obj.text, obj.score);
              }
            } catch(_) {}
          }
        });
        // flush remaining buffer
        const rem = buffer.trim();
        if (rem) { try { const obj = JSON.parse(rem); if (obj && typeof obj.text === 'string') sendChunk(obj.text, obj.score || 2); } catch(_) {} }
      } catch(e) {
        ERR('FIND_ON_PAGE stream error:', e.message);
      }
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'FIND_DONE', searchId }).catch(() => {});
    })();
    return false; // respond() already called synchronously
  }

  // ── Web search with LLM-cited summary ──────────────────────────────────
  if (msg.type === 'WEB_SEARCH') {
    (async () => {
      const { apiKey, model, provider } = await getConfig();
      if (!apiKey) { respond({ error: 'No LLM API key set.' }); return; }
      const { query } = msg.payload;
      const searchCfg = await new Promise(r => chrome.storage.sync.get(['cwaSearchApiKey', 'cwaSearchProvider'], r));
      const searchKey      = (searchCfg.cwaSearchApiKey || '').trim();
      const searchProvider = searchCfg.cwaSearchProvider || 'brave';
      if (!searchKey) { respond({ error: 'No Search API key configured. Add one in Settings → Search API.' }); return; }
      try {
        let results = [];
        if (searchProvider === 'brave') {
          const r = await fetch(
            'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=6&text_decorations=0',
            { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': searchKey } }
          );
          if (!r.ok) throw new Error('Brave Search error ' + r.status + ': ' + await r.text().then(t => t.slice(0,200)));
          const data = await r.json();
          results = ((data.web && data.web.results) || []).slice(0, 6).map(item => ({
            title: item.title || '', url: item.url || '', snippet: item.description || '',
          }));
        } else if (searchProvider === 'serper') {
          const r = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': searchKey },
            body: JSON.stringify({ q: query, num: 6 }),
          });
          if (!r.ok) throw new Error('Serper error ' + r.status);
          const data = await r.json();
          results = (data.organic || []).slice(0, 6).map(item => ({
            title: item.title || '', url: item.link || '', snippet: item.snippet || '',
          }));
        }
        if (!results.length) { respond({ error: 'No search results returned.' }); return; }

        const srcBlock = results.map((r, i) =>
          '[' + (i+1) + '] ' + r.title + '\n' + r.url + '\n' + r.snippet
        ).join('\n\n');
        const summaryPrompt =
          'Summarize these web search results to answer: "' + query + '"\n' +
          'Rules:\n' +
          '- Every factual statement MUST be followed by a citation like [1] or [2] immediately after.\n' +
          '- Write 3–6 bullet points. Be concise and factual.\n' +
          '- Answer in the same language as the query.\n' +
          '- Use only the source numbers from the list below.\n\n' +
          'Sources:\n' + srcBlock;
        let summary = '';
        if (provider === 'claude') {
          const data = await requestAnthropicJson(apiKey, {
            model, max_tokens: 1024,
            system: 'You summarize web search results with inline numbered citations [N]. Be concise.',
            messages: [{ role: 'user', content: summaryPrompt }],
          });
          summary = ((data.content || []).map(p => p.text || '').join('')).trim();
        } else {
          const data = await requestOpenAICompatibleJson(provider, apiKey, {
            model, messages: [{ role: 'user', content: summaryPrompt }],
            stream: false, max_completion_tokens: 1024,
          });
          summary = (data.choices[0].message.content || '').trim();
        }
        respond({ summary, sources: results, query });
      } catch(e) {
        ERR('WEB_SEARCH error:', e.message);
        respond({ error: e.message });
      }
    })();
    return true;
  }

  return false;
});

// ── Chrome commands (work on ALL pages incl. PDF viewer) ──────────────────
// onCommand passes (command, tab) — use tab directly to preserve user-gesture context
chrome.commands.onCommand.addListener((command, tab) => {
  LOG('DEBUG onCommand: command=', command, 'tab=', tab && tab.id, 'tabUrl=', tab && (tab.url || '').slice(0, 60));
  if (!tab) { LOG('DEBUG onCommand: ⚠ tab is null/undefined — Chrome did not supply tab for this command'); return; }

  if (command === 'open-sidebar-capture') {
    LOG('DEBUG open-sidebar-capture: calling sidePanel.open() synchronously (has gesture context)');
    chrome.sidePanel.open({ tabId: tab.id })
      .then(() => {
        LOG('DEBUG open-sidebar-capture: sidePanel.open() succeeded, scheduling cwaGoCapture in 300ms');
        // Delay writing cwaGoCapture to give sidepanel JS time to init() and register storage.onChanged listener.
        // This ensures the capture event is not missed due to race condition.
        setTimeout(() => {
          chrome.storage.session.set({ cwaGoCapture: { t: Date.now(), url: tab.url || '' } });
          spOpenTabs.add(tab.id);
          chrome.storage.session.set({ cwaSpOpen: true });
        }, 300);
      })
      .catch(e => ERR('sidePanel.open', e));
  }

  if (command === 'find-on-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_FIND_PANEL' }).catch(e => ERR('find-on-page sendMessage', e));
    return;
  }

  if (command === 'toggle-sidebar') {
    // Use spOpenTabs (in-memory, synchronous) so sidePanel.open() is called with no async hop.
    if (spOpenTabs.has(tab.id)) {
      chrome.windows.getCurrent(w => {
        chrome.sidePanel.close({ windowId: w.id }).catch(e => LOG('sidePanel.close error:', e.message));
        spOpenTabs.delete(tab.id);
        chrome.storage.session.set({ cwaSpOpen: false });
      });
    } else {
      chrome.sidePanel.open({ tabId: tab.id })
        .then(() => { spOpenTabs.add(tab.id); chrome.storage.session.set({ cwaSpOpen: true }); })
        .catch(e => ERR('sidePanel.open', e));
    }
  }
});

// ── History storage helpers ────────────────────────────────────────────────
const HISTORY_KEY      = 'cwaHistory';
const MAX_MAIN_BYTES   = 100 * 1024;       // 100 KB
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024; // 2 MB

// Validate that a directory has been selected for data storage
async function validateDataDir() {
  return new Promise(resolve => {
    const req = indexedDB.open('pluck_idb', 2);
    req.onupgradeneeded = e => { const db = e.target.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('kv', 'readonly');
      tx.objectStore('kv').get('dirHandle').onsuccess = ev => {
        resolve(!!ev.target.result);
      };
    };
    req.onerror = () => resolve(false);
  });
}

function histLGet(key) {
  return new Promise(r => chrome.storage.local.get(key, d => r(d[key] || null)));
}
function histLSet(key, val) {
  return new Promise(r => chrome.storage.local.set({ [key]: val }, r));
}

function normalizeHistUrl(url) {
  try {
    const u = new URL(url);
    // Keep full URL minus hash; strip trailing slash from pathname
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return u.origin + path + (u.search || '');
  } catch (_) { return url; }
}

async function saveHistoryEntry(payload) {
  const { url, title, userMessage, aiReply, contextTexts = [] } = payload;
  const normUrl = normalizeHistUrl(url);

  const raw = await histLGet(HISTORY_KEY);
  const hist = raw || { version: 1, entries: [] };

  const now = Date.now();
  const msgPair = [
    { timestamp: now,     role: 'user',      message: userMessage,
      context: contextTexts.filter(Boolean).join(' | ') },
    { timestamp: now + 1, role: 'assistant', message: aiReply,
      context: '', contextRefs: (payload.contextRefs || []),
      traceAttributions: payload.traceAttributions || null },
  ];

  const idx = hist.entries.findIndex(e => e.url === normUrl);
  if (idx >= 0) {
    const entry = hist.entries[idx];
    entry.timestamp = now;
    if (!entry.content) entry.content = [];
    entry.content.push(...msgPair);
    if (entry.content.length > 50) entry.content = entry.content.slice(-50);
    contextTexts.filter(Boolean).forEach(c => {
      if (!entry.context.includes(c)) entry.context.push(c);
    });
    // Re-sort to front
    hist.entries.splice(idx, 1);
    hist.entries.unshift(entry);
  } else {
    hist.entries.unshift({
      url:       normUrl,
      timestamp: now,
      title:     title || normUrl,
      context:   contextTexts.filter(Boolean),
      content:   msgPair,
    });
  }

  await maybeArchive(hist);
  await histLSet(HISTORY_KEY, hist);
}

async function maybeArchive(hist) {
  const size = new TextEncoder().encode(JSON.stringify(hist)).length;
  if (size <= MAX_MAIN_BYTES) return;

  const displayDays = await new Promise(r =>
    chrome.storage.sync.get('cwaDisplayDays', d => r(d.cwaDisplayDays || 7))
  );
  const cutoff = Date.now() - displayDays * 24 * 3600 * 1000;

  let toArchive = hist.entries.filter(e => e.timestamp < cutoff);
  if (toArchive.length === 0) {
    // Force-evict oldest 20 %
    const n = Math.max(1, Math.floor(hist.entries.length * 0.2));
    toArchive = hist.entries.slice(-n);
  }
  if (toArchive.length === 0) return;

  await appendToArchive(toArchive);
  const archiveUrls = new Set(toArchive.map(e => e.url));
  hist.entries = hist.entries.filter(e => !archiveUrls.has(e.url));
}

async function appendToArchive(entries) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let suffix = '';
  for (;;) {
    const key = 'cwaArchive_' + today + suffix;
    const existing = await histLGet(key);
    const arr = existing || [];
    const proposed = [...arr, ...entries];
    const size = new TextEncoder().encode(JSON.stringify(proposed)).length;
    if (size <= MAX_ARCHIVE_BYTES || arr.length === 0) {
      await histLSet(key, proposed);
      return;
    }
    // Current archive full — try next slot
    const n = suffix ? (parseInt(suffix.slice(1), 10) + 1) : 1;
    suffix = '_' + n;
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

LOG('background started');
