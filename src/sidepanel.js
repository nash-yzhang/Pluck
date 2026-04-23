// sidepanel.js  Pluck v2.0
'use strict';

// Track sidebar open state so popup.js toggle and background.js can read it.
chrome.storage.session.set({ cwaSpOpen: true });
window.addEventListener('pagehide', function() {
  chrome.storage.session.set({ cwaSpOpen: false });
});

const LOG = (...a) => console.log('%c[CWA-SP]', 'color:#4dfa9a;font-weight:bold', ...a);
const ERR = (...a) => console.error('[CWA-SP]', ...a);

const HISTORY_KEY  = 'cwaHistory';
const CTX_STORE_KEY = 'cwaCtxStore';
const PAGE_SIZE    = 10;

const DEFAULT_PRESETS = {
  sum:       'Summarize the selected text into bare key points. No formatting, no filler. Match the language of the user prompt; if absent, match the selected text\'s language.',
  extract:   'Extract all key data points, numbers, and facts from the selected text into a minimal list. No commentary.',
  explain:   'Explain what this page or selected content is about in plain language. Be concise.',
  translate: 'Detect the language of the selected text and translate it to English. If the user specifies a target language in their prompt, translate there instead. Output translation only.',
  rephrase:  'Give 3–5 alternative phrasings of the selected text. Cover: simpler, more formal, more concise, casual. Label each variant with one word. No explanations.',
  grammar:   'List only the grammatical errors in the selected text. Format each as: [original] → [correction]. No other output.',
  keywords:  'Generate precise search keyword candidates from the selected text to expand information retrieval. Include exact phrases, synonyms, and related terms. Compact list only.',
  find:      'The user\'s prompt is a fuzzy description of something. Search the selected text for matching information. Return direct quotes only so the user can Ctrl+F to locate them. If nothing matches, output: not found.',
  define:    'Define the selected term or concept in 1–3 sentences. Precise and direct, no padding.',
  outline:   'Convert the selected content into a hierarchical outline. Minimal words per node. No prose.',
};

const S = {
  view:              'list',
  currentEntry:      null,
  currentUrl:        '',
  currentTitle:      '',
  allEntries:        [],
  displayedCount:    PAGE_SIZE,
  provider:          'openai',
  model:             'gpt-4o-mini',
  displayDays:       7,
  chatBusy:          false,
  pendingSelections: [],   // legacy; now ctx references by ID
  ctxStore:          {},   // { [ctxId]: { text, url, title, createdAt } }
  presets:           {},   // from config.json
  hintIdx:           -1,   // keyboard nav index in hint dropdown
  hintItems:         [],   // current hint item elements
  selectedUrls:           new Set(), // currently selected entry URLs
  lastCtxSels:            [],   // last-used context selections (persisted across Q&As)
  suppressHistoryRender:  false, // true while TRACE_SAVE is in flight
  autoCtxId:         null,  // ID of auto-captured full-page ctx for current URL
  ctxUrlToPage:      {},   // { [url]: pageNum } for sequential IDs
  ctxNextPageNum:    1,    // next global page number
};

const $  = id => document.getElementById(id);
const el = {
  viewList:      $('view-list'),
  viewChat:      $('view-chat'),
  currentDomain: $('current-domain-el'),
  currentTitle:  $('current-title-el'),
  currentBar:    $('current-bar'),
  entriesList:   $('entries-list'),
  loadMore:      $('load-more'),
  chatBack:      $('chat-back'),
  chatDomain:    $('chat-domain-el'),
  chatPath:      $('chat-path-el'),
  chatCtxBar:    $('chat-ctx-bar'),
  chatCtxItems:  $('chat-ctx-items'),
  chatMessages:  $('chat-messages'),
  chatInp:       $('chat-inp'),
  chatInpMirror: $('chat-inp-mirror'),
  chatSend:      $('chat-send'),
  atHint:        $('at-hint'),
  ctxSearchPanel: $('ctx-search-panel'),
  ctxSearchInp:   $('ctx-search-inp'),
  ctxSearchRes:   $('ctx-search-results'),
  chatSbarSlot:  $('chat-sbar-slot'),
  modelBadge:    $('model-badge'),
  gearBtn:       $('gear-btn'),
  gSdot:         $('g-sdot'),
  gStxt:         $('g-stxt'),
  delConfirm:    $('del-confirm'),
  delConfirmMsg: $('del-confirm-n'),
  delConfirmOk:  $('del-confirm-ok'),
  delConfirmCancel: $('del-confirm-cancel'),
};

//  Bootstrap 
async function init() {
  // REQUIRED: Check if data directory is set
  const hasDirHandle = await (async () => {
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
  })();

  if (!hasDirHandle) {
    document.body.innerHTML = `
      <div style="
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        height:100%; background:#0c0c0e; padding:20px; text-align:center;
        font-family: 'Cascadia Code', monospace; color:#d0d0d8;
      ">
        <h2 style="font-size:14px;color:#4dfa9a;margin-bottom:16px">SETUP REQUIRED</h2>
        <p style="font-size:12px;color:#9090a0;max-width:280px;line-height:1.7;margin-bottom:24px">
          Please select a folder where your conversation data will be saved.
        </p>
        <button id="sp-open-settings" style="
          background:#111;border:1px solid #4dfa9a;color:#4dfa9a;
          padding:10px 20px;font-size:11px;cursor:pointer;border-radius:3px;
          font-family:inherit;letter-spacing:1px;transition:all .15s;
        ">OPEN SETTINGS</button>
        <p style="font-size:10px;color:#555;margin-top:20px">
          File System Access API<br>Your folder, your data control
        </p>
      </div>
    `;
    document.getElementById('sp-open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    return;
  }

  // Mark sidebar as open so background can toggle it
  chrome.storage.session.set({ cwaSpOpen: true });
  window.addEventListener('pagehide', () => chrome.storage.session.set({ cwaSpOpen: false }));

  const sync = await chromeSGet(['cwaApiKey', 'cwaApiKeys', 'cwaProvider', 'cwaModel', 'cwaDisplayDays', 'userSkills', 'cwaPresets']);
  const normalized = cwaNormalizeSettings({
    provider: sync.cwaProvider,
    model: sync.cwaModel,
    apiKeys: sync.cwaApiKeys,
    apiKey: sync.cwaApiKey,
  });
  S.provider    = normalized.provider;
  S.model       = normalized.model;
  S.displayDays = sync.cwaDisplayDays || 7;
  syncModelBadges();

  // Merge: built-in defaults → user-edited presets → user skills
  S.presets = Object.assign({}, DEFAULT_PRESETS, sync.cwaPresets || {}, sync.userSkills || {});
  LOG('presets loaded:', Object.keys(S.presets).join(', '));

  // Clone status bar into chat view
  const sbarClone = document.querySelector('.g-sbar').cloneNode(true);
  sbarClone.id = 'chat-sbar-clone';
  el.chatSbarSlot.replaceWith(sbarClone);

  // Wire events
  el.modelBadge.addEventListener('click', cycleModel);
  el.gearBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  el.currentBar.addEventListener('click', navigateToCurrent);
  el.loadMore.addEventListener('click', onLoadMore);
  el.chatBack.addEventListener('click', backToList);

  // Delete confirm overlay
  el.delConfirmOk.addEventListener('click', () => executeDelete());
  el.delConfirmCancel.addEventListener('click', () => hideDelConfirm());
  el.delConfirm.addEventListener('click', e => { if (e.target === el.delConfirm) hideDelConfirm(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.delConfirm.classList.contains('show')) { hideDelConfirm(); return; }
    if (e.key === 'Enter'  && el.delConfirm.classList.contains('show')) { executeDelete(); return; }
    // Delete key on list view
    if (e.key === 'Delete' && S.view === 'list' && !el.delConfirm.classList.contains('show')) {
      if (S.selectedUrls.size) { e.preventDefault(); showDelConfirm(); }
    }
    // Req 3: Alt+S or Alt+` — close/toggle sidebar even when sidebar is focused
    const isToggle = e.altKey && !e.ctrlKey && !e.shiftKey &&
                     (e.code === 'KeyS' || e.code === 'Backquote');
    if (isToggle) {
      e.preventDefault();
      LOG('DEBUG sidepanel keydown toggle: e.code=', e.code, 'e.key=', e.key,
          '| sending TOGGLE_SIDE_PANEL (⚠ same broken path — background cannot call sidePanel.open() from onMessage)');
      chrome.runtime.sendMessage({ type: 'TOGGLE_SIDE_PANEL' });
      return;
    }
    // Req 4: Alt+1 — toggle visual-select mode on the active page tab
    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'Digit1') {
      e.preventDefault();
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_VISUAL_MODE' }).catch(() => {});
      });
      return;
    }
  });

  el.chatSend.addEventListener('click', sendChatMessage);
  el.chatInp.addEventListener('keydown', e => {
    // hint dropdown keyboard nav
    if (el.atHint.style.display !== 'none' && S.hintItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        S.hintIdx = Math.min(S.hintIdx + 1, S.hintItems.length - 1);
        updateHintActive();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        S.hintIdx = Math.max(S.hintIdx - 1, 0);
        updateHintActive();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && S.hintIdx >= 0)) {
        e.preventDefault();
        const active = S.hintItems[S.hintIdx >= 0 ? S.hintIdx : 0];
        if (active) active.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return;
      }
      if (e.key === 'Escape') { hideAtHint(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); return; }
    if (e.key === 'Escape') hideAtHint();
  });
  el.chatInp.addEventListener('input', () => { autoResizeTextarea(); updateMirror(); checkInputHint(); });
  document.getElementById('chat-sbar-clone').querySelector('.model-badge').addEventListener('click', cycleModel);
  document.getElementById('chat-sbar-clone').querySelector('.gear-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Load context store
  const ctxData = await new Promise(r => chrome.storage.local.get(CTX_STORE_KEY, r));
  S.ctxStore = ctxData[CTX_STORE_KEY] || {};
  LOG('ctxStore loaded:', Object.keys(S.ctxStore).length, 'items');
  initCtxIdCounters();

  renderPresetBar();
  await refreshCurrentTab();

  // Tab events
  chrome.tabs.onActivated.addListener(async info => {
    const tab = await chrome.tabs.get(info.tabId).catch(() => null);
    if (tab) await onTabNavigated(tab.url || '', tab.title || '');
  });
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && active.id === tabId) await onTabNavigated(active.url || '', active.title || '');
  });

  // Storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HISTORY_KEY]) onHistoryChanged(changes[HISTORY_KEY].newValue);
    if (area === 'local' && changes[CTX_STORE_KEY]) S.ctxStore = changes[CTX_STORE_KEY].newValue || {};
    if (area === 'session') {
      if (changes.cwaSelMsg)    onSelMsg(changes.cwaSelMsg.newValue);
      if (changes.cwaGoChat)    navigateToCurrent(); // hotkey  jump to chat view
      if (changes.cwaGoCapture) { LOG('DEBUG storage.onChanged cwaGoCapture fired:', JSON.stringify(changes.cwaGoCapture.newValue)); onGoCapture(changes.cwaGoCapture.newValue); }
    }
    if (area === 'sync') {
      if (changes.cwaProvider || changes.cwaModel || changes.cwaApiKeys || changes.cwaApiKey) {
        chrome.storage.sync.get(['cwaApiKey', 'cwaApiKeys', 'cwaProvider', 'cwaModel'], function(syncSettings) {
          var normalized = cwaNormalizeSettings({
            provider: syncSettings.cwaProvider,
            model: syncSettings.cwaModel,
            apiKeys: syncSettings.cwaApiKeys,
            apiKey: syncSettings.cwaApiKey,
          });
          S.provider = normalized.provider;
          S.model = normalized.model;
          syncModelBadges();
        });
      }
      if (changes.cwaDisplayDays) { S.displayDays = changes.cwaDisplayDays.newValue || 7; refreshList(); }
      if (changes.cwaPresets) {
        S.presets = Object.assign({}, DEFAULT_PRESETS, changes.cwaPresets.newValue || {});
        LOG('presets updated from sync:', Object.keys(S.presets).join(', '));
        // Sync to pluck_data.json if dir handle is available
        syncToDir().catch(() => {});
      }
    }
  });

  // Race-condition fix: background may have set cwaGoCapture BEFORE this listener was registered
  // (common when sidepanel was just opened by the Alt+1 command). Replay any pending keys.
  chrome.storage.session.get(['cwaGoCapture', 'cwaGoChat', 'cwaSelMsg'], pending => {
    LOG('DEBUG init: checking pending session keys on startup',
        'cwaGoCapture=', !!pending.cwaGoCapture,
        'cwaGoChat=', !!pending.cwaGoChat,
        'cwaSelMsg=', !!pending.cwaSelMsg);
    if (pending.cwaGoCapture) {
      LOG('DEBUG init: replaying missed cwaGoCapture', JSON.stringify(pending.cwaGoCapture));
      onGoCapture(pending.cwaGoCapture);
    }
    if (pending.cwaGoChat) navigateToCurrent();
    if (pending.cwaSelMsg) onSelMsg(pending.cwaSelMsg);
  });

  LOG('init');
}

//  Preset bar (hidden — presets activated via /cmd inline text) 
function renderPresetBar() { /* no-op: presets now via /cmd in input */ }

//  Textarea syntax highlight mirror 
function updateMirror() {
  const text = el.chatInp.value;
  if (!text) {
    el.chatInpMirror.innerHTML = '';
    el.chatInp.classList.add('no-highlight');
    return;
  }
  // Tokenize: /word or /word-with-hyphens = cmd-token, @ctxId = ctx-token
  let html = '';
  let hasToken = false;
  const parts = text.split(/((?:^|(?<=\s))\/[\w-]+|@(?:[a-f0-9]{6}|\d+\.\d+)\b)/g);
  parts.forEach(part => {
    if (!part) return;
    if (/^\/[\w-]+$/.test(part)) {
      html += '<span class="cmd-token">' + esc(part) + '</span>';
      hasToken = true;
    } else if (/^@(?:[a-f0-9]{6}|\d+\.\d+)$/.test(part)) {
      html += '<span class="ctx-token">' + esc(part) + '</span>';
      hasToken = true;
    } else {
      html += '<span style="color:var(--fg)">' + esc(part) + '</span>';
    }
  });
  if (hasToken) {
    el.chatInpMirror.innerHTML = html;
    el.chatInp.classList.remove('no-highlight');
  } else {
    // No special tokens: let the textarea render its own text, keep mirror empty
    el.chatInpMirror.innerHTML = '';
    el.chatInp.classList.add('no-highlight');
  }
}

//  Chrome command: Alt+1 from any page (including PDF) 
async function onGoCapture(msg) {
  LOG('DEBUG onGoCapture: msg=', JSON.stringify(msg));
  if (!msg) { LOG('DEBUG onGoCapture: msg is null/undefined, aborting'); return; }
  navigateToCurrent(); // switch to chat view

  const isPdf = /\.pdf(\?.*)?$/i.test(msg.url) ||
                msg.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
  LOG('DEBUG onGoCapture: url=', msg.url, 'isPdf=', isPdf);
  if (isPdf) {
    // PDF: extract text immediately and insert as context
    try {
      const pdfUrl = msg.url.startsWith('chrome-extension://')
        ? (new URL(msg.url).searchParams.get('file') || new URL(msg.url).searchParams.get('url') || msg.url)
        : msg.url;
      LOG('DEBUG onGoCapture PDF: resolved pdfUrl=', pdfUrl);
      const pageText = await extractPdfText(pdfUrl);
      LOG('DEBUG onGoCapture PDF: extracted text length=', pageText ? pageText.length : 0);
      if (pageText) {
        const id = nextCtxId(msg.url || S.currentUrl);
        S.ctxStore[id] = { text: pageText, url: msg.url, title: 'PDF', createdAt: Date.now(), auto: true };
        S.autoCtxId = id;
        chrome.storage.local.get(CTX_STORE_KEY, d => {
          const store = d[CTX_STORE_KEY] || {};
          store[id] = S.ctxStore[id];
          chrome.storage.local.set({ [CTX_STORE_KEY]: store });
        });
        const inp = el.chatInp;
        const atRef = '@' + id + ' ';
        inp.value = inp.value ? inp.value.trimEnd() + ' ' + atRef : atRef;
        inp.selectionStart = inp.selectionEnd = inp.value.length;
        updateMirror();
        inp.focus();
      }
    } catch(e) { ERR('PDF capture failed', e.message, e); }
  } else {
    // Normal page: tell content.js to toggle visual-select mode
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    LOG('DEBUG onGoCapture normal page: sending TOGGLE_VISUAL_MODE to tab=', tab && tab.id);
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_VISUAL_MODE' }).catch(e => ERR('DEBUG TOGGLE_VISUAL_MODE sendMessage failed:', e.message));
  }
}

function initCtxIdCounters() {
  S.ctxUrlToPage   = {};
  S.ctxNextPageNum = 1;
  for (const [id, ctx] of Object.entries(S.ctxStore)) {
    const m = id.match(/^(\d+)\.\d+$/);
    if (m) {
      const page = parseInt(m[1], 10);
      if (page >= S.ctxNextPageNum) S.ctxNextPageNum = page + 1;
      if (ctx.url && !S.ctxUrlToPage[ctx.url]) S.ctxUrlToPage[ctx.url] = page;
    }
  }
}

function nextCtxId(url) {
  if (!S.ctxUrlToPage[url]) {
    S.ctxUrlToPage[url] = S.ctxNextPageNum++;
  }
  const pageNum = S.ctxUrlToPage[url];
  const subIdx  = Object.values(S.ctxStore).filter(c => c.url === url).length;
  return pageNum + '.' + subIdx;
}

// Auto-capture full page/PDF text as context X.0 when opening chat
async function autoCapturePageCtx() {
  const url = S.currentUrl;
  LOG('DEBUG autoCapturePageCtx: url=', url);
  if (!url || url.startsWith('chrome')) { LOG('DEBUG autoCapturePageCtx: skipping chrome:// or empty url'); return; }
  // Already auto-captured for this URL in this session
  if (S.autoCtxId && S.ctxStore[S.autoCtxId] && S.ctxStore[S.autoCtxId].url === url) { LOG('DEBUG autoCapturePageCtx: already captured, skip'); return; }
  S.autoCtxId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    const tabUrl = tab.url || '';
    const isPdf  = /\.pdf(\?.*)?$/i.test(tabUrl) ||
                   tabUrl.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
    LOG('DEBUG autoCapturePageCtx: tabUrl=', tabUrl, 'isPdf=', isPdf);
    let pageText = '';
    if (isPdf) {
      try {
        const pdfUrl = tabUrl.startsWith('chrome-extension://')
          ? (new URL(tabUrl).searchParams.get('file') || new URL(tabUrl).searchParams.get('url') || tabUrl)
          : tabUrl;
        LOG('DEBUG autoCapturePageCtx PDF: resolved pdfUrl=', pdfUrl);
        pageText = await extractPdfText(pdfUrl);
        LOG('DEBUG autoCapturePageCtx PDF: text length=', pageText.length);
      } catch(e) { ERR('PDF auto-capture failed', e.message, e); return; }
    } else {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => (document.body && document.body.innerText || '').trim().slice(0, 8000),
        });
        pageText = (results && results[0] && results[0].result) || '';
      } catch(e) { return; }
    }
    if (!pageText) return;
    const id = nextCtxId(url);
    S.ctxStore[id] = { text: pageText, url, title: S.currentTitle || url, createdAt: Date.now(), auto: true };
    S.autoCtxId = id;
    chrome.storage.local.get(CTX_STORE_KEY, d => {
      const store = d[CTX_STORE_KEY] || {};
      store[id] = S.ctxStore[id];
      chrome.storage.local.set({ [CTX_STORE_KEY]: store });
    });
    // Insert @id into chat input only if input is empty
    const inp = el.chatInp;
    if (!inp.value.trim()) {
      inp.value = '@' + id + ' ';
      inp.selectionStart = inp.selectionEnd = inp.value.length;
      updateMirror();
    }
    LOG('auto-captured ctx:', id, 'chars:', pageText.length);
  } catch(e) { ERR('auto-capture failed', e); }
}

//  Selection messages from content.js 
function onSelMsg(msg) {
  if (!msg) return;
  if (msg.type === 'SEL_NEW') {
    const { text, url, title, elementPick } = msg.payload;
    // Cancel auto-captured page ctx when user explicitly element-picks
    if (elementPick && S.autoCtxId) {
      const autoUrl = S.ctxStore[S.autoCtxId] && S.ctxStore[S.autoCtxId].url;
      if (autoUrl === (url || S.currentUrl)) {
        const autoId = S.autoCtxId;
        delete S.ctxStore[autoId];
        S.autoCtxId = null;
        chrome.storage.local.get(CTX_STORE_KEY, d => {
          const store = d[CTX_STORE_KEY] || {};
          delete store[autoId];
          chrome.storage.local.set({ [CTX_STORE_KEY]: store });
        });
        const inp = el.chatInp;
        const atRef = '@' + autoId;
        if (inp.value.includes(atRef)) {
          inp.value = inp.value.split(atRef).join('').replace(/\s{2,}/g, ' ').trim();
          updateMirror();
        }
      }
    }
    const id = nextCtxId(url || S.currentUrl);
    S.ctxStore[id] = { text, url: url || S.currentUrl, title: title || S.currentTitle, createdAt: Date.now() };
    // Persist
    chrome.storage.local.get(CTX_STORE_KEY, d => {
      const store = d[CTX_STORE_KEY] || {};
      store[id] = S.ctxStore[id];
      chrome.storage.local.set({ [CTX_STORE_KEY]: store });
    });
    // Insert @id into chat input
    const inp = el.chatInp;
    const atRef = '@' + id + ' ';
    inp.value = inp.value ? inp.value.trimEnd() + ' ' + atRef : atRef;
    inp.selectionStart = inp.selectionEnd = inp.value.length;
    updateMirror();
    if (S.view === 'chat') inp.focus();
  }
  // Legacy relay support
  if (msg.type === 'SEL_SET')    S.pendingSelections = [msg.payload];
  if (msg.type === 'SEL_APPEND') S.pendingSelections.push(msg.payload);
  if (S.view === 'chat') renderCtxBar();
}

function renderCtxBar() {
  const ctx = S.pendingSelections.filter(Boolean);
  if (!ctx.length) { el.chatCtxBar.style.display = 'none'; return; }
  el.chatCtxBar.style.display = 'flex';
  el.chatCtxItems.innerHTML = ctx.map((c, i) =>
    '<span class="ctx-badge" title="' + escAttr(c.text) + '">' +
    '<span class="ctx-idx">@' + (i+1) + '</span>' +
    esc(c.text.slice(0, 20)) + (c.text.length > 20 ? '\u2026' : '') +
    '</span>'
  ).join('');
}

//  Hint dropdown helpers 
function updateHintActive() {
  S.hintItems.forEach((item, i) => {
    item.classList.toggle('active', i === S.hintIdx);
    if (i === S.hintIdx) item.scrollIntoView({ block: 'nearest' });
  });
}

function showHintItems(itemEls) {
  S.hintIdx   = -1;
  S.hintItems = itemEls;
  el.atHint.style.display = 'block';
}

//  @mention + /slash hint (shared dropdown) 
function checkInputHint() {
  const val    = el.chatInp.value;
  const pos    = el.chatInp.selectionStart;
  const before = val.slice(0, pos);

  // /slash — preset commands
  const slashM = before.match(/(?:^|\s)(\/[\w-]*)$/);
  if (slashM) {
    const word    = slashM[1];          // includes leading /
    const partial = word.slice(1).toLowerCase();
    const hits    = Object.keys(S.presets).filter(k => k.startsWith(partial));
    if (hits.length) {
      // clear existing hint content (leave search panel if present)
      el.atHint.querySelectorAll('.at-hint-item').forEach(n => n.remove());
      const frag = document.createDocumentFragment();
      hits.forEach(k => {
        const item = document.createElement('div');
        item.className = 'at-hint-item';
        item.dataset.slash = k;
        item.innerHTML =
          '<span class="at-hint-idx" style="color:var(--accent)">/</span>' +
          '<span class="at-hint-text"><b>' + esc(k) + '</b> \u2014 ' + esc(S.presets[k].slice(0, 52)) + '\u2026</span>';
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          // Replace /partial with /k in the input
          const matchStart = before.length - word.length;
          el.chatInp.value = val.slice(0, matchStart) + '/' + k + ' ' + val.slice(pos);
          const newPos = matchStart + k.length + 2;
          el.chatInp.selectionStart = el.chatInp.selectionEnd = newPos;
          updateMirror();
          hideAtHint();
          el.chatInp.focus();
        });
        frag.appendChild(item);
      });
      el.atHint.insertBefore(frag, el.atHint.firstChild);
      el.ctxSearchPanel.style.display = 'none';
      showHintItems([...el.atHint.querySelectorAll('.at-hint-item')]);
      return;
    }
  }

  // @ctxId — context references (own URL first, then others)
  const atM = before.match(/@([\w.]*)$/);
  if (atM) {
    const partial = atM[1].toLowerCase();
    const allIds  = Object.keys(S.ctxStore);
    const ownIds  = allIds.filter(id => S.ctxStore[id].url === S.currentUrl);
    const otherIds= allIds.filter(id => S.ctxStore[id].url !== S.currentUrl);
    const sortedIds = [...ownIds, ...otherIds];
    const filtered = sortedIds.filter(id => !partial || id.startsWith(partial));
    const top = filtered.slice(0, 8);

    if (top.length || partial === '') {
      el.atHint.querySelectorAll('.at-hint-item').forEach(n => n.remove());
      const frag = document.createDocumentFragment();
      top.forEach(id => {
        const ctx  = S.ctxStore[id];
        const item = document.createElement('div');
        item.className = 'at-hint-item';
        item.dataset.ctxId = id;
        const isOwn = ctx.url === S.currentUrl;
        const preview = ctx.text.slice(0, 40) + (ctx.text.length > 40 ? '\u2026' : '');
        const title = ctx.title ? esc(ctx.title.slice(0, 30)) + (ctx.title.length > 30 ? '…' : '') : 'no title';
        item.innerHTML =
          '<span class="at-hint-idx" style="color:' + (isOwn ? 'var(--accent)' : '#8888ff') + '">@' + id + '</span>' +
          '<span class="at-hint-text">' + title + ' <span style="color:var(--fg-dim)">—</span> ' + esc(preview) + '</span>';
        // Hover: expand preview
        item.addEventListener('mouseover', () => {
          const expandedPreview = ctx.text.slice(0, 120) + (ctx.text.length > 120 ? '\u2026' : '');
          item.querySelector('.at-hint-text').innerHTML = title + ' <span style="color:var(--fg-dim)">—</span> ' + esc(expandedPreview);
        });
        item.addEventListener('mouseleave', () => {
          item.querySelector('.at-hint-text').innerHTML = title + ' <span style="color:var(--fg-dim)">—</span> ' + esc(preview);
        });
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          const matchLen = atM[0].length;
          const replacement = '@' + id + ' ';
          el.chatInp.value = before.slice(0, before.length - matchLen) + replacement + val.slice(pos);
          const newPos = before.length - matchLen + replacement.length;
          el.chatInp.selectionStart = el.chatInp.selectionEnd = newPos;
          updateMirror();
          hideAtHint();
          el.chatInp.focus();
        });
        frag.appendChild(item);
      });
      el.atHint.insertBefore(frag, el.atHint.firstChild);

      // Show cross-URL search button if there are more contexts from other URLs
      if (otherIds.length > 0 || top.length === 0) {
        el.ctxSearchPanel.style.display = 'block';
        el.ctxSearchInp.value = '';
        el.ctxSearchRes.innerHTML = '';
        el.ctxSearchInp.oninput = () => runCtxSearch(atM, val, pos);
        el.ctxSearchInp.onkeydown = e => {
          if (e.key === 'Enter') { e.preventDefault(); commitCtxSearch(atM, val, pos); }
          if (e.key === 'Escape') hideAtHint();
        };
      } else {
        el.ctxSearchPanel.style.display = 'none';
      }
      showHintItems([...el.atHint.querySelectorAll('.at-hint-item')]);
      return;
    }
  }

  hideAtHint();
}

function runCtxSearch(atM, val, pos) {
  const query = el.ctxSearchInp.value.toLowerCase().trim();
  if (!query) { el.ctxSearchRes.innerHTML = ''; return; }
  const words = query.split(/\s+/);
  const results = Object.entries(S.ctxStore)
    .filter(([, ctx]) => words.every(w => ctx.text.toLowerCase().includes(w)))
    .slice(0, 5);
  el.ctxSearchRes.innerHTML = '';
  if (!results.length) {
    el.ctxSearchRes.innerHTML = '<div style="font-size:10px;color:var(--fg3);padding:3px 8px">no matches</div>';
    return;
  }
  S._searchResults = results;
  S._searchSel = 0;
  results.forEach(([id, ctx], i) => {
    const item = document.createElement('div');
    item.className = 'at-hint-item' + (i === 0 ? ' active' : '');
    item.dataset.ctxId = id;
    const preview = ctx.text.slice(0, 60) + (ctx.text.length > 60 ? '\u2026' : '');
    const title = ctx.title ? esc(ctx.title.slice(0, 30)) + (ctx.title.length > 30 ? '…' : '') : 'no title';
    item.innerHTML =
      '<span class="at-hint-idx" style="color:#8888ff">@' + id + '</span>' +
      '<span class="at-hint-text">' + title + ' <span style="color:var(--fg-dim)">—</span> ' + esc(preview) + '</span>';
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      insertCtxRef(id, atM, val, pos);
    });
    el.ctxSearchRes.appendChild(item);
  });
  el.ctxSearchInp.onkeydown = e => {
    if (e.key === 'ArrowDown') { S._searchSel = Math.min(S._searchSel + 1, results.length - 1); updateSearchActive(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp')   { S._searchSel = Math.max(S._searchSel - 1, 0); updateSearchActive(); e.preventDefault(); return; }
    if (e.key === 'Enter') { e.preventDefault(); insertCtxRef(results[S._searchSel][0], atM, val, pos); return; }
    if (e.key === 'Escape') hideAtHint();
  };
}

function updateSearchActive() {
  [...el.ctxSearchRes.querySelectorAll('.at-hint-item')].forEach((item, i) => {
    item.classList.toggle('active', i === S._searchSel);
  });
}

function insertCtxRef(id, atM, val, pos) {
  const before = val.slice(0, pos);
  const matchLen = atM ? atM[0].length : 0;
  const replacement = '@' + id + ' ';
  el.chatInp.value = before.slice(0, before.length - matchLen) + replacement + val.slice(pos);
  const newPos = before.length - matchLen + replacement.length;
  el.chatInp.selectionStart = el.chatInp.selectionEnd = newPos;
  updateMirror();
  hideAtHint();
  el.chatInp.focus();
}

function hideAtHint() {
  el.atHint.style.display = 'none';
  el.atHint.querySelectorAll('.at-hint-item').forEach(n => n.remove());
  el.ctxSearchPanel.style.display = 'none';
  S.hintIdx   = -1;
  S.hintItems = [];
}

// Resolve @ctxId refs and /cmd presets from input text
// Returns { cleanText, resolvedCtxs, presetInstruction }
function parseInput(rawText) {
  // Extract /cmd (first occurrence, anywhere in text)
  let presetInstruction = null;
  let textWithoutCmd = rawText;
  const cmdM = rawText.match(/(^|\s)\/([\w-]+)(\s|$)/);
  if (cmdM) {
    const key = cmdM[2];
    if (S.presets[key]) {
      presetInstruction = S.presets[key];
      textWithoutCmd = rawText.replace(cmdM[0], cmdM[1] || cmdM[3] ? ' ' : '').trim();
    }
  }

  // Resolve @ctxId references
  const resolvedCtxs = [];
  const cleanText = textWithoutCmd.replace(/@([a-f0-9]{6}|\d+\.\d+)\b/g, (match, id) => {
    const ctx = S.ctxStore[id];
    if (ctx) {
      if (!resolvedCtxs.find(x => x.id === id)) resolvedCtxs.push({ id, text: ctx.text, context: ctx.text });
      return ''; // remove from visible text to GPT (will be in context block)
    }
    return match;
  }).replace(/\s{2,}/g, ' ').trim();

  return { cleanText: cleanText || textWithoutCmd, resolvedCtxs, presetInstruction };
}

//  Tab helpers 
async function refreshCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { await refreshList(); return; }
  await onTabNavigated(tab.url || '', tab.title || '');
}

async function onTabNavigated(url, title) {
  S.currentUrl   = normalizeUrl(url);
  S.currentTitle = title;
  S.pendingSelections = [];
  S.autoCtxId = null;   // reset auto-ctx on URL change
  updateCurrentBar();

  const hist  = await loadHistory();
  const entry = hist.entries.find(e => e.url === S.currentUrl);

  if (S.view === 'chat') {
    if (!S.currentEntry) { backToList(); return; }
    if (S.currentEntry.url !== S.currentUrl) {
      if (entry) { openChatView(entry); } else { backToList(); return; }
      autoCapturePageCtx().catch(() => {});
    }
    return;
  }
  await refreshList(hist);
  if (entry) { openChatView(entry); autoCapturePageCtx().catch(() => {}); }
}

function onHistoryChanged(newHist) {
  if (!newHist) return;
  if (S.suppressHistoryRender) return; // TRACE_SAVE in flight — don't wipe DOM annotations
  if (S.view === 'list') { refreshList(newHist); return; }
  if (S.view === 'chat' && S.currentEntry) {
    const updated = (newHist.entries || []).find(e => e.url === S.currentEntry.url);
    if (updated) { S.currentEntry = updated; renderChatMessages(updated.content || []); }
  }
}

//  List view 
function showListView() {
  S.view = 'list';
  el.viewChat.style.display = 'none';
  el.viewList.style.display = 'flex';
  refreshList();
}

async function refreshList(hist) {
  if (!hist) hist = await loadHistory();
  const cutoff = Date.now() - S.displayDays * 86400000;
  S.allEntries = (hist.entries || [])
    .filter(e => e.timestamp >= cutoff)
    .sort((a, b) => b.timestamp - a.timestamp);
  S.displayedCount = PAGE_SIZE;
  renderEntries();
}

function renderEntries() {
  el.entriesList.innerHTML = '';
  const slice = S.allEntries.slice(0, S.displayedCount);

  if (!slice.length) {
    el.entriesList.innerHTML = '<div class="empty-msg">NO HISTORY<br><span style="font-size:10px">conversations appear after your first Q&A</span></div>';
    el.loadMore.style.display = 'none';
    return;
  }

  slice.forEach(entry => {
    const wrap = document.createElement('div');
    wrap.className = 'entry' + (entry.url === S.currentUrl ? ' current' : '')
                              + (S.selectedUrls.has(entry.url) ? ' selected' : '');

    const head = document.createElement('div');
    head.className = 'entry-head';
    const titleEl = document.createElement('div');
    titleEl.className = 'entry-title';
    titleEl.textContent = entry.title || entry.url;
    const timeEl = document.createElement('div');
    timeEl.className = 'entry-time';
    timeEl.textContent = relTime(entry.timestamp);
    const caret = document.createElement('span');
    caret.className = 'entry-caret';
    caret.textContent = '\u25b6';
    head.appendChild(titleEl);
    head.appendChild(timeEl);
    head.appendChild(caret);

    // Ctrl+click or Shift+click: toggle/range-select; plain click: deselect-all then open
    head.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation();
        if (S.selectedUrls.has(entry.url)) S.selectedUrls.delete(entry.url);
        else S.selectedUrls.add(entry.url);
        wrap.classList.toggle('selected', S.selectedUrls.has(entry.url));
        return;
      }
      if (e.shiftKey && S.selectedUrls.size > 0) {
        e.stopPropagation();
        // range: find last selected in slice, select everything between
        const lastIdx = slice.findIndex(en => S.selectedUrls.has(en.url));
        const thisIdx = slice.indexOf(entry);
        const lo = Math.min(lastIdx, thisIdx), hi = Math.max(lastIdx, thisIdx);
        slice.slice(lo, hi + 1).forEach(en => S.selectedUrls.add(en.url));
        renderEntries();
        return;
      }
      // Plain click — clear selection, then toggle expand
      if (S.selectedUrls.size) {
        S.selectedUrls.clear();
        renderEntries();
        return;
      }
    });

    // Double-click: switch to that tab or open new tab
    wrap.addEventListener('dblclick', e => {
      e.stopPropagation();
      chrome.tabs.query({}, tabs => {
        const existing = tabs.find(t => normalizeUrl(t.url || '') === entry.url);
        if (existing) {
          chrome.tabs.update(existing.id, { active: true });
          chrome.windows.update(existing.windowId, { focused: true });
        } else {
          chrome.tabs.create({ url: entry.url, active: true });
        }
      });
    });

    const body = document.createElement('div');
    body.className = 'entry-body';
    const inner = document.createElement('div');
    inner.className = 'entry-body-inner';

    const pairs = [];
    const msgs = entry.content || [];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user') {
        pairs.push({ q: msgs[i], a: msgs[i+1] || null });
        if (msgs[i+1]) i++;
      }
    }
    pairs.forEach(p => {
      const pairEl = document.createElement('div');
      pairEl.className = 'ep-pair';
      const tsEl = document.createElement('div');
      tsEl.className = 'ep-ts';
      tsEl.textContent = fmtTime(p.q.timestamp);
      const qEl = document.createElement('div');
      qEl.className = 'ep-q';
      qEl.textContent = p.q.message.slice(0, 120) + (p.q.message.length > 120 ? '...' : '');
      pairEl.appendChild(tsEl);
      pairEl.appendChild(qEl);
      if (p.a) {
        const aEl = document.createElement('div');
        aEl.className = 'ep-a';
        aEl.textContent = p.a.message.slice(0, 120) + (p.a.message.length > 120 ? '...' : '');
        pairEl.appendChild(aEl);
      }
      inner.appendChild(pairEl);
    });

    const openBtn = document.createElement('button');
    openBtn.className = 'entry-open-btn';
    openBtn.textContent = 'OPEN CONVERSATION \u2192';
    openBtn.addEventListener('click', e => { e.stopPropagation(); openChatView(entry); });

    body.appendChild(inner);
    body.appendChild(openBtn);

    // Expand/collapse on head click (only when not in Ctrl/Shift select mode)
    head.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (S.selectedUrls.size) return; // plain-click while selection active is handled above
      const isOpen = wrap.classList.toggle('open');
      if (isOpen && inner.children.length === 0 && pairs.length === 0) {
        inner.innerHTML = '<div style="font-size:10px;color:var(--fg3);padding:4px 0">No messages yet</div>';
      }
    });

    wrap.appendChild(head);
    wrap.appendChild(body);
    el.entriesList.appendChild(wrap);
  });

  el.loadMore.style.display = S.displayedCount < S.allEntries.length ? '' : 'none';
}

function onLoadMore() {
  S.displayedCount += PAGE_SIZE;
  renderEntries();
}

//  Delete helpers 
function showDelConfirm() {
  const n = S.selectedUrls.size;
  el.delConfirmMsg.textContent = n === 1
    ? '1 conversation'
    : n + ' conversations';
  el.delConfirm.classList.add('show');
}

function hideDelConfirm() {
  el.delConfirm.classList.remove('show');
}

async function executeDelete() {
  hideDelConfirm();
  const toDelete = new Set(S.selectedUrls);
  S.selectedUrls.clear();
  const hist = await loadHistory();
  hist.entries = (hist.entries || []).filter(e => !toDelete.has(e.url));
  await new Promise(r => chrome.storage.local.set({ [HISTORY_KEY]: hist }, r));
  await refreshList(hist);
  // Sync updated data to the JSON file if a dir handle is saved
  syncToDir().catch(() => {});
}

async function syncToDir() {
  // CRITICAL: Validate directory is set and accessible
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('pluck_idb', 2);
    req.onupgradeneeded = e => { const db = e.target.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(new Error('IndexedDB unavailable'));
  });
  
  const handle = await new Promise((res, rej) => {
    const tx  = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get('dirHandle');
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = () => rej(new Error('Directory handle not found'));
  });

  if (!handle) {
    ERR('⚠️ CRITICAL: No data directory set. Cannot sync history.');
    return;
  }

  try {
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      ERR('Permission denied for directory access');
      return;
    }

    // Safety: Verify we can access the directory (detect extension folder)
    try {
      await handle.getFileHandle('manifest.json');
      ERR('⚠️ SECURITY: Blocked attempt to write to extension folder!');
      return;
    } catch (e) {
      // Good: manifest.json doesn't exist, so this is NOT the extension folder
    }

    // Build snapshot matching options.js buildSnapshot format
    const local = await new Promise(r => chrome.storage.local.get(['cwaHistory', 'cwaCtxStore'], r));
    const sync  = await new Promise(r => chrome.storage.sync.get(['cwaProvider', 'cwaApiKeys', 'cwaModel', 'cwaDisplayDays', 'userSkills', 'cwaPresets'], r));
    const snapshot = {
      version:    2,
      exportedAt: new Date().toISOString(),
      history:    local.cwaHistory  || { version: 1, entries: [] },
      ctxStore:   local.cwaCtxStore || {},
      settings:   {
        provider: sync.cwaProvider,
        apiKeys: sync.cwaApiKeys,
        model: sync.cwaModel,
        displayDays: sync.cwaDisplayDays,
        userSkills: sync.userSkills,
        presets: sync.cwaPresets,
      },
    };

    const fh       = await handle.getFileHandle('pluck_data.json', { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(snapshot, null, 2));
    await writable.close();
    LOG('✓ synced to pluck_data.json');
  } catch (e) {
    ERR('syncToDir error:', e.message);
  }
}

function updateCurrentBar() {
  if (!S.currentUrl || S.currentUrl.startsWith('chrome')) {
    el.currentDomain.textContent = '';
    el.currentTitle.textContent  = 'browser page';
    return;
  }
  el.currentDomain.textContent = getDomain(S.currentUrl);
  el.currentTitle.textContent  = S.currentTitle || getPath(S.currentUrl) || S.currentUrl;
}

async function navigateToCurrent() {
  if (!S.currentUrl || S.currentUrl.startsWith('chrome')) return;
  const hist  = await loadHistory();
  const entry = hist.entries.find(e => e.url === S.currentUrl);
  openChatView(entry || { url: S.currentUrl, title: S.currentTitle, context: [], content: [] });
  autoCapturePageCtx().catch(() => {});
}

//  Chat view 
function openChatView(entry) {
  S.view         = 'chat';
  S.currentEntry = entry;
  document.body.className = '';

  el.viewList.style.display = 'none';
  el.viewChat.style.display = 'flex';

  el.chatDomain.textContent = getDomain(entry.url);
  el.chatPath.textContent   = getPath(entry.url) || entry.url;
  el.chatPath.title         = entry.url;

  renderCtxBar();
  renderChatMessages(entry.content || []);
  setTimeout(() => el.chatInp.focus(), 50);
}

function renderChatMessages(content) {
  el.chatMessages.innerHTML = '';
  if (!content.length) {
    el.chatMessages.innerHTML = '<div class="msg sys">NEW CONVERSATION \u2014 type below to start</div>';
    return;
  }
  let lastTsKey = null;
  for (let i = 0; i < content.length; i++) {
    const m = content[i];
    if (m.role === 'user') {
      const k = Math.floor(m.timestamp / 60000);
      if (k !== lastTsKey) {
        const ts = document.createElement('div');
        ts.className = 'msg-ts';
        ts.textContent = fmtTime(m.timestamp);
        el.chatMessages.appendChild(ts);
        lastTsKey = k;
      }
    }
    const msgDiv = appendMsgEl(m.role, m.message, false, m.contextRefs || null);
    // Restore saved trace annotations instead of showing TRACE button
    if (m.role === 'assistant' && m.traceAttributions && m.traceAttributions.length) {
      const traceBtn = msgDiv.querySelector('.trace-btn');
      if (traceBtn) traceBtn.remove();
      const savedSrcs = (m.contextRefs || []).map(r => ({
        text: r.text || r.context || '',
        url:  r.url   || '',
        title: r.title || '',
      }));
      renderTraceAnnotations(msgDiv, m.traceAttributions, savedSrcs);
      attachTraceButton(msgDiv, m.message, savedSrcs, m.traceAttributions);
    }
  }
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

//  appendMsgEl 
// role, text, streaming, contextRefs:[{text,context}]|null
function appendMsgEl(role, text, streaming, contextRefs) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const span = document.createElement('span');
  span.className = 'msg-content';
  if (role === 'assistant') span.innerHTML = streaming ? '' : renderMarkdown(text || '');
  else span.textContent = text || '';
  div.appendChild(span);
  div._content = span;
  div._originalText = text || '';
  if (streaming) div.classList.add('streaming');

  if (role === 'assistant' && contextRefs && contextRefs.length) {
    appendCtxFooter(div, contextRefs);
  }

  // Attach trace button to all non-streaming assistant messages
  if (role === 'assistant' && !streaming && text) {
    const savedSrcs = (contextRefs || []).map(r => ({
      text: r.text || r.context || '',
      url:  r.url   || '',
      title: r.title || '',
    }));
    attachTraceButton(div, text, savedSrcs);
  }

  el.chatMessages.appendChild(div);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return div;
}

function appendCtxFooter(msgDiv, refs) {
  const footer = document.createElement('div');
  footer.className = 'msg-ctx-footer';
  refs.forEach((ref, i) => {
    const tag = document.createElement('span');
    tag.className = 'ctx-ref-tag';
    tag.textContent = '@' + (ref.id || (i+1)) + ' ' + ref.text.slice(0, 18) + (ref.text.length > 18 ? '\u2026' : '');
    tag.title = 'Click to expand context';
    let expanded = false;
    let previewEl = null;
    tag.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        previewEl = document.createElement('div');
        previewEl.className = 'ctx-ref-preview';
        previewEl.textContent = ref.context || ref.text;
        footer.insertBefore(previewEl, tag.nextSibling);
        tag.style.borderColor = 'var(--accent)';
        tag.style.color = 'var(--accent)';
      } else {
        if (previewEl) { previewEl.remove(); previewEl = null; }
        tag.style.borderColor = '';
        tag.style.color = '';
      }
      el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    });
    footer.appendChild(tag);
  });
  msgDiv.appendChild(footer);
}

// ── Trace: post-hoc attribution ────────────────────────────────────────────
function attachTraceButton(msgDiv, reply, sources, priorAttributions) {
  const isRetrace = !!(priorAttributions && priorAttributions.length);
  const btn = document.createElement('button');
  btn.className = 'trace-btn';
  btn.textContent = isRetrace ? 'RE-TRACE' : 'TRACE';
  btn.title = isRetrace
    ? 'Re-run attribution with prior results as context'
    : 'Post-hoc source attribution via LLM';
  btn.addEventListener('click', async () => {
    const currentModel = S.model;  // capture model at click time
    btn.disabled = true;
    btn.textContent = 'TRACING\u2026';
    // If no sources were captured, fall back to current page text
    let activeSources = (sources && sources.length) ? sources : [];
    if (!activeSources.length) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id && !tab.url.startsWith('chrome://')) {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => (document.body && document.body.innerText || '').trim().slice(0, 4000),
          });
          const pageText = results && results[0] && results[0].result;
          if (pageText) activeSources = [{ text: pageText, url: tab.url, title: tab.title || tab.url }];
        }
      } catch(e) {}
    }
    if (!activeSources.length) {
      btn.textContent = 'NO SRC';
      btn.title = 'No source text available to attribute against';
      setTimeout(() => { btn.textContent = isRetrace ? 'RE-TRACE' : 'TRACE'; btn.disabled = false; }, 2000);
      return;
    }
    const result = await new Promise(resolve =>
      chrome.runtime.sendMessage({
        type: 'TRACE',
        payload: { reply, sources: activeSources, model: currentModel, priorAttributions: priorAttributions || null },
      }, resolve)
    );
    if (!result || result.error) {
      btn.textContent = 'ERR';
      btn.title = result ? result.error : 'unknown error';
      btn.disabled = false;
      return;
    }
    btn.remove();
    // Filter out attributions with empty claim or evidence before rendering
    const valid = (result.attributions || []).filter(a =>
      a && a.claim && a.claim.trim() && a.evidence && a.evidence.trim()
    );
    // Clear previous trace annotations when re-tracing
    if (isRetrace) clearMsgTraceAnnotations(msgDiv);
    // Persist trace results to history (suppress re-render triggered by storage change)
    S.suppressHistoryRender = true;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const url = (tabs && tabs[0] && tabs[0].url) || S.currentUrl || '';
      chrome.runtime.sendMessage({
        type: 'TRACE_SAVE',
        payload: { url, aiReply: reply, traceAttributions: valid },
      }, () => {
        S.suppressHistoryRender = false;
        syncToDir().catch(() => {});  // sync trace results to JSON file
      });
    });
    renderTraceAnnotations(msgDiv, valid, activeSources);
    attachTraceButton(msgDiv, reply, sources, valid);  // re-attach as RE-TRACE
  });
  msgDiv.appendChild(btn);
}

function clearMsgTraceAnnotations(msgDiv) {
  // Re-render message content to remove injected superscripts
  if (msgDiv._content && msgDiv._originalText) {
    msgDiv._content.innerHTML = renderMarkdown(msgDiv._originalText);
  }
  // Remove footnotes block and empty note
  msgDiv.querySelectorAll('.trace-footnotes, .trace-empty').forEach(e => e.remove());
}

function renderTraceAnnotations(msgDiv, attributions, sources) {
  // Filter out any empty entries that slipped through
  const valid = (attributions || []).filter(a =>
    a && a.claim && a.claim.trim() && a.evidence && a.evidence.trim()
  );
  if (!valid.length) {
    const note = document.createElement('div');
    note.className = 'trace-empty';
    note.textContent = 'No attributable sources found.';
    msgDiv.appendChild(note);
    return;
  }

  // Inject numbered superscripts into the reply text
  const injected = [];
  valid.forEach((attr, idx) => {
    const src = sources[attr.src];
    if (injectSuperscript(msgDiv._content, attr.claim, idx + 1, attr.evidence, src)) {
      injected.push({ num: idx + 1, attr, src });
    }
  });

  // Collapsed SOURCES block below the message
  if (injected.length) {
    const fnWrap = document.createElement('div');
    fnWrap.className = 'trace-footnotes';
    const fnToggle = document.createElement('button');
    fnToggle.className = 'trace-fn-toggle';
    fnToggle.textContent = 'SOURCES (' + injected.length + ')';
    const fnBody = document.createElement('div');
    fnBody.className = 'trace-fn-body';
    fnBody.style.display = 'none';
    fnToggle.addEventListener('click', () => {
      const open = fnBody.style.display !== 'none';
      fnBody.style.display = open ? 'none' : 'block';
      fnToggle.classList.toggle('open', !open);
    });
    injected.forEach(({ num, attr }) => {
      const row = document.createElement('div');
      row.className = 'trace-fn-row';
      const numEl = document.createElement('span');
      numEl.className = 'trace-fn-num';
      numEl.textContent = num + '.';
      const evidEl = document.createElement('span');
      evidEl.className = 'trace-fn-evid';
      evidEl.textContent = '\u201c' + attr.evidence + '\u201d';
      row.appendChild(numEl);
      row.appendChild(evidEl);
      fnBody.appendChild(row);
    });
    fnWrap.appendChild(fnToggle);
    fnWrap.appendChild(fnBody);
    msgDiv.appendChild(fnWrap);
  } else {
    // All claims injected without match — show empty note
    const note = document.createElement('div');
    note.className = 'trace-empty';
    note.textContent = 'No attributable sources found.';
    msgDiv.appendChild(note);
  }

  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function injectSuperscript(container, claim, num, evidence, src) {
  const needle = claim.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    // Split: [before claim][sup][after claim]
    const before   = text.slice(0, idx + claim.length);
    const after    = text.slice(idx + claim.length);
    const sup = document.createElement('sup');
    sup.className = 'trace-sup';
    sup.textContent = num;
    sup.title = evidence ? '\u201c' + evidence.slice(0, 100) + '\u201d' : '';
    sup.addEventListener('click', () => {
      if (!evidence) return;
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs[0] || !tabs[0].id) return;
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: (evidence) => {
            // Clear previous trace highlights
            document.querySelectorAll('.cwa-trace-hl').forEach(m => {
              if (!m.parentNode) return;
              while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
              m.parentNode.removeChild(m);
            });
            // Normalize helper: collapse all whitespace to single space
            const norm = s => s.replace(/\s+/g, ' ').trim();
            const normEvidence = norm(evidence);
            // Try progressively shorter prefixes in case evidence is long
            const candidates = [normEvidence, normEvidence.slice(0, 120), normEvidence.slice(0, 60)];
            const HL_STYLE = 'background:#ffe066 !important;color:#000 !important;border-radius:2px;outline:1px solid #ffb300;';
            for (const needle of candidates) {
              if (!needle) continue;
              // window.find: case-insensitive, forward, wrap-around
              if (!window.find(needle, false, false, true, false, false, false)) continue;
              const sel = window.getSelection();
              if (!sel || !sel.rangeCount) continue;
              const range = sel.getRangeAt(0).cloneRange();
              sel.removeAllRanges();
              const mark = document.createElement('mark');
              mark.className = 'cwa-trace-hl';
              mark.style.cssText = HL_STYLE;
              try {
                range.surroundContents(mark);
              } catch (_) {
                // Range spans elements — insert mark as overlay at start instead
                try {
                  const startRange = range.cloneRange();
                  startRange.collapse(true);
                  const span = document.createElement('mark');
                  span.className = 'cwa-trace-hl';
                  span.style.cssText = HL_STYLE + 'position:relative;';
                  startRange.insertNode(span);
                  span.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  return 1;
                } catch(_2) { return 0; }
              }
              mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return 1;
            }
            return 0;
          },
          args: [evidence],
        }).catch(() => {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'HIGHLIGHT_TRACES', snippets: [evidence] }).catch(() => {});
        });
      });
    });
    const parent = node.parentNode;
    const afterNode = document.createTextNode(after);
    parent.replaceChild(afterNode, node);
    parent.insertBefore(sup, afterNode);
    parent.insertBefore(document.createTextNode(before), sup);
    return true;
  }
  return false;
}

function backToList() {
  S.currentEntry = null;
  S.selectedUrls.clear();
  document.body.className = '';
  showListView();
}

//  Chat send 
async function sendChatMessage() {
  const rawText = el.chatInp.value.trim();
  if (!rawText || S.chatBusy) return;
  hideAtHint();

  const { cleanText, resolvedCtxs, presetInstruction } = parseInput(rawText);
  const text = cleanText;

  // Merge legacy pending + resolved @ctxId selections
  const allSels = [...S.pendingSelections];
  resolvedCtxs.forEach(s => { if (!allSels.find(x => x.text === s.text)) allSels.push(s); });

  // Req 1: if no new context declared, reuse last-used context
  if (allSels.length === 0 && S.lastCtxSels.length > 0) {
    S.lastCtxSels.forEach(s => allSels.push(s));
  }

  // Req 2: if still no context, capture full page text as fallback
  if (allSels.length === 0) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        const tabUrl = tab.url || '';
        const isPdf  = /\.pdf(\?.*)?$/i.test(tabUrl) ||
                       tabUrl.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/');
        if (isPdf) {
          // PDF pages: scripting.executeScript won't work; fetch + parse instead
          try {
            const pdfUrl = isPdf && tabUrl.startsWith('chrome-extension://')
              ? new URL(tabUrl).searchParams.get('url') || tabUrl
              : tabUrl;
            const pageText = await extractPdfText(pdfUrl);
            if (pageText) allSels.push({ text: '[PDF] ' + pageText, context: pageText });
          } catch(pe) { ERR('PDF extract failed', pe); }
        } else {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => (document.body && document.body.innerText || '').trim().slice(0, 5000),
          });
          const pageText = results && results[0] && results[0].result;
          if (pageText) allSels.push({ text: pageText, context: pageText });
        }
      }
    } catch(e) { ERR('page text capture failed', e); }
  }

  S.chatBusy = true;
  el.chatInp.value = '';
  el.chatInp.style.height = '';
  updateMirror();
  el.chatInp.disabled = true;
  el.chatSend.disabled = true;

  const tsEl = document.createElement('div');
  tsEl.className = 'msg-ts';
  tsEl.textContent = fmtTime(Date.now());
  el.chatMessages.appendChild(tsEl);
  appendMsgEl('user', text, false, null);

  const entry    = S.currentEntry;
  const histMsgs = (entry && entry.content || []).slice(-20).map(m => ({ role: m.role, content: m.message }));

  const payload = {
    prompt:     text,
    url:        (entry && entry.url)   || S.currentUrl,
    meta:       { title: (entry && entry.title) || S.currentTitle || '', description: '' },
    selections: allSels.map(s => ({ text: s.text, context: s.context || s.text })),
    messages:   histMsgs,
    model:      S.model,
    presetInstruction: presetInstruction || null,
  };

  const snapshotSels = allSels.slice();
  const traceSrcs = snapshotSels.map(s => {
    const stored = s.id ? S.ctxStore[s.id] : null;
    return {
      text:  s.text,
      url:   (stored && stored.url)   || payload.url   || S.currentUrl || '',
      title: (stored && stored.title) || payload.meta.title || S.currentTitle || '',
    };
  });
  const aiDiv = appendMsgEl('assistant', '', true, null);
  let buf = '';

  try {
    setStatus('waiting');
    await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'cwa' });
      port.onMessage.addListener(msg => {
        if (msg.type === 'CHUNK') {
          buf += msg.chunk;
          setStatus('streaming');
          aiDiv._content.innerHTML = renderMarkdown(buf);
          el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
          return;
        }
        port.disconnect();
        if (msg.error) { reject(new Error(msg.error)); return; }
        const reply = msg.reply || buf;
        aiDiv._content.innerHTML = renderMarkdown(reply);
        aiDiv.classList.remove('streaming');
        if (snapshotSels.length) appendCtxFooter(aiDiv, snapshotSels);
        aiDiv._originalText = reply;
        attachTraceButton(aiDiv, reply, traceSrcs);
        el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
        if (snapshotSels.length > 0) S.lastCtxSels = snapshotSels.slice();
        chrome.runtime.sendMessage({
          type: 'HISTORY_SAVE',
          payload: {
            url:          payload.url,
            title:        S.currentTitle || payload.url,
            userMessage:  text,
            aiReply:      reply,
            contextTexts: snapshotSels.map(s => s.text),
            contextRefs:  traceSrcs.map((ts, i) => ({
              id:      snapshotSels[i] ? snapshotSels[i].id : undefined,
              text:    snapshotSels[i] ? snapshotSels[i].text    : ts.text,
              context: snapshotSels[i] ? snapshotSels[i].context : ts.text,
              url:     ts.url,
              title:   ts.title,
            })),
          },
        }).catch(() => {});
        resolve();
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (err) reject(new Error(err)); else resolve();
      });
      port.postMessage({ type: 'QUERY', payload });
    });
    setStatus('ready');
  } catch(e) {
    ERR(e.message);
    aiDiv.className = 'msg error';
    aiDiv._content.textContent = 'ERROR: ' + e.message;
    aiDiv.classList.remove('streaming');
    setStatus('error');
  } finally {
    S.chatBusy = false;
    el.chatInp.disabled = false;
    el.chatSend.disabled = false;
    el.chatInp.focus();
  }
}

//  Status 
function setStatus(s) {
  document.body.className = s === 'ready' ? '' : 's-' + s;
  const labels = { ready: 'READY', waiting: 'AWAITING', streaming: 'STREAMING', error: 'ERROR' };
  document.querySelectorAll('#g-stxt, #chat-sbar-clone #g-stxt').forEach(el => el.textContent = labels[s] || s.toUpperCase());
}

//  Model 
function cycleModel() {
  const models = cwaGetProviderConfig(S.provider).models;
  const idx = models.indexOf(S.model);
  S.model = models[(idx + 1) % models.length];
  chrome.storage.sync.set({ cwaModel: S.model });
  syncModelBadges();
}
function syncModelBadges() {
  const label = cwaFormatModelBadge(S.provider, S.model);
  document.querySelectorAll('.model-badge').forEach(function(b) {
    b.textContent = label;
    b.title = cwaGetProviderConfig(S.provider).label + ' model: ' + S.model + '. Click to cycle models for this provider.';
  });
}

//  Storage 
function loadHistory() {
  return new Promise(r => chrome.storage.local.get(HISTORY_KEY, d => r(d[HISTORY_KEY] || { version:1, entries:[] })));
}
function chromeSGet(keys) {
  return new Promise(r => chrome.storage.sync.get(keys, r));
}

//  Markdown 
function renderMarkdown(raw) {
  let t = (raw || '').trim();
  if (!t) return '';
  const blocks = [];
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push('<pre><code>' + esc(code.trim()) + '</code></pre>');
    return '\x00BLOCK' + (blocks.length-1) + '\x00';
  });
  t = t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  t = t.replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>');
  t = t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  t = t.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  t = t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>');
  t = t.replace(/`([^`]+)`/g, (_,c) => '<code>' + esc(c) + '</code>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/((?:^[-*] .+\n?)+)/gm, m => '<ul>' + m.trim().split('\n').map(l=>'<li>'+l.replace(/^[-*] /,'')+'</li>').join('') + '</ul>');
  t = t.replace(/((?:^\d+\. .+\n?)+)/gm, m => '<ol>' + m.trim().split('\n').map(l=>'<li>'+l.replace(/^\d+\. /,'')+'</li>').join('') + '</ol>');
  t = t.split(/\n{2,}/).map(c => { c = c.trim(); if (!c) return ''; if (/^<(h[1-3]|ul|ol|pre|hr|blockquote)/.test(c)) return c; return '<p>'+c.replace(/\n/g,'<br>')+'</p>'; }).join('\n');
  t = t.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[+i]);
  return t;
}
function esc(s)     { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return (s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

//  Utilities 
function normalizeUrl(url) {
  try { const u=new URL(url); return u.origin+(u.pathname.replace(/\/+$/,'')||'/')+(u.search||''); } catch(_){return url;}
}
function getDomain(url) { try{return new URL(url).hostname.replace(/^www\./,'');}catch(_){return url;} }
function getPath(url)   { try{const u=new URL(url);return (u.pathname+(u.search||'')).replace(/^\//,'')||'/';}catch(_){return url;} }
function relTime(ts) {
  const d=Date.now()-ts, m=Math.floor(d/60000);
  if(m<1) return 'now'; if(m<60) return m+'m'; const h=Math.floor(m/60);
  if(h<24) return h+'h'; return Math.floor(h/24)+'d';
}
function fmtTime(ts) {
  const d=new Date(ts), now=new Date();
  const sameDay=d.toDateString()===now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
    : d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function autoResizeTextarea() {
  el.chatInp.style.height = 'auto';
  el.chatInp.style.height = Math.min(el.chatInp.scrollHeight, 100) + 'px';
}

document.addEventListener('DOMContentLoaded', init);
