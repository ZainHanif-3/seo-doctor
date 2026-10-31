'use strict';

const meta = require('./meta');
const content = require('./content');
const social = require('./social');
const structured = require('./structured');
const technical = require('./technical');
const geo = require('./geo');
const { scoreIssues, scoreReport, projectScore, SEVERITIES } = require('../scoring');

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
        ...(spec.meta ? { meta: spec.meta } : {}),
        ...(spec.geoWeight != null ? { geoWeight: spec.geoWeight } : {}),
        ...(spec.deniedFromScore ? { deniedFromScore: true } : {})
      };
    }
  };

  let issues = [];
  issues = issues.concat(
    meta.run(ctx),
    content.run(ctx),
    social.run(ctx),
    structured.run(ctx),
    technical.run(ctx),
    geo.run(ctx)
  );

  issues.sort((a, b) =>
    (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) ||
    a.category.localeCompare(b.category) ||
    a.page.localeCompare(b.page));

  const geoPossible = geo.possibleFor(pages.length);
  const scores = scoreReport(issues, { pages: pages.length, geoPossible });
  const projection = projectScore(issues, { pages: pages.length, geoPossible });
  const v1 = scoreIssues(issues);

  return {
    issues,
    // v1 fields (backwards compatible)
    score: scores.seo,
    counts: v1.counts,
    weighted: v1.weighted,
    maxPossible: v1.maxPossible,
    // new
    seoScore: scores.seo,
    geoScore: scores.geo,
    overall: scores.overall,
    scores: {
      seo: scores.seo,
      geo: scores.geo,
      overall: scores.overall,
      counts: v1.counts,
      seoWeighted: scores.seoWeighted,
      geoPossible
    },
    projection: {
      seo: projection.seo,
      geo: projection.geo,
      overall: projection.overall,
      blockers: projection.blockers.map(b => ({
        id: b.id, rule: b.rule, severity: b.severity, category: b.category, title: b.title, page: b.page
      }))
    },
    contentPages: pages.length
  };
}

module.exports = { runAudit, dedupeContentPages };
