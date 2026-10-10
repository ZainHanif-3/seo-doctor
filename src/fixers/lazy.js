'use strict';

const cheerio = require('cheerio');
const { record } = require('./helpers');

function isHero(el, index) {
  if (index === 0) return true;
  const cls = String(el.attribs && (el.attribs.class || '')).toLowerCase();
  return /hero|logo|banner|brand|icon/.test(cls);
}

function fix(html, ctx) {
  if (!ctx.lazyIssues) return html;
  const $ = cheerio.load(html, { xmlMode: false });
  let changed = false;
  let added = 0;

  $('img').each((i, el) => {
    if (isHero(el, i)) return;
    const $el = $(el);
    if ($el.attr('loading')) return;
    if (($el.attr('fetchpriority') || '').toLowerCase() === 'high') return;
    $el.attr('loading', 'lazy');
    if (!$el.attr('decoding')) $el.attr('decoding', 'async');
    changed = true;
    added += 1;
  });

  if (changed) {
    record(ctx, { rule: 'lazy', fixed: true, detail: `added loading="lazy" to ${added} image(s)` });
    return $.html();
  }
  record(ctx, { rule: 'lazy', fixed: false, note: 'no eligible images found' });
  return html;
}

module.exports = { fix };
