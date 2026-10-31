'use strict';

const { siteKey, stripHash } = require('../util');

const KB = 1024, MB = 1024 * 1024;
const WEIGHT_LIMIT = 3 * MB;

function isCustom404(body) {
  const text = String(body || '');
  return /(^|[^0-9])(404)([^0-9]|$)/i.test(text) || /page\s+not\s+found|not\s+found|oops/i.test(text);
}

function run(ctx) {
  const issues = [];
  const pages = ctx.pages;
  const all = ctx.allPages;
  const crawl = ctx.crawl;
  const startUrl = ctx.startUrl;
  const origin = crawl.origin;
  const https = /^https:/.test(startUrl);

  // ---------- robots.txt ----------
  if (!crawl.robots.exists) {
    issues.push(ctx.mk({
      rule: 'robots-txt', severity: 'high', category: 'technical', page: startUrl, pages: [startUrl],
      title: 'robots.txt missing',
      message: 'GET /robots.txt returned ' + crawl.robots.status + ' — crawlers find no crawl policy and no sitemap hint.',
      evidence: `GET ${origin}/robots.txt → ${crawl.robots.status}`,
      fixable: true, autoFixable: true,
      advice: 'Publish an allow-all robots.txt with a Sitemap: line pointing at /sitemap.xml.'
    }));
  } else {
    const hasSitemapLine = (crawl.robots.parsed.sitemaps || []).length > 0;
    if (!hasSitemapLine) {
      issues.push(ctx.mk({
        rule: 'robots-txt', severity: 'medium', category: 'technical', page: startUrl, pages: [startUrl],
        title: 'robots.txt has no Sitemap line',
        message: 'robots.txt exists but never advertises the XML sitemap.',
        evidence: 'no "Sitemap:" directive found in /robots.txt',
        fixable: true, autoFixable: true,
        advice: 'Add a Sitemap: <absolute-url>/sitemap.xml line.'
      }));
    }
    const blocked = (crawl.blockedPaths || [])
      .map(b => { try { return new URL(b.url).pathname; } catch { return b.url; } });
    if (blocked.length) {
      issues.push(ctx.mk({
        rule: 'robots-blocked', severity: 'high', category: 'technical', page: startUrl, pages: [startUrl],
        title: 'robots.txt blocks important pages',
        message: 'Live content pages are disallowed for crawlers — they will not be indexed.',
        evidence: blocked.slice(0, 6).join(', '),
        fixable: false,
        advice: 'Remove the Disallow rules covering these paths (keep them only for private areas).'
      }));
    }
  }

  // ---------- sitemap.xml ----------
  if (!crawl.sitemap.exists) {
    issues.push(ctx.mk({
      rule: 'sitemap-xml', severity: 'high', category: 'technical', page: startUrl, pages: [startUrl],
      title: 'sitemap.xml missing',
      message: 'GET /sitemap.xml returned ' + crawl.sitemap.status + ' — no explicit URL inventory for search engines.',
      evidence: `GET ${origin}/sitemap.xml → ${crawl.sitemap.status}`,
      fixable: true, autoFixable: true,
      advice: 'Generate sitemap.xml listing every indexable URL with a lastmod date.'
    }));
  } else if (crawl.robots.exists && (crawl.robots.parsed.sitemaps || []).length === 0) {
    issues.push(ctx.mk({
      rule: 'robots-txt', severity: 'medium', category: 'technical', page: startUrl, pages: [startUrl],
      title: 'sitemap.xml not referenced in robots.txt',
      message: 'A sitemap exists but robots.txt does not point to it.',
      evidence: '/sitemap.xml present, no Sitemap: line in /robots.txt',
      fixable: true, autoFixable: true,
      advice: 'Add a Sitemap: line to robots.txt.'
    }));
  }

  // ---------- page status + redirect chains ----------
  for (const p of all) {
    if (p.offsite) continue;
    if (p.status >= 400 || p.status === 0) {
      issues.push(ctx.mk({
        rule: 'page-status', severity: 'high', category: 'technical', page: p.url, pages: [p.url],
        title: p.status === 0 ? 'Page unreachable' : `Page returns HTTP ${p.status}`,
        message: p.status === 0
          ? `Crawl failed for this URL (${p.error || 'network error'}).`
          : 'A final status of 4xx/5xx means the page cannot be indexed and users hit an error.',
        evidence: `${p.url} → ${p.status === 0 ? (p.error || 'error') : 'HTTP ' + p.status}`,
        fixable: false,
        advice: p.status === 410 || p.status === 404
          ? 'Restore the page or remove internal links pointing at it (301 to a live equivalent).'
          : 'Fix the server error, or 301-redirect the URL to a working page.'
      }));
    }
    if ((p.chain || []).length >= 2) {
      issues.push(ctx.mk({
        rule: 'redirect-chain', severity: 'medium', category: 'technical', page: p.url, pages: [p.url],
        title: `Redirect chain (${p.chain.length} hops)`,
        message: 'Every extra hop slows crawling and leaks link equity.',
        evidence: p.chain.map(c => `${c.status} ${c.from} → ${c.to}`).join(' ⇒ '),
        fixable: false,
        advice: 'Point every hop directly at the final destination URL (single 301).'
      }));
    }
  }

  // ---------- broken internal links ----------
  const statusByTarget = new Map();
  for (const p of all) statusByTarget.set(stripHash(p.url), p.status);
  const broken = new Map();
  for (const p of pages) {
    const src = p.finalUrl || p.url;
    for (const l of (p.parsed && p.parsed.links) || []) {
      if (l.external) continue;
      const t = stripHash(l.abs);
      if (t === src) continue;
      const st = statusByTarget.has(t) ? statusByTarget.get(t) : (ctx.crawl.linkStatus[t] ? ctx.crawl.linkStatus[t].status : undefined);
      if (st === undefined) continue;
      if (st === 0 || st >= 400) {
        if (!broken.has(t)) broken.set(t, { target: t, status: st, sources: [] });
        const b = broken.get(t);
        if (!b.sources.includes(src)) b.sources.push(src);
      }
    }
  }
  for (const b of broken.values()) {
    issues.push(ctx.mk({
      rule: 'link-broken', severity: 'high', category: 'technical', page: b.sources[0], pages: b.sources,
      title: `Broken internal link → HTTP ${b.status}`,
      message: 'Internal links point at a URL that returns an error; crawlers waste crawl budget and users hit dead ends.',
      evidence: `${b.target} → ${b.status}; linked from: ${b.sources.join(', ')}`,
      fixable: false,
      advice: 'Update the anchor to a working URL or 301-redirect the broken target.'
    }));
  }

  // ---------- HTTPS ----------
  if (!https) {
    issues.push(ctx.mk({
      rule: 'http-https', severity: 'high', category: 'technical', page: startUrl, pages: [startUrl],
      title: 'Site served over HTTP (no HTTPS)',
      message: 'The crawl started on plain http:// — HTTPS is a ranking signal and browsers flag HTTP pages as "Not secure".',
      evidence: startUrl,
      fixable: false,
      advice: 'Install a TLS certificate, force https://, and add HSTS. Redirect all http URLs with a 301.'
    }));
  } else {
    for (const p of pages) {
      const pr = p.parsed;
      const url = p.finalUrl || p.url;
      const mixed = [];
      for (const im of pr.images) if (im.abs && /^http:\/\//.test(im.abs)) mixed.push('img ' + im.abs);
      for (const s of pr.stylesheets) if (/^http:\/\//.test(s)) mixed.push('css ' + s);
      for (const s of pr.scripts) if (/^http:\/\//.test(s)) mixed.push('js ' + s);
      if (mixed.length) {
        issues.push(ctx.mk({
          rule: 'mixed-content', severity: 'high', category: 'technical', page: url, pages: [url],
          title: 'Mixed content (http:// assets on https page)',
          message: 'Insecure subresources are blocked by browsers, breaking layout/functionality.',
          evidence: mixed.slice(0, 5).join('; '),
          fixable: false,
          advice: 'Change every asset URL to https:// (protocol-relative or absolute).'
        }));
      }
    }
  }

  // ---------- www consistency ----------
  const withWww = new Set();
  const withoutWww = new Set();
  const consider = (u) => {
    try {
      const hn = new URL(u).hostname;
      if (siteKey(hn) !== siteKey(ctx.host)) return;
      (hn.startsWith('www.') ? withWww : withoutWww).add(hn);
    } catch { /* ignore */ }
  };
  for (const p of all) { consider(p.url); consider(p.finalUrl); }
  for (const p of pages) for (const l of (p.parsed && p.parsed.links) || []) consider(l.abs);
  if (withWww.size && withoutWww.size) {
    issues.push(ctx.mk({
      rule: 'www-inconsistency', severity: 'medium', category: 'technical', page: startUrl, pages: [startUrl],
      title: 'www / non-www inconsistency',
      message: 'Internal URLs mix the www and non-www host — this splits link equity across two versions of the site.',
      evidence: `www: ${Array.from(withWww).join(', ')} | bare: ${Array.from(withoutWww).join(', ')}`,
      fixable: false,
      advice: 'Pick one canonical host, 301 the other to it, and make canonicals/redirects agree.'
    }));
  }

  // ---------- custom 404 ----------
  if (crawl.canary.status >= 400 && crawl.canary.status < 500) {
    if (!isCustom404(crawl.canary.body)) {
      issues.push(ctx.mk({
        rule: 'page-404', severity: 'medium', category: 'technical', page: startUrl, pages: [startUrl],
        title: 'Missing custom 404 page',
        message: 'An unknown URL returns the generic server error page (no "404" content) — lost visitors get no navigation back.',
        evidence: `GET /seo-doctor-canary → ${crawl.canary.status}, body has no 404 content: "${String(crawl.canary.body).replace(/\s+/g, ' ').slice(0, 90)}"`,
        fixable: false,
        advice: 'Serve a branded 404.html with a search box, site menu and a link back to the homepage.'
      }));
    }
  } else if (crawl.canary.status >= 200 && crawl.canary.status < 300) {
    issues.push(ctx.mk({
      rule: 'page-404', severity: 'medium', category: 'technical', page: startUrl, pages: [startUrl],
      title: 'No real 404 status (catch-all route)',
      message: 'Unknown URLs return HTTP 200 — search engines cannot detect removed pages and will keep indexing garbage.',
      evidence: `GET /seo-doctor-canary → 200`,
      fixable: false,
      advice: 'Return an actual 404 status for non-existent URLs (keep the friendly body).'
    }));
  }

  // ---------- page weight ----------
  for (const p of pages) {
    if (p.size > WEIGHT_LIMIT) {
      issues.push(ctx.mk({
        rule: 'page-weight', severity: 'medium', category: 'technical', page: p.finalUrl || p.url, pages: [p.finalUrl || p.url],
        title: `Page weight ${(p.size / MB).toFixed(1)} MB (>3 MB)`,
        message: 'Heavy pages load slowly, hurting Core Web Vitals and rankings.',
        evidence: `${p.finalUrl || p.url}: ${(p.size / KB).toFixed(0)} KB of HTML`,
        fixable: false,
        advice: 'Compress/inline less, defer non-critical JS, and lazy-load heavy embeds.'
      }));
    }
  }

  // ---------- unminified inline styles ----------
  for (const p of pages) {
    const blocks = (p.parsed.inlineStyles || []).filter(s => s && s.length > 40);
    const unminified = blocks.filter(s => /\n\s*\S/.test(s) || /\s{2,}/.test(s));
    if (unminified.length) {
      issues.push(ctx.mk({
        rule: 'inline-css', severity: 'low', category: 'technical', page: p.finalUrl || p.url, pages: [p.finalUrl || p.url],
        title: 'Unminified inline styles',
        message: `${unminified.length} inline <style> block(s) contain whitespace/newlines — wasted bytes on every render.`,
        evidence: unminified.map(s => s.replace(/\s+/g, ' ').slice(0, 90)).join(' | '),
        fixable: true, autoFixable: true,
        advice: 'Move the CSS to an external file or minify it (one line, no comments).'
      }));
    }
  }

  // ---------- lazy loading ----------
  for (const p of pages) {
    const imgs = p.parsed.images.filter(im => im.src);
    const below = imgs.slice(1).filter(im =>
      im.loading !== 'lazy' && im.fetchpriority !== 'high' &&
      !/hero|logo|banner|brand/i.test(im.classes));
    if (below.length) {
      issues.push(ctx.mk({
        rule: 'lazy', severity: 'low', category: 'technical', page: p.finalUrl || p.url, pages: [p.finalUrl || p.url],
        title: `${below.length} below-fold image(s) without loading="lazy"`,
        message: 'Above-the-fold optimisation is missing — non-hero images load eagerly for no reason.',
        evidence: below.map(im => `<img src="${im.src}">`).join('; ').slice(0, 300),
        fixable: true, autoFixable: true,
        advice: 'Add loading="lazy" decoding="async" to images below the first viewport.'
      }));
    }
  }

  // ---------- theme-color ----------
  if (pages.length && !pages.some(p => p.parsed.themeColor)) {
    issues.push(ctx.mk({
      rule: 'theme-color', severity: 'low', category: 'technical', page: startUrl, pages: [startUrl],
      title: 'Missing theme-color meta tag',
      message: 'No <meta name="theme-color"> — mobile browsers cannot tint the UI chrome with the brand colour.',
      evidence: 'no <meta name="theme-color"> on any crawled page',
      fixable: true, autoFixable: true,
      advice: 'Add <meta name="theme-color" content="#06070B"> (your brand hex) to the head.'
    }));
  }

  void origin;
  return issues;
}

module.exports = { run, isCustom404 };
