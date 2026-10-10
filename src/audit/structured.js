'use strict';

const { analyzeJsonLd } = require('../parse');

function run(ctx) {
  const issues = [];
  const pages = ctx.pages;

  let anyValid = false;
  let anyBreadcrumb = false;
  const pageJsonLd = new Map();

  for (const p of pages) {
    const pr = p.parsed;
    const url = p.finalUrl || p.url;
    const results = analyzeJsonLd(pr.jsonld || []);
    pageJsonLd.set(url, results);

    const good = results.filter(r => r.parsed && r.hasContext);
    if (good.length) anyValid = true;
    if (good.some(r => r.types.includes('BreadcrumbList') || r.types.includes('https://schema.org/BreadcrumbList'))) {
      anyBreadcrumb = true;
    }

    const bad = results.filter(r => !r.parsed || !r.hasContext);
    if (bad.length) {
      issues.push(ctx.mk({
        rule: 'jsonld-invalid', severity: 'high', category: 'structured-data', page: url, pages: [url],
        title: 'Invalid JSON-LD structured data',
        message: 'A JSON-LD block on this page does not parse or is missing @context, so rich results are rejected.',
        evidence: bad.map(r => r.error ? `JSON.parse error: ${r.error}` : 'missing "@context"').join('; '),
        fixable: false,
        advice: 'Fix the JSON syntax (quotes, commas, closing braces) and include "@context": "https://schema.org".'
      }));
    }
  }

  if (pages.length && !anyValid) {
    issues.push(ctx.mk({
      rule: 'jsonld', severity: 'medium', category: 'structured-data', page: ctx.startUrl,
      pages: pages.map(p => p.finalUrl || p.url),
      title: 'No JSON-LD structured data on any page',
      message: 'The site publishes zero valid JSON-LD — no rich-result eligibility (Organization, WebSite, Breadcrumb, Product, etc.).',
      evidence: '0 of ' + pages.length + ' crawled pages contain a parseable JSON-LD block with @context',
      fixable: true, autoFixable: true,
      advice: 'Add WebSite + Organization JSON-LD to the homepage and relevant schema per template.'
    }));
  }

  if (pages.length && !anyBreadcrumb) {
    issues.push(ctx.mk({
      rule: 'breadcrumb', severity: 'low', category: 'structured-data', page: ctx.startUrl,
      pages: [ctx.startUrl],
      title: 'No breadcrumb structured data',
      message: 'No BreadcrumbList JSON-LD found — breadcrumb rich results are unavailable.',
      evidence: 'no BreadcrumbList @type in any JSON-LD block',
      fixable: false,
      advice: 'Add a BreadcrumbList JSON-LD mirroring the visible navigation hierarchy.'
    }));
  }

  // hreflang reciprocity
  const byUrl = new Map(pages.map(p => [p.finalUrl || p.url, p]));
  for (const p of pages) {
    const pr = p.parsed;
    const url = p.finalUrl || p.url;
    if (!pr.hreflang.length) continue;
    const missing = [];
    for (const h of pr.hreflang) {
      if (!h.href) continue;
      const target = byUrl.get(h.href) || byUrl.get(h.href.replace(/\/$/, '/'));
      if (!target) continue;
      const back = (target.parsed.hreflang || []).find(x => x.lang === h.lang);
      if (!back || back.href !== url) missing.push(`${h.lang} → ${h.href}`);
    }
    if (missing.length) {
      issues.push(ctx.mk({
        rule: 'hreflang', severity: 'medium', category: 'structured-data', page: url, pages: [url],
        title: 'hreflang without reciprocal return link',
        message: 'Alternate-language hints are not returned by the target page, so Google ignores them.',
        evidence: missing.join('; '),
        fixable: false,
        advice: 'Make each hreflang alternate link back to this page with the matching hreflang value.'
      }));
    }
  }

  void pageJsonLd;
  return issues;
}

module.exports = { run };
