'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  report: null,
  analyzing: false,
  optimizing: false,
  progressTimer: null,
  progressPct: 0
};

const el = {
  form: $('#scan-form'),
  url: $('#url-input'),
  siteName: $('#site-name-input'),
  lang: $('#lang-input'),
  analyzeBtn: $('#analyze-btn'),
  progress: $('#progress'),
  stage: $('#progress-stage'),
  pct: $('#progress-pct'),
  bar: $('#progress-bar'),
  error: $('#error-box'),
  report: $('#report'),
  issuesPanel: $('#issues-panel'),
  repair: $('#repair'),
  results: $('#results'),
  gaugeArc: $('#gauge-arc'),
  gaugeArcGeo: $('#gauge-arc-geo'),
  scoreNum: $('#score-num'),
  geoScoreNum: $('#geo-score-num'),
  overallScore: $('#overall-score'),
  targetBadge: $('#target-badge'),
  projection: $('#projection'),
  reportMeta: $('#report-meta'),
  scoreFacts: $('#score-facts'),
  groups: $('#issue-groups'),
  selectAll: $('#select-all'),
  optimizeBtn: $('#optimize-btn'),
  improveBtn: $('#improve-btn'),
  optimizeCount: $('#optimize-count'),
  livePanel: $('#live-panel'),
  mirrorCard: $('#mode-mirror-card'),
  liveCard: $('#mode-live-card'),
  resultStats: $('#result-stats'),
  scoreDelta: $('#score-delta'),
  iterationBox: $('#iteration-box'),
  iterationCount: $('#iteration-count'),
  iterations: $('#iterations'),
  optimizeError: $('#optimize-error'),
  diffs: $('#diffs'),
  manualBox: $('#manual-box'),
  manualList: $('#manual-list'),
  manualCount: $('#manual-count'),
  downloadBtn: $('#download-btn'),
  permCheck: $('#permission-check')
};

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const GAUGE_C = 2 * Math.PI * 84;

/* ---------------------------------------------------------------- helpers */

function showError(node, msg) {
  if (!node) return;
  node.textContent = msg;
  node.hidden = !msg;
}

function normalizeUrlInput(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  return 'https://' + s.replace(/^\/+/, '');
}

function shortUrl(u, max = 64) {
  if (!u) return '';
  let s = String(u);
  try {
    const url = new URL(s);
    s = url.pathname === '/' ? url.host : url.host + url.pathname;
  } catch { /* keep raw */ }
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

function animateNumber(node, to, ms = 900) {
  if (!node) return;
  const from = Number(node.textContent) || 0;
  if (from === to) { node.textContent = String(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function gaugeColor(score) {
  return score >= 80 ? '#A3E635' : score >= 50 ? '#22D3EE' : score >= 30 ? '#F59E0B' : '#F43F5E';
}

function gaugeGlow(score) {
  return score >= 80 ? 'rgba(163,230,53,.6)' : score >= 50 ? 'rgba(34,211,238,.6)' : 'rgba(245,158,11,.6)';
}

function setGauge(node, score) {
  if (!node) return;
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  node.style.strokeDasharray = String(GAUGE_C);
  node.style.strokeDashoffset = String(GAUGE_C * (1 - clamped / 100));
  node.style.stroke = gaugeColor(clamped);
  node.style.filter = `drop-shadow(0 0 8px ${gaugeGlow(clamped)})`;
}

/* ------------------------------------------------------------- progress */

const STAGE_TEXT = [
  'Fetching robots.txt…',
  'Probing sitemap.xml + favicon…',
  'Crawling pages…',
  'Following internal links…',
  'Auditing meta tags…',
  'Auditing content, images & links…',
  'Auditing structured data & technical…',
  'Scoring report…'
];

function startProgress() {
  state.progressPct = 4;
  el.progress.hidden = false;
  el.bar.style.width = '4%';
  el.pct.textContent = '4%';
  el.stage.textContent = STAGE_TEXT[0];
  let tick = 0;
  state.progressTimer = setInterval(() => {
    tick += 1;
    const cap = 93;
    const inc = state.progressPct < 60 ? 7 : state.progressPct < 85 ? 3 : 1;
    state.progressPct = Math.min(cap, state.progressPct + inc);
    el.bar.style.width = state.progressPct + '%';
    el.pct.textContent = state.progressPct + '%';
    let stage = STAGE_TEXT[Math.min(STAGE_TEXT.length - 1, Math.floor(tick / 3))];
    if (stage.startsWith('Crawling')) {
      const seen = state.report ? state.report.pages : 0;
      const n = Math.min(30, 2 + Math.floor(tick * 1.7));
      stage = `Crawling pages… ${n}/30 pages${seen ? ` (${seen} found)` : ''}`;
    }
    el.stage.textContent = stage;
  }, 420);
}

function stopProgress(doneMsg) {
  if (state.progressTimer) clearInterval(state.progressTimer);
  state.progressTimer = null;
  state.progressPct = 100;
  el.bar.style.width = '100%';
  el.pct.textContent = '100%';
  el.stage.textContent = doneMsg || 'Done.';
  setTimeout(() => { el.progress.hidden = true; }, 1800);
}

/* -------------------------------------------------------------- analyze */

async function analyze(url) {
  state.analyzing = true;
  el.analyzeBtn.disabled = true;
  showError(el.error, '');
  startProgress();

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        siteName: el.siteName.value.trim() || undefined,
        lang: el.lang.value.trim() || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Analyze failed (HTTP ${res.status})`);

    state.report = data;
    stopProgress(`Audit complete — ${data.issues.length} issues across ${data.pages} pages.`);
    renderReport(data);
  } catch (e) {
    if (state.progressTimer) clearInterval(state.progressTimer);
    state.progressTimer = null;
    el.progress.hidden = true;
    showError(el.error, e.message || 'Analyze failed.');
  } finally {
    state.analyzing = false;
    el.analyzeBtn.disabled = false;
  }
}

function renderTargetBadge(overall, projection) {
  if (!el.targetBadge) return;
  const projected = projection && typeof projection.overall === 'number' ? projection.overall : null;
  el.targetBadge.hidden = false;
  if (overall >= 90) {
    el.targetBadge.textContent = 'target met ≥90';
    el.targetBadge.className = 'target-badge ok';
  } else if (projected != null && projected >= 90) {
    el.targetBadge.textContent = `projected ${projected} after repair`;
    el.targetBadge.className = 'target-badge near';
  } else if (projected != null) {
    el.targetBadge.textContent = `ceiling ~${projected} · manual fixes needed`;
    el.targetBadge.className = 'target-badge blocked';
  } else {
    el.targetBadge.hidden = true;
  }
}

function renderProjection(data) {
  if (!el.projection) return;
  const p = data.projection;
  if (!p || typeof p.overall !== 'number') {
    el.projection.textContent = '';
    return;
  }
  const blockers = (p.blockers || []).length;
  el.projection.innerHTML = '';
  const strong = document.createElement('b');
  strong.textContent = `Projected after auto-repair: ${p.overall}/100`;
  el.projection.appendChild(strong);
  el.projection.appendChild(document.createTextNode(
    ` (SEO ${p.seo} · GEO ${p.geo})` + (blockers ? ` · ${blockers} item(s) still need a human.` : ' · nothing manual blocking.')
  ));
}

function renderReport(data) {
  el.report.hidden = false;
  el.issuesPanel.hidden = false;
  el.repair.hidden = false;
  el.results.hidden = true;
  el.scoreDelta.hidden = true;
  el.iterationBox.hidden = true;

  const seo = data.seoScore != null ? data.seoScore : data.score;
  const geo = data.geoScore != null ? data.geoScore : 0;
  const overall = data.overall != null ? data.overall : seo;

  setGauge(el.gaugeArc, seo);
  setGauge(el.gaugeArcGeo, geo);
  animateNumber(el.scoreNum, seo);
  animateNumber(el.geoScoreNum, geo);
  animateNumber(el.overallScore, overall);
  renderTargetBadge(overall, data.projection);
  renderProjection(data);

  $('#c-critical').textContent = data.counts.critical;
  $('#c-high').textContent = data.counts.high;
  $('#c-medium').textContent = data.counts.medium;
  $('#c-low').textContent = data.counts.low;

  const fixable = data.issues.filter(i => i.autoFixable).length;
  el.reportMeta.textContent = `${shortUrl(data.url)} · ${data.pages} pages · ${data.durationMs} ms`;
  el.scoreFacts.innerHTML = '';
  const facts = [
    ['URL', shortUrl(data.url, 40)],
    ['Pages crawled', String(data.pages)],
    ['SEO score', String(seo)],
    ['GEO score', String(geo)],
    ['Issues found', String(data.issues.length)],
    ['Auto-repairable', String(fixable)],
    ['Crawl time', (data.durationMs / 1000).toFixed(1) + ' s'],
    ['Report id', data.id]
  ];
  for (const [k, v] of facts) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = v;
    li.appendChild(b);
    li.appendChild(document.createTextNode(k));
    el.scoreFacts.appendChild(li);
  }

  renderIssues(data.issues);
  updateOptimizeCount();

  el.report.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* --------------------------------------------------------------- issues */

function buildIssueRow(issue, severity) {
  const row = document.createElement('div');
  row.className = 'issue-row';
  row.dataset.id = issue.id;
  if (issue.fixed) row.classList.add('is-done');

  // checkbox
  const chkCell = document.createElement('div');
  chkCell.className = 'fix-check';
  if (issue.fixable) {
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!issue.autoFixable;
    chk.disabled = !!issue.fixed;
    chk.id = 'chk-' + issue.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    chk.setAttribute('aria-label', 'Select for repair: ' + issue.title);
    chk.addEventListener('change', updateOptimizeCount);
    chkCell.appendChild(chk);
  }
  row.appendChild(chkCell);

  // severity
  const sevCell = document.createElement('div');
  sevCell.className = 'sev-cell';
  const sev = document.createElement('span');
  sev.className = 'sev ' + severity;
  sev.textContent = severity;
  sevCell.appendChild(sev);
  row.appendChild(sevCell);

  // title + category
  const titleCell = document.createElement('div');
  titleCell.className = 'issue-title-cell';
  const title = document.createElement('span');
  title.className = 'issue-title';
  title.textContent = issue.title;
  const cat = document.createElement('span');
  cat.className = 'issue-cat';
  cat.textContent = issue.category + ' · ' + issue.rule + (issue.fixable ? (issue.autoFixable ? ' · auto' : ' · manual') : ' · advice');
  titleCell.appendChild(title);
  titleCell.appendChild(cat);
  row.appendChild(titleCell);

  // page
  const pageCell = document.createElement('div');
  pageCell.className = 'issue-page-cell';
  const page = document.createElement('span');
  page.className = 'issue-page';
  page.textContent = shortUrl(issue.page, 46);
  page.title = issue.page;
  pageCell.appendChild(page);
  row.appendChild(pageCell);

  // evidence
  const ev = document.createElement('span');
  ev.className = 'issue-ev';
  ev.textContent = issue.evidence || issue.message || '—';
  ev.title = issue.evidence || issue.message || '';
  row.appendChild(ev);

  // action
  const actions = document.createElement('div');
  actions.className = 'issue-actions';
  if (issue.fixable && issue.autoFixable && !issue.fixed) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-mini';
    btn.textContent = 'Repair';
    btn.addEventListener('click', () => runOptimize([issue.id], btn));
    actions.appendChild(btn);
  } else {
    const tag = document.createElement('span');
    tag.className = 'tag-manual';
    tag.textContent = issue.fixable ? 'manual' : 'advice';
    tag.title = issue.advice || '';
    actions.appendChild(tag);
  }
  row.appendChild(actions);

  return row;
}

function renderIssues(issues) {
  el.groups.innerHTML = '';
  for (const sev of SEV_ORDER) {
    const list = issues.filter(i => i.severity === sev);
    if (!list.length) continue;

    const group = document.createElement('div');
    group.className = 'issue-group';

    const head = document.createElement('h3');
    head.className = 'group-head';
    head.innerHTML = `<span class="sev ${sev}">${sev}</span> <span class="group-count">${list.length}</span>`;
    group.appendChild(head);

    const table = document.createElement('div');
    table.className = 'issue-table';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', sev + ' issues');

    const headRow = document.createElement('div');
    headRow.className = 'issue-head';
    ['✓', 'Severity', 'Problem', 'Page', 'Evidence', 'Fix'].forEach(h => {
      const c = document.createElement('span');
      c.textContent = h;
      headRow.appendChild(c);
    });
    table.appendChild(headRow);

    for (const issue of list) table.appendChild(buildIssueRow(issue, sev));
    group.appendChild(table);
    el.groups.appendChild(group);
  }
}

function selectedIssueIds() {
  const boxes = $$('#issue-groups .fix-check input[type="checkbox"]:checked:not(:disabled)');
  const ids = boxes
    .map(b => b.closest('.issue-row').dataset.id)
    .filter(Boolean);
  return ids;
}

function updateOptimizeCount() {
  const n = selectedIssueIds().length;
  const total = state.report ? state.report.issues.filter(i => i.autoFixable && !i.fixed).length : 0;
  el.optimizeCount.textContent = n ? `(${n} selected)` : total ? `(all ${total} repairable)` : '';
}

/* -------------------------------------------------------------- optimize */

function currentMode() {
  const checked = $('input[name="mode"]:checked');
  return checked ? checked.value : 'mirror';
}

function syncModeUI() {
  const live = currentMode() === 'live';
  el.mirrorCard.classList.toggle('active', !live);
  el.liveCard.classList.toggle('active', live);
  el.livePanel.hidden = !live;
}

function collectCreds() {
  const port = $('#ftp-port').value.trim();
  const pathv = $('#ftp-path').value.trim();
  return {
    host: $('#ftp-host').value.trim(),
    user: $('#ftp-user').value.trim(),
    password: $('#ftp-pass').value,
    ...(port ? { port } : {}),
    ...(pathv ? { path: pathv } : {})
  };
}

async function runOptimize(ids, sourceBtn, opts = {}) {
  if (state.optimizing || !state.report) return;
  const mode = currentMode();

  showError(el.optimizeError, '');
  if (mode === 'live' && !el.permCheck.checked) {
    showError(el.optimizeError, 'Live mode: tick "I have permission to edit this site" first.');
    return;
  }

  state.optimizing = true;
  const btn = sourceBtn || el.optimizeBtn;
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = opts.endpoint === '/api/improve' ? 'Improving…' : 'Optimizing…';
  el.optimizeBtn.disabled = true;
  el.improveBtn.disabled = true;

  try {
    const payload = {
      reportId: state.report.id,
      mode,
      siteName: el.siteName.value.trim() || undefined,
      lang: el.lang.value.trim() || undefined,
      ...(opts.extra || {})
    };
    if (ids && ids.length) payload.selected = ids;
    if (mode === 'live') {
      payload.confirm = true;
      payload.permission = el.permCheck.checked === true;
      payload.creds = collectCreds();
    }

    const endpoint = opts.endpoint || (mode === 'live' ? '/api/optimize/live' : '/api/optimize');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Optimize failed (HTTP ${res.status})`);

    renderResults(data, ids);
    if (ids && ids.length === 1) {
      const row = el.groups.querySelector(`.issue-row[data-id="${cssEscape(ids[0])}"]`);
      if (row) row.classList.add('is-done');
    } else {
      $$('#issue-groups .issue-row').forEach(r => r.classList.add('is-done'));
      $$('#issue-groups .fix-check input').forEach(c => { c.disabled = true; c.checked = false; });
    }
    updateOptimizeCount();
    el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(el.optimizeError, e.message || 'Optimize failed.');
    el.results.hidden = false;
  } finally {
    state.optimizing = false;
    btn.disabled = false;
    btn.textContent = prevText;
    el.optimizeBtn.disabled = false;
    el.improveBtn.disabled = false;
    updateOptimizeCount();
  }
}

function runImprove() {
  return runOptimize(null, el.improveBtn, {
    endpoint: '/api/improve',
    extra: { maxIterations: 6, target: 90 }
  });
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}

function renderScoreDelta(data) {
  const before = data.scores && data.scores.before;
  const after = data.scores && data.scores.after;
  if (!before || !after || typeof after.overall !== 'number') {
    el.scoreDelta.hidden = true;
    return;
  }
  el.scoreDelta.hidden = false;
  el.scoreDelta.innerHTML = '';

  const rows = [
    ['SEO', before.seo, after.seo],
    ['GEO', before.geo, after.geo],
    ['Overall', before.overall, after.overall]
  ];

  for (const [label, b, a] of rows) {
    const cell = document.createElement('div');
    cell.className = 'delta-cell' + (label === 'Overall' ? ' overall' : '');

    const name = document.createElement('span');
    name.className = 'delta-name';
    name.textContent = label;

    const val = document.createElement('span');
    val.className = 'delta-val';
    val.textContent = `${b == null ? '—' : b} → `;

    const strong = document.createElement('b');
    strong.textContent = a == null ? '—' : String(a);

    const diff = document.createElement('span');
    const d = (typeof a === 'number' && typeof b === 'number') ? a - b : null;
    diff.className = 'delta-diff ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
    diff.textContent = d == null ? '' : (d > 0 ? `+${d}` : String(d));

    val.appendChild(strong);
    cell.appendChild(name);
    cell.appendChild(val);
    cell.appendChild(diff);
    el.scoreDelta.appendChild(cell);
  }

  if (data.reachedTarget) {
    const ok = document.createElement('span');
    ok.className = 'target-hit';
    ok.textContent = `target ${data.target} reached`;
    el.scoreDelta.appendChild(ok);
  }

  // Keep the header gauges in sync with the repaired score.
  if (state.report) {
    state.report.seoScore = after.seo;
    state.report.geoScore = after.geo;
    state.report.overall = after.overall;
    setGauge(el.gaugeArc, after.seo);
    setGauge(el.gaugeArcGeo, after.geo);
    animateNumber(el.scoreNum, after.seo);
    animateNumber(el.geoScoreNum, after.geo);
    animateNumber(el.overallScore, after.overall);
    renderTargetBadge(after.overall, null);
  }
}

function renderIterations(data) {
  const list = data.iterations || [];
  if (list.length < 2) {
    el.iterationBox.hidden = true;
    return;
  }
  el.iterationBox.hidden = false;
  el.iterationCount.textContent = `(${list.length} passes)`;
  el.iterations.innerHTML = '';

  const table = document.createElement('div');
  table.className = 'iter-table';
  const head = document.createElement('div');
  head.className = 'iter-row iter-head';
  ['Pass', 'SEO', 'GEO', 'Overall', 'Issues left', 'Changed'].forEach(h => {
    const c = document.createElement('span');
    c.textContent = h;
    head.appendChild(c);
  });
  table.appendChild(head);

  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'iter-row';
    const cells = [
      `#${it.iteration}`,
      String(it.seo),
      String(it.geo),
      String(it.overall),
      String(it.issues),
      it.iteration === 1 ? '—' : `${it.changedPages || 0} page(s)`
    ];
    cells.forEach((text, i) => {
      const c = document.createElement('span');
      c.textContent = text;
      if (i === 3) c.className = 'iter-overall';
      row.appendChild(c);
    });
    table.appendChild(row);
  }

  el.iterations.appendChild(table);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = data.remainingAutoFixable
    ? `${data.remainingAutoFixable} auto-repairable issue(s) remain — re-run Improve to try another pass.`
    : 'No auto-repairable issues remain. Anything left is listed under manual recommendations.';
  el.iterations.appendChild(note);
}

function renderResults(data, requestedIds) {
  el.results.hidden = false;
  el.optimizeError.hidden = true;

  const files = data.diff ? data.diff.length : 0;
  el.resultStats.innerHTML = '';
  const stats = [
    ['ok', String(data.stats ? data.stats.fixed : data.fixed.length), 'Fixed'],
    ['skip', String(data.stats ? data.stats.skipped : data.skipped.length), 'Skipped / manual'],
    ['files', String(files), 'Files changed'],
    ['time', ((data.durationMs || 0) / 1000).toFixed(1) + 's', 'Repair time']
  ];
  for (const [cls, value, label] of stats) {
    const div = document.createElement('div');
    div.className = 'stat ' + cls;
    const b = document.createElement('b');
    b.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    div.appendChild(b);
    div.appendChild(span);
    el.resultStats.appendChild(div);
  }

  if (data.mode === 'live' && data.uploaded) {
    const div = document.createElement('div');
    div.className = 'stat files';
    const b = document.createElement('b');
    b.textContent = String(data.uploaded.length);
    const span = document.createElement('span');
    span.textContent = 'Uploaded via FTP';
    div.appendChild(b);
    div.appendChild(span);
    el.resultStats.appendChild(div);
  }

  // download
  if (data.zipUrl) {
    el.downloadBtn.hidden = false;
    el.downloadBtn.href = data.zipUrl;
  } else {
    el.downloadBtn.hidden = true;
  }

  renderScoreDelta(data);
  renderIterations(data);

  // diffs
  el.diffs.innerHTML = '';
  if (!files) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No files needed changing — the selected issues were already satisfied.';
    el.diffs.appendChild(p);
  }
  for (const d of (data.diff || [])) {
    const det = document.createElement('details');
    det.className = 'diff-file';

    const sum = document.createElement('summary');
    const code = document.createElement('code');
    code.textContent = d.file;
    const rules = document.createElement('span');
    rules.className = 'diff-rules';
    rules.textContent = (d.rules || []).join(', ');
    sum.appendChild(code);
    sum.appendChild(rules);
    det.appendChild(sum);

    const cols = document.createElement('div');
    cols.className = 'diff-cols';

    const before = document.createElement('div');
    before.className = 'diff-col before';
    before.innerHTML = '<h4>Before</h4>';
    const preB = document.createElement('pre');
    preB.textContent = d.before;
    before.appendChild(preB);

    const after = document.createElement('div');
    after.className = 'diff-col after';
    after.innerHTML = '<h4>After</h4>';
    const preA = document.createElement('pre');
    preA.textContent = d.after;
    after.appendChild(preA);

    cols.appendChild(before);
    cols.appendChild(after);
    det.appendChild(cols);
    el.diffs.appendChild(det);
  }

  // manual recommendations
  const manual = (data.skipped || []).filter(s => /manual|advice|review/.test(s.note || ''));
  el.manualCount.textContent = `(${(data.skipped || []).filter(s => !/already correct/.test(s.note || '')).length} entries)`;
  el.manualList.innerHTML = '';
  if (manual.length) {
    el.manualBox.hidden = false;
    for (const m of manual) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = (m.note || 'manual') + ' — ';
      li.appendChild(b);
      li.appendChild(document.createTextNode(m.advice || m.item || m.rule));
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = shortUrl(m.page, 70);
      li.appendChild(where);
      el.manualList.appendChild(li);
    }
  } else {
    el.manualBox.hidden = true;
  }
}

/* ----------------------------------------------------------------- init */

function init() {
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.analyzing) return;
    const raw = el.url.value;
    if (!raw.trim()) {
      showError(el.error, 'Enter a URL to analyze.');
      el.url.focus();
      return;
    }
    const url = normalizeUrlInput(raw);
    el.url.value = url;
    analyze(url);
  });

  el.optimizeBtn.addEventListener('click', () => runOptimize(null, el.optimizeBtn));
  el.improveBtn.addEventListener('click', runImprove);

  el.selectAll.addEventListener('change', () => {
    $$('#issue-groups .fix-check input:not(:disabled)').forEach(c => {
      c.checked = el.selectAll.checked;
    });
    updateOptimizeCount();
  });

  $$('input[name="mode"]').forEach(r => r.addEventListener('change', syncModeUI));
  syncModeUI();

  el.downloadBtn.addEventListener('click', (e) => {
    if (el.downloadBtn.getAttribute('href') === '#') e.preventDefault();
  });
}

document.addEventListener('DOMContentLoaded', init);
