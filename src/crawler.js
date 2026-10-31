'use strict';

const { absUrl, isSameSite, looksLikePage, siteKey, stripHash } = require('./util');
const { parsePage } = require('./parse');

const UA = 'SEO-Doctor/1.0 (+ZN DEVELOPER; audit bot)';
const UA_LC = UA.toLowerCase();

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  for (let line of String(text || '').split(/\r?\n/)) {
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    const m = line.match(/^\s*([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (!cur) { cur = { agents: ['*'], rules: [] }; groups.push(cur); }
      cur.rules.push({ type: key, path: val });
    } else if (key === 'sitemap') {
      if (val) sitemaps.push(val);
    }
  }
  return { groups, sitemaps, raw: String(text || '') };
}

function pathMatches(path, pattern) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let re = '';
  for (const ch of body) {
    if (ch === '*') re += '.*';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  re = '^' + re + (anchored ? '$' : '');
  try { return new RegExp(re).test(path); } catch { return path.startsWith(body); }
}

function robotsAllows(path, robots) {
  if (!robots) return true;
  let bestLen = -1;
  let allowed = true;
  let matched = false;
  for (const g of robots.groups) {
    if (!g.agents.some(a => a === '*' || UA_LC.includes(a) || a.includes('seo-doctor'))) continue;
    for (const r of g.rules) {
      if (!r.path) continue;
      if (r.path.length < bestLen) continue;
      if (pathMatches(path, r.path)) {
        if (r.path.length > bestLen) { bestLen = r.path.length; allowed = r.type === 'allow'; matched = true; }
        else if (r.type === 'allow') { allowed = true; matched = true; }
      }
    }
  }
  return matched ? allowed : true;
}

async function fetchWithTimeout(url, timeoutMs, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-encoding': 'identity'
      },
      ...opts
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDocument(url, timeoutMs, siteStart) {
  let cur = url;
  const chain = [];
  for (let hop = 0; hop < 6; hop++) {
    let res;
    try {
      res = await fetchWithTimeout(cur, timeoutMs);
    } catch (e) {
      return { error: e.name === 'AbortError' ? 'timeout' : String(e.message || e), finalUrl: cur, chain };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      const next = loc ? absUrl(cur, loc) : null;
      chain.push({ from: cur, to: next, status: res.status });
      if (!next) return { res, finalUrl: cur, chain };
      if (siteStart && !isSameSite(next, siteStart)) {
        return { res, finalUrl: next, chain, offsite: true };
      }
      cur = next;
      continue;
    }
    return { res, finalUrl: cur, chain };
  }
  return { error: 'too-many-redirects', finalUrl: cur, chain };
}

async function probe(origin, path, timeoutMs = 4000) {
  try {
    const res = await fetchWithTimeout(origin + path, timeoutMs);
    const text = res.headers.get('content-type') && /text|xml|json/.test(res.headers.get('content-type'))
      ? (await res.text()).slice(0, 200000) : null;
    return { status: res.status, ok: res.ok, text, headers: res.headers };
  } catch (e) {
    return { status: 0, ok: false, error: String(e.message || e) };
  }
}

async function crawlSite(startUrl, opts = {}) {
  const cfg = {
    maxPages: Number(opts.maxPages) || 30,
    maxDepth: Number(opts.maxDepth) || 3,
    budgetMs: Number(opts.budgetMs) || 10000,
    concurrency: Number(opts.concurrency) || 4,
    perRequestMs: Number(opts.perRequestMs) || 5000,
    ...opts
  };
  const t0 = Date.now();
  const origin = new URL(startUrl).origin;
  const host = new URL(startUrl).hostname;
  const key = siteKey(host);

  const [robotsProbeRes, faviconRes, sitemapRes, canaryRes, llmsRes] = await Promise.all([
    probe(origin, '/robots.txt'),
    probe(origin, '/favicon.ico'),
    probe(origin, '/sitemap.xml'),
    probe(origin, '/seo-doctor-canary-' + Math.random().toString(36).replace(/[0-9]/g, 'abcdefghijkmnpqrstuvwxyz').slice(2, 10)),
    probe(origin, '/llms.txt')
  ]);

  const robots = {
    status: robotsProbeRes.status,
    exists: robotsProbeRes.status >= 200 && robotsProbeRes.status < 300,
    text: robotsProbeRes.text || '',
    parsed: null
  };
  robots.parsed = robots.exists ? parseRobots(robots.text) : null;

  const sitemapProbe = {
    status: sitemapRes.status,
    exists: sitemapRes.status >= 200 && sitemapRes.status < 300,
    text: sitemapRes.text || ''
  };
  const favicon = { status: faviconRes.status, ok: faviconRes.status >= 200 && faviconRes.status < 300 };
  const canary = { status: canaryRes.status, body: canaryRes.text || '' };

  // llms.txt — the GEO convention for telling AI assistants what to cite.
  const llms = {
    status: llmsRes.status,
    exists: llmsRes.status >= 200 && llmsRes.status < 300,
    text: llmsRes.text || ''
  };

  const pages = [];
  const seen = new Set();
  const blockedPaths = [];
  const assets = new Map();
  const linkStatus = new Map();
  let stopReason = null;

  const queue = [{ url: stripHash(startUrl), depth: 0 }];

  const budgetLeft = () => cfg.budgetMs - (Date.now() - t0);

  async function worker() {
    while (true) {
      if (stopReason) return;
      if (pages.length >= cfg.maxPages) { stopReason = 'page-cap'; return; }
      if (budgetLeft() <= 400) { stopReason = 'budget'; return; }
      const item = queue.shift();
      if (!item) return;
      if (seen.has(item.url)) continue;
      seen.add(item.url);

      let u;
      try { u = new URL(item.url); } catch { continue; }
      const path = u.pathname + u.search;
      if (robots.parsed && !robotsAllows(path, robots.parsed)) {
        blockedPaths.push({ url: item.url, depth: item.depth });
        linkStatus.set(item.url, { blocked: true });
        continue;
      }

      const timeout = Math.max(1500, Math.min(cfg.perRequestMs, budgetLeft()));
      const result = await fetchDocument(item.url, timeout, startUrl);

      if (result.error) {
        pages.push({
          url: item.url, finalUrl: result.finalUrl, status: 0, chain: result.chain || [],
          error: result.error, contentType: null, size: 0, html: null, parsed: null,
          depth: item.depth, fetchedAt: new Date().toISOString()
        });
        linkStatus.set(item.url, { status: 0 });
        continue;
      }

      const { res, finalUrl, chain, offsite } = result;
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      let html = null;
      let size = Number(res.headers.get('content-length') || 0);

      if (!offsite && res.status >= 200 && res.status < 300 && /html/.test(contentType)) {
        html = await res.text();
        if (!size) size = Buffer.byteLength(html, 'utf8');
      } else if (!offsite && res.status >= 200 && res.status < 300) {
        const buf = Buffer.from(await res.arrayBuffer());
        size = buf.length;
      }

      let parsed = null;
      if (html) {
        try { parsed = parsePage(html, finalUrl || item.url); } catch (e) { parsed = null; }
      }

      const entry = {
        url: item.url,
        finalUrl,
        status: res.status,
        chain,
        offsite: !!offsite,
        contentType,
        size,
        html,
        parsed,
        depth: item.depth,
        fetchedAt: new Date().toISOString()
      };
      pages.push(entry);
      linkStatus.set(item.url, { status: res.status });
      if (res.status >= 400) continue;
      if (!parsed) continue;

      for (const img of parsed.images) {
        if (img.abs && isSameSite(img.abs, startUrl)) assets.set(img.abs, 'image');
        else if (img.abs) assets.set(img.abs, 'external-image');
      }
      for (const s of parsed.stylesheets) assets.set(s, isSameSite(s, startUrl) ? 'css' : 'external-css');
      for (const s of parsed.scripts) assets.set(s, isSameSite(s, startUrl) ? 'js' : 'external-js');
      if (parsed.favicon.length) for (const f of parsed.favicon) {
        const a = absUrl(finalUrl || item.url, f);
        if (a) assets.set(a, 'favicon');
      }

      if (item.depth + 1 > cfg.maxDepth) continue;
      const discovered = new Set();
      for (const l of parsed.links) {
        const norm = stripHash(l.abs);
        if (!looksLikePage(norm)) continue;
        if (!isSameSite(norm, startUrl)) continue;
        discovered.add(norm);
        if (!linkStatus.has(norm) && !seen.has(norm)) {
          queue.push({ url: norm, depth: item.depth + 1 });
        }
      }
      void discovered;
    }
  }

  await Promise.all(Array.from({ length: cfg.concurrency }, () => worker()));

  const durationMs = Date.now() - t0;
  return {
    startUrl: stripHash(startUrl),
    origin,
    host,
    siteKey: key,
    robots,
    favicon,
    canary,
    llms,
    sitemap: sitemapProbe,
    pages,
    blockedPaths,
    assets: Array.from(assets.entries()).map(([url, kind]) => ({ url, kind })),
    linkStatus: Object.fromEntries(linkStatus),
    limits: { maxPages: cfg.maxPages, maxDepth: cfg.maxDepth, budgetMs: cfg.budgetMs, concurrency: cfg.concurrency },
    truncated: !!stopReason,
    stopReason,
    durationMs
  };
}

module.exports = { crawlSite, parseRobots, robotsAllows, pathMatches, fetchWithTimeout, UA };
