'use strict';

const { injectBeforeCloseHead, record } = require('./helpers');

function buildJsonLd(ctx) {
  const siteName = ctx.siteName || 'Website';
  const url = ctx.origin ? ctx.origin + '/' : (ctx.startUrl || '');
  const website = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url
  };
  if (ctx.description || ctx.existingDescription) website.description = (ctx.description || ctx.existingDescription).slice(0, 200);
  const org = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: siteName,
    url
  };
  if (ctx.ogImage) org.logo = ctx.ogImage;
  return [
    `<script type="application/ld+json">${JSON.stringify(website)}</script>`,
    `<script type="application/ld+json">${JSON.stringify(org)}</script>`
  ];
}

function fix(html, ctx) {
  if (!ctx.jsonldIssues) return html;
  if (/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i.test(html)) {
    return html;
  }
  let out = html;
  for (const tag of buildJsonLd(ctx)) out = injectBeforeCloseHead(out, tag);
  record(ctx, { rule: 'jsonld', fixed: true, detail: 'injected WebSite + Organization JSON-LD' });
  return out;
}

module.exports = { fix, buildJsonLd };
