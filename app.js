'use strict';
/* Predict Alpha — a zero-backend live dashboard.
 *
 * Everything money-related is read straight from public, CORS-open APIs in
 * the browser: Polymarket data-api (positions, on-chain activity), CLOB
 * (midpoints, price history, websocket book), gamma (market resolution) and
 * a public Polygon RPC (cash balance). The only static inputs are
 * config.js (wallet, invested capital constant) and two optional files:
 * data/scans.json (scraped agent reasoning) and data/annotations.json
 * (why a position was closed manually — the chain can't know intent).
 */

const CFG = window.PA_CONFIG || {};
const DATA_API = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/* ══════════════ state ══════════════ */
let POS = [];          // open positions (arena rows, static part)
let CLOSED = null;     // {rows, realized, wins, manualCount, manualPnl, needsRedeem}
let CURVE = [];        // [{date, pnl}] daily cumulative P&L, chain-replayed
let CASH = null;       // pUSD balance from RPC; null until first success
let FEES = 0;          // lifetime entry fees, from activity
let SC = {};           // scans.json: market title → [scan judgments]
let ANN = {};          // annotations.json: token id → {kind, reason}
let ACT = [];          // raw activity rows (chain truth)

let px = {}, pxPrev = {}, weekHist = {};
let expanded = new Set();
let feedItems = [];
let lastEquity = null;   // previous paint only — drives the flash color, no math
let ws = null, wsAlive = false, wsRetry = 0;
let histDays = null;   // null = all; 7 / 30 = window
let assets = [];       // arena token ids — mutated in place, closed over by ws/poll
let mounted = false;

/* ══════════════ helpers ══════════════ */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (v, sg) => v == null ? '—' :
  (sg && v >= 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctf = (v, sg) => v == null ? '—' :
  (sg && v >= 0 ? '+' : v < 0 ? '−' : '') + (Math.abs(v) * 100).toFixed(1) + '%';
const cls = v => v > 0 ? 'g' : v < 0 ? 'l' : '';
const nowHMS = () => new Date().toTimeString().slice(0, 8);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const jget = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
};

/* ══════════════ theme ══════════════ */
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const btn = $('#themeBtn');
  if (btn) btn.textContent = currentThemeIsDark() ? '☀' : '☾';
  if (mounted) { drawHist(); drawSparks(); }
}
function currentThemeIsDark() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === 'dark';
  return !(matchMedia('(prefers-color-scheme: light)').matches);
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('pa-theme'); } catch {}
  const q = new URLSearchParams(location.search).get('theme');
  applyTheme(q === 'light' || q === 'dark' ? q : saved);
  $('#themeBtn').addEventListener('click', () => {
    const next = currentThemeIsDark() ? 'light' : 'dark';
    try { localStorage.setItem('pa-theme', next); } catch {}
    applyTheme(next);
  });
}

/* ══════════════ number tween ══════════════ */
const tweens = new Map();
function tween(el, to, fmt, ms = 500) {
  if (!el) return;
  const from = tweens.has(el) ? tweens.get(el).cur : to;
  const t0 = performance.now();
  const state = { cur: from };
  tweens.set(el, state);
  const step = now => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    state.cur = from + (to - from) * e;
    el.textContent = fmt(state.cur);
    if (k < 1 && tweens.get(el) === state) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ══════════════ chain reads ══════════════ */
async function fetchPositions() {
  return jget(`${DATA_API}/positions?user=${CFG.wallet}&limit=500`);
}
async function fetchActivity() {
  // One page covers years at the current trade rate; page anyway so the
  // dashboard doesn't silently truncate history once it grows past 500.
  const out = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const page = await jget(`${DATA_API}/activity?user=${CFG.wallet}&limit=500&offset=${offset}`);
    out.push(...page);
    if (page.length < 500) break;
  }
  return out;
}
async function fetchCash() {
  const data = '0x70a08231' + CFG.wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  for (const host of CFG.rpcs || []) {
    try {
      const r = await fetch(host, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
                               params: [{ to: CFG.pusd, data }, 'latest'] }),
      });
      const j = await r.json();
      if (j.result) return parseInt(j.result, 16) / 1e6;
    } catch {}
  }
  return null;
}
/* Market resolution per outcome token, from gamma. A lost settled position
 * stays in the data-api positions list forever as a dead $0 row (nothing to
 * redeem, nobody cleans it up) — this is how we tell it apart.
 * Gamma's clob_token_ids filter EXCLUDES closed markets by default, so the
 * tokens missing from the first pass get a second pass with closed=true —
 * those are exactly the resolved ones. */
const parseWhen = s => s ? Date.parse(String(s).replace(' ', 'T').replace(/\+00$/, 'Z')) || null : null;
async function fetchGamma(tokenIds) {
  const map = {};
  const grab = async (ids, extra) => {
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const qs = chunk.map(t => `clob_token_ids=${t}`).join('&');
      try {
        const mkts = await jget(`${GAMMA}/markets?${qs}${extra}`);
        for (const m of mkts) {
          let toks = [], prices = [];
          try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch {}
          try { prices = JSON.parse(m.outcomePrices || '[]'); } catch {}
          toks.forEach((t, idx) => {
            map[t] = {
              closed: !!m.closed,
              won: m.closed ? parseFloat(prices[idx]) === 1 : null,
              end: parseWhen(m.closedTime) || parseWhen(m.endDate),
            };
          });
        }
      } catch {}
    }
  };
  await grab(tokenIds, '');
  const missing = tokenIds.filter(t => !(t in map));
  if (missing.length) await grab(missing, '&closed=true');
  return map;
}

/* ══════════════ derive open + closed from chain ══════════════ */
function positionCost(p) {
  // Gross cost basis (incl. entry fees) — same convention as the cash-based
  // P&L curve, so the two never disagree by a fee.
  if (p.grossInitialValue != null) return +p.grossInitialValue;
  if (p.entryFeesUsdc != null) return +p.initialValue + +p.entryFeesUsdc;
  return +p.initialValue;
}
function aggregateTrades(activity) {
  const by = {};
  for (const a of activity) {
    if (!a.asset) continue;
    const t = a.type;
    if (t !== 'TRADE' && t !== 'REDEEM') continue;
    const b = by[a.asset] ||= { bought: 0, buyUsd: 0, sold: 0, sellUsd: 0,
                                redeemed: 0, redeemUsd: 0, firstBuy: null,
                                lastExit: null, title: null, outcome: null };
    b.title ||= a.title; b.outcome ||= a.outcome;
    if (t === 'TRADE' && a.side === 'BUY') {
      b.bought += +a.size; b.buyUsd += +a.usdcSize;
      if (b.firstBuy == null || a.timestamp < b.firstBuy) b.firstBuy = a.timestamp;
    } else if (t === 'TRADE' && a.side === 'SELL') {
      b.sold += +a.size; b.sellUsd += +a.usdcSize;
      if (b.lastExit == null || a.timestamp > b.lastExit) b.lastExit = a.timestamp;
    } else if (t === 'REDEEM') {
      b.redeemed += +a.size; b.redeemUsd += +a.usdcSize;
      if (b.lastExit == null || a.timestamp > b.lastExit) b.lastExit = a.timestamp;
    }
  }
  return by;
}
function derive(positions, activity, gamma) {
  const by = aggregateTrades(activity);
  const now = Date.now();
  const open = [], closedRows = [];

  const posByAsset = {};
  for (const p of positions) if (+p.size > 0) posByAsset[p.asset] = p;

  for (const p of Object.values(posByAsset)) {
    const g = gamma[p.asset], b = by[p.asset];
    if (g && g.closed) {
      // Resolved but tokens still in the wallet: a settled position.
      const cost = positionCost(p);
      closedRows.push({
        asset: p.asset, title: p.title, outcome: p.outcome,
        size: +p.size, cost, entry: +p.avgPrice,
        exit: g.won ? 1 : 0,
        pnl: (g.won ? +p.size : 0) - cost,
        action: 'settled', won: !!g.won, needsRedeem: !!g.won,
        ts: g.end || now,
        heldDays: b && b.firstBuy ? (now / 1000 - b.firstBuy) / 86400 : null,
      });
      continue;
    }
    // Some markets carry an epoch-garbage endDate; anything before 2001
    // is noise, not a settle date.
    const end = parseWhen(p.endDate);
    open.push({
      asset: p.asset, title: p.title, outcome: p.outcome,
      size: +p.size, entry_price: +p.avgPrice, cost: positionCost(p),
      market_value: +p.currentValue,
      days_to_resolution: end && end > 978307200000 ? (end - now) / 86400e3 : null,
    });
  }

  // Fully exited via sells (or redeems): bought once, nothing left now.
  for (const [asset, b] of Object.entries(by)) {
    if (posByAsset[asset] || !b.bought) continue;
    const out = b.sold + b.redeemed;
    if (out < b.bought * 0.99) continue;   // dust tolerance
    const viaRedeem = b.redeemed > b.sold;
    closedRows.push({
      asset, title: b.title, outcome: b.outcome,
      size: b.bought, cost: b.buyUsd, entry: b.bought ? b.buyUsd / b.bought : null,
      exit: b.sold ? b.sellUsd / b.sold : (b.redeemed ? b.redeemUsd / b.redeemed : null),
      pnl: b.sellUsd + b.redeemUsd - b.buyUsd,
      action: viaRedeem ? 'settled' : 'sold',
      won: viaRedeem ? true : null, needsRedeem: false,
      ts: (b.lastExit || 0) * 1000,
      heldDays: b.firstBuy && b.lastExit ? (b.lastExit - b.firstBuy) / 86400 : null,
    });
  }

  // Off-chain intent: annotations turn a plain "Sold" into a manual close.
  for (const r of closedRows) {
    const a = ANN[r.asset];
    if (a && a.kind === 'manual') { r.manual = true; r.reason = a.reason; }
  }

  closedRows.sort((x, y) => y.ts - x.ts);
  const priced = closedRows.filter(r => r.pnl != null);
  CLOSED = {
    rows: closedRows,
    realized: priced.reduce((s, r) => s + r.pnl, 0),
    wins: priced.filter(r => r.pnl > 0).length,
    manualCount: closedRows.filter(r => r.manual).length,
    manualPnl: priced.filter(r => r.manual).reduce((s, r) => s + r.pnl, 0),
    needsRedeem: closedRows.filter(r => r.needsRedeem).length,
  };
  POS = open;
  FEES = activity.filter(a => a.type === 'TRADE' && a.side === 'BUY')
    .reduce((s, a) => s + (+a.usdcSize || 0) - (+a.price || 0) * (+a.size || 0), 0);
}

/* ══════════════ live account view ══════════════ */
function liveState() {
  let mv = 0, cost = 0;
  const rows = POS.map(p => {
    const lp = p.asset && px[p.asset] != null ? px[p.asset] : null;
    const m = lp != null ? p.size * lp : p.market_value;
    mv += m; cost += p.cost;
    return { ...p, live: lp, mv: m, pnlNow: m - p.cost, roiNow: p.cost ? (m - p.cost) / p.cost : 0 };
  });
  const cash = CASH != null ? CASH : 0;
  const equity = cash + mv;
  return { rows, equity, mv, costB: cost, unreal: mv - cost,
           cum: equity - (CFG.invested || 0) };
}

/* ══════════════ mount ══════════════ */
function mount() {
  const S = liveState();
  lastEquity = S.equity;

  $('#app').innerHTML = `
    <div class="hero">
      <div class="panel equity-box">
        <div class="label">Account Equity</div>
        <div class="equity" id="eqBig">${usd(S.equity)}</div>
        <div class="delta-row">
          <span class="delta-chip">Today <b id="todayD">—</b></span>
          <span class="delta-chip">Total <b id="cumD" class="${cls(S.cum)}">${usd(S.cum, 1)}</b></span>
          <span class="delta-chip">Unrealized <b id="unrD" class="${cls(S.unreal)}">${usd(S.unreal, 1)}</b></span>
        </div>
      </div>
      <div class="panel chart-box">
        <div class="title">
          <span>Cumulative P&amp;L · LIVE — since inception (${esc(CFG.inception || '')})</span>
          <span class="ranges"><span id="histDelta"></span>
            <button class="range-btn" data-days="7">7D</button>
            <button class="range-btn" data-days="30">30D</button>
            <button class="range-btn on" data-days="">All</button>
          </span>
        </div>
        <canvas id="histChart" height="168"></canvas>
      </div>
    </div>

    <div class="main">
      <div class="panel board">
        <h2>Position Arena <span>ranked by live P&amp;L · tick-level prices · 1-week trend</span></h2>
        <div class="rows" id="board"></div>
      </div>
      <div class="rail">
        <div class="panel feed">
          <h2>Live Feed <span>price moves in our positions, as they happen</span></h2>
          <div id="feed"></div>
        </div>
      </div>
    </div>

    <div class="panel board" id="closedSec" hidden></div>

    <div class="stats-strip" id="strip"></div>`;

  mounted = true;
  renderStrip(S);
  renderBoard(S, true);
  renderClosed();
  drawHist(); initHistRanges();
  addEventListener('resize', drawHist);
  const toggle = (sel, rerender) => $(sel).addEventListener('click', ev => {
    if (ev.target.closest('a')) return;
    const row = ev.target.closest('.row.has-scan');
    if (!row) return;
    const key = row.dataset.k;
    expanded.has(key) ? expanded.delete(key) : expanded.add(key);
    rerender();
  });
  toggle('#board', () => renderBoard(liveState(), true));
  toggle('#closedSec', renderClosed);
}

/* ══════════════ stats strip ══════════════ */
function maxDrawdown() {
  const pts = CURVE.map(p => p.pnl);
  if (mounted) pts.push(liveState().cum);
  let peak = -Infinity, dd = 0;
  for (const v of pts) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  return dd;
}
function renderStrip(S) {
  const c = CLOSED || { rows: [], wins: 0 };
  const closedPriced = c.rows.filter(r => r.pnl != null).length;
  $('#strip').innerHTML = [
    ['Cash', CASH != null ? usd(CASH) : '—'],
    ['Market Value', usd(S.mv)],
    ['Invested', usd(CFG.invested)],
    ['Realized P&L', usd(c.realized)],
    ['Max Drawdown', CURVE.length ? usd(maxDrawdown()) : '—'],
    ['Win Rate', closedPriced ? `${pctf(c.wins / closedPriced)} · ${c.wins}/${closedPriced}` : '—'],
    ['Utilization', S.equity ? pctf(S.costB / S.equity) : '—'],
    ['Fees Paid', usd(FEES)],
    ['Open Positions', String(POS.length)],
  ].map(([k, v]) => `<span class="stat">${k} <b>${esc(v)}</b></span>`).join('');
}

/* ══════════════ arena (FLIP reorder animation) ══════════════ */
function renderBoard(S, first) {
  const board = $('#board');
  const sorted = [...S.rows].sort((x, y) => y.pnlNow - x.pnlNow);
  const maxAbs = Math.max(.0001, ...sorted.map(r => Math.abs(r.roiNow)));
  const old = {};
  if (!first) for (const el of board.children) old[el.dataset.k] = el.getBoundingClientRect().top;

  board.innerHTML = sorted.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1;
    const dirUp = r.asset && pxPrev[r.asset] != null && px[r.asset] != null
      ? (px[r.asset] > pxPrev[r.asset] ? 1 : px[r.asset] < pxPrev[r.asset] ? -1 : 0) : 0;
    const arrow = dirUp > 0 ? '<span class="arrow g">▲</span>' : dirUp < 0 ? '<span class="arrow l">▼</span>' : '';
    const w = Math.abs(r.roiNow) / maxAbs * 50;
    const key = r.asset || r.title;
    const scans = SC[(r.title || '').trim()];
    const isOpen = scans && expanded.has(key);
    return `<div class="row ${scans ? 'has-scan' : ''} ${isOpen ? 'open' : ''}" data-k="${esc(key)}">
      <div class="rank ${i < 3 ? 'medal' : ''}">${medal}</div>
      <div class="mkt"><div class="t" title="${esc(r.title)}">${
          scans ? '<span class="chev">▶</span>' : ''}${esc(r.title)}</div>
        <div class="s">${r.size.toFixed(0)} sh · cost ${usd(r.cost)} · ${
          r.days_to_resolution != null ? 'settles ' + Math.round(r.days_to_resolution) + 'd' : 'settle date n/a'}${
          scans ? ` · ${scans.length} scans` : ''}</div></div>
      <div class="side ${(r.outcome || '').toLowerCase() === 'yes' ? 'yes' : 'no'}">${esc((r.outcome || '?').toUpperCase())}</div>
      <div class="px">${arrow} ${r.live != null ? r.live.toFixed(3) : '—'}
        <small>entry ${r.entry_price != null ? r.entry_price.toFixed(3) : '—'}</small></div>
      <div class="spark"><canvas data-spark="${esc(r.asset || '')}" width="144" height="52"></canvas></div>
      <div class="pnl ${cls(r.pnlNow)}">${usd(r.pnlNow, 1)}<small>value ${usd(r.mv)}</small></div>
      <div class="roi-cell">
        <div class="roi-bar" style="background:${r.roiNow >= 0 ? 'var(--gain)' : 'var(--loss)'};
          width:${w}%; left:${r.roiNow >= 0 ? 50 : 50 - w}%"></div>
        <span class="roi-txt ${cls(r.roiNow)}">${pctf(r.roiNow, 1)}</span>
      </div></div>${isOpen ? scanDetail(key, scans) : ''}`;
  }).join('');

  if (!first) for (const el of board.children) {
    const prev = old[el.dataset.k];
    if (prev == null) continue;
    const dy = prev - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 2) {
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
                 { duration: 450, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  }
  drawSparks();
}

/* ── expandable scan reasoning (scraped by the companion fetch script) ── */
function scanDetail(key, scans) {
  const items = scans.map(s => {
    const when = (s.scanned_at || s.date || '').slice(0, 16).replace('T', ' ');
    const nums = (s.agent != null && s.market_price_t0 != null)
      ? `agent <b>${s.agent.toFixed(0)}%</b> vs market <b>${s.market_price_t0.toFixed(0)}%</b>
         <span class="${cls(s.agent - s.market_price_t0)}">(${
           (s.agent - s.market_price_t0) >= 0 ? '+' : ''}${(s.agent - s.market_price_t0).toFixed(1)}pp)</span>`
      : '';
    // richer fields arrive via the traces-API sync; absent on scraped entries
    const extra = [
      s.confidence != null ? `confidence ${(s.confidence * 100).toFixed(0)}%` : null,
      s.category ? `category ${s.category}` : null,
    ].filter(Boolean).map(esc).join(' · ');
    return `<div class="scan-item">
      <div class="head"><span class="when">${esc(when)}</span> ${nums}
        ${extra ? `<span class="extra">${extra}</span>` : ''}
        <a href="${esc(s.url)}" target="_blank" rel="noopener">full reasoning ↗</a></div>
      <div class="body">${esc(s.rationale || '(no rationale captured for this scan)')}</div>
    </div>`;
  }).join('');
  return `<div class="row-detail" data-k="${esc(key)}::detail">${items}</div>`;
}

/* ══════════════ closed positions ══════════════ */
function renderClosed() {
  const c = CLOSED, sec = $('#closedSec');
  if (!c || !c.rows.length) { sec.hidden = true; return; }
  sec.hidden = false;

  const bits = [`Realized <b class="${cls(c.realized)}">${usd(c.realized, 1)}</b>`,
                `${c.rows.length} trades (${c.wins} wins)`];
  if (c.manualCount) bits.push(`${c.manualCount} manual closes ${usd(c.manualPnl, 1)}`);
  if (c.needsRedeem) bits.push(`⚠ ${c.needsRedeem} won, awaiting redemption`);

  const rows = c.rows.map(r => {
    const key = 'closed:' + r.asset;
    const scans = SC[(r.title || '').trim()];
    const isOpen = scans && expanded.has(key);
    const [howCls, howTxt] = r.manual ? ['manual', 'MANUAL']
      : r.action === 'settled' ? ['settled', r.won ? 'SETTLED ✓' : 'SETTLED'] : ['sold', 'SOLD'];
    const d = r.ts ? new Date(r.ts).toISOString().slice(5, 10) : '—';
    return `<div class="row crow ${scans ? 'has-scan' : ''} ${isOpen ? 'open' : ''}" data-k="${esc(key)}">
      <div class="cdate">${d}</div>
      <div class="mkt"><div class="t" title="${esc(r.title)}">${
          scans ? '<span class="chev">▶</span>' : ''}${esc(r.title)}</div>
        <div class="s">${r.size.toFixed(0)} sh · cost ${usd(r.cost)}${
          r.heldDays != null ? ` · held ${Math.round(r.heldDays)}d` : ''}${
          scans ? ` · ${scans.length} scans` : ''}${
          r.manual && r.reason ? ` <span class="why">· ${esc(r.reason)}</span>` : ''}</div></div>
      <div class="side ${(r.outcome || '').toLowerCase() === 'yes' ? 'yes' : 'no'}">${esc((r.outcome || '?').toUpperCase())}</div>
      <div class="px">${r.exit != null ? r.exit.toFixed(3) : '—'}
        <small>entry ${r.entry != null ? r.entry.toFixed(3) : '—'}</small></div>
      <div><span class="how ${howCls}">${howTxt}</span></div>
      <div class="pnl ${cls(r.pnl)}">${usd(r.pnl, 1)}</div>
      <div class="roi-cell"><span class="roi-txt ${cls(r.pnl)}">${
        r.cost ? pctf(r.pnl / r.cost, 1) : '—'}</span></div>
    </div>${isOpen ? scanDetail(key, scans) : ''}`;
  }).join('');

  sec.innerHTML = `<h2>Closed Positions <span>${bits.join(' · ')}</span></h2>
    <div class="rows">${rows}</div>`;
}

function flashRow(asset, up) {
  const el = document.querySelector(`.row[data-k="${CSS.escape(asset)}"]`);
  if (!el) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth;
  el.classList.add(up ? 'flash-up' : 'flash-down');
  setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 650);
}

/* ══════════════ live feed ══════════════ */
function pushFeed(title, outcome, from, to) {
  const d = to - from;
  feedItems.unshift({ tm: nowHMS(), title, outcome, from, to, d });
  feedItems = feedItems.slice(0, 30);
  $('#feed').innerHTML = feedItems.map(f => `<div class="tick">
    <span class="tm">${f.tm}</span>
    <span class="body"><span class="t">${esc(f.title)}</span>
    <span class="mv"><span style="color:var(--ink-3)">${esc(f.outcome)}</span>
      ${f.from.toFixed(3)} → ${f.to.toFixed(3)}
      <span class="${cls(f.d)}">${(f.d >= 0 ? '+' : '') + (f.d * 100).toFixed(1)}pp</span></span></span></div>`).join('');
}
/* Seed the feed with the biggest 24h movers, computed from the weekly
 * histories once they're in — so the rail isn't empty on first paint. */
function seedFeed() {
  if (feedItems.length) return;
  const movers = POS.map(p => {
    const h = weekHist[p.asset];
    if (!h || h.length < 26) return null;
    const from = h[h.length - 25], to = h[h.length - 1];
    return { p, from, to, d: Math.abs(to - from) };
  }).filter(m => m && m.d >= 0.005)
    .sort((a, b) => b.d - a.d).slice(0, 5);
  [...movers].reverse().forEach(m =>
    pushFeed(m.p.title, (m.p.outcome || '') + ' · 24h', m.from, m.to));
}

/* ══════════════ canvas plumbing ══════════════ */
function setupCanvas(cv) {
  // Cache the design height once: writing cv.height rewrites the attribute,
  // and attr*dpr on every redraw doubles the canvas each frame on Retina.
  if (!cv.dataset.h) cv.dataset.h = cv.getAttribute('height') || 150;
  const h = +cv.dataset.h, dpr = devicePixelRatio || 1;
  const w = cv.getBoundingClientRect().width || cv.parentElement.clientWidth;
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}

/* ══════════════ cumulative P&L chart ══════════════
 * The y-value is always "cumulative P&L since inception" — range buttons
 * crop the x-window, they never re-zero the baseline. The live endpoint is
 * equity − invested: the same cash-based, fee-inclusive convention the
 * replayed daily curve uses, so the joint is seamless. */
function livePnlPoint() { return liveState().cum; }
function drawHist() {
  const cv = $('#histChart'); if (!cv) return;
  const [ctx, W, H] = setupCanvas(cv);
  ctx.clearRect(0, 0, W, H);
  const all = CURVE;
  if (all.length < 2) {
    ctx.fillStyle = cssVar('--ink-3'); ctx.font = '11px ui-monospace';
    ctx.fillText('replaying on-chain history…', 10, H / 2);
    return;
  }

  let c = all, baseVal = 0;
  if (histDays != null) {
    const cut = new Date(Date.now() - histDays * 86400e3).toISOString().slice(0, 10);
    const idx = all.findIndex(p => p.date >= cut);
    if (idx > 0) baseVal = all[idx - 1].pnl;
    c = idx >= 0 ? all.slice(idx) : all;
    if (c.length < 2) { c = all.slice(-2); baseVal = 0; }
  }

  const liveV = livePnlPoint();
  const vs = c.map(p => p.pnl).concat([liveV]);
  const n = vs.length;
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (histDays == null) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = Math.max((hi - lo) * .12, 1); lo -= pad; hi += pad;
  const X = i => 8 + i / (n - 1) * (W - 20);
  const Y = v => H - 22 - (v - lo) / (hi - lo) * (H - 34);

  if (0 >= lo && 0 <= hi) {
    ctx.strokeStyle = cssVar('--line'); ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(8, Y(0)); ctx.lineTo(W - 12, Y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }

  const col = liveV >= 0 ? cssVar('--gain') : cssVar('--loss');
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, col + '2e'); grad.addColorStop(1, col + '00');
  ctx.beginPath();
  vs.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(0), Y(v)));
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
  ctx.lineTo(X(n - 1), H - 16); ctx.lineTo(X(0), H - 16); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  const lx = X(n - 1), ly = Y(liveV);
  ctx.beginPath(); ctx.arc(lx, ly, 8, 0, 7); ctx.fillStyle = col + '44'; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, 7); ctx.fillStyle = col; ctx.fill();

  ctx.fillStyle = cssVar('--ink-3'); ctx.font = '10px ui-monospace';
  ctx.fillText(c[0].date, 8, H - 4);
  const lastLbl = 'LIVE  ' + usd(liveV, 1);
  ctx.fillText(lastLbl, W - 12 - ctx.measureText(lastLbl).width, H - 4);

  const dEl = $('#histDelta');
  if (dEl) {
    if (histDays == null) { dEl.textContent = ''; }
    else {
      const wd = liveV - baseVal;
      dEl.textContent = `${histDays}D ${usd(wd, 1)}`;
      dEl.className = cls(wd) || '';
    }
  }
}
function initHistRanges() {
  document.querySelectorAll('.range-btn').forEach(b =>
    b.addEventListener('click', () => {
      histDays = b.dataset.days === '' ? null : +b.dataset.days;
      document.querySelectorAll('.range-btn').forEach(x =>
        x.classList.toggle('on', x === b));
      drawHist();
    }));
}

/* ══════════════ daily curve: replay chain activity ══════════════
 * P&L(day) = Σ cash deltas up to that day + Σ holdings × price(day).
 * Cash deltas come from trade/redeem/yield/reward usdcSize (fee-inclusive),
 * so deposits never enter the formula and fees never create fake steps. */
async function buildCurve(activity) {
  const events = activity
    .filter(a => ['TRADE', 'REDEEM', 'YIELD', 'REWARD'].includes(a.type))
    .map(a => ({
      ts: a.timestamp,
      asset: a.asset || null,
      dSize: a.type === 'TRADE' ? (a.side === 'BUY' ? +a.size : -a.size)
           : a.type === 'REDEEM' ? -a.size : 0,
      dCash: a.type === 'TRADE' ? (a.side === 'BUY' ? -a.usdcSize : +a.usdcSize)
           : +a.usdcSize,
    }))
    .sort((x, y) => x.ts - y.ts);
  if (!events.length) return;

  const traded = [...new Set(events.map(e => e.asset).filter(Boolean))];
  const hist = {};
  const q = [...traded];
  const work = async () => {
    while (q.length) {
      const a = q.shift();
      try {
        const r = await jget(`${CLOB}/prices-history?market=${a}&interval=max&fidelity=720`);
        hist[a] = r.history || [];
      } catch { hist[a] = []; }
    }
  };
  await Promise.all([work(), work(), work(), work()]);

  const priceAt = (a, tsEnd) => {
    const h = hist[a];
    if (!h || !h.length) return null;
    let best = null;
    for (const pt of h) { if (pt.t <= tsEnd) best = pt.p; else break; }
    return best != null ? best : h[0].p;
  };

  const startTs = Math.min(events[0].ts * 1000,
                           Date.parse((CFG.inception || '') + 'T00:00:00Z') || Infinity);
  const days = [];
  for (let t = startTs; t < Date.now(); t += 86400e3)
    days.push(new Date(t).toISOString().slice(0, 10));

  const holdings = {}; let cash = 0, ei = 0;
  CURVE = days.map(date => {
    const dayEnd = Date.parse(date + 'T23:59:59Z') / 1000;
    while (ei < events.length && events[ei].ts <= dayEnd) {
      const e = events[ei++];
      cash += e.dCash;
      if (e.asset) holdings[e.asset] = (holdings[e.asset] || 0) + e.dSize;
    }
    let mv = 0;
    for (const [a, sz] of Object.entries(holdings)) {
      if (sz <= 1e-6) continue;
      const p = priceAt(a, dayEnd);
      if (p != null) mv += sz * p;
    }
    return { date, pnl: cash + mv };
  });
  drawHist();
  if (mounted) { renderStrip(liveState()); scheduleRefresh(); }   // Today chip needs the curve
}

/* ══════════════ weekly sparklines ══════════════ */
function loadWeekSparks(list) {
  const q = [...list];
  const work = async () => {
    while (q.length) {
      const a = q.shift();
      try {
        const r = await fetch(`${CLOB}/prices-history?market=${a}&interval=1w&fidelity=60`);
        if (!r.ok) continue;
        const h = ((await r.json()).history || []).map(x => x.p).filter(v => v > 0);
        if (h.length > 1) { weekHist[a] = h; drawSparks(); }
      } catch {}
    }
  };
  return Promise.all([work(), work(), work(), work()]);
}
function drawSparks() {
  const gain = cssVar('--gain'), loss = cssVar('--loss');
  document.querySelectorAll('canvas[data-spark]').forEach(cv => {
    const a = cv.dataset.spark;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const hist = weekHist[a];
    if (!hist || hist.length < 2) return;
    const pts = hist.slice();
    if (px[a] != null) pts.push(px[a]);
    const step = Math.max(1, Math.ceil(pts.length / 48));
    const ds = pts.filter((_, i) => i % step === 0);
    if (ds[ds.length - 1] !== pts[pts.length - 1]) ds.push(pts[pts.length - 1]);
    const lo = Math.min(...ds), hi = Math.max(...ds), span = (hi - lo) || 1e-6;
    const X = i => 3 + i / (ds.length - 1) * (cv.width - 10);
    const Y = v => cv.height - 5 - (v - lo) / span * (cv.height - 10);
    const up = ds[ds.length - 1] >= ds[0];
    const col = up ? gain : loss;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(ds[0]));
    for (let i = 1; i < ds.length - 1; i++) {
      ctx.quadraticCurveTo(X(i), Y(ds[i]),
                           (X(i) + X(i + 1)) / 2, (Y(ds[i]) + Y(ds[i + 1])) / 2);
    }
    ctx.lineTo(X(ds.length - 1), Y(ds[ds.length - 1]));
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.beginPath();
    ctx.arc(X(ds.length - 1), Y(ds[ds.length - 1]), 2.5, 0, 7);
    ctx.fillStyle = col; ctx.fill();
  });
}

/* ══════════════ price intake ══════════════
 * Single convention: CLOB midpoint only (polled, or computed from ws book).
 * Mixing sources once produced a 15-second sawtooth on the equity line. */
function acceptPrice(asset, p, silent) {
  if (p == null || !(p > 0) || p >= 1.000001) return;
  const prev = px[asset];
  if (prev != null && Math.abs(prev - p) < 5e-4) return;
  pxPrev[asset] = prev != null ? prev : p;
  px[asset] = p;
  if (!silent && prev != null) {
    const pos = POS.find(q => q.asset === asset);
    if (pos) { flashRow(asset, p > prev); pushFeed(pos.title, pos.outcome, prev, p); }
  }
  scheduleRefresh();
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refresh(); }, 250);
}
/* P&L accumulated today (UTC): live cumulative minus yesterday's replayed
 * close — an absolute number, identical no matter when the page is opened. */
function todayDelta(S) {
  if (!CURVE.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  for (let i = CURVE.length - 1; i >= 0; i--)
    if (CURVE[i].date < today) return S.cum - CURVE[i].pnl;
  return null;
}
function refresh() {
  if (!mounted) return;
  const S = liveState();
  const eqEl = $('#eqBig');
  tween(eqEl, S.equity, v => usd(v));
  if (lastEquity != null && Math.abs(S.equity - lastEquity) > 1e-9) {
    eqEl.classList.toggle('up', S.equity > lastEquity);
    eqEl.classList.toggle('down', S.equity < lastEquity);
  }
  lastEquity = S.equity;
  const td = todayDelta(S);
  const tEl = $('#todayD');
  tEl.textContent = usd(td, 1); tEl.className = td == null ? '' : cls(td) || '';
  const cEl = $('#cumD');
  cEl.textContent = usd(S.cum, 1); cEl.className = cls(S.cum);
  const uEl = $('#unrD');
  uEl.textContent = usd(S.unreal, 1); uEl.className = cls(S.unreal);
  renderBoard(S, false);
  drawHist();
}

/* ══════════════ connection status ══════════════ */
function setConn(mode) {
  const chip = $('#connChip'), txt = $('#connTxt');
  chip.className = 'chip ' + (mode === 'ws' ? 'live' : mode === 'poll' ? 'poll' : 'dead');
  txt.textContent = mode === 'ws' ? 'LIVE' : mode === 'poll' ? 'LIVE · 15s' : 'OFFLINE';
}

/* ══════════════ websocket ══════════════ */
function connectWS(list) {
  try { ws = new WebSocket(WS_URL); }
  catch { return; }
  let pinger = 0;
  ws.onopen = () => {
    ws.send(JSON.stringify({ assets_ids: list, type: 'market' }));
    pinger = setInterval(() => { try { ws.send('PING'); } catch {} }, 10000);
    wsAlive = true; wsRetry = 0; setConn('ws');
  };
  ws.onmessage = ev => {
    if (ev.data === 'PONG') return;
    let msgs; try { msgs = JSON.parse(ev.data); } catch { return; }
    (Array.isArray(msgs) ? msgs : [msgs]).forEach(m => {
      if (m.event_type === 'book' && m.asset_id) {
        // Mid only from a two-sided book: a bid-only sliver is not a price.
        const bid = best(m.bids, true), ask = best(m.asks, false);
        if (bid != null && ask != null) acceptPrice(m.asset_id, (bid + ask) / 2);
      } else if (m.event_type === 'price_change') {
        const chs = m.price_changes || m.changes || [];
        chs.forEach(c => {
          const aid = c.asset_id || m.asset_id;
          if (!aid) return;
          if (c.best_bid != null && c.best_ask != null)
            acceptPrice(aid, (parseFloat(c.best_bid) + parseFloat(c.best_ask)) / 2);
        });
      }
    });
  };
  const drop = () => {
    clearInterval(pinger);
    if (wsAlive || wsRetry === 0) setConn('poll');
    wsAlive = false;
    setTimeout(() => connectWS(list), Math.min(30000, 1000 * 2 ** wsRetry++));
  };
  ws.onclose = drop;
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function best(levels, isBid) {
  if (!Array.isArray(levels) || !levels.length) return null;
  let b = null;
  for (const l of levels) {
    const v = parseFloat(l.price);
    if (Number.isNaN(v)) continue;
    b = b == null ? v : (isBid ? Math.max(b, v) : Math.min(b, v));
  }
  return b;
}

/* ══════════════ REST fallback: batch midpoints ══════════════ */
async function pollOnce(list, silent) {
  if (wsAlive && !silent) return false;
  try {
    const r = await fetch(`${CLOB}/midpoints`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list.map(a => ({ token_id: a }))) });
    if (!r.ok) return false;
    const mids = await r.json();
    let got = false;
    for (const [id, v] of Object.entries(mids)) {
      const p = parseFloat(v);
      if (!Number.isNaN(p)) { acceptPrice(id, p, silent); got = true; }
    }
    if (got && !wsAlive) setConn('poll');
    return got;
  } catch { return false; }
}

/* ══════════════ periodic wallet refresh ══════════════
 * Prices tick over the websocket; the wallet itself (fills, closes, cash)
 * is re-read from the chain every minute. New tokens are hot-added to the
 * price feeds; a closed one flows from the arena into Closed Positions. */
async function refreshWallet() {
  try {
    const [positions, activity, cash] = await Promise.all([
      fetchPositions(), fetchActivity(), fetchCash()]);
    if (cash != null) CASH = cash;
    ACT = activity;
    const gamma = await fetchGamma([...new Set(positions.filter(p => +p.size > 0).map(p => p.asset))]);
    derive(positions, activity, gamma);

    const now = new Set(POS.map(p => p.asset).filter(Boolean));
    const added = [...now].filter(a => !assets.includes(a));
    const removed = assets.filter(a => !now.has(a));
    if (added.length || removed.length) {
      assets.length = 0; assets.push(...now);   // in place: ws/poll closures see it
      if (added.length) { loadWeekSparks(added); pollOnce(added, true); }
      try { ws && ws.close(); } catch {}        // reconnect → resubscribe with new list
    }
    $('#dataTime').textContent = 'on-chain ' + nowHMS();
    renderClosed();
    renderStrip(liveState());
    scheduleRefresh();
  } catch {}
}

/* ══════════════ boot ══════════════ */
(async function boot() {
  initTheme();
  if (!CFG.wallet) {
    $('#app').innerHTML = `<div class="err"><p>Missing config.js — set your wallet address in PA_CONFIG.</p></div>`;
    return;
  }
  // Optional enrichments; the dashboard runs fine without them.
  try { SC = await jget('data/scans.json'); } catch {}
  try {
    const a = await jget('data/annotations.json');
    delete a._comment; ANN = a;
  } catch {}

  let positions, activity, cash;
  try {
    [positions, activity, cash] = await Promise.all([
      fetchPositions(), fetchActivity(), fetchCash()]);
  } catch (e) {
    $('#app').innerHTML = `<div class="err"><p>Could not reach Polymarket data-api (${esc(e.message)})</p>
      <p style="margin-top:8px;color:var(--ink-2)">Check the network — the page reads everything
      live from public APIs and keeps no local copy.</p></div>`;
    return;
  }
  CASH = cash; ACT = activity;
  const gamma = await fetchGamma([...new Set(positions.filter(p => +p.size > 0).map(p => p.asset))]);
  derive(positions, activity, gamma);

  assets = [...new Set(POS.map(p => p.asset).filter(Boolean))];
  await pollOnce(assets, true);        // seed prices so the first paint is live
  mount();
  $('#dataTime').textContent = 'on-chain ' + nowHMS();
  connectWS(assets);
  loadWeekSparks(assets).then(seedFeed);
  buildCurve(activity);                // async; chart fills in when replay is done
  setInterval(() => pollOnce(assets, false), 15000);
  setInterval(refreshWallet, 60000);
})();
