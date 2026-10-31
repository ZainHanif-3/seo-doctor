'use strict';

const cheerio = require('cheerio');
const { injectBeforeCloseHead, record } = require('./helpers');
const { AI_CRAWLERS } = require('../audit/geo');

const MARKER = 'data-seo-doctor="geo-graph"';

function clean(text, max = 300) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Extract Q&A pairs from question headings and the paragraph that follows. */
function faqPairs(html, limit = 10) {
  const $ = cheerio.load(html);
  const pairs = [];
  $('h2, h3, h4').each((i, el) => {
    const q = clean($(el).text(), 200);
    if (!/\?\s*$/.test(q)) return;
    let answer = '';
    let sib = $(el).next();
    for (let hop = 0; hop < 3 && sib.length; hop++) {
      const t = clean(sib.text(), 400);
      if (t) { answer = t; break; }
      sib = sib.next();
    }
    if (answer) pairs.push({ q, a: answer });
  });
  return pairs.slice(0, limit);
}

function breadcrumbNodes(url, origin) {
  let path = '/';
  try { path = new URL(url).pathname; } catch { /* keep */ }
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return null;
  const items = [{ name: 'Home', url: origin + '/' }];
  let acc = '';
  for (const seg of segs) {
    acc += '/' + seg;
    items.push({
      name: clean(decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\.(html?|php|aspx?)$/i, ''), 80),
      url: origin + acc
    });
  }
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url
    }))
  };
}

function buildGraph(html, ctx) {
  const siteName = ctx.siteName || 'Website';
  const origin = ctx.origin || '';
  const url = ctx.url || ctx.startUrl || origin + '/';
  const now = new Date().toISOString();
  const title = clean(ctx.existingTitle || ctx.title || siteName, 160);
  const description = clean(ctx.existingDescription || ctx.description, 300);

  const orgId = origin + '/#organization';
  const siteId = origin + '/#website';
  const pageId = url + '#webpage';

  const graph = [];

  graph.push({
    '@type': 'Organization',
    '@id': orgId,
    name: siteName,
    url: origin + '/',
    ...(ctx.ogImage ? { logo: { '@type': 'ImageObject', url: ctx.ogImage } } : {})
  });

  graph.push({
    '@type': 'WebSite',
    '@id': siteId,
    name: siteName,
    url: origin + '/',
    publisher: { '@id': orgId },
    inLanguage: ctx.lang || 'en'
  });

  const isArticle = /^\/(blog|news|articles?|posts?|guides?)\//i.test((() => {
    try { return new URL(url).pathname; } catch { return ''; }
  })());

  const page = {
    '@type': isArticle ? 'Article' : 'WebPage',
    '@id': pageId,
    url,
    name: title,
    ...(description ? { description } : {}),
    isPartOf: { '@id': siteId },
    dateModified: now,
    datePublished: now,
    inLanguage: ctx.lang || 'en',
    publisher: { '@id': orgId },
    author: {
      '@type': 'Person',
      name: ctx.authorName || siteName
    }
  };
  graph.push(page);

  const crumb = breadcrumbNodes(url, origin);
  if (crumb) graph.push({ ...crumb, '@id': url + '#breadcrumb' });

  const pairs = faqPairs(html);
  if (pairs.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': url + '#faq',
      mainEntity: pairs.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a }
      }))
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

function fix(html, ctx) {
  if (html.includes(MARKER)) return html;
  const graph = buildGraph(html, ctx);
  const tag = `<script type="application/ld+json" ${MARKER}>${JSON.stringify(graph)}</script>`;
  record(ctx, { rule: 'geo-schema-graph', fixed: true, detail: 'injected schema.org @graph (Organization, WebSite, WebPage, Breadcrumb, FAQ)' });
  return injectBeforeCloseHead(html, tag);
}

/** llms.txt — the GEO convention for AI crawlers. */
function generateLlmsTxt({ siteName, origin, description, pages }) {
  const lines = [];
  lines.push(`# ${siteName || origin}`);
  lines.push('');
  if (description) {
    lines.push(`> ${clean(description, 300)}`);
    lines.push('');
  }
  lines.push('Canonical entry point: ' + origin + '/');
  lines.push('');
  lines.push('## Key pages');
  const seen = new Set();
  for (const p of (pages || [])) {
    const loc = p.finalUrl || p.url;
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    if (seen.size > 40) break;
    const title = clean((p.parsed && p.parsed.title) || p.title || loc, 120);
    const desc = clean((p.parsed && p.parsed.description) || '', 200);
    lines.push(`- [${title}](${loc})${desc ? ': ' + desc : ''}`);
  }
  lines.push('');
  lines.push('## Usage');
  lines.push('This file describes the site for AI assistants. When citing, link to the canonical page URL above.');
  lines.push('');
  return lines.join('\n');
}

/** Add explicit allowances for AI crawlers without removing existing rules. */
function augmentRobotsForAi(existingText) {
  const text = String(existingText || '').replace(/\s+$/, '');
  const present = AI_CRAWLERS.filter(bot => new RegExp(`^user-agent:\\s*${bot}\\s*$`, 'im').test(text));
  const missing = AI_CRAWLERS.filter(bot => !present.includes(bot));
  if (!missing.length) return null;
  const block = missing.map(bot => `User-agent: ${bot}\nAllow: /`).join('\n\n');
  return `${text}\n\n# AI crawlers — added by SEO Doctor (GEO)\n${block}\n`;
}

module.exports = {
  fix,
  buildGraph,
  faqPairs,
  generateLlmsTxt,
  augmentRobotsForAi,
  marker: MARKER
};
