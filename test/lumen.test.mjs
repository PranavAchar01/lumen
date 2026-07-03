// Unit tests for Lumen's pure edge-function helpers.
// Run with:  node --test   (Node 18+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../edge-functions/api/[[default]].js');
const {
  assertFetchableUrl, isBlockedHost, isPrivateIPv4, ipv4ToParts,
  extractPage, parseModelOutput, parseJsonLoose, stripMarkdown,
} = mod.__test__;

test('SSRF guard blocks loopback, private, link-local and metadata hosts', () => {
  const blocked = [
    'http://localhost/', 'http://127.0.0.1/', 'http://127.1/', // 127.1 is a bare number -> blocked
    'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd00::1]/',
    'http://metadata.google.internal/', 'http://foo.local/', 'http://svc.internal/',
    'http://2130706433/', // decimal-encoded 127.0.0.1
    'http://0x7f000001/', // hex-encoded
    'ftp://example.com/', 'file:///etc/passwd', 'gopher://x/',
    'http://user:pass@example.com/', // embedded credentials
    'http://example.com:22/', // disallowed port
  ];
  for (const u of blocked) {
    assert.throws(() => assertFetchableUrl(u), new RegExp('.'), `should block ${u}`);
  }
});

test('SSRF guard allows normal public URLs', () => {
  const ok = [
    'https://example.com/', 'http://example.com/path?q=1',
    'https://en.wikipedia.org/wiki/Screen_reader',
    'https://sub.domain.co.uk:8443/x', 'https://8.8.8.8/', // public IP is fine
  ];
  for (const u of ok) assert.doesNotThrow(() => assertFetchableUrl(u), `should allow ${u}`);
});

test('isPrivateIPv4 classifies ranges correctly', () => {
  assert.equal(isPrivateIPv4([10, 1, 2, 3]), true);
  assert.equal(isPrivateIPv4([169, 254, 169, 254]), true);
  assert.equal(isPrivateIPv4([172, 20, 0, 1]), true);
  assert.equal(isPrivateIPv4([172, 32, 0, 1]), false); // just outside /12
  assert.equal(isPrivateIPv4([8, 8, 8, 8]), false);
  assert.equal(isPrivateIPv4([1, 1, 1, 1]), false);
});

test('ipv4ToParts rejects malformed and out-of-range octets', () => {
  assert.deepEqual(ipv4ToParts('192.168.0.1'), [192, 168, 0, 1]);
  assert.equal(ipv4ToParts('256.0.0.1'), null);
  assert.equal(ipv4ToParts('192.168.0'), null);
  assert.equal(ipv4ToParts('example.com'), null);
});

test('isBlockedHost is case-insensitive and handles trailing dot', () => {
  assert.equal(isBlockedHost('LOCALHOST'), true);
  assert.equal(isBlockedHost('127.0.0.1.'), true);
  assert.equal(isBlockedHost('Example.COM'), false);
});

test('extractPage pulls title, headings, links and text from messy HTML', () => {
  const html = `<!doctype html><html lang="en"><head><title>  Demo &amp; Co  </title>
    <meta name="description" content="A test page">
    <script>var x = "<h1>fake</h1>";</script></head>
    <body><nav><a href="/skip">skip</a></nav>
    <main><h1>Main Title</h1><p>First para with <b>bold</b> text &mdash; ok.</p>
    <h2>Sub</h2><p>Second para.</p>
    <a href="https://example.com/a">Alpha</a> <a href="mailto:x@y.com">mail</a>
    <a href="/rel">Rel</a></main></body></html>`;
  const p = extractPage(html, 'https://site.test/page');
  assert.equal(p.title, 'Demo & Co');
  assert.equal(p.metaDesc, 'A test page');
  assert.equal(p.lang, 'en');
  assert.ok(p.headings.some((h) => h.level === 1 && h.text === 'Main Title'));
  assert.ok(p.headings.some((h) => h.level === 2 && h.text === 'Sub'));
  // script content must not leak into headings
  assert.ok(!p.headings.some((h) => h.text === 'fake'));
  // relative link resolved against base, mailto excluded
  assert.ok(p.links.some((l) => l.href === 'https://site.test/rel' && l.text === 'Rel'));
  assert.ok(p.links.some((l) => l.href === 'https://example.com/a'));
  assert.ok(!p.links.some((l) => l.href.startsWith('mailto:')));
  assert.match(p.text, /First para with bold text — ok\./);
});

test('extractPage never throws on malformed markup', () => {
  for (const bad of ['', '<html', '<h1>unclosed', '<<<>>>', '<a href=>x</a>', '<title>only']) {
    assert.doesNotThrow(() => extractPage(bad, 'https://x.test/'));
  }
});

test('parseModelOutput handles OpenAI JSON, SSE stream and plain text', () => {
  const jsonBody = JSON.stringify({ choices: [{ message: { content: 'hello world' } }] });
  assert.equal(parseModelOutput(jsonBody), 'hello world');

  const sse = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n' +
              'data: {"choices":[{"delta":{"content":"lo"}}]}\n' +
              'data: [DONE]\n';
  assert.equal(parseModelOutput(sse), 'Hello');

  assert.equal(parseModelOutput('just text'), 'just text');
  assert.equal(parseModelOutput('   '), '');
});

test('parseJsonLoose recovers JSON from fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"b":2}\n```'), { b: 2 });
  assert.deepEqual(parseJsonLoose('Sure! {"c":3} done'), { c: 3 });
  assert.equal(parseJsonLoose('no json here'), null);
});

test('stripMarkdown removes bold, code and heading markers', () => {
  assert.equal(stripMarkdown('**Bold** and `code`'), 'Bold and code');
  assert.equal(stripMarkdown('# Heading\ntext'), 'Heading\ntext');
});
