'use strict';

const cheerio = require('cheerio');
const { record } = require('./helpers');

const LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/**
 * Skipped heading levels (h1 → h3) break the document outline. The safe repair
 * is to renumber the offending heading to `previous + 1`, preserving its
 * attributes and inner HTML. Text and styling hooks are untouched.
 */
function fix(html, ctx) {
  let changed = 0;
  const $ = cheerio.load(html, { decodeEntities: false });

  let prev = 0;
  $('h1, h2, h3, h4, h5, h6').each((i, el) => {
    const tag = String(el.tagName || el.name || '').toLowerCase();
    const level = LEVELS.indexOf(tag) + 1;
    if (!level) return;

    let target = level;
    if (prev && level > prev + 1) {
      target = prev + 1;
      const newTag = 'h' + target;
      const replacement = $('<' + newTag + '></' + newTag + '>');
      const attrs = el.attribs || {};
      for (const [k, v] of Object.entries(attrs)) replacement.attr(k, v);
      replacement.html($(el).html() || '');
      $(el).replaceWith(replacement);
      changed += 1;
    }
    prev = target;
  });

  if (!changed) {
    record(ctx, { rule: 'heading-skip', fixed: false, note: 'no skipped levels found' });
    return html;
  }
  record(ctx, { rule: 'heading-skip', fixed: true, detail: `renumbered ${changed} heading(s)` });
  return $.html();
}

module.exports = { fix };
