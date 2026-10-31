'use strict';

const { record } = require('./helpers');

const PUNCT = /[{}:;,>+~()]/;

/**
 * Conservative CSS minifier: removes comments and collapses whitespace while
 * leaving quoted strings (content: "a  b") byte-for-byte intact.
 */
function minifyCss(css) {
  const src = String(css || '');
  let out = '';
  let i = 0;
  let quote = null;

  while (i < src.length) {
    const ch = src[i];

    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] || '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    if (/\s/.test(ch)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      const next = src[j];
      if (next && !PUNCT.test(next) && out && !PUNCT.test(out[out.length - 1])) out += ' ';
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.trim();
}

function fix(html, ctx) {
  let changed = 0;

  const out = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (whole, open, css, close) => {
    if (!css || css.length <= 40) return whole;
    const min = minifyCss(css);
    if (!min || min === css) return whole;
    changed += 1;
    return open + min + close;
  });

  if (!changed) {
    record(ctx, { rule: 'inline-css', fixed: false, note: 'nothing to minify' });
    return html;
  }
  record(ctx, { rule: 'inline-css', fixed: true, detail: `minified ${changed} inline style block(s)` });
  return out;
}

module.exports = { fix, minifyCss };
