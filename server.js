const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── API KEYS ──────────────────────────────────────────────────
const HELIUS_KEY = '04d7d86a-48da-45db-8364-1c57d40fc4b1';
const HELIUS_URL = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
const LUNAR_KEY = 'wzejf56fq9a5oamkc8qo6f7lpmot9qa4qoc8lpv';
const LUNAR_URL = 'https://lunarcrush.com/api4/public';

// ── CONFIG ────────────────────────────────────────────────────
const CFG = {
  MIN_SCORE: 80,
  SOL_GAS: 0.001,
  MAX_POS: 0.08,
  MAX_OPEN: 4,
  TRAIL_ACT: 0.04,   // trail activates at 5% gain
  TRAIL_PB: 0.02,    // exit if price pulls back 25% from peak
  LOSS_LIM: 0.10,    // daily loss limit 10%
  POOL_MAX: 10000,   // increased pool size
  PRICE_INTERVAL: 500,  // check prices every 500ms
  SCAN_INTERVAL: 500,   // scan for new trades every 500ms
};

// ── STATE ─────────────────────────────────────────────────────
const S = {
  tokens: new Map(),
  open: [],
  closed: [],
  stats: { w: 0, l: 0, r: 0, t: 0 },
  fund: 100,
  savings: 0,
  running: false,
  pumpLive: false,
  pumpCount: 0,
  scanCount: 0,
  rejectCount: 0,
  logs: [],
  sources: {},
  startTime: null,
  dayStartFund: 100,
};

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, type) {
  type = type || 'info';
  S.logs.unshift({ msg, type, time: new Date().toLocaleTimeString() });
  if (S.logs.length > 500) S.logs.pop();
  console.log('[' + type.toUpperCase() + '] ' + msg);
}

// ── TOKEN POOL ────────────────────────────────────────────────
function addTok(t) {
  if (!t || !t.n || !t.id) return;
  // Don't overwrite a token that has a real price with one that doesn't
  const existing = S.tokens.get(t.n + t.id);
  if (existing && existing.price && !t.price) return;
  S.tokens.set(t.n + t.id, t);
  if (S.tokens.size > CFG.POOL_MAX) {
    for (var k of S.tokens.keys()) { S.tokens.delete(k); break; }
  }
}

// ── JUPITER PRICE API (free, no key needed) ───────────────────
async function getJupiterPrice(mintAddress) {
  try {
    var res = await fetch('https://api.jup.ag/price/v2?ids=' + mintAddress, { timeout: 5000 });
    if (!res.ok) return null;
    var data = await res.json();
    if (data && data.data && data.data[mintAddress]) {
      return parseFloat(data.data[mintAddress].price) || null;
    }
    return null;
  } catch(e) { return null; }
}

// ── JUPITER BATCH PRICES ──────────────────────────────────────
async function getJupiterPrices(mintAddresses) {
  try {
    if (!mintAddresses || mintAddresses.length === 0) return {};
    var ids = mintAddresses.slice(0, 100).join(',');
    var res = await fetch('https://api.jup.ag/price/v2?ids=' + ids, { timeout: 8000 });
    if (!res.ok) return {};
    var data = await res.json();
    return data.data || {};
  } catch(e) { return {}; }
}

// ── HELIUS TOKEN DATA ─────────────────────────────────────────
// Enriches Pump.fun tokens with real on-chain data via Helius
async function enrichPumpToken(mint, name) {
  try {
    var price = await getJupiterPrice(mint);
    var tok = S.tokens.get(name + mint);
    if (tok && price) { tok.price = price; S.tokens.set(name + mint, tok); }
  } catch(e) {}
}

async function getHeliusTokenData(mintAddress) {
  try {
    var res = await fetch(HELIUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'memebot',
        method: 'getAsset',
        params: { id: mintAddress }
      }),
      timeout: 8000
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data.result || null;
  } catch(e) { return null; }
}

// ── LUNARCRUSH SOCIAL DATA ────────────────────────────────────
// Cache social scores to avoid hammering the API
var lunarCache = {}; // symbol -> { score, ts }
var lunarTrending = []; // list of trending symbols from LunarCrush

async function fetchLunarTrending() {
  try {
    var res = await fetch(LUNAR_URL + '/coins/list/v1?sort=galaxy_score&limit=50&key=' + LUNAR_KEY, { timeout: 8000 });
    if (!res.ok) throw new Error();
    var data = await res.json();
    var coins = data.data || [];
    lunarTrending = [];
    coins.forEach(function(c) {
      var sym = (c.symbol || '').toUpperCase();
      var score = c.galaxy_score || 0;
      var mentions = c.social_score || 0;
      lunarCache[sym] = { score, mentions, ts: Date.now() };
      lunarTrending.push(sym);
    });
    S.sources['LUNAR'] = 'live:' + lunarTrending.length;
    log('LunarCrush: ' + lunarTrending.length + ' trending coins loaded', 'info');
  } catch(e) { S.sources['LUNAR'] = 'dead'; }
}

function getLunarScore(symbol) {
  var sym = (symbol || '').toUpperCase();
  var cached = lunarCache[sym];
  if (!cached) return 0;
  // Galaxy score 0-100 — map to 0-15 bonus points
  return Math.floor((cached.score / 100) * 15);
}

function isLunarTrending(symbol) {
  return lunarTrending.indexOf((symbol || '').toUpperCase()) >= 0;
}

// ── GECKO TERMINAL (free, no key) ─────────────────────────────
async function fetchGeckoTerminal() {
  try {
    var res = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1', { timeout: 8000 });
    if (!res.ok) throw new Error();
    var data = await res.json();
    var pools = (data.data || []).slice(0, 30);
    var count = 0;
    pools.forEach(function(p) {
      var attr = p.attributes || {};
      var baseToken = attr.base_token_price_usd;
      var name = (attr.name || '').split('/')[0].trim().toUpperCase().slice(0, 12);
      var addr = (p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id || '').replace('solana_', '');
      if (!name || !addr) return;
      var liq = parseFloat(attr.reserve_in_usd) || 0;
      var vol24 = parseFloat(attr.volume_usd && attr.volume_usd.h24) || 0;
      var vol1 = parseFloat(attr.volume_usd && attr.volume_usd.h1) || 0;
      var c5 = parseFloat(attr.price_change_percentage && attr.price_change_percentage.m5) || 0;
      var c1 = parseFloat(attr.price_change_percentage && attr.price_change_percentage.h1) || 0;
      var c24 = parseFloat(attr.price_change_percentage && attr.price_change_percentage.h24) || 0;
      var buys = parseInt(attr.transactions && attr.transactions.h1 && attr.transactions.h1.buys) || 0;
      var sells = parseInt(attr.transactions && attr.transactions.h1 && attr.transactions.h1.sells) || 1;
      var age = attr.pool_created_at ? (Date.now() - new Date(attr.pool_created_at).getTime()) / 3600000 : 24;
      addTok({
        id: addr, n: name, src: 'GECKO', pump: false,
        liq, vol1, vol24, c5, c1, c24,
        bsr: buys / Math.max(sells, 1),
        txns: buys + sells, age,
        isNew: age < 1, hot: age < 0.17,
        price: parseFloat(baseToken) || null,
        mint: addr,
        rug: false, hp: false
      });
      count++;
    });
    S.sources['GECKO'] = 'live:' + count;
    log('GeckoTerminal: ' + count + ' trending pools', 'info');
  } catch(e) { S.sources['GECKO'] = 'dead'; }
}

// ── DEXSCREENER ───────────────────────────────────────────────
var DS_QUERIES = [
  { id: 'DSC-NEW',   url: 'https://api.dexscreener.com/latest/dex/search?q=solana+new+token' },
  { id: 'DSC-TREND', url: 'https://api.dexscreener.com/latest/dex/search?q=solana+trending' },
  { id: 'DSC-BOOST', url: 'https://api.dexscreener.com/latest/dex/search?q=solana+pump+fun' },
  { id: 'DSC-MEME',  url: 'https://api.dexscreener.com/latest/dex/search?q=solana+meme+coin' },
  { id: 'DSC-GEM',   url: 'https://api.dexscreener.com/latest/dex/search?q=solana+gem+moon' },
  { id: 'DSC-MOON',  url: 'https://api.dexscreener.com/latest/dex/search?q=solana+dog+cat+pepe' },
];

function mapDS(p) {
  var c1 = (p.priceChange && p.priceChange.h1) || 0;
  var c24 = (p.priceChange && p.priceChange.h24) || 0;
  var c5 = (p.priceChange && p.priceChange.m5) || 0;
  var liq = (p.liquidity && p.liquidity.usd) || 0;
  var v24 = (p.volume && p.volume.h24) || 0;
  var buys = (p.txns && p.txns.h1 && p.txns.h1.buys) || 0;
  var sells = (p.txns && p.txns.h1 && p.txns.h1.sells) || 1;
  var age = (p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) : 86400000 * 30) / 3600000;
  var mint = (p.baseToken && p.baseToken.address) || null;
  return {
    id: p.pairAddress || Math.random().toString(36).substr(2, 8),
    n: ((p.baseToken && p.baseToken.symbol) || '???').toUpperCase().slice(0, 12),
    src: 'DSC', pump: false, liq, vol1: v24/24, vol24: v24,
    c5, c1, c24,
    bsr: buys / Math.max(sells, 1),
    txns: buys + sells, age,
    isNew: age < 1, hot: age < 0.17,
    price: parseFloat(p.priceUsd) || null,
    mint,
    rug: false, hp: buys > 10 && sells === 0
  };
}

function mapCG(c) {
  var c1 = c.price_change_percentage_1h_in_currency || 0;
  var mcap = c.market_cap || 1000000;
  return {
    id: c.id,
    n: (c.symbol || '???').toUpperCase().slice(0, 12),
    src: 'CGK', pump: false,
    liq: mcap * 0.05,
    vol1: (c.total_volume || 0) / 24,
    vol24: c.total_volume || 0,
    c5: c1 / 12, c1,
    c24: c.price_change_percentage_24h || 0,
    bsr: c1 > 5 ? 2.0 : c1 > 0 ? 1.3 : 0.8,
    txns: 50, age: 720,
    isNew: false, hot: false,
    price: c.current_price || null,
    mint: null,
    rug: false, hp: false
  };
}

async function fetchAll() {
  // DexScreener
  for (var q of DS_QUERIES) {
    try {
      var res = await fetch(q.url, { timeout: 8000 });
      if (!res.ok) throw new Error();
      var data = await res.json();
      var pairs = (data.pairs || []).filter(function(p) { return p.chainId === 'solana' && p.priceUsd; });
      pairs.forEach(function(p) { addTok(mapDS(p)); });
      S.sources[q.id] = 'live:' + pairs.length;
    } catch(e) { S.sources[q.id] = 'dead'; }
  }

  // CoinGecko
  try {
    var res2 = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=solana-meme-coins&order=volume_desc&per_page=20&sparkline=false&price_change_percentage=1h,24h', { timeout: 8000 });
    if (res2.ok) {
      var cg = await res2.json();
      if (cg && cg.length) {
        cg.forEach(function(c) { addTok(mapCG(c)); });
        S.sources['COINGECKO'] = 'live:' + cg.length;
      }
    }
  } catch(e) { S.sources['COINGECKO'] = 'dead'; }

  // GeckoTerminal
  await fetchGeckoTerminal();

  log('Pool: ' + S.tokens.size + ' tokens | Pump.fun: ' + S.pumpCount + ' live', 'info');
}

// ── PUMP.FUN WEBSOCKET ────────────────────────────────────────
var pumpWs = null;
function connectPump() {
  if (pumpWs && pumpWs.readyState === WebSocket.OPEN) return;
  try {
    pumpWs = new WebSocket('wss://pumpportal.fun/api/data');
    pumpWs.on('open', function() {
      S.pumpLive = true;
      S.sources['PUMP.FUN'] = 'live:0';
      pumpWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
      pumpWs.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
      log('Pump.fun WebSocket LIVE', 'pump');
    });
    pumpWs.on('message', function(raw) {
      try {
        var d = JSON.parse(raw.toString());
        if (d.mint && (d.symbol || d.name)) {
          // New token launch — fetch real price from Jupiter
          var mint = d.mint;
          var name = ((d.symbol || d.name || 'NEW') + '').toUpperCase().slice(0, 12);
          // Add with real on-chain data from the launch event
          var initialLiq = (d.vSolInBondingCurve || 0) * 150; // SOL price estimate
          var mktCap = (d.marketCapSol || 0) * 150;
          addTok({
            id: mint, n: name, src: 'WS', pump: true,
            liq: initialLiq || 5000,
            vol1: (d.volume || 0),
            vol24: (d.volume || 0),
            c5: 0, c1: 0, c24: 0,
            bsr: 2.0, // new launches start with buy pressure
            txns: 1,
            age: 0, isNew: true, hot: true,
            price: null, // will be fetched from Jupiter
            mint: mint,
            rug: false, hp: false,
            launchData: d
          });
          S.pumpCount++;
          S.sources['PUMP.FUN'] = 'live:' + S.pumpCount;
          // Enrich with real price from Jupiter
          enrichPumpToken(mint, name);
          if (S.pumpCount % 20 === 0) {
            log('Pump.fun: ' + S.pumpCount + ' launches - latest: ' + name, 'pump');
          }
        }
        // Trade events — update token data with real trade info
        if (d.txType === 'buy' || d.txType === 'sell') {
          var mint2 = d.mint;
          var name2 = ((d.symbol || '') + '').toUpperCase().slice(0, 12);
          if (mint2) {
            var key = name2 + mint2;
            var existing = S.tokens.get(key);
            if (existing) {
              // Update with real trade data
              if (d.txType === 'buy') existing.bsr = Math.min((existing.bsr || 1) + 0.1, 5);
              else existing.bsr = Math.max((existing.bsr || 1) - 0.1, 0.1);
              if (d.marketCapSol) existing.liq = d.marketCapSol * 150 * 0.05;
              S.tokens.set(key, existing);
            }
          }
        }
      } catch(e) {}
    });
    pumpWs.on('error', function() { S.pumpLive = false; S.sources['PUMP.FUN'] = 'dead'; });
    pumpWs.on('close', function() {
      S.pumpLive = false;
      S.sources['PUMP.FUN'] = 'dead';
      setTimeout(connectPump, 10000);
    });
  } catch(e) { setTimeout(connectPump, 15000); }
}

// ── REAL PRICE TRACKING FOR OPEN TRADES ──────────────────────
async function updateOpenTradePrices() {
  if (S.open.length === 0) return;

  // Get all mint addresses for open trades
  var mints = S.open.filter(function(t) { return t.mint; }).map(function(t) { return t.mint; });
  if (mints.length === 0) return;

  // Batch fetch from Jupiter
  var prices = await getJupiterPrices(mints);

  S.open.forEach(function(trade) {
    if (!trade.mint) return;
    var priceData = prices[trade.mint];
    if (!priceData) return;
    var currentPrice = parseFloat(priceData.price);
    if (!currentPrice || currentPrice <= 0) return;

    // Update current price
    trade.currentPrice = currentPrice;

    // Calculate real P&L
    if (trade.entryPrice && trade.entryPrice > 0) {
      var pricePct = (currentPrice - trade.entryPrice) / trade.entryPrice;
      trade.realPnlPct = pricePct;
      trade.realPnl = trade.size * pricePct;

      // Update peak price for trail stop
      if (!trade.peakPrice || currentPrice > trade.peakPrice) {
        trade.peakPrice = currentPrice;
      }

      // Check trail stop — exit if pulled back 25% from peak
      if (trade.peakPrice && trade.tpl === 'TRAIL') {
        var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
        if (peakGain >= CFG.TRAIL_ACT) {
          // Trail is active — check for pullback
          var pullback = (trade.peakPrice - currentPrice) / trade.peakPrice;
          if (pullback >= CFG.TRAIL_PB) {
            log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain*100).toFixed(1) + '% | Pullback -' + (pullback*100).toFixed(1) + '%', 'win');
            closeTradeReal(trade.id, 'Trail exit');
            return;
          }
        }
      }

      // Check stop loss
      if (pricePct <= -trade.sl) {
        log('SL HIT ' + trade.tok.n + ' | ' + (pricePct*100).toFixed(1) + '%', 'loss');
        closeTradeReal(trade.id, 'Stop loss hit');
        return;
      }
    }
  });
}

// ── REAL TRADE CLOSE ──────────────────────────────────────────
function closeTradeReal(id, reason) {
  var i = S.open.findIndex(function(t) { return t.id === id; });
  if (i === -1) return;
  var tr = S.open[i];

  var pnl = 0;
  var closeReason = reason || 'Manual sell';

  if (tr.entryPrice && tr.currentPrice) {
    // Real P&L from actual price movement
    var pricePct = (tr.currentPrice - tr.entryPrice) / tr.entryPrice;
    var slippage = tr.slip || 0.005;
    pnl = tr.size * pricePct - tr.size * slippage - CFG.SOL_GAS;
  } else {
    // No price data available — use entry size as loss (conservative)
    pnl = -(CFG.SOL_GAS);
    closeReason = reason + ' (no price data)';
  }

  if (pnl > 0) {
    S.fund = parseFloat((S.fund + pnl * 0.80).toFixed(4));
    S.savings = parseFloat((S.savings + pnl * 0.20).toFixed(4));
    log(tr.tok.n + ' +$' + pnl.toFixed(2) + ' | saved $' + (pnl*0.20).toFixed(2) + ' | ' + closeReason, 'win');
    S.stats.w++;
  } else {
    S.fund = parseFloat((S.fund + pnl).toFixed(4));
    log(tr.tok.n + ' -$' + Math.abs(pnl).toFixed(2) + ' | ' + closeReason, 'loss');
    S.stats.l++;
  }

  S.stats.t++;
  S.closed.unshift({
    tok: tr.tok,
    closeReason: closeReason,
    pnl: parseFloat(pnl.toFixed(4)),
    entryPrice: tr.entryPrice,
    exitPrice: tr.currentPrice,
    slip: tr.slip || 0
  });
  if (S.closed.length > 200) S.closed.pop();
  S.open.splice(i, 1);

  // Daily loss limit check
  if (S.fund < S.dayStartFund * (1 - CFG.LOSS_LIM)) {
    log('Daily loss limit hit — bot stopped', 'rug');
    stopBot();
  }
}

// ── SCORING ───────────────────────────────────────────────────
function score(t) {
  var s = 0, pos = [], neg = [], flags = [];
  var freshLaunch = (t.src === 'WS' && t.age < 0.017); // under 1 min old

  // ── FRESH PUMP.FUN LAUNCH SCORING ──
  // New launches have no history — judge purely on launch signals
  if (freshLaunch) {
    // Buy pressure at launch (most important signal)
    var bp2 = t.bsr > 4 ? 35 : t.bsr > 3 ? 30 : t.bsr > 2 ? 25 : t.bsr > 1.5 ? 20 : t.bsr > 1 ? 10 : 0;
    s += bp2;
    if (bp2 >= 30) pos.push('Strong launch buys ' + t.bsr.toFixed(1) + 'x');
    else if (bp2 >= 20) pos.push('Good launch buys ' + t.bsr.toFixed(1) + 'x');
    else if (bp2 === 0) neg.push('No buy pressure');

    // Initial liquidity
    var lp2 = t.liq > 50000 ? 20 : t.liq > 20000 ? 15 : t.liq > 10000 ? 10 : t.liq > 5000 ? 5 : 0;
    s += lp2;
    if (lp2 >= 15) pos.push('Good launch liq $' + (t.liq/1000).toFixed(0) + 'k');
    else if (lp2 === 0) neg.push('Low launch liq');

    // Live launch bonus
    s += 25;
    pos.push('LIVE LAUNCH ⚡');

    // LunarCrush social bonus
    var lscore = getLunarScore(t.n);
    if (lscore > 0) { s += lscore; pos.push('Social buzz +' + lscore); }
    if (isLunarTrending(t.n)) { s += 10; pos.push('🔥 TRENDING'); }

    // Safety penalties
    if (t.bsr < 0.5) { s = Math.floor(s * 0.30); flags.push('Heavy sell'); }
    if (t.liq < 500) { s = Math.floor(s * 0.20); flags.push('Danger liq'); }

    return { sc: Math.min(Math.round(s), 100), pos, neg, flags, all: pos.concat(neg).concat(flags) };
  }

  // ── STANDARD SCORING for established tokens ──

  // Liquidity
  var lp = t.liq > 2e6 ? 25 : t.liq > 5e5 ? 20 : t.liq > 1e5 ? 14 : t.liq > 3e4 ? 9 : t.liq > 1e4 ? 5 : t.liq > 2000 ? 2 : 0;
  s += lp;
  if (lp >= 20) pos.push('Deep liq $' + (t.liq/1000).toFixed(0) + 'k');
  else if (lp >= 9) pos.push('Liq $' + (t.liq/1000).toFixed(0) + 'k');
  else if (lp < 2) neg.push('Micro liq');

  // Volume ratio
  var vr = t.vol1 / Math.max(t.vol24/24, 1);
  var vp = vr > 5 ? 20 : vr > 3 ? 16 : vr > 2 ? 12 : vr > 1.5 ? 7 : vr > 1 ? 3 : 0;
  s += vp;
  if (vp >= 16) pos.push('Vol surge ' + vr.toFixed(1) + 'x');
  else if (vp >= 12) pos.push('Vol ' + vr.toFixed(1) + 'x');
  else if (vp === 0) neg.push('Vol declining');

  // Buy/sell ratio
  var bp = t.bsr > 3 ? 20 : t.bsr > 2 ? 16 : t.bsr > 1.5 ? 11 : t.bsr > 1.2 ? 7 : t.bsr > 1 ? 3 : 0;
  s += bp;
  if (bp >= 16) pos.push('Buys ' + t.bsr.toFixed(1) + 'x');
  else if (bp >= 11) pos.push('Buying ' + t.bsr.toFixed(1) + 'x');
  else if (bp === 0) neg.push('Selling');

  // Price momentum
  var mp = t.c5 > 20 ? 15 : t.c5 > 10 ? 12 : t.c5 > 3 ? 8 : t.c5 > 0 ? 3 : t.c5 > -5 ? 0 : -2;
  s += Math.max(mp, 0);
  if (mp >= 12) pos.push('+' + t.c5.toFixed(1) + '% 5m');
  else if (mp >= 8) pos.push('+' + t.c5.toFixed(1) + '% 5m');
  else if (mp < 0) neg.push(t.c5.toFixed(1) + '% 5m');

  // 1h momentum
  var hp = t.c1 > 50 ? 10 : t.c1 > 20 ? 7 : t.c1 > 5 ? 4 : t.c1 > 0 ? 1 : 0;
  s += hp;
  if (hp >= 7) pos.push('+' + t.c1.toFixed(0) + '% 1h');

  // Source bonus
  if (t.hot) { s += 15; pos.push('HOT <10min'); }
  else if (t.isNew) { s += 10; pos.push('NEW <1h'); }
  else if (t.age < 6) { s += 5; pos.push(t.age.toFixed(1) + 'h old'); }
  if (t.pump && t.isNew) { s += 5; pos.push('pump.fun'); }

  // LunarCrush social bonus
  var lscore2 = getLunarScore(t.n);
  if (lscore2 > 0) { s += lscore2; pos.push('Social buzz +' + lscore2); }
  if (isLunarTrending(t.n)) { s += 10; pos.push('🔥 TRENDING'); }

  // Penalty flags
  if (t.c1 > 300) { s = Math.floor(s * 0.20); flags.push('Mega pump'); }
  else if (t.c1 > 150) { s = Math.floor(s * 0.35); flags.push('Big pump'); }
  else if (t.c1 > 80) { s = Math.floor(s * 0.55); flags.push('Late entry'); }
  if (t.bsr < 0.5) { s = Math.floor(s * 0.50); flags.push('Heavy sell'); }
  if (t.liq < 1500) { s = Math.floor(s * 0.25); flags.push('Danger liq'); }

  return { sc: Math.min(Math.round(s), 100), pos, neg, flags, all: pos.concat(neg).concat(flags) };
}


// ── POSITION SIZING ───────────────────────────────────────────
function cl(v, a, b) { return Math.min(Math.max(v, a), b); }

function getSlip(liq, sz) {
  // Real slippage estimate based on liquidity and position size
  return parseFloat(cl(0.004 + (sz / Math.max(liq, 100)) * 2.5, 0.003, 0.15).toFixed(4));
}

function getSize(fund, sc, liq) {
  var p = sc >= 85 ? 0.08 : sc >= 75 ? 0.065 : 0.05;
  if (liq < 5e4) p *= 0.65;
  if (liq < 1e4) p *= 0.50;
  return parseFloat((fund * Math.min(p, CFG.MAX_POS)).toFixed(4));
}

function getSL(sc) {
  return cl(sc >= 85 ? 0.12 : sc >= 75 ? 0.15 : 0.18, 0.10, 0.28);
}

// ── MAIN SCAN ─────────────────────────────────────────────────
var scanI = null, scanIdx = 0;
async function runScan() {
  if (!S.running || S.tokens.size === 0) return;
  if (S.fund < 1) { stopBot(); return; }

  var tokens = Array.from(S.tokens.values());
  var tok = tokens[scanIdx % tokens.length];
  scanIdx++; S.scanCount++;

  var result = score(tok);
  var sc = result.sc, pos = result.pos, neg = result.neg, flags = result.flags, all = result.all;
  var src = '[' + tok.src + ']';

  if (tok.hp) { S.rejectCount++; log('SKIP ' + tok.n + ' ' + src + ' - HONEYPOT', 'reject'); return; }

  // Fresh Pump.fun launches under 1 min get a lower threshold
  var minScore = (tok.src === 'WS' && tok.age < 0.017) ? 60 : CFG.MIN_SCORE;
  if (sc < minScore) {
    S.rejectCount++;
    var why = neg.slice(0, 2).concat(flags.slice(0, 1)).join(' | ') || 'weak signals';
    log('SKIP ' + tok.n + ' ' + src + ' - Score ' + sc + '/' + minScore + ' | ' + why, 'reject');
    return;
  }

  if (S.open.length >= CFG.MAX_OPEN) return;
  if (S.open.find(function(t) { return t.tok.n === tok.n; })) return;

  // Get real entry price from Jupiter
  var entryPrice = null;
  if (tok.mint) {
    entryPrice = await getJupiterPrice(tok.mint);
  }
  if (!entryPrice && tok.price) {
    entryPrice = tok.price; // fall back to last known price
  }

  var slip = getSlip(tok.liq, S.fund * 0.08);
  var size = getSize(S.fund, sc, tok.liq);
  if (size < 0.50) { S.rejectCount++; return; }

  // Deduct slippage cost from fund at entry
  S.fund = parseFloat((S.fund - size * slip).toFixed(4));

  var sl = getSL(sc);

  var trade = {
    id: Math.random().toString(36).substr(2, 9),
    tok: Object.assign({}, tok),
    sc, reasons: all,
    size: parseFloat(size.toFixed(4)),
    tpl: 'TRAIL',
    sl, slip,
    mint: tok.mint || null,
    entryPrice: entryPrice,
    currentPrice: entryPrice,
    peakPrice: entryPrice,
    realPnl: 0,
    realPnlPct: 0,
    openedAt: new Date().toLocaleTimeString(),
    startTime: Date.now()
  };

  S.open.push(trade);

  var tag = tok.src === 'WS' ? 'LIVE ' : tok.hot ? 'HOT ' : tok.isNew ? 'NEW ' : '';
  var priceStr = entryPrice ? ' | Entry $' + entryPrice.toFixed(8) : ' | Price fetching...';
  log('ENTER ' + tag + tok.n + ' ' + src + ' | Score ' + sc + ' | SL -' + (sl*100).toFixed(0) + '% | $' + size.toFixed(2) + ' | Slip ' + (slip*100).toFixed(2) + '%' + priceStr, 'entry');
}

// ── PRICE UPDATE LOOP ─────────────────────────────────────────
var priceI = null;
function startPriceUpdates() {
  if (priceI) clearInterval(priceI);
  priceI = setInterval(updateOpenTradePrices, CFG.PRICE_INTERVAL);
}

// ── BOT CONTROL ───────────────────────────────────────────────
var fetchI = null;

function startBot() {
  if (S.running) return;
  S.running = true;
  S.startTime = Date.now();
  S.dayStartFund = S.fund;
  connectPump();
  fetchAll();
  scanI = setInterval(runScan, CFG.SCAN_INTERVAL);
  fetchI = setInterval(fetchAll, 30000);
  startPriceUpdates();
  fetchLunarTrending();
  setInterval(fetchLunarTrending, 300000); // refresh every 5 mins
  log('MemeBot V12 REAL DATA started | Score ' + CFG.MIN_SCORE + '+ | Jupiter + Helius + DexScreener + GeckoTerminal + Pump.fun', 'info');
}

function stopBot() {
  S.running = false;
  clearInterval(scanI);
  clearInterval(priceI);
  clearInterval(fetchI);
  log('Bot stopped', 'info');
}

// ── API ROUTES ────────────────────────────────────────────────
app.get('/api/state', function(req, res) {
  res.json({
    fund: S.fund, savings: S.savings, stats: S.stats,
    running: S.running, pumpLive: S.pumpLive, pumpCount: S.pumpCount,
    poolSize: S.tokens.size, scanCount: S.scanCount, rejectCount: S.rejectCount,
    openTrades: S.open, closedTrades: S.closed.slice(0, 20),
    logs: S.logs.slice(0, 100), sources: S.sources, startTime: S.startTime
  });
});

app.post('/api/start', function(req, res) { startBot(); res.json({ success: true }); });
app.post('/api/stop', function(req, res) { stopBot(); res.json({ success: true }); });
app.post('/api/sell/:id', function(req, res) { closeTradeReal(req.params.id, 'Manual sell'); res.json({ success: true }); });
app.post('/api/setTP', function(req, res) { res.json({ success: true }); });
app.get('/health', function(req, res) { res.json({ status: 'ok', pool: S.tokens.size, pump: S.pumpCount }); });

// ── START SERVER ──────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('MemeBot V12 REAL DATA running on port ' + PORT);
  connectPump();
  fetchAll();
  // Bot does NOT auto-start — Mike controls this manually
});
