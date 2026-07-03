'use strict';

const $ = (id) => document.getElementById(id);
const state = { url: null, history: [], fontStep: 0 };

/* ---------- display settings ---------- */

$('fontUp').addEventListener('click', () => setFont(1));
$('fontDown').addEventListener('click', () => setFont(-1));
function setFont(delta) {
  state.fontStep = Math.max(-2, Math.min(4, state.fontStep + delta));
  document.documentElement.style.fontSize = 18 + state.fontStep * 2 + 'px';
  announce(`Text size ${state.fontStep >= 0 ? 'increased' : 'decreased'}`);
}

$('contrast').addEventListener('click', () => {
  const html = document.documentElement;
  const on = html.getAttribute('data-contrast') !== 'high';
  html.setAttribute('data-contrast', on ? 'high' : 'normal');
  $('contrast').setAttribute('aria-pressed', String(on));
  announce(on ? 'High contrast on' : 'High contrast off');
});

function announce(msg, isError = false) {
  const s = $('status');
  s.textContent = msg;
  s.className = isError ? 'err' : 'ok';
}

/* ---------- read a page ---------- */

document.querySelectorAll('.chip').forEach((c) =>
  c.addEventListener('click', () => { $('url').value = c.dataset.url; readPage(); }));

$('readForm').addEventListener('submit', (e) => { e.preventDefault(); readPage(); });

async function readPage() {
  const url = $('url').value.trim();
  if (!url) return;
  const btn = $('readBtn');
  btn.disabled = true;
  speechSynthesis.cancel();
  announce('Fetching the page at the nearest edge node and rebuilding it for reading…');
  try {
    const res = await fetch('/api/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    render(data);
    announce(data.cached
      ? 'Ready — served instantly from the EdgeOne KV cache.'
      : 'Ready. Use headings to navigate, or ask a question below.');
  } catch (err) {
    announce(`Could not read that page: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function render(data) {
  state.url = data.url;
  state.history = [];
  $('thread').textContent = '';
  $('result').hidden = false;

  $('resultTitle').textContent = data.title || data.url;
  const v = data.view;
  $('summary').textContent = v.summary || '';
  $('meta').textContent =
    `${v.readingTimeMin ? `~${v.readingTimeMin} min read · ` : ''}${new URL(data.url).hostname}` +
    (data.cached ? ' · from KV cache' : '');

  const sections = $('sections');
  sections.textContent = '';
  (v.sections || []).forEach((s) => {
    sections.append(el('h3', {}, s.heading));
    sections.append(el('p', {}, s.body));
  });

  const outline = $('outline');
  outline.textContent = '';
  (data.headings || []).slice(0, 20).forEach((h) => {
    outline.append(el('li', { class: `lv${h.level}` }, h.text));
  });
  if (!outline.children.length) outline.append(el('li', {}, 'No headings found on the original page — Lumen created its own structure above.'));

  const actions = $('actions');
  actions.textContent = '';
  (v.keyActions || []).forEach((a) => {
    const li = el('li');
    const link = el('a', { href: a.href, rel: 'noopener' }, a.label);
    li.append(link);
    actions.append(li);
  });
  if (!actions.children.length) actions.append(el('li', {}, 'No obvious actions on this page.'));

  const warnings = $('warnings');
  warnings.textContent = '';
  const warns = (v.warnings || []).filter(Boolean);
  $('warnCard').hidden = warns.length === 0;
  warns.forEach((w) => warnings.append(el('li', {}, w)));

  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- listen (text-to-speech) ---------- */

$('listen').addEventListener('click', () => {
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    $('listen').textContent = '🔊 Listen';
    return;
  }
  const parts = [$('resultTitle').textContent, $('summary').textContent];
  document.querySelectorAll('#sections h3, #sections p').forEach((n) => parts.push(n.textContent));
  const utter = new SpeechSynthesisUtterance(parts.join('. '));
  utter.rate = 1.0;
  utter.onend = () => { $('listen').textContent = '🔊 Listen'; };
  speechSynthesis.speak(utter);
  $('listen').textContent = '⏹ Stop';
});

/* ---------- ask the agent ---------- */

$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q || !state.url) return;
  $('q').value = '';
  addMsg('user', q);
  const pending = addMsg('agent', 'Thinking…');
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: state.url, question: q, history: state.history }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    pending.textContent = '';
    (data.steps || []).forEach((s) => {
      pending.append(el('span', { class: 'step' }, `Opened ${s.href}${s.why ? ` — ${s.why}` : ''}`));
    });
    pending.append(document.createTextNode(data.answer));
    state.history.push({ role: 'user', content: q }, { role: 'assistant', content: data.answer });
  } catch (err) {
    pending.textContent = `Sorry — ${err.message}`;
  }
});

function addMsg(kind, text) {
  const m = el('div', { class: `msg ${kind}` }, text);
  $('thread').append(m);
  m.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return m;
}

/* ---------- keyboard shortcuts ---------- */

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === '/') { e.preventDefault(); $('q').focus(); }
});

/* ---------- shareable links: ?u=<url> auto-reads on load ---------- */

const shared = new URLSearchParams(location.search).get('u');
if (shared) {
  $('url').value = shared;
  readPage();
}

/* ---------- edge node info ---------- */

fetch('/api/health').then((r) => r.json()).then((h) => {
  const place = [h.node?.city, h.node?.country].filter(Boolean).join(', ');
  $('edgeInfo').textContent =
    `Running on Tencent EdgeOne${place ? ` · nearest node region: ${place}` : ''} · edge AI: DeepSeek (built-in) · KV cache: ${h.kv ? 'on' : 'off'}`;
}).catch(() => {
  $('edgeInfo').textContent = 'Running on Tencent EdgeOne';
});
