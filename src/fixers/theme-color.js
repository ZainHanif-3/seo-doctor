'use strict';

const { injectBeforeCloseHead, esc, record } = require('./helpers');

const DEFAULT_COLOR = '#06070B';

function fix(html, ctx) {
  if (/<meta\b[^>]*name\s*=\s*["']theme-color["']/i.test(html)) {
    record(ctx, { rule: 'theme-color', fixed: false, note: 'already present' });
    return html;
  }
  const color = ctx.themeColor || DEFAULT_COLOR;
  record(ctx, { rule: 'theme-color', fixed: true, detail: `added theme-color ${color}` });
  return injectBeforeCloseHead(html, `<meta name="theme-color" content="${esc(color)}">`);
}

module.exports = { fix };
