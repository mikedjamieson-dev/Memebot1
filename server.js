const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── CONFIG ────────────────────────────────────────────────────
const CFG = {
  MIN_SCORE: 68,
  SOL_GAS: 0.001,
  MAX_POS: 0.08,
  MAX_OPEN: 4,
  TRAIL_ACT: 0.05,
  TRAIL_PB: 0.02,
  WIN_BASE: 0.38,
  WIN_MAX: 0.52,
  LOSS_LIM: 0.10,
  POOL_MAX: 5000
};

// ── STATE ─────────────────────────────────────────────────────
const S = {
  tokens: new Map(),
  open: [], closed: [],
  stats: { w: 0, l: 0, r: 0, t: 0 },
  fund: 100, savings: 0,
  running: false,
  pumpLive: false, pumpCount: 0,
  scanCount: 0, rejectCount: 0,
  logs: [], sources: {},
  startTime: null
};

function log(msg, type = 'info') {
  const e = { msg, type, time: new Date().toLocaleTimeString() };
  S.logs.unshift(e);
  if (S.logs.length > 500) S.logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function addTok(t) {
  if (!t || !t.n || !t.id) return;
  S.tokens.set(t.n + t.id, t);
  if (S.tokens.size > CFG.POOL_MAX) {
    for (const [k, v] of S.tokens) { if (!v.pump) { S.tokens.delete(k); break; } }
  }
}

// ── PUMP.FUN WEBSOCKET ────────────────────────────────────────
let pumpWs = null;
function connectPump() {
  if (pumpWs && pumpWs.readyState === WebSocket.OPEN) return;
  try {
    pumpWs = new WebSocket('wss://pumpportal.fun/api/data');
    pumpWs.on('open', () => {
      S.pumpLive = true;
      S.sources['PUMP.FUN'] = 'live';
      pumpWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
      log('⚡ Pump.fun WebSocket LIVE — streaming new launches', 'pump');
    });
    pumpWs.on('message', (data) => {
      try {
        const d = JSON.parse(data.toString());
        if (d.mint && (d.symbol || d.name)) {
          addTok({
            id: d.mint,
            n: (d.symbol || d.name || 'NEW').toUpperCase().slice(0, 12),
            src: 'WS', pump: true,
            liq: Math.random() * 30000 + 5000,
            vol1: Math.random() * 10000 + 500,
            vol24: Math.random() * 50000 + 1000,
            c5: Math.random() * 80,
            c1: Math.random() * 150 - 10,
            c24: Math.random() * 200 - 20,
            bsr: Math.random() * 3.5 + 1.5,
            txns: Math.floor(Math.random() * 100) + 5,
            age: 0, isNew: true, hot: true,
            rug: Math.random() < 0.12, hp: Math.random() < 0.04
          });
          S.pumpCount++;
          S.sources['PUMP.FUN'] = `live:${S.pumpCount}`;
          if (S.pumpCount % 20 === 0) log(`🔥 Pump.fun: ${S.pumpCount} launches — latest: ${(d.symbol||d.name||'?').toUpperCase().slice(0,12)}`, 'pump');
        }
      } catch (e) {}
    });
    pumpWs.on('error', () => { S.pumpLive = false; S.sources['PUMP.FUN'] = 'dead'; });
    pumpWs.on('close', () => { S.pumpLive = false; S.sources['PUMP.FUN'] = 'dead'; setTimeout(connectPump, 10000); });
  } catch (e) { setTimeout(connectPump, 15000); }
}

// ── HTTP SOURCES ──────────────────────────────────────────────
const DS_QUERIES = [
  { id: 'DSC-NEW',   url: 'https://api.dexscreener.com/latest/dex/search?q=solana+new+token' },
  { id: 'DSC-TREND', url: 'https://api.dexscreener.com/latest/dex/search?q=solana+trending' },
  { id: 'DSC-BOOST', url: 'https://api.dexscreener.com/latest/dex/search?q=solana+pump+fun' },
  { id: 'DSC-MEME',  url: 'https://api.dexscreener.com/latest/dex/search?q=solana+meme+coin' },
  { id: 'DSC-GEM',   url: 'https://api.dexscreener.com/latest/dex/search?q=solana+gem+moon' },
  { id: 'DSC-MOON',  url: 'https://api.dexscreener.com/latest/dex/search?q=solana+dog+cat+pepe' },
];

async function fetchAll() {
  // DexScreener
  for (const q of DS_QUERIES) {
    try {
      const res = await fetch(q.url, { timeout: 8000 });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const pairs = (data.pairs || []).filter(p => p.chainId === 'solana' && p.priceUsd);
      pairs.forEach(p => addTok(mapDS(p)));
      S.sources[q.id] = `live:${pairs.length}`;
    } catch (e) { S.sources[q.id] = 'dead'; }
  }

  // DSC Profiles
  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 8000 });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const profiles = (Array.isArray(data) ? data : (data.profiles || [])).filter(p => p.chainId === 'solana').slice(0, 30);
    profiles.forEach(p => addTok(mapDSP(p)));
    S.sources['DSC-PROF'] = `live:${profiles.length}`;
  } catch (e) { S.sources['DSC-PROF'] = 'dead'; }

  // Jupiter
  try {
    const res = await fetch('https://lite.jupiterapi.com/tokens?tags=birdeye-trending', { timeout: 8000 });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const toks = (Array.isArray(data) ? data : []).slice(0, 30);
    toks.forEach(t => addTok(mapJup(t)));
    S.sources['JUPITER'] = `live:${toks.length}`;
  } catch (e) { S.sources['JUPITER'] = 'dead'; }

  // DexPaprika
  try {
    const res = await fetch('https://api.dexpaprika.com/networks/sol/pools/?limit=25&order_by=volume_usd&sort=desc', { timeout: 8000 });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const pools = (Array.isArray(data) ? data : (data.pools || [])).slice(0, 25);
    pools.forEach(p => addTok(mapDXP(p)));
    S.sources['DEXPAPRIKA'] = `live:${pools.length}`;
  } catch (e) { S.sources['DEXPAPRIKA'] = 'dead'; }

  // CoinGecko
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=solana-meme-coins&order=volume_desc&per_page=20&sparkline=false&price_change_percentage=1h,24h', { timeout: 8000 });
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data && data.length) { data.forEach(c => addTok(mapCG(c))); S.sources['COINGECKO'] = `live:${data.length}`; }
  } catch (e) { S.sources['COINGECKO'] = 'dead'; }

  log(`📊 Pool: ${S.tokens.size} tokens | Pump.fun: ${S.pumpCount} live`, 'info');
}

// ── MAPPERS ───────────────────────────────────────────────────
function rn(a, b) { return Math.random() * (b - a) + a; }
function ri(a, b) { return Math.floor(rn(a, b)); }

function mapDS(p) {
  const c1 = p.priceChange?.h1 || 0, c24 = p.priceChange?.h24 || 0, c5 = p.priceChange?.m5 || 0;
  const liq = p.liquidity?.usd || 0, v24 = p.volume?.h24 || 0;
  const buys = p.txns?.h1?.buys || 0, sells = p.txns?.h1?.sells || 1;
  const age = (p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) : 86400000 * 30) / 3600000;
  return { id: p.pairAddress || Math.random().toString(36).substr(2, 8), n: (p.baseToken?.symbol || '???').toUpperCase().slice(0, 12), src: 'DSC', pump: false, liq, vol1: v24 / 24, vol24: v24, c5, c1, c24, bsr: buys / Math.max(sells, 1), txns: buys + sells, age, isNew: age < 1, hot: age < 0.17, rug: rugChk(c1, c24, liq, buys / Math.max(sells, 1)), hp: buys > 10 && sells === 0 };
}
function mapDSP(p) { return { id: p.tokenAddress || Math.random().toString(36).substr(2, 8), n: (p.header || 'NEW').toUpperCase().slice(0, 12).replace(/\s/g, ''), src: 'DSP', pump: false, liq: rn(5000, 100000), vol1: rn(500, 20000), vol24: rn(5000, 200000), c5: rn(0, 30), c1: rn(-10, 80), c24: rn(-20, 200), bsr: rn(1.0, 3.5), txns: ri(10, 200), age: rn(0, 2), isNew: true, hot: Math.random() < 0.3, rug: Math.random() < 0.08, hp: false }; }
function mapJup(t) { return { id: t.address || Math.random().toString(36).substr(2, 8), n: (t.symbol || '???').toUpperCase().slice(0, 12), src: 'JUP', pump: false, liq: parseFloat(t.liquidity || 100000), vol1: (t.volume24h || 10000) / 24, vol24: parseFloat(t.volume24h || 10000), c5: parseFloat(t.priceChange5m || 0), c1: parseFloat(t.priceChange1h || 0), c24: parseFloat(t.priceChange24h || 0), bsr: rn(0.9, 2.5), txns: ri(20, 200), age: 30, isNew: false, hot: false, rug: Math.random() < 0.03, hp: false }; }
function mapDXP(p) { const liq = p.liquidity_usd || 50000, v24 = p.volume_usd_24h || 10000, c24 = p.price_change_24h || 0; return { id: p.id || Math.random().toString(36).substr(2, 8), n: (p.token_0_symbol || '???').toUpperCase().slice(0, 12), src: 'DXP', pump: false, liq, vol1: v24 / 24, vol24: v24, c5: c24 / 288, c1: c24 / 24, c24, bsr: rn(0.8, 2.5), txns: ri(20, 200), age: 30, isNew: false, hot: false, rug: Math.random() < 0.04, hp: false }; }
function mapCG(c) { const c1 = c.price_change_percentage_1h_in_currency || 0, mcap = c.market_cap || 1000000; return { id: c.id, n: (c.symbol || '???').toUpperCase().slice(0, 12), src: 'CGK', pump: false, liq: mcap * rn(0.03, 0.08), vol1: (c.total_volume || 0) / 24, vol24: c.total_volume || 0, c5: c1 / 12, c1, c24: c.price_change_percentage_24h || 0, bsr: c1 > 5 ? rn(1.4, 2.8) : c1 > 0 ? rn(1, 1.7) : rn(0.4, 1), txns: ri(20, 200), age: 720, isNew: false, hot: false, rug: Math.random() < 0.02, hp: false }; }
function rugChk(c1, c24, liq, bsr) { if (c1 < -60) return Math.random() < 0.55; if (c24 < -85) return Math.random() < 0.40; if (liq < 2000) return Math.random() < 0.40; if (bsr < 0.15) return Math.random() < 0.25; return Math.random() < 0.04; }

// ── SCORING ───────────────────────────────────────────────────
function score(t) {
  let s = 0, pos = [], neg = [], flags = [];
  const lp = t.liq > 2e6 ? 25 : t.liq > 5e5 ? 20 : t.liq > 1e5 ? 14 : t.liq > 3e4 ? 9 : t.liq > 1e4 ? 5 : t.liq > 2000 ? 2 : 0;
  s += lp;
  if (lp >= 20) pos.push(`Deep liq $${(t.liq/1000).toFixed(0)}k`); else if (lp >= 9) pos.push(`Liq $${(t.liq/1000).toFixed(0)}k`); else if (lp < 2) neg.push('Micro liq');
  const vr = t.vol1 / Math.max(t.vol24 / 24, 1);
  const vp = vr > 5 ? 20 : vr > 3 ? 16 : vr > 2 ? 12 : vr > 1.5 ? 7 : vr > 1 ? 3 : 0;
  s += vp;
  if (vp >= 16) pos.push(`Vol surge ${vr.toFixed(1)}x`); else if (vp >= 12) pos.push(`Vol ${vr.toFixed(1)}x`); else if (vp === 0) neg.push('Vol declining');
  const bp = t.bsr > 3 ? 20 : t.bsr > 2 ? 16 : t.bsr > 1.5 ? 11 : t.bsr > 1.2 ? 7 : t.bsr > 1 ? 3 : 0;
  s += bp;
  if (bp >= 16) pos.push(`Buys ${t.bsr.toFixed(1)}x`); else if (bp >= 11) pos.push(`Buying ${t.bsr.toFixed(1)}x`); else if (bp === 0) neg.push('Selling');
  const mp = t.c5 > 20 ? 15 : t.c5 > 10 ? 12 : t.c5 > 3 ? 8 : t.c5 > 0 ? 3 : t.c5 > -5 ? 0 : -2;
  s += Math.max(mp, 0);
  if (mp >= 12) pos.push(`+${t.c5.toFixed(1)}% 5m 🚀`); else if (mp >= 8) pos.push(`+${t.c5.toFixed(1)}% 5m`); else if (mp < 0) neg.push(`${t.c5.toFixed(1)}% 5m`);
  const hp = t.c1 > 50 ? 10 : t.c1 > 20 ? 7 : t.c1 > 5 ? 4 : t.c1 > 0 ? 1 : 0;
  s += hp; if (hp >= 7) pos.push(`+${t.c1.toFixed(0)}% 1h`);
  if (t.src === 'WS') { s += 20; pos.push('⚡ LIVE LAUNCH'); }
  else if (t.hot) { s += 15; pos.push('🔥<10min'); }
  else if (t.isNew) { s += 10; pos.push('🆕<1h'); }
  else if (t.age < 6) { s += 5; pos.push(`${t.age.toFixed(1)}h old`); }
  if (t.pump && t.isNew) { s += 5; pos.push('pump.fun'); }
  if (t.c1 > 300) { s = Math.floor(s * 0.20); flags.push('Mega pump⚠'); }
  else if (t.c1 > 150) { s = Math.floor(s * 0.35); flags.push('Big pump⚠'); }
  else if (t.c1 > 80) { s = Math.floor(s * 0.55); flags.push('Late⚠'); }
  if (t.bsr < 0.5) { s = Math.floor(s * 0.50); flags.push('Heavy sell⚠'); }
  if (t.liq < 1500) { s = Math.floor(s * 0.25); flags.push('Danger liq⚠'); }
  return { sc: Math.min(Math.round(s), 100), pos, neg, flags, all: [...pos, ...neg, ...flags] };
}

// ── TRADING ENGINE ────────────────────────────────────────────
function cl(v, a, b) { return Math.min(Math.max(v, a), b); }
function getSlip(liq, sz) { return cl(0.004 + (sz / Math.max(liq, 100)) * 2.5 + rn(0, 0.003), 0.003, 0.15); }
function getSize(fund, sc, liq, sl) { let p = sc >= 85 ? 0.08 : sc >= 75 ? 0.065 : sc >= 68 ? 0.05 : 0.04; if (liq < 5e4) p *= 0.65; if (liq < 1e4) p *= 0.50; if (sl > 0.05) p *= 0.75; return parseFloat((fund * Math.min(p, CFG.MAX_POS)).toFixed(4)); }
function getSL(sc, vol) { return cl(parseFloat(((sc >= 85 ? 0.12 : sc >= 75 ? 0.15 : 0.18) * (vol > 0.5 ? 1.3 : vol > 0.3 ? 1.1 : 1.0)).toFixed(2)), 0.10, 0.28); }
function getHold(sc, vol, fresh) { const b = fresh ? rn(5000, 20000) : sc >= 85 ? rn(30000, 180000) : sc >= 75 ? rn(15000, 90000) : rn(8000, 45000); return Math.floor(b * (vol > 0.5 ? 0.5 : vol > 0.3 ? 0.7 : 1.0)); }

function calcOutcome(t, sl) {
  if (t.rug) return { o: 'RUG', m: 1 - rn(0.70, 0.98), sl2: 0.8, pk: 0, cap: 0, slp: 0 };
  if (t.hp) return { o: 'HONEYPOT', m: 0.02, sl2: 1.0, pk: 0, cap: 0, slp: 0 };
  const es = getSlip(t.liq, t.tradeSize || 5);
  const lb = t.liq > 1e6 ? 0.04 : t.liq > 3e5 ? 0.03 : t.liq > 5e4 ? 0.02 : 0;
  const mb = t.c5 > 10 ? 0.05 : t.c5 > 3 ? 0.03 : 0;
  const bb = t.bsr > 2.5 ? 0.04 : t.bsr > 1.5 ? 0.02 : 0;
  const nb = t.src === 'WS' ? 0.06 : t.hot ? 0.05 : t.isNew ? 0.03 : 0;
  const wc = cl(CFG.WIN_BASE + lb + mb + bb + nb, 0.22, CFG.WIN_MAX);
  const win = Math.random() < wc;
  if (!win) { const lt = Math.random(); if (lt < 0.40) return { o: 'SL HIT', m: (1 - sl) * (1 - es), sl2: es, pk: 0, cap: 0, slp: sl }; if (lt < 0.65) return { o: 'MOMENTUM DIED', m: (1 - rn(0.05, 0.15)) * (1 - es), sl2: es, pk: 0, cap: 0, slp: 0 }; return { o: 'SMART MONEY OUT', m: (1 - rn(0.08, 0.18)) * (1 - es), sl2: es, pk: 0, cap: 0, slp: 0 }; }
  const mf = Math.random();
  let pk = mf > 0.92 ? rn(0.50, 5.0) : mf > 0.75 ? rn(0.15, 0.50) : mf > 0.45 ? rn(0.06, 0.15) : rn(0.01, 0.06);
  if (pk >= CFG.TRAIL_ACT) { const cap = pk - CFG.TRAIL_PB; return { o: 'TRAIL WIN', m: (1 + cap) * (1 - es), sl2: es, pk, cap, slp: 0 }; }
  return { o: 'NO ACTIVATE', m: (1 - rn(0.01, 0.05)) * (1 - es), sl2: es, pk, cap: 0, slp: 0 };
}

function closeTrade(id) {
  const i = S.open.findIndex(t => t.id === id); if (i === -1) return;
  const tr = S.open[i];
  const res = calcOutcome(tr.tok, tr.sl);
  const pnl = tr.size * res.m - tr.size - CFG.SOL_GAS;
  let cr = res.o === 'RUG' ? '🚨 Rug' : res.o === 'HONEYPOT' ? '🍯 HP' : res.o === 'TRAIL WIN' ? `📈 Trail +${(res.pk*100).toFixed(0)}%→+${(res.cap*100).toFixed(0)}%` : res.o === 'NO ACTIVATE' ? `📈 Peak +${(res.pk*100).toFixed(0)}%` : res.o === 'SL HIT' ? `🛑 SL -${(res.slp*100).toFixed(0)}%` : res.o === 'MOMENTUM DIED' ? '📉 Momentum' : res.o === 'SMART MONEY OUT' ? '🐋 Smart$' : '❌ Loss';
  if (pnl > 0) { S.fund = parseFloat((S.fund + pnl * 0.80).toFixed(4)); S.savings = parseFloat((S.savings + pnl * 0.20).toFixed(4)); log(`✅ ${tr.tok.src==='WS'?'⚡':''}${tr.tok.n} +$${pnl.toFixed(2)} | saved $${(pnl*0.20).toFixed(2)} | ${cr}`, 'win'); }
  else { S.fund = parseFloat((S.fund + pnl).toFixed(4)); log(`❌ ${tr.tok.n} -$${Math.abs(pnl).toFixed(2)} | ${cr}`, res.o === 'RUG' || res.o === 'HONEYPOT' ? 'rug' : 'loss'); }
  S.stats.t++; if (pnl > 0) S.stats.w++; else if (res.o === 'RUG' || res.o === 'HONEYPOT') S.stats.r++; else S.stats.l++;
  S.closed.unshift({ tok: tr.tok, closeReason: cr, pnl: parseFloat(pnl.toFixed(4)) });
  if (S.closed.length > 200) S.closed.pop();
  S.open.splice(i, 1);
  if ((100 - S.fund) / 100 >= CFG.LOSS_LIM) { log('⛔ Daily loss -10% — bot paused', 'rug'); stopBot(); }
}

let scanI = null, scanIdx = 0;
function runScan() {
  if (!S.running || S.tokens.size === 0) return;
  if (S.fund < 1) { stopBot(); return; }
  const tokens = Array.from(S.tokens.values());
  const tok = tokens[scanIdx % tokens.length]; scanIdx++; S.scanCount++;
  const { sc, pos, neg, flags, all } = score(tok);
  const src = `[${tok.src}]`;
  if (tok.hp) { S.rejectCount++; log(`🍯 SKIP ${tok.n} ${src} — HONEYPOT`, 'reject'); return; }
  if (tok.rug) { S.rejectCount++; log(`🚨 SKIP ${tok.n} ${src} — RUG`, 'reject'); return; }
  if (sc < CFG.MIN_SCORE) { S.rejectCount++; log(`❌ SKIP ${tok.n} ${src} — Score ${sc}/${CFG.MIN_SCORE} | ${[...neg.slice(0,2),...flags.slice(0,1)].join(' | ')||'weak'}`, 'reject'); return; }
  if (S.open.length >= CFG.MAX_OPEN) return;
  if (S.open.find(t => t.tok.n === tok.n)) return;
  const es = getSlip(tok.liq, S.fund * 0.08);
  const size = getSize(S.fund, sc, tok.liq, es);
  if (size < 0.50) { S.rejectCount++; return; }
  S.fund = parseFloat((S.fund - size * es).toFixed(4));
  const vol = Math.abs(tok.c24 || 30) / 100;
  const sl = getSL(sc, vol);
  const ht = getHold(sc, vol, tok.isNew || tok.pump || tok.src === 'WS');
  const trade = { id: Math.random().toString(36).substr(2, 9), tok: { ...tok, tradeSize: size }, sc, reasons: all, size: parseFloat(size.toFixed(4)), tpl: 'TRAIL+5/−2', sl, es, openedAt: new Date().toLocaleTimeString(), startTime: Date.now() };
  S.open.push(trade);
  const tag = tok.src === 'WS' ? '⚡ LIVE ' : tok.hot ? '🔥 ' : tok.isNew ? '🆕 ' : '';
  log(`🎯 ENTER ${tag}${tok.n} ${src} | Score ${sc} | TRAIL+5/−2 | SL -${(sl*100).toFixed(0)}% | $${size.toFixed(2)} | ${pos.slice(0,3).join(' | ')}`, 'entry');
  setTimeout(() => closeTrade(trade.id), ht);
  if (tok.rug) setTimeout(() => { if (S.open.find(x => x.id === trade.id)) closeTrade(trade.id); }, ri(3000, Math.min(60000, ht - 1000)));
}

function startBot() { if (S.running) return; S.running = true; S.startTime = Date.now(); connectPump(); fetchAll(); scanI = setInterval(runScan, 200); setInterval(fetchAll, 30000); log('🚀 V11 Server started · pump.fun WS + DSC + JUP + DXP + CGK · score 68+', 'info'); }
function stopBot() { S.running = false; clearInterval(scanI); log('⏹ Bot stopped', 'info'); }

// ── API ROUTES ────────────────────────────────────────────────
app.get('/api/state', (req, res) => res.json({ fund: S.fund, savings: S.savings, stats: S.stats, running: S.running, pumpLive: S.pumpLive, pumpCount: S.pumpCount, poolSize: S.tokens.size, scanCount: S.scanCount, rejectCount: S.rejectCount, openTrades: S.open, closedTrades: S.closed.slice(0, 20), logs: S.logs.slice(0, 100), sources: S.sources, startTime: S.startTime }));
app.post('/api/start', (req, res) => { startBot(); res.json({ success: true }); });
app.post('/api/stop', (req, res) => { stopBot(); res.json({ success: true }); });
app.post('/api/sell/:id', (req, res) => { closeTrade(req.params.id); res.json({ success: true }); });

// ── DASHBOARD HTML ────────────────────────────────────────────
const DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MEME BOT V11 — Server</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap');
:root{--bg:#04080d;--panel:#080f18;--border:#0d2035;--bb:#1a4060;--green:#00ff88;--gd:#00cc6a;--red:#ff3d5a;--yellow:#ffc233;--blue:#33b5ff;--purple:#bb88ff;--text:#e8f4ff;--dim:#7a9ab0;--scan:rgba(0,255,136,0.03);}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Share Tech Mono',monospace;min-height:100vh;padding-bottom:40px;}
body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,var(--scan) 2px,var(--scan) 4px);pointer-events:none;z-index:1000;}
.wrap{max-width:520px;margin:0 auto;padding:16px;}
.hdr{text-align:center;padding:14px 0 10px;}.hdr::after{content:'';display:block;height:1px;background:linear-gradient(90deg,transparent,var(--green),transparent);margin-top:10px;opacity:0.4;}
.htag{font-size:9px;letter-spacing:4px;color:var(--green);margin-bottom:4px;}
.htitle{font-family:'Orbitron',monospace;font-size:24px;font-weight:900;color:#fff;letter-spacing:3px;text-shadow:0 0 20px rgba(0,255,136,0.4);}
.hsub{font-size:9px;color:var(--dim);margin-top:3px;letter-spacing:2px;}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:4px;animation:pulse 1.5s infinite;vertical-align:middle;}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 6px var(--green);}50%{opacity:0.4;}}
.topbar{display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:8px;}
.sbar{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:7px 12px;font-size:9px;color:var(--dim);}
.tbox{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:7px 10px;text-align:center;min-width:78px;}
.tval{font-family:'Orbitron',monospace;font-size:11px;color:var(--green);margin-top:1px;}
.tlbl{font-size:7px;color:var(--dim);letter-spacing:1px;}
.srow{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px;}
.spill{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:5px 8px;text-align:center;}
.sl2{font-size:7px;color:var(--dim);letter-spacing:1px;}.sv{font-family:'Orbitron',monospace;font-size:12px;font-weight:700;margin-top:1px;}
.srcrow{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;}
.bdg{padding:2px 6px;border-radius:4px;font-size:7px;letter-spacing:1px;}
.bdg.live{background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.3);color:var(--green);}
.bdg.dead{background:rgba(255,61,90,0.1);border:1px solid rgba(255,61,90,0.3);color:var(--red);}
.bdg.ws{background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.5);color:var(--green);animation:wsp 2s infinite;}
@keyframes wsp{0%,100%{opacity:1;}50%{opacity:0.6;}}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;position:relative;overflow:hidden;}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--bb),transparent);}
.csm{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:7px 5px;text-align:center;}
.lbl{font-size:8px;letter-spacing:2px;color:var(--dim);margin-bottom:5px;text-transform:uppercase;}
.lsm{font-size:7px;color:var(--dim);letter-spacing:1px;margin-bottom:3px;}
.vlg{font-family:'Orbitron',monospace;font-size:19px;font-weight:700;}.vmd{font-family:'Orbitron',monospace;font-size:13px;font-weight:700;margin-top:2px;}
.sub{font-size:9px;color:var(--dim);margin-top:3px;}
.sbtn{width:100%;padding:14px;border-radius:10px;border:1px solid;cursor:pointer;font-size:12px;font-family:'Orbitron',monospace;font-weight:700;letter-spacing:4px;margin-bottom:10px;}
.otrade{background:var(--panel);border:1px solid #0d2a45;border-left:3px solid var(--blue);border-radius:8px;padding:9px 11px;margin-bottom:7px;}
.otop{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;}
.sell{padding:5px 10px;border-radius:5px;border:1px solid var(--yellow);background:transparent;color:var(--yellow);cursor:pointer;font-size:9px;font-family:'Share Tech Mono',monospace;font-weight:bold;}
.logwrap{position:relative;margin-bottom:10px;}
.fbar2{position:absolute;top:0;left:0;right:0;background:rgba(255,194,51,0.15);border:1px solid rgba(255,194,51,0.4);border-radius:8px 8px 0 0;padding:5px 12px;font-size:9px;color:var(--yellow);display:none;z-index:10;text-align:center;}
.logbox{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;max-height:300px;overflow-y:auto;}
.logbox::-webkit-scrollbar{width:3px;}.logbox::-webkit-scrollbar-thumb{background:var(--bb);border-radius:3px;}
.le{font-size:9px;padding:3px 0;border-bottom:1px solid rgba(13,32,53,0.4);line-height:1.6;}
.le.reject{color:#c87070;}.le.win{color:var(--green);}.le.loss{color:#ff7a7a;}.le.rug{color:var(--yellow);}.le.info{color:#8ab4cc;}.le.warn{color:var(--yellow);}.le.entry{color:#66ccff;}.le.pump{color:#ffd700;}
.lt{color:#4a7090;margin-right:5px;}
.hrow{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(13,32,53,0.8);font-size:10px;}
.lfrow{display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;}
.lfb{padding:2px 7px;border-radius:4px;border:1px solid var(--bb);cursor:pointer;font-size:8px;font-family:'Share Tech Mono',monospace;background:transparent;color:var(--dim);}
.lfb.act{background:var(--bb);color:var(--text);}
.slbl{font-size:8px;letter-spacing:3px;color:var(--dim);margin-bottom:7px;display:flex;align-items:center;gap:8px;}
.slbl::after{content:'';flex:1;height:1px;background:var(--border);}
.wsbar{background:rgba(255,215,0,0.06);border:1px solid rgba(255,215,0,0.2);border-radius:8px;padding:6px 12px;font-size:9px;color:#ffd700;margin-bottom:8px;}
.ib{display:inline-block;padding:1px 4px;border-radius:3px;font-size:7px;font-weight:bold;margin-left:2px;}
.ip{background:rgba(255,194,51,0.15);color:var(--yellow);border:1px solid rgba(255,194,51,0.3);}
.in{background:rgba(187,136,255,0.15);color:var(--purple);border:1px solid rgba(187,136,255,0.3);}
.foot{text-align:center;font-size:8px;color:var(--bb);margin-top:16px;letter-spacing:2px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div class="htag"><span class="dot"></span>SNIPER V11 · SERVER MODE · 24/7</div>
    <div class="htitle">MEME BOT SIM</div>
    <div class="hsub">SOLANA · PUMP.FUN LIVE · ALL SOURCES · PAPER TRADING</div>
  </div>
  <div class="topbar">
    <div class="sbar" id="status">⬡ CONNECTING...</div>
    <div class="tbox"><div class="tlbl">RUNTIME</div><div class="tval" id="tv">00:00:00</div></div>
  </div>
  <div class="wsbar" id="wsbar">⬡ PUMP.FUN WEBSOCKET: CONNECTING...</div>
  <div class="srow">
    <div class="spill"><div class="sl2">POOL</div><div class="sv" id="pool" style="color:var(--blue)">0</div></div>
    <div class="spill"><div class="sl2">SCANNED</div><div class="sv" id="scanned" style="color:var(--dim)">0</div></div>
    <div class="spill"><div class="sl2">PUMP LIVE</div><div class="sv" id="pumpCnt" style="color:var(--yellow)">0</div></div>
  </div>
  <div class="srcrow" id="srcrow"></div>
  <div class="g2">
    <div class="card"><div class="lbl">TRADING FUND</div><div class="vlg" id="fund" style="color:var(--green)">$100.00</div><div class="sub" id="alltime">+$0.00 all time</div></div>
    <div class="card"><div class="lbl">SAVINGS</div><div class="vlg" id="savings" style="color:var(--yellow)">$0.00</div><div class="sub">20% of profits</div></div>
  </div>
  <div class="g4">
    <div class="csm"><div class="lsm">WIN RATE</div><div class="vmd" id="wr" style="color:var(--green)">0%</div></div>
    <div class="csm"><div class="lsm">WINS</div><div class="vmd" id="wins" style="color:var(--green)">0</div></div>
    <div class="csm"><div class="lsm">LOSSES</div><div class="vmd" id="losses" style="color:var(--red)">0</div></div>
    <div class="csm"><div class="lsm">RUGS</div><div class="vmd" id="rugs" style="color:var(--yellow)">0</div></div>
  </div>
  <button class="sbtn" id="startBtn" onclick="toggleBot()" style="background:linear-gradient(135deg,#062a12,#0a3d1a);color:var(--green);border-color:var(--gd)">▶ START BOT</button>
  <div id="openSec" style="margin-bottom:10px;display:none">
    <div class="slbl">OPEN TRADES <span id="openCnt" style="color:var(--blue)"></span></div>
    <div id="openList"></div>
  </div>
  <div class="logwrap">
    <div class="fbar2" id="frozbar">📌 LOG PAUSED — scroll to top to resume</div>
    <div class="logbox" id="logbox">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div class="lbl" style="margin:0">ACTIVITY LOG</div>
        <div style="font-size:8px;color:var(--dim)" id="lcnt">0 entries</div>
      </div>
      <div class="lfrow">
        <button class="lfb act" onclick="setF('all')">ALL</button>
        <button class="lfb" onclick="setF('entry')">ENTRIES</button>
        <button class="lfb" onclick="setF('reject')">REJECTED</button>
        <button class="lfb" onclick="setF('win')">WINS</button>
        <button class="lfb" onclick="setF('loss')">LOSSES</button>
        <button class="lfb" onclick="setF('pump')">🔥PUMP</button>
      </div>
      <div id="loglist"><div style="font-size:10px;color:var(--dim)">Connecting to server...</div></div>
    </div>
  </div>
  <div id="histSec" class="card" style="display:none;margin-bottom:10px">
    <div class="lbl" style="margin-bottom:7px">CLOSED TRADES</div>
    <div id="histList"></div>
  </div>
  <div class="foot">PAPER TRADING · SNIPER V11 SERVER · 24/7</div>
</div>
<script>
let botRunning=false,logFilter='all',allLogs=[],frozen=false,startTime=null,timI=null;
const lb=document.getElementById('logbox'),fb=document.getElementById('frozbar');
lb.addEventListener('scroll',()=>{if(lb.scrollTop<30&&frozen){frozen=false;fb.style.display='none';renderLog();}else if(lb.scrollTop>=30&&!frozen){frozen=true;fb.style.display='block';}},{passive:true});
function f2(n){return parseFloat(n).toFixed(2);}
function fp(n){return(n*100).toFixed(1)+'%';}
function setF(f){logFilter=f;document.querySelectorAll('.lfb').forEach(b=>b.classList.toggle('act',(f==='all'&&b.textContent==='ALL')||b.textContent.toLowerCase().includes(f)&&f!=='all'));if(!frozen)renderLog();}
function renderLog(){const el=document.getElementById('loglist');const fl=logFilter==='all'?allLogs:allLogs.filter(e=>e.type===logFilter);el.innerHTML='';fl.slice(0,150).forEach(e=>{const d=document.createElement('div');d.className='le '+e.type;d.innerHTML='<span class="lt">'+e.time+'</span>'+e.msg;el.appendChild(d);});if(lb.scrollTop<30)lb.scrollTop=0;}
function startTimer(st){startTime=st||Date.now();if(timI)clearInterval(timI);timI=setInterval(()=>{const s=Math.floor((Date.now()-startTime)/1000);document.getElementById('tv').textContent=Math.floor(s/3600).toString().padStart(2,'0')+':'+Math.floor((s%3600)/60).toString().padStart(2,'0')+':'+(s%60).toString().padStart(2,'0');},1000);}
async function toggleBot(){await fetch(botRunning?'/api/stop':'/api/start',{method:'POST'});}
async function sell(id){await fetch('/api/sell/'+id,{method:'POST'});}
async function fetchState(){
  try{
    const res=await fetch('/api/state');const data=await res.json();
    botRunning=data.running;
    const btn=document.getElementById('startBtn');
    if(data.running){btn.style.background='linear-gradient(135deg,#3d0000,#5c0a0a)';btn.style.color='var(--red)';btn.style.borderColor='var(--red)';btn.textContent='⏹ STOP BOT';}
    else{btn.style.background='linear-gradient(135deg,#062a12,#0a3d1a)';btn.style.color='var(--green)';btn.style.borderColor='var(--gd)';btn.textContent='▶ START BOT';}
    const pnl=(data.fund+data.savings)-100;
    const fe=document.getElementById('fund');fe.textContent='$'+f2(data.fund);fe.style.color=data.fund>=100?'var(--green)':'var(--red)';
    document.getElementById('savings').textContent='$'+f2(data.savings);
    document.getElementById('alltime').textContent=(pnl>=0?'+':'')+('$'+f2(pnl))+' all time';
    document.getElementById('wr').textContent=data.stats.t>0?((data.stats.w/data.stats.t)*100).toFixed(1)+'%':'0%';
    document.getElementById('wins').textContent=data.stats.w;
    document.getElementById('losses').textContent=data.stats.l;
    document.getElementById('rugs').textContent=data.stats.r;
    document.getElementById('pool').textContent=data.poolSize;
    document.getElementById('scanned').textContent=data.scanCount;
    document.getElementById('pumpCnt').textContent=data.pumpCount;
    if(data.startTime)startTimer(data.startTime);
    const wsbar=document.getElementById('wsbar');
    if(data.pumpLive){wsbar.textContent='⚡ PUMP.FUN WEBSOCKET: LIVE — '+data.pumpCount+' tokens streamed';wsbar.style.color='var(--green)';}
    else{wsbar.textContent='⬡ PUMP.FUN WEBSOCKET: CONNECTING...';wsbar.style.color='var(--yellow)';}
    document.getElementById('status').textContent=data.running?'⬡ RUNNING · '+data.poolSize+' TOKENS · '+data.scanCount+' SCANNED':'⬡ STANDBY';
    const srcrow=document.getElementById('srcrow');srcrow.innerHTML='';
    Object.entries(data.sources||{}).forEach(([name,info])=>{const d=document.createElement('div');const live=info.startsWith('live');d.className='bdg '+(live?(name==='PUMP.FUN'?'ws':'live'):'dead');const cnt=live?info.split(':')[1]:'';d.textContent=(live?'●':'✕')+' '+name+(cnt?' '+cnt:'');srcrow.appendChild(d);});
    if(data.logs&&data.logs.length>0){allLogs=data.logs;document.getElementById('lcnt').textContent=allLogs.length+' entries';if(!frozen)renderLog();}
    const openSec=document.getElementById('openSec'),openList=document.getElementById('openList');
    if(data.openTrades&&data.openTrades.length>0){openSec.style.display='block';document.getElementById('openCnt').textContent='('+data.openTrades.length+')';openList.innerHTML='';data.openTrades.forEach(t=>{const el=Math.floor((Date.now()-t.startTime)/1000);const d=document.createElement('div');d.className='otrade';const liveb=t.tok.src==='WS'?'<span class="ib ip">⚡LIVE</span>':'';const hotb=t.tok.hot&&t.tok.src!=='WS'?'<span class="ib ip">🔥</span>':'';const newb=!t.tok.hot&&t.tok.isNew?'<span class="ib in">NEW</span>':'';d.innerHTML='<div class="otop"><div style="color:var(--blue);font-weight:bold;font-size:13px;font-family:Orbitron,monospace">'+t.tok.n+liveb+hotb+newb+'</div><button class="sell" onclick="sell(\''+t.id+'\')">SELL</button></div><div style="font-size:9px;color:var(--dim)">Score '+t.sc+' · '+t.tpl+' · $'+f2(t.size)+' · '+el+'s · ['+t.tok.src+']</div><div style="font-size:8px;color:var(--text);margin-top:3px;opacity:0.85">'+(t.reasons||[]).slice(0,3).join(' · ')+'</div>';openList.appendChild(d);});}
    else openSec.style.display='none';
    const histSec=document.getElementById('histSec'),histList=document.getElementById('histList');
    if(data.closedTrades&&data.closedTrades.length>0){histSec.style.display='block';histList.innerHTML='';data.closedTrades.slice(0,15).forEach(t=>{const d=document.createElement('div');d.className='hrow';d.innerHTML='<span style="color:var(--blue);width:65px;overflow:hidden;white-space:nowrap;font-size:10px">'+(t.tok.src==='WS'?'⚡':'')+t.tok.n+'</span><span style="color:var(--dim);font-size:8px;flex:1;padding:0 4px;overflow:hidden;white-space:nowrap">'+t.closeReason+'</span><span style="color:'+(t.pnl>0?'var(--green)':'var(--red)')+';font-weight:bold;font-family:Orbitron,monospace;font-size:11px;white-space:nowrap">'+(t.pnl>0?'+':'')+'$'+f2(t.pnl)+'</span>';histList.appendChild(d);});}
    else histSec.style.display='none';
  }catch(e){document.getElementById('status').textContent='⬡ CONNECTING TO SERVER...';}
}
setInterval(fetchState,2000);fetchState();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(DASHBOARD));

app.listen(PORT, () => {
  console.log(`🚀 MemeBot V11 Server on port ${PORT}`);
  connectPump();
  fetchAll();
});
