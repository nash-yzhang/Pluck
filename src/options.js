var providerApiKeys = {};
var providerModels = {};
var presets = {};

var DEFAULT_PRESETS = {
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

// ── i18n ──────────────────────────────────────────────────────────────────────
var _lang = 'en';
var _t = (typeof cwaT === 'function') ? cwaT('en') : {};

function applyI18n(lang, rerender) {
  _lang = lang;
  _t = cwaT(lang);

  var $ = function(id) { return document.getElementById(id); };

  $('page-title').textContent = _t.pageTitle;
  $('about-blurb').innerHTML  = _t.aboutLine1 + '<br>' + _t.aboutLine2Pre + ' <em>' + _t.aboutLine2Em + '</em> ' + _t.aboutLine2Post;
  $('lang-label').textContent  = _t.langLabel;
  $('lang-en').classList.toggle('active', lang === 'en');
  $('lang-zh').classList.toggle('active', lang === 'zh');

  $('section-api').textContent     = _t.sectionApi;
  $('label-provider').textContent  = _t.labelProvider;
  $('hint-provider').textContent   = _t.hintProvider;
  $('label-model').textContent     = _t.labelModel;
  $('hint-model').textContent      = _t.hintModel;
  $('toggleKey').textContent       = $('apiKey').type === 'password' ? _t.showKey : _t.hideKey;
  $('save').textContent            = _t.saveBtn;

  $('section-presets').textContent   = _t.sectionPresets;
  $('hint-presets').textContent      = _t.hintPresets;
  $('new-preset-name').placeholder   = _t.presetNamePh;
  $('new-preset-body').placeholder   = _t.presetBodyPh;
  $('save-presets').textContent      = _t.savePresetsBtn;
  $('reset-presets').textContent     = _t.resetPresetsBtn;
  $('add-preset').textContent        = _t.addBtn;

  $('section-data').textContent      = _t.sectionData;
  $('hint-data').textContent         = _t.hintData;
  $('label-sync-folder').textContent = _t.labelSyncFolder;
  $('sync-dir-path').placeholder     = _t.syncDirPh;
  $('pick-dir').textContent          = _t.pickDirBtn;
  $('hint-sync-folder').textContent  = _t.hintSyncFolder;
  $('export-json').textContent       = _t.exportBtn;
  $('import-json').textContent       = _t.importBtn;

  $('setup-title').textContent  = _t.setupTitle;
  $('setup-text').textContent   = _t.setupText;
  $('setup-text2').innerHTML    = _t.setupText2Pre + ' <em>' + _t.setupText2Em + '</em> ' + _t.setupText2Post;
  $('setup-pick-dir').textContent = _t.setupPickBtn;
  $('setup-footer').innerHTML   = _t.setupFooter + '<br>' + _t.setupFooter2;

  if (rerender) {
    renderPresets();
  }
}

// ── SETUP: Enforce data folder selection on first use ─────────────────────────
var _dirHandle = null;

async function checkAndEnforceSetup() {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('pluck_idb', 2);
    req.onupgradeneeded = e => { const db = e.target.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    req.onsuccess = e => res(e.target.result);
    req.onerror = () => rej();
  });

  const handle = await new Promise((res) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get('dirHandle');
    req.onsuccess = e => res(e.target.result || null);
  });

  if (!handle) {
    document.getElementById('setup-modal').classList.add('active');
  } else {
    _dirHandle = handle;
    document.getElementById('sync-dir-path').value = handle.name;
  }
}

document.getElementById('setup-pick-dir').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    saveDirHandle(handle);
    document.getElementById('setup-modal').classList.remove('active');
    showDataMsg(_t.setupDone, true);
  } catch (e) {
    if (e.name !== 'AbortError') showDataMsg(_t.folderError, false);
  }
});

window.addEventListener('DOMContentLoaded', checkAndEnforceSetup);

// ── Language toggle ────────────────────────────────────────────────────────────
document.getElementById('lang-en').addEventListener('click', function() {
  chrome.storage.sync.set({ cwaLanguage: 'en' }, function() { applyI18n('en', true); });
});
document.getElementById('lang-zh').addEventListener('click', function() {
  chrome.storage.sync.set({ cwaLanguage: 'zh' }, function() { applyI18n('zh', true); });
});

// ── Provider / model selectors ─────────────────────────────────────────────────
function populateProviderOptions() {
  var providerSel = document.getElementById('provider');
  providerSel.innerHTML = '';
  cwaListProviders().forEach(function(provider) {
    var cfg = cwaGetProviderConfig(provider);
    var opt = document.createElement('option');
    opt.value = provider;
    opt.textContent = cfg.label;
    providerSel.appendChild(opt);
  });
}

function populateModelOptions(provider, selectedModel) {
  var cfg = cwaGetProviderConfig(provider);
  var modelSel = document.getElementById('model');
  modelSel.innerHTML = '';
  cfg.models.forEach(function(model) {
    var opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    modelSel.appendChild(opt);
  });
  modelSel.value = cfg.models.indexOf(selectedModel) >= 0 ? selectedModel : cfg.defaultModel;
}

function renderProviderFields(provider, apiKeys, selectedModel) {
  var cfg = cwaGetProviderConfig(provider);
  document.getElementById('apiKeyLabel').textContent = cfg.keyLabel;
  document.getElementById('apiKey').placeholder = cfg.keyPlaceholder;
  document.getElementById('apiKey').value = (apiKeys && apiKeys[provider]) || '';
  document.getElementById('api-key-hint').textContent = cfg.keyHint;
  populateModelOptions(provider, selectedModel);
}

// ── Load saved settings ────────────────────────────────────────────────────────
populateProviderOptions();

chrome.storage.sync.get(['cwaApiKey', 'cwaApiKeys', 'cwaProvider', 'cwaModel', 'cwaLanguage'], function(r) {
  // Apply language first so all renders use correct strings
  applyI18n(r.cwaLanguage || 'en', false);

  var normalized = cwaNormalizeSettings({
    provider: r.cwaProvider,
    model: r.cwaModel,
    apiKeys: r.cwaApiKeys,
    apiKey: r.cwaApiKey,
  });
  providerApiKeys = Object.assign({}, normalized.apiKeys);
  providerModels[normalized.provider] = normalized.model;
  document.getElementById('provider').value = normalized.provider;
  document.getElementById('provider').setAttribute('data-prev-provider', normalized.provider);
  renderProviderFields(normalized.provider, normalized.apiKeys, normalized.model);
});

chrome.storage.sync.get(['cwaPresets'], function(r) {
  presets = Object.assign({}, DEFAULT_PRESETS, r.cwaPresets || {});
  renderPresets();
});

document.getElementById('provider').addEventListener('change', function() {
  var previousProvider = this.getAttribute('data-prev-provider') || cwaGetDefaultProvider();
  providerApiKeys[previousProvider] = document.getElementById('apiKey').value.trim();
  providerModels[previousProvider] = document.getElementById('model').value;

  var nextProvider = document.getElementById('provider').value;
  var normalized = cwaNormalizeSettings({
    provider: nextProvider,
    model: providerModels[nextProvider],
    apiKeys: providerApiKeys,
  });
  renderProviderFields(normalized.provider, providerApiKeys, normalized.model);
  this.setAttribute('data-prev-provider', normalized.provider);
});

document.getElementById('model').addEventListener('change', function() {
  providerModels[document.getElementById('provider').value] = this.value;
});

document.getElementById('apiKey').addEventListener('input', function() {
  providerApiKeys[document.getElementById('provider').value] = this.value.trim();
});

// ── Toggle API key visibility ──────────────────────────────────────────────────
document.getElementById('toggleKey').addEventListener('click', function() {
  var inp  = document.getElementById('apiKey');
  var show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  this.textContent = show ? _t.hideKey : _t.showKey;
});

// ── Save settings ──────────────────────────────────────────────────────────────
document.getElementById('save').addEventListener('click', function() {
  var provider = document.getElementById('provider').value;
  var key      = document.getElementById('apiKey').value.trim();
  var model    = document.getElementById('model').value;
  var normalized = cwaNormalizeSettings({
    provider: provider,
    model: model,
    apiKeys: providerApiKeys,
  });
  normalized.apiKeys[provider] = key;
  providerApiKeys = Object.assign({}, normalized.apiKeys);
  providerModels[provider] = model;
  chrome.storage.sync.set({
    cwaProvider: provider,
    cwaApiKeys: normalized.apiKeys,
    cwaModel: model,
  }, function() {
    var st = document.getElementById('status');
    st.textContent = _t.savedStatus;
    setTimeout(function() { st.textContent = ''; }, 2000);
  });
});

// ── Presets ────────────────────────────────────────────────────────────────────
var _presetsStatus = document.getElementById('presets-status');

function showPresetsMsg(msg, ok) {
  _presetsStatus.textContent = msg;
  _presetsStatus.style.color = ok ? '#4dfa9a' : '#ff6655';
  setTimeout(function() { _presetsStatus.textContent = ''; }, 2000);
}

function renderPresets() {
  var list = document.getElementById('presets-list');
  list.innerHTML = '';
  var keys = Object.keys(presets);
  if (keys.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:#555;padding:4px 0">No presets saved.</div>';
    return;
  }
  keys.forEach(function(name) {
    var row = document.createElement('div');
    row.className = 'preset-row';

    var header = document.createElement('div');
    header.className = 'preset-header';

    var nm = document.createElement('span');
    nm.className = 'preset-name';
    nm.textContent = '/' + name;

    var actions = document.createElement('span');
    actions.style.cssText = 'display:flex;gap:4px;align-items:center';

    if (DEFAULT_PRESETS[name]) {
      var resetBtn = document.createElement('button');
      resetBtn.className = 'preset-reset';
      resetBtn.textContent = _t.presetResetBtn || 'RESET';
      resetBtn.title = _t.presetResetTitle || 'Reset to default';
      actions.appendChild(resetBtn);
      row._resetBtn = resetBtn;
    }

    var del = document.createElement('span');
    del.className = 'preset-del';
    del.textContent = '×';
    del.title = _t.presetDelTitle || 'Delete';
    del.addEventListener('click', (function(n) {
      return function() {
        delete presets[n];
        // Save immediately to chrome.storage.sync
        chrome.storage.sync.set({ cwaPresets: presets }, function() {
          renderPresets();
        });
      };
    })(name));
    actions.appendChild(del);

    header.appendChild(nm);
    header.appendChild(actions);

    var ta = document.createElement('textarea');
    ta.className = 'preset-body';
    ta.value = presets[name];
    ta.spellcheck = false;
    ta.addEventListener('input', (function(n, t) {
      return function() {
        presets[n] = t.value;
        // Save immediately to chrome.storage.sync
        chrome.storage.sync.set({ cwaPresets: presets });
      };
    })(name, ta));

    if (row._resetBtn) {
      row._resetBtn.addEventListener('click', (function(n, t) {
        return function() {
          t.value = DEFAULT_PRESETS[n];
          presets[n] = DEFAULT_PRESETS[n];
          // Save immediately to chrome.storage.sync
          chrome.storage.sync.set({ cwaPresets: presets });
        };
      })(name, ta));
    }

    row.appendChild(header);
    row.appendChild(ta);
    list.appendChild(row);
  });
}

document.getElementById('save-presets').addEventListener('click', function() {
  chrome.storage.sync.set({ cwaPresets: presets }, function() {
    showPresetsMsg(_t.presetSaved || 'SAVED', true);
  });
});

document.getElementById('reset-presets').addEventListener('click', function() {
  if (!confirm(_t.confirmReset || 'Reset all presets to built-in defaults?')) return;
  presets = Object.assign({}, DEFAULT_PRESETS);
  chrome.storage.sync.set({ cwaPresets: presets }, function() {
    renderPresets();
    showPresetsMsg(_t.presetReset || 'RESET', true);
  });
});

document.getElementById('add-preset').addEventListener('click', function() {
  var name = document.getElementById('new-preset-name').value.trim().replace(/\s+/g, '-');
  var body = document.getElementById('new-preset-body').value.trim();
  if (!name || !body) return;
  presets[name] = body;
  document.getElementById('new-preset-name').value = '';
  document.getElementById('new-preset-body').value = '';
  // Save immediately to chrome.storage.sync and pluck_data.json
  chrome.storage.sync.set({ cwaPresets: presets }, function() {
    renderPresets();
    if (_dirHandle) {
      buildSnapshot(function(snapshot) {
        writeToDir(snapshot);
      });
    }
  });
});

// ── Data section: Export / Import / Directory picker ──────────────────────────
var _dataStatus = document.getElementById('data-status');

function showDataMsg(msg, ok) {
  _dataStatus.textContent = msg;
  _dataStatus.style.color = ok ? '#4dfa9a' : '#ff6655';
  setTimeout(function() { _dataStatus.textContent = ''; }, 3000);
}

function saveDirHandle(handle) {
  _dirHandle = handle;
  document.getElementById('sync-dir-path').value = handle.name;
  var req = indexedDB.open('pluck_idb', 2);
  req.onupgradeneeded = function(e) { var db = e.target.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
  req.onsuccess = function(e) {
    var db = e.target.result;
    var tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(handle, 'dirHandle');
    // After saving dir handle, immediately sync current data to pluck_data.json
    setTimeout(function() {
      buildSnapshot(function(snapshot) {
        writeToDir(snapshot);
      });
    }, 100);
  };
}

document.getElementById('pick-dir').addEventListener('click', async function() {
  try {
    var handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    saveDirHandle(handle);
    showDataMsg(_t.folderSelected(handle.name), true);
  } catch(e) {
    if (e.name !== 'AbortError') showDataMsg(_t.folderError, false);
  }
});

function buildSnapshot(cb) {
  chrome.storage.local.get(['cwaHistory', 'cwaCtxStore'], function(local) {
    chrome.storage.sync.get(['cwaProvider', 'cwaApiKeys', 'cwaModel', 'cwaDisplayDays', 'cwaPresets'], function(sync) {
      cb({
        version: 2,
        exportedAt: new Date().toISOString(),
        history:  local.cwaHistory  || { version: 1, entries: [] },
        ctxStore: local.cwaCtxStore || {},
        settings: {
          provider: sync.cwaProvider,
          apiKeys: sync.cwaApiKeys,
          model: sync.cwaModel,
          displayDays: sync.cwaDisplayDays,
          presets: sync.cwaPresets,
        },
      });
    });
  });
}

async function writeToDir(snapshot) {
  if (!_dirHandle) return;
  try {
    var perm = await _dirHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return;
    var fh  = await _dirHandle.getFileHandle('pluck_data.json', { create: true });
    var writable = await fh.createWritable();
    await writable.write(JSON.stringify(snapshot, null, 2));
    await writable.close();
  } catch(e) { console.warn('[Pluck] dir write failed', e); }
}

document.getElementById('export-json').addEventListener('click', function() {
  buildSnapshot(function(snapshot) {
    var blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href   = url;
    a.download = 'pluck_data_' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showDataMsg(_t.exportedMsg, true);
    if (_dirHandle) writeToDir(snapshot);
  });
});

document.getElementById('import-json').addEventListener('click', function() {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var data = JSON.parse(ev.target.result);
      if (!data.version) throw new Error('unrecognized format');
      var localSet = {};
      if (data.history)  localSet.cwaHistory  = data.history;
      if (data.ctxStore) localSet.cwaCtxStore = data.ctxStore;
      chrome.storage.local.set(localSet, function() {
        if (data.settings) {
          var syncSet = {};
          if (data.settings.provider)    syncSet.cwaProvider    = data.settings.provider;
          if (data.settings.apiKeys)     syncSet.cwaApiKeys     = data.settings.apiKeys;
          if (data.settings.model)       syncSet.cwaModel       = data.settings.model;
          if (data.settings.displayDays) syncSet.cwaDisplayDays = data.settings.displayDays;
          if (data.settings.presets)     syncSet.cwaPresets  = data.settings.presets;
          chrome.storage.sync.set(syncSet, function() {
            if (data.settings.presets) {
              presets = Object.assign({}, DEFAULT_PRESETS, data.settings.presets);
              renderPresets();
            }
          });
        }
        var ctxCount  = Object.keys(data.ctxStore || {}).length;
        var convCount = (data.history && data.history.entries || []).length;
        showDataMsg(_t.importedMsg(ctxCount, convCount), true);
      });
    } catch(err) {
      showDataMsg(_t.importFailPfx + err.message, false);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ── Search API settings ────────────────────────────────────────────────────────
chrome.storage.sync.get(['cwaSearchApiKey', 'cwaSearchProvider'], function(r) {
  if (r.cwaSearchProvider) document.getElementById('search-provider').value = r.cwaSearchProvider;
  if (r.cwaSearchApiKey)   document.getElementById('search-api-key').value  = r.cwaSearchApiKey;
});

document.getElementById('toggle-search-key').addEventListener('click', function() {
  var inp  = document.getElementById('search-api-key');
  var show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  this.textContent = show ? 'HIDE' : 'SHOW';
});

document.getElementById('save-search').addEventListener('click', function() {
  var provider = document.getElementById('search-provider').value;
  var key      = document.getElementById('search-api-key').value.trim();
  chrome.storage.sync.set({ cwaSearchProvider: provider, cwaSearchApiKey: key }, function() {
    var st = document.getElementById('search-status');
    st.textContent = 'SAVED';
    setTimeout(function() { st.textContent = ''; }, 2000);
  });
});
