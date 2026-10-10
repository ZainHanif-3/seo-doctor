'use strict';

const meta = require('./meta');
const content = require('./content');
const social = require('./social');
const structured = require('./structured');
const technical = require('./technical');
const { scoreIssues, SEVERITIES } = require('../scoring');

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function dedupeContentPages(pages) {
  const seen = new Set();
  const out = [];
  for (const p of pages) {
    if (!p.html || !p.parsed) continue;
    const key = p.finalUrl || p.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  out.sort((a, b) => (a.depth - b.depth) || a.url.localeCompare(b.url));
  return out;
}

function runAudit(crawl, opts = {}) {
  const pages = dedupeContentPages(crawl.pages);
  const ids = new Set();
  let seq = 0;

  const ctx = {
    crawl,
    startUrl: crawl.startUrl,
    host: crawl.host,
    origin: crawl.origin,
    pages,
    allPages: crawl.pages,
    siteName: opts.siteName || '',
    lang: opts.lang || 'en',
    mk(spec) {
      const pageList = spec.pages && spec.pages.length ? spec.pages : [spec.page || crawl.startUrl];
      const key = spec.pageLevel === 'site' ? 'site' : pageList[0];
      let id = `${spec.rule}@${key}`;
      if (ids.has(id)) id = `${spec.rule}@${key}#${++seq}`;
      ids.add(id);
      const { rule, pageLevel, pages: _p, ...rest } = spec;
      return {
        id,
        rule,
        severity: SEVERITIES.includes(spec.severity) ? spec.severity : 'low',
        category: spec.category || 'technical',
        page: spec.page || pageList[0],
        pages: pageList,
        title: spec.title || rule,
        message: spec.message || '',
        evidence: spec.evidence || '',
        fixable: !!spec.fixable,
        autoFixable: !!spec.autoFixable,
        advice: spec.advice || '',
        ...(spec.meta ? { meta: spec.meta } : {})
      };
    }
  };

  let issues = [];
  issues = issues.concat(meta.run(ctx), content.run(ctx), social.run(ctx), structured.run(ctx), technical.run(ctx));

  issues.sort((a, b) =>
    (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) ||
    a.category.localeCompare(b.category) ||
    a.page.localeCompare(b.page));

  const { score, counts, weighted, maxPossible } = scoreIssues(issues);
  return { issues, score, counts, weighted, maxPossible, contentPages: pages.length };
}

module.exports = { runAudit, dedupeContentPages };
