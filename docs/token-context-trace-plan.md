# Pluck Token/Context/Trace Incremental Implementation Plan

## Summary

Pluck should use an `instant` local-first retrieval path for webpage floating UI and a `balanced` default for the sidebar. Higher-cost behavior is only enabled when the user explicitly chooses `balanced` or `deep`, clicks Alt+S `TRY HARDER`, retries an answer with `TRY HARDER`, or runs `RE-TRACE`.

Third-party evaluation: MiniSearch is the best mature candidate for a future vendored local search layer, but this implementation keeps the first increment self-contained because Chrome MV3 extensions cannot load remotely hosted code. mark.js may improve highlighting later, but it does not solve citation verification. First-shot span extraction and anti-hallucination citation validation remain product-specific and are implemented locally.

## Effort Levels

| Effort | Find budget | Trace budget | Evidence budget | Middle anchors | Use |
| --- | ---: | ---: | ---: | ---: | --- |
| `instant` | 3,500 chars | 3,500 chars | 2,500 chars | 3 | Float/default fast path, no trace entry |
| `balanced` | 6,000 chars | 7,000 chars | 4,500 chars | 5 | Sidebar default / first retry |
| `deep` | 11,000 chars | 14,000 chars | 8,000 chars | 9 | Try hard / Re-trace |

## Implemented Architecture

- Page text remains cached locally. Requests receive compact evidence packs, page maps, middle anchors, and verified candidate spans instead of blindly sending more full text.
- First-shot citation prompts use `<src id="sN">verbatim span</src>` against local candidate spans. Any generated source span that cannot be verified locally is downgraded to `[unverified]`.
- TRACE uses reply/source candidate compression before calling the model and validates returned evidence as `verified` or `unverified`.
- Alt+S keeps instant as default and exposes `TRY HARDER` to choose balanced/deep and rerun the same query.
- Sidebar exposes an effort dropdown and a provider/model dropdown. Effort is stored as `cwaEffort`; models remain stored as `cwaProvider`/`cwaModel`.

## Third-Party Notes

- MiniSearch is the preferred future replacement for the current local retrieval code because it is small, browser-friendly, zero-dependency, and supports field boosting, fuzzy matching, prefix search, and filtering.
- Fuse.js is useful for typo-tolerant fuzzy matching but is less suitable as the primary long-document retrieval engine.
- Lunr/Elasticlunr are mature BM25-style options, but their dynamic chunk/filter ergonomics fit Pluck less well than MiniSearch.
- mark.js can be evaluated later for robust cross-element highlighting. It should be vendored only if it measurably improves trace highlighting without DOM instability.
- Any third-party JS must be bundled in the extension package, not loaded from a CDN.

## Test Plan

- Alt+S instant sends no more candidate text than before; `TRY HARDER` increases recall and clears old highlights.
- Long-page middle queries hit middle chunks through page maps and anchors.
- First-shot citations render only when the `<src>` evidence matches a local candidate span.
- TRACE does not truncate deep sources to only the first 8,000 chars; Re-trace increases candidate budget.
- OpenAI GPT-5 models and DeepSeek reasoning/flash/pro models do not receive unsupported temperature values.
- Effort and model dropdown selections persist across list and chat status bars.
