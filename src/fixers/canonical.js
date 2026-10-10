'use strict';

const { injectBeforeCloseHead, record } = require('./helpers');

function fix(html, ctx) {
  if (/<link\b[^>]*\brel\s*=\s*["']canonical["']/i.test(html)) return html;
  const url = ctx.url || ctx.startUrl;
  if (!url) return html;
  const out = injectBeforeCloseHead(html, `<link rel="canonical" href="${url}">`);
  record(ctx, { rule: 'canonical', fixed: true, detail: url });
  return out;
}

module.exports = { fix };
