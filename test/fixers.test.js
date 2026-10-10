'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { FIXERS, applyPageFixes, generateRobotsTxt, augmentRobotsTxt, generateSitemapXml, sitemapEntriesFor } = require('../src/fixers');

function ctx(extra) {
  return {
    url: 'https://example.com/about',
    origin: 'https://example.com',
    startUrl: 'https://example.com/',
    siteName: 'Example Co',
    lang: 'en',
    h1: 'About Our Widget Company',
    firstHeading: 'About Our Widget Company',
    existingTitle: '',
    existingDescription: '',
    firstParagraph: 'We have been building reliable widgets for manufacturing lines since nineteen ninety two, and this paragraph is long enough to become the meta description source text for the page when the tool derives one automatically.',
    bodyHtml: '<p>We have been building reliable widgets for manufacturing lines since nineteen ninety two, and this paragraph is long enough to become the meta description source text for the page when the tool derives one automatically.</p>',
    record: [],
    ...extra
  };
}

test('title: injects a generated title when missing and stays <= 60 chars', () => {
  const html = '<html><head><meta charset="utf-8"></head><body><h1>Best Coffee Beans In Town</h1></body></html>';
  const c = ctx({ titleIssues: ['missing'], existingTitle: '', h1: 'Best Coffee Beans In Town', url: 'https://example.com/' });
  const out = FIXERS.title(html, c);
  assert.match(out, /<title>Best Coffee Beans In Town – Example Co<\/title>/);
  const m = out.match(/<title>([^<]*)<\/title>/);
  assert.ok(m[1].length <= 60, 'title must be <= 60 chars');
  assert.strictEqual(FIXERS.title(out, c), out, 'second run must be a no-op');
});

test('title: regenerates an over-long title', () => {
  const long = 'A'.repeat(95);
  const html = `<html><head><title>${long}</title></head><body><h1>Short H1 For Long Title Case</h1></body></html>`;
  const c = ctx({ titleIssues: ['long'], existingTitle: long, h1: 'Short H1 For Long Title Case' });
  const out = FIXERS.title(html, c);
  const got = out.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(got.length <= 60, `got ${got.length}`);
  assert.notStrictEqual(got, long);
});

test('title: differentiates duplicate titles per page', () => {
  const html = '<html><head><title>Same Title On Two Pages</title></head><body><h1>Unique Heading Here</h1></body></html>';
  const c = ctx({
    titleIssues: ['duplicate'],
    existingTitle: 'Same Title On Two Pages',
    otherTitles: ['Same Title On Two Pages'],
    h1: 'Unique Heading Here',
    pathSuffix: 'About'
  });
  const out = FIXERS.title(html, c);
  const got = out.match(/<title>([^<]*)<\/title>/)[1];
  assert.notStrictEqual(got.toLowerCase(), 'same title on two pages');
  assert.ok(got.length <= 60);
});

test('description: derives a 140-160 char description from the first paragraph', () => {
  const html = '<html><head><title>x</title></head><body><p>' + 'We ship hand tested mechanical keyboards worldwide with a five year warranty and free returns. ' + '</p></body></html>';
  const c = ctx({ descIssues: ['missing'], existingDescription: '', firstParagraph: 'We ship hand tested mechanical keyboards worldwide with a five year warranty and free returns. Every unit is inspected twice before packing.' });
  const out = FIXERS.description(html, c);
  const got = out.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.ok(got.length >= 100 && got.length <= 160, `length ${got.length}`);
  assert.strictEqual(FIXERS.description(out, c), out);
});

test('description: truncates an over-long description naturally', () => {
  const long = 'This is a very long description. '.repeat(9).trim();
  const html = `<html><head><meta name="description" content="${long}"></head><body></body></html>`;
  const c = ctx({ descIssues: ['long'], existingDescription: long });
  const out = FIXERS.description(html, c);
  const got = out.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.ok(got.length <= 160, `length ${got.length}`);
  assert.ok(got.length < long.length);
});

test('canonical: injects the page own absolute URL only when absent', () => {
  const html = '<html><head></head><body></body></html>';
  const out = FIXERS.canonical(html, ctx());
  assert.match(out, /<link rel="canonical" href="https:\/\/example\.com\/about">/);
  assert.strictEqual(FIXERS.canonical(out, ctx()), out, 'idempotent');
});

test('robots-meta + viewport: injected once when missing', () => {
  let html = '<html><head></head><body></body></html>';
  html = FIXERS['robots-meta'](html, ctx());
  html = FIXERS.viewport(html, ctx());
  assert.match(html, /<meta name="robots" content="index,follow">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.strictEqual(FIXERS['robots-meta'](html, ctx()), html);
  assert.strictEqual(FIXERS.viewport(html, ctx()), html);
});

test('charset: lands as first child of <head>', () => {
  const html = '<html>\n<head>\n  <title>t</title>\n</head><body></body></html>';
  const out = FIXERS.charset(html, ctx());
  const headIdx = out.toLowerCase().indexOf('<head>');
  const csIdx = out.toLowerCase().indexOf('<meta charset');
  assert.ok(csIdx > headIdx && csIdx < headIdx + 80, 'charset right after <head>');
  const next = FIXERS.charset(out, ctx());
  assert.match(next, /<meta charset="utf-8">/);
  const matches = next.match(/charset/gi) || [];
  assert.strictEqual(matches.length, 1, 'no duplicate charset');
});

test('lang: adds lang to <html> using the configured language', () => {
  const html = '<html>\n<head><title>t</title></head><body></body></html>';
  const out = FIXERS.lang(html, ctx({ lang: 'fr' }));
  assert.match(out, /<html lang="fr">/);
  assert.strictEqual(FIXERS.lang(out, ctx({ lang: 'fr' })), out);
});

test('h1: promotes first h2 when no h1 exists', () => {
  const html = '<html><body><h2>Who We Are</h2><p>text</p></body></html>';
  const c = ctx({ h1Issues: [{}] });
  const out = FIXERS.h1(html, c);
  assert.match(out, /<h1>Who We Are<\/h1>/);
  assert.doesNotMatch(out, /<h2>/);
});

test('h1: demotes duplicate h1s after the first', () => {
  const html = '<html><body><h1>Main Topic</h1><p>a</p><h1>Secondary Topic</h1></body></html>';
  const out = FIXERS.h1(html, ctx({ h1Issues: [{}] }));
  const ones = out.match(/<h1>/g) || [];
  const twos = out.match(/<h2>/g) || [];
  assert.strictEqual(ones.length, 1);
  assert.strictEqual(twos.length, 1);
  assert.match(out, /<h2>Secondary Topic<\/h2>/);
});

test('img-alt: uses the parent heading and flags filename guesses for review', () => {
  const html = '<html><body><img src="/img/q3_report_final_v2.png"><h2>Assembly Line Robot</h2><img src="/img/assembly-line-robot.png"></body></html>';
  const c = ctx({ imgAltIssues: [{}] });
  const out = FIXERS['img-alt'](html, c);
  assert.match(out, /alt="Assembly Line Robot"/);
  assert.match(out, /alt="q3 report final v2"/);
  const fixed = c.record.filter(r => r.rule === 'img-alt' && r.fixed);
  const review = c.record.filter(r => r.rule === 'img-alt' && r.note === 'review needed');
  assert.strictEqual(fixed.length, 1);
  assert.strictEqual(review.length, 1);
});

test('img-dimensions: reads sizes from downloaded asset buffers', () => {
  const html = '<html><body><img src="/img/hero.png"></body></html>';
  const c = ctx({
    imgDimIssues: [{}],
    assetDims: { 'https://example.com/img/hero.png': { width: 640, height: 360 } }
  });
  const out = FIXERS['img-dimensions'](html, c);
  assert.match(out, /width="640"/);
  assert.match(out, /height="360"/);
});

test('og: injects the full Open Graph + Twitter set and is idempotent', () => {
  const html = '<html><head><title>T</title></head><body></body></html>';
  const c = ctx({ socialIssues: [{}], title: 'T', description: 'D', ogImage: 'https://example.com/img.png' });
  const out = FIXERS.og(html, c);
  for (const p of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name']) {
    assert.match(out, new RegExp(`property="${p}"`), p);
  }
  assert.match(out, /name="twitter:card"/);
  assert.strictEqual(FIXERS.og(out, c), out, 'idempotent');
});

test('favicon: injects a link tag and generates a valid svg', () => {
  const html = '<html><head></head><body></body></html>';
  const c = ctx({ faviconHref: '../favicon.svg' });
  const out = FIXERS.favicon(html, c);
  assert.match(out, /<link rel="icon" href="\.\.\/favicon\.svg" type="image\/svg\+xml">/);
  assert.strictEqual(FIXERS.favicon(out, c), out);
  const svg = require('../src/fixers/favicon').generateFaviconSvg('Example Co');
  assert.match(svg, /<svg/);
  assert.match(svg, /E</);
});

test('jsonld: injects parseable WebSite + Organization with @context', () => {
  const html = '<html><head><title>T</title></head><body></body></html>';
  const c = ctx({ jsonldIssues: [{}] });
  const out = FIXERS.jsonld(html, c);
  const blocks = [...out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.strictEqual(blocks.length, 2);
  const parsed = blocks.map(b => JSON.parse(b));
  assert.strictEqual(parsed[0]['@type'], 'WebSite');
  assert.strictEqual(parsed[1]['@type'], 'Organization');
  assert.ok(parsed.every(p => p['@context'] === 'https://schema.org'));
  assert.strictEqual(FIXERS.jsonld(out, c), out, 'no second injection');
});

test('lazy: skips the hero image and tags the rest', () => {
  const html = '<html><body><img src="/a.png" alt="a"><img src="/b.png" alt="b"><img src="/logo.png" class="logo" alt="logo"></body></html>';
  const out = FIXERS.lazy(html, ctx({ lazyIssues: [{}] }));
  const tagOf = (src) => {
    const m = out.match(new RegExp('<img[^>]*' + src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^>]*>'));
    return m ? m[0] : '';
  };
  assert.match(tagOf('/b.png'), /loading="lazy"/);
  assert.match(tagOf('/b.png'), /decoding="async"/);
  assert.doesNotMatch(tagOf('/logo.png'), /loading="lazy"/);
  assert.doesNotMatch(tagOf('/a.png'), /loading="lazy"/);
});

test('robots.txt generator: allow-all + Sitemap line; augment only when missing', () => {
  const txt = generateRobotsTxt({ origin: 'https://example.com', siteName: 'Example', sitemapUrl: 'https://example.com/sitemap.xml' });
  assert.match(txt, /User-agent: \*/);
  assert.match(txt, /Allow: \//);
  assert.match(txt, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);

  const withLine = 'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n';
  assert.strictEqual(augmentRobotsTxt(withLine, 'https://example.com/sitemap.xml'), null, 'no duplicate Sitemap line');

  const withoutLine = 'User-agent: *\nDisallow: /admin\n';
  const augmented = augmentRobotsTxt(withoutLine, 'https://example.com/sitemap.xml');
  assert.match(augmented, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
  assert.match(augmented, /Disallow: \/admin/, 'existing rules preserved');
});

test('sitemap.xml generator: every 2xx page with lastmod', () => {
  const entries = sitemapEntriesFor({
    startUrl: 'https://example.com/',
    pages: [
      { url: 'https://example.com/', finalUrl: 'https://example.com/', status: 200, fetchedAt: '2026-10-10T00:00:00.000Z' },
      { url: 'https://example.com/a', finalUrl: 'https://example.com/a', status: 200, fetchedAt: '2026-10-10T00:00:00.000Z' },
      { url: 'https://example.com/broken', finalUrl: 'https://example.com/broken', status: 404, fetchedAt: '2026-10-10T00:00:00.000Z' }
    ]
  });
  const xml = generateSitemapXml(entries);
  assert.match(xml, /<urlset/);
  assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/a<\/loc>/);
  assert.doesNotMatch(xml, /broken/);
  assert.match(xml, /<lastmod>2026-10-10<\/lastmod>/);
});

test('applyPageFixes: runs only the requested rules and reports what applied', () => {
  const html = '<html><head><meta charset="utf-8"></head><body><h1>H</h1></body></html>';
  const c = ctx({ url: 'https://example.com/x', h1Issues: [] });
  const res = applyPageFixes(html, c, ['canonical', 'viewport']);
  assert.deepStrictEqual(res.applied.sort(), ['canonical', 'viewport']);
  assert.ok(res.changed);
  const res2 = applyPageFixes(res.html, ctx({ url: 'https://example.com/x' }), ['canonical', 'viewport']);
  assert.strictEqual(res2.changed, false, 'second pass changes nothing');
  assert.deepStrictEqual(res2.applied, []);
});
