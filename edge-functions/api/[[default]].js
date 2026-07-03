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

function extractPage(html, baseUrl) {
  html = html.slice(0, MAX_HTML_BYTES);

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
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error('Only http/https URLs are supported');
  const res = await fetch(target.href, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; LumenAgent/1.0; +https://lumen.edgeone.app) accessibility reader',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`The site responded with HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('html') && !ct.includes('text')) throw new Error(`Not a readable page (content-type: ${ct})`);
  return extractPage(await res.text(), target.href);
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
  raw = raw.trim();
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
    } catch (e) {
      lastErr = e;
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
You may use ONE tool: to open a link from the page, reply with STRICT JSON {"tool":"open_link","href":"<absolute url from the provided links>","why":"short reason"} and nothing else.
Otherwise reply with the final answer as plain conversational text (no JSON, no markdown headings): direct, specific, 1-4 sentences, quoting exact facts/numbers from the page. If the page truly lacks the answer, say so and point to the most relevant link.`;

function pageDigest(page) {
  return [
    `TITLE: ${page.title}`,
    page.metaDesc ? `META: ${page.metaDesc}` : '',
    `HEADINGS:\n${page.headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n')}`,
    `LINKS:\n${page.links.map((l) => `- [${l.text}](${l.href})`).join('\n')}`,
    `CONTENT:\n${page.text}`,
  ].filter(Boolean).join('\n\n');
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

  const store = kv();
  const viewKey = `view:${await sha1(normalized)}`;
  if (store && !body.fresh) {
    try {
      const hit = await store.get(viewKey);
      if (hit) return json({ ...JSON.parse(hit), cached: true });
    } catch { /* fall through to live path */ }
  }

  const { page } = await getPageCached(normalized, ctx);
  const raw = await chat([
    { role: 'system', content: READ_SYSTEM },
    { role: 'user', content: pageDigest(page) },
  ]);
  const view = parseJsonLoose(raw);
  if (!view || !Array.isArray(view.sections)) {
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
  return json(result);
}

async function handleAsk(body, ctx) {
  const url = String(body.url || '').trim();
  const question = String(body.question || '').trim().slice(0, 500);
  if (!url || !question) return json({ error: 'Provide url and question' }, 400);

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const { page } = await getPageCached(url, ctx);

  const messages = [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: `PAGE DATA:\n${pageDigest(page)}` },
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 1000) })),
    { role: 'user', content: question },
  ];

  const steps = [];
  let answer = await chat(messages);

  // Agent loop: allow one link-follow tool call.
  const tool = parseJsonLoose(answer);
  if (tool && tool.tool === 'open_link' && tool.href) {
    const allowed = page.links.some((l) => l.href === tool.href);
    if (allowed) {
      steps.push({ action: 'open_link', href: tool.href, why: tool.why || '' });
      try {
        const linked = await fetchPage(tool.href);
        messages.push({ role: 'assistant', content: answer });
        messages.push({
          role: 'user',
          content: `TOOL RESULT for ${tool.href}:\n${pageDigest(linked).slice(0, 9000)}\n\nNow answer the original question in plain text.`,
        });
        answer = await chat(messages);
      } catch (e) {
        answer = `I tried to open ${tool.href} but could not (${e.message}). Based on the current page: ` +
          (page.metaDesc || page.title || 'no further information is available.');
      }
    }
  }

  const plain = answer
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return json({ answer: plain, steps });
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
    return json({ error: e.message || 'Unexpected error' }, 500);
  }
}
