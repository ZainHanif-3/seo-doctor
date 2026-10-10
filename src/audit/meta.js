'use strict';

const { absUrl, siteKey } = require('../util');

const TITLE_MIN = 30, TITLE_MAX = 60;
const DESC_MIN = 70, DESC_MAX = 165;

function groupBy(pages, fn) {
  const m = new Map();
  for (const p of pages) {
    const k = fn(p);
    if (k == null || k === '') continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  return m;
}

function run(ctx) {
  const issues = [];
  const pages = ctx.pages;
  const startKey = siteKey(ctx.host);

  const dupTitles = groupBy(pages, p => (p.parsed.title || '').trim().toLowerCase());
  const dupDescs = groupBy(pages, p => (p.parsed.description || '').trim().toLowerCase());

  for (const p of pages) {
    const pr = p.parsed;
    const url = p.finalUrl || p.url;

    // ---- titles ----
    const rawTitle = (pr.title || '').trim();
    if (!rawTitle) {
      issues.push(ctx.mk({
        rule: 'title', severity: 'critical', category: 'meta', page: url, pages: [url],
        title: 'Missing <title> tag',
        message: 'This page has no title tag (or it is empty). The title is the strongest on-page relevance signal.',
        evidence: pr.title === '' ? '<title></title> is empty' : 'no <title> element found in <head>',
        fixable: true, autoFixable: true,
        advice: 'Add a unique, descriptive title of 30-60 characters containing the primary keyword.'
      }));
    } else {
      if (rawTitle.length < TITLE_MIN || rawTitle.length > TITLE_MAX) {
        issues.push(ctx.mk({
          rule: 'title', severity: 'medium', category: 'meta', page: url, pages: [url],
          title: rawTitle.length > TITLE_MAX ? 'Title too long (>60)' : 'Title too short (<30)',
          message: `Title is ${rawTitle.length} characters — search engines display roughly 30-60.`,
          evidence: `<title>${rawTitle}</title> (${rawTitle.length} chars)`,
          fixable: true, autoFixable: true,
          meta: { reason: rawTitle.length > TITLE_MAX ? 'long' : 'short' },
          advice: 'Rewrite the title to 30-60 characters, keyword first, brand last.'
        }));
      }
      const group = dupTitles.get(rawTitle.toLowerCase()) || [];
      const others = group.filter(x => (x.finalUrl || x.url) !== url);
      if (others.length) {
        issues.push(ctx.mk({
          rule: 'title', severity: 'high', category: 'meta', page: url, pages: [url],
          title: 'Duplicate title across pages',
          message: 'Other pages on this site use the exact same title, so search engines cannot tell them apart.',
          evidence: `"${rawTitle}" also used by: ${others.map(o => o.finalUrl || o.url).join(', ')}`,
          fixable: true, autoFixable: true,
          meta: { reason: 'duplicate' },
          advice: 'Give every page a unique title based on its own H1/topic.'
        }));
      }
    }

    // ---- descriptions ----
    const desc = (pr.description || '').trim();
    if (!desc) {
      issues.push(ctx.mk({
        rule: 'description', severity: 'high', category: 'meta', page: url, pages: [url],
        title: 'Missing meta description',
        message: 'No meta description — the snippet shown in search results will be auto-generated and less clickable.',
        evidence: pr.description === '' ? '<meta name="description" content=""> is empty' : 'no <meta name="description"> found',
        fixable: true, autoFixable: true,
        advice: 'Write a 140-160 character description summarising the page with a call to action.'
      }));
    } else {
      if (desc.length < DESC_MIN) {
        issues.push(ctx.mk({
          rule: 'description', severity: 'medium', category: 'meta', page: url, pages: [url],
          title: 'Description too short (<70)',
          message: `Description is ${desc.length} characters — aim for 140-160 for a full SERP snippet.`,
          evidence: desc,
          fixable: true, autoFixable: true,
          meta: { reason: 'short' },
          advice: 'Expand the description to 140-160 characters.'
        }));
      } else if (desc.length > DESC_MAX) {
        issues.push(ctx.mk({
          rule: 'description', severity: 'medium', category: 'meta', page: url, pages: [url],
          title: 'Description too long (>165)',
          message: `Description is ${desc.length} characters and will be truncated in search results.`,
          evidence: desc.slice(0, 120) + '…',
          fixable: true, autoFixable: true,
          meta: { reason: 'long' },
          advice: 'Trim the description to 140-160 characters.'
        }));
      }
      const group = dupDescs.get(desc.toLowerCase()) || [];
      const others = group.filter(x => (x.finalUrl || x.url) !== url);
      if (others.length) {
        issues.push(ctx.mk({
          rule: 'description', severity: 'medium', category: 'meta', page: url, pages: [url],
          title: 'Duplicate meta description',
          message: 'The same description is used on multiple pages.',
          evidence: `${desc.slice(0, 80)}… also on: ${others.map(o => o.finalUrl || o.url).join(', ')}`,
          fixable: true, autoFixable: true,
          meta: { reason: 'duplicate' },
          advice: 'Write a unique description per page.'
        }));
      }
    }

    // ---- robots meta ----
    if (!pr.robotsMeta) {
      issues.push(ctx.mk({
        rule: 'robots-meta', severity: 'low', category: 'meta', page: url, pages: [url],
        title: 'Missing <meta name="robots">',
        message: 'No robots meta tag — crawling/indexing directives are implicit rather than explicit.',
        evidence: 'no <meta name="robots" content="index,follow">',
        fixable: true, autoFixable: true,
        advice: 'Add <meta name="robots" content="index,follow"> (or noindex for private pages).'
      }));
    }

    // ---- canonical ----
    const canon = (pr.canonical || '').trim();
    if (!canon) {
      issues.push(ctx.mk({
        rule: 'canonical', severity: 'medium', category: 'meta', page: url, pages: [url],
        title: 'Missing canonical URL',
        message: 'No <link rel="canonical"> — duplicate/parameterised URLs may be indexed instead of this page.',
        evidence: 'no <link rel="canonical" href="...">',
        fixable: true, autoFixable: true,
        advice: 'Point a self-referencing canonical at this page\'s own URL.'
      }));
    } else {
      const abs = absUrl(url, canon);
      if (abs) {
        let ck = '';
        try { ck = siteKey(new URL(abs).hostname); } catch { ck = ''; }
        if (ck && ck !== startKey) {
          issues.push(ctx.mk({
            rule: 'canonical', severity: 'high', category: 'meta', page: url, pages: [url],
            title: 'Canonical points off-host',
            message: 'The canonical URL points to a different domain than the one being crawled. This transfers all ranking signal away from this site.',
            evidence: `<link rel="canonical" href="${abs}"> (site host: ${ctx.host})`,
            fixable: false,
            advice: 'Confirm the cross-domain canonical is intentional (syndication). If not, change it to this page\'s own absolute URL.'
          }));
        }
      }
    }

    // ---- lang ----
    if (!pr.lang) {
      issues.push(ctx.mk({
        rule: 'lang', severity: 'medium', category: 'meta', page: url, pages: [url],
        title: 'Missing <html lang> attribute',
        message: 'The <html> element has no lang attribute — screen readers and search engines cannot determine the language.',
        evidence: pr.lang === '' ? '<html lang=""> is empty' : 'no lang attribute on <html>',
        fixable: true, autoFixable: true,
        advice: `Add lang="${ctx.lang || 'en'}" to the <html> tag.`
      }));
    }

    // ---- viewport ----
    if (!pr.viewport) {
      issues.push(ctx.mk({
        rule: 'viewport', severity: 'high', category: 'meta', page: url, pages: [url],
        title: 'Missing viewport meta tag',
        message: 'No viewport meta tag — Google uses mobile-first indexing, so this page is scored as non-mobile-friendly.',
        evidence: 'no <meta name="viewport" content="width=device-width, initial-scale=1">',
        fixable: true, autoFixable: true,
        advice: 'Add the standard responsive viewport tag in <head>.'
      }));
    }

    // ---- charset ----
    if (!pr.charset) {
      issues.push(ctx.mk({
        rule: 'charset', severity: 'low', category: 'meta', page: url, pages: [url],
        title: 'Missing charset declaration',
        message: 'No <meta charset> declared — the encoding is guessed, which can garble content in search results.',
        evidence: 'no <meta charset="utf-8">',
        fixable: true, autoFixable: true,
        advice: 'Add <meta charset="utf-8"> as the first child of <head>.'
      }));
    }
  }

  return issues;
}

module.exports = { run };
