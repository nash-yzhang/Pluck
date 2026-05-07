// background.js — Pluck v2.0  (LLM API relay, MV3 service worker)
// No native host needed — fetch() calls the selected provider directly.
'use strict';

importScripts('providers.js');

const LOG = (...a) => console.log('[CWA-BG]', ...a);
const ERR = (...a) => console.error('[CWA-BG]', ...a);

const CWA_EFFORTS = Object.freeze({
  instant:  { findChars: 3500,  traceChars: 3500,  evidenceChars: 2500, middleAnchors: 3, findCap: 34 },
  balanced: { findChars: 6000,  traceChars: 7000,  evidenceChars: 4500, middleAnchors: 5, findCap: 48 },
  deep:     { findChars: 11000, traceChars: 14000, evidenceChars: 8000, middleAnchors: 9, findCap: 72 },
});

function normalizeEffort(effort) {
  if (effort === 'cheap') return 'instant';
  return CWA_EFFORTS[effort] ? effort : 'instant';
}

function getEffortBudget(effort) {
  return CWA_EFFORTS[normalizeEffort(effort)];
}

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
    chrome.storage.sync.get(['cwaApiKey', 'cwaApiKeys', 'cwaModel', 'cwaProvider', 'cwaEffort'], r => {
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
        effort: normalizeEffort(r.cwaEffort),
      });
    });
  });
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function _tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = lower.match(/\w+/g) || [];
  const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  let m;
  while ((m = cjkRe.exec(lower)) !== null) {
    tokens.push(m[0]);
    const next = lower[m.index + 1];
    if (next && /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(next)) {
      tokens.push(m[0] + next);
    }
  }
  return tokens;
}

function _bm25Select(chunks, query, charBudget) {
  const N = chunks.length;
  if (!N) return { idxs: [], lowConf: false };
  const qTokens = _tokenize(query);
  if (!qTokens.length) {
    const idxs = [];
    let chars = 0;
    const step = Math.max(1, Math.floor(N / 30));
    for (let i = 0; i < N && chars < charBudget; i += step) {
      idxs.push(chunks[i].idx);
      chars += (chunks[i].text || '').length;
    }
    return { idxs, lowConf: true };
  }
  const df = {};
  chunks.forEach(function(c) {
    const seen = new Set(_tokenize(c.text || c.textPreview || ''));
    seen.forEach(function(t) { df[t] = (df[t] || 0) + 1; });
  });
  const avgLen = Math.max(1, chunks.reduce(function(s, c) { return s + _tokenize(c.text || c.textPreview || '').length; }, 0) / N);
  const scores = chunks.map(function(c) {
    const tokens = _tokenize(c.text || c.textPreview || '');
    const tf = {};
    tokens.forEach(function(t) { tf[t] = (tf[t] || 0) + 1; });
    let score = 0;
    qTokens.forEach(function(qt) {
      const f = tf[qt] || 0;
      if (!f) return;
      const d = df[qt] || 0;
      const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
      score += idf * (f * 2.5) / (f + 1.5 * (0.25 + 0.75 * tokens.length / avgLen));
    });
    return { idx: c.idx, score };
  }).sort(function(a, b) { return b.score - a.score; });
  const lowConf = !scores.length || scores[0].score < 0.5;
  const selected = new Set();
  let chars = 0;
  for (let i = 0; i < scores.length && chars < charBudget; i++) {
    if (scores[i].score <= 0) break;
    const c = chunks[scores[i].idx];
    selected.add(scores[i].idx);
    chars += c ? (c.text || c.textPreview || '').length : 0;
  }
  if (lowConf && chars < charBudget * 0.7) {
    const step = Math.max(1, Math.floor(N / 25));
    for (let i = 0; i < N && chars < charBudget; i += step) {
      selected.add(chunks[i].idx);
      chars += (chunks[i].text || '').length;
    }
  }
  return { idxs: Array.from(selected), lowConf };
}

function simpleHash(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(36);
}

function splitIntoSegments(text, maxLen) {
  const clean = normalizeText(text);
  if (!clean) return [];
  const parts = clean.match(/[^.!?。！？\n]+[.!?。！？]?/g) || [clean];
  const out = [];
  let cur = '';
  parts.forEach(function(p) {
    p = p.trim();
    if (!p) return;
    if ((cur + ' ' + p).trim().length > maxLen && cur) {
      out.push(cur.trim());
      cur = p;
    } else {
      cur = (cur ? cur + ' ' : '') + p;
    }
  });
  if (cur) out.push(cur.trim());
  return out;
}

function makePlainChunks(text, title) {
  const clean = normalizeText(text);
  if (!clean) return [];
  const chunks = [];
  const size = 900, overlap = 140;
  for (let start = 0; start < clean.length; start += size - overlap) {
    const part = clean.slice(start, start + size).trim();
    if (part.length < 40) continue;
    const idx = chunks.length;
    chunks.push({
      idx,
      text: part,
      textFull: part,
      textPreview: part.slice(0, 650),
      headingPath: title || 'Page',
      positionRatio: clean.length ? start / clean.length : 0,
      tagName: 'text',
      prevIdx: idx > 0 ? idx - 1 : null,
      nextIdx: null,
      hash: simpleHash(part),
    });
    if (idx > 0) chunks[idx - 1].nextIdx = idx;
  }
  return chunks;
}

function localSelectChunks(chunks, query, charBudget) {
  const bm = _bm25Select(chunks, query || '', charBudget);
  const selected = new Set(bm.idxs || []);
  const lowerQ = normalizeText(query).toLowerCase();
  const qTokens = _tokenize(lowerQ);
  chunks.forEach(function(c) {
    const heading = normalizeText(c.headingPath || c.heading || '').toLowerCase();
    if (heading && qTokens.some(t => t.length > 1 && heading.indexOf(t) !== -1)) selected.add(c.idx);
    if (lowerQ && normalizeText(c.text || '').toLowerCase().indexOf(lowerQ) !== -1) selected.add(c.idx);
  });
  if (bm.lowConf) {
    [0.12, 0.35, 0.5, 0.65, 0.88].forEach(function(r) {
      const idx = Math.min(chunks.length - 1, Math.max(0, Math.floor(chunks.length * r)));
      if (chunks[idx]) selected.add(chunks[idx].idx);
    });
  }
  const ordered = Array.from(selected).sort(function(a, b) { return a - b; });
  const out = [];
  let chars = 0;
  ordered.forEach(function(i) {
    const c = chunks[i];
    if (!c || chars >= charBudget) return;
    out.push(i);
    chars += normalizeText(c.text || c.textPreview || '').length;
  });
  return { idxs: out, lowConf: bm.lowConf };
}

function buildEvidencePack(spans) {
  return (spans || []).map(function(s) {
    return '[' + s.spanId + ' | chunk ' + s.chunkIdx + ' | ' + Math.round((s.positionRatio || 0) * 100) + '% | ' +
      (s.headingPath || 'Section') + ']\n' + s.evidence;
  }).join('\n\n');
}

function verifyInlineSources(text, spans) {
  if (!text || !spans || !spans.length) return text || '';
  const byId = {};
  spans.forEach(function(s) { byId[s.spanId] = s; });
  return String(text).replace(/<src(?:\s+id=["']?([^"'>\s]+)["']?)?>([\s\S]*?)<\/src>/gi, function(full, id, ev) {
    const evidence = normalizeText(ev);
    let span = id && byId[id];
    if (!span) {
      span = spans.find(function(s) { return normalizeText(s.evidence).indexOf(evidence) !== -1 || evidence.indexOf(normalizeText(s.evidence)) !== -1; });
    }
    if (!span) return '[unverified]';
    const sourceText = normalizeText(span.evidence);
    if (sourceText.indexOf(evidence) === -1 && evidence.indexOf(sourceText) === -1) return '[unverified]';
    return '<src id="' + span.spanId + '">' + evidence + '</src>';
  });
}

function buildTraceCandidateSources(reply, sources, effort) {
  const budget = getEffortBudget(effort);
  const query = splitIntoSegments(reply || '', 220).slice(0, 12).join(' ');
  const out = [];
  let total = 0;
  (sources || []).forEach(function(src, srcIdx) {
    if (total >= budget.traceChars) return;
    const chunks = src.chunks && src.chunks.length
      ? src.chunks
      : makePlainChunks(src.text || '', src.title || src.url || ('source ' + srcIdx));
    const selected = localSelectChunks(chunks, query, Math.max(800, Math.floor(budget.traceChars / Math.max(1, sources.length))));
    selected.idxs.forEach(function(chunkIdx) {
      if (total >= budget.traceChars) return;
      const c = chunks[chunkIdx];
      if (!c) return;
      const text = normalizeText(c.text || c.textFull || c.textPreview || '').slice(0, 900);
      if (!text) return;
      out.push({
        srcIdx,
        chunkIdx: c.idx,
        title: src.title || '',
        url: src.url || '',
        text,
        headingPath: c.headingPath || c.heading || '',
        positionRatio: c.positionRatio || 0,
      });
      total += text.length;
    });
  });
  return out;
}

function buildMessages(payload, provider) {
  const effort = normalizeEffort(payload.effort);
  const budget = getEffortBudget(effort);
  let baseSystem =
    'You are a browser-embedded web assistant. Be CONCISE and FAST.\n' +
    '- Lead with the answer, add detail only if essential.\n' +
    '- Use the page URL and title to infer context instantly.\n' +
    '- [Key] marks text the user highlighted — treat it as the primary focus.\n' +
    '- [Context] is the surrounding element/page content for reference.\n' +
    '- Answer in the same language the user writes in.\n' +
    '- When page evidence is provided, do NOT rely only on the abstract or opening paragraphs. Important evidence may appear in the middle or end.\n' +
    '- For every factual claim: cite a provided candidate span with <src id="sN">verbatim span</src>. If no candidate span supports the claim, append [unverified]. Never invent source text or span ids.';

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

  if (payload.pageMap) {
    parts.push('\n[Page Map]:\n' + payload.pageMap);
  }
  if (payload.middleAnchors) {
    parts.push('\n[Middle Anchors]:\n' + payload.middleAnchors);
  }
  if (payload.candidateSpans && payload.candidateSpans.length) {
    parts.push('\n[Candidate Spans — cite only these exact spans with <src id="sN">...</src>]:\n' + buildEvidencePack(payload.candidateSpans).slice(0, budget.evidenceChars + 1200));
  }
  msgs.push({ role: 'user', content: parts.join('\n') });

  // Phase 0-B: build effective page context (base + delta)
  let effectivePageContext = payload.pageContext || null;
  if (effort === 'instant' && effectivePageContext && payload.candidateSpans && payload.candidateSpans.length) {
    effectivePageContext = null;
  } else if (effectivePageContext && effort !== 'deep') {
    effectivePageContext = effectivePageContext.slice(0, budget.evidenceChars);
  }
  if (effectivePageContext && payload.pageDelta) {
    effectivePageContext += '\n\n[Page Update]:\n' + payload.pageDelta;
  } else if (!effectivePageContext && payload.pageDelta) {
    effectivePageContext = payload.pageDelta;
  }

  // Wrap page context with query anchors to mitigate "lost in the middle" attention bias.
  // Echoing the question before and after the document helps the model scan the full text.
  if (effectivePageContext && payload.prompt) {
    effectivePageContext =
      '[User question — keep this in mind while reading the full document below]:\n' + payload.prompt +
      '\n\n' + effectivePageContext +
      '\n\n[Reminder — answer the question above using the FULL document, not just the opening sections]:\n' + payload.prompt;
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

function normalizeOpenAICompatibleBody(provider, body) {
  const normalized = Object.assign({}, body);
  const model = String(normalized.model || '');

  // OpenAI GPT-5 chat-completions models only accept the default temperature.
  if (provider === 'openai' && /^gpt-5(?:-|$)/.test(model) && normalized.temperature !== undefined && normalized.temperature !== 1) {
    delete normalized.temperature;
  }
  if (provider === 'deepseek' && /(?:reasoner|v4)/.test(model) && normalized.temperature !== undefined && normalized.temperature !== 1) {
    delete normalized.temperature;
  }

  return normalized;
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
  const normalizedBody = normalizeOpenAICompatibleBody(provider, body);
  const response = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(normalizedBody),
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

// ── DuckDuckGo HTML scraper (shared by WEB_SEARCH and WEB_SEARCH_RAW) ───────
async function scrapeDDG(query) {
  const r = await fetch(
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }
  );
  if (!r.ok) throw new Error('DuckDuckGo fetch failed: ' + r.status);
  const html = await r.text();
  const results = [];
  const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < 6) {
    const rawHref = m[1];
    const title   = m[2].replace(/<[^>]+>/g, '').trim();
    const snippet = m[3].replace(/<[^>]+>/g, '').trim();
    let url = rawHref;
    const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
    else if (rawHref.startsWith('//')) url = 'https:' + rawHref;
    if (title && snippet) results.push({ title, url, snippet });
  }
  return results;
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

      contentPort.postMessage({ type: 'DONE', reply: verifyInlineSources(fullText, msg.payload.candidateSpans || []) });
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
  // AUTO_FIND hits relay: content.js → background → chrome.storage.session → sidepanel.js
  if (msg.type === 'AUTO_FIND_HITS') {
    chrome.storage.session.set({ cwaAutoFindHits: msg.hits });
    respond({});
    return false;
  }
  // SCROLL_TO_CHUNK_RELAY: sidepanel → background → active tab content script
  // Avoids unreliable direct sidepanel→tab messaging when sidepanel has focus.
  if (msg.type === 'SCROLL_TO_CHUNK_RELAY') {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SCROLL_TO_CHUNK', chunkIdx: msg.chunkIdx }).catch(() => {});
      }
      respond({});
    })();
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
      if (!msg.handoff && msg.goChat) chrome.storage.session.set({ cwaGoChat: { t: Date.now() } });
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
  if (msg.type === 'IS_SIDE_PANEL_OPEN') {
    const tabId = sender && sender.tab && sender.tab.id;
    respond({ open: !!(tabId && spOpenTabs.has(tabId)) });
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
      const { apiKey, model, provider, effort: storedEffort } = await getConfig();
      if (!apiKey) { respond({ error: 'No API key set.' }); return; }
      const { reply, sources, model: reqModel, priorAttributions, effort } = msg.payload;
      const traceEffort = normalizeEffort(effort || storedEffort);
      const traceCandidates = buildTraceCandidateSources(reply, sources, traceEffort);
      const srcBlock = traceCandidates.map((s, i) =>
        `[${i}] source=${s.srcIdx} chunk=${s.chunkIdx} pos=${Math.round((s.positionRatio || 0) * 100)}% ${s.title ? s.title + ' @ ' : ''}${s.url || 'source'}:\n${s.text}`
      ).join('\n\n');
      let prompt =
        'You are a citation attribution assistant. The AI reply and the source texts may be in DIFFERENT languages (e.g. reply in Chinese, sources in English). This is normal — the reply was generated from those sources via translation or paraphrase.\n\n' +
        'Task: go through the ENTIRE reply sentence by sentence, and for every factual claim or statement, find the passage in the numbered source texts that the claim was derived from.\n\n' +
        'You MUST cover ALL claims throughout the full reply — not just the first paragraph or first few sentences.\n\n' +
        'Return ONLY a valid JSON array (no markdown fences, no explanation):\n' +
        '[{"claim":"short phrase copied verbatim from the reply","src":0,"chunkIdx":0,"confidence":0.8,"evidence":"exact verbatim substring copied from the source text — do NOT translate, do NOT paraphrase, must be findable by substring search in the source"}]\n\n' +
        'Critical rules:\n' +
        '- "evidence" MUST be a verbatim substring of the numbered source text. Copy it character-for-character.\n' +
        '- "evidence" is always in the SOURCE language, even if the reply is in a different language.\n' +
        '- "claim" is in the REPLY language, exactly as it appears in the reply.\n' +
        '- Cover claims from the beginning, middle, AND end of the reply.\n' +
        '- Only include claims with clear source support. If nothing is attributable, return [].\n' +
        '- src is the original source number shown as source= in the candidate block. chunkIdx is the candidate chunk number.\n\n' +
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
        const attributions = (JSON.parse(raw) || []).map(function(a) {
          const ev = normalizeText(a && a.evidence);
          const cand = traceCandidates.find(function(c) {
            return c.srcIdx === a.src && (normalizeText(c.text).indexOf(ev) !== -1 || ev.indexOf(normalizeText(c.text)) !== -1);
          });
          return Object.assign({}, a, {
            src: cand ? cand.srcIdx : a.src,
            chunkIdx: cand ? cand.chunkIdx : a.chunkIdx,
            confidence: typeof a.confidence === 'number' ? a.confidence : (cand ? 0.75 : 0.25),
            status: cand ? 'verified' : 'unverified',
          });
        });
        respond({ attributions });
      } catch(e) {
        ERR('TRACE error:', e.message);
        respond({ error: e.message });
      }
    })();
    return true;
  }

  // ── AI-powered on-page find (Alt+S panel fallback) ─────────────────────
  if (msg.type === 'FIND_ON_PAGE') {
    const tabId = sender.tab && sender.tab.id;
    const { query, chunks, mode, searchId, bm25Only, effort } = msg.payload;
    const findEffort = normalizeEffort(effort);
    const findBudget = getEffortBudget(findEffort);
    respond({ started: true }); // release the sendMessage callback immediately
    (async () => {
      const sendChunk = (chunkIdx, score) => {
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'FIND_CHUNK', chunkIdx, score, searchId }).catch(() => {});
      };
      // lowConf = vocabulary/language mismatch: use larger budget so LLM sees more candidates.
      // highConf = BM25 found keyword matches: tighter budget, stitch ±1 for boundary safety.
      const { idxs: rawIdxs, lowConf: isLowConf } = (function() {
        const r1 = _bm25Select(chunks, query, findBudget.findChars);
        if (r1.lowConf) return r1;
        // high-confidence: re-run with tighter budget for token savings
        const r2 = _bm25Select(chunks, query, Math.min(findBudget.findChars, Math.max(3500, Math.floor(findBudget.findChars * 0.65))));
        return { idxs: r2.idxs, lowConf: false };
      }());
      const stitchedSet = new Set(rawIdxs);
      if (!isLowConf) {
        rawIdxs.forEach(function(i) {
          if (i > 0) stitchedSet.add(i - 1);
          if (i < chunks.length - 1) stitchedSet.add(i + 1);
        });
      }
      // lowConf: cap at 60 chunks (wide sweep); highConf: cap at 40
      const hardCap = isLowConf ? findBudget.findCap : Math.min(findBudget.findCap, 40);
      const selected = Array.from(stitchedSet).sort(function(a, b) { return a - b; }).slice(0, hardCap);

      // bm25Only: sidebar AUTO_FIND path — skip LLM entirely, highlight BM25 top results directly
      if (bm25Only) {
        rawIdxs.slice(0, 12).forEach(function(i) { sendChunk(i, 2); });
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'FIND_DONE', searchId }).catch(() => {});
        return;
      }

      const { apiKey, model, provider } = await getConfig();
      if (!apiKey) {
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'FIND_DONE', searchId }).catch(() => {});
        return;
      }
      const snippetBlock = selected.map(function(i) {
        return '[' + i + '] ' + (chunks[i] ? chunks[i].text : '');
      }).join('\n');
      // mode: 1=strict(scores 3-4), 2=related(2-4), 3=general(1-4), 4=broad(1-4)
      const modeInstructions = [
        '',
        'Return only chunks with score 3 or 4. Exact or very close semantic match only.',
        'Return chunks semantically related to the query. Score 2-4.',
        'Return chunks generally related to the query topic. Score 1-4.',
        'Return any chunk broadly related to the query. Score 1-4.',
      ];
      const safeMode = Math.max(1, Math.min(4, mode || 2));
      // lowConf: BM25 found no keyword match — query and page likely differ in vocabulary or language.
      // Instruct LLM to reason about meaning, not surface words.
      const semanticNote = isLowConf
        ? 'IMPORTANT: The query and page content may use different vocabulary or different languages. ' +
          'Match by MEANING and CONCEPT, not by literal words. Cross-language matching is expected.\n\n'
        : '';
      const prompt =
        semanticNote +
        'Find numbered text chunks that match the user query.\n' +
        modeInstructions[safeMode] + '\n\n' +
        'Output one JSON object per line (NDJSON). No other text:\n' +
        '{"chunkIdx":N,"score":4}\n' +
        'Scores: 4=exact/equivalent match, 3=closely related, 2=generally related, 1=broad.\n' +
        'Max 12 results. chunkIdx must be one of the numbers in the list below.\n\n' +
        'User query: ' + query + '\n\nChunks:\n' + snippetBlock;
      let buffer = '';
      try {
        await streamProviderResponse(provider, apiKey, model, {
          system: 'Output NDJSON only. Each line: {"chunkIdx":N,"score":M}. No markdown, no extra text.',
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
              if (obj && typeof obj.chunkIdx === 'number' && typeof obj.score === 'number') {
                sendChunk(obj.chunkIdx, obj.score);
              }
            } catch(_) {}
          }
        });
        const rem = buffer.trim();
        if (rem) { try { const obj = JSON.parse(rem); if (obj && typeof obj.chunkIdx === 'number') sendChunk(obj.chunkIdx, obj.score || 2); } catch(_) {} }
      } catch(e) {
        ERR('FIND_ON_PAGE stream error:', e.message);
      }
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'FIND_DONE', searchId }).catch(() => {});
    })();
    return false; // respond() already called synchronously
  }

  // ── Web search: raw DDG results only (no LLM summary) ──────────────────
  if (msg.type === 'WEB_SEARCH_RAW') {
    (async () => {
      const { query } = msg.payload;
      try {
        const results = await scrapeDDG(query);
        if (!results.length) { respond({ error: 'No results from DuckDuckGo.' }); return; }
        respond({ results, query });
      } catch(e) {
        ERR('WEB_SEARCH_RAW error:', e.message);
        respond({ error: e.message });
      }
    })();
    return true;
  }

  // ── Extract search keywords via LLM (non-streaming) ──────────────────────
  if (msg.type === 'SEARCH_KEYWORDS') {
    (async () => {
      const { apiKey, model, provider } = await getConfig();
      if (!apiKey) { respond({ error: 'No API key.' }); return; }
      const { prompt, context } = msg.payload;
      const userMsg = context
        ? 'Page context: ' + context + '\n\nUser question: ' + prompt
        : 'User question: ' + prompt;
      const systemPrompt = 'Output only a comma-separated list of 3-6 precise English search keywords for the user question. No explanation, no extra text.';
      try {
        let keywords = '';
        if (provider === 'claude') {
          const data = await requestAnthropicJson(apiKey, {
            model, max_tokens: 60,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMsg }],
          });
          keywords = ((data.content || []).map(p => p.text || '').join('')).trim();
        } else {
          const data = await requestOpenAICompatibleJson(provider, apiKey, {
            model, stream: false, max_completion_tokens: 60,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMsg },
            ],
          });
          keywords = (data.choices[0].message.content || '').trim();
        }
        respond({ keywords });
      } catch(e) {
        ERR('SEARCH_KEYWORDS error:', e.message);
        respond({ error: e.message });
      }
    })();
    return true;
  }

  // ── Web search with LLM-cited summary ──────────────────────────────────
  if (msg.type === 'WEB_SEARCH') {
    (async () => {
      const { apiKey, model, provider } = await getConfig();
      if (!apiKey) { respond({ error: 'No LLM API key set.' }); return; }
      const { query } = msg.payload;
      try {
        const results = await scrapeDDG(query);
        if (!results.length) { respond({ error: 'No results from DuckDuckGo.' }); return; }

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
    if (tab && tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_FIND_PANEL' }).catch(e => ERR('find-on-page sendMessage', e));
    }
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
        .then(() => {
          spOpenTabs.add(tab.id);
          chrome.storage.session.set({ cwaSpOpen: true, cwaGoChat: { t: Date.now() } });
        })
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
      traceAttributions: payload.traceAttributions || null,
      searchSources: payload.searchSources || null },
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
