# Pluck — Feature Roadmap (Multi-Session Implementation Plan)

> Generated: 2026-05-05  
> Strategy: 4 independent phases, each deliverable on its own.  
> Unless noted, edits concentrate in `src/content.js`, `src/sidepanel.js`, `src/background.js`.

---

## Phase 0 · Page-Context Caching & Session Resume
*Foundation for Req 0 — improves cache hit rate for all later phases.*

### 0-A  Per-page context UID + one-time auto-capture

**Goal:** First time a question or semantic search is sent for a given page, capture
`document.body.innerText` (≤ 25 000 chars) and store it keyed by a UID.  
Subsequent queries on the same page reuse the cached text — no re-capture.

| File | Change |
|---|---|
| `content.js` | On `QUERY` / `FIND_ON_PAGE` dispatch: if no cache for current URL, capture innerText and send it in the message payload under a new field `autoPageText`. |
| `sidepanel.js` | Extend `S.pageHtmlCache` (`{ [url]: { uid, text, title, createdAt } }`). On first query for a URL, write entry; reuse on repeat. Expose `uid` generation: `url_hash_8chars + '_' + timestamp_base36`. |
| `background.js` | `buildMessages` already accepts `payload.pageContext` — no change needed; callers just supply the cached text. |

**Display:** The UID is internal. When shown in the `@` hint dropdown, display  
`[page title] · [HH:MM DD/MM]` (use existing `title` + `createdAt` fields already in `ctxStore`).  
No new UI component; just change the label rendering in `renderAtHint()` in `sidepanel.js`.

**Deduplication rule:** If `S.pageHtmlCache[url]` already exists, skip capture entirely.  
Dynamic-page delta is handled in 0-C.

---

### 0-B  Dynamic-page incremental context (MutationObserver delta)

**Goal:** For SPAs (Twitter, LinkedIn, etc.), when the main content area changes after
initial capture, record a diff and attach it as `[Page Update]` on the next query.

**Scope:** Only observe semantic content elements — `article`, `main`, `[id*=content]`,
`[class*=content]` (first match wins). Navigation bars, sidebars, and ad slots are ignored.

| File | Change |
|---|---|
| `content.js` | After initial capture fires, attach one `MutationObserver` to the detected content root. Debounce 500 ms. On callback: compute text diff (new `innerText` vs cached snapshot); if delta ≥ 200 chars, store in `window.__cwa_delta__`. |
| `content.js` | When dispatching the next `FIND_ON_PAGE` or `QUERY` message, append `pageDelta: window.__cwa_delta__` to payload and clear `__cwa_delta__`. |
| `background.js` | In `buildMessages`: if `payload.pageDelta` present, append `\n\n[Page Update]:\n${pageDelta}` to the page-context block. |

**Teardown:** Observer is disconnected when the page context cache entry is invalidated
(full reload detected via `beforeunload` → send `PAGE_UNLOAD` message to clear session cache).

---

### 0-C  Session resume summary on page revisit

**Goal:** When a page with ≥ 4 prior chat messages is reopened, generate a brief LLM
summary (≤ 150 tokens) to use as context prefix — instead of replaying the full
message array. Reduces token cost and avoids context-window overflow on long threads.

| File | Change |
|---|---|
| `sidepanel.js` | In `onTabNavigated`: if `S.pageHtmlCache[url]` is missing (fresh open) AND history for that URL has ≥ 4 messages AND no `resumeSummary` is stored, fire a one-shot `RESUME_SUMMARIZE` message to background. Store returned summary as `S.resumeCache[url]`. |
| `sidepanel.js` | In `buildMessages` payload assembly: if `S.resumeCache[url]` exists, send `resumeSummary` field. Clear raw `messages` or keep only the last 2. |
| `background.js` | Handle `RESUME_SUMMARIZE` one-shot: call LLM with `"Summarize this conversation in ≤5 bullet points for context resumption."` + last N messages. Respond with summary string. |
| `background.js` | In `buildMessages`: if `payload.resumeSummary` present, prepend `[Previous session summary]:\n${resumeSummary}` to the system block. |

**Persistence:** `resumeSummary` is stored in `chrome.storage.local` keyed by normalised URL.
Semantic search history is **not** saved on page close — already the case (session-only data).  
Chat Q&A history remains saved to disk via existing `HISTORY_SAVE` mechanism.

---

## Phase 1 · Semantic Search UX Overhaul
*Req 1 — rename "Super Ctrl-F" → "Semantic Search"; all changes in `content.js`.*

### 1-A  Draggable floating panel

The find panel (`#__cwa_find_panel__`) is currently `position:fixed; right:14px; top:60px`.

**Change:** Replace `right` with `left` (computed on creation from `window.innerWidth`).
Add a drag handle row (thin bar at top of panel). On `mousedown` on handle → capture
`pointerId`, listen `pointermove` / `pointerup` on `document` to reposition panel.
Clamp to viewport bounds. Store last position in `_find.pos = {x, y}` so recreated panel
reopens at same position within the session.

No external library; ~30 lines of vanilla JS.

---

### 1-B  Breathing animation on active match (exponential-decay pulse)

When `navigateFindMatchAbsolute(idx)` is called:
1. Remove animation from previous active mark.
2. Apply CSS class `cwa-active-hl` to the new active mark.

Add to the injected `<style id="__cwa_find_style__">`:

```css
@keyframes cwa-breathe {
  0%   { box-shadow: 0 0 0 3px rgba(255,220,70,.9); }
  40%  { box-shadow: 0 0 0 7px rgba(255,220,70,.5); }
  70%  { box-shadow: 0 0 0 5px rgba(255,220,70,.2); }
  100% { box-shadow: 0 0 0 3px rgba(255,220,70,.0); }
}
.cwa-active-hl {
  animation: cwa-breathe 1.6s ease-out 1 forwards;
  outline: 2px solid #ffe066 !important;
}
```

After animation ends (`animationend` event), remove the class but keep the outline.

---

### 1-C  Always broad search; slider filters displayed results

**Current:** Slider value 0–4 is sent to LLM as `mode`; LLM only returns results at or
below that strictness level.

**New behaviour:**
- `doFind()` always calls `_doFindAI(query, 4, searchId)` (broadest).
- Slider is **hidden by default**; it slides down when mouse enters the panel
  (`mouseenter` → `row2.style.maxHeight = '24px'`; `mouseleave` → `row2.style.maxHeight = '0'`).
- Slider's `input` event no longer re-triggers `doFind`. Instead, it calls a new
  `filterHighlightsByScore(minScore)` function.
- `filterHighlightsByScore(min)`: iterate `_findHighlights`; for each text mark set
  `display: inline` if `score >= min`, else `display: none`. For elem highlights,
  toggle `visibility`. Then recount and update the counter.

**Score interpretation (unchanged):** 4=exact, 3=strict, 2=general, 1=broad.  
Slider left = 1 (show all), slider right = 4 (show only exact).  
Label on right of slider changes accordingly (currently "broad" ↔ "literal" — keep as-is).

**Accessibility:** Counter shows `"N visible / M total"` format when slider is not at 1.

---

## Phase 2 · Alt+1 Inline Floating Ask Widget
*Req 2 — biggest UI change; primarily `content.js`, with handoff to `sidepanel.js`.*

### 2-A  Alt+1 no longer opens sidebar; shows inline float instead

**New Alt+1 flow:**

```
Alt+1 pressed
  ├─ text already selected?  →  show float immediately (skip element pick)
  └─ no selection            →  enter visual-select mode (existing hover/click logic)
                                    └─ on element click  →  show float near element
```

Float position: use `selection.getRangeAt(0).getBoundingClientRect()` (text selection) or
`el.getBoundingClientRect()` (element pick). Place float 8 px below the bottom-right corner
of the bounding rect, clamped to viewport.

Remove `openSidePanel(true)` from the Alt+1 branch in the `keydown` handler.
Remove the `OPEN_SIDE_PANEL` dispatch from `exitVisualMode()` when called after a pick.

---

### 2-B  Floating ask widget UI

Widget ID: `__cwa_ask_float__`. Created once per page; hidden when inactive.

**Layout (single column, ~300 px wide):**

```
┌──────────────────────────────────┐
│  [model badge]  ● status text    │  ← header row (8px padding)
│─────────────────────────────────│
│  textarea (auto-grow, max 4 rows) │
│─────────────────────────────────│
│  [Preset ▾]          [▶ Send]   │  ← footer row
└──────────────────────────────────┘
```

Elements:
- **Model badge**: same style as sidebar badge, click cycles model. Reads/writes `S.floatModel` in `chrome.storage.sync`.
- **Status dot + text**: green = ready, yellow = streaming, grey = idle after abort.
- **Send / Abort toggle**: single `<button>`. Label = "▶" when idle; "■" when streaming.
  On click when streaming: call `_floatPort.disconnect()` (aborts stream), show partial reply, set status to idle.
- **Textarea**: Enter sends (Shift+Enter = newline). Escape hides widget.
- **Preset dropdown**: reuses existing preset list from `S.presets`; applies `presetInstruction` to payload.

Styling: same dark theme as find panel (`#161616` bg, `#4dfa9a` accent, monospace font).  
Widget is **draggable** (same pointer-event technique as Phase 1-A).

---

### 2-C  First response in float; second question opens sidebar

**State machine for `__cwa_ask_float__`:**

| State | Meaning |
|---|---|
| `pick` | Waiting for element selection |
| `input` | Showing textarea, waiting for user question |
| `streaming` | LLM streaming reply into float |
| `done_first` | First reply complete; textarea resets for follow-up |
| `sidebar_hand_off` | Second question submitted → open sidebar |

**First reply:** render streaming text into a `<div class="float-reply">` inside the float.
Use `chrome.runtime.connect({ name: 'cwa' })` port (same as sidepanel). Store port in `_floatPort`.

**Second question trigger:** When `done_first` state AND user sends another message:
1. Package `{ firstQ, firstA, secondQ, selection, url, title }` into  
   `chrome.storage.session.set({ cwaFloatHandoff: { ... } })`.
2. Call `openSidePanel(true)` (has gesture context from keyboard event).
3. Hide float widget.

**Sidepanel pickup:** In `init()` replay check (bottom of `init`), add:
```js
if (pending.cwaFloatHandoff) onFloatHandoff(pending.cwaFloatHandoff);
```
`onFloatHandoff` pre-populates the chat with the two turns and focuses the input.

---

### 2-D  Fix button-height display bug in sidebar

**Bug:** Send / other buttons appear clipped (height too low).

**Diagnosis target:** look for `height:` / `min-height:` / `line-height:` on `.chat-send` and
`.preset-btn` in `sidepanel.html` `<style>` block. Most likely cause: explicit `height: 28px`
with `padding` overflowing it, or `box-sizing: content-box`.

**Fix:** Set `min-height` instead of `height`; ensure `box-sizing: border-box`.  
Verify across narrow sidebar widths (≥ 240 px).

---

## Phase 3 · DuckDuckGo Instant Answer API
*Req 3 — replace Brave Search / Serper with free DuckDuckGo API.*

### 3-A  Background handler update

**Endpoint:** `https://api.duckduckgo.com/?q={query}&format=json&no_html=1&skip_disambig=1`  
No API key required. Responses may be empty for obscure queries.

**Replace** the `WEB_SEARCH` handler in `background.js`:

```js
// DuckDuckGo Instant Answer
const r = await fetch(
  'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) +
  '&format=json&no_html=1&skip_disambig=1'
);
const data = await r.json();

// Build results array from DDG response fields:
const results = [];
if (data.AbstractText) results.push({
  title: data.AbstractSource || 'DuckDuckGo',
  url:   data.AbstractURL   || 'https://duckduckgo.com/?q=' + encodeURIComponent(query),
  snippet: data.AbstractText,
});
(data.RelatedTopics || []).slice(0, 5).forEach(t => {
  if (t.Text && t.FirstURL) results.push({
    title: t.Text.split(' - ')[0] || t.Text.slice(0, 60),
    url: t.FirstURL,
    snippet: t.Text,
  });
});
if (!results.length) { respond({ error: 'No results from DuckDuckGo.' }); return; }
// ... then proceed to LLM summarisation (same as before)
```

### 3-B  Options page update

- Remove the "Search API" section (key + provider dropdown) from `options.html` / `options.js`.
- Remove `cwaSearchApiKey` / `cwaSearchProvider` sync storage reads.
- Keep `[SEARCH: ...]` pill UI in sidepanel unchanged — backend switch is transparent.

### 3-C  Manifest host_permissions

DuckDuckGo API is on `https://api.duckduckgo.com/*` — already covered by the existing
`"https://*/*"` wildcard host permission. No manifest change needed.

**Known limitation:** DDG Instant Answer is best for encyclopaedic / factual queries.
Time-sensitive news or niche topics may return no `AbstractText`. In that case, surface
`RelatedTopics` only, or show the "not found" fallback gracefully.

---

## Implementation Order Recommendation

```
Phase 0-A  (context caching)           — unblocks cache-hit benefits for all phases
Phase 1-C  (slider filter only)        — quick win, changes only JS in createFindPanel
Phase 1-A  (draggable panel)           — quick win, ~30 lines
Phase 1-B  (breathing animation)       — quick win, CSS only
Phase 2-D  (button height bug fix)     — quick fix, 1–2 lines CSS
Phase 0-B  (MutationObserver delta)    — medium complexity
Phase 0-C  (resume summary)           — medium complexity, needs LLM round-trip
Phase 2-A/B/C (inline float widget)   — largest chunk, do last in phase 2
Phase 3-A/B (DDG search)              — isolated, can be done any time
```

---

## Open Questions / Constraints to Track

| # | Topic | Decision |
|---|---|---|
| 1 | DDG API rate limits | Undocumented; monitor for 429 errors in production. Add exponential backoff if needed. |
| 2 | Float widget z-index collision | Use `2147483646` (one below find panel) to avoid fighting page z-index wars. |
| 3 | MutationObserver on PDFs | Disabled — PDF viewer has no `article`/`main`; observer attach is skipped. |
| 4 | `openSidePanel` in Alt+1 handoff | Must be called synchronously inside the `keydown` handler while gesture context is live. Handoff storage write happens before the open call. |
| 5 | Semantic search history | Not persisted — `_findHighlights` and `_find` state are already session-only in-memory. No change needed. |
