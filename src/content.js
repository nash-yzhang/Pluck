// content.js  Pluck v2.0
// Selection capture + hotkey bridge. All UI lives in the side panel.
// Alt+`   toggle side panel (fallback; use Alt+K in manifest for proper gesture context)
// Alt+1   enter visual-select mode; pick one element → new context entry → auto-exit
// Alt+2   element-pick + clipboard copy  (NO side panel, NO history)
// Alt+S   find on page (floating panel with AI fallback)

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

  // Phase 0-A: Per-URL page text cache for FIND_ON_PAGE (avoids re-capture on repeat queries)
  const _pageTextCache = {};
  // Phase 1: DOM chunk cache — {idx, text, el}[] per URL; text for retrieval, el for highlighting
  const _pageChunkCache = {};
  // Phase 0-B: MutationObserver for SPA delta detection
  let _pageObserver = null;
  window.__cwa_delta__ = null;

  function openSidePanel(goChat, handoff) {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', goChat: !!goChat, handoff: handoff || null }).catch(() => {});
  }
  function isSidePanelOpen(cb) {
    try {
      if (chrome.storage && chrome.storage.session && chrome.storage.session.get) {
        chrome.storage.session.get('cwaSpOpen', function(d) {
          if (d && d.cwaSpOpen) { cb(true); return; }
          chrome.runtime.sendMessage({ type: 'IS_SIDE_PANEL_OPEN' }, function(resp) {
            cb(!!(resp && resp.open));
          });
        });
        return;
      }
    } catch(_) {}
    chrome.runtime.sendMessage({ type: 'IS_SIDE_PANEL_OPEN' }, function(resp) {
      cb(!!(resp && resp.open));
    });
  }
  function sendSelection(type, captured) {
    chrome.runtime.sendMessage({
      type: type,
      payload: {
        text: captured.text,
        context: captured.context || captured.text,
        url: location.href,
        title: document.title,
        elementPick: !!captured._el,
      },
    }).catch(() => {});
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
  // ── Selection highlight state machine ──────────────────────────────────
  // States:  idle → picking → locked → idle
  //   idle:    nothing active
  //   picking: Alt+1 active; hover shows ghost outline; drag colors text green
  //   locked:  element/text confirmed; solid green highlight; float is open
  //
  // Transitions:
  //   idle    + Alt+1             → picking
  //   picking + Alt+1 / Esc      → idle   (cancel, no highlight)
  //   picking + mouseup w/ pick  → locked (apply highlight, show float)
  //   locked  + Alt+1            → picking (start new pick, clears old HL)
  //   locked  + Esc / close btn  → idle   (clears HL)
  //   locked  + send/handoff     → idle   (clears HL before new locked is set)

  const SEL = (function() {
    const GHOST_CSS   = 'outline:1px solid rgba(77,250,154,0.35)!important;outline-offset:2px!important;cursor:crosshair!important;';
    const LOCKED_CSS  = 'outline:2px solid #4dfa9a!important;outline-offset:3px!important;box-shadow:0 0 0 4px rgba(77,250,154,0.10)!important;';
    const TEXT_HL_CSS = 'background:rgba(77,250,154,0.18)!important;color:inherit!important;' +
                        'text-decoration:underline!important;text-decoration-color:#4dfa9a!important;' +
                        'text-underline-offset:3px!important;outline:none!important;border-radius:2px!important;';
    let _state    = 'idle';
    let _hover    = null;   // ghosted element
    let _lockEl   = null;   // locked element
    let _lockPrev = '';     // its original style
    let _marks    = [];     // locked text <mark> nodes
    let _selStyle = null;   // <style> for drag ::selection color

    function _applyEl(el, css) {
      if (!el || el === document.documentElement || el === document.body) return;
      if (el.__cwa_orig__ === undefined) el.__cwa_orig__ = el.style.cssText;
      el.style.cssText = (el.__cwa_orig__ || '') + ';' + css;
    }
    function _restoreEl(el) {
      if (!el || el.__cwa_orig__ === undefined) return;
      el.style.cssText = el.__cwa_orig__ || '';
      delete el.__cwa_orig__;
    }
    function _clearHover() {
      if (_hover) { _restoreEl(_hover); _hover = null; }
    }
    function _clearLock() {
      if (_lockEl) { _lockEl.style.cssText = _lockPrev; _lockEl = null; _lockPrev = ''; }
      _marks.forEach(m => {
        const p = m.parentNode;
        if (p) { while (m.firstChild) p.insertBefore(m.firstChild, m); try { p.removeChild(m); p.normalize(); } catch(_){} }
      });
      _marks = [];
    }
    function _setDragStyle(on) {
      if (on && !_selStyle) {
        _selStyle = document.createElement('style');
        _selStyle.id = '__cwa_sel_style__';
        _selStyle.textContent = '::selection{background:rgba(77,250,154,0.35)!important;color:inherit!important}' +
                                '::-moz-selection{background:rgba(77,250,154,0.35)!important;color:inherit!important}';
        document.head.appendChild(_selStyle);
      } else if (!on && _selStyle) { _selStyle.remove(); _selStyle = null; }
    }

    return {
      get state() { return _state; },

      // Enter picking mode (Alt+1 from idle, or Alt+1 from locked to restart)
      startPicking() {
        _clearHover();
        _clearLock();
        _state = 'picking';
        S.visualMode = true;
        document.documentElement.style.cursor = 'crosshair';
      },

      // Cancel picking / dismiss lock — go to idle
      reset() {
        _clearHover();
        _clearLock();
        _setDragStyle(false);
        _state = 'idle';
        S.visualMode = false;
        document.documentElement.style.cursor = '';
      },

      // Ghost hover during picking
      hover(el) {
        if (_state !== 'picking') return;
        if (_hover === el) return;
        _clearHover();
        _hover = el;
        if (el) _applyEl(el, GHOST_CSS);
      },
      unhover(el) {
        if (_hover === el) _clearHover();
      },

      // Signal mousedown during drag — turn on green ::selection color
      dragStart() { if (_state === 'picking') _setDragStyle(true); },
      dragEnd()   { _setDragStyle(false); },

      // Lock element pick (solid outline)
      lockElement(el) {
        _clearHover();
        _clearLock();
        if (!el || el === document.documentElement || el === document.body) return;
        _lockEl   = el;
        _lockPrev = el.style.cssText;
        _applyEl(el, LOCKED_CSS);
        _state = 'locked';
        S.visualMode = false;
        document.documentElement.style.cursor = '';
      },

      // Lock text selection (underline+background mark)
      lockText() {
        _clearHover();
        _clearLock();
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) { _state = 'idle'; S.visualMode = false; document.documentElement.style.cursor = ''; return; }
        const marks = [];
        try {
          for (let i = 0; i < sel.rangeCount; i++) {
            const range = sel.getRangeAt(i);
            const mark = document.createElement('mark');
            mark.className = '__cwa_sel__';
            mark.style.cssText = TEXT_HL_CSS;
            try { range.surroundContents(mark); marks.push(mark); } catch (_) {
              // Range spans element boundaries — wrap each text node individually
              const frag = range.extractContents();
              mark.appendChild(frag);
              range.insertNode(mark);
              marks.push(mark);
            }
          }
          sel.removeAllRanges();
        } catch (_) {}
        _marks = marks;
        _state = 'locked';
        S.visualMode = false;
        document.documentElement.style.cursor = '';
      },
    };
  })();

  // ── Mouse event handlers (visual pick mode) ─────────────────────────────
  document.addEventListener('mouseover', function(e) {
    if (SEL.state !== 'picking') return;
    SEL.hover(e.target);
  }, true);
  document.addEventListener('mouseout', function(e) {
    if (SEL.state !== 'picking') return;
    SEL.unhover(e.target);
  }, true);

  let _click = { x: 0, y: 0, moved: false, el: null };
  document.addEventListener('mousedown', function(e) {
    if (SEL.state === 'picking') {
      _click = { x: e.clientX, y: e.clientY, moved: false, el: e.target };
      SEL.dragStart();
      return;
    }
    if (S.copyMode) { _click = { x: e.clientX, y: e.clientY, moved: false, el: e.target }; }
  }, true);
  document.addEventListener('mousemove', function(e) {
    if (!_click.el) return;
    if (Math.hypot(e.clientX - _click.x, e.clientY - _click.y) > 3) _click.moved = true;
  }, true);
  document.addEventListener('mouseup', function(e) {
    SEL.dragEnd();
    if (SEL.state !== 'picking' && !S.copyMode) { _click = {}; return; }

    const selObj  = window.getSelection();
    const selText = selObj && selObj.toString().trim();

    if (S.copyMode) {
      let text = selText;
      if (!text && _click.el) text = (_click.el.innerText || _click.el.textContent || '').trim();
      if (text) {
        navigator.clipboard.writeText(text + '\n\n[Source: ' + location.href + ']').catch(() => {});
        showSelToast('Copied with URL', false);
      }
      _click = {};
      exitCopyMode();
      return;
    }

    // Visual pick mode
    let captured = null;
    let appendMode = false;
    let isElement = false;
    if (e.shiftKey && _click.moved) {
      const rect = {
        left: Math.min(_click.x, e.clientX),
        right: Math.max(_click.x, e.clientX),
        top: Math.min(_click.y, e.clientY),
        bottom: Math.max(_click.y, e.clientY),
      };
      const candidates = document.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,figcaption,caption,article,section,div');
      const picked = [];
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom) continue;
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 12) picked.push(t);
        if (picked.length >= 10) break;
      }
      const joined = picked.join('\n\n').slice(0, 4000).trim();
      if (joined) {
        captured = { text: joined, context: joined, rect: { left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top } };
      }
    } else if (selText && _click.moved) {
      // Text drag selection
      const parentEl = selObj.anchorNode && selObj.anchorNode.parentElement;
      const ctx = parentEl ? (parentEl.innerText || parentEl.textContent || '').trim() : selText;
      const selRange = selObj.rangeCount > 0 ? selObj.getRangeAt(0) : null;
      captured = { text: selText, context: ctx, rect: selRange ? selRange.getBoundingClientRect() : null };
    } else if (!_click.moved && _click.el) {
      // Element click
      const el = e.target === _click.el ? e.target : _click.el;
      const text = (el.innerText || el.textContent || '').trim();
      if (text) {
        captured = { text, context: text, rect: el.getBoundingClientRect(), _el: el };
        isElement = true;
        appendMode = !!e.ctrlKey;
      }
    }
    _click = {};
    if (!captured) return;

    // Phase B: lock highlight
    if (isElement) { SEL.lockElement(captured._el); }
    else            { SEL.lockText(); }

    finishCapturedSelection(captured, captured.rect || null, appendMode);
  }, true);

  function finishCapturedSelection(captured, rect, appendMode) {
    showSelToast(captured.text, !!appendMode);
    isSidePanelOpen(function(opened) {
      if (opened) {
        sendSelection(appendMode ? 'SEL_APPEND' : 'SEL_NEW', captured);
        openSidePanel(true);
        if (!appendMode) SEL.reset();
      } else {
        let effectiveSel = captured.text;
        if (appendMode && _float.sel) {
          effectiveSel = (_float.sel + '\n\n' + captured.text).slice(0, 5000);
        }
        showAskFloat(rect, effectiveSel);
      }
    });
  }

  function exitCopyMode() {
    S.copyMode = false;
    document.documentElement.style.cursor = '';
  }
  // exitVisualMode kept as thin alias for compatibility (message handler, etc.)
  function exitVisualMode() { SEL.reset(); }
  // clearPersistHL alias for CLEAR_SEL_HL message handler
  function clearPersistHL() { SEL.reset(); }

  // Right-click cancels picking
  document.addEventListener('contextmenu', function(e) {
    if (SEL.state === 'picking') { e.preventDefault(); SEL.reset(); return; }
    if (S.copyMode) { e.preventDefault(); exitCopyMode(); }
  }, true);

  document.addEventListener('keydown', function(e) {
    const isToggle = e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'Backquote';
    if (isToggle) { e.preventDefault(); toggleSidePanel(); return; }

    if (e.altKey && !e.ctrlKey && e.code === 'Digit1') {
      e.preventDefault();
      const isPdf = location.href.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
      if (isPdf) { openSidePanel(true); return; }
      // Already-selected text → lock immediately and show float
      const pgSel = window.getSelection();
      const pgTxt = pgSel && pgSel.toString().trim();
      if (pgTxt && SEL.state === 'idle') {
        const pgRange = pgSel.rangeCount > 0 ? pgSel.getRangeAt(0) : null;
        SEL.lockText();
        finishCapturedSelection({ text: pgTxt, context: pgTxt }, pgRange ? pgRange.getBoundingClientRect() : null);
        return;
      }
      if (SEL.state === 'picking') { SEL.reset(); return; }  // Alt+1 again = cancel
      if (SEL.state === 'locked')  { SEL.startPicking(); return; }  // Alt+1 = new pick
      SEL.startPicking();
      return;
    }

    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'Digit2') {
      e.preventDefault();
      if (location.href.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')) return;
      if (S.copyMode) { exitCopyMode(); return; }
      const txt = window.getSelection() && window.getSelection().toString().trim();
      if (txt) { navigator.clipboard.writeText(txt).catch(() => {}); return; }
      S.copyMode = true;
      document.documentElement.style.cursor = 'crosshair';
      return;
    }

    if (e.key === 'Escape') {
      if (_find.visible)                                      { hideFindPanel(); return; }
      if (_float.panel && _float.panel.style.display !== 'none') { hideAskFloat(true); return; }
      if (SEL.state !== 'idle') { SEL.reset(); return; }
      if (S.copyMode) exitCopyMode();
    }
  }, true);

  // Req 4: toggle visual-select mode when messaged from sidepanel (Alt+1 while sidebar focused)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_FIND_PANEL') {
      if (_find.visible) { hideFindPanel(); } else { showFindPanel(); }
    }
    if (msg.type === 'FIND_CHUNK') { _applyFindChunk(msg.chunkIdx, msg.score, msg.searchId); }
    if (msg.type === 'FIND_DONE')  { _finalizeFindSearch(msg.searchId); }
    // AUTO_FIND: sidebar Q&A → BM25-only chunk highlights + sidebar badge navigation (zero LLM cost)
    // No find panel; scroll saved before first hit and restored on next Q&A / sidebar close / Alt+S.
    if (msg.type === 'AUTO_FIND') {
      // Restore previous scroll before starting fresh
      if (_autoFindSavedScroll !== null) {
        window.scrollTo({ top: _autoFindSavedScroll, behavior: 'instant' });
        _autoFindSavedScroll = null;
      }
      clearFindHighlights();
      _autoFindHits = [];
      _find.searchId++;
      _autoFindSearchId = _find.searchId;
      _find.suppressAutoNav = true;  // scroll managed manually per-hit below
      _doFindAI(msg.query, 2, _find.searchId, true);
    }
    // Scroll page to a specific AUTO_FIND chunk (sidebar badge click)
    if (msg.type === 'SCROLL_TO_CHUNK') {
      const _scChunks = _pageChunkCache[location.href];
      if (_scChunks && msg.chunkIdx >= 0 && msg.chunkIdx < _scChunks.length) {
        const _scEl = _scChunks[msg.chunkIdx].el;
        if (_scEl && _scEl.isConnected) {
          _scEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Temporary pulse highlight: visible for 2s then restored
          const _prevOutline = _scEl.style.outline;
          const _prevBg = _scEl.style.background;
          _scEl.style.outline = '2px solid #4dfa9a';
          _scEl.style.background = 'rgba(77,250,154,0.12)';
          setTimeout(function() {
            _scEl.style.outline = _prevOutline;
            _scEl.style.background = _prevBg;
          }, 2000);
        }
      }
    }
    // Restore scroll and clear highlights (triggered by: next Q&A, sidebar close, Alt+S)
    if (msg.type === 'RESTORE_SCROLL') {
      if (_autoFindSavedScroll !== null) {
        window.scrollTo({ top: _autoFindSavedScroll, behavior: 'smooth' });
        _autoFindSavedScroll = null;
      }
      clearFindHighlights();
      _autoFindHits = [];
    }
    if (msg.type === 'TOGGLE_VISUAL_MODE') {
      if (SEL.state === 'picking') { SEL.reset(); }
      else { SEL.startPicking(); }
    }
    if (msg.type === 'CLEAR_SEL_HL') { SEL.reset(); }
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

  // ── On-Page Find Panel (Alt+S) ─────────────────────────────────────────────
  // score 4=exact(yellow) 3=strict(green) 2=general(cyan) 1=broad(blue)
  // _findHighlights items: {type:'text',mark} | {type:'elem',el,origOutline,origBg,color}
  const _FC = [
    null,
    { bg: '#4488ff', fg: '#fff' },  // 1 broad
    { bg: '#00cccc', fg: '#000' },  // 2 general
    { bg: '#44cc77', fg: '#000' },  // 3 related
    { bg: '#ffe066', fg: '#000' },  // 4 exact/literal
  ];
  const _SL = ['literal', 'strict', 'related', 'general', 'broad'];

  const _find = {
    visible: false, panel: null, inp: null, counter: null,
    slider: null, statusEl: null, modeLabel: null, _debounce: null,
    searchId: 0, pos: null, lastQuery: '', minScore: 1,
    effort: 'instant',
    suppressAutoNav: false,  // true for AUTO_FIND from sidebar (no jarring scroll)
  };

  // Re-clamp find panel when Chrome side-panel open/close shrinks the viewport
  window.addEventListener('resize', function() {
    if (!_find.panel || _find.panel.style.display === 'none') return;
    const _PW = _find.panel.offsetWidth || 300;
    const maxX = Math.max(0, window.innerWidth - _PW - 4);
    const curX = parseInt(_find.panel.style.left) || 0;
    if (curX > maxX) {
      _find.panel.style.left = maxX + 'px';
      if (_find.pos) _find.pos.x = maxX;
    }
  });
  let _findHighlights = [];
  let _findActive = -1;

  // AUTO_FIND state — hits collected per sidebar Q&A, scroll position saved before first navigation
  let _autoFindHits = [];
  let _autoFindSearchId = -1;
  let _autoFindSavedScroll = null;

  function _navBtnCss() {
    return 'background:#1f1f23;border:1px solid #2a2a38;border-radius:3px;' +
           'color:#9090a0;font:11px monospace;padding:3px 6px;cursor:pointer;line-height:1;flex-shrink:0;';
  }

  function _filterTextNode(node) {
    const p = node.parentElement;
    if (!p) return NodeFilter.FILTER_REJECT;
    const t = (p.tagName || '').toLowerCase();
    if (['script','style','noscript','textarea','input'].indexOf(t) !== -1) return NodeFilter.FILTER_REJECT;
    let el = p;
    while (el) { if (el.id === '__cwa_find_panel__') return NodeFilter.FILTER_REJECT; el = el.parentElement; }
    return NodeFilter.FILTER_ACCEPT;
  }

  function createFindPanel() {
    if (_find.panel) return;
    const panel = document.createElement('div');
    panel.id = '__cwa_find_panel__';
    const _PW = 300;
    const _initX = _find.pos ? Math.min(_find.pos.x, window.innerWidth - _PW - 4)
                             : Math.max(4, window.innerWidth - _PW - 14);
    const _initY = _find.pos ? Math.max(4, _find.pos.y) : 8;
    panel.style.cssText =
      'position:fixed;top:' + _initY + 'px;left:' + _initX + 'px;z-index:2147483646;' +
      'background:rgba(16,16,22,0.90);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);will-change:backdrop-filter;' +
      'border:1px solid rgba(77,250,154,0.50);border-radius:8px;padding:6px 8px;display:flex;' +
      'flex-direction:column;gap:2px;font:12px/1 monospace;' +
      'box-shadow:0 4px 24px rgba(0,0,0,.55);width:' + _PW + 'px;';

    // ── Phase 1-A: Drag handle ──
    const dragHandle = document.createElement('div');
    dragHandle.style.cssText = 'width:100%;height:10px;cursor:grab;display:flex;align-items:center;justify-content:center;opacity:0.5;user-select:none;flex-shrink:0;';
    dragHandle.innerHTML = '<span style="display:block;width:32px;height:3px;border-radius:2px;background:#4dfa9a;"></span>';
    dragHandle.addEventListener('mousedown', function(de) {
      de.preventDefault();
      const offX = de.clientX - panel.offsetLeft, offY = de.clientY - panel.offsetTop;
      dragHandle.style.cursor = 'grabbing';
      function onMove(me) {
        const nx = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  me.clientX - offX));
        const ny = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, me.clientY - offY));
        panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
        _find.pos = { x: nx, y: ny };
      }
      function onUp() {
        dragHandle.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // ── Row 1: input + nav buttons ──
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = 'find on page\u2026';
    inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.style.cssText =
      'flex:1;background:#0c0c0e;border:1px solid #2a2a38;border-radius:3px;' +
      'color:#e8e8e8;font:12px monospace;padding:4px 8px;outline:none;min-width:0;';
    inp.addEventListener('focus', () => { inp.style.borderColor = '#4dfa9a'; });
    inp.addEventListener('blur',  () => { inp.style.borderColor = '#2a2a38'; });

    const counter = document.createElement('span');
    counter.style.cssText = 'font-size:10px;color:#9090a0;flex-shrink:0;min-width:40px;text-align:center;';

    function mkBtn(txt, title, onclick) {
      const b = document.createElement('button');
      b.textContent = txt; b.title = title;
      b.style.cssText = _navBtnCss();
      b.addEventListener('click', onclick);
      return b;
    }
    const closeBtn = mkBtn('\xd7', 'Close (Esc)', hideFindPanel);
    closeBtn.style.cssText = _navBtnCss() + 'color:#ff5e57;';
    row1.append(inp, counter,
      mkBtn('\u25b2', 'Previous (Shift+Enter)', () => navigateFindMatch(-1)),
      mkBtn('\u25bc', 'Next (Enter)',           () => navigateFindMatch(1)),
      closeBtn);

    // ── Row 2: slider ──
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;max-height:0;overflow:hidden;opacity:0;pointer-events:none;transition:max-height .25s ease,opacity .15s ease;align-items:center;justify-content:center;gap:5px;padding:0 2px;box-sizing:border-box;';

    function sideLabel(txt) {
      const s = document.createElement('span');
      s.style.cssText = 'font-size:9px;color:#505070;flex-shrink:0;';
      s.textContent = txt; return s;
    }
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '1'; slider.max = '4'; slider.value = '1';
    slider.style.cssText =
      'flex:1;-webkit-appearance:none;appearance:none;height:3px;border-radius:2px;outline:none;cursor:pointer;';

    const modeLabel = document.createElement('span');
    modeLabel.style.cssText = 'font-size:9px;color:#4dfa9a;flex-shrink:0;width:42px;text-align:right;';
    modeLabel.textContent = 'broad';

    if (!document.getElementById('__cwa_find_style__')) {
      const st = document.createElement('style'); st.id = '__cwa_find_style__';
      st.textContent =
        '#__cwa_find_panel__ input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:#4dfa9a;cursor:pointer;}' +
        '#__cwa_find_panel__ input[type=range]::-moz-range-thumb{width:10px;height:10px;border-radius:50%;background:#4dfa9a;border:none;cursor:pointer;}' +
        '@keyframes cwa-breathe{0%{box-shadow:0 0 0 3px rgba(255,220,70,.9)}40%{box-shadow:0 0 0 7px rgba(255,220,70,.5)}70%{box-shadow:0 0 0 5px rgba(255,220,70,.2)}100%{box-shadow:0 0 0 3px rgba(255,220,70,0)}}' +
        '.cwa-active-hl{animation:cwa-breathe 1.6s ease-out 1 forwards;outline:2px solid #ffe066 !important;}';
      document.head.appendChild(st);
    }
    function _updateTrack(v) {
      const p = (v - 1) / 3 * 100;
      slider.style.background = 'linear-gradient(to right,#4dfa9a 0%,#4dfa9a '+p+'%,#2a2a38 '+p+'%,#2a2a38 100%)';
    }
    _updateTrack(1);
    // Phase 1-C: slider filters displayed results — no re-query on slide
    const _FILTER_LABELS = ['', 'broad', 'general', 'related', 'literal'];
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value); _updateTrack(v);
      modeLabel.textContent = _FILTER_LABELS[v] || 'broad';
      filterHighlightsByScore(v);
    });
    row2.append(sideLabel('literal'), slider, sideLabel('broad'), modeLabel);

    // ── Row 3: status ──
    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:9px;color:#606080;min-height:3px;line-height:10px;';  // ← adjust min-height here to change bottom clearance

    const hardBtn = document.createElement('button');
    hardBtn.textContent = _find.effort.toUpperCase();
    hardBtn.title = 'Rerun this search with a larger retrieval budget';
    hardBtn.style.cssText = 'align-self:flex-start;background:none;border:1px solid #2a2a38;border-radius:3px;color:#9090a0;font:9px monospace;letter-spacing:1px;padding:2px 6px;cursor:pointer;margin-top:2px;';
    hardBtn.addEventListener('mouseenter', () => { hardBtn.style.borderColor = '#4dfa9a'; hardBtn.style.color = '#4dfa9a'; });
    hardBtn.addEventListener('mouseleave', () => { hardBtn.style.borderColor = '#2a2a38'; hardBtn.style.color = '#9090a0'; });
    hardBtn.addEventListener('mouseenter', function() {
      _showEffortMenu(hardBtn, function(effort) {
        _find.effort = effort;
        hardBtn.textContent = _find.effort.toUpperCase();
        if (_find.lastQuery || inp.value.trim()) {
          _find.lastQuery = inp.value.trim() || _find.lastQuery;
          doFind(_find.lastQuery);
        }
      });
    });
    hardBtn.addEventListener('click', function(e) {
      e.preventDefault();
      _showEffortMenu(hardBtn, function(effort) {
        _find.effort = effort;
        hardBtn.textContent = _find.effort.toUpperCase();
        if (_find.lastQuery || inp.value.trim()) {
          _find.lastQuery = inp.value.trim() || _find.lastQuery;
          doFind(_find.lastQuery);
        }
      });
    });

    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? navigateFindMatch(-1) : navigateFindMatch(1); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideFindPanel(); return; }
    });
    inp.addEventListener('input', () => {
      clearTimeout(_find._debounce);
      const q = inp.value.trim();
      if (!q) { clearFindHighlights(); _find.lastQuery = ''; counter.textContent = ''; statusEl.textContent = ''; return; }
      statusEl.textContent = '\u23f3\u00a0typing\u2026';
      _find._debounce = setTimeout(() => { _find.lastQuery = q; doFind(q); }, 800);
    });

    panel.append(dragHandle, row1, row2, statusEl, hardBtn);
    _find.panel = panel; _find.inp = inp; _find.counter = counter;
    _find.slider = slider; _find.statusEl = statusEl; _find.modeLabel = modeLabel;
    // Phase 1-C: reveal slider row on hover
    panel.addEventListener('mouseenter', () => { row2.style.maxHeight = '32px'; row2.style.padding = '4px 2px'; row2.style.overflow = 'visible'; row2.style.opacity = '1'; row2.style.pointerEvents = 'auto'; });
    panel.addEventListener('mouseleave', () => { row2.style.maxHeight = '0'; row2.style.padding = '0 2px'; row2.style.overflow = 'hidden'; row2.style.opacity = '0'; row2.style.pointerEvents = 'none'; });
  }

  function showFindPanel() {
    // Restore AUTO_FIND scroll when user explicitly opens Alt+S find panel
    if (_autoFindSavedScroll !== null) {
      window.scrollTo({ top: _autoFindSavedScroll, behavior: 'instant' });
      _autoFindSavedScroll = null;
      clearFindHighlights();
      _autoFindHits = [];
    }
    createFindPanel();
    if (!document.body.contains(_find.panel)) document.body.appendChild(_find.panel);
    _find.panel.style.display = 'flex';
    _find.visible = true;
    // Restore last query and replay highlights if panel was merely hidden
    if (_find.lastQuery && !_find.inp.value) {
      _find.inp.value = _find.lastQuery;
    }
    setTimeout(() => { _find.inp.focus(); _find.inp.select(); }, 0);
  }

  function hideFindPanel() {
    if (_find.panel) _find.panel.style.display = 'none';
    _find.visible = false;
    // Clear highlights when panel is toggled off; re-opening will re-run the search
    clearFindHighlights();
  }

  function clearFindHighlights() {
    const textParents = new Set();
    _findHighlights.forEach(function(hl) {
      if (hl.type === 'text') {
        const mark = hl.mark;
        if (!mark.parentNode) return;
        textParents.add(mark.parentNode);
        while (mark.firstChild) mark.parentNode.insertBefore(mark.firstChild, mark);
        mark.parentNode.removeChild(mark);
      } else if (hl.type === 'elem') {
        try { hl.el.style.outline = hl.origOutline; hl.el.style.background = hl.origBg; } catch(_) {}
      }
    });
    _findHighlights = []; _findActive = -1;
    document.querySelectorAll('.cwa-find-hl').forEach(function(m) {
      if (m.parentNode) {
        textParents.add(m.parentNode);
        while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
        m.parentNode.removeChild(m);
      }
    });
    textParents.forEach(function(p) { try { p.normalize(); } catch(_) {} });
    updateFindCounter();
    if (_find.statusEl) _find.statusEl.textContent = '';
  }

  function doFind(query) {
    _find.searchId++;
    clearFindHighlights();
    if (!query) return;
    // Phase 1-C: always search broadest; slider filters displayed results client-side
    _doLiteralHighlight(query, 4);

    if (_findHighlights.length) { updateFindCounter(); navigateFindMatchAbsolute(0); }
    _doFindAI(query, 4, _find.searchId);
  }

  function _doLiteralHighlight(query, score) {
    const needle = query.toLowerCase();
    const color = _FC[score];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: _filterTextNode });
    const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
    nodes.forEach(function(textNode) {
      const lower = (textNode.nodeValue || '').toLowerCase();
      const positions = [];
      let i = 0;
      while (true) { const f = lower.indexOf(needle, i); if (f === -1) break; positions.push(f); i = f + needle.length; }
      if (!positions.length) return;
      for (let j = positions.length - 1; j >= 0; j--) {
        const s = positions[j], e2 = s + needle.length;
        try {
          textNode.splitText(e2);
          const mn = textNode.splitText(s);
          const mark = document.createElement('mark');
          mark.className = 'cwa-find-hl'; mark.dataset.score = String(score);
          mark.style.cssText = 'background:' + color.bg + ';color:' + color.fg + ';border-radius:2px;';
          mn.parentNode.replaceChild(mark, mn); mark.appendChild(mn);
          _findHighlights.push({ type: 'text', mark });
        } catch(e) {}
      }
    });
  }

  // Phase 1: HTML denoising — skip elements inside structural noise zones (nav/header/footer/ads)
  // Note: _doFindAI signature extended with optional bm25Only param (used by AUTO_FIND)
  const _NOISY_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
  const _NOISY_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'menubar', 'menu']);
  const _NOISY_CLS_RE = /\b(nav|menu|sidebar|side-bar|footer|header|cookie|consent|ad-|ads-|banner|popup|modal|toast|overlay)\b/i;
  function _isNoisyAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const tag = (cur.tagName || '').toLowerCase();
      if (_NOISY_TAGS.has(tag)) return true;
      const role = cur.getAttribute('role') || '';
      if (_NOISY_ROLES.has(role)) return true;
      const cls = (cur.className && typeof cur.className === 'string') ? cur.className : '';
      const id = cur.id || '';
      if (_NOISY_CLS_RE.test(cls) || _NOISY_CLS_RE.test(id)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Phase 1: Build DOM chunk array — text for BM25/LLM retrieval, el for direct DOM highlighting
  function _chunkPage(url) {
    if (_pageChunkCache[url]) return _pageChunkCache[url];
    const els = document.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,figcaption,caption');
    const chunks = [];
    let currentHeading = '';
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      let inPanel = false, anc = el;
      while (anc) { if (anc.id === '__cwa_find_panel__') { inPanel = true; break; } anc = anc.parentElement; }
      if (inPanel) continue;
      if (_isNoisyAncestor(el)) continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 20) continue;
      const tagName = (el.tagName || '').toLowerCase();
      if (/^h[1-6]$/.test(tagName)) currentHeading = text.slice(0, 120);
      const idx = chunks.length;
      const positionRatio = els.length ? i / els.length : 0;
      chunks.push({
        idx,
        textFull: text,
        textPreview: text.slice(0, 650),
        text: text.slice(0, 650),
        headingPath: currentHeading || document.title || 'Page',
        positionRatio,
        tagName,
        prevIdx: idx > 0 ? idx - 1 : null,
        nextIdx: null,
        hash: String(text.length) + ':' + text.slice(0, 24),
        el,
      });
      if (idx > 0) chunks[idx - 1].nextIdx = idx;
    }
    _pageChunkCache[url] = chunks;
    return chunks;
  }

  function _doFindAI(query, mode, searchId, bm25Only) {
    if (_find.statusEl) _find.statusEl.textContent = '\u23f3\u00a0AI searching (' + _find.effort + ')\u2026';
    if (!_findHighlights.length && _find.counter) _find.counter.textContent = 'AI\u2026';

    const url = location.href;
    // Phase 0-B / Phase 1: on SPA delta invalidate both caches so new content is chunked fresh
    if (window.__cwa_delta__) {
      delete _pageChunkCache[url];
      delete _pageTextCache[url];
      window.__cwa_delta__ = null;
    }

    // Phase 1: build denoised DOM chunks (text for retrieval, el for highlighting)
    const chunks = _chunkPage(url);
    // Keep text cache alive for SPA observer snapshot
    if (!_pageTextCache[url]) {
      const joined = chunks.map(function(c) { return c.text; }).join('\n');
      _pageTextCache[url] = joined;
      _attachPageObserver(url, joined);
    }

    chrome.runtime.sendMessage(
      { type: 'FIND_ON_PAGE', payload: { query, chunks: chunks.map(function(c) { return { idx: c.idx, text: c.text, headingPath: c.headingPath, positionRatio: c.positionRatio, textPreview: c.textPreview }; }), mode, searchId, bm25Only: !!bm25Only, effort: bm25Only ? 'instant' : _find.effort } },
      function(resp) { if (chrome.runtime.lastError) ERR('FIND_ON_PAGE send:', chrome.runtime.lastError.message); }
    );
  }

  // Try to find the needle in a single text node (fast path — works for simple/static pages)
  function _tryTextNodeHL(normNeedle, score, color) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const t = (p.tagName || '').toLowerCase();
        if (['script','style','noscript'].indexOf(t) !== -1) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('cwa-find-hl')) return NodeFilter.FILTER_REJECT;
        let el = p; while (el) { if (el.id === '__cwa_find_panel__') return NodeFilter.FILTER_REJECT; el = el.parentElement; }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let tn;
    while ((tn = w.nextNode())) {
      const origLower = (tn.nodeValue || '').toLowerCase();
      const idx = origLower.indexOf(normNeedle);
      if (idx === -1) continue;
      try {
        tn.splitText(idx + normNeedle.length);
        const mn = tn.splitText(idx);
        const mark = document.createElement('mark');
        mark.className = 'cwa-find-hl'; mark.dataset.score = String(score);
        mark.style.cssText = 'background:' + color.bg + ';color:' + color.fg + ';border-radius:2px;';
        mn.parentNode.replaceChild(mark, mn); mark.appendChild(mn);
        _findHighlights.push({ type: 'text', mark });
        return true;
      } catch(e) {}
    }
    return false;
  }

  // Element-level fallback: find the smallest visible element whose innerText contains the needle.
  // Works on SPAs (LinkedIn, Twitter, etc.) where text is fragmented across nested elements.
  function _tryElemHL(normNeedle, score, color) {
    const maxLen = normNeedle.length * 8 + 400;
    let best = null, bestLen = Infinity;
    const els = document.body.querySelectorAll('a,h1,h2,h3,h4,h5,h6,p,li,td,th,label,button,article,span,div');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      // Skip panel itself and its descendants
      let inPanel = false, anc = el;
      while (anc) { if (anc.id === '__cwa_find_panel__') { inPanel = true; break; } anc = anc.parentElement; }
      if (inPanel) continue;
      const elText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').toLowerCase().trim();
      if (elText.length < normNeedle.length || elText.length > maxLen) continue;
      if (elText.indexOf(normNeedle) === -1) continue;
      if (elText.length < bestLen) { best = el; bestLen = elText.length; }
    }
    if (!best) return false;
    const origOutline = best.style.outline;
    const origBg = best.style.background;
    best.style.outline = '2px solid ' + color.bg;
    best.style.background = color.bg + '26'; // ~15% opacity tint
    _findHighlights.push({ type: 'elem', el: best, origOutline, origBg, color, score });
    return true;
  }

  // Phase 1: highlight by chunk element reference — no string-match reversal needed
  function _applyFindChunk(chunkIdx, score, searchId) {
    if (_find.searchId !== searchId) return;
    const url = location.href;
    const chunks = _pageChunkCache[url];
    if (!chunks || chunkIdx < 0 || chunkIdx >= chunks.length) return;
    const chunk = chunks[chunkIdx];
    const el = chunk.el;
    if (!el || !el.isConnected) return;

    if (searchId === _autoFindSearchId) {
      // AUTO_FIND: silently collect hit for sidebar PAGE SECTIONS panel.
      // NO page highlight during collection — only a temporary flash when user clicks to navigate.
      // Use longer snippet (120 chars) for meaningful PAGE SECTIONS quotes.
      const _afSnippet = chunk.text.slice(0, 120);
      _autoFindHits.push({ chunkIdx, score, snippet: _afSnippet });
      // Save scroll position on first hit (needed for RESTORE_SCROLL)
      if (_autoFindHits.length === 1) _autoFindSavedScroll = window.scrollY;
    } else {
      // Regular FIND_ON_PAGE: apply persistent visual highlight
      const color = _FC[Math.max(1, Math.min(4, score || 2))];
      const origOutline = el.style.outline;
      const origBg = el.style.background;
      el.style.outline = '2px solid ' + color.bg;
      el.style.background = color.bg + '26';
      _findHighlights.push({ type: 'elem', el, origOutline, origBg, color, score });
      updateFindCounter();
      if (!_find.suppressAutoNav && _findActive < 0 && _findHighlights.length) {
        navigateFindMatchAbsolute(0);
      }
    }
  }

  function _finalizeFindSearch(searchId) {
    if (_find.searchId !== searchId) return;
    _find.suppressAutoNav = false;
    if (_find.statusEl) _find.statusEl.textContent = '';
    if (!_findHighlights.length && _find.counter) _find.counter.textContent = 'not found';
    else updateFindCounter();
    // Report hits to background → sidepanel for badge navigation
    if (searchId === _autoFindSearchId && _autoFindHits.length) {
      chrome.runtime.sendMessage({ type: 'AUTO_FIND_HITS', hits: _autoFindHits }).catch(() => {});
    }
  }

  // Collect the full ancestor element set of a node (up to body).
  function _ancestorSet(node) {
    const set = new Set();
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) { set.add(el); el = el.parentElement; }
    return set;
  }

  // Find the trigger button/link that JS-controls a given element (matched by id)
  function _findTrigger(el) {
    const id = el.id;
    if (!id) return null;
    return document.querySelector('[aria-controls="' + id + '"]') ||
           document.querySelector('[data-bs-target="#' + id + '"]') ||
           document.querySelector('[data-target="#' + id + '"]') ||
           document.querySelector('[href="#' + id + '"]');
  }

  // Returns true only if el is a legitimate UI container (contains visible child elements,
  // not purely a data/script/template store). This guards against revealing hidden JSON blobs.
  function _isUiContainer(el) {
    // Non-visual tags that should never be forcibly shown
    const _DATA_TAGS = new Set(['script','style','template','noscript','link','meta','code','pre']);
    // Must have at least one child element that is not a data-only tag
    let hasVisualChild = false;
    for (let i = 0; i < el.children.length; i++) {
      const t = el.children[i].tagName.toLowerCase();
      if (!_DATA_TAGS.has(t)) { hasVisualChild = true; break; }
    }
    // Also allow if el itself carries a recognised UI role or semantic tag
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const _UI_TAGS = new Set(['details','dialog','aside','section','article','nav','header','footer','main','form','fieldset','figure','li','dd','td','th']);
    const _UI_ROLES = new Set(['tabpanel','dialog','region','complementary','navigation','main','form','listitem','row','gridcell','group','tree','treeitem']);
    if (_UI_TAGS.has(tag) || _UI_ROLES.has(role)) return true;
    return hasVisualChild;
  }

  // Reveal all hidden/collapsed ancestors of a target node so it becomes visible.
  // Returns { undos: Array<{el,undo}>, triggered: boolean }.
  // triggered=true means a JS-managed trigger was clicked (expect CSS transition ~350ms).
  function revealAncestors(node) {
    const undos = [];
    let triggered = false;
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) {
      const tag = el.tagName && el.tagName.toLowerCase();

      // 1. <details> — open it (always safe, it's a native disclosure widget)
      if (tag === 'details' && !el.open) {
        el.open = true;
        const _el = el;
        undos.push({ el: _el, undo: () => { _el.open = false; } });
      }

      // All remaining operations require the element to be a legitimate UI container.
      // Skip data-store divs (LinkedIn Voyager JSON, Redux stores, etc.).
      if (!_isUiContainer(el)) { el = el.parentElement; continue; }

      // 2. aria-hidden="true" — remove it
      if (el.getAttribute('aria-hidden') === 'true') {
        el.setAttribute('aria-hidden', 'false');
        const _el = el;
        undos.push({ el: _el, undo: () => { _el.setAttribute('aria-hidden', 'true'); } });
      }

      // 3. display:none — prefer clicking the JS trigger; only fall back to direct style if
      //    a trigger exists (never forcibly show elements without a known control mechanism,
      //    to avoid revealing hidden data containers like LinkedIn's JSON blobs).
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none') {
        const trigger = _findTrigger(el);
        if (trigger) {
          const tl = trigger.closest('[role=tablist],[role=navigation]');
          const prevActive = tl ? tl.querySelector('[aria-selected="true"],[aria-expanded="true"],.active') : null;
          try { trigger.click(); triggered = true; } catch(_) {}
          undos.push({ el: trigger, undo: () => {
            if (prevActive && prevActive !== trigger) { try { prevActive.click(); } catch(_) {} }
            else { try { trigger.click(); } catch(_) {} }
          }});
        }
        // No trigger and not a known UI container: skip — do NOT forcibly set display:block
      }
      if (cs.visibility === 'hidden') {
        const prev = el.style.visibility;
        el.style.visibility = 'visible';
        const _el = el;
        undos.push({ el: _el, undo: () => { _el.style.visibility = prev; } });
      }

      // 4. Tab panels: find and click the controlling tab; record previously active tab to restore
      const role = el.getAttribute('role');
      if (role === 'tabpanel') {
        const panelId = el.id;
        const tabBtn = panelId
          ? document.querySelector('[role=tab][aria-controls="' + panelId + '"]') ||
            document.querySelector('button[aria-controls="' + panelId + '"]') ||
            document.querySelector('[data-target="#' + panelId + '"]') ||
            document.querySelector('[href="#' + panelId + '"]')
          : null;
        if (tabBtn) {
          const tabList = tabBtn.closest('[role=tablist]') || tabBtn.parentElement;
          const activeTab = tabList
            ? tabList.querySelector('[role=tab][aria-selected="true"], [role=tab].active')
            : null;
          try { tabBtn.click(); triggered = true; } catch(_) {}
          if (activeTab && activeTab !== tabBtn) {
            undos.push({ el: tabBtn, undo: () => { try { activeTab.click(); } catch(_) {} } });
          }
        } else {
          el.removeAttribute('hidden');
          el.style.display = el.style.display === 'none' ? 'block' : el.style.display;
          const _el = el;
          undos.push({ el: _el, undo: () => { _el.setAttribute('hidden', ''); } });
        }
      }

      // 5. Bootstrap / generic class-toggled collapse (.collapse without .show)
      //    Prefer clicking the JS trigger; fall back to direct class addition
      if (el.classList.contains('collapse') && !el.classList.contains('show')) {
        const trigger = _findTrigger(el);
        if (trigger) {
          try { trigger.click(); triggered = true; } catch(_) {}
          undos.push({ el: trigger, undo: () => { try { trigger.click(); } catch(_) {} } });
        } else {
          el.classList.add('show');
          const _el = el;
          undos.push({ el: _el, undo: () => { _el.classList.remove('show'); } });
        }
      }

      // 6. Generic .hidden class override
      if (el.classList.contains('hidden')) {
        el.classList.remove('hidden');
        const _el = el;
        undos.push({ el: _el, undo: () => { _el.classList.add('hidden'); } });
      }

      el = el.parentElement;
    }
    return { undos, triggered };
  }

  // Per-highlight undo stacks (populated by revealAncestors on each navigation)
  const _revealUndos = {};

  function navigateFindMatch(dir) {
    if (!_findHighlights.length) return;
    const visIdx = _visibleIndices();
    if (!visIdx.length) return;
    // Find where the current active item sits within the visible subset
    const curPos = visIdx.indexOf(_findActive);
    const nextPos = ((curPos + dir) % visIdx.length + visIdx.length) % visIdx.length;
    navigateFindMatchAbsolute(visIdx[nextPos]);
  }

  function navigateFindMatchAbsolute(idx) {
    if (!_findHighlights.length) return;
    // Restore previous highlight to its resting colour
    if (_findActive >= 0 && _findHighlights[_findActive]) {
      const prev = _findHighlights[_findActive];
      if (prev.type === 'text') {
        const c = _FC[parseInt(prev.mark.dataset.score || '4')] || _FC[4];
        prev.mark.classList.remove('cwa-active-hl');
        prev.mark.style.cssText = 'background:' + c.bg + ';color:' + c.fg + ';border-radius:2px;';
      } else {
        prev.el.style.outline = '2px solid ' + prev.color.bg;
      }
    }

    const hl = _findHighlights[idx];
    if (!hl) return;
    const targetNode = hl.type === 'text' ? hl.mark : hl.el;

    // Revert ancestor UI changes from the previous highlight,
    // but skip any element that is also an ancestor of the new target (shared container).
    if (_findActive >= 0 && _revealUndos[_findActive]) {
      const newAncs = _ancestorSet(targetNode);
      _revealUndos[_findActive].forEach(function(entry) {
        if (!newAncs.has(entry.el)) entry.undo();
      });
      delete _revealUndos[_findActive];
    }

    _findActive = idx;

    // Reveal collapsed/hidden ancestors and store undos for later revert
    const _revealResult = revealAncestors(targetNode);
    _revealUndos[_findActive] = _revealResult.undos;

    // If a JS trigger was clicked, there is a CSS transition (~350ms); delay scroll to match
    const _doScroll = () => {
      if (hl.type === 'text') {
        const c = _FC[parseInt(hl.mark.dataset.score || '4')] || _FC[4];
        // Phase 1-B: apply breathing animation on active match
        hl.mark.style.cssText = 'background:' + c.bg + ';color:' + c.fg + ';border-radius:2px;outline:2px solid #ffe066 !important;';
        hl.mark.classList.add('cwa-active-hl');
        hl.mark.addEventListener('animationend', function() { hl.mark.classList.remove('cwa-active-hl'); }, { once: true });
        hl.mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        hl.el.style.outline = '3px solid #fff';
        hl.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      updateFindCounter();
    };
    if (_revealResult.triggered) {
      setTimeout(_doScroll, 380);
    } else {
      _doScroll();
    }
  }

  function updateFindCounter() {
    if (!_find.counter) return;
    if (!_findHighlights.length) { _find.counter.textContent = ''; return; }
    const min = _find.minScore || 1;
    if (min <= 1) {
      _find.counter.textContent = (_findActive < 0 ? '?' : _findActive + 1) + '\u202f/\u202f' + _findHighlights.length;
    } else {
      const visIdx = _visibleIndices();
      const pos = _findActive >= 0 ? visIdx.indexOf(_findActive) : -1;
      _find.counter.textContent = (pos < 0 ? '?' : pos + 1) + '\u202f/\u202f' + visIdx.length + ' (filtered)';
    }
  }

  // Returns indices of highlights that pass the current score filter
  function _visibleIndices() {
    const min = _find.minScore || 1;
    const out = [];
    _findHighlights.forEach(function(hl, i) {
      const score = hl.type === 'text' ? parseInt(hl.mark.dataset.score || '2') : (hl.score || 2);
      if (score >= min) out.push(i);
    });
    return out;
  }

  // Phase 1-C: filter displayed highlights by minimum score threshold
  function filterHighlightsByScore(min) {
    _find.minScore = min;
    let visCount = 0;
    _findHighlights.forEach(function(hl) {
      const score = hl.type === 'text' ? parseInt(hl.mark.dataset.score || '2') : (hl.score || 2);
      const show = score >= min;
      if (hl.type === 'text') hl.mark.style.display = show ? 'inline' : 'none';
      else hl.el.style.visibility = show ? '' : 'hidden';
      if (show) visCount++;
    });
    // If the currently active highlight is now filtered out, jump to nearest visible one
    const visIdx = _visibleIndices();
    if (visIdx.length > 0) {
      const stillVisible = _findActive >= 0 && visIdx.includes(_findActive);
      if (!stillVisible) {
        // Navigate to the closest visible item after the current position
        const next = visIdx.find(i => i > _findActive) !== undefined
          ? visIdx.find(i => i > _findActive)
          : visIdx[0];
        navigateFindMatchAbsolute(next);
      }
    }
    updateFindCounter();
  }

  function _removeFloatMenus() {
    document.querySelectorAll('.cwa-effort-menu').forEach(m => m.remove());
  }

  function _showEffortMenu(anchor, onPick) {
    _removeFloatMenus();
    const menu = document.createElement('div');
    menu.className = 'cwa-effort-menu';
    menu.style.cssText = 'position:fixed;z-index:2147483647;background:#18181b;border:1px solid #3a3a50;border-radius:4px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:0 8px 28px rgba(0,0,0,.45);';
    ['balanced', 'deep'].forEach(function(effort) {
      const b = document.createElement('button');
      b.textContent = effort.toUpperCase();
      b.style.cssText = 'background:none;border:1px solid transparent;color:#d0d0d8;font:10px monospace;padding:4px 8px;text-align:left;cursor:pointer;border-radius:2px;';
      b.addEventListener('mouseenter', () => { b.style.borderColor = '#4dfa9a'; b.style.color = '#4dfa9a'; });
      b.addEventListener('mouseleave', () => { b.style.borderColor = 'transparent'; b.style.color = '#d0d0d8'; });
      b.addEventListener('click', function(e) {
        e.stopPropagation();
        onPick(effort);
        _removeFloatMenus();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(window.innerWidth - menu.offsetWidth - 4, r.left)) + 'px';
    menu.style.top = Math.max(4, r.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('click', _removeFloatMenus, { once: true }), 0);
  }

  // ── Phase 2: Inline Ask Float ───────────────────────────────────────────
  const _float = {
    panel: null, textarea: null, replyDiv: null, sendBtn: null, modelBadge: null,
    statusDot: null, statusTxt: null,
    state: 'idle',  // idle | input | streaming | done_first
    port: null, buf: '',
    firstQ: null, firstA: null, sel: null,
    model: null, pos: null, effort: 'instant',
  };

  function _floatClamp(x, y, w, h) {
    return {
      x: Math.max(0, Math.min(x, window.innerWidth  - w)),
      y: Math.max(0, Math.min(y, window.innerHeight - h)),
    };
  }

  function createAskFloat() {
    if (_float.panel) return;
    const FW = 300;

    // Inject pulse keyframes once
    if (!document.getElementById('__cwa_float_styles__')) {
      const st = document.createElement('style');
      st.id = '__cwa_float_styles__';
      st.textContent = '@keyframes cwa-float-hl-pulse{0%,100%{outline-color:rgba(77,250,154,0.55)}50%{outline-color:rgba(77,250,154,1);background:rgba(77,250,154,0.40) !important}}';
      document.head.appendChild(st);
    }

    const panel = document.createElement('div');
    panel.id = '__cwa_ask_float__';
    panel.style.cssText =
      'position:fixed;z-index:2147483645;width:' + FW + 'px;display:none;flex-direction:column;' +
      'background:rgba(16,16,22,0.90);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'border:1px solid rgba(77,250,154,0.50);border-radius:8px;font:12px/1 monospace;' +
      'box-shadow:0 4px 24px rgba(0,0,0,.55);overflow:hidden;';

    // drag handle
    const drag = document.createElement('div');
    drag.style.cssText = 'width:100%;height:10px;cursor:grab;display:flex;align-items:center;justify-content:center;opacity:0.5;user-select:none;flex-shrink:0;';
    drag.innerHTML = '<span style="display:block;width:32px;height:3px;border-radius:2px;background:#4dfa9a;"></span>';
    drag.addEventListener('mousedown', function(de) {
      de.preventDefault();
      const offX = de.clientX - panel.offsetLeft, offY = de.clientY - panel.offsetTop;
      drag.style.cursor = 'grabbing';
      function onMove(me) {
        const r = _floatClamp(me.clientX - offX, me.clientY - offY, panel.offsetWidth, panel.offsetHeight);
        panel.style.left = r.x + 'px'; panel.style.top = r.y + 'px'; _float.pos = r;
      }
      function onUp() { drag.style.cursor = 'grab'; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // reply area (hidden until first answer arrives)
    const replyDiv = document.createElement('div');
    replyDiv.style.cssText = 'display:none;padding:6px 8px;font-size:11px;color:#c8d0e0;line-height:1.6;max-height:200px;overflow-y:auto;border-bottom:1px solid rgba(77,250,154,0.12);white-space:pre-wrap;word-break:break-word;';
    _float.replyDiv = replyDiv;

    // textarea
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Ask about selected text\u2026';
    textarea.rows = 2;
    textarea.style.cssText =
      'background:#0c0c0e;border:none;border-bottom:1px solid #1e1e2a;color:#e8e8e8;' +
      'font:12px monospace;padding:7px 8px;resize:none;outline:none;width:100%;box-sizing:border-box;' +
      'max-height:80px;overflow-y:auto;line-height:1.5;';
    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); hideAskFloat(true); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _floatSend();
      }
    });
    _float.textarea = textarea;

    // footer: model \u00b7 status \u00b7 spacer \u00b7 maximize \u00b7 send/abort \u00b7 close
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;padding:4px 6px;gap:4px;border-top:1px solid rgba(77,250,154,0.15);';
    const modelBadge = document.createElement('button');
    modelBadge.style.cssText = 'background:none;border:1px solid #3a3a50;border-radius:2px;color:#7090b0;font:9px monospace;padding:2px 5px;cursor:pointer;letter-spacing:1px;transition:all .15s;flex-shrink:0;';
    modelBadge.title = 'Click to cycle model';
    const _FLOAT_MODELS = [
      ['gpt-4o-mini','openai'],['gpt-5-nano','openai'],['gpt-5-mini','openai'],['gpt-4o','openai'],
      ['deepseek-v4-flash','deepseek'],['deepseek-v4-pro','deepseek'],['deepseek-chat','deepseek'],
      ['claude-3-5-haiku-latest','claude'],['claude-3-5-sonnet-latest','claude'],
    ];
    modelBadge.addEventListener('click', function() {
      const idx = _FLOAT_MODELS.findIndex(([m]) => m === _float.model);
      const next = _FLOAT_MODELS[(idx + 1) % _FLOAT_MODELS.length];
      _float.model = next[0];
      modelBadge.textContent = next[0].split('/').pop().slice(0, 18).toUpperCase();
      chrome.storage.sync.set({ cwaModel: next[0], cwaProvider: next[1] });
    });
    const effortBtn = document.createElement('button');
    effortBtn.textContent = _float.effort.toUpperCase();
    effortBtn.title = 'Use balanced or deep mode for this page float';
    effortBtn.style.cssText = 'background:none;border:1px solid #3a3a50;border-radius:2px;color:#7090b0;font:9px monospace;padding:2px 5px;cursor:pointer;letter-spacing:1px;transition:all .15s;flex-shrink:0;';
    effortBtn.addEventListener('mouseenter', function() {
      _showEffortMenu(effortBtn, function(effort) {
        _float.effort = effort;
        effortBtn.textContent = effort.toUpperCase();
      });
    });
    effortBtn.addEventListener('click', function(e) {
      e.preventDefault();
      _showEffortMenu(effortBtn, function(effort) {
        _float.effort = effort;
        effortBtn.textContent = effort.toUpperCase();
      });
    });
    const statusDot = document.createElement('span');
    statusDot.style.cssText = 'width:5px;height:5px;border-radius:50%;background:#4dfa9a;flex-shrink:0;';
    const statusTxt = document.createElement('span');
    statusTxt.style.cssText = 'font-size:9px;color:#4dfa9a;letter-spacing:1.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    statusTxt.textContent = 'READY';
    _float.modelBadge = modelBadge; _float.statusDot = statusDot; _float.statusTxt = statusTxt;
    const maximizeBtn = document.createElement('button');
    maximizeBtn.textContent = '\u2922';
    maximizeBtn.title = 'Continue in sidebar';
    maximizeBtn.style.cssText = 'background:none;border:1px solid #3a3a50;border-radius:2px;color:#7090b0;font:11px monospace;padding:2px 5px;cursor:pointer;transition:all .15s;flex-shrink:0;';
    maximizeBtn.addEventListener('mouseover', () => { maximizeBtn.style.color = '#4dfa9a'; maximizeBtn.style.borderColor = '#4dfa9a'; });
    maximizeBtn.addEventListener('mouseout',  () => { maximizeBtn.style.color = '#7090b0'; maximizeBtn.style.borderColor = '#3a3a50'; });
    maximizeBtn.addEventListener('click', function() {
      const handoff = {
        firstQ: _float.firstQ, firstA: _float.firstA,
        secondQ: _float.textarea ? _float.textarea.value.trim() : '',
        effort: _float.effort || 'instant',
        selection: _float.sel, url: location.href, title: document.title,
      };
      console.log('[CWA-FLOAT] maximizeBtn: sending handoff via OPEN_SIDE_PANEL; firstQ=', !!handoff.firstQ, 'firstA=', !!handoff.firstA);
      hideAskFloat();
      openSidePanel(true, handoff);
    });
    const sendBtn = document.createElement('button');
    sendBtn.textContent = '\u25b6';
    sendBtn.title = 'Send (Enter)';
    sendBtn.style.cssText =
      'background:none;border:1px solid #2a2a38;border-radius:2px;color:#9090a0;' +
      'font:12px monospace;padding:3px 8px;cursor:pointer;transition:all .15s;flex-shrink:0;';
    sendBtn.addEventListener('mouseover', () => { sendBtn.style.color = '#4dfa9a'; sendBtn.style.borderColor = '#4dfa9a'; });
    sendBtn.addEventListener('mouseout',  () => {
      sendBtn.style.color = _float.state === 'streaming' ? '#ff5e57' : '#9090a0';
      sendBtn.style.borderColor = _float.state === 'streaming' ? '#ff5e57' : '#2a2a38';
    });
    sendBtn.addEventListener('click', function() {
      if (_float.state === 'streaming') { _floatAbort(); } else { _floatSend(); }
    });
    _float.sendBtn = sendBtn;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\xd7';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'background:none;border:none;color:#ff5e57;font:14px monospace;cursor:pointer;padding:0 3px;line-height:1;flex-shrink:0;';
    closeBtn.addEventListener('click', () => hideAskFloat(true));
    footer.append(modelBadge, effortBtn, statusDot, statusTxt, maximizeBtn, sendBtn, closeBtn);

    panel.append(drag, replyDiv, textarea, footer);
    document.body.appendChild(panel);
    _float.panel = panel;
  }

  function showAskFloat(anchorRect, selText) {
    createAskFloat();
    _float.sel = selText || null;
    _float.firstQ = null; _float.firstA = null; _float.buf = '';
    _float.state = 'input';

    // Position 8px below bottom-right corner, clamped to viewport
    const FW = 300, FH_EST = 155;
    let tx = anchorRect ? anchorRect.right + 8 : window.innerWidth / 2 - FW / 2;
    let ty = anchorRect ? anchorRect.bottom + 8 : window.innerHeight / 2 - FH_EST / 2;
    const cpos = _float.pos || _floatClamp(tx, ty, FW, FH_EST);
    _float.panel.style.left = cpos.x + 'px';
    _float.panel.style.top  = cpos.y + 'px';

    // Reset UI
    _float.replyDiv.style.display = 'none';
    _float.replyDiv.textContent = '';
    _float.textarea.value = '';
    _float.textarea.placeholder = 'Ask about selected text\u2026';
    _float.textarea.disabled = false;
    _float.sendBtn.textContent = '\u25b6';
    _float.sendBtn.style.color = '#9090a0';
    _float.sendBtn.style.borderColor = '#2a2a38';
    _float.statusTxt.textContent = 'READY';
    _float.statusDot.style.background = '#4dfa9a';

    chrome.storage.sync.get(['cwaModel'], function(r) {
      _float.model = r.cwaModel || 'gpt-4o';
      _float.modelBadge.textContent = (_float.model).split('/').pop().slice(0, 18).toUpperCase();
    });

    _float.panel.style.display = 'flex';
    setTimeout(function() { _float.textarea.focus(); }, 0);
  }

  function hideAskFloat(clearSel) {
    _floatAbort();
    if (_float.panel) _float.panel.style.display = 'none';
    _float.state = 'idle';
    if (clearSel) {
      // Explicit dismiss (Esc / ✕) — always clear the selection highlight
      SEL.reset();
    } else {
      // Handoff path — keep HL alive if sidebar is taking over
      chrome.storage.session.get('cwaSpOpen', function(d) {
        if (!d.cwaSpOpen) SEL.reset();
      });
    }
  }

  function _floatAbort() {
    if (_float.port) { try { _float.port.disconnect(); } catch(_) {} _float.port = null; }
    if (_float.state === 'streaming') {
      _float.state = 'done_first';
      _float.firstA = _float.buf;
      _float.sendBtn.textContent = '\u25b6';
      _float.sendBtn.style.color = '#9090a0';
      _float.sendBtn.style.borderColor = '#2a2a38';
      _float.statusTxt.textContent = 'STOPPED';
      _float.statusDot.style.background = '#8888a0';
      _float.textarea.disabled = false;
      _float.textarea.focus();
    }
  }

  function _floatSend() {
    if (!_float.textarea || _float.state === 'streaming') return;
    const q = _float.textarea.value.trim();
    if (!q) return;

    // Second question → hand off to sidebar
    if (_float.state === 'done_first') {
      const handoff = {
        firstQ:    _float.firstQ,
        firstA:    _float.firstA,
        secondQ:   q,
        effort:    _float.effort || 'instant',
        selection: _float.sel,
        url:       location.href,
        title:     document.title,
      };
      console.log('[CWA-FLOAT] _floatSend done_first: sending handoff via OPEN_SIDE_PANEL; firstQ=', !!handoff.firstQ, 'secondQ=', q.slice(0,30));
      hideAskFloat();
      openSidePanel(true, handoff);
      return;
    }

    // First question → stream into float
    _float.firstQ = q;
    _float.buf = '';
    _float.state = 'streaming';
    _float.replyDiv.textContent = '';
    _float.replyDiv.style.display = 'block';
    _float.textarea.disabled = true;
    _float.sendBtn.textContent = '\u25a0';
    _float.sendBtn.style.color = '#ff5e57';
    _float.sendBtn.style.borderColor = '#ff5e57';
    _float.statusTxt.textContent = 'THINKING';
    _float.statusDot.style.background = '#ffe066';

    const payload = {
      prompt:     q,
      url:        location.href,
      meta:       { title: document.title, description: '' },
      selections: _float.sel ? [{ text: _float.sel, context: _float.sel }] : [],
      messages:   [],
      model:      _float.model || 'gpt-4o',
      effort:     _float.effort || 'instant',
      presetInstruction: null,
      pageContext: null,
    };

    const port = chrome.runtime.connect({ name: 'cwa' });
    _float.port = port;
    port.onMessage.addListener(function(msg) {
      if (msg.type === 'CHUNK') {
        _float.buf += msg.chunk;
        _float.replyDiv.textContent = _float.buf;
        _float.statusTxt.textContent = 'STREAMING';
        _float.replyDiv.scrollTop = _float.replyDiv.scrollHeight;
        return;
      }
      port.disconnect();
      _float.port = null;
      const reply = msg.reply || _float.buf;
      _float.firstA = reply;
      _float.buf = reply;
      _float.replyDiv.textContent = reply;
      _float.state = 'done_first';
      _float.sendBtn.textContent = '\u25b6';
      _float.sendBtn.style.color = '#9090a0';
      _float.sendBtn.style.borderColor = '#2a2a38';
      _float.statusTxt.textContent = msg.error ? 'ERROR' : 'DONE \u00b7 follow-up \u2192 sidebar';
      _float.statusDot.style.background = msg.error ? '#ff5e57' : '#4dfa9a';
      _float.textarea.value = '';
      _float.textarea.placeholder = 'Follow-up\u2026 (opens sidebar)';
      _float.textarea.disabled = false;
      _float.textarea.focus();
      // Save Q/A so sidebar can pick up seamlessly if user opens it without typing a follow-up
      if (!msg.error) {
        try { chrome.runtime.sendMessage({ type: 'SET_SESSION', key: 'cwaFloatPending', value: { firstQ: _float.firstQ, firstA: reply, sel: _float.sel, url: location.href, title: document.title } }).catch(() => {}); } catch(_) {}
      }
    });
    port.onDisconnect.addListener(function() {
      if (_float.state === 'streaming') {
        _float.state = 'done_first';
        _float.firstA = _float.buf;
        _float.statusTxt.textContent = 'DISCONNECTED';
        _float.statusDot.style.background = '#ff5e57';
        _float.textarea.disabled = false;
      }
      _float.port = null;
    });
    port.postMessage({ type: 'QUERY', payload });
  }

  // Phase 0-B: attach MutationObserver to detect SPA content changes after initial capture
  function _attachPageObserver(url, snapshot) {
    if (_pageObserver) { _pageObserver.disconnect(); _pageObserver = null; }
    // Skip PDF viewer — no semantic content root to observe
    if (url.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')) return;
    const root = document.querySelector('article, main') ||
                 document.querySelector('[id*="content"]') ||
                 document.querySelector('[class*="content"]') ||
                 document.body;
    let debounceTimer = null;
    let lastSnapshot = snapshot;
    _pageObserver = new MutationObserver(function() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function() {
        const newText = (root.innerText || root.textContent || '').trim();
        if (newText.length > lastSnapshot.length + 200) {
          const delta = newText.slice(lastSnapshot.length).trim();
          if (delta.length >= 200) {
            window.__cwa_delta__ = delta.slice(0, 5000);
            // Relay to sidepanel so QUERY messages can include page delta
            try { chrome.storage.session.set({ cwaPageDelta: { text: window.__cwa_delta__, url, ts: Date.now() } }); } catch(_) {}
          }
        }
        lastSnapshot = newText.slice(0, 25000);
        delete _pageChunkCache[url]; // Phase 1: invalidate chunk cache on SPA content change
      }, 500);
    });
    _pageObserver.observe(root, { childList: true, subtree: true });
  }

  console.log('%c[CWA]', 'color:#4dfa9a;font-weight:bold', 'loaded v' + VER + ' on', location.href);

  // Phase 0-B: teardown observer on page unload
  window.addEventListener('beforeunload', function() {
    if (_pageObserver) { _pageObserver.disconnect(); _pageObserver = null; }
    try { chrome.storage.session.remove('cwaPageDelta'); } catch(_) {}
  });
})();
