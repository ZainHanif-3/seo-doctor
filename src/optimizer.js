'use strict';

const fs = require('fs');
const path = require('path');
const { imageSize } = require('image-size');
const ftpClient = require('basic-ftp');

const { isSameSite, mirrorRelPath, escapeHtml, deriveSiteName, titleCase } = require('./util');
const { fetchWithTimeout, parseRobots } = require('./crawler');
const { parsePage } = require('./parse');
const { runAudit } = require('./audit');
const {
  applyPageFixes, generateRobotsTxt, augmentRobotsTxt,
  generateSitemapXml, sitemapEntriesFor, generateFaviconSvg,
  generateLlmsTxt, augmentRobotsForAi
} = require('./fixers');
const { zipDirectory } = require('./zip');
const store = require('./store');

const ROOT = path.join(__dirname, '..');
const SITES_DIR = path.join(ROOT, 'sites');
const ZIPS_DIR = path.join(ROOT, 'data', 'zips');
const SITE_RULES = new Set(['robots-txt', 'sitemap-xml', 'geo-llms-txt', 'geo-ai-crawlers']);
const DIFF_CAP = 12000;
const MAX_ASSETS = 100;
const ASSET_TIMEOUT = 6000;
const ASSET_MAX_BYTES = 4 * 1024 * 1024;

const DEFAULT_MAX_ITERATIONS = 4;
const DEFAULT_TARGET = 90;

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

  return {
    url,
    startUrl: report.url,
    origin: report.origin,
    host: report.host,
    siteName: shared.siteName,
    lang: shared.lang,
    pageKey: pathSuffixFor(url),
    pathSuffix: pathSuffixFor(url),
    authorName: shared.authorName || '',

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
}

// ---------------------------------------------------------------------------
// Iterative engine
// ---------------------------------------------------------------------------

function initialState(report) {
  return {
    pages: (report.pages || []).map(p => ({ ...p })),
    robots: {
      exists: !!(report.crawl.robots && report.crawl.robots.exists),
      status: report.crawl.robots ? report.crawl.robots.status : 0,
      text: (report.crawl.robots && report.crawl.robots.text) || '',
      parsed: (report.crawl.robots && report.crawl.robots.parsed)
        || parseRobots((report.crawl.robots && report.crawl.robots.text) || '')
    },
    sitemap: {
      exists: !!(report.crawl.sitemap && report.crawl.sitemap.exists),
      status: report.crawl.sitemap ? report.crawl.sitemap.status : 0
    },
    llms: {
      exists: !!(report.crawl.llms && report.crawl.llms.exists),
      status: report.crawl.llms ? report.crawl.llms.status : 0,
      text: (report.crawl.llms && report.crawl.llms.text) || ''
    },
    favicon: report.crawl.favicon || { status: 0 },
    canary: report.crawl.canary || { status: 404, body: 'Not Found' }
  };
}

function syntheticCrawl(state, report) {
  return {
    startUrl: report.url,
    origin: report.origin,
    host: report.host,
    siteKey: report.host,
    robots: state.robots,
    favicon: state.favicon,
    canary: state.canary,
    llms: state.llms,
    sitemap: state.sitemap,
    pages: state.pages,
    blockedPaths: [],
    assets: report.crawl.assets || [],
    linkStatus: {},
    limits: report.crawl.limits || {},
    truncated: false,
    stopReason: null
  };
}

function applySiteFixes(state, chosen, report, siteName) {
  const rules = new Set(chosen.map(i => i.rule));
  const origin = report.origin;
  const sitemapUrl = origin + '/sitemap.xml';
  const written = [];

  if (rules.has('robots-txt') || rules.has('geo-ai-crawlers')) {
    let text = state.robots.exists && state.robots.text
      ? state.robots.text
      : generateRobotsTxt({ origin, siteName, sitemapUrl });

    if (!state.sitemap.exists && !rules.has('sitemap-xml')) {
      // keep the sitemap line pointing at a file we are not generating
    }
    const withAi = augmentRobotsForAi(text);
    if (withAi) {
      state.robots.text = withAi;
    } else if (!state.robots.exists) {
      state.robots.text = text;
    }
    state.robots.exists = true;
    state.robots.parsed = parseRobots(state.robots.text);
    written.push('robots.txt');
  }

  if (rules.has('sitemap-xml')) {
    const entries = sitemapEntriesFor({ startUrl: report.url, pages: state.pages });
    state.sitemap.text = generateSitemapXml(entries);
    state.sitemap.exists = true;
    written.push('sitemap.xml');
  }

  if (rules.has('geo-llms-txt')) {
    const home = state.pages.find(p => {
      try { return new URL(p.finalUrl || p.url).pathname === '/'; } catch { return false; }
    }) || state.pages[0];
    const description = (home && home.parsed && home.parsed.description) || '';
    state.llms.text = generateLlmsTxt({
      siteName,
      origin,
      description,
      pages: state.pages
    });
    state.llms.exists = true;
    written.push('llms.txt');
  }

  return written;
}

function applyPageIteration(state, report, chosen, shared) {
  const pageRules = new Map();
  for (const issue of chosen) {
    if (SITE_RULES.has(issue.rule)) continue;
    for (const p of issue.pages || []) {
      if (!pageRules.has(p)) pageRules.set(p, new Set());
      pageRules.get(p).add(issue.rule);
    }
  }

  let changedPages = 0;
  const applied = [];

  for (const page of state.pages) {
    if (!page.html || !page.parsed) continue;
    const url = page.finalUrl || page.url;
    const rules = pageRules.get(url);
    if (!rules || !rules.size) continue;

    const pseudo = { ...report, issues: report.issues, pages: state.pages };
    const ctx = buildPageContext(pseudo, page, shared);
    const res = applyPageFixes(page.html, ctx, Array.from(rules));
    if (res.applied.length) applied.push({ url, rules: res.applied });
    if (res.changed) {
      page.html = res.html;
      try { page.parsed = parsePage(res.html, url); } catch { /* keep old parse */ }
      changedPages += 1;
    }
  }

  return { changedPages, applied };
}

/**
 * Run the audit → repair → re-audit loop until the target is reached, the
 * score stops improving, or the iteration cap is hit.
 */
function runLoop(report, opts = {}) {
  const siteName = opts.siteName || report.siteName || deriveSiteName(report.host);
  const lang = opts.lang || report.lang || 'en';
  const maxIterations = Math.max(1, Number(opts.maxIterations) || DEFAULT_MAX_ITERATIONS);
  const target = Number(opts.target) || DEFAULT_TARGET;

  const state = initialState(report);
  const shared = { siteName, lang, dims: opts.dims || {}, authorName: opts.authorName || '' };
  const history = [];
  let previous = null;
  let finalAudit = null;

  for (let i = 1; i <= maxIterations; i++) {
    const crawl = syntheticCrawl(state, report);
    const audit = runAudit(crawl, { siteName, lang });
    finalAudit = audit;

    history.push({
      iteration: i,
      seo: audit.seoScore,
      geo: audit.geoScore,
      overall: audit.overall,
      issues: audit.issues.length,
      autoFixable: audit.issues.filter(x => x.autoFixable).length,
      changedPages: previous ? previous.changedPages : 0,
      siteFiles: previous ? previous.siteFiles : []
    });

    if (audit.overall >= target) break;

    const chosen = audit.issues.filter(x => x.autoFixable);
    if (!chosen.length) break;

    const pseudo = { ...report, issues: audit.issues };
    const siteFiles = applySiteFixes(state, chosen, report, siteName);
    const pageRes = applyPageIteration(state, pseudo, chosen, shared);

    const didChange = siteFiles.length > 0 || pageRes.changedPages > 0;
    if (!didChange) break;

    previous = { changedPages: pageRes.changedPages, siteFiles };
  }

  // Final audit reflects the repaired state exactly.
  const finalCrawl = syntheticCrawl(state, report);
  finalAudit = runAudit(finalCrawl, { siteName, lang });

  return {
    state,
    history,
    audit: finalAudit,
    reachedTarget: finalAudit.overall >= target,
    target
  };
}

// ---------------------------------------------------------------------------
// Mirror writing
// ---------------------------------------------------------------------------

function buildDiffReportHtml(report, result) {
  const rows = result.diff.map(d => `
    <details class="file">
      <summary><code>${escapeHtml(d.file)}</code> — ${d.rules ? d.rules.join(', ') : ''}</summary>
      <div class="cols">
        <div><h3>Before</h3><pre>${escapeHtml(d.before)}</pre></div>
        <div><h3>After</h3><pre>${escapeHtml(d.after)}</pre></div>
      </div>
    </details>`).join('\n');

  const before = result.scores && result.scores.before ? result.scores.before : {};
  const after = result.scores && result.scores.after ? result.scores.after : {};
  const delta = (a, b) => {
    if (typeof a !== 'number' || typeof b !== 'number') return '';
    const d = b - a;
    return `<small class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}</small>`;
  };

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
.up{color:#A3E635} .down{color:#F43F5E}
table{border-collapse:collapse;margin:10px 0} th,td{border:1px solid #1f2430;padding:6px 10px;text-align:left}
th{color:#22D3EE}
</style></head>
<body>
<h1>SEO Doctor <span>repair report</span></h1>
<p>Site: <span class="k">${escapeHtml(report.url)}</span></p>
<table>
<tr><th>Score</th><th>Before</th><th>After</th><th>Change</th></tr>
<tr><td>SEO</td><td>${before.seo ?? '—'}</td><td>${after.seo ?? '—'}</td><td>${delta(before.seo, after.seo)}</td></tr>
<tr><td>GEO</td><td>${before.geo ?? '—'}</td><td>${after.geo ?? '—'}</td><td>${delta(before.geo, after.geo)}</td></tr>
<tr><td><b>Overall</b></td><td><b>${before.overall ?? '—'}</b></td><td><b>${after.overall ?? '—'}</b></td><td>${delta(before.overall, after.overall)}</td></tr>
</table>
<p>Passes: <span class="k">${result.iterations ? result.iterations.length : 1}</span> · Fixed: <span class="k">${result.fixed.length}</span> · Still manual: <span class="k">${result.skipped.length}</span> · Files changed: <span class="k">${result.diff.length}</span></p>
<h2>Score by pass</h2>
<table><tr><th>Pass</th><th>SEO</th><th>GEO</th><th>Overall</th><th>Issues</th></tr>
${(result.iterations || []).map(it => `<tr><td>${it.iteration}</td><td>${it.seo}</td><td>${it.geo}</td><td>${it.overall}</td><td>${it.issues}</td></tr>`).join('')}
</table>
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

  // A single-rule "Repair" click must not run the whole loop.
  const maxIterations = selected ? 1 : (Number(opts.maxIterations) || DEFAULT_MAX_ITERATIONS);
  const target = selected ? 101 : (Number(opts.target) || DEFAULT_TARGET);

  const { dims } = await downloadAssets(report, mirrorDir);

  // Restrict the loop to the selected issues when the user picked a subset.
  const workingReport = selected
    ? { ...report, issues: report.issues.map(i => (selected.has(i.id) ? i : { ...i, autoFixable: false })) }
    : report;

  const loop = runLoop(workingReport, { siteName, lang, dims, maxIterations, target });
  const { state, history, audit } = loop;

  // ---- write pages ----
  const diffs = [];
  const changedFiles = [];
  const originalPages = new Map((report.pages || []).map(p => [p.finalUrl || p.url, p]));

  for (const page of state.pages) {
    if (!page.html || !page.parsed) continue;
    const url = page.finalUrl || page.url;
    const rel = mirrorRelPath(page.url);
    const abs = path.join(mirrorDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, page.html, 'utf8');

    const orig = originalPages.get(url);
    if (orig && orig.html && orig.html !== page.html) {
      diffs.push({
        file: rel,
        page: url,
        rules: rulesBetween(orig.html, page.html),
        before: cap(orig.html),
        after: cap(page.html)
      });
      changedFiles.push({ rel, abs });
    }
  }

  // ---- site-level files ----
  const siteFileSpecs = [
    { key: 'robots', rel: 'robots.txt', content: state.robots.exists ? state.robots.text : '', rule: 'robots-txt' },
    { key: 'sitemap', rel: 'sitemap.xml', content: state.sitemap.text, rule: 'sitemap-xml' },
    { key: 'llms', rel: 'llms.txt', content: state.llms.text, rule: 'geo-llms-txt' }
  ];

  for (const spec of siteFileSpecs) {
    if (!spec.content) continue;
    const abs = path.join(mirrorDir, spec.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existedBefore = spec.key === 'robots'
      ? !!(report.crawl.robots && report.crawl.robots.exists)
      : spec.key === 'sitemap'
        ? !!(report.crawl.sitemap && report.crawl.sitemap.exists)
        : !!(report.crawl.llms && report.crawl.llms.exists);
    const beforeText = spec.key === 'robots'
      ? (report.crawl.robots && report.crawl.robots.text) || ''
      : spec.key === 'llms'
        ? (report.crawl.llms && report.crawl.llms.text) || ''
        : '';
    if (existedBefore && beforeText === spec.content) continue;
    fs.writeFileSync(abs, spec.content, 'utf8');
    diffs.push({
      file: spec.rel,
      page: report.origin + '/' + spec.rel,
      rules: [spec.rule],
      before: existedBefore ? cap(beforeText || '(empty)') : '(missing)',
      after: cap(spec.content)
    });
    changedFiles.push({ rel: spec.rel, abs });
  }

  // favicon (existing behaviour)
  const needsFavicon = report.issues.some(i => i.rule === 'favicon' && i.autoFixable);
  if (needsFavicon && !report.crawl.favicon.ok) {
    const content = generateFaviconSvg(siteName);
    const abs = path.join(mirrorDir, 'favicon.svg');
    fs.writeFileSync(abs, content, 'utf8');
    diffs.push({ file: 'favicon.svg', page: report.origin + '/favicon.svg', rules: ['favicon'], before: '(missing)', after: content });
    changedFiles.push({ rel: 'favicon.svg', abs });
  }

  // ---- fixed / skipped summary ----
  const keyOf = (i) => `${i.rule}@${(i.pages && i.pages[0]) || i.page}`;
  const finalKeys = new Set(audit.issues.map(keyOf));
  const fixed = [];
  const skipped = [];

  for (const issue of report.issues) {
    if (selected && !selected.has(issue.id)) continue;
    const stillThere = finalKeys.has(keyOf(issue));
    if (!stillThere) {
      // Resolved — either by its own fixer or as a side effect of another repair.
      fixed.push({
        id: issue.id, rule: issue.rule, title: issue.title, page: issue.page,
        files: diffs.filter(d => d.file.endsWith('.html') && d.page === issue.page).map(d => d.file)
      });
    } else {
      skipped.push({
        id: issue.id, rule: issue.rule, page: issue.page, fixed: false,
        note: issue.autoFixable ? 'not resolvable automatically — manual edit required' : 'manual recommendation',
        advice: issue.advice || ''
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
    iterations: history,
    scores: {
      before: { seo: report.seoScore != null ? report.seoScore : report.score, geo: report.geoScore, overall: report.overall },
      after: { seo: audit.seoScore, geo: audit.geoScore, overall: audit.overall }
    },
    reachedTarget: loop.reachedTarget,
    target: loop.target,
    remainingAutoFixable: audit.issues.filter(i => i.autoFixable).length,
    stats: { fixed: fixed.length, skipped: skipped.length, filesChanged: diffs.length, passes: history.length },
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
  report.seoScore = audit.seoScore;
  report.geoScore = audit.geoScore;
  report.overall = audit.overall;
  store.add(report);

  return result;
}

/** Which rules plausibly touched a page, by diffing the two snapshots. */
function rulesBetween(before, after) {
  const rules = [];
  const has = (re, b, a) => {
    if (b.test(before) !== b.test(after)) rules.push(re);
  };
  if (!/<title>/i.test(before) || (before.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]
    !== (after.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]) rules.push('title');
  if (!/name=["']description["']/i.test(before)) rules.push('description');
  if (!/rel=["']canonical["']/i.test(before)) rules.push('canonical');
  if (!/<main[\s>]/i.test(before) && /<main[\s>]/i.test(after)) rules.push('geo-semantic');
  if (!/application\/ld\+json/i.test(before) && /application\/ld\+json/i.test(after)) rules.push('geo-schema-graph');
  if (!/og:title/i.test(before) && /og:title/i.test(after)) rules.push('og');
  if (!/loading=["']lazy["']/i.test(before) && /loading=["']lazy["']/i.test(after)) rules.push('lazy');
  if (!/name=["']viewport["']/i.test(before)) rules.push('viewport');
  has('charset', /charset/i, null);
  return Array.from(new Set(rules));
}

module.exports = { optimize, httpError, SITES_DIR, buildPageContext, runLoop };
