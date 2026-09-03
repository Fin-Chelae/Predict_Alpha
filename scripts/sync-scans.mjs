#!/usr/bin/env node
/* Sync data/scans.json from the forecast Reasoning Traces API.
 *
 * Replaces the old HTML scraper. The index endpoint is cheap (metadata only);
 * full traces are ~500 KB each, so rationales are fetched on demand, only for
 * scans we don't have yet, capped per run.
 *
 * Token: TRACES_TOKEN env var, or a git-ignored `.traces-token` file next to
 * the project root. The token never belongs in the page or the repo — in CI
 * it comes from a GitHub Actions secret.
 *
 * Output shape is exactly what the page already reads:
 *   { "<market title>": [ {id, scanned_at, date, agent, market_price_t0,
 *                          edge, confidence, category, rationale, url}, … ] }
 * plus a "_meta" key (ignored by the page: it looks titles up directly).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'scans.json');
const BASE = 'https://forecast.agenticlearning.ai';
const DETAIL_CAP = 40;          // max full-trace fetches per run (politeness + runtime)
const DELAY_MS = 250;

const token = process.env.TRACES_TOKEN
  || (existsSync(join(ROOT, '.traces-token'))
      ? readFileSync(join(ROOT, '.traces-token'), 'utf8').trim() : null);
if (!token) {
  console.error('No token. Set TRACES_TOKEN or put it in predict-alpha/.traces-token');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.json();
}

/* The trace's internal layout evolves with the pipeline — only the envelope
 * is contractual. So the rationale is found, not addressed: walk the object,
 * collect every long string under a *rationale* key, prefer one on a path
 * that mentions "final", otherwise take the longest. */
function extractRationale(trace) {
  if (!trace) return null;
  const found = [];
  const walk = (o, path) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const p = path + '/' + k.toLowerCase();
      if (typeof v === 'string' && v.length > 40 && /rationale|reasoning/.test(k.toLowerCase())) {
        found.push({ p, v });
      } else if (typeof v === 'object') walk(v, p);
    }
  };
  walk(trace, '');
  if (!found.length) return null;
  const final = found.filter(f => /final/.test(f.p));
  const pool = final.length ? final : found;
  return pool.reduce((a, b) => (b.v.length > a.v.length ? b : a)).v;
}

const load = () => { try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch { return {}; } };

async function main() {
  const scans = load();
  const meta = scans._meta || {};
  const known = new Map();   // id -> {title, entry}
  for (const [title, list] of Object.entries(scans)) {
    if (title === '_meta' || !Array.isArray(list)) continue;
    for (const e of list) if (e.id != null) known.set(String(e.id), { title, entry: e });
  }

  // Incremental after the first backfill; 2-day overlap for safety.
  let since = '';
  if (meta.last_sync) {
    const t = new Date(Date.parse(meta.last_sync) - 2 * 86400e3);
    since = '&since=' + encodeURIComponent(t.toISOString().slice(0, 19));
  }

  console.log(`index sync${since ? ' (incremental)' : ' (full backfill)'}…`);
  const rows = [];
  let cursor = '';
  for (;;) {
    const page = await api(`/api/traces?source=scanner&platform=polymarket&limit=500${since}${cursor}`);
    rows.push(...(page.traces || []));
    if (page.next_cursor == null) break;
    cursor = '&cursor=' + page.next_cursor;
    await sleep(DELAY_MS);
  }
  console.log(`index rows: ${rows.length}`);

  let added = 0, updated = 0;
  for (const t of rows) {
    if (!t.title) continue;
    const entry = {
      id: t.id,
      scanned_at: t.scanned_at,
      date: (t.scanned_at || '').slice(0, 10),
      // page renders percentages; index serves 0–1 floats
      agent: t.predicted_p_yes != null ? +(t.predicted_p_yes * 100).toFixed(1) : null,
      market_price_t0: t.market_price != null ? +(t.market_price * 100).toFixed(1) : null,
      edge: t.edge ?? null,
      confidence: t.confidence_score ?? null,
      category: t.category ?? null,
      pipeline: t.pipeline_version ?? null,
      rationale: known.get(String(t.id))?.entry?.rationale ?? null,
      url: `${BASE}/scans/v2/${t.id}`,
      has_trace: !!t.has_trace,
    };
    const title = t.title.trim();
    const list = scans[title] ||= [];
    const i = list.findIndex(e => String(e.id) === String(t.id));
    if (i >= 0) { list[i] = { ...list[i], ...entry, rationale: list[i].rationale ?? entry.rationale }; updated++; }
    else { list.push(entry); added++; }
  }

  // Rationales: only for scans that still lack one, newest first, capped.
  const wanting = [];
  for (const [title, list] of Object.entries(scans)) {
    if (title === '_meta' || !Array.isArray(list)) continue;
    for (const e of list) if (e.has_trace && !e.rationale && e.id != null) wanting.push(e);
  }
  wanting.sort((a, b) => (b.scanned_at || '').localeCompare(a.scanned_at || ''));
  const batch = wanting.slice(0, DETAIL_CAP);
  console.log(`rationales missing: ${wanting.length}, fetching: ${batch.length}`);
  let got = 0;
  for (const e of batch) {
    try {
      const d = await api(`/api/traces/scanner/${e.id}`);
      const r = extractRationale(d.trace);
      if (r) { e.rationale = r; got++; }
      else e.has_trace = false;   // don't re-fetch a trace with nothing to show
    } catch (err) { console.error(`  #${e.id}: ${err.message}`); }
    await sleep(DELAY_MS);
  }

  for (const [title, list] of Object.entries(scans)) {
    if (title === '_meta' || !Array.isArray(list)) continue;
    list.sort((a, b) => (b.scanned_at || '').localeCompare(a.scanned_at || ''));
  }
  scans._meta = { last_sync: new Date().toISOString(), source: 'traces-api' };
  writeFileSync(OUT, JSON.stringify(scans, null, 1) + '\n');
  const titles = Object.keys(scans).filter(k => k !== '_meta').length;
  console.log(`done: ${titles} markets, +${added} new scans, ${updated} refreshed, ${got} rationales fetched`);
  if (wanting.length > batch.length)
    console.log(`note: ${wanting.length - batch.length} rationales still pending — next run continues`);
}

main().catch(e => { console.error(e); process.exit(1); });
