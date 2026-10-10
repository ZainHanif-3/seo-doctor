'use strict';

const OG_REQUIRED = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];
const TW_REQUIRED = ['twitter:card', 'twitter:title', 'twitter:description'];

function run(ctx) {
  const issues = [];
  const pages = ctx.pages;

  for (const p of pages) {
    const pr = p.parsed;
    const url = p.finalUrl || p.url;

    const ogMissing = OG_REQUIRED.filter(k => !pr.og[k]);
    if (ogMissing.length) {
      issues.push(ctx.mk({
        rule: 'og', severity: 'medium', category: 'social', page: url, pages: [url],
        title: 'Missing Open Graph tags',
        message: 'Shared links will render without a rich preview on Facebook, LinkedIn, WhatsApp, etc.',
        evidence: `missing: ${ogMissing.join(', ')}${Object.keys(pr.og).length ? '' : ' (no og:* tags at all)'}`,
        fixable: true, autoFixable: true,
        advice: 'Add the full og:title / og:description / og:image / og:url / og:type set.'
      }));
    }

    const twMissing = TW_REQUIRED.filter(k => !pr.twitter[k]);
    if (twMissing.length) {
      issues.push(ctx.mk({
        rule: 'og', severity: 'low', category: 'social', page: url, pages: [url],
        title: 'Missing Twitter card tags',
        message: 'X/Twitter shares fall back to a plain link instead of a summary card.',
        evidence: `missing: ${twMissing.join(', ')}`,
        fixable: true, autoFixable: true,
        advice: 'Add twitter:card, twitter:title and twitter:description meta tags.'
      }));
    }
  }

  // site-level favicon
  const anyFaviconLink = pages.some(p => p.parsed.favicon && p.parsed.favicon.length);
  if (!anyFaviconLink && !ctx.crawl.favicon.ok) {
    issues.push(ctx.mk({
      rule: 'favicon', severity: 'low', category: 'social', page: ctx.startUrl, pages: pages.map(p => p.finalUrl || p.url),
      title: 'Favicon missing',
      message: 'No <link rel="icon"> on any page and /favicon.ico returns ' + ctx.crawl.favicon.status + ' — browsers show a generic icon in tabs and search results.',
      evidence: `<link rel="icon"> not found; GET /favicon.ico → ${ctx.crawl.favicon.status}`,
      fixable: true, autoFixable: true,
      advice: 'Ship a 48x48+ favicon and reference it with <link rel="icon" href="/favicon.ico">.'
    }));
  }

  return issues;
}

module.exports = { run, OG_REQUIRED, TW_REQUIRED };
