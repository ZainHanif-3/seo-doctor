'use strict';

const { record } = require('./helpers');

function fix(html, ctx) {
  const open = html.match(/<html\b([^>]*)>/i);
  if (!open) {
    record(ctx, { rule: 'lang', fixed: false, note: 'no <html> element found' });
    return html;
  }
  const attrs = open[1] || '';
  if (/\blang\s*=/i.test(attrs)) return html;
  const lang = (ctx.lang || 'en').replace(/[^a-zA-Z0-9-]/g, '') || 'en';
  const rest = attrs && attrs.trim() ? ' ' + attrs.trim() : '';
  const out = html.replace(open[0], () => `<html lang="${lang}"${rest}>`);
  record(ctx, { rule: 'lang', fixed: true, detail: `lang="${lang}"` });
  return out;
}

module.exports = { fix };
