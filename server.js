'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const { normalizeInputUrl, deriveSiteName } = require('./src/util');
const { crawlSite } = require('./src/crawler');
const { runAudit } = require('./src/audit');
const store = require('./src/store');
const { optimize } = require('./src/optimizer');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ZIPS_DIR = path.join(ROOT, 'data', 'zips');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

// Never log request bodies (live mode may carry FTP credentials).
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

function rid() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function slimCrawl(crawl) {
  return {
    origin: crawl.origin,
    host: crawl.host,
    startUrl: crawl.startUrl,
    robots: { status: crawl.robots.status, exists: crawl.robots.exists, text: crawl.robots.text || '' },
    favicon: crawl.favicon,
    canary: { status: crawl.canary.status, body: String(crawl.canary.body || '').slice(0, 4000) },
    sitemap: { status: crawl.sitemap.status, exists: crawl.sitemap.exists },
    blockedPaths: crawl.blockedPaths,
    assets: crawl.assets,
    limits: crawl.limits,
    truncated: crawl.truncated,
    stopReason: crawl.stopReason
  };
}

// ---------- built-in demo site ----------
app.get('/demo', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'demo', 'index.html'));
});
app.get('/demo/old.html', (req, res) => {
  res.redirect(301, '/demo/legacy.html');
});
app.get('/demo/legacy.html', (req, res) => {
  res.redirect(301, '/demo/about.html');
});

app.use(express.static(PUBLIC, { index: 'index.html' }));

// ---------- API ----------
app.post('/api/analyze', async (req, res) => {
  try {
    const body = req.body || {};
    const url = normalizeInputUrl(body.url);
    if (!url) {
      return res.status(400).json({ error: 'Provide a valid URL, e.g. https://example.com or localhost:3000/demo' });
    }
    const siteName = String(body.siteName || '').trim().slice(0, 60) || deriveSiteName(new URL(url).hostname);
    const lang = String(body.lang || 'en').trim().replace(/[^a-zA-Z-]/g, '').slice(0, 10) || 'en';

    const t0 = Date.now();
    const crawl = await crawlSite(url, { maxPages: 30, maxDepth: 3, budgetMs: 10000, concurrency: 4 });
    const audit = runAudit(crawl, { siteName, lang });

    const report = {
      id: rid(),
      url: crawl.startUrl,
      origin: crawl.origin,
      host: crawl.host,
      siteName,
      lang,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      score: audit.score,
      counts: audit.counts,
      weighted: audit.weighted,
      contentPages: audit.contentPages,
      issues: audit.issues,
      crawl: slimCrawl(crawl),
      pages: crawl.pages,
      optimizedAt: null,
      lastResult: null
    };
    store.add(report);

    res.json({
      id: report.id,
      url: report.url,
      score: report.score,
      pages: crawl.pages.length,
      counts: report.counts,
      issues: report.issues,
      durationMs: report.durationMs,
      siteName,
      lang,
      truncated: crawl.truncated
    });
  } catch (e) {
    console.error('[analyze]', e.message);
    res.status(500).json({ error: `Analysis failed: ${e.message}` });
  }
});

app.get('/api/report/:id', (req, res) => {
  const report = store.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { pages, crawl, ...rest } = report;
  res.json({
    ...rest,
    pages: pages.map(p => ({
      url: p.url, finalUrl: p.finalUrl, status: p.status, depth: p.depth,
      size: p.size, title: p.parsed ? p.parsed.title : null,
      words: p.parsed ? p.parsed.wordCount : null, chain: p.chain || []
    })),
    crawl: { ...crawl, canary: { status: crawl.canary.status } }
  });
});

async function handleOptimize(req, res, forceLive) {
  try {
    const body = req.body || {};
    const report = store.get(body.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found — run Analyze first.' });
    const mode = forceLive ? 'live' : (body.mode === 'live' ? 'live' : 'mirror');
    const result = await optimize(report, {
      mode,
      selected: Array.isArray(body.selected) ? body.selected : null,
      confirm: body.confirm === true,
      permission: body.permission === true,
      creds: body.creds || null,
      siteName: body.siteName ? String(body.siteName).trim().slice(0, 60) : undefined,
      lang: body.lang ? String(body.lang).trim().slice(0, 10) : undefined
    });
    res.json({
      mode: result.mode,
      fixed: result.fixed,
      skipped: result.skipped,
      diff: result.diff,
      diffs: result.diffs,
      zipUrl: result.zipUrl || null,
      mirror: result.mirror || null,
      diffReport: result.diffReport,
      uploaded: result.uploaded || null,
      stats: result.stats,
      durationMs: result.durationMs
    });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[optimize]', e.message);
    res.status(status).json({ error: e.message });
  }
}

app.post('/api/optimize', (req, res) => handleOptimize(req, res, false));
app.post('/api/optimize/live', (req, res) => handleOptimize(req, res, true));

app.get('/api/download/:id', (req, res) => {
  const report = store.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const zipPath = path.join(ZIPS_DIR, `${report.id}.zip`);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'No repaired mirror yet — click Optimize first.' });
  }
  const name = `seo-doctor-${String(report.host).replace(/[^a-z0-9.-]/gi, '_')}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(zipPath).pipe(res);
});

app.get('/api/stats', (req, res) => {
  res.json({ ...store.stats(), uptimeSec: Math.round(process.uptime()), port: PORT });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'seo-doctor', uptimeSec: Math.round(process.uptime()) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`SEO Doctor running → http://localhost:${PORT} (demo: /demo)`);
});

module.exports = { app, PORT };
