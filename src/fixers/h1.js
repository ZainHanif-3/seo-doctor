'use strict';

const cheerio = require('cheerio');
const { record } = require('./helpers');

function retag(el, name) {
  el.name = name;
  if (el.tagName) el.tagName = name;
  if (el.nodeName) el.nodeName = name;
}

function fix(html, ctx) {
  if (!ctx.h1Issues || !ctx.h1Issues.length) return html;
  const $ = cheerio.load(html, { xmlMode: false });
  const h1s = $('h1');

  if (h1s.length === 0) {
    const target = $('h2').first();
    if (!target.length) {
      record(ctx, { rule: 'h1', fixed: false, note: 'no <h2> available to promote' });
      return html;
    }
    const text = target.text().replace(/\s+/g, ' ').trim();
    retag(target[0], 'h1');
    const out = $.html();
    ctx.h1 = text;
    record(ctx, { rule: 'h1', fixed: true, detail: `promoted <h2>"${text}"</h2> → <h1>` });
    return out;
  }

  if (h1s.length > 1) {
    const demoted = [];
    h1s.toArray().slice(1).forEach(el => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      retag(el, 'h2');
      demoted.push(`"${text}"`);
    });
    const out = $.html();
    record(ctx, { rule: 'h1', fixed: true, detail: `demoted ${demoted.length} extra <h1> to <h2>: ${demoted.join(', ')}` });
    return out;
  }

  return html;
}

module.exports = { fix };
