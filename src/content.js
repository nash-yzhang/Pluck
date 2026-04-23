// content.js  Pluck v2.0
// Selection capture + hotkey bridge. All UI lives in the side panel.
// Alt+`   toggle side panel
// Alt+1   enter visual-select mode; pick one element → new context entry → auto-exit
// Alt+2   element-pick + clipboard copy  (NO side panel, NO history)

(function () {
  'use strict';
  if (window.__CWA_LOADED__) return;
  window.__CWA_LOADED__ = true;

  const VER  = '1.5.0';
  const LOG  = (...a) => console.log('%c[CWA]', 'color:#4dfa9a;font-weight:bold', ...a);
  const ERR  = (...a) => console.error('[CWA]', ...a);

  // State
  const S = {
    visualMode: false,
    copyMode:   false,
  };

  function openSidePanel(goChat) {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', goChat: !!goChat }).catch(() => {});
  }
  function toggleSidePanel() {
    chrome.runtime.sendMessage({ type: 'TOGGLE_SIDE_PANEL' }).catch(() => {});
  }

  // ── Visual feedback toast ──────────────────────────────────────────────
  function showSelToast(text, isAppend) {
    const t = document.createElement('div');
    t.style.cssText = [
      'position:fixed', 'bottom:22px', 'right:22px', 'z-index:2147483647',
      'background:#161616', 'color:#4dfa9a', 'font:bold 11px/1.5 monospace',
      'padding:7px 14px', 'border-radius:4px', 'border:1px solid #4dfa9a',
      'max-width:290px', 'word-break:break-word', 'pointer-events:none',
      'box-shadow:0 2px 12px rgba(0,0,0,.6)', 'transition:opacity .3s',
    ].join(';');
    t.textContent = (isAppend ? '+ Added: ' : '✓ Selected: ') +
      text.slice(0, 55) + (text.length > 55 ? '…' : '');
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 1800);
  }

  // Visual mode helpers
  const HIGHLIGHT_COLOR = '#ffcc44';
  let _hoverEl = null;
  let _highlightedEls = [];

  function applyHL(el, css) {
    if (!el || el === document.documentElement || el === document.body) return;
    // Only snapshot the original style once — re-calls must not overwrite it,
    // otherwise removeHL would restore to a state that already has our outline.
    if (el.__cwa_prev__ === undefined) el.__cwa_prev__ = el.style.cssText;
    // Always replace on top of the original (no accumulation of duplicate rules).
    el.style.cssText = (el.__cwa_prev__ || '') + ';' + css;
  }
  function removeHL(el) {
    if (!el || el.__cwa_prev__ === undefined) return;
    el.style.cssText = el.__cwa_prev__ || '';
    delete el.__cwa_prev__;
  }
  function clearHighlights() {
    _highlightedEls.forEach(el => {
      if (el.__cwa_text_span__) {
        const p = el.parentNode;
        if (p) { while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); p.normalize(); }
      } else { removeHL(el); }
    });
    _highlightedEls = [];
  }

  let _selectionStyle = null;
  function setVisualSelectionStyle(active) {
    if (active && !_selectionStyle) {
      _selectionStyle = document.createElement('style');
      _selectionStyle.id = '__cwa_sel_style__';
      _selectionStyle.textContent = '::selection{background:#ffcc44 !important;color:#000 !important;} ::-moz-selection{background:#ffcc44 !important;color:#000 !important;}';
      document.head.appendChild(_selectionStyle);
    } else if (!active && _selectionStyle) {
      _selectionStyle.remove();
      _selectionStyle = null;
    }
  }

  document.addEventListener('mouseover', function(e) {
    if (!S.visualMode && !S.copyMode) return;
    const target = e.target;
    if (_hoverEl && _hoverEl !== target) { removeHL(_hoverEl); _hoverEl = null; }
    _hoverEl = target;
    applyHL(target, `outline:2px solid ${HIGHLIGHT_COLOR} !important;outline-offset:2px !important;cursor:crosshair !important;`);
  }, true);
  document.addEventListener('mouseout', function(e) {
    if (!S.visualMode && !S.copyMode) return;
    if (e.target === _hoverEl) { removeHL(_hoverEl); _hoverEl = null; }
  }, true);

  let _click = { x: 0, y: 0, moved: false, el: null };
  document.addEventListener('mousedown', function(e) {
    if (!S.visualMode && !S.copyMode) return;
    _click = { x: e.clientX, y: e.clientY, moved: false, el: e.target };
    if (_hoverEl) {
      removeHL(_hoverEl);
      applyHL(_hoverEl, `outline:2px dashed #336633 !important;outline-offset:2px !important;cursor:crosshair !important;`);
    }
    setVisualSelectionStyle(true);
  }, true);
  document.addEventListener('mousemove', function(e) {
    if (!_click.el) return;
    const d = Math.hypot(e.clientX - _click.x, e.clientY - _click.y);
    if (d > 3) _click.moved = true;
  }, true);
  document.addEventListener('mouseup', function(e) {
    if (!S.visualMode && !S.copyMode) { _click = {}; return; }
    const selObj  = window.getSelection();
    const selText = selObj && selObj.toString().trim();

    if (_hoverEl) {
      removeHL(_hoverEl);
      applyHL(_hoverEl, `outline:2px solid ${HIGHLIGHT_COLOR} !important;outline-offset:2px !important;cursor:crosshair !important;`);
    }
    setVisualSelectionStyle(false);

    let captured = null;
    let elementPick = false;
    if (selText && _click.moved) {
      const parentEl = selObj.anchorNode && selObj.anchorNode.parentElement;
      const ctx = parentEl ? (parentEl.innerText || parentEl.textContent || '').trim() : selText;
      captured = { text: selText, context: ctx };
    } else if (!_click.moved && _click.el && !selText) {
      const el   = e.target === _click.el ? e.target : _click.el;
      const text = (el.innerText || el.textContent || '').trim();
      if (text) { captured = { text, context: text }; elementPick = true; }
    }
    _click = {};
    if (!captured) return;

    if (S.copyMode) {
      const textWithUrl = captured.text + '\n\n[Source: ' + location.href + ']';
      navigator.clipboard.writeText(textWithUrl).catch(err => ERR('copy failed', err));
      showSelToast('Copied with URL', false);
      exitCopyMode();
      return;
    }
    if (S.visualMode) {
      chrome.runtime.sendMessage({
        type: 'SEL_NEW',
        payload: { text: captured.text, url: location.href, title: document.title, elementPick },
      }).catch(() => {});
      showSelToast(captured.text, false);
      exitVisualMode();
    }
  }, true);

  function exitCopyMode() {
    S.copyMode = false;
    if (_hoverEl) { removeHL(_hoverEl); _hoverEl = null; }
    clearHighlights();
    document.documentElement.style.cursor = '';
  }
  function exitVisualMode() {
    S.visualMode = false;
    if (_hoverEl) { removeHL(_hoverEl); _hoverEl = null; }
    clearHighlights();
  }

  // Right-click exits visual/copy mode
  document.addEventListener('contextmenu', function(e) {
    if (S.visualMode || S.copyMode) {
      e.preventDefault();
      if (S.visualMode) exitVisualMode();
      if (S.copyMode)   exitCopyMode();
    }
  }, true);

  document.addEventListener('keydown', function(e) {
    // Alt+S or Alt+` — toggle sidebar
    // Alt+S matches the manifest suggested_key; Alt+` kept as fallback if manually registered.
    const isToggle = e.altKey && !e.ctrlKey && !e.shiftKey &&
                     (e.code === 'KeyS' || e.code === 'Backquote');
    if (isToggle) {
      LOG('DEBUG keydown toggle: e.code=', e.code, 'e.key=', e.key, 'altKey=', e.altKey,
          'ctrlKey=', e.ctrlKey, 'shiftKey=', e.shiftKey, 'metaKey=', e.metaKey,
          '| url=', location.href.slice(0, 60));
      LOG('DEBUG toggle: sending TOGGLE_SIDE_PANEL to background (⚠ onMessage cannot call sidePanel.open — only closes side)');
      e.preventDefault(); toggleSidePanel(); return;
    }
    // Alt+1 — enter visual-select mode (creates new context entry)
    // On PDFs, just open sidebar to trigger text extraction
    if (e.altKey && !e.ctrlKey && e.code === 'Digit1') {
      e.preventDefault();
      const isPdf = location.href.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
      if (isPdf) {
        openSidePanel(true);
        return;
      }
      if (S.visualMode) { exitVisualMode(); return; }
      S.visualMode = true;
      openSidePanel(true);
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'Digit2') {
      e.preventDefault();
      const isPdf = location.href.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
      if (isPdf) return; // Copy mode not supported on PDFs
      if (S.copyMode) { exitCopyMode(); return; }
      const pageSel = window.getSelection();
      const txt = pageSel && pageSel.toString().trim();
      if (txt) { navigator.clipboard.writeText(txt).catch(err => ERR('copy failed', err)); return; }
      S.copyMode = true;
      document.documentElement.style.cursor = 'crosshair';
      return;
    }
    if (e.key === 'Escape') {
      if (S.visualMode) exitVisualMode();
      if (S.copyMode)   exitCopyMode();
    }
  }, true);

  // Req 4: toggle visual-select mode when messaged from sidepanel (Alt+1 while sidebar focused)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_VISUAL_MODE') {
      if (S.visualMode) { exitVisualMode(); }
      else { S.visualMode = true; }
    }
    if (msg.type === 'HIGHLIGHT_TRACES') { applyTraceHighlights(msg.snippets); }
    if (msg.type === 'CLEAR_TRACE_HIGHLIGHTS') { clearTraceHighlights(); }
  });

  // ── Trace text highlights ────────────────────────────────────────────────
  let _traceHighlights = [];
  function applyTraceHighlights(snippets) {
    clearTraceHighlights();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const toWrap = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      for (const snippet of snippets) {
        if (!snippet || snippet.length < 5) continue;
        const needle = snippet.slice(0, 80).toLowerCase();
        const idx = text.toLowerCase().indexOf(needle);
        if (idx !== -1) { toWrap.push({ node, start: idx, len: needle.length }); break; }
      }
    }
    let scrolled = false;
    toWrap.forEach(({ node, start, len }) => {
      try {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, Math.min(start + len, node.textContent.length));
        const mark = document.createElement('mark');
        mark.className = 'cwa-trace-hl';
        mark.style.cssText = 'background:#ffe066 !important;color:#000 !important;border-radius:2px;outline:1px solid #ffaa00;';
        range.surroundContents(mark);
        _traceHighlights.push(mark);
        if (!scrolled) { mark.scrollIntoView({ behavior: 'smooth', block: 'center' }); scrolled = true; }
      } catch(e) {}
    });
  }
  function clearTraceHighlights() {
    _traceHighlights.forEach(mark => {
      if (mark.parentNode) {
        while (mark.firstChild) mark.parentNode.insertBefore(mark.firstChild, mark);
        mark.parentNode.removeChild(mark);
      }
    });
    _traceHighlights = [];
    document.querySelectorAll('.cwa-trace-hl').forEach(m => {
      if (m.parentNode) { while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m); m.parentNode.removeChild(m); }
    });
  }

  console.log('%c[CWA]', 'color:#4dfa9a;font-weight:bold', 'loaded v' + VER + ' on', location.href);
})();
