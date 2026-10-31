'use strict';

/**
 * GEO — Generative Engine Optimisation audit.
 *
 * "GEO" is about being *citable* by AI answer engines (ChatGPT, Claude,
 * Perplexity, Google AI Overviews, Bing Copilot). Those systems look for:
 *
 *   - permission to crawl (llms.txt, AI user-agents not blocked in robots.txt)
 *   - machine-readable entity data (JSON-LD @graph, authors, dates)
 *   - answer-first, extractable prose (question headings, short answers,
 *     lists/tables, citations)
 *   - clear authorship and freshness
 *
 * The numeric GEO score covers *technical/structural* signals only — the ones
 * that can be measured objectively and repaired. Editorial signals (answer-first
 * copy, citations, semantic depth) are reported as "content opportunities" and
 * are deliberately NOT part of the score, because they cannot be verified
 * mechanically and should not inflate or deflate a technical readiness figure.
 */

const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-Web', 'anthropic-ai',
  'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'CCBot', 'Bytespider',
  'Amazonbot', 'Applebot-Extended', 'meta-externalagent'
];

// Weights are relative, not percentages. The coverage score normalises them.
const PAGE_CHECKS = {
  'geo-noindex': 12,
  'geo-schema-graph': 12,
  'geo-author': 6,
  'geo-freshness': 4,
  'geo-faq': 6
};

const SITE_CHECKS = {
  'geo-llms-txt': 12,
  'geo-ai-crawlers': 12
};

const EDITORIAL_CHECKS = ['geo-semantic', 'geo-answer-first', 'geo-depth', 'geo-citations', 'geo-extractable'];

const PAGE_TOTAL = Object.values(PAGE_CHECKS).reduce((a, b) => a + b, 0);
const SITE_TOTAL = Object.values(SITE_CHECKS).reduce((a, b) => a + b, 0);

/** Total GEO weight available for a crawl of `pages` content pages. */
function possibleFor(pages) {
  const n = Math.max(1, Number(pages) || 1);
  return SITE_TOTAL + PAGE_TOTAL * n;
}

function jsonLdTypes(rawBlocks) {
  const types = new Set();
  const nodes = [];
  for (const raw of rawBlocks || []) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const t = node['@type'];
      if (typeof t === 'string') { types.add(t); nodes.push(node); }
      else if (Array.isArray(t)) { t.forEach(x => { if (typeof x === 'string') types.add(x); }); nodes.push(node); }
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(walk);
    };
    walk(parsed);
  }
  return { types, nodes };
}

function isHome(url, origin) {
  try {
    const u = new URL(url);
    return u.pathname === '/' || u.pathname === '';
  } catch { return false; }
}

function run(ctx) {
  const issues = [];
  const pages = ctx.pages;
  const crawl = ctx.crawl;
  const origin = ctx.origin;
  const startUrl = ctx.startUrl;

  const mk = (spec) => {
    const weight = spec.deniedFromScore
      ? 0
      : (spec.rule in PAGE_CHECKS ? PAGE_CHECKS[spec.rule] : (SITE_CHECKS[spec.rule] || 1));
    return ctx.mk({
      category: 'geo',
      ...spec,
      meta: { ...(spec.meta || {}), geoWeight: weight },
      geoWeight: weight
    });
  };

  // ---------------------------------------------------------------- site: llms.txt
  const llms = crawl.llms || { exists: false, status: 0 };
  if (!llms.exists) {
    issues.push(mk({
      rule: 'geo-llms-txt', severity: 'high', page: startUrl, pages: [startUrl],
      title: 'No /llms.txt — AI crawlers get no guidance',
      message: 'llms.txt is the emerging convention that tells AI assistants what your site is, which pages matter and how to cite them.',
      evidence: `GET ${origin}/llms.txt → ${llms.status || 'not found'}`,
      fixable: true, autoFixable: true,
      advice: 'Publish an llms.txt with the site summary, key pages and canonical links.'
    }));
  }

  // ------------------------------------------------------- site: AI crawler access
  if (crawl.robots && crawl.robots.exists) {
    const text = String(crawl.robots.text || '');
    const blocked = [];
    const groups = (crawl.robots.parsed && crawl.robots.parsed.groups) || [];
    for (const g of groups) {
      const agents = g.agents || [];
      const hits = agents.filter(a => AI_CRAWLERS.some(c => c.toLowerCase() === a));
      if (!hits.length) continue;
      const denied = g.rules.some(r => r.type === 'disallow' && (r.path === '/' || r.path === '/*'));
      if (denied) blocked.push(hits.join(', '));
    }
    const blanket = groups.some(g => g.agents.includes('*')
      && g.rules.some(r => r.type === 'disallow' && (r.path === '/' || r.path === '/*')));
    if (blocked.length || blanket) {
      issues.push(mk({
        rule: 'geo-ai-crawlers', severity: 'high', page: startUrl, pages: [startUrl],
        title: blanket && !blocked.length ? 'robots.txt blocks all crawlers' : 'robots.txt blocks AI crawlers',
        message: 'AI answer engines cannot read this site, so it can never be cited in generated answers.',
        evidence: blanket && !blocked.length
          ? 'User-agent: *\nDisallow: /'
          : blocked.map(b => `Disallow: / for ${b}`).join('; '),
        fixable: true, autoFixable: true,
        advice: 'Allow the major AI user-agents (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot) while keeping private paths blocked.'
      }));
    }
  }

  // ------------------------------------------------------------- per-page signals
  for (const p of pages) {
    const pr = p.parsed;
    if (!pr) continue;
    const url = p.finalUrl || p.url;
    const { types, nodes } = jsonLdTypes(pr.jsonld);

    // --- noindex ---
    const robotsMeta = String(pr.robotsMeta || '').toLowerCase();
    if (/noindex|none/.test(robotsMeta)) {
      issues.push(mk({
        rule: 'geo-noindex', severity: 'critical', page: url, pages: [url],
        title: 'Page is marked noindex',
        message: 'A noindex directive removes this page from search results and from AI retrieval — nothing else can compensate for it.',
        evidence: `<meta name="robots" content="${pr.robotsMeta}">`,
        fixable: false,
        advice: 'Remove noindex unless the page must stay out of search entirely.'
      }));
    }

    // --- schema graph ---
    const hasOrg = types.has('Organization') || types.has('LocalBusiness') || types.has('Corporation');
    const hasSite = types.has('WebSite');
    const hasPage = ['WebPage', 'Article', 'BlogPosting', 'NewsArticle', 'Product', 'Service', 'FAQPage', 'CollectionPage']
      .some(t => types.has(t));
    const home = isHome(url, origin);
    const schemaOk = home ? (hasOrg && hasSite) : hasPage;
    if (!schemaOk) {
      const missing = [];
      if (home && !hasOrg) missing.push('Organization');
      if (home && !hasSite) missing.push('WebSite');
      if (!home && !hasPage) missing.push('WebPage/Article');
      issues.push(mk({
        rule: 'geo-schema-graph', severity: 'high', page: url, pages: [url],
        title: `Missing JSON-LD entity data (${missing.join(', ') || 'none detected'})`,
        message: 'AI engines rely on structured data to identify the publisher, the page type and the entity relationships. Without it the page is ambiguous.',
        evidence: pr.jsonld.length
          ? `JSON-LD present but lacks: ${missing.join(', ')} (found: ${Array.from(types).join(', ') || 'nothing'})`
          : 'no <script type="application/ld+json"> on the page',
        fixable: true, autoFixable: true,
        advice: 'Publish a @graph containing Organization, WebSite, WebPage and BreadcrumbList nodes.'
      }));
    }

    // --- author entity ---
    const hasAuthor = nodes.some(n => n && n.author) || types.has('Person') || pr.hasByline;
    if (!hasAuthor) {
      issues.push(mk({
        rule: 'geo-author', severity: 'medium', page: url, pages: [url],
        title: 'No author / publisher entity',
        message: 'Answer engines prefer attributable content. A named author with a Person node increases citation confidence.',
        evidence: pr.hasByline ? 'byline found but no Person schema' : 'no author byline or Person schema',
        fixable: true, autoFixable: true,
        advice: 'Add author to the Article/WebPage node and include a Person with name + url.'
      }));
    }

    // --- freshness ---
    const hasDate = nodes.some(n => n && (n.dateModified || n.datePublished));
    if (!hasDate) {
      issues.push(mk({
        rule: 'geo-freshness', severity: 'low', page: url, pages: [url],
        title: 'No datePublished / dateModified',
        message: 'Undated content is down-ranked by AI retrieval, which favours recent, verifiable sources.',
        evidence: 'no datePublished or dateModified in JSON-LD',
        fixable: true, autoFixable: true,
        advice: 'Add dateModified (and datePublished where known) to the page entity.'
      }));
    }

    // --- FAQ / Q&A ---
    const questions = (pr.headings || []).filter(h => /\?\s*$/.test(h.text || ''));
    const hasFaq = types.has('FAQPage');
    if (questions.length && !hasFaq) {
      issues.push(mk({
        rule: 'geo-faq', severity: 'medium', page: url, pages: [url],
        title: `${questions.length} question heading(s) without FAQPage schema`,
        message: 'Question headings already answer user intent, but without FAQPage markup the Q&A pair is not machine-readable.',
        evidence: questions.slice(0, 3).map(q => `h${q.level}: ${q.text}`).join(' | '),
        fixable: true, autoFixable: true,
        advice: 'Wrap the question/answer pairs in FAQPage structured data.'
      }));
    }

    // ------------------------------------------------ editorial (not scored)
    const landmarks = pr.landmarks || {};
    if (!landmarks.main) {
      issues.push(mk({
        rule: 'geo-semantic', severity: 'medium', page: url, pages: [url],
        title: 'No <main> landmark',
        message: 'Semantic landmarks help retrieval pipelines separate the primary content from navigation and boilerplate.',
        evidence: `landmarks found: ${Object.keys(landmarks).filter(k => landmarks[k]).join(', ') || 'none'}`,
        fixable: false, deniedFromScore: true,
        advice: 'Wrap the primary content in a single <main> element.'
      }));
    }

    if (pr.firstParagraph) {
      const words = String(pr.firstParagraph).trim().split(/\s+/).length;
      if (words > 90) {
        issues.push(mk({
          rule: 'geo-answer-first', severity: 'medium', page: url, pages: [url],
          title: `Opening paragraph is ${words} words — too long to quote`,
          message: 'AI answers lift short, self-contained passages. Lead with a 40–60 word direct answer, then elaborate.',
          evidence: pr.firstParagraph.slice(0, 140) + '…',
          fixable: false, deniedFromScore: true,
          advice: 'Open with a 2–3 sentence answer that stands alone without context.'
        }));
      }
    }

    if (pr.wordCount > 0 && pr.wordCount < 400) {
      issues.push(mk({
        rule: 'geo-depth', severity: 'medium', page: url, pages: [url],
        title: `Thin content for citation (${pr.wordCount} words)`,
        message: 'Pages under ~400 words rarely carry enough substance for an AI engine to cite.',
        evidence: `body word count: ${pr.wordCount}`,
        fixable: false, deniedFromScore: true,
        advice: 'Expand to 600–1200 words of specific, factual detail (definitions, steps, numbers).'
      }));
    }

    const authoritative = (pr.links || []).filter(l => l.external && /\.(gov|edu)$|wikipedia\.org|doi\.org|who\.int|nih\.gov|europa\.eu/i.test(l.abs));
    if (!authoritative.length && pr.wordCount > 200) {
      issues.push(mk({
        rule: 'geo-citations', severity: 'low', page: url, pages: [url],
        title: 'No authoritative outbound citations',
        message: 'GEO favours content that cites primary sources — it is a trust signal for retrieval systems.',
        evidence: `${(pr.links || []).filter(l => l.external).length} outbound links, 0 authoritative`,
        fixable: false, deniedFromScore: true,
        advice: 'Link to primary sources (research, .gov/.edu, standards bodies) where you make factual claims.'
      }));
    }

    if (!(pr.listCount >= 1) && !(pr.tableCount >= 1) && pr.wordCount > 200) {
      issues.push(mk({
        rule: 'geo-extractable', severity: 'low', page: url, pages: [url],
        title: 'No lists or tables on the page',
        message: 'Structured content (bullet lists, comparison tables) is far more likely to be lifted into an AI answer.',
        evidence: `lists: ${pr.listCount || 0}, tables: ${pr.tableCount || 0}`,
        fixable: false, deniedFromScore: true,
        advice: 'Break key facts into bullet lists or a comparison table.'
      }));
    }
  }

  return issues;
}

module.exports = {
  run,
  possibleFor,
  AI_CRAWLERS,
  PAGE_CHECKS,
  SITE_CHECKS,
  EDITORIAL_CHECKS,
  PAGE_TOTAL,
  SITE_TOTAL
};
