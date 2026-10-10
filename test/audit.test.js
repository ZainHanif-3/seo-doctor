'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { scoreIssues, WEIGHTS } = require('../src/scoring');
const { parseRobots, robotsAllows, pathMatches } = require('../src/crawler');
const { isCustom404 } = require('../src/audit/technical');
const { runAudit } = require('../src/audit');
const { parsePage } = require('../src/parse');
const { normalizeInputUrl, mirrorRelPath, siteKey, truncateSentence, firstSignificantWord } = require('../src/util');

test('scoring: weights and floor behave as specified', () => {
  assert.strictEqual(scoreIssues([]).score, 100);
  assert.strictEqual(scoreIssues([]).counts.critical, 0);

  const allCritical = Array.from({ length: 5 }, (_, i) => ({ severity: 'critical', id: i }));
  const r1 = scoreIssues(allCritical);
  assert.strictEqual(r1.score, 0, 'all-critical scores 0');
  assert.strictEqual(r1.counts.critical, 5);

  const allLow = Array.from({ length: 5 }, (_, i) => ({ severity: 'low', id: i }));
  const r2 = scoreIssues(allLow);
  assert.strictEqual(r2.score, 90, 'all-low = 100 - 1/10*100');

  const mixed = scoreIssues([
    { severity: 'critical' }, { severity: 'high' }, { severity: 'medium' }, { severity: 'low' }
  ]);
  assert.strictEqual(mixed.weighted, WEIGHTS.critical + WEIGHTS.high + WEIGHTS.medium + WEIGHTS.low);
  assert.strictEqual(mixed.counts.high, 1);
  assert.ok(mixed.score > 0 && mixed.score < 100);
});

test('robots parsing: groups, sitemaps, agent matching', () => {
  const txt = '# comment\nUser-agent: Googlebot\nDisallow: /private\n\nUser-agent: *\nDisallow: /admin\nAllow: /admin/public\nSitemap: https://x.com/sitemap.xml\n';
  const r = parseRobots(txt);
  assert.strictEqual(r.groups.length, 2);
  assert.deepStrictEqual(r.sitemaps, ['https://x.com/sitemap.xml']);

  assert.strictEqual(robotsAllows('/admin/panel', r), false, 'blocked by Disallow /admin');
  assert.strictEqual(robotsAllows('/admin/public/x', r), true, 'longer Allow wins');
  assert.strictEqual(robotsAllows('/about', r), true);
});

test('robots path matching: prefix, wildcard and $ anchor', () => {
  assert.strictEqual(pathMatches('/fish.html', '/fish'), true);
  assert.strictEqual(pathMatches('/fish/salmon', '/fish'), true);
  assert.strictEqual(pathMatches('/Fish', '/fish'), false, 'robots paths are case sensitive');
  assert.strictEqual(pathMatches('/bait', '/fish$'), false);
  assert.strictEqual(pathMatches('/fish$', '/fish$'), false);
  assert.strictEqual(pathMatches('/a/b/c', '/a/*/c'), true);
  assert.strictEqual(pathMatches('/abc', '/'), true);
});

test('robotsAllows: allows everything when no robots rules apply', () => {
  assert.strictEqual(robotsAllows('/anything', null), true);
  const empty = parseRobots('');
  assert.strictEqual(robotsAllows('/anything', empty), true);
});

test('custom 404 detection', () => {
  assert.strictEqual(isCustom404('<h1>404</h1><p>Page not found</p>'), true);
  assert.strictEqual(isCustom404('<!doctype html><html><head><title>Error</title></head><body><pre>Cannot GET /x</pre></body></html>'), false);
});

test('util: url normalization and mirror paths', () => {
  assert.strictEqual(normalizeInputUrl('example.com'), 'https://example.com/');
  assert.strictEqual(normalizeInputUrl('http://localhost:3200/demo'), 'http://localhost:3200/demo');
  assert.strictEqual(normalizeInputUrl('ftp://x'), null);
  assert.strictEqual(normalizeInputUrl(''), null);

  assert.strictEqual(mirrorRelPath('http://x/'), 'index.html');
  assert.strictEqual(mirrorRelPath('http://x/demo'), 'demo/index.html');
  assert.strictEqual(mirrorRelPath('http://x/demo/'), 'demo/index.html');
  assert.strictEqual(mirrorRelPath('http://x/demo/about.html'), 'demo/about.html');
  assert.strictEqual(mirrorRelPath('http://x/img/a.png'), 'img/a.png');

  assert.strictEqual(siteKey('www.Example.com'), 'example.com');
  assert.strictEqual(siteKey('example.com'), 'example.com');
});

test('util: natural description truncation + keyword extraction', () => {
  const long = 'This sentence is the first one and it is reasonably long. This second sentence continues the thought much further than the limit allows for sure.';
  const cut = truncateSentence(long, 155, 160);
  assert.ok(cut.length <= 160, 'capped');
  assert.ok(/[.!?]$/.test(cut), 'ends at a boundary');

  assert.strictEqual(firstSignificantWord('The Quick Brown Fox'), 'quick');
  assert.strictEqual(firstSignificantWord('and of the'), '');
});

test('parsePage extracts the audit surface from a document', () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>My Page Title That Is Long Enough</title>
    <meta name="description" content="${'d'.repeat(150)}">
    <meta name="viewport" content="width=device-width">
    <meta charset="utf-8">
    <link rel="canonical" href="https://example.com/my-page">
    <meta property="og:title" content="My Page Title That Is Long Enough">
    <style>.a { color: red;\n  margin: 0; }</style>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>
  </head><body>
    <h1>My Page Title That Is Long Enough</h1><h3>Sub</h3>
    <p>${'word '.repeat(60)}</p>
    <img src="/img/a.png" alt="A" width="10" height="10">
    <img src="/img/b.png">
    <a href="/next">Next</a>
  </body></html>`;

  const p = parsePage(html, 'https://example.com/my-page');
  assert.strictEqual(p.title, 'My Page Title That Is Long Enough');
  assert.ok(p.description.length >= 140);
  assert.strictEqual(p.lang, 'en');
  assert.strictEqual(p.viewport, 'width=device-width');
  assert.ok(p.charset);
  assert.strictEqual(p.canonical, 'https://example.com/my-page');
  assert.strictEqual(p.h1s.length, 1);
  assert.strictEqual(p.images.length, 2);
  assert.strictEqual(p.images[0].width, '10');
  assert.strictEqual(p.images[1].width, undefined);
  assert.strictEqual(p.links[0].abs, 'https://example.com/next');
  assert.strictEqual(p.jsonld.length, 1);
  assert.strictEqual(p.inlineStyles.length, 1);
  assert.ok(p.wordCount > 55);
  assert.ok(p.firstParagraph.length > 50);
  assert.strictEqual(p.og.title, 'My Page Title That Is Long Enough');
});

function fakeCrawl(pages, probes = {}) {
  const startUrl = 'https://site.test/';
  return {
    startUrl,
    origin: 'https://site.test',
    host: 'site.test',
    siteKey: 'site.test',
    robots: { status: 404, exists: false, text: '', parsed: null, ...probes.robots },
    favicon: { status: 404, ok: false, ...probes.favicon },
    canary: { status: 404, body: '<html><head><title>Error</title></head><body><pre>Cannot GET /nope</pre></body></html>', ...probes.canary },
    sitemap: { status: 404, exists: false, text: '' },
    blockedPaths: [],
    assets: [],
    linkStatus: {},
    limits: { maxPages: 30, maxDepth: 3, budgetMs: 10000, concurrency: 4 },
    truncated: false,
    stopReason: null,
    durationMs: 12,
    pages
  };
}

function page(url, html, extra = {}) {
  const parsed = html ? parsePage(html, url) : null;
  return { url, finalUrl: url, status: 200, chain: [], contentType: 'text/html', size: html ? Buffer.byteLength(html) : 0, html, parsed, depth: 0, fetchedAt: new Date().toISOString(), ...extra };
}

test('runAudit: finds the expected issue families on a broken page set', () => {
  const home = page('https://site.test/', `<!doctype html><html><head></head><body>
    <h1>Home</h1>
    <p>${'lorem ipsum dolor sit amet '.repeat(20)}</p>
    <img src="/img/a.png">
    <a href="/missing">broken</a>
  </body></html>`);
  const missing = page('https://site.test/missing', null, { status: 404 });

  const crawl = fakeCrawl([home, missing]);
  const { issues, score, counts } = runAudit(crawl, { siteName: 'Site', lang: 'en' });

  const rules = new Set(issues.map(i => i.rule));
  for (const expected of [
    'title', 'description', 'robots-meta', 'canonical', 'viewport',
    'img-alt', 'img-dimensions', 'og', 'favicon', 'jsonld',
    'robots-txt', 'sitemap-xml', 'page-status', 'link-broken',
    'page-404', 'theme-color', 'breadcrumb'
  ]) {
    assert.ok(rules.has(expected), `missing expected rule: ${expected}`);
  }

  const robotsIssue = issues.find(i => i.rule === 'robots-txt');
  assert.strictEqual(robotsIssue.severity, 'high');
  assert.strictEqual(robotsIssue.autoFixable, true);

  const broken = issues.find(i => i.rule === 'link-broken');
  assert.ok(broken.evidence.includes('/missing'));

  assert.ok(score >= 0 && score < 100);
  assert.ok(counts.critical + counts.high + counts.medium + counts.low === issues.length);

  const ids = issues.map(i => i.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'issue ids unique');

  const nonFixable = issues.filter(i => !i.fixable);
  assert.ok(nonFixable.every(i => i.advice && i.advice.length > 10), 'manual issues carry advice');
});

test('runAudit: a clean page set scores higher than the broken one', () => {
  const clean = page('https://site.test/', `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>A perfectly valid page title that fits</title>
    <meta name="description" content="${'A unique description that is definitely long enough to pass the length checks and describes the page clearly. '.slice(0, 150)}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="https://site.test/">
    <link rel="icon" href="/favicon.ico">
    <meta property="og:title" content="t"><meta property="og:description" content="d">
    <meta property="og:image" content="i"><meta property="og:url" content="u"><meta property="og:type" content="website">
    <meta name="twitter:card" content="summary"><meta name="twitter:title" content="t"><meta name="twitter:description" content="d">
    <meta name="theme-color" content="#000">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList"}</script>
    <style>.a{color:red}</style>
  </head><body>
    <h1>A perfectly valid page title</h1>
    ${'<p>' + 'unique words here '.repeat(30) + '</p>'}
    <img src="/img/a.png" alt="A" width="10" height="10" loading="lazy">
  </body></html>`);

  const crawl = fakeCrawl([clean], {
    robots: { status: 200, exists: true, text: 'User-agent: *\nAllow: /\nSitemap: https://site.test/sitemap.xml\n', parsed: parseRobots('User-agent: *\nAllow: /\nSitemap: https://site.test/sitemap.xml\n') },
    favicon: { status: 200, ok: true },
    canary: { status: 404, body: '<h1>404 - page not found</h1>' }
  });
  crawl.sitemap = { status: 200, exists: true, text: '<urlset></urlset>' };

  const broken = runAudit(fakeCrawl([page('https://site.test/', '<html><body></body></html>')]), { siteName: 'S', lang: 'en' });
  const ok = runAudit(crawl, { siteName: 'S', lang: 'en' });

  assert.ok(ok.issues.length < broken.issues.length, `${ok.issues.length} < ${broken.issues.length}`);
  assert.ok(ok.score > broken.score, `clean ${ok.score} > broken ${broken.score}`);
});
