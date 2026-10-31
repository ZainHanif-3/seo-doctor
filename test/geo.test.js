'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parsePage } = require('../src/parse');
const { runAudit } = require('../src/audit');
const { runLoop } = require('../src/optimizer');
const { scoreReport, projectScore } = require('../src/scoring');
const { applyPageFixes } = require('../src/fixers');
const { possibleFor } = require('../src/audit/geo');

function page(url, html) {
  return { url, finalUrl: url, status: 200, html, parsed: parsePage(html, url), depth: 0, size: html.length };
}

function crawlOf(pages, probes = {}) {
  return {
    startUrl: 'https://site.test/',
    origin: 'https://site.test',
    host: 'site.test',
    siteKey: 'site.test',
    robots: { status: 404, exists: false, text: '', parsed: null, ...(probes.robots || {}) },
    sitemap: { status: 404, exists: false, ...(probes.sitemap || {}) },
    llms: { status: 404, exists: false, text: '', ...(probes.llms || {}) },
    favicon: { status: 404, ok: false, ...(probes.favicon || {}) },
    canary: {
      status: 404,
      body: '<html><head><title>Error</title></head><body><pre>Cannot GET /nope</pre></body></html>',
      ...(probes.canary || {})
    },
    blockedPaths: [],
    assets: [],
    linkStatus: {},
    limits: { maxPages: 30, maxDepth: 3, budgetMs: 10000, concurrency: 4 },
    truncated: false,
    stopReason: null,
    durationMs: 10,
    pages
  };
}

const BARE_PAGE = `<!doctype html><html><head><title>Site</title></head>
<body><p>${'word '.repeat(50)}</p></body></html>`;

test('scoring: SEO and GEO are scored separately, overall is weighted', () => {
  const issues = [
    { severity: 'high', category: 'meta', autoFixable: false },
    { severity: 'high', category: 'geo', autoFixable: false, geoWeight: 12 },
    { severity: 'low', category: 'geo', autoFixable: false, geoWeight: 4 }
  ];
  const s = scoreReport(issues, { pages: 1, geoPossible: 60 });
  assert.ok(s.seo > 0 && s.seo < 100, 'seo in range');
  assert.ok(s.geo > 0 && s.geo < 100, 'geo in range');
  assert.strictEqual(s.overall, Math.round(s.seo * 0.6 + s.geo * 0.4));
});

test('scoring: a clean set scores 100 and projection ignores auto-fixable issues', () => {
  assert.strictEqual(scoreReport([], { pages: 1, geoPossible: 60 }).overall, 100);

  const mixed = [
    { severity: 'critical', category: 'meta', autoFixable: true },
    { severity: 'medium', category: 'content', autoFixable: false }
  ];
  const projected = projectScore(mixed, { pages: 1, geoPossible: 60 });
  assert.strictEqual(projected.blockers.length, 1, 'only the manual issue blocks the ceiling');
  assert.ok(projected.seo > 0, 'projected score is computed from what remains');
});

test('GEO: missing llms.txt, AI access and schema are reported', () => {
  const pages = [page('https://site.test/', BARE_PAGE)];
  const audit = runAudit(crawlOf(pages), { siteName: 'Site' });
  const rules = new Set(audit.issues.map(i => i.rule));

  assert.ok(rules.has('geo-llms-txt'), 'llms.txt missing');
  assert.ok(rules.has('geo-schema-graph'), 'schema graph missing');
  assert.ok(rules.has('geo-author'), 'author missing');
  assert.ok(rules.has('geo-freshness'), 'dates missing');
  assert.ok(audit.geoScore < 100, 'geo score reflects the gaps');
});

test('GEO: present signals raise the score and clear the issues', () => {
  const html = `<!doctype html><html lang="en"><head><title>Site — a sufficiently long title</title>
  <meta name="description" content="${'d'.repeat(150)}">
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Site' },
      { '@type': 'WebSite', name: 'Site' },
      { '@type': 'WebPage', name: 'Site', dateModified: '2026-01-01', author: { '@type': 'Person', name: 'A' } },
      { '@type': 'BreadcrumbList', itemListElement: [] }
    ]
  })}</script></head>
  <body><main><h1>Site</h1><p>${'word '.repeat(50)}</p></main></body></html>`;

  const pages = [page('https://site.test/', html)];
  const crawl = crawlOf(pages, { llms: { status: 200, exists: true, text: '# Site' } });
  const audit = runAudit(crawl, { siteName: 'Site' });
  const rules = new Set(audit.issues.map(i => i.rule));

  assert.ok(!rules.has('geo-llms-txt'));
  assert.ok(!rules.has('geo-schema-graph'));
  assert.ok(!rules.has('geo-author'));
  assert.ok(!rules.has('geo-freshness'));
  assert.strictEqual(audit.issues.filter(i => i.category === 'geo' && !i.deniedFromScore).length, 0);
});

test('GEO: robots.txt blocking AI crawlers is detected and repaired', () => {
  const robotsText = 'User-agent: GPTBot\nDisallow: /\n';
  const { parseRobots } = require('../src/crawler');
  const pages = [page('https://site.test/', BARE_PAGE)];
  const audit = runAudit(crawlOf(pages, {
    robots: { status: 200, exists: true, text: robotsText, parsed: parseRobots(robotsText) }
  }), { siteName: 'Site' });

  assert.ok(audit.issues.some(i => i.rule === 'geo-ai-crawlers'));

  const { augmentRobotsForAi } = require('../src/fixers');
  const fixed = augmentRobotsForAi(robotsText);
  assert.ok(/User-agent: ClaudeBot[\s\S]*Allow: \//.test(fixed), 'adds allowances for the missing bots');
  assert.ok(fixed.includes('User-agent: GPTBot'), 'keeps the existing group');
});

test('GEO fixer: injects a valid @graph and is idempotent', () => {
  const html = BARE_PAGE;
  const ctx = {
    url: 'https://site.test/about',
    startUrl: 'https://site.test/',
    origin: 'https://site.test',
    siteName: 'Site',
    lang: 'en',
    existingTitle: 'About',
    existingDescription: '',
    record: []
  };
  const once = applyPageFixes(html, ctx, ['geo-schema-graph']);
  assert.ok(once.changed);
  assert.ok(once.html.includes('Organization'));
  assert.ok(once.html.includes('BreadcrumbList'));

  const match = once.html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'json-ld block present');
  const graph = JSON.parse(match[1]);
  assert.ok(graph['@graph'].some(n => n['@type'] === 'Organization'));
  assert.ok(graph['@graph'].some(n => n['@type'] === 'WebPage'));

  const twice = applyPageFixes(once.html, ctx, ['geo-schema-graph']);
  assert.strictEqual(twice.html, once.html, 'second pass is a no-op');
});

test('social: Open Graph tags are recognised after the parser strips the prefix', () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Site — a sufficiently long title for tests</title>
    <meta name="description" content="${'d'.repeat(150)}">
    <meta property="og:title" content="Title">
    <meta property="og:description" content="Desc">
    <meta property="og:image" content="https://site.test/a.png">
    <meta property="og:url" content="https://site.test/">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="Title">
    <meta name="twitter:description" content="Desc">
  </head><body><h1>Site</h1></body></html>`;

  const audit = runAudit(crawlOf([page('https://site.test/', html)]), { siteName: 'Site' });
  assert.ok(!audit.issues.some(i => i.rule === 'og'), 'no false "missing og" issue');
});

test('improve loop: repairs, re-audits and drives the score up', () => {
  const html = `<!doctype html><html><head><title>x</title></head>
  <body><h2>Broken</h2><p>${'word '.repeat(40)}</p><img src="/a.png"></body></html>`;

  const pages = [page('https://site.test/', html)];
  const crawl = crawlOf(pages);
  const first = runAudit(crawl, { siteName: 'Site' });

  const report = {
    id: 'loop-test',
    url: crawl.startUrl,
    origin: crawl.origin,
    host: crawl.host,
    siteName: 'Site',
    lang: 'en',
    issues: first.issues,
    seoScore: first.seoScore,
    geoScore: first.geoScore,
    overall: first.overall,
    crawl,
    pages
  };

  const loop = runLoop(report, { siteName: 'Site', lang: 'en', maxIterations: 4, target: 90 });

  assert.ok(loop.audit.overall > first.overall, `score rises (${first.overall} → ${loop.audit.overall})`);
  const autoBefore = first.issues.filter(i => i.autoFixable).length;
  const autoAfter = loop.audit.issues.filter(i => i.autoFixable).length;
  assert.ok(autoAfter < autoBefore, `auto-fixable issues drop (${autoBefore} → ${autoAfter})`);
  assert.ok(loop.history.length >= 2, 'at least one repair pass was recorded');
  assert.ok(loop.state.pages[0].html.includes('<h1>'), 'heading repaired to h1');
});

test('geo possible weight scales with page count', () => {
  assert.ok(possibleFor(3) > possibleFor(1));
  assert.strictEqual(possibleFor(1), possibleFor(0), 'minimum of one page');
});
