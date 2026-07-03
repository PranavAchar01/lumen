/*
 * Lumen — edge accessibility agent
 * Runs entirely on Tencent EdgeOne Edge Functions.
 *
 * Routes (single catch-all to share helpers within EdgeOne's one-file-per-route model):
 *   POST /api/read   { url }                          -> structured accessible reading view
 *   POST /api/ask    { url, question, history[] }     -> agentic Q&A (can follow links as a tool)
 *   GET  /api/health                                  -> edge node geo + status
 *
 * Sponsored tech used here: EdgeOne Pages Functions, EdgeOne Edge AI (built-in
 * DeepSeek models via the AI global, no API key), EdgeOne KV (optional cache),
 * EdgeOne geo metadata (request.eo).
 */

const MODELS = [
  '@tx/deepseek-ai/deepseek-v4',
  '@tx/deepseek-ai/deepseek-v32',
  '@tx/deepseek-ai/deepseek-v3-0324',
];

const MAX_HTML_BYTES = 400_000;
const MAX_CONTENT_CHARS = 11_000;
const MAX_LINKS = 40;
const CACHE_TTL_S = 60 * 60 * 24;
const MAX_REDIRECTS = 4;
const MAX_TOOL_HOPS = 3; // agent may open up to this many links while answering

/* ---------------- Telemetry ---------------- */

// Structured, greppable logs. EdgeOne surfaces console output in the console's
// runtime logs; each line is a single JSON object so it can be parsed downstream.
function log(event, data = {}) {
  try {
    console.log(JSON.stringify({ evt: event, t: new Date().toISOString(), ...data }));
  } catch { /* logging must never throw */ }
}
function logError(event, err, data = {}) {
  try {
    console.error(JSON.stringify({ evt: event, level: 'error', t: new Date().toISOString(), err: String(err && err.message || err), ...data }));
  } catch { /* logging must never throw */ }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

function kv() {
  try {
    // Optional KV namespace bound as `lumen_kv` in the EdgeOne console.
    // eslint-disable-next-line no-undef
    return typeof lumen_kv !== 'undefined' ? lumen_kv : null;
  } catch {
    return null;
  }
}

async function sha1(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- SSRF guard ----------------
 * Lumen fetches user-supplied URLs from inside an edge function, so it must not
 * be usable as a proxy into private networks or the cloud metadata endpoint.
 * We reject: non-http(s) schemes, credentials in the URL, non-default-looking
 * ports, and any host that is (or parses to) a private / loopback / link-local /
 * reserved IP or a private-use hostname. Redirects are followed manually and
 * every hop is re-checked (see fetchPage), which closes the redirect-to-internal
 * bypass. Note: this blocks IP-literal and known-name attacks; it cannot by
 * itself defeat DNS rebinding, since the edge runtime does not expose a resolver
 * to pin the address — documented in the README's security section.
 */

function ipv4ToParts(host) {
  // Accepts dotted-decimal only; other encodings (octal/hex/decimal) are
  // rejected outright below as non-standard and therefore suspicious.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isPrivateIPv4(parts) {
  const [a, b] = parts;
  if (a === 0) return true;                       // 0.0.0.0/8 "this host"
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                      // multicast + reserved
  return false;
}

function isBlockedHost(host) {
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal') return true;

  // Bracketed or bare IPv6 — block loopback, link-local, unique-local, unspecified.
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const mapped = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (mapped) {
      const p = ipv4ToParts(mapped[1]);
      if (!p || isPrivateIPv4(p)) return true;
    }
    return false;
  }

  const parts = ipv4ToParts(host);
  if (parts) return isPrivateIPv4(parts);

  // A bare number, hex, or 0x/octal form is not a normal hostname — treat as hostile.
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) return true;
  return false;
}

function assertFetchableUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That does not look like a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed');
  if (u.port && !['', '80', '443', '8080', '8443'].includes(u.port)) {
    throw new Error('That port is not allowed');
  }
  if (isBlockedHost(u.hostname)) throw new Error('That address is not allowed');
  return u;
}

/* ---------------- HTML -> readable text extraction ---------------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Regex-based extraction is deliberately lightweight: edge functions have a hard
// CPU budget (~200ms) and no DOM, so a full HTML parser is not an option here.
// It is a heuristic reader, not a spec-compliant parser — it favours resilience
// (never throws on malformed markup) over perfect fidelity on deeply nested DOMs.
function extractPage(html, baseUrl) {
  html = String(html).slice(0, MAX_HTML_BYTES);

  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [, ''])[1];
  const lang = (html.match(/<html[^>]+lang=["']([^"']+)["']/i) || [, ''])[1];

  // Drop non-content blocks before text extraction.
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const headings = [];
  const hRe = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = hRe.exec(body)) && headings.length < 60) {
    const text = stripTags(m[2]);
    if (text) headings.push({ level: Number(m[1]), text: text.slice(0, 160) });
  }

  const links = [];
  const seen = new Set();
  const aRe = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(body)) && links.length < MAX_LINKS) {
    const text = stripTags(m[2]).slice(0, 90);
    let href = m[1];
    if (!text || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try { href = new URL(href, baseUrl).href; } catch { continue; }
    if (!href.startsWith('http') || seen.has(href)) continue;
    seen.add(href);
    links.push({ text, href });
  }

  // Prefer main/article content when present.
  const mainMatch = body.match(/<(main|article)[\s\S]*?<\/\1>/i);
  let contentHtml = mainMatch ? mainMatch[0] : body;
  contentHtml = contentHtml
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|blockquote)>/gi, '\n');
  const text = decodeEntities(contentHtml.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 2)
    .join('\n')
    .slice(0, MAX_CONTENT_CHARS);

  return { title, metaDesc, lang, headings, links, text };
}

async function fetchPage(url) {
  let current = assertFetchableUrl(url);

  // Follow redirects manually so every hop is re-validated by the SSRF guard.
  let res;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(current.href, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; LumenAgent/1.0; +https://lumen.edgeone.cool) accessibility reader',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects');
      const next = new URL(res.headers.get('location'), current.href);
      current = assertFetchableUrl(next.href); // re-check the redirect target
      continue;
    }
    break;
  }

  if (!res.ok) throw new Error(`The site responded with HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('html') && !ct.includes('text')) throw new Error(`Not a readable page (content-type: ${ct || 'unknown'})`);
  return extractPage(await res.text(), current.href);
}

/* ---------------- Edge AI helpers ---------------- */

async function drainStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function contentFromChunk(obj) {
  const c = obj?.choices?.[0];
  return c?.delta?.content ?? c?.message?.content ?? c?.text ?? '';
}

function parseModelOutput(raw) {
  raw = String(raw).trim();
  if (!raw) return '';
  // Whole-body JSON (non-streamed OpenAI shape)
  try {
    const obj = JSON.parse(raw);
    const c = contentFromChunk(obj);
    if (c) return c;
  } catch { /* try SSE */ }
  // SSE: lines of `data: {...}` with streamed deltas
  if (raw.includes('data:')) {
    let acc = '';
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.+)$/);
      if (!m || m[1] === '[DONE]') continue;
      try { acc += contentFromChunk(JSON.parse(m[1])); } catch { /* skip */ }
    }
    if (acc) return acc;
  }
  return raw;
}

async function chat(messages) {
  let lastErr = new Error('No model available');
  for (const model of MODELS) {
    try {
      // eslint-disable-next-line no-undef
      const r = await AI.chatCompletions({ model, messages, stream: false });
      let raw;
      if (r instanceof ReadableStream) raw = await drainStream(r);
      else if (r && typeof r.text === 'function') raw = await r.text();
      else if (typeof r === 'string') raw = r;
      else raw = JSON.stringify(r);
      const content = parseModelOutput(raw);
      if (content && content.trim()) return content;
      lastErr = new Error(`Empty response from ${model}`);
      logError('model.empty', lastErr, { model });
    } catch (e) {
      lastErr = e;
      logError('model.error', e, { model });
    }
  }
  throw lastErr;
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

const READ_SYSTEM = `You are Lumen, an accessibility agent that rebuilds cluttered web pages for blind and low-vision readers using screen readers, and for people with cognitive or reading disabilities.
Given raw page data, respond with STRICT JSON only (no markdown fences, no commentary) in this shape:
{
  "summary": "2-3 plain sentences: what this page is and what a visitor can do here",
  "readingTimeMin": 3,
  "sections": [{ "heading": "short heading", "body": "faithful, plain-language rewrite of that part. Preserve facts and numbers exactly." }],
  "keyActions": [{ "label": "what the user can do", "href": "url" }],
  "warnings": ["accessibility traps on the original page, e.g. auto-playing media, unlabeled buttons — empty array if none"]
}
Rules: write at a clear 8th-grade reading level without dumbing down facts; never invent content not present in the data; 3-6 sections max; 3-5 keyActions chosen from the provided links (most useful first).`;

const ASK_SYSTEM = `You are Lumen, an accessibility agent answering questions about a web page for a screen-reader user.
You may use a tool to open a link that appears on the page: reply with STRICT JSON {"tool":"open_link","href":"<absolute url from the provided links>","why":"short reason"} and nothing else. You may do this more than once, one link at a time, to gather what you need before answering.
When you have enough information, reply with the final answer as plain conversational text (no JSON, no markdown headings): direct, specific, 1-4 sentences, quoting exact facts/numbers from the pages you read. If the answer truly cannot be found, say so and point to the most relevant link.`;

function pageDigest(page) {
  return [
    `TITLE: ${page.title}`,
    page.metaDesc ? `META: ${page.metaDesc}` : '',
    `HEADINGS:\n${page.headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n')}`,
    `LINKS:\n${page.links.map((l) => `- [${l.text}](${l.href})`).join('\n')}`,
    `CONTENT:\n${page.text}`,
  ].filter(Boolean).join('\n\n');
}

function stripMarkdown(answer) {
  return String(answer)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/* ---------------- Route handlers ---------------- */

async function getPageCached(url, ctx) {
  const store = kv();
  const key = `page:${await sha1(url)}`;
  if (store) {
    try {
      const hit = await store.get(key);
      if (hit) return { page: JSON.parse(hit), cached: true };
    } catch { /* cache miss path below */ }
  }
  const page = await fetchPage(url);
  if (store) {
    const write = store.put(key, JSON.stringify(page), { expirationTtl: CACHE_TTL_S }).catch(() => {});
    ctx?.waitUntil?.(write);
  }
  return { page, cached: false };
}

async function handleRead(body, ctx) {
  const url = String(body.url || '').trim();
  if (!url) return json({ error: 'Provide a url' }, 400);
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { assertFetchableUrl(normalized); } catch (e) { return json({ error: e.message }, 400); }

  const store = kv();
  const viewKey = `view:${await sha1(normalized)}`;
  if (store && !body.fresh) {
    try {
      const hit = await store.get(viewKey);
      if (hit) { log('read.cache_hit', { url: normalized }); return json({ ...JSON.parse(hit), cached: true }); }
    } catch { /* fall through to live path */ }
  }

  const started = Date.now();
  const { page } = await getPageCached(normalized, ctx);
  const raw = await chat([
    { role: 'system', content: READ_SYSTEM },
    { role: 'user', content: pageDigest(page) },
  ]);
  const view = parseJsonLoose(raw);
  if (!view || !Array.isArray(view.sections)) {
    logError('read.bad_model_json', new Error('unparseable view'), { url: normalized });
    return json({ error: 'The model returned an unreadable result. Please try again.' }, 502);
  }
  const result = {
    url: normalized,
    title: page.title,
    lang: page.lang || 'en',
    headings: page.headings,
    view,
    cached: false,
  };
  if (store) {
    const write = store.put(viewKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_S }).catch(() => {});
    ctx?.waitUntil?.(write);
  }
  log('read.ok', { url: normalized, ms: Date.now() - started, sections: view.sections.length });
  return json(result);
}

async function handleAsk(body, ctx) {
  const url = String(body.url || '').trim();
  const question = String(body.question || '').trim().slice(0, 500);
  if (!url || !question) return json({ error: 'Provide url and question' }, 400);
  try { assertFetchableUrl(/^https?:\/\//i.test(url) ? url : `https://${url}`); }
  catch (e) { return json({ error: e.message }, 400); }

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const { page } = await getPageCached(url, ctx);

  const messages = [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: `PAGE DATA:\n${pageDigest(page)}` },
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 1000) })),
    { role: 'user', content: question },
  ];

  const steps = [];
  const visited = new Set([page && page.title ? url : url]);
  let answer = await chat(messages);

  // Agent loop: the model may open up to MAX_TOOL_HOPS links, one at a time,
  // before giving its final answer. Each target must be a link that actually
  // appears on a page we have already read, and must pass the SSRF guard.
  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const tool = parseJsonLoose(answer);
    if (!tool || tool.tool !== 'open_link' || !tool.href) break;

    const known = page.links.some((l) => l.href === tool.href);
    if (!known || visited.has(tool.href)) {
      // Nudge the model to answer instead of looping on an invalid/repeat link.
      messages.push({ role: 'assistant', content: answer });
      messages.push({ role: 'user', content: 'That link is not available. Please answer the question using what you have already read.' });
      answer = await chat(messages);
      break;
    }

    visited.add(tool.href);
    steps.push({ action: 'open_link', href: tool.href, why: tool.why || '' });
    try {
      const linked = await fetchPage(tool.href);
      log('ask.hop', { href: tool.href, hop: hop + 1 });
      messages.push({ role: 'assistant', content: answer });
      messages.push({
        role: 'user',
        content: `TOOL RESULT for ${tool.href}:\n${pageDigest(linked).slice(0, 9000)}\n\nOpen another link if you still need more, otherwise answer the original question in plain text.`,
      });
      answer = await chat(messages);
    } catch (e) {
      logError('ask.hop_failed', e, { href: tool.href });
      messages.push({ role: 'assistant', content: answer });
      messages.push({ role: 'user', content: `Opening ${tool.href} failed (${e.message}). Answer using what you already have.` });
      answer = await chat(messages);
      break;
    }
  }

  // If the model's last utterance was still a tool call, don't return raw JSON.
  const trailing = parseJsonLoose(answer);
  if (trailing && trailing.tool) {
    answer = page.metaDesc || page.title
      ? `I could not open more links to answer fully. From this page: ${page.metaDesc || page.title}`
      : 'I was not able to find that on the page.';
  }

  log('ask.ok', { url, hops: steps.length });
  return json({ answer: stripMarkdown(answer), steps });
}

function handleHealth(request) {
  const eo = request.eo || {};
  const geo = eo.geo || eo;
  return json({
    ok: true,
    agent: 'lumen',
    node: {
      city: geo.cityName || geo.city || null,
      region: geo.regionName || geo.region || null,
      country: geo.countryName || geo.countryCodeAlpha2 || geo.country || null,
    },
    models: MODELS,
    kv: Boolean(kv()),
    time: new Date().toISOString(),
  });
}

export async function onRequest(context) {
  const { request } = context;
  const path = new URL(request.url).pathname.replace(/\/+$/, '');

  if (request.method === 'OPTIONS') return json({ ok: true });
  try {
    if (path.endsWith('/api/health')) return handleHealth(request);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (path.endsWith('/api/read')) return handleRead(body, context);
    if (path.endsWith('/api/ask')) return handleAsk(body, context);
    return json({ error: `No such endpoint: ${path}` }, 404);
  } catch (e) {
    logError('request.unhandled', e, { path });
    return json({ error: e.message || 'Unexpected error' }, 500);
  }
}

/* Pure helpers exported for the test suite (see test/lumen.test.mjs).
 * Exporting them is inert on the edge runtime. */
export const __test__ = {
  assertFetchableUrl, isBlockedHost, isPrivateIPv4, ipv4ToParts,
  extractPage, parseModelOutput, parseJsonLoose, stripMarkdown, contentFromChunk,
};
