'use strict';

const { record } = require('./helpers');

function fix(html, ctx) {
  if (/<meta\b[^>]*\bcharset\s*=/i.test(html)) return html;
  const open = html.match(/<head[^>]*>/i);
  if (open) {
    const at = open.index + open[0].length;
    const out = html.slice(0, at) + '\n    <meta charset="utf-8">' + html.slice(at);
    record(ctx, { rule: 'charset', fixed: true, detail: '<meta charset="utf-8"> (first child of <head>)' });
    return out;
  }
  if (/<html[^>]*>/i.test(html)) {
    const out = html.replace(/(<html[^>]*>)/i, '$1\n<head><meta charset="utf-8"></head>');
    record(ctx, { rule: 'charset', fixed: true, detail: '<meta charset="utf-8">' });
    return out;
  }
  record(ctx, { rule: 'charset', fixed: false, note: 'no <head> element found' });
  return html;
}

module.exports = { fix };
