'use strict';

const fs = require('fs');
const path = require('path');
const { imageSize } = require('image-size');
const ftpClient = require('basic-ftp');

const { isSameSite, mirrorRelPath, escapeHtml, deriveSiteName, titleCase } = require('./util');
const { fetchWithTimeout } = require('./crawler');
const {
  applyPageFixes, generateRobotsTxt, augmentRobotsTxt,
  generateSitemapXml, sitemapEntriesFor, generateFaviconSvg
} = require('./fixers');
const { zipDirectory } = require('./zip');
const store = require('./store');

const ROOT = path.join(__dirname, '..');
const SITES_DIR = path.join(ROOT, 'sites');
const ZIPS_DIR = path.join(ROOT, 'data', 'zips');
const SITE_RULES = new Set(['robots-txt', 'sitemap-xml']);
const DIFF_CAP = 12000;
const MAX_ASSETS = 100;
const ASSET_TIMEOUT = 6000;
const ASSET_MAX_BYTES = 4 * 1024 * 1024;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cap(s) {
  s = String(s == null ? '' : s);
  if (s.length <= DIFF_CAP) return s;
  return s.slice(0, DIFF_CAP) + `\n… [truncated, ${s.length} chars total]`;
}

async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      try { await worker(item); } catch { /* best effort */ }
    }
  });
  await Promise.all(runners);
}

function relFaviconHref(relPagePath) {
  const dir = path.posix.dirname(relPagePath);
  if (!dir || dir === '.') return 'favicon.svg';
  const depth = dir.split('/').filter(Boolean).length;
  return '../'.repeat(depth) + 'favicon.svg';
}

function pathSuffixFor(url) {
  try {
    const p = new URL(url).pathname;
    const base = p.split('/').filter(Boolean).pop() || '';
    const stem = base.replace(/\.[a-z0-9]+$/i, '');
    if (!stem) return '';
    return titleCase(stem.replace(/[-_]+/g, ' '));
  } catch { return ''; }
}

async function downloadAssets(report, mirrorDir) {
  const dims = {};
  const list = (report.crawl.assets || [])
    .filter(a => a && a.url && isSameSite(a.url, report.url))
    .slice(0, MAX_ASSETS);
  let saved = 0;

  await pool(list, 4, async (a) => {
    let res;
    try {
      res = await fetchWithTimeout(a.url, ASSET_TIMEOUT);
    } catch { return; }
    if (!res || !res.ok) return;
    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); } catch { return; }
    if (!buf.length || buf.length > ASSET_MAX_BYTES) return;
    try {
      const rel = mirrorRelPath(a.url);
      const abs = path.join(mirrorDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      saved += 1;
      if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(new URL(a.url).pathname)) {
        try {
          const d = imageSize(buf);
          if (d && d.width && d.height) dims[a.url] = { width: d.width, height: d.height };
        } catch { /* not an image we can measure */ }
      }
    } catch { /* write failure ignored */ }
  });

  return { dims, saved };
}

function buildPageContext(report, page, shared) {
  const pr = page.parsed;
  const url = page.finalUrl || page.url;
  const rel = mirrorRelPath(page.url);
  const pageIssues = report.issues.filter(i => (i.pages || []).includes(url));

  const ctx = {
    url,
    startUrl: report.url,
    origin: report.origin,
    host: report.host,
    siteName: shared.siteName,
    lang: shared.lang,
    pageKey: pathSuffixFor(url),
    pathSuffix: pathSuffixFor(url),

    existingTitle: pr.title || '',
    existingDescription: pr.description || '',
    title: pr.title || '',
    description: pr.description || '',
    h1: (pr.h1s && pr.h1s[0]) || '',
    firstHeading: (pr.headings && pr.headings[0] && pr.headings[0].text) || '',
    firstParagraph: pr.firstParagraph || '',
    bodyHtml: page.html,

    titleIssues: pageIssues.filter(i => i.rule === 'title').map(i => (i.meta && i.meta.reason) || 'missing'),
    descIssues: pageIssues.filter(i => i.rule === 'description').map(i => (i.meta && i.meta.reason) || 'missing'),
    h1Issues: pageIssues.filter(i => i.rule === 'h1'),
    imgAltIssues: pageIssues.filter(i => i.rule === 'img-alt'),
    imgDimIssues: pageIssues.filter(i => i.rule === 'img-dimensions'),
    socialIssues: pageIssues.filter(i => i.rule === 'og'),
    jsonldIssues: pageIssues.filter(i => i.rule === 'jsonld'),
    lazyIssues: pageIssues.filter(i => i.rule === 'lazy'),

    canonicalPresent: !!pr.canonical,
    otherTitles: report.pages
      .filter(p => p !== page && p.parsed && p.parsed.title)
      .map(p => p.parsed.title),

    ogImage: (pr.images || []).map(i => i.abs).find(Boolean) || '',
    assetDims: shared.dims,
    faviconHref: relFaviconHref(rel),
    record: []
  };
  return ctx;
}

function buildDiffReportHtml(report, result) {
  const rows = result.diff.map(d => `
    <details class="file">
      <summary><code>${escapeHtml(d.file)}</code> — ${d.rules ? d.rules.join(', ') : ''}</summary>
      <div class="cols">
        <div><h3>Before</h3><pre>${escapeHtml(d.before)}</pre></div>
        <div><h3>After</h3><pre>${escapeHtml(d.after)}</pre></div>
      </div>
    </details>`).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SEO Doctor — repair report</title>
<style>
body{background:#06070B;color:#e5e7eb;font:14px/1.6 "JetBrains Mono",ui-monospace,monospace;margin:0;padding:32px;max-width:1100px;margin-inline:auto}
h1{color:#22D3EE} h1 span{color:#A3E635}
.score{font-size:40px;color:#A3E635}
.k{color:#F59E0B}
.file{border:1px solid #1f2430;border-radius:10px;margin:10px 0;background:#0b0d14}
summary{cursor:pointer;padding:12px 14px;color:#22D3EE}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 14px 14px}
pre{white-space:pre-wrap;word-break:break-word;background:#06070B;border:1px solid #1f2430;border-radius:8px;padding:10px;max-height:340px;overflow:auto;color:#cbd5e1}
h3{color:#F59E0B;font-size:13px;margin:8px 0}
ul{padding-left:18px} li{margin:4px 0}
</style></head>
<body>
<h1>SEO Doctor <span>repair report</span></h1>
<p>Site: <span class="k">${escapeHtml(report.url)}</span><br>
Score before repair: <span class="score">${report.score}</span> / 100</p>
<p>Fixed: <span class="k">${result.fixed.length}</span> · Skipped / manual: <span class="k">${result.skipped.length}</span> · Files changed: <span class="k">${result.diff.length}</span></p>
<h2>Fixed</h2><ul>${result.fixed.map(f => `<li><code>${escapeHtml(f.rule)}</code> — ${escapeHtml(f.title || '')} <small>(${escapeHtml(f.page || '')})</small></li>`).join('') || '<li>none</li>'}</ul>
<h2>Skipped / manual recommendations</h2><ul>${result.skipped.map(f => `<li><code>${escapeHtml(f.rule)}</code> — ${escapeHtml(f.note || '')} <small>(${escapeHtml(f.page || '')})</small></li>`).join('') || '<li>none</li>'}</ul>
<h2>Diffs</h2>
${rows || '<p>No files changed.</p>'}
<hr style="border-color:#1f2430"><p>Built by the ZN DEVELOPER team — CEO Zain Hanif — <a style="color:#22D3EE" href="https://github.com/ZainHanif-3">GitHub</a></p>
</body></html>`;
}

async function uploadLive(mirrorDir, changedFiles, creds) {
  const client = new ftpClient.Client();
  client.ftp.verbose = false;
  const base = String(creds.path || '').replace(/^\/+|\/+$/g, '');
  const uploaded = [];
  try {
    await client.access({
      host: creds.host,
      user: creds.user,
      password: creds.password,
      port: Number(creds.port) || 21,
      secure: !!creds.secure
    });
    await client.ensureDir('/');
    for (const f of changedFiles) {
      const parts = f.rel.split('/');
      const name = parts.pop();
      const remoteDir = [base, ...parts].filter(Boolean).join('/');
      if (remoteDir) await client.ensureDir(remoteDir);
      await client.uploadFrom(f.abs, name);
      uploaded.push('/' + [remoteDir, name].filter(Boolean).join('/'));
    }
  } finally {
    client.close();
  }
  return uploaded;
}

async function optimize(report, opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mirror';
  const started = Date.now();

  if (mode === 'live') {
    if (opts.confirm !== true) {
      throw httpError(400, 'Live mode requires confirm:true — type the confirmation to proceed.');
    }
    if (opts.permission !== true) {
      throw httpError(400, 'Live mode requires the "I have permission to edit this site" checkbox (permission:true).');
    }
    const c = opts.creds || {};
    if (!c.host || !c.user || !c.password) {
      throw httpError(400, 'Live mode requires FTP/SFTP credentials: host, user, password (port/path optional).');
    }
  }

  try {
    return await runOptimize(report, opts, mode, started);
  } finally {
    if (opts.creds) {
      for (const k of Object.keys(opts.creds)) opts.creds[k] = null;
      try { delete opts.creds.password; } catch { /* ignore */ }
      opts.creds = null;
    }
  }
}

async function runOptimize(report, opts, mode, started) {
  const siteName = opts.siteName || report.siteName || deriveSiteName(report.host);
  const lang = opts.lang || report.lang || 'en';
  const hostDir = String(report.host || 'site').replace(/[^a-z0-9.\-_]/gi, '_');
  const mirrorDir = path.join(SITES_DIR, hostDir);

  fs.rmSync(mirrorDir, { recursive: true, force: true });
  fs.mkdirSync(mirrorDir, { recursive: true });

  const selected = Array.isArray(opts.selected) && opts.selected.length
    ? new Set(opts.selected.map(String))
    : null;

  const chosen = report.issues.filter(i => i.fixable && i.autoFixable && (!selected || selected.has(i.id)));
  const fixed = [];
  const skipped = [];

  for (const i of report.issues) {
    if (selected) {
      if (selected.has(i.id) && !chosen.includes(i)) {
        skipped.push({
          id: i.id, rule: i.rule, page: i.page, fixed: false,
          note: i.fixable ? 'not auto-repairable — manual fix required' : 'manual recommendation — see advice'
        });
      }
    } else if (!i.autoFixable) {
      skipped.push({
        id: i.id, rule: i.rule, page: i.page, fixed: false,
        note: i.fixable ? 'manual fix required' : 'manual recommendation',
        advice: i.advice || ''
      });
    }
  }

  const { dims } = await downloadAssets(report, mirrorDir);

  const pageRules = new Map();
  for (const issue of chosen) {
    if (SITE_RULES.has(issue.rule)) continue;
    for (const p of issue.pages || []) {
      if (!pageRules.has(p)) pageRules.set(p, new Set());
      pageRules.get(p).add(issue.rule);
    }
  }

  const shared = { siteName, lang, dims };
  const diffs = [];
  const changedFiles = [];
  const appliedByPage = new Map();
  const recordsByPage = new Map();
  const faviconApplied = [];

  for (const page of report.pages) {
    if (!page.html || !page.parsed) continue;
    const url = page.finalUrl || page.url;
    const rel = mirrorRelPath(page.url);
    const abs = path.join(mirrorDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    let html = page.html;
    const rules = pageRules.get(url) || pageRules.get(page.url);

    if (rules && rules.size) {
      const ctx = buildPageContext(report, page, shared);
      const res = applyPageFixes(html, ctx, Array.from(rules));
      html = res.html;
      appliedByPage.set(url, res.applied);
      recordsByPage.set(url, ctx.record);
      if (res.applied.includes('favicon')) faviconApplied.push(url);
      if (res.changed) {
        diffs.push({
          file: rel,
          page: url,
          rules: res.applied,
          before: cap(page.html),
          after: cap(html)
        });
        changedFiles.push({ rel, abs });
      }
    }

    fs.writeFileSync(abs, html, 'utf8');
  }

  const sitemapUrl = report.origin + '/sitemap.xml';

  if (chosen.some(i => i.rule === 'robots-txt')) {
    if (!report.crawl.robots.exists) {
      const content = generateRobotsTxt({ origin: report.origin, siteName, sitemapUrl });
      const abs = path.join(mirrorDir, 'robots.txt');
      fs.writeFileSync(abs, content, 'utf8');
      diffs.push({ file: 'robots.txt', page: report.origin + '/robots.txt', rules: ['robots-txt'], before: '(missing)', after: content });
      changedFiles.push({ rel: 'robots.txt', abs });
    } else {
      const augmented = augmentRobotsTxt(report.crawl.robots.text, sitemapUrl);
      if (augmented) {
        const abs = path.join(mirrorDir, 'robots.txt');
        fs.writeFileSync(abs, augmented, 'utf8');
        diffs.push({ file: 'robots.txt', page: report.origin + '/robots.txt', rules: ['robots-txt'], before: report.crawl.robots.text, after: augmented });
        changedFiles.push({ rel: 'robots.txt', abs });
      }
    }
  }

  if (chosen.some(i => i.rule === 'sitemap-xml')) {
    const entries = sitemapEntriesFor({ startUrl: report.url, pages: report.pages });
    const content = generateSitemapXml(entries);
    const abs = path.join(mirrorDir, 'sitemap.xml');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    diffs.push({ file: 'sitemap.xml', page: sitemapUrl, rules: ['sitemap-xml'], before: '(missing)', after: content });
    changedFiles.push({ rel: 'sitemap.xml', abs });
  }

  if (faviconApplied.length && chosen.some(i => i.rule === 'favicon')) {
    const content = generateFaviconSvg(siteName);
    const abs = path.join(mirrorDir, 'favicon.svg');
    fs.writeFileSync(abs, content, 'utf8');
    diffs.push({ file: 'favicon.svg', page: report.origin + '/favicon.svg', rules: ['favicon'], before: '(missing)', after: content });
    changedFiles.push({ rel: 'favicon.svg', abs });
  }

  for (const issue of chosen) {
    if (SITE_RULES.has(issue.rule)) {
      const wrote = diffs.some(d => (d.rules || []).includes(issue.rule));
      if (wrote) {
        fixed.push({
          id: issue.id, rule: issue.rule, title: issue.title, page: issue.page,
          files: diffs.filter(d => (d.rules || []).includes(issue.rule)).map(d => d.file)
        });
      } else {
        skipped.push({ id: issue.id, rule: issue.rule, page: issue.page, fixed: false, note: 'already present — no change needed' });
      }
      continue;
    }

    const pagesTried = (issue.pages || []).filter(p => pageRules.get(p) && pageRules.get(p).has(issue.rule));
    const appliedOn = pagesTried.filter(p => (appliedByPage.get(p) || []).includes(issue.rule));

    if (!appliedOn.length) {
      skipped.push({ id: issue.id, rule: issue.rule, page: issue.page, fixed: false, note: 'already correct — no change needed' });
      continue;
    }

    const items = [];
    const reviewNotes = [];
    for (const p of appliedOn) {
      for (const r of (recordsByPage.get(p) || [])) {
        if (r.rule !== issue.rule) continue;
        if (r.fixed) items.push(r.item || r.detail || 'fixed');
        else if (r.note === 'review needed') reviewNotes.push({ page: p, item: r.item });
        else reviewNotes.push({ page: p, item: r.note || 'not applied' });
      }
    }

    fixed.push({
      id: issue.id,
      rule: issue.rule,
      title: issue.title,
      page: issue.page,
      pages: appliedOn,
      files: appliedOn.map(p => diffs.find(d => d.page === p)).filter(Boolean).map(d => d.file),
      items: items.slice(0, 12)
    });

    for (const rn of reviewNotes) {
      skipped.push({
        id: issue.id, rule: issue.rule, page: rn.page, fixed: false,
        note: 'review needed', item: rn.item
      });
    }
  }

  const result = {
    mode,
    fixed,
    skipped,
    diff: diffs,
    diffs,
    changedFiles: diffs.length,
    stats: { fixed: fixed.length, skipped: skipped.length, filesChanged: diffs.length },
    durationMs: Date.now() - started
  };

  const diffHtml = buildDiffReportHtml(report, result);
  const diffAbs = path.join(mirrorDir, 'SEO-DOCTOR-DIFF.html');
  fs.writeFileSync(diffAbs, diffHtml, 'utf8');
  result.diffReport = 'SEO-DOCTOR-DIFF.html';

  if (mode === 'mirror') {
    const zipPath = path.join(ZIPS_DIR, `${report.id}.zip`);
    await zipDirectory(mirrorDir, zipPath);
    result.zipUrl = `/api/download/${report.id}`;
    result.zipBytes = fs.statSync(zipPath).size;
    result.mirror = `sites/${hostDir}`;
  } else {
    const uploaded = await uploadLive(mirrorDir, changedFiles, opts.creds || {});
    result.uploaded = uploaded;
    result.live = { ok: true, uploaded, host: (opts.creds && opts.creds.host) || '' };
    result.zipUrl = `/api/download/${report.id}`;
    result.mirror = `sites/${hostDir}`;
  }

  report.optimizedAt = new Date().toISOString();
  report.lastResult = { mode, fixed: fixed.length, skipped: skipped.length, filesChanged: diffs.length };
  store.add(report);

  return result;
}

module.exports = { optimize, httpError, SITES_DIR };
