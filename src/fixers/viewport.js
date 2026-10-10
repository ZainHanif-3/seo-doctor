'use strict';

const { injectBeforeCloseHead, record } = require('./helpers');

function fix(html, ctx) {
  if (/<meta\b[^>]*\bname\s*=\s*["']viewport["']/i.test(html)) return html;
  const out = injectBeforeCloseHead(html, '<meta name="viewport" content="width=device-width, initial-scale=1">');
  record(ctx, { rule: 'viewport', fixed: true, detail: 'width=device-width, initial-scale=1' });
  return out;
}

module.exports = { fix };
