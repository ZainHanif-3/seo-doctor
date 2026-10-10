'use strict';

const cheerio = require('cheerio');
const { absUrl } = require('../util');
const { record } = require('./helpers');

function fix(html, ctx) {
  if (!ctx.imgDimIssues) return html;
  const dims = ctx.assetDims || {};
  const $ = cheerio.load(html, { xmlMode: false });
  let changed = false;

  $('img').each((i, el) => {
    const $el = $(el);
    if ($el.attr('width') && $el.attr('height')) return;
    const src = ($el.attr('src') || '').trim();
    if (!src) return;
    const abs = absUrl(ctx.url, src);
    const d = dims[src] || (abs && dims[abs]);
    if (d && d.width && d.height) {
      $el.attr('width', String(d.width));
      $el.attr('height', String(d.height));
      changed = true;
      record(ctx, { rule: 'img-dimensions', fixed: true, item: `${src} → ${d.width}×${d.height}` });
    } else {
      record(ctx, {
        rule: 'img-dimensions', fixed: false, note: 'review needed',
        item: `${src} → intrinsic size unavailable (asset not downloadable), set width/height manually`
      });
    }
  });

  return changed ? $.html() : html;
}

module.exports = { fix };
