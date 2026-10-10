'use strict';

const cheerio = require('cheerio');
const { absUrl, stripTags, wordCount } = require('./util');

function metaContent($, name) {
  const byName = $(`meta[name="${name}"]`).attr('content');
  if (byName != null) return byName;
  const byProp = $(`meta[property="${name}"]`).attr('content');
  if (byProp != null) return byProp;
  return null;
}

function parsePage(html, pageUrl) {
  const $ = cheerio.load(html, { xmlMode: false });
  const out = {};

  out.title = ($('title').first().text() || '').trim();

  out.description = (metaContent($, 'description') || '').trim();
  out.robotsMeta = (metaContent($, 'robots') || '').trim();
  out.viewport = (metaContent($, 'viewport') || '').trim();
  out.themeColor = (metaContent($, 'theme-color') || '').trim();

  const charsetTag = html.match(/<meta[^>]+charset\s*=\s*["']?[^"'>\s]+/i);
  out.charset = charsetTag ? charsetTag[0] : null;

  out.canonical = ($('link[rel="canonical"]').attr('href') || '').trim();

  const htmlAttrs = $('html').first().attr() || {};
  out.lang = (htmlAttrs.lang || '').trim();

  out.favicon = $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
    .map((i, el) => ($(el).attr('href') || '').trim()).get().filter(Boolean);

  out.og = {};
  for (const el of $('meta[property^="og:"]')) {
    const p = ($(el).attr('property') || '').replace(/^og:/, '');
    const c = $(el).attr('content');
    if (p && c != null && out.og[p] == null) out.og[p] = c.trim();
  }
  out.twitter = {};
  for (const el of $('meta[name^="twitter:"], meta[property^="twitter:"]')) {
    const p = (($(el).attr('name') || $(el).attr('property') || '')).replace(/^twitter:/, '');
    const c = $(el).attr('content');
    if (p && c != null && out.twitter[p] == null) out.twitter[p] = c.trim();
  }

  out.headings = [];
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    const level = Number(el.tagName.replace(/^h/, ''));
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    out.headings.push({ level, text });
  });
  out.h1s = out.headings.filter(h => h.level === 1).map(h => h.text);

  out.images = [];
  $('img').each((i, el) => {
    const $el = $(el);
    const src = ($el.attr('src') || $el.attr('data-src') || '').trim();
    out.images.push({
      src,
      abs: absUrl(pageUrl, src),
      alt: $el.attr('alt'),
      width: $el.attr('width'),
      height: $el.attr('height'),
      loading: ($el.attr('loading') || '').toLowerCase(),
      fetchpriority: ($el.attr('fetchpriority') || '').toLowerCase(),
      classes: ($el.attr('class') || '').trim()
    });
  });

  out.links = [];
  $('a[href]').each((i, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    const abs = absUrl(pageUrl, href);
    if (!abs) return;
    out.links.push({
      href, abs,
      rel: ($el.attr('rel') || '').trim(),
      text: ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      external: !samePageHost(pageUrl, abs)
    });
  });

  out.stylesheets = [];
  $('link[rel="stylesheet"]').each((i, el) => {
    const href = ($(el).attr('href') || '').trim();
    const abs = absUrl(pageUrl, href);
    if (abs) out.stylesheets.push(abs);
  });

  out.scripts = [];
  $('script[src]').each((i, el) => {
    const abs = absUrl(pageUrl, ($(el).attr('src') || '').trim());
    if (abs) out.scripts.push(abs);
  });

  out.inlineStyles = [];
  $('style').each((i, el) => { out.inlineStyles.push($(el).html() || ''); });
  out.styleAttrs = [];
  $('[style]').each((i, el) => { out.styleAttrs.push(($(el).attr('style') || '').trim()); });

  out.jsonld = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    out.jsonld.push(($(el).html() || '').trim());
  });

  out.hreflang = [];
  $('link[rel="alternate"][hreflang]').each((i, el) => {
    out.hreflang.push({
      lang: ($(el).attr('hreflang') || '').trim(),
      href: absUrl(pageUrl, ($(el).attr('href') || '').trim())
    });
  });

  out.xuaCompatible = /http-equiv\s*=\s*["']X-UA-Compatible["']/i.test(html);

  const bodyHtml = html.replace(/<head[\s\S]*?<\/head>/i, '');
  out.bodyText = stripTags(bodyHtml);
  out.wordCount = wordCount(out.bodyText);

  out.firstParagraph = '';
  const ps = $('p').map((i, el) => ($(el).text() || '').replace(/\s+/g, ' ').trim()).get()
    .filter(t => t.length >= 40);
  if (ps.length) out.firstParagraph = ps[0];
  else {
    const any = $('p').map((i, el) => ($(el).text() || '').replace(/\s+/g, ' ').trim()).get()
      .filter(t => t.length >= 15);
    if (any.length) out.firstParagraph = any[0];
  }

  return out;
}

function samePageHost(a, b) {
  try {
    const strip = h => h.toLowerCase().replace(/^www\./, '');
    return strip(new URL(a).hostname) === strip(new URL(b).hostname);
  } catch { return false; }
}

function analyzeJsonLd(blocks) {
  const results = [];
  for (const raw of blocks) {
    let parsed = null, error = null;
    try { parsed = JSON.parse(raw); } catch (e) { error = e.message; }
    const hasContext = parsed != null && (
      typeof parsed['@context'] !== 'undefined' ||
      (Array.isArray(parsed['@graph']) && parsed['@graph'].some(n => n && typeof n['@context'] !== 'undefined'))
    );
    const types = [];
    if (parsed) {
      if (typeof parsed['@type'] === 'string') types.push(parsed['@type']);
      if (Array.isArray(parsed['@type'])) types.push(...parsed['@type']);
      if (Array.isArray(parsed['@graph'])) {
        for (const n of parsed['@graph']) {
          if (n && typeof n['@type'] === 'string') types.push(n['@type']);
        }
      }
    }
    results.push({ raw, parsed, error, hasContext, types });
  }
  return results;
}

module.exports = { parsePage, analyzeJsonLd, metaContent };
