'use strict';

const { injectBeforeCloseHead, record } = require('./helpers');

function fix(html, ctx) {
  if (/<meta\b[^>]*\bname\s*=\s*["']robots["']/i.test(html)) return html;
  const out = injectBeforeCloseHead(html, '<meta name="robots" content="index,follow">');
  record(ctx, { rule: 'robots-meta', fixed: true, detail: 'meta name="robots" content="index,follow"' });
  return out;
}

module.exports = { fix };
