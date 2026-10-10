'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const MAX_REPORTS = 20;

const reports = new Map();

function load() {
  try {
    if (!fs.existsSync(REPORTS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      for (const r of raw) if (r && r.id) reports.set(r.id, r);
    }
  } catch (e) {
    console.warn('[store] could not read reports.json:', e.message);
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const list = Array.from(reports.values())
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, MAX_REPORTS);
    reports.clear();
    for (const r of list) reports.set(r.id, r);
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(list));
  } catch (e) {
    console.warn('[store] could not write reports.json:', e.message);
  }
}

function add(report) {
  reports.set(report.id, report);
  persist();
  return report;
}

function get(id) {
  return reports.get(id) || null;
}

function list() {
  return Array.from(reports.values())
    .map(r => ({
      id: r.id, url: r.url, score: r.score, counts: r.counts,
      createdAt: r.createdAt, durationMs: r.durationMs, pages: r.pages ? r.pages.length : 0
    }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function stats() {
  const all = Array.from(reports.values());
  const scores = all.map(r => r.score).filter(n => typeof n === 'number');
  return {
    reports: all.length,
    issues: all.reduce((n, r) => n + (r.issues ? r.issues.length : 0), 0),
    averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    optimized: all.filter(r => r.optimizedAt).length,
    recent: list().slice(0, 5)
  };
}

load();

module.exports = { add, get, list, stats, persist };
