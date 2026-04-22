// pdf-extract.js — minimal PDF text extractor (no external deps)
// Handles: FlateDecode (zlib) and uncompressed content streams.
// Does NOT handle: encrypted PDFs, scanned/image-only PDFs, multi-filter chains.
'use strict';

/**
 * Fetch a PDF URL and return extracted plain text (max ~8000 chars).
 * @param {string} url
 * @returns {Promise<string>}
 */
async function extractPdfText(url) {
  console.log('[CWA-PDF] extractPdfText: fetching url=', url);
  let res;
  try {
    res = await fetch(url);
  } catch(fetchErr) {
    console.error('[CWA-PDF] extractPdfText: fetch threw', fetchErr.message, 'url=', url);
    throw fetchErr;
  }
  console.log('[CWA-PDF] extractPdfText: HTTP', res.status, res.ok ? 'OK' : 'FAIL',
              'content-type=', res.headers.get('content-type'));
  if (!res.ok) throw new Error('PDF fetch failed: HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  console.log('[CWA-PDF] extractPdfText: arraybuffer bytes=', buf.byteLength);
  const text = await parsePdfText(new Uint8Array(buf));
  console.log('[CWA-PDF] extractPdfText: extracted chars=', text.length, 'preview=', text.slice(0, 80));
  return text;
}

async function parsePdfText(raw) {
  const latin = new TextDecoder('latin1').decode(raw);
  const texts = [];

  // Iterate every stream...endstream block
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(latin)) !== null) {
    const dataStart = match.index + match[0].length;

    // Locate endstream (search from dataStart, skip degenerate/huge streams)
    const endIdx = latin.indexOf('endstream', dataStart);
    if (endIdx < 0 || endIdx - dataStart > 4 * 1024 * 1024) continue;

    // Find the dict immediately preceding this stream keyword
    const dictEnd   = match.index;
    const dictStart = latin.lastIndexOf('<<', dictEnd);
    const dict = dictStart >= 0 ? latin.slice(dictStart, dictEnd) : '';

    // Determine filter
    const hasFlate = /\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dict);
    const hasAnyFilter = /\/Filter/.test(dict);
    if (hasAnyFilter && !hasFlate) continue; // skip unsupported combos

    // Trim trailing \r\n before endstream
    let dataEnd = endIdx;
    if (latin[dataEnd - 1] === '\n') dataEnd--;
    if (latin[dataEnd - 1] === '\r') dataEnd--;

    let streamText;
    if (hasFlate) {
      streamText = await _inflate(raw.slice(dataStart, dataEnd));
      if (!streamText) continue;
    } else {
      streamText = latin.slice(dataStart, dataEnd);
    }

    // Extract text from BT...ET operators
    const btRe = /BT([\s\S]*?)ET/g;
    let btm;
    while ((btm = btRe.exec(streamText)) !== null) {
      const t = _extractBt(btm[1]);
      if (t) texts.push(t);
    }
  }

  return texts.join('\n').replace(/[ \t]+/g, ' ').trim().slice(0, 8000);
}

/** Decompress zlib/deflate bytes, returns latin1 string or null on failure. */
async function _inflate(bytes) {
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const result = await _inflateWith(bytes, fmt);
      if (result !== null) return result;
    } catch (_) { /* try next format */ }
  }
  return null;
}

async function _inflateWith(bytes, fmt) {
  const ds     = new DecompressionStream(fmt);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write and read must run concurrently on a transform stream
  const writePromise = (async () => {
    try {
      await writer.write(bytes);
      await writer.close();
    } catch (_) { /* decompress error surfaces on reader side */ }
  })();

  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (_) {
    await writePromise;
    return null;  // this format failed, caller will try next
  }
  await writePromise;

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out   = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder('latin1').decode(out);
}

/** Extract visible text from a single BT...ET block. */
function _extractBt(block) {
  let out = '';
  // (str) Tj | (str) ' | [(...)...] TJ
  const re = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")|\[([^\]]*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    if (m[1] !== undefined) {
      out += _decodePdfStr(m[1]) + ' ';
    } else if (m[2] !== undefined) {
      const inner = m[2];
      const tjRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let t;
      while ((t = tjRe.exec(inner)) !== null) out += _decodePdfStr(t[1]);
      out += ' ';
    }
  }
  return out.trim();
}

/** Decode PDFDocEncoding string with escape sequences; handles UTF-16BE BOM. */
function _decodePdfStr(s) {
  // Check for UTF-16BE BOM (0xFE 0xFF)
  if (s.length >= 2 && s.charCodeAt(0) === 0xFE && s.charCodeAt(1) === 0xFF) {
    let str = '';
    for (let i = 2; i + 1 < s.length; i += 2) {
      const cp = ((s.charCodeAt(i) & 0xFF) << 8) | (s.charCodeAt(i + 1) & 0xFF);
      if (cp) str += String.fromCodePoint(cp);
    }
    return str;
  }
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, '$1');
}
