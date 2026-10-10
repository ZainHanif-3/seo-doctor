'use strict';

const { escapeHtml } = require('../util');

function injectBeforeCloseHead(html, snippet) {
  const close = html.match(/<\/head\s*>/i);
  if (close) return html.slice(0, close.index) + '    ' + snippet + '\n  ' + html.slice(close.index);
  const open = html.match(/<head[^>]*>/i);
  if (open) {
    const at = open.index + open[0].length;
    return html.slice(0, at) + '\n    ' + snippet + html.slice(at);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + '\n<head>\n    ' + snippet + '\n  </head>' + html.slice(at);
  }
  return snippet + '\n' + html;
}

function replaceMetaBy(html, matcher, replacement) {
  let replaced = false;
  const out = html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (replaced) return tag;
    if (matcher.test(tag)) {
      replaced = true;
      return replacement;
    }
    return tag;
  });
  return { html: out, replaced };
}

function hasMeta(html, nameRe) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (nameRe.test(m[0])) return true;
  }
  return false;
}

function attrValue(tag, attr) {
  const m = tag.match(new RegExp('\\b' + attr + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  if (!m) return null;
  return m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
}

function esc(s) {
  return escapeHtml(String(s == null ? '' : s));
}

function record(ctx, entry) {
  if (ctx && Array.isArray(ctx.record)) ctx.record.push(entry);
}

module.exports = { injectBeforeCloseHead, replaceMetaBy, hasMeta, attrValue, esc, record };
