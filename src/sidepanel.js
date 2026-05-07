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
const EFFORTS = ['instant', 'balanced', 'deep'];
const EFFORT_BUDGETS = {
  instant:  { evidenceChars: 2500, middleAnchors: 3 },
  balanced: { evidenceChars: 4500, middleAnchors: 5 },
  deep:     { evidenceChars: 8000, middleAnchors: 9 },
};

const DEFAULT_PRESETS = {
  sum:       'Summarize the selected text into bare key points. No formatting, no filler. Match the language of the user prompt; if absent, match the selected text\'s language.',
  extract:   'Extract all key data points, numbers, and facts from the selected text into a minimal list. No commentary.',
  explain:   'Explain what this page or selected content is about in plain language. Be concise.',
  translate: 'Detect the language of the selected text and translate it to English. If the user specifies a target language in their prompt, translate there instead. Output translation only.',
  rephrase:  'Give 3–5 alternative phrasings of the selected text. Cover: simpler, more formal, more concise, casual. Label each variant with one word. No explanations.',
  grammar:   'List only the grammatical errors in the selected text. Format each as: [original] → [correction]. No other output.',
  keywords:  'Generate precise search keyword candidates from the selected text to expand information retrieval. Include exact phrases, synonyms, and related terms. Compact list only.',
  find:      'Search the page content for passages matching the user\'s description or keyword. Return ONLY verbatim quotes in double quotes — these will be auto-highlighted on the page. If nothing matches, output: not found.',
  define:    'Define the selected term or concept in 1–3 sentences. Precise and direct, no padding.',
  outline:   'Convert the selected content into a hierarchical outline. Minimal words per node. No prose.',
  search:    'Use web search results to answer. Respond in the same language and at the same level of detail (brief/detailed) as the user\'s question. Cite sources with [N].',
};

const S = {
  view:              'list',
  scrollPositions:   {},   // { [url]: scrollTop } — persisted across tab switches
  currentEntry:      null,
  currentUrl:        '',
  currentTitle:      '',
  allEntries:        [],
  displayedCount:    PAGE_SIZE,
  provider:          'openai',
  model:             'gpt-4o-mini',
  apiKeys:           {},
  effort:            'balanced',
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
  currentPort:       null,  // active chrome.runtime port; set during streaming for abort
  ctxNextId:         1,    // global monotone context ID counter
  pageHtmlCache:     {},   // { [url]: { uid, text, title, createdAt } } — session-level page text cache
  resumeCache:       {},   // { [url]: string } — LLM session resume summaries (persisted)
};  // deep mode is derived from !!S.pageHtmlCache[S.currentUrl] — no separate flag

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

// ── Debug console (Alt+F12) ───────────────────────────────────────────────
const _dbgLines = $('dbg-lines');
const _dbgClear = $('dbg-console-clear');
if (_dbgClear) _dbgClear.addEventListener('click', () => { if (_dbgLines) _dbgLines.innerHTML = ''; });

function HDBG(...args) {
  const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  LOG(text);
  if (!_dbgLines) return;
  const lvl = /✗|FAIL|fail|error|Error/.test(text) ? 'err'
            : /WARN|warn/.test(text) ? 'warn'
            : /▶|INIT|ONCHG/.test(text) ? 'info' : '';
  const line = document.createElement('div');
  line.className = 'dl' + (lvl ? ' ' + lvl : '');
  line.textContent = new Date().toISOString().slice(11, 23) + '  ' + text;
  _dbgLines.appendChild(line);
  _dbgLines.scrollTop = _dbgLines.scrollHeight;
}

function normalizeEffort(effort) {
  if (effort === 'cheap') return 'instant';
  return EFFORTS.indexOf(effort) >= 0 ? effort : 'balanced';
}

function nextEffort(effort) {
  const idx = EFFORTS.indexOf(normalizeEffort(effort));
  return EFFORTS[Math.min(EFFORTS.length - 1, idx + 1)];
}

document.addEventListener('keydown', function(e) {
  if (e.altKey && e.key === 'F12') {
    e.preventDefault();
    document.body.classList.toggle('dbg-open');
  }
}, true);

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

  const sync = await chromeSGet(['cwaApiKey', 'cwaApiKeys', 'cwaProvider', 'cwaModel', 'cwaEffort', 'cwaDisplayDays', 'cwaPresets']);
  const normalized = cwaNormalizeSettings({
    provider: sync.cwaProvider,
    model: sync.cwaModel,
    apiKeys: sync.cwaApiKeys,
    apiKey: sync.cwaApiKey,
  });
  S.provider    = normalized.provider;
  S.model       = normalized.model;
  S.apiKeys     = normalized.apiKeys || {};
  // Sidebar mode is isolated from float and always starts from balanced.
  S.effort      = 'balanced';
  chrome.storage.sync.set({ cwaEffort: S.effort });
  S.displayDays = sync.cwaDisplayDays || 7;
  syncModelBadges();
  syncEffortButtons();

  S.presets = Object.assign({}, DEFAULT_PRESETS, sync.cwaPresets || {});
  LOG('presets loaded:', Object.keys(S.presets).join(', '));

  // Clone status bar into chat view
  const sbarClone = document.querySelector('.g-sbar').cloneNode(true);
  sbarClone.id = 'chat-sbar-clone';
  el.chatSbarSlot.replaceWith(sbarClone);

  // Wire events
  el.modelBadge.addEventListener('click', showModelMenu);
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
    // Req 3: Alt+` — close/toggle sidebar even when sidebar is focused
    const isToggle = e.altKey && !e.ctrlKey && !e.shiftKey &&
                     (e.code === 'Backquote');
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

  el.chatSend.addEventListener('click', () => {
    if (S.chatBusy) { abortCurrentStream(); return; }
    sendChatMessage();
  });
  document.addEventListener('click', e => {
    // <src> evidence superscripts — click to highlight span on active page
    const srcSup = e.target.closest('sup.inline-src');
    if (srcSup) {
      const evidence = srcSup.dataset.ev;
      if (evidence) {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (!tabs[0] || !tabs[0].id) return;
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: ev => {
              document.querySelectorAll('.cwa-trace-hl').forEach(m => {
                if (!m.parentNode) return;
                while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
                m.parentNode.removeChild(m);
              });
              const norm = s => s.replace(/\s+/g, ' ').trim();
              const normEv = norm(ev);
              const HL = 'background:#ffe066 !important;color:#000 !important;border-radius:2px;outline:1px solid #ffb300;';
              for (const needle of [normEv, normEv.slice(0, 120), normEv.slice(0, 60)]) {
                if (!needle) continue;
                if (!window.find(needle, false, false, true, false, false, false)) continue;
                const sel = window.getSelection();
                if (!sel || !sel.rangeCount) continue;
                const range = sel.getRangeAt(0).cloneRange();
                sel.removeAllRanges();
                const mark = document.createElement('mark');
                mark.className = 'cwa-trace-hl';
                mark.style.cssText = HL;
                try { range.surroundContents(mark); } catch (_) {
                  const sp = document.createElement('mark');
                  sp.className = 'cwa-trace-hl';
                  sp.style.cssText = HL;
                  range.collapse(true);
                  range.insertNode(sp);
                  sp.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  return;
                }
                mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
              }
            },
            args: [evidence],
          }).catch(() => {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'HIGHLIGHT_TRACES', snippets: [evidence] }).catch(() => {});
          });
        });
      }
      return;
    }
    // [N] web-search citation superscripts — click to open source URL
    const citeSup = e.target.closest('sup.search-cite');
    if (citeSup && !citeSup.classList.contains('search-cite-low')) {
      e.preventDefault();
      const url = citeSup.dataset.url;
      if (url) chrome.tabs.create({ url });
      return;
    }
    // [SEARCH: ...] pill links generated by LLM
    const searchLink = e.target.closest('a.search-link');
    if (searchLink) {
      e.preventDefault();
      const q = searchLink.dataset.searchQuery;
      if (q) {
        el.chatInp.value = q;
        autoResizeTextarea();
        el.chatInp.focus();
      }
      return;
    }
    const effortToggle = e.target && e.target.closest ? e.target.closest('#deep-chat-btn') : null;
    if (effortToggle) {
      e.preventDefault();
      showEffortMenu(effortToggle);
    }
  });

  // Save scroll position per URL so it survives tab switches (e.g. citation clicks)
  el.chatMessages.addEventListener('scroll', () => {
    if (S.currentUrl) S.scrollPositions[S.currentUrl] = el.chatMessages.scrollTop;
  }, { passive: true });
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
  document.getElementById('chat-sbar-clone').querySelector('.model-badge').addEventListener('click', showModelMenu);
  document.getElementById('chat-sbar-clone').querySelector('.gear-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Load context store
  const ctxData = await new Promise(r => chrome.storage.local.get(CTX_STORE_KEY, r));
  S.ctxStore = ctxData[CTX_STORE_KEY] || {};
  LOG('ctxStore loaded:', Object.keys(S.ctxStore).length, 'items');
  initCtxIdCounters();

  // Phase 0-C: load persisted resume summaries
  const resumeData = await new Promise(r => chrome.storage.local.get('cwaResumeCache', r));
  S.resumeCache = resumeData.cwaResumeCache || {};
  LOG('resumeCache loaded:', Object.keys(S.resumeCache).length, 'entries');

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
      if (changes.cwaGoChat && changes.cwaGoChat.newValue && !S.floatHandoffBusy) navigateToCurrent(); // hotkey jump to chat view
      if (changes.cwaFloatHandoff && changes.cwaFloatHandoff.newValue) {
        HDBG('ONCHG▶ cwaFloatHandoff changed; calling onFloatHandoff');
        onFloatHandoff(changes.cwaFloatHandoff.newValue);
      }
      if (changes.cwaFloatPending && changes.cwaFloatPending.newValue && !S.floatHandoffBusy) onFloatPending(changes.cwaFloatPending.newValue);
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
          S.apiKeys = normalized.apiKeys || {};
          syncModelBadges();
        });
      }
      if (changes.cwaEffort) {
        S.effort = normalizeEffort(changes.cwaEffort.newValue);
        syncEffortButtons();
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
  chrome.storage.session.get(['cwaGoCapture', 'cwaGoChat', 'cwaSelMsg', 'cwaFloatHandoff', 'cwaFloatPending'], pending => {
    HDBG('INIT▶ pending keys: handoff=', !!pending.cwaFloatHandoff,
        'pending=', !!pending.cwaFloatPending,
        'goChat=', !!pending.cwaGoChat,
        'goCapture=', !!pending.cwaGoCapture);
    if (pending.cwaFloatHandoff) HDBG('INIT▶ handoff payload firstQ=', !!(pending.cwaFloatHandoff.firstQ), 'url=', pending.cwaFloatHandoff.url);
    if (pending.cwaGoCapture) {
      LOG('DEBUG init: replaying missed cwaGoCapture', JSON.stringify(pending.cwaGoCapture));
      onGoCapture(pending.cwaGoCapture);
    }
    if (pending.cwaGoChat && !pending.cwaFloatHandoff) navigateToCurrent();
    if (pending.cwaSelMsg) onSelMsg(pending.cwaSelMsg);
    if (pending.cwaFloatHandoff) onFloatHandoff(pending.cwaFloatHandoff);
    else if (pending.cwaFloatPending) onFloatPending(pending.cwaFloatPending);
  });

  // Keep cwaSpOpen in sync so background.js knows the panel is alive
  window.addEventListener('pagehide', () => {
    chrome.storage.session.remove('cwaSpOpen');
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_SEL_HL' }).catch(() => {});
      });
  });
  LOG('init');
}

//  Preset bar (hidden — presets activated via /cmd inline text) 
function renderPresetBar() { /* no-op: presets now via /cmd in input */ }

// Phase 2-C: receive float handoff — pre-populate chat with first Q/A then optionally auto-send second Q
async function onFloatHandoff(handoff) {
  HDBG('HANDOFF▶ called; firstQ=', !!(handoff && handoff.firstQ),
      'firstA=', !!(handoff && handoff.firstA),
      'secondQ=', !!(handoff && handoff.secondQ),
      'url=', handoff && handoff.url);
  chrome.storage.session.remove(['cwaFloatHandoff', 'cwaGoChat']);
  if (!handoff) { HDBG('HANDOFF✗ handoff null'); return; }
  S.floatHandoffBusy = true;
  try {
    // Keep sidebar effort independent from float effort.
    // Float may run instant/deep per-question, but sidebar always resumes in balanced mode.
    S.effort = 'balanced';
    syncEffortButtons();
    const normUrl  = normalizeUrl(handoff.url || S.currentUrl);
    S.currentUrl   = normUrl;
    S.currentTitle = handoff.title || S.currentTitle;
    HDBG('HANDOFF▶ normUrl=', normUrl);

    const hist     = await loadHistory();
    let entryIdx   = hist.entries.findIndex(e => e.url === normUrl);
    HDBG('HANDOFF▶ hist.entries=', hist.entries.length, 'entryIdx=', entryIdx,
         'knownURLs=', JSON.stringify(hist.entries.slice(0,2).map(e => e.url)));
    let entry;

    const floatPair = (handoff.firstQ && handoff.firstA) ? [
      { timestamp: Date.now() - 1, role: 'user',      message: handoff.firstQ, context: handoff.selection || '' },
      { timestamp: Date.now(),     role: 'assistant', message: handoff.firstA, context: '',
        effort: normalizeEffort(handoff.effort || S.effort),
        contextRefs: handoff.selection ? [{ text: handoff.selection, url: normUrl, title: handoff.title }] : [] },
    ] : [];
    HDBG('HANDOFF▶ floatPair.length=', floatPair.length);

    if (entryIdx >= 0) {
      entry = hist.entries[entryIdx];
      const prevLen = entry.content ? entry.content.length : 0;
      if (!entry.content) entry.content = [];
      entry.content.push(...floatPair);
      hist.entries.splice(entryIdx, 1);
      hist.entries.unshift(entry);
      HDBG('HANDOFF▶ merged into existing entry; content', prevLen, '→', entry.content.length);
    } else {
      entry = { url: normUrl, title: S.currentTitle || normUrl, context: [], content: [...floatPair], timestamp: Date.now() };
      if (floatPair.length) hist.entries.unshift(entry);
      HDBG('HANDOFF▶ NEW entry created; content.length=', entry.content.length);
    }

    if (floatPair.length) {
      S.suppressHistoryRender = true;
      HDBG('HANDOFF▶ suppress=true; saving to storage…');
      try {
        await new Promise(r => chrome.storage.local.set({ [HISTORY_KEY]: hist }, r));
        HDBG('HANDOFF▶ storage saved; entry.content.length=', entry.content.length);
      } catch(saveErr) {
        HDBG('HANDOFF✗ storage save FAILED:', saveErr);
      }
      HDBG('HANDOFF▶ calling openChatView; content.length=', entry.content.length);
      openChatView(entry);
      S.suppressHistoryRender = false;
      HDBG('HANDOFF▶ suppress=false; openChatView done; S.view=', S.view);
    } else {
      HDBG('HANDOFF▶ no floatPair; openChatView for empty entry');
      openChatView(entry);
    }

    if (handoff.secondQ) {
      HDBG('HANDOFF▶ auto-sending secondQ:', handoff.secondQ.slice(0, 40));
      el.chatInp.value = handoff.secondQ;
      updateMirror();
      await sendChatMessage();
    } else {
      HDBG('HANDOFF▶ no secondQ — done');
    }
  } catch(e) { HDBG('HANDOFF✗ failed:', String(e)); }
  finally { S.floatHandoffBusy = false; HDBG('HANDOFF▶ floatHandoffBusy cleared'); }
}

// Open sidebar with a pending float conversation (user opened sidebar manually while float had Q/A)
async function onFloatPending(fp) {
  LOG('PENDING▶ onFloatPending called; firstQ=', !!(fp && fp.firstQ), 'url=', fp && fp.url);
  chrome.storage.session.remove('cwaFloatPending');
  if (!fp || !fp.firstQ || !fp.firstA) { ERR('PENDING✗ missing firstQ/firstA'); return; }
  try {
    const normUrl  = normalizeUrl(fp.url || S.currentUrl);
    S.currentUrl   = normUrl;
    S.currentTitle = fp.title || S.currentTitle;

    const hist     = await loadHistory();
    let entryIdx   = hist.entries.findIndex(e => e.url === normUrl);
    let entry;

    const floatPair = [
      { timestamp: Date.now() - 1, role: 'user',      message: fp.firstQ, context: fp.sel || '' },
      { timestamp: Date.now(),     role: 'assistant', message: fp.firstA, context: '',
        contextRefs: fp.sel ? [{ text: fp.sel, url: fp.url, title: fp.title }] : [] },
    ];

    if (entryIdx >= 0) {
      entry = hist.entries[entryIdx];
      if (!entry.content) entry.content = [];
      entry.content.push(...floatPair);
      hist.entries.splice(entryIdx, 1);
      hist.entries.unshift(entry);
    } else {
      entry = { url: normUrl, title: S.currentTitle || normUrl, context: [], content: [...floatPair], timestamp: Date.now() };
      hist.entries.unshift(entry);
    }

    S.suppressHistoryRender = true;
    try {
      await new Promise(r => chrome.storage.local.set({ [HISTORY_KEY]: hist }, r));
    } catch(e2) { ERR('PENDING✗ storage save failed:', e2); }
    LOG('PENDING▶ saved; calling openChatView; content.length=', entry.content.length);
    openChatView(entry);
    S.suppressHistoryRender = false;
  } catch(e) { ERR('PENDING✗ onFloatPending failed:', e); }
}

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
  const parts = text.split(/((?:^|(?<=\s))\/[\w-]+|@(?:[a-f0-9]{6,8}(?:_[a-z0-9]+)?|\d+)\b)/g);
  parts.forEach(part => {
    if (!part) return;
    if (/^\/[\w-]+$/.test(part)) {
      html += '<span class="cmd-token">' + esc(part) + '</span>';
      hasToken = true;
    } else if (/^@(?:[a-f0-9]{6,8}(?:_[a-z0-9]+)?|\d+)$/.test(part)) {
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

// Phase 0-A: generate per-page UID: 8-hex-char url hash + '_' + timestamp base36
function genPageUid(url) {
  let h = 5381;
  const len = Math.min((url || '').length, 200);
  for (let i = 0; i < len; i++) { h = ((h << 5) + h) ^ url.charCodeAt(i); h = h >>> 0; }
  return h.toString(16).padStart(8, '0') + '_' + Date.now().toString(36);
}

function initCtxIdCounters() {
  S.ctxNextId = 1;
  for (const id of Object.keys(S.ctxStore)) {
    // Support both new integer format and legacy "X.Y" format
    const n = parseInt(id, 10);
    if (!isNaN(n) && n >= S.ctxNextId) S.ctxNextId = n + 1;
  }
}

function nextCtxId(url) {
  return String(S.ctxNextId++);
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
          func: () => (document.body && document.body.innerText || '').trim().slice(0, 30000),
        });
        pageText = (results && results[0] && results[0].result) || '';
      } catch(e) { return; }
    }
    if (!pageText) return;
    // Phase 0-A: cache full page text as { uid, text, title, createdAt }
    S.pageHtmlCache[url] = { uid: genPageUid(url), text: pageText, title: S.currentTitle || url, createdAt: Date.now() };
    // Reuse existing context ID for this URL so it stays stable across sessions
    const existingAutoId = Object.keys(S.ctxStore).find(k => S.ctxStore[k].url === url && S.ctxStore[k].auto);
    const id = existingAutoId || nextCtxId(url);
    const preservedCreatedAt = existingAutoId ? S.ctxStore[id].createdAt : Date.now();
    S.ctxStore[id] = { text: pageText, url, title: S.currentTitle || url, createdAt: preservedCreatedAt, auto: true };
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
    LOG('auto-captured ctx:', id, existingAutoId ? '(reused)' : '(new)', 'chars:', pageText.length);
    updateDeepChatBtn();
  } catch(e) { ERR('auto-capture failed', e); }
}

//  Selection messages from content.js 
function onSelMsg(msg) {
  if (!msg) return;
  if (msg.type === 'SEL_NEW' || msg.type === 'SEL_APPEND') {
    const { text, context, url, title, elementPick } = msg.payload;
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
    const pillCtx = { id, text, context: context || text };
    S.pendingSelections = (msg.type === 'SEL_NEW' ? [] : S.pendingSelections).filter(Boolean);
    S.pendingSelections.push(pillCtx);
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
  if (msg.type === 'SEL_SET') S.pendingSelections = [msg.payload];
  if (S.view === 'chat') renderCtxBar();
}

function renderCtxBar() {
  const ctx = S.pendingSelections.filter(Boolean);
  if (!ctx.length) { el.chatCtxBar.style.display = 'none'; return; }
  el.chatCtxBar.style.display = 'flex';
  el.chatCtxItems.innerHTML = '';
  ctx.forEach(function(c, i) {
    const badge = document.createElement('span');
    badge.className = 'ctx-badge';
    const cid = c.id || (i + 1);
    badge.innerHTML = '<span class="ctx-idx">@' + esc(String(cid)) + '</span>' +
      esc((c.text || '').slice(0, 20)) + ((c.text || '').length > 20 ? '\u2026' : '');
    badge.title = (c.text || '').slice(0, 200);
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', function() {
      const existing = badge.nextSibling && badge.nextSibling.classList && badge.nextSibling.classList.contains('ctx-ref-preview')
        ? badge.nextSibling : null;
      if (existing) { existing.remove(); return; }
      const preview = document.createElement('div');
      preview.className = 'ctx-ref-preview';
      preview.textContent = c.context || c.text || '';
      badge.insertAdjacentElement('afterend', preview);
    });
    el.chatCtxItems.appendChild(badge);
  });
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
    const filtered = sortedIds.filter(id => {
      if (!partial) return true;
      if (id.startsWith(partial)) return true;
      const title = (S.ctxStore[id].title || '').toLowerCase();
      return title.includes(partial);
    });
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
        // Phase 0-A: for auto-captured page entries show title · HH:MM DD/MM instead of raw preview
        let labelText;
        if (ctx.auto && ctx.createdAt) {
          const d = new Date(ctx.createdAt);
          const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const ddmm = d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
          labelText = title + ' \u00b7 ' + hhmm + ' ' + ddmm;
        } else {
          labelText = title + ' <span style="color:var(--fg-dim)">\u2014</span> ' + esc(preview);
        }
        item.innerHTML =
          '<span class="at-hint-idx" style="color:' + (isOwn ? 'var(--accent)' : '#8888ff') + '">@' + id + '</span>' +
          '<span class="at-hint-text">' + labelText + '</span>';
        // Hover: expand preview (only for non-auto entries)
        item.addEventListener('mouseover', () => {
          if (ctx.auto) return;
          const expandedPreview = ctx.text.slice(0, 120) + (ctx.text.length > 120 ? '\u2026' : '');
          item.querySelector('.at-hint-text').innerHTML = title + ' <span style="color:var(--fg-dim)">—</span> ' + esc(expandedPreview);
        });
        item.addEventListener('mouseleave', () => {
          if (ctx.auto) return;
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

      showHintItems([...el.atHint.querySelectorAll('.at-hint-item')]);
      return;
    }
  }

  hideAtHint();
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
  S.hintIdx   = -1;
  S.hintItems = [];
}

// Resolve @ctxId refs and /cmd presets from input text
// Returns { cleanText, resolvedCtxs, presetInstruction, presetKey }
function parseInput(rawText) {
  // Extract /cmd (first occurrence, anywhere in text)
  let presetInstruction = null;
  let presetKey = null;
  let textWithoutCmd = rawText;
  const cmdM = rawText.match(/(^|\s)\/([\w-]+)(\s|$)/);
  if (cmdM) {
    const key = cmdM[2];
    if (S.presets[key]) {
      presetInstruction = S.presets[key];
      presetKey = key;
      textWithoutCmd = rawText.replace(cmdM[0], cmdM[1] || cmdM[3] ? ' ' : '').trim();
    }
  }

  // Resolve @ctxId references
  const resolvedCtxs = [];
  const cleanText = textWithoutCmd.replace(/@([a-f0-9]{6,8}(?:_[a-z0-9]+)?|\d+)\b/g, (match, id) => {
    const ctx = S.ctxStore[id];
    if (ctx) {
      if (!resolvedCtxs.find(x => x.id === id)) resolvedCtxs.push({ id, text: ctx.text, context: ctx.text });
      return ''; // remove from visible text to GPT (will be in context block)
    }
    return match;
  }).replace(/\s{2,}/g, ' ').trim();

  return { cleanText: cleanText || textWithoutCmd, resolvedCtxs, presetInstruction, presetKey };
}

//  Tab helpers 
async function refreshCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { await refreshList(); return; }
  await onTabNavigated(tab.url || '', tab.title || '');
}

async function onTabNavigated(url, title) {
  const newNorm = normalizeUrl(url);
  LOG('onTabNavigated: newUrl=', newNorm, '| S.view=', S.view,
      '| floatHandoffBusy=', !!S.floatHandoffBusy);
  // If handoff is in progress, don't let tab navigation overwrite S.currentUrl
  // or wipe the chat view being built by onFloatHandoff
  if (S.floatHandoffBusy) {
    LOG('onTabNavigated: SKIPPED — floatHandoffBusy is true');
    return;
  }
  S.currentUrl   = newNorm;
  S.currentTitle = title;
  S.pendingSelections = [];
  S.autoCtxId = null;              // reset auto-ctx on URL change
  delete S.pageHtmlCache[S.currentUrl];  // Phase 0-A: invalidate stale cache so autoCapturePageCtx re-runs
  updateCurrentBar();

  const hist  = await loadHistory();
  const entry = hist.entries.find(e => e.url === S.currentUrl);

  // Phase 0-C: trigger resume summary if ≥4 messages exist and no summary cached
  if (entry && entry.content && entry.content.length >= 4 && !S.resumeCache[S.currentUrl]) {
    const normUrl = S.currentUrl;
    const lastMsgs = entry.content.slice(-8).map(m => ({ role: m.role, content: m.message }));
    chrome.runtime.sendMessage({
      type: 'RESUME_SUMMARIZE',
      payload: { messages: lastMsgs, url: normUrl },
    }, resp => {
      if (resp && resp.summary) {
        S.resumeCache[normUrl] = resp.summary;
        chrome.storage.local.get('cwaResumeCache', d => {
          const cache = d.cwaResumeCache || {};
          cache[normUrl] = resp.summary;
          chrome.storage.local.set({ cwaResumeCache: cache });
        });
      }
    });
  }

  if (S.view === 'chat') {
    if (!S.currentEntry) { backToList(); return; }
    if (S.currentEntry.url !== S.currentUrl) {
      if (entry) { openChatView(entry); } else { backToList(); return; }
      updateDeepChatBtn();
    }
    return;
  }
  await refreshList(hist);
  if (entry) {
    openChatView(entry);
    updateDeepChatBtn();
  }
}

function onHistoryChanged(newHist) {
  if (!newHist) return;
  if (S.suppressHistoryRender) {
    HDBG('onHistoryChanged: SUPPRESSED; view=', S.view);
    return;
  }
  HDBG('onHistoryChanged: FIRING; view=', S.view,
      'currentEntry.url=', S.currentEntry && S.currentEntry.url,
      'newHist entries=', (newHist.entries || []).length);
  if (S.view === 'list') { refreshList(newHist); return; }
  if (S.view === 'chat' && S.currentEntry) {
    const updated = (newHist.entries || []).find(e => e.url === S.currentEntry.url);
    HDBG('onHistoryChanged: chat; updated=', !!updated, 'msgs=', updated ? (updated.content||[]).length : 'N/A');
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
      // Plain click — clear selection (update classes in-place, no DOM rebuild)
      if (S.selectedUrls.size) {
        S.selectedUrls.clear();
        el.entriesList.querySelectorAll('.entry.selected').forEach(el => el.classList.remove('selected'));
        return;
      }
    });

    // Double-click: switch to that tab or open new tab
    head.addEventListener('dblclick', e => {
      e.stopPropagation();
      LOG('DEBUG dblclick: entry.url=', entry.url);
      chrome.tabs.query({}, tabs => {
        LOG('DEBUG dblclick: tabs count=', tabs.length, 'checking against entry.url=', entry.url);
        const existing = tabs.find(t => {
          const norm = normalizeUrl(t.url || '');
          LOG('DEBUG dblclick tab:', norm, '===', entry.url, '?', norm === entry.url);
          return norm === entry.url;
        });
        if (existing) {
          LOG('DEBUG dblclick: found existing tab id=', existing.id, 'windowId=', existing.windowId);
          chrome.tabs.update(existing.id, { active: true });
          chrome.windows.update(existing.windowId, { focused: true });
        } else {
          LOG('DEBUG dblclick: no existing tab found, creating new tab for', entry.url);
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
    const sync  = await new Promise(r => chrome.storage.sync.get(['cwaProvider', 'cwaApiKeys', 'cwaModel', 'cwaDisplayDays', 'cwaPresets'], r));
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
  updateDeepChatBtn();
}

//  Chat view 
function openChatView(entry) {
  LOG('openChatView: url=', entry && entry.url,
      '| content.length=', entry && entry.content ? entry.content.length : 0);
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
  // Restore saved scroll position if not at bottom (e.g. after citation tab jump)
  const savedScroll = S.scrollPositions[entry.url];
  if (savedScroll !== undefined) {
    // Only restore if user had scrolled away from bottom (>100px)
    const atBottom = savedScroll >= el.chatMessages.scrollHeight - el.chatMessages.clientHeight - 100;
    if (!atBottom) el.chatMessages.scrollTop = savedScroll;
  }
  setTimeout(() => el.chatInp.focus(), 50);
}

// Convert [N] citation markers in already-rendered HTML to clickable superscripts.
// Valid source index → <sup class="search-cite"> linked to source URL.
// Out-of-range index → <sup class="search-cite search-cite-low"> with ? to flag hallucination.
function applySearchCitations(html, sources) {
  if (!sources || !sources.length) return html;
  // Only replace [N] that are NOT inside an HTML tag (attributes, etc.)
  // Since renderMarkdown escapes < and >, all [N] in output are real content.
  return html.replace(/\[(\d+)\]/g, (match, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx >= 0 && idx < sources.length) {
      const url   = escAttr(sources[idx].url   || '');
      const title = escAttr(sources[idx].title || sources[idx].url || '');
      return '<sup class="search-cite" data-url="' + url + '" title="' + title + '">' + n + '</sup>';
    }
    // LLM cited a source number that doesn't exist — flag it
    return '<sup class="search-cite search-cite-low" title="Source index out of range">?</sup>';
  });
}

// Extract all inline <src> evidence spans and build a collapsible sources panel
function buildInlineSrcPanel(msgDiv) {
  const srcs = msgDiv.querySelectorAll('sup.inline-src[data-ev]');
  if (!srcs.length) return;
  const seen = new Set();
  const evidences = [];
  srcs.forEach(sup => {
    const ev = sup.dataset.ev;
    if (ev && !seen.has(ev)) {
      seen.add(ev);
      evidences.push(ev);
    }
  });
  if (!evidences.length) return;
  
  const fnWrap = document.createElement('div');
  fnWrap.className = 'trace-footnotes inline-src-footnotes';
  const toggle = document.createElement('button');
  toggle.className = 'trace-fn-toggle';
  toggle.textContent = 'CITED (' + evidences.length + ')';
  const body = document.createElement('div');
  body.className = 'trace-fn-body';
  body.style.display = 'none';
  toggle.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    toggle.classList.toggle('open', !open);
  });
  evidences.forEach((ev, i) => {
    const row = document.createElement('div');
    row.className = 'trace-fn-row';
    const num = document.createElement('span');
    num.className = 'trace-fn-num';
    num.textContent = (i + 1) + '.';
    const evid = document.createElement('span');
    evid.className = 'inline-src-text';
    evid.textContent = ev.length > 120 ? ev.slice(0, 117) + '…' : ev;
    evid.title = ev;
    row.appendChild(num);
    row.appendChild(evid);
    body.appendChild(row);
  });
  fnWrap.appendChild(body);
  const actionRow = getAssistantActionRow(msgDiv);
  actionRow.appendChild(toggle);
  msgDiv.appendChild(fnWrap);
}

// Rebuild the collapsible SOURCES panel for a saved web-search message.
function restoreSearchSourcesPanel(msgDiv, sources) {
  if (!sources || !sources.length) return;
  if (msgDiv.querySelector('.trace-footnotes')) return; // already present
  const fnWrap = document.createElement('div');
  fnWrap.className = 'trace-footnotes';
  const toggle = document.createElement('button');
  toggle.className = 'trace-fn-toggle';
  toggle.textContent = 'SOURCES (' + sources.length + ')';
  const body = document.createElement('div');
  body.className = 'trace-fn-body';
  body.style.display = 'none';
  toggle.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    toggle.classList.toggle('open', !open);
  });
  sources.forEach((src, i) => {
    const row = document.createElement('div');
    row.className = 'trace-fn-row';
    const num = document.createElement('span');
    num.className = 'trace-fn-num';
    num.textContent = (i + 1) + '.';
    const lnk = document.createElement('a');
    lnk.href = '#';
    lnk.className = 'search-src-link';
    lnk.textContent = src.title || src.url;
    lnk.title = src.url;
    lnk.addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: src.url }); });
    row.appendChild(num);
    row.appendChild(lnk);
    body.appendChild(row);
  });
  fnWrap.appendChild(toggle);
  fnWrap.appendChild(body);
  msgDiv.appendChild(fnWrap);
}

function renderChatMessages(content) {
  LOG('renderChatMessages: content.length=', content.length,
      '| caller=', (new Error().stack.split('\n')[2] || '').trim().slice(0, 80));
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
    const msgDiv = appendMsgEl(m.role, m.message, false, m.contextRefs || null, { effort: m.effort || S.effort });
    if (m.role === 'assistant') {
      // Backfill retry metadata for persisted history so effort pills always work.
      const prevUser = i > 0 && content[i - 1] && content[i - 1].role === 'user' ? content[i - 1] : null;
      if (prevUser && !msgDiv._retryPayload) {
        msgDiv._userText = String(prevUser.message || '').replace(/\n\n\[try hard: [^\]]+\]\s*$/i, '');
        msgDiv._retryPayload = {
          prompt: msgDiv._userText,
          url: S.currentUrl,
          meta: { title: S.currentTitle || S.currentUrl, description: '' },
          selections: (m.contextRefs || []).map(function(ref) { return { text: ref.text || ref.context || '', context: ref.context || ref.text || '' }; }).filter(function(ref) { return !!ref.text; }),
          messages: content.slice(Math.max(0, i - 20), i - 1).map(function(mm) { return { role: mm.role, content: mm.message }; }),
          model: S.model,
          effort: normalizeEffort(m.effort || S.effort),
          presetInstruction: null,
          pageContext: null,
        };
      }
    }
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
    // Restore web search citations + sources panel from history
    if (m.role === 'assistant' && m.searchSources && m.searchSources.length) {
      msgDiv._content.innerHTML = applySearchCitations(msgDiv._content.innerHTML, m.searchSources);
      restoreSearchSourcesPanel(msgDiv, m.searchSources);
    }
  }
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

//  appendMsgEl 
// role, text, streaming, contextRefs:[{text,context}]|null
function appendMsgEl(role, text, streaming, contextRefs, opts) {
  opts = opts || {};
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const span = document.createElement('span');
  span.className = 'msg-content';
  if (role === 'assistant') span.innerHTML = streaming ? '' : renderMarkdown(text || '');
  else span.textContent = text || '';
  div.appendChild(span);
  div._content = span;
  div._originalText = text || '';
  div._effort = opts.effort || S.effort;
  if (streaming) div.classList.add('streaming');

  if (role === 'assistant' && contextRefs && contextRefs.length) {
    appendCtxFooter(div, contextRefs);
  }

  if (role === 'assistant') attachAssistantActionRow(div);

  // Attach trace button to all non-streaming assistant messages except instant answers
  if (role === 'assistant' && !streaming && text && div._effort !== 'instant') {
    const savedSrcs = (contextRefs || []).map(r => ({
      text: r.text || r.context || '',
      url:  r.url   || '',
      title: r.title || '',
    }));
    if (div._effort !== 'instant') attachTraceButton(div, text, savedSrcs);
  }

  // Collect inline <src> evidence and build sources panel
  if (role === 'assistant' && !streaming && text) {
    buildInlineSrcPanel(div);
  }

  el.chatMessages.appendChild(div);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return div;
}

function attachAssistantActionRow(msgDiv) {
  if (msgDiv.querySelector('.msg-action-row')) return;
  const row = document.createElement('div');
  row.className = 'msg-action-row';
  const tryBtn = document.createElement('button');
  tryBtn.className = 'trace-btn tryhard-pill';
  tryBtn.textContent = normalizeEffort(msgDiv._effort || S.effort).toUpperCase();
  tryBtn.title = 'Retry with balanced or deep effort';
  tryBtn.addEventListener('mouseenter', function() {
    showTryHardMenu(tryBtn, msgDiv);
  });
  tryBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    showTryHardMenu(tryBtn, msgDiv);
  });
  row.appendChild(tryBtn);
  msgDiv.appendChild(row);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-copy-btn';
  copyBtn.textContent = 'COPY';
  copyBtn.title = 'Copy answer';
  copyBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(msgDiv._originalText || msgDiv._content.textContent || '').catch(() => {});
  });
  msgDiv.appendChild(copyBtn);
}

function getAssistantActionRow(msgDiv) {
  let row = msgDiv.querySelector('.msg-action-row');
  if (!row) {
    attachAssistantActionRow(msgDiv);
    row = msgDiv.querySelector('.msg-action-row');
  }
  return row;
}

function showTryHardMenu(anchor, msgDiv) {
  removeFloatingMenus();
  const menu = document.createElement('div');
  menu.className = 'cwa-pop-menu';
  ['balanced', 'deep'].forEach(function(effort) {
    const b = document.createElement('button');
    b.textContent = effort.toUpperCase();
    b.addEventListener('click', function(e) {
      e.stopPropagation();
      retryAssistantMessage(msgDiv, effort);
      removeFloatingMenus();
    });
    menu.appendChild(b);
  });
  positionMenu(menu, anchor);
}

async function retryAssistantMessage(msgDiv, effort) {
  const base = msgDiv._retryPayload;
  if (!base || !msgDiv._userText || S.chatBusy) return;
  const targetEffort = normalizeEffort(effort);
  S.effort = targetEffort;
  chrome.storage.sync.set({ cwaEffort: targetEffort });
  const pageText = (S.pageHtmlCache[S.currentUrl] && S.pageHtmlCache[S.currentUrl].text) || '';
  const packet = pageText ? buildContextPacket(pageText, msgDiv._userText, targetEffort, S.currentTitle || S.currentUrl) : null;
  const payload = Object.assign({}, base, {
    effort: targetEffort,
    pageMap: packet ? packet.pageMap : base.pageMap,
    middleAnchors: packet ? packet.middleAnchors : base.middleAnchors,
    candidateSpans: packet ? packet.candidateSpans : base.candidateSpans,
  });
  const retryDiv = appendMsgEl('assistant', '', true, null);
  retryDiv._userText = msgDiv._userText;
  retryDiv._retryPayload = payload;
  S.chatBusy = true;
  let buf = '';
  try {
    await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'cwa' });
      S.currentPort = port;
      port.onMessage.addListener(msg => {
        if (msg.type === 'CHUNK') {
          buf += msg.chunk;
          retryDiv._content.innerHTML = renderMarkdown(buf);
          return;
        }
        port.disconnect();
        if (msg.error) { reject(new Error(msg.error)); return; }
        const reply = msg.reply || buf;
        retryDiv._content.innerHTML = renderMarkdown(reply);
        retryDiv._originalText = reply;
        retryDiv._retryPayload = payload;
        buildInlineSrcPanel(retryDiv);
        const retrySources = packet && pageText
          ? [{ text: pageText, chunks: packet.chunks, url: S.currentUrl, title: S.currentTitle || S.currentUrl }]
          : [];
        attachTraceButton(retryDiv, reply, retrySources);
        persistTryHardResult(msgDiv._userText, reply, targetEffort);
        resolve();
      });
      port.onDisconnect.addListener(() => resolve());
      port.postMessage({ type: 'QUERY', payload });
    });
  } catch(e) {
    retryDiv.className = 'msg error';
    retryDiv._content.textContent = 'ERROR: ' + e.message;
  } finally {
    retryDiv.classList.remove('streaming');
    S.chatBusy = false;
    S.currentPort = null;
  }
}

function persistTryHardResult(userText, reply, effort) {
  const title = S.currentTitle || S.currentUrl;
  const markedUser = userText + '\n\n[try hard: ' + effort + ']';
  if (S.currentEntry) {
    if (!S.currentEntry.content) S.currentEntry.content = [];
    S.currentEntry.content.push(
      { timestamp: Date.now(), role: 'user', message: markedUser, context: '' },
      { timestamp: Date.now() + 1, role: 'assistant', message: reply, context: '' }
    );
  }
  S.suppressHistoryRender = true;
  chrome.runtime.sendMessage({
    type: 'HISTORY_SAVE',
    payload: {
      url: S.currentUrl,
      title,
      userMessage: markedUser,
      aiReply: reply,
      contextTexts: [],
      contextRefs: [],
    },
  }, () => { S.suppressHistoryRender = false; syncToDir().catch(() => {}); });
}

// ── AUTO_FIND: PAGE SECTIONS panel (mirrors TRACE SOURCES) ─────────────────
// BM25 hits are shown as a collapsible panel opened by default.
// Clicking a row → SCROLL_TO_CHUNK_RELAY → background → content.js → scroll + 2s pulse.
// Superscript injection is skipped (answer and page often differ in language; no verbatim overlap).
function _showAutoFindBadges(msgDiv, hits) {
  if (!msgDiv || !hits || !hits.length) return;
  // Remove stale panel from prior call on this message
  msgDiv.querySelectorAll('.auto-find-bar').forEach(function(e) { e.remove(); });

  // Route through background to avoid focus-related failures of direct tab messaging
  const scrollToChunk = function(chunkIdx) {
    chrome.runtime.sendMessage({ type: 'SCROLL_TO_CHUNK_RELAY', chunkIdx: chunkIdx }, function() {
      if (chrome.runtime.lastError) {} // suppress
    });
  };

  // Collapsible PAGE SECTIONS panel — reuses trace-footnotes CSS, opened by default
  const fnWrap = document.createElement('div');
  fnWrap.className = 'auto-find-bar trace-footnotes';

  const fnToggle = document.createElement('button');
  fnToggle.className = 'trace-fn-toggle open';
  fnToggle.textContent = 'PAGE SECTIONS (' + hits.length + ')';

  const fnBody = document.createElement('div');
  fnBody.className = 'trace-fn-body';
  // Open by default so user sees clickable rows immediately
  fnBody.style.display = 'block';

  fnToggle.addEventListener('click', function() {
    const isOpen = fnBody.style.display !== 'none';
    fnBody.style.display = isOpen ? 'none' : 'block';
    fnToggle.classList.toggle('open', !isOpen);
  });

  hits.forEach(function(hit, i) {
    const row = document.createElement('div');
    row.className = 'trace-fn-row';
    row.style.cursor = 'pointer';
    row.title = 'Click to scroll to this section on the page';
    const numEl = document.createElement('span');
    numEl.className = 'trace-fn-num';
    numEl.textContent = (i + 1) + '.';
    const evidEl = document.createElement('span');
    evidEl.className = 'trace-fn-evid';
    evidEl.textContent = '\u201c' + (hit.snippet || 'Section #' + hit.chunkIdx) + '\u2026\u201d';
    row.appendChild(numEl);
    row.appendChild(evidEl);
    row.addEventListener('click', function() { scrollToChunk(hit.chunkIdx); });
    fnBody.appendChild(row);
  });

  fnWrap.appendChild(fnToggle);
  fnWrap.appendChild(fnBody);
  msgDiv.appendChild(fnWrap);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
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
function updateDeepChatBtn() {
  const active = !!(S.currentUrl && S.pageHtmlCache[S.currentUrl]);
  document.querySelectorAll('#deep-chat-btn').forEach(btn => {
    btn.classList.toggle('active', active);
    btn.textContent = S.effort.toUpperCase();
    btn.title = 'Effort: ' + S.effort + (active ? ' — page context cached' : ' — click to choose retrieval depth');
  });
}

function syncEffortButtons() {
  updateDeepChatBtn();
}

function removeFloatingMenus() {
  document.querySelectorAll('.cwa-pop-menu').forEach(m => m.remove());
}

function showEffortMenu(anchor) {
  removeFloatingMenus();
  const menu = document.createElement('div');
  menu.className = 'cwa-pop-menu';
  EFFORTS.forEach(function(effort) {
    const b = document.createElement('button');
    b.textContent = effort.toUpperCase();
    b.className = effort === S.effort ? 'active' : '';
    b.title = effort === 'instant' ? 'Fast local-first mode with no trace entry'
      : effort === 'balanced' ? 'More evidence and middle-page coverage'
      : 'Largest retrieval budget for try-hard runs';
    b.addEventListener('click', function(ev) {
      ev.stopPropagation();
      S.effort = effort;
      chrome.storage.sync.set({ cwaEffort: effort });
      if (effort !== 'instant' && !S.pageHtmlCache[S.currentUrl]) autoCapturePageCtx().catch(() => {});
      if (effort === 'instant' && S.pageHtmlCache[S.currentUrl]) delete S.pageHtmlCache[S.currentUrl];
      syncEffortButtons();
      removeFloatingMenus();
    });
    menu.appendChild(b);
  });
  positionMenu(menu, anchor);
}

function showModelMenu(e) {
  if (e && e.preventDefault) e.preventDefault();
  const anchor = e && e.currentTarget ? e.currentTarget : el.modelBadge;
  removeFloatingMenus();
  const menu = document.createElement('div');
  menu.className = 'cwa-pop-menu model-menu';
  cwaListProviders().forEach(function(provider) {
    const cfg = cwaGetProviderConfig(provider);
    const label = document.createElement('div');
    label.className = 'menu-label';
    label.textContent = cfg.label;
    menu.appendChild(label);
    cfg.models.forEach(function(model) {
      const b = document.createElement('button');
      const hasKey = !!(S.apiKeys && S.apiKeys[provider]);
      b.textContent = model + (provider === 'deepseek' && model === 'deepseek-chat' ? ' (legacy)' : '');
      b.className = provider === S.provider && model === S.model ? 'active' : '';
      if (!hasKey) {
        b.disabled = true;
        b.title = 'API key needed';
      }
      b.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (!hasKey) return;
        S.provider = provider;
        S.model = model;
        chrome.storage.sync.set({ cwaProvider: provider, cwaModel: model });
        syncModelBadges();
        removeFloatingMenus();
      });
      menu.appendChild(b);
    });
  });
  positionMenu(menu, anchor);
}

function positionMenu(menu, anchor) {
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 160;
  menu.style.left = Math.max(4, Math.min(window.innerWidth - mw - 4, r.right - mw)) + 'px';
  menu.style.top = Math.max(4, Math.min(window.innerHeight - mh - 4, r.top - mh - 6)) + 'px';
  menu.addEventListener('mouseleave', function() {
    removeFloatingMenus();
  });
  setTimeout(function() {
    document.addEventListener('click', removeFloatingMenus, { once: true });
  }, 0);
}

function attachTraceButton(msgDiv, reply, sources, priorAttributions) {
  if (msgDiv._effort === 'instant') return;
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
    // If no sources were captured, use deep-mode cache if available (cache-optimized path)
    let activeSources = (sources && sources.length) ? sources : [];
    if (!activeSources.length && S.pageHtmlCache[S.currentUrl]) {
      const cached = S.pageHtmlCache[S.currentUrl];
      activeSources = [{ text: cached.text, chunks: buildLocalChunks(cached.text, cached.title || S.currentUrl), url: S.currentUrl, title: cached.title || S.currentUrl }];
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
        payload: { reply, sources: activeSources, model: currentModel, effort: S.effort, priorAttributions: priorAttributions || null },
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
      a && a.claim && a.claim.trim() && a.evidence && a.evidence.trim() && a.status !== 'unverified'
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
  getAssistantActionRow(msgDiv).appendChild(btn);
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
    a && a.claim && a.claim.trim() && a.evidence && a.evidence.trim() && a.status !== 'unverified'
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

// ── /search preset: 3-step flow (keywords → DDG → streaming answer) ────────
async function runSearchFlow(text, dedupedSels, pageCtxText, resumeSummary, pageDeltaText) {
  const entry = S.currentEntry;
  const payloadUrl   = (entry && entry.url)   || S.currentUrl;
  const payloadTitle = (entry && entry.title) || S.currentTitle || '';

  // Show user message
  const tsEl = document.createElement('div');
  tsEl.className = 'msg-ts';
  tsEl.textContent = fmtTime(Date.now());
  el.chatMessages.appendChild(tsEl);
  appendMsgEl('user', text, false, null);

  const snapshotSels = dedupedSels.slice();
  const traceSrcs = snapshotSels.map(s => {
    const stored = s.id ? S.ctxStore[s.id] : null;
    return {
      text:  s.text,
      url:   (stored && stored.url)   || payloadUrl || '',
      title: (stored && stored.title) || payloadTitle || '',
    };
  });

  // Build history slice
  const rawMsgs = entry && entry.content || [];
  const msgSlice = resumeSummary ? rawMsgs.slice(-4) : rawMsgs.slice(-20);
  const histMsgs = msgSlice.map(m => ({ role: m.role, content: m.message }));

  const aiDiv = appendMsgEl('assistant', '', true, null);
  let buf = '';

  try {
    // Step 1: generate search keywords via LLM
    setStatus('waiting');
    aiDiv._content.textContent = '\u231b getting search keywords\u2026';
    const ctxHint = snapshotSels.length ? snapshotSels[0].text.slice(0, 300) : '';
    const kwResult = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'SEARCH_KEYWORDS', payload: { prompt: text, context: ctxHint } }, resolve)
    );
    if (!kwResult || kwResult.error) throw new Error(kwResult ? kwResult.error : 'keyword extraction failed');
    const keywords = kwResult.keywords.trim();

    // Step 2: DDG search
    aiDiv._content.textContent = '\u231b searching: ' + keywords + '\u2026';
    const searchResult = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'WEB_SEARCH_RAW', payload: { query: keywords } }, resolve)
    );
    if (!searchResult || searchResult.error) throw new Error(searchResult ? searchResult.error : 'search failed');
    const rawResults = searchResult.results || [];

    // Step 3: stream answer with results injected as context
    aiDiv._content.textContent = '';
    setStatus('waiting');
    const srcBlock = rawResults.map((r, i) =>
      '[' + (i + 1) + '] ' + r.title + '\n' + r.url + '\n' + r.snippet
    ).join('\n\n');
    const searchCtx = '[Web Search for: ' + keywords + ']\n\n' + srcBlock;
    const payload = {
      prompt:     text,
      url:        payloadUrl,
      meta:       { title: payloadTitle, description: '' },
      selections: [
        ...snapshotSels.map(s => ({ text: s.text, context: s.context || s.text })),
        { text: searchCtx, context: searchCtx },
      ],
      messages:   histMsgs,
      model:      S.model,
      presetInstruction: S.presets['search'] || null,
      pageContext: pageCtxText,
      resumeSummary: resumeSummary || undefined,
      pageDelta: pageDeltaText || undefined,
    };

    await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'cwa' });
      S.currentPort = port;
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
        aiDiv._content.innerHTML = applySearchCitations(renderMarkdown(reply), rawResults);
        aiDiv.classList.remove('streaming');
        // Minimal search marker at top of message
        const marker = document.createElement('div');
        marker.className = 'search-marker';
        marker.textContent = '\uD83D\uDD0D ' + keywords;
        aiDiv.insertBefore(marker, aiDiv.firstChild);
        // Collapsible sources
        if (rawResults.length) {
          const fnWrap = document.createElement('div');
          fnWrap.className = 'trace-footnotes';
          const toggle = document.createElement('button');
          toggle.className = 'trace-fn-toggle';
          toggle.textContent = 'SOURCES (' + rawResults.length + ')';
          const body = document.createElement('div');
          body.className = 'trace-fn-body';
          body.style.display = 'none';
          toggle.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            toggle.classList.toggle('open', !open);
          });
          rawResults.forEach((src, i) => {
            const row = document.createElement('div');
            row.className = 'trace-fn-row';
            const num = document.createElement('span');
            num.className = 'trace-fn-num';
            num.textContent = (i + 1) + '.';
            const lnk = document.createElement('a');
            lnk.href = '#';
            lnk.className = 'search-src-link';
            lnk.textContent = src.title || src.url;
            lnk.title = src.url;
            lnk.addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: src.url }); });
            row.appendChild(num);
            row.appendChild(lnk);
            body.appendChild(row);
          });
          fnWrap.appendChild(toggle);
          fnWrap.appendChild(body);
          aiDiv.appendChild(fnWrap);
        }
        if (snapshotSels.length) appendCtxFooter(aiDiv, snapshotSels);
        aiDiv._originalText = reply;
        attachTraceButton(aiDiv, reply, traceSrcs);
        el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
        if (snapshotSels.length > 0) S.lastCtxSels = snapshotSels.slice();
        // Save to history with minimal [\uD83D\uDD0D kw] marker prefix
        const markedReply = '[\uD83D\uDD0D ' + keywords + ']\n' + reply;
        const now = Date.now();
        const newMsgPair = [
          { timestamp: now, role: 'user', message: text, context: snapshotSels.map(s => s.text).filter(Boolean).join(' | ') },
          { timestamp: now + 1, role: 'assistant', message: markedReply, context: '', contextRefs: traceSrcs.map((ts, i) => ({ id: snapshotSels[i] ? snapshotSels[i].id : undefined, text: snapshotSels[i] ? snapshotSels[i].text : ts.text, context: snapshotSels[i] ? snapshotSels[i].context : ts.text, url: ts.url, title: ts.title })), searchSources: rawResults },
        ];
        if (S.currentEntry) {
          if (!S.currentEntry.content) S.currentEntry.content = [];
          S.currentEntry.content.push(...newMsgPair);
        } else {
          S.currentEntry = { url: payloadUrl, title: payloadTitle || payloadUrl, context: [], content: newMsgPair };
        }
        S.suppressHistoryRender = true;
        chrome.runtime.sendMessage({
          type: 'HISTORY_SAVE',
          payload: {
            url: payloadUrl, title: payloadTitle || payloadUrl,
            userMessage: text, aiReply: markedReply,
            contextTexts: snapshotSels.map(s => s.text),
            contextRefs: traceSrcs.map((ts, i) => ({
              id: snapshotSels[i] ? snapshotSels[i].id : undefined,
              text: snapshotSels[i] ? snapshotSels[i].text : ts.text,
              context: snapshotSels[i] ? snapshotSels[i].context : ts.text,
              url: ts.url, title: ts.title,
            })),
            searchSources: rawResults,
          },
        }, () => { S.suppressHistoryRender = false; syncToDir().catch(() => {}); });
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
    S.currentPort = null;
    el.chatInp.disabled = false;
    el.chatSend.textContent = '\u25b6';
    el.chatSend.title = 'Send (Enter)';
    el.chatInp.focus();
  }
}

function appendSearchResult(summary, sources, query) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant search-result-msg';

  const hdr = document.createElement('div');
  hdr.className = 'search-result-header';
  hdr.textContent = '\ud83d\udd0d ' + query;
  wrap.appendChild(hdr);

  const content = document.createElement('span');
  content.className = 'msg-content';

  // Render summary markdown, then replace [N] with clickable superscripts
  let html = renderMarkdown(summary);
  html = html.replace(/\[(\d+)\]/g, function(_, n) {
    const idx = parseInt(n, 10) - 1;
    const src = sources && sources[idx];
    const titleAttr = src ? escAttr(src.title || src.url) : '';
    const urlAttr   = src ? escAttr(src.url) : '';
    return '<sup class="search-cite" data-url="' + urlAttr + '" title="' + titleAttr + '">[' + n + ']</sup>';
  });
  content.innerHTML = html;

  // Wire superscript citation clicks to open source URL
  content.querySelectorAll('.search-cite[data-url]').forEach(sup => {
    sup.addEventListener('click', () => {
      const url = sup.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });
  wrap.appendChild(content);

  // Collapsible SOURCES block (reuse trace-footnotes styles)
  if (sources && sources.length) {
    const fnWrap = document.createElement('div');
    fnWrap.className = 'trace-footnotes';
    const toggle = document.createElement('button');
    toggle.className = 'trace-fn-toggle';
    toggle.textContent = 'SOURCES (' + sources.length + ')';
    const body = document.createElement('div');
    body.className = 'trace-fn-body';
    body.style.display = 'none';
    toggle.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      toggle.classList.toggle('open', !open);
    });
    sources.forEach((src, i) => {
      const row = document.createElement('div');
      row.className = 'trace-fn-row';
      const num = document.createElement('span');
      num.className = 'trace-fn-num';
      num.textContent = (i + 1) + '.';
      const lnk = document.createElement('a');
      lnk.href = '#';
      lnk.className = 'search-src-link';
      lnk.textContent = src.title || src.url;
      lnk.title = src.url;
      lnk.addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: src.url }); });
      row.appendChild(num);
      row.appendChild(lnk);
      body.appendChild(row);
    });
    fnWrap.appendChild(toggle);
    fnWrap.appendChild(body);
    wrap.appendChild(fnWrap);
  }

  el.chatMessages.appendChild(wrap);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function backToList() {
  LOG('backToList called; S.view=', S.view, '| floatHandoffBusy=', !!S.floatHandoffBusy,
      '| caller=', (new Error().stack.split('\n')[2] || '').trim().slice(0, 80));
  S.selectedUrls.clear();
  document.body.className = '';
  showListView();
}

function normText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function textHash(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(36);
}

function tokenizeLocal(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = lower.match(/\w+/g) || [];
  const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  let m;
  while ((m = cjkRe.exec(lower)) !== null) {
    tokens.push(m[0]);
    const next = lower[m.index + 1];
    if (next && /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(next)) tokens.push(m[0] + next);
  }
  return tokens;
}

function buildLocalChunks(text, title) {
  const clean = normText(text);
  if (!clean) return [];
  const chunks = [];
  const size = 900, overlap = 140;
  for (let start = 0; start < clean.length; start += size - overlap) {
    const part = clean.slice(start, start + size).trim();
    if (part.length < 40) continue;
    const idx = chunks.length;
    chunks.push({
      idx,
      textFull: part,
      textPreview: part.slice(0, 650),
      text: part.slice(0, 650),
      headingPath: title || 'Page',
      positionRatio: clean.length ? start / clean.length : 0,
      tagName: 'text',
      prevIdx: idx > 0 ? idx - 1 : null,
      nextIdx: null,
      hash: textHash(part),
    });
    if (idx > 0) chunks[idx - 1].nextIdx = idx;
  }
  return chunks;
}

function selectLocalChunks(chunks, query, charBudget) {
  const qTokens = tokenizeLocal(query);
  const exact = normText(query).toLowerCase();
  const scored = chunks.map(function(c) {
    const text = (c.textFull || c.text || '').toLowerCase();
    const heading = (c.headingPath || '').toLowerCase();
    let score = 0;
    qTokens.forEach(function(t) {
      if (t.length < 2) return;
      if (text.indexOf(t) !== -1) score += 2;
      if (heading.indexOf(t) !== -1) score += 3;
    });
    if (exact && text.indexOf(exact) !== -1) score += 8;
    return { idx: c.idx, score };
  }).sort(function(a, b) { return b.score - a.score; });
  const selected = new Set();
  let chars = 0;
  scored.forEach(function(s) {
    if (s.score <= 0 || chars >= charBudget) return;
    selected.add(s.idx);
    chars += (chunks[s.idx].text || '').length;
  });
  [0.15, 0.35, 0.5, 0.65, 0.85].forEach(function(r) {
    if (chars >= charBudget) return;
    const idx = Math.min(chunks.length - 1, Math.floor(chunks.length * r));
    if (idx >= 0 && chunks[idx] && !selected.has(idx)) {
      selected.add(idx);
      chars += (chunks[idx].text || '').length;
    }
  });
  return Array.from(selected).sort(function(a, b) { return a - b; });
}

function splitEvidenceSegments(text) {
  const parts = normText(text).match(/[^.!?。！？]+[.!?。！？]?/g) || [normText(text)];
  return parts.map(s => s.trim()).filter(s => s.length >= 30);
}

function buildContextPacket(pageText, question, effort, title) {
  const safeEffort = normalizeEffort(effort);
  const budget = EFFORT_BUDGETS[safeEffort] || EFFORT_BUDGETS.instant;
  const chunks = buildLocalChunks(pageText, title);
  const idxs = selectLocalChunks(chunks, question, budget.evidenceChars);
  const candidateSpans = [];
  let chars = 0;
  idxs.forEach(function(idx) {
    const c = chunks[idx];
    if (!c || chars >= budget.evidenceChars) return;
    splitEvidenceSegments(c.textFull || c.text).slice(0, 2).forEach(function(seg) {
      if (chars >= budget.evidenceChars) return;
      const evidence = seg.slice(0, 260);
      candidateSpans.push({
        spanId: 's' + candidateSpans.length,
        chunkIdx: c.idx,
        evidence,
        headingPath: c.headingPath,
        positionRatio: c.positionRatio,
        score: 0.65,
      });
      chars += evidence.length;
    });
  });
  const pageMap = chunks.filter(function(c, i) { return i === 0 || i % Math.max(1, Math.floor(chunks.length / 8)) === 0; })
    .slice(0, 10)
    .map(function(c) { return '[' + Math.round(c.positionRatio * 100) + '%] ' + c.headingPath; })
    .join('\n');
  const middleAnchors = [];
  const start = Math.floor(chunks.length * 0.28);
  const end = Math.max(start + 1, Math.floor(chunks.length * 0.78));
  const span = Math.max(1, end - start);
  for (let i = 0; i < budget.middleAnchors; i++) {
    const c = chunks[Math.min(chunks.length - 1, start + Math.floor(span * (i + 0.5) / budget.middleAnchors))];
    if (c) middleAnchors.push('[' + Math.round(c.positionRatio * 100) + '%] ' + c.headingPath + ' | ' + normText(c.textFull).slice(0, 240));
  }
  return { chunks, candidateSpans, pageMap, middleAnchors: middleAnchors.join('\n') };
}

//  Chat send 
async function sendChatMessage() {
  const rawText = el.chatInp.value.trim();
  if (!rawText || S.chatBusy) return;
  hideAtHint();
  const { cleanText, resolvedCtxs, presetInstruction, presetKey } = parseInput(rawText);
  const text = cleanText;

  // Merge legacy pending + resolved @ctxId selections
  const allSels = [...S.pendingSelections];
  resolvedCtxs.forEach(s => { if (!allSels.find(x => x.text === s.text)) allSels.push(s); });

  // Req 1: if no new context declared, reuse last-used context
  if (allSels.length === 0 && S.lastCtxSels.length > 0) {
    S.lastCtxSels.forEach(s => allSels.push(s));
  }

  // Phase 0-A: full page text — sent only when cached via deep mode (cache-optimized path only)
  const pageCtxCache = S.pageHtmlCache[S.currentUrl] || null;
  const pageCtxText = pageCtxCache ? pageCtxCache.text : null;
  const contextPacket = pageCtxText
    ? buildContextPacket(pageCtxText, text, S.effort, S.currentTitle || S.currentUrl)
    : buildContextPacket(allSels.map(s => s.context || s.text).join('\n\n'), text, S.effort, S.currentTitle || S.currentUrl);

  // Deduplicate: if a selection is identical to the cached page text it's redundant (already in system)
  let dedupedSels = pageCtxText
    ? allSels.filter(s => s.text !== pageCtxText)
    : allSels.slice();

  S.chatBusy = true;
  el.chatInp.value = '';
  el.chatInp.style.height = '';
  updateMirror();
  el.chatInp.disabled = true;
  el.chatSend.textContent = '\u25a0';
  el.chatSend.title = 'Stop (click to abort)';

  // Phase 0-C: use resume summary to trim history when available
  const resumeSummary = S.resumeCache[S.currentUrl] || null;

  // Phase 0-B: consume accumulated SPA page delta from content script
  let pageDeltaText = null;
  try {
    const deltaSess = await new Promise(r => chrome.storage.session.get('cwaPageDelta', r));
    if (deltaSess.cwaPageDelta && deltaSess.cwaPageDelta.url === (S.currentUrl || '')) {
      pageDeltaText = deltaSess.cwaPageDelta.text || null;
      chrome.storage.session.remove('cwaPageDelta');
    }
  } catch(_) {}

  // /search preset: 3-step flow (keywords → DDG → streaming answer)
  if (presetKey === 'search') {
    return runSearchFlow(text, dedupedSels, pageCtxText, resumeSummary, pageDeltaText);
  }

  const tsEl = document.createElement('div');
  tsEl.className = 'msg-ts';
  tsEl.textContent = fmtTime(Date.now());
  el.chatMessages.appendChild(tsEl);
  appendMsgEl('user', text, false, null);

  const entry    = S.currentEntry;
  // Phase 0-C: when resume summary exists, only keep last 2 turns to reduce token cost
  const rawMsgs = entry && entry.content || [];
  const msgSlice = resumeSummary ? rawMsgs.slice(-4) : rawMsgs.slice(-20);
  const histMsgs = msgSlice.map(m => ({ role: m.role, content: m.message }));

  const payload = {
    prompt:     text,
    url:        (entry && entry.url)   || S.currentUrl,
    meta:       { title: (entry && entry.title) || S.currentTitle || '', description: '' },
    selections: dedupedSels.map(s => ({ text: s.text, context: s.context || s.text })),
    messages:   histMsgs,
    model:      S.model,
    effort:     S.effort,
    presetInstruction: presetInstruction || null,
    pageContext: pageCtxText,   // full page text → system-level caching, not repeated in user messages
    pageMap: contextPacket.pageMap || undefined,
    middleAnchors: contextPacket.middleAnchors || undefined,
    candidateSpans: contextPacket.candidateSpans || undefined,
    resumeSummary: resumeSummary || undefined,  // Phase 0-C
    pageDelta: pageDeltaText || undefined,       // Phase 0-B
  };

  const snapshotSels = dedupedSels.slice();
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
      S.currentPort = port;
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
        // Build CITED panel from any <src> evidence spans in the final reply
        buildInlineSrcPanel(aiDiv);
        // Super Ctrl+F: auto-highlight quoted matches returned by /find
        if (presetKey === 'find' && reply) {
          const quotes = [];
          const qRe = /"([^"]{5,200})"/g;
          let qm;
          while ((qm = qRe.exec(reply)) !== null) quotes.push(qm[1]);
          if (quotes.length) {
            chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
              if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'HIGHLIGHT_TRACES', snippets: quotes }).catch(() => {});
            });
          }
        }
        if (snapshotSels.length) appendCtxFooter(aiDiv, snapshotSels);
        aiDiv._originalText = reply;
        aiDiv._retryPayload = Object.assign({}, payload, { messages: histMsgs });
        aiDiv._userText = text;
        const traceSources = pageCtxText
          ? [{ text: pageCtxText, chunks: contextPacket.chunks, url: S.currentUrl, title: S.currentTitle || S.currentUrl }]
          : traceSrcs;
        if (S.effort !== 'instant') attachTraceButton(aiDiv, reply, traceSources);
        el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
        if (snapshotSels.length > 0) S.lastCtxSels = snapshotSels.slice();
        // Update S.currentEntry immediately so subsequent messages use fresh history
        const newMsgPair = [
          { timestamp: Date.now(), role: 'user', message: text, context: snapshotSels.map(s => s.text).filter(Boolean).join(' | ') },
          { timestamp: Date.now() + 1, role: 'assistant', message: reply, context: '', contextRefs: traceSrcs.map((ts, i) => ({ id: snapshotSels[i] ? snapshotSels[i].id : undefined, text: snapshotSels[i] ? snapshotSels[i].text : ts.text, context: snapshotSels[i] ? snapshotSels[i].context : ts.text, url: ts.url, title: ts.title })) },
        ];
        if (S.currentEntry) {
          if (!S.currentEntry.content) S.currentEntry.content = [];
          S.currentEntry.content.push(...newMsgPair);
          LOG('DEBUG sendChat: updated S.currentEntry.content length=', S.currentEntry.content.length);
        } else {
          S.currentEntry = { url: payload.url, title: S.currentTitle || payload.url, context: [], content: newMsgPair };
          LOG('DEBUG sendChat: created new S.currentEntry for url=', payload.url);
        }
        // Suppress onHistoryChanged re-render: DOM and S.currentEntry are already updated locally
        S.suppressHistoryRender = true;
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
        }, () => { S.suppressHistoryRender = false; syncToDir().catch(() => {}); });
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
    S.currentPort = null;
    el.chatInp.disabled = false;
    el.chatSend.textContent = '\u25b6';
    el.chatSend.title = 'Send (Enter)';
    el.chatInp.focus();
  }
}

function abortCurrentStream() {
  if (S.currentPort) {
    try { S.currentPort.disconnect(); } catch(_) {}
    S.currentPort = null;
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
    b.title = cwaGetProviderConfig(S.provider).label + ' model: ' + S.model + '. Click to choose provider/model.';
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
  // Extract <src>…</src> evidence spans before HTML escaping
  const srcSpans = [];
  t = t.replace(/<src(?:\s+id=["']?([^"'>\s]+)["']?)?>([\s\S]*?)<\/src>/gi, (_, id, s) => {
    srcSpans.push(s.trim());
    return '\x00SRC' + (srcSpans.length - 1) + '\x00';
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
  // Restore <src> spans as ⁺ superscripts — clickable to highlight on page
  if (srcSpans.length) {
    t = t.replace(/\x00SRC(\d+)\x00/g, (_, i) => {
      const ev = srcSpans[+i];
      return '<sup class="inline-src" data-ev="' + escAttr(ev) + '" title="' + escAttr(ev) + '">&#x2B;</sup>';
    });
  }
  // [SEARCH: query] → pill button that triggers in-panel web search (no external redirect)
  t = t.replace(/\[SEARCH:\s*([^\]]{3,120})\]/gi, (_, q) => {
    const display = q.trim();
    const raw = display.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return '<a class="search-link" href="#" data-search-query="' + escAttr(raw) + '">&#128269; ' + display + '</a>';
  });
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
