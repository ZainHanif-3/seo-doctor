'use strict';

const { injectBeforeCloseHead, replaceMetaBy, esc, record } = require('./helpers');

const OG_KEYS = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];

function metaPropHtml(prop, content) {
  return `<meta property="${prop}" content="${esc(content)}">`;
}
function metaNameHtml(name, content) {
  return `<meta name="${name}" content="${esc(content)}">`;
}

function hasPropTag(html, prop) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const p = (m[0].match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (p && p.toLowerCase() === prop.toLowerCase()) return true;
  }
  return false;
}

function fix(html, ctx) {
  if (!ctx.socialIssues) return html;
  const title = ctx.title || ctx.existingTitle || ctx.siteName || 'Website';
  const desc = ctx.description || ctx.existingDescription || '';
  const image = ctx.ogImage || (ctx.origin ? ctx.origin + '/favicon.svg' : '');
  const url = ctx.url;
  const siteName = ctx.siteName || '';

  const additions = [];
  let out = html;

  for (const prop of OG_KEYS) {
    if (hasPropTag(out, prop)) continue;
    let value = '';
    if (prop === 'og:title') value = title;
    else if (prop === 'og:description') value = desc;
    else if (prop === 'og:image') value = image;
    else if (prop === 'og:url') value = url;
    else if (prop === 'og:type') value = 'website';
    if (!value) continue;
    const tag = metaPropHtml(prop, value);
    const res = replaceMetaBy(out, new RegExp(`\\bproperty\\s*=\\s*["']${prop}["']`, 'i'), tag);
    if (res.replaced) out = res.html;
    else additions.push(tag);
  }

  const tw = [
    ['twitter:card', image ? 'summary_large_image' : 'summary'],
    ['twitter:title', title],
    ['twitter:description', desc]
  ];
  for (const [name, value] of tw) {
    if (!value || hasPropTag(out, name)) continue;
    const tag = metaNameHtml(name, value);
    const res = replaceMetaBy(out, new RegExp(`\\bname\\s*=\\s*["']${name}["']`, 'i'), tag);
    if (res.replaced) out = res.html;
    else additions.push(tag);
  }

  if (siteName && !hasPropTag(out, 'og:site_name')) {
    additions.push(metaPropHtml('og:site_name', siteName));
  }

  if (!additions.length) {
    record(ctx, { rule: 'og', fixed: false, note: 'all social tags already present' });
    return html;
  }
  for (const tag of additions) out = injectBeforeCloseHead(out, tag);
  record(ctx, { rule: 'og', fixed: true, detail: `added ${additions.length} tag(s): ${additions.map(t => (t.match(/(?:property|name)="([^"]+)"/) || [])[1]).join(', ')}` });
  return out;
}

module.exports = { fix, OG_KEYS };
