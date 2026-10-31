'use strict';

const title = require('./title');
const description = require('./description');
const canonical = require('./canonical');
const robotsMeta = require('./robots-meta');
const viewport = require('./viewport');
const charset = require('./charset');
const lang = require('./lang');
const h1 = require('./h1');
const imgAlt = require('./img-alt');
const imgDimensions = require('./img-dimensions');
const og = require('./og');
const favicon = require('./favicon');
const jsonld = require('./jsonld');
const lazy = require('./lazy');
const robotsSitemap = require('./robots-sitemap');
const geo = require('./geo');
const jsonldClean = require('./jsonld-clean');
const themeColor = require('./theme-color');
const headingOrder = require('./heading-order');
const inlineCss = require('./inline-css');

const FIXERS = {
  title: title.fix,
  description: description.fix,
  canonical: canonical.fix,
  'robots-meta': robotsMeta.fix,
  viewport: viewport.fix,
  charset: charset.fix,
  lang: lang.fix,
  h1: h1.fix,
  'img-alt': imgAlt.fix,
  'img-dimensions': imgDimensions.fix,
  og: og.fix,
  favicon: favicon.fix,
  'jsonld': jsonld.fix,
  'jsonld-invalid': jsonldClean.fix,
  'theme-color': themeColor.fix,
  'heading-skip': headingOrder.fix,
  'inline-css': inlineCss.fix,
  lazy: lazy.fix,
  // GEO — all four page rules converge on one idempotent @graph injection
  'geo-schema-graph': geo.fix,
  'geo-author': geo.fix,
  'geo-freshness': geo.fix,
  'geo-faq': geo.fix
};

const RULES = Object.keys(FIXERS);

function applyPageFixes(html, ctx, rules) {
  let out = html;
  const applied = [];
  for (const rule of rules) {
    const fn = FIXERS[rule];
    if (typeof fn !== 'function') continue;
    const next = fn(out, ctx);
    if (typeof next === 'string' && next !== out) {
      applied.push(rule);
      out = next;
    }
  }
  return { html: out, changed: out !== html, applied };
}

module.exports = {
  FIXERS,
  RULES,
  applyPageFixes,
  generateRobotsTxt: robotsSitemap.generateRobotsTxt,
  augmentRobotsTxt: robotsSitemap.augmentRobotsTxt,
  generateSitemapXml: robotsSitemap.generateSitemapXml,
  sitemapEntriesFor: robotsSitemap.sitemapEntriesFor,
  generateFaviconSvg: favicon.generateFaviconSvg,
  buildTitle: title.buildTitle,
  buildDescription: description.buildDescription,
  generateLlmsTxt: geo.generateLlmsTxt,
  augmentRobotsForAi: geo.augmentRobotsForAi,
  geo: geo
};
