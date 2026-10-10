'use strict';

const cheerio = require('cheerio');
const { slugify } = require('../util');
const { record } = require('./helpers');

const MAX_ALT = 110;

function nearestHeadingText($, el) {
  const merged = $('h1,h2,h3,h4,h5,h6,img').toArray();
  const idx = merged.findIndex(n => n === el);
  if (idx < 0) return '';
  for (let i = idx - 1; i >= 0; i--) {
    const name = merged[i].name || merged[i].tagName || '';
    if (/^h[1-6]$/.test(name)) {
      const t = $(merged[i]).text().replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  }
  return '';
}

function fix(html, ctx) {
  if (!ctx.imgAltIssues) return html;
  const $ = cheerio.load(html, { xmlMode: false });
  let changed = false;

  $('img').each((i, el) => {
    const $el = $(el);
    const alt = $el.attr('alt');
    if (alt != null && String(alt).trim() !== '') return;

    const heading = nearestHeadingText($, el);
    const src = ($el.attr('src') || $el.attr('data-src') || '').trim();
    let altValue = '';
    let source = '';
    if (heading) {
      altValue = heading;
      source = 'parent heading';
    } else {
      const slug = slugify(src.split('/').pop() || '');
      if (slug) { altValue = slug; source = 'filename'; }
    }

    if (!altValue) {
      altValue = 'descriptive image';
      source = 'fallback';
    }
    if (altValue.length > MAX_ALT) altValue = altValue.slice(0, MAX_ALT).trim();

    $el.attr('alt', altValue);
    changed = true;

    if (source === 'filename' || source === 'fallback') {
      record(ctx, {
        rule: 'img-alt', fixed: false, note: 'review needed',
        item: `${src || '(no src)'} → alt="${altValue}" (generated from ${source}, please verify)`
      });
    } else {
      record(ctx, {
        rule: 'img-alt', fixed: true,
        item: `${src || '(no src)'} → alt="${altValue}"`
      });
    }
  });

  return changed ? $.html() : html;
}

module.exports = { fix, nearestHeadingText };
