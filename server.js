'use strict';
const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── API KEYS ──────────────────────────────────────────────────
const ST_KEY = process.env.ST_KEY || '75035862-d3fe-40a5-9a47-7d6338685930';
const SOLANA_STREAMING_KEY = process.env.SOLANA_STREAMING_KEY || '';
var TRADING_WALLET = process.env.TRADING_WALLET || '';
var SAVINGS_WALLET = process.env.SAVINGS_WALLET || '';
var BASE_TRADING_WALLET = process.env.BASE_TRADING_WALLET || '';
var BASE_SAVINGS_WALLET = process.env.BASE_SAVINGS_WALLET || '';

// ── CONFIGURATION ─────────────────────────────────────────────
const CFG = {
  MAX_POS: 0.05,
  MAX_OPEN: 8,
  MAX_GRAD: 2,
  SOL_GAS: 0.001,
  TRAIL_ACT: 0.04,
  TRAIL_PB: 0.02,
  STOP_LOSS: 0.10,
  STALE_TIME: 120000,
  NO_PRICE_TIMEOUT: 180000,
  LOSS_LIM: 0.10,
  MIN_SPLIT_WIN: 0.05,
  SAVINGS_PCT: 0.20,
  MIN_LIQ_USD: 5000,
  MAX_MCAP_USD: 25000000,
  MIN_MCAP_USD: 1000,
  GRAD_ENTRY_SOL: 100,
  GRAD_MAX_SOL: 480,
  GRAD_TARGET: 500,
  GRAD_POS: 0.10,
  GRAD_MIN_BSR: 1.2,
  GRAD_MIN_TXNS: 3,
  MAX_POOL: 10000,
  POOL_AGE_MS: 14400000,
  COOLDOWN_MS: 1800000,
  BAN_TEMP_MS: 43200000,
  DS_INTERVAL: 300000,
  WIN_COOLDOWN_MS: 300000,
};

// ── PORTFOLIO DATA ────────────────────────────────────────────
const PORTFOLIO_FILE = path.join(__dirname, 'data', 'portfolio.json');

var P = {
  allTime: { t: 0, w: 0, l: 0, totalPnl: 0, totalFees: 0, bestPnl: 0, worstPnl: 0 },
  bestTrade: null,
  worstTrade: null,
  trades: [],
  sessions: [],
};

function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_FILE)) {
      var raw = fs.readFileSync(PORTFOLIO_FILE, 'utf8');
      P = JSON.parse(raw);
      log('Portfolio loaded — ' + P.trades.length + ' trades in history', 'info');
    }
  } catch(e) {
    log('Portfolio file not found — starting fresh', 'info');
  }
}

function savePortfolio() {
  try {
    var dir = path.dirname(PORTFOLIO_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(P, null, 2));
  } catch(e) {}
}

// ── STATE ─────────────────────────────────────────────────────
const S = {
  tokens: new Map(),
  open: [],
  closed: [],
  stats: { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0 },
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
  gradCandidates: new Map(),
  gradCount: 0,
  permanentBans: new Map(),
  tempBans: new Map(),
  cooldowns: new Map(),
  dscPool: 0,
  solPool: 0,
  basePool: 0,
  dscKey: 0,
  sessionFund: 100,
  takeProfitMode: 'TRAIL',
  takeProfitPct: 5,
  stopLossPct: 10,
  totalFees: 0,
  maxOpen: 8,
  fundStopLossPct: 10,
  windingDown: false,
  maxPool: 10000,
  solEnabled: true,
  baseEnabled: true,
  chainStats: { solW: 0, solL: 0, baseW: 0, baseL: 0 },
  bestTrade: null,
};

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, type) {
  type = type || 'info';
  var entry = {
    msg: msg,
    type: type,
    time: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
  };
  S.logs.unshift(entry);
  if (S.logs.length > 500) S.logs.pop();
  console.log('[' + type.toUpperCase() + '] ' + msg);
}

// ── SOL PRICE ─────────────────────────────────────────────────
var SOL_PRICE_USD = 170;
async function updateSolPrice() {
  try {
    var res = await fetch(
      'https://api.dexscreener.com/latest/dex/pairs/solana/So11111111111111111111111111111111111111112',
      { timeout: 5000 }
    );
    if (!res.ok) return;
    var data = await res.json();
    var pairs = data.pairs || [];
    if (pairs.length > 0 && pairs[0].priceUsd) {
      SOL_PRICE_USD = parseFloat(pairs[0].priceUsd);
    }
  } catch(e) {}
}

// ── BAN SYSTEM ────────────────────────────────────────────────
function permanentBan(mint, reason) {
  S.permanentBans.set(mint, reason);
  log('PERMANENT BAN ' + mint.slice(0, 8) + '... | ' + reason, 'warn');
}

function tempBan(mint, reason) {
  S.tempBans.set(mint, { bannedAt: Date.now(), reason: reason });
  log('12HR BAN ' + mint.slice(0, 8) + '... | ' + reason, 'warn');
}

function isBanned(mint) {
  if (!mint) return true;
  if (S.permanentBans.has(mint)) return true;
  var tb = S.tempBans.get(mint);
  if (tb) {
    if (Date.now() - tb.bannedAt < CFG.BAN_TEMP_MS) return true;
    S.tempBans.delete(mint);
  }
  return false;
}

function recheckExpiredBans() {
  var now = Date.now();
  S.tempBans.forEach(function(ban, mint) {
    if (now - ban.bannedAt >= CFG.BAN_TEMP_MS) {
      S.tempBans.delete(mint);
      log('RECHECK ' + mint.slice(0, 8) + '... — 12hr ban expired', 'info');
    }
  });
}

// ── SAFETY CHECKLIST ──────────────────────────────────────────
async function runSafetyChecklist(mint, tokenData, isPumpFun) {
  if (tokenData.mintAuthority &&
      tokenData.mintAuthority !== 'null' &&
      tokenData.mintAuthority !== '') {
    tempBan(mint, 'Mint authority not renounced');
    return false;
  }
  if (tokenData.freezeAuthority &&
      tokenData.freezeAuthority !== 'null' &&
      tokenData.freezeAuthority !== '') {
    permanentBan(mint, 'Freeze authority retained — honeypot');
    return false;
  }
  if (tokenData.lpBurn !== undefined && tokenData.lpBurn !== null && tokenData.lpBurn < 80) {
    tempBan(mint, 'LP burn too low: ' + tokenData.lpBurn + '%');
    return false;
  }
  if (tokenData.dev !== undefined && tokenData.dev !== null && tokenData.dev > 5) {
    tempBan(mint, 'Dev holding too high: ' + tokenData.dev + '%');
    return false;
  }
  if (!isPumpFun) {
    var isHoneypot = await checkHoneypot(mint);
    if (isHoneypot) {
      permanentBan(mint, 'Honeypot confirmed — sell simulation failed');
      return false;
    }
  }
  return true;
}

// ── SOLANA HONEYPOT CHECK ─────────────────────────────────────
async function checkHoneypot(mint) {
  try {
    var res = await fetch(
      'https://quote-api.jup.ag/v6/quote?inputMint=' + mint +
      '&outputMint=So11111111111111111111111111111111111111112' +
      '&amount=1000000&slippageBps=5000',
      { timeout: 5000 }
    );
    if (!res.ok) return true;
    var data = await res.json();
    if (!data || !data.outAmount || parseInt(data.outAmount) === 0) return true;
    return false;
  } catch(e) {
    return true;
  }
}

// ── BASE HONEYPOT CHECK ───────────────────────────────────────
async function checkBaseHoneypot(address) {
  try {
    var res = await fetch(
      'https://api.honeypot.is/v2/IsHoneypot?address=' + address + '&chainID=8453',
      { timeout: 8000 }
    );
    if (!res.ok) return false;
    var data = await res.json();
    if (data && data.honeypotResult && data.honeypotResult.isHoneypot) return true;
    if (data && data.riskLevel !== undefined && data.riskLevel >= 60) return true;
    return false;
  } catch(e) {
    return false;
  }
}

// ── DEXSCREENER PRICE ─────────────────────────────────────────
async function getDSPrice(mint, pairAddress, chain) {
  try {
    var chainId = chain || 'solana';
    var url = pairAddress
      ? 'https://api.dexscreener.com/latest/dex/pairs/' + chainId + '/' + pairAddress
      : 'https://api.dexscreener.com/tokens/v1/' + chainId + '/' + mint;
    var res = await fetch(url, { timeout: 5000 });
    if (!res.ok) return null;
    var data = await res.json();
    var pairs = data.pairs || (Array.isArray(data) ? data : []);
    if (pairs.length > 0 && pairs[0].priceUsd) {
      return parseFloat(pairs[0].priceUsd);
    }
    return null;
  } catch(e) {
    return null;
  }
}

// ── DEXSCREENER TOKEN DISCOVERY ───────────────────────────────
var SOL_QUERIES = [
  'solana meme', 'pump fun sol', 'pepe sol', 'dog sol',
  'cat sol', 'moon sol', 'ai sol', 'degen sol'
];
var BASE_QUERIES = [
  'base meme', 'base coin', 'base dog', 'base cat',
  'brett', 'toshi', 'degen base', 'pepe base'
];
var solQueryIdx = 0;
var baseQueryIdx = 0;

async function fetchDSChain(query, chainId) {
  var now = Date.now();
  var added = 0;
  try {
    var res = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(query),
      { timeout: 10000 }
    );
    if (!res.ok) return 0;
    var data = await res.json();
    var pairs = (data.pairs || []).filter(function(p) { return p.chainId === chainId; });

    for (var k = 0; k < pairs.length; k++) {
      var pair = pairs[k];
      var mint = pair.baseToken && pair.baseToken.address;
      if (!mint) continue;
      if (isBanned(mint)) continue;
      if (S.tokens.has(mint)) continue;

      var liq = parseFloat((pair.liquidity && pair.liquidity.usd) || 0);
      var mcap = parseFloat(pair.fdv || 0);
      var price = parseFloat(pair.priceUsd || 0);
      var vol1h = parseFloat((pair.volume && pair.volume.h1) || 0);
      var buys = parseInt((pair.txns && pair.txns.h1 && pair.txns.h1.buys) || 0);
      var sells = parseInt((pair.txns && pair.txns.h1 && pair.txns.h1.sells) || 1);
      var age = pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 3600000 : 24;

      if (liq < CFG.MIN_LIQ_USD) continue;
      if (mcap > CFG.MAX_MCAP_USD) continue;
      if (buys < 3) continue;
      if (buys / Math.max(sells, 1) < 1.0) continue;

      if (chainId === 'base') {
        var isHp = await checkBaseHoneypot(mint);
        if (isHp) { permanentBan(mint, 'Base honeypot detected'); continue; }
      } else {
        var tokenData = { mintAuthority: null, freezeAuthority: null, lpBurn: undefined, dev: undefined };
        var safe = await runSafetyChecklist(mint, tokenData, true);
        if (!safe) continue;
      }

      S.tokens.set(mint, {
        mint: mint,
        price: price,
        n: (pair.baseToken && pair.baseToken.symbol || '???').toUpperCase().slice(0, 12),
        src: 'DSC',
        chain: chainId,
        liq: liq,
        mcap: mcap,
        vol1h: vol1h,
        buys: buys,
        sells: sells,
        age: age,
        pairAddress: pair.pairAddress || null,
        addedAt: Date.now(),
      });
      added++;
      S.dscKey++;
    }
  } catch(e) {}
  return added;
}

async function fetchDSTokens() {
  if (S.solEnabled) {
    var solQuery = SOL_QUERIES[solQueryIdx % SOL_QUERIES.length];
    solQueryIdx++;
    var solAdded = await fetchDSChain(solQuery, 'solana');
    if (solAdded > 0) log('DS SOL [' + solQuery + ']: ' + solAdded + ' added | Pool: ' + S.tokens.size, 'info');
  }
  if (S.baseEnabled) {
    var baseQuery = BASE_QUERIES[baseQueryIdx % BASE_QUERIES.length];
    baseQueryIdx++;
    var baseAdded = await fetchDSChain(baseQuery, 'base');
    if (baseAdded > 0) log('DS BASE [' + baseQuery + ']: ' + baseAdded + ' added | Pool: ' + S.tokens.size, 'info');
  }
  S.dscPool = Array.from(S.tokens.values()).filter(function(t) { return t.src === 'DSC'; }).length;
  S.solPool = Array.from(S.tokens.values()).filter(function(t) { return t.chain === 'solana'; }).length;
  S.basePool = Array.from(S.tokens.values()).filter(function(t) { return t.chain === 'base'; }).length;
  S.sources['DSC'] = 'live:' + S.tokens.size;
}

// ── SOLANASTREAMING — REAL TIME DATA ─────────────────────────
// One WebSocket connection: wss://api.solanastreaming.com
// Auth via X-API-KEY header — key lives in Render environment only
// newPairSubscribe: new Pump.fun launches with REAL authority data
// swapSubscribe: every buy/sell on watched bonding curves — real prices
var pumpPrices = {};
var pumpWs = null;
var ssSwapSubId = null;
var ssSwapSubPending = false;
var ssTooManyConn = false;
var ssLastSentFilter = '';
var ssMsgId = 10;
var ssSwapLogCount = 0;
var ssPingI = null;

function connectSS() {
  if (pumpWs && (pumpWs.readyState === WebSocket.OPEN || pumpWs.readyState === WebSocket.CONNECTING)) return;
  if (!SOLANA_STREAMING_KEY) {
    log('SOLANA_STREAMING_KEY missing — add it in Render Environment tab', 'rug');
    return;
  }
  try {
    pumpWs = new WebSocket('wss://api.solanastreaming.com', {
      headers: { 'X-API-KEY': SOLANA_STREAMING_KEY }
    });

    pumpWs.on('open', function() {
      S.pumpLive = true;
      ssSwapSubId = null;
      ssSwapSubPending = false;
      ssLastSentFilter = '';
      S.sources['SOLSTREAM'] = 'live:0';
      pumpWs.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'newPairSubscribe', params: { include_pumpfun: true } }));
      log('SolanaStreaming LIVE — real time data connected', 'pump');
      if (ssPingI) clearInterval(ssPingI);
      ssPingI = setInterval(function() {
        try { if (pumpWs && pumpWs.readyState === WebSocket.OPEN) pumpWs.ping(); } catch(e) {}
      }, 30000);
    });

    pumpWs.on('message', function(raw) {
      try {
        var msg = JSON.parse(raw.toString());

        if (msg.id === 1 && msg.result && msg.result.subscription_id !== undefined) {
          log('New pair stream active — subscription #' + msg.result.subscription_id, 'pump');
          return;
        }
        if (msg.id === 2 && msg.result && msg.result.subscription_id !== undefined) {
          ssSwapSubId = msg.result.subscription_id;
          ssSwapSubPending = false;
          log('Swap stream active — subscription #' + ssSwapSubId, 'pump');
          return;
        }
        if (msg.id >= 10 && msg.result === true) {
          ssSwapSubPending = false;
          return;
        }
        if (msg.error) {
          ssSwapSubPending = false;
          log('SS ERROR: ' + JSON.stringify(msg.error).slice(0, 200), 'warn');
          if (msg.error.code === -32001) ssTooManyConn = true;
          return;
        }
        if (msg.params && msg.params.pair) { handleNewPair(msg.params); return; }
        if (msg.params && msg.params.swap) { handleSwap(msg.params); return; }
      } catch(e) {}
    });

    pumpWs.on('error', function() { S.pumpLive = false; S.sources['SOLSTREAM'] = 'dead'; });
    pumpWs.on('close', function() {
      S.pumpLive = false;
      S.sources['SOLSTREAM'] = 'dead';
      if (ssPingI) clearInterval(ssPingI);
      var delay = ssTooManyConn ? 15000 : 3000;
      ssTooManyConn = false;
      setTimeout(connectSS, delay);
    });
  } catch(e) { setTimeout(connectSS, 5000); }
}

async function handleNewPair(p) {
  var pair = p.pair || {};

  // Graduation — token migrated off the bonding curve to a DEX
  if (pair.migration === 'pumpfun') {
    var gmint = pair.baseToken && pair.baseToken.account;
    if (gmint && S.gradCandidates.has(gmint)) {
      log('GRADUATED ' + gmint.slice(0, 8) + '... — migrated to ' + (pair.sourceExchange || 'DEX'), 'pump');
    }
    return;
  }

  // Only Pump.fun launches feed the sniper pipeline
  if (pair.sourceExchange !== 'pumpfun') return;

  var mint = pair.baseToken && pair.baseToken.account;
  var amm = pair.ammAccount;
  if (!mint || !amm) return;

  var info = (pair.baseToken && pair.baseToken.info) || {};
  var meta = info.metadata || {};
  var name = ((meta.symbol || meta.name || 'NEW') + '').toUpperCase().slice(0, 12);

  S.pumpCount++;
  S.sources['SOLSTREAM'] = 'live:' + S.pumpCount;
  if (S.pumpCount % 20 === 0) log('Pump.fun: ' + S.pumpCount + ' launches — latest: ' + name, 'pump');

  if (isBanned(mint)) return;
  if (S.tokens.has(mint)) return;

  // Pool cap eviction — unchanged behavior
  if (S.tokens.size >= S.maxPool) {
    var worstKey = null;
    var worstBSR = Infinity;
    S.tokens.forEach(function(tok, key) {
      if (S.open.find(function(t) { return t.mint === key; })) return;
      var bsr = tok.buys / Math.max(tok.sells || 1, 1);
      if (bsr < worstBSR) { worstBSR = bsr; worstKey = key; }
    });
    if (worstKey) S.tokens.delete(worstKey);
  }

  // Safety checklist — now fed with REAL on-chain authority data
  var tokenData = {
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    lpBurn: undefined,
    dev: undefined,
  };
  var safe = await runSafetyChecklist(mint, tokenData, true);
  if (!safe) return;

  var liqSol = parseInt(pair.quoteTokenLiquidityAdded || '0') / 1e9;

  S.tokens.set(mint, {
    mint: mint,
    price: null,
    n: name,
    src: 'PUMP',
    chain: 'solana',
    ammAccount: amm,
    liq: liqSol * SOL_PRICE_USD,
    mcap: 0,
    vol1h: 0,
    buys: 1,
    sells: 0,
    age: 0,
    pairAddress: null,
    addedAt: Date.now(),
    isNew: true,
  });

  log('NEW TOKEN ' + name + ' | ' + liqSol.toFixed(1) + ' SOL liq | Added to pool', 'info');
}

function handleSwap(p) {
  var s = p.swap || {};
  var mint = s.baseTokenMint;
  if (!mint) return;

  // Confirm the stream is flowing — first 3 swaps logged
  ssSwapLogCount++;
  if (ssSwapLogCount <= 3) log('SS SWAP #' + ssSwapLogCount + ' | ' + (s.swapType || '?') + ' | ' + mint.slice(0, 8) + '...', 'info');

  // quotePrice is in wSOL — convert to USD
  var priceUsd = null;
  if (s.quotePrice && s.quotePrice !== '') {
    var pSol = parseFloat(s.quotePrice);
    if (!isNaN(pSol) && pSol > 0) priceUsd = pSol * SOL_PRICE_USD;
  }

  // Real SOL reserves in the bonding curve (beta field — may be empty)
  var solInCurve = 0;
  if (s.quoteTokenLiquidity && s.quoteTokenLiquidity !== '') {
    solInCurve = parseInt(s.quoteTokenLiquidity) / 1e9;
  }

  // Buy count ALWAYS updates — fully decoupled from price
  var poolTok = S.tokens.get(mint);
  if (poolTok) {
    if (s.swapType === 'buy') poolTok.buys = (poolTok.buys || 0) + 1;
    else if (s.swapType === 'sell') poolTok.sells = (poolTok.sells || 0) + 1;
    if (priceUsd) poolTok.price = priceUsd;
  }

  if (priceUsd) {
    pumpPrices[mint] = { price: priceUsd, solInCurve: solInCurve, ts: Date.now() };

    // Open PUMP trades — price update + exit checks on EVERY swap
    S.open.forEach(function(trade) {
      if (trade.mint !== mint || trade.src !== 'PUMP') return;

      // Sanity check — reject single-tick moves over 90% as data errors
      if (trade.currentPrice && trade.currentPrice > 0) {
        var change = Math.abs(priceUsd - trade.currentPrice) / trade.currentPrice;
        if (change > 0.90) {
          log('PRICE SANITY REJECT ' + trade.tok.n + ' | ' + (change * 100).toFixed(0) + '% single tick', 'warn');
          return;
        }
      }

      trade.currentPrice = priceUsd;
      trade.priceUpdates = (trade.priceUpdates || 0) + 1;
      if (!trade.firstUpdateAt) trade.firstUpdateAt = Date.now();
      if (priceUsd > (trade.peakPrice || 0)) trade.peakPrice = priceUsd;
      if (trade.entryPrice > 0) {
        trade.realPnlPct = (priceUsd - trade.entryPrice) / trade.entryPrice;
        trade.realPnl = trade.size * trade.realPnlPct;
      }
      if (!trade.lastPrice || Math.abs(priceUsd - trade.lastPrice) / trade.lastPrice > 0.001) {
        trade.lastPriceChange = Date.now();
        trade.lastPrice = priceUsd;
      }

      if (trade.entryPrice > 0) {
        var pct = (priceUsd - trade.entryPrice) / trade.entryPrice;

        if (trade.tpl === 'FIXED' && pct >= (trade.tpPct / 100)) {
          log('TP HIT ' + trade.tok.n + ' | +' + (pct * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'win');
          closeTradeReal(trade.id, 'Take profit hit');
          return;
        }

        if (trade.tpl === 'TRAIL' && trade.peakPrice) {
          var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
          if (peakGain >= CFG.TRAIL_ACT) {
            var pullback = (trade.peakPrice - priceUsd) / trade.peakPrice;
            if (pullback >= CFG.TRAIL_PB) {
              log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain * 100).toFixed(1) + '% | Pullback -' + (pullback * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'win');
              closeTradeReal(trade.id, 'Trail exit');
              return;
            }
          }
        }

        if (pct <= -(trade.sl || 0.10)) {
          log('SL HIT ' + trade.tok.n + ' | ' + (pct * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'loss');
          closeTradeReal(trade.id, 'Stop loss hit');
          return;
        }
      }
    });
  }

  // Graduation candidate tracking — REAL SOL reserves now
  if (solInCurve > 0) {
    var pt = S.tokens.get(mint);
    var existing = S.gradCandidates.get(mint) || {
      name: pt ? pt.n : '', mint: mint, firstSeen: Date.now(), buys: 0, sells: 0,
    };
    existing.solInCurve = solInCurve;
    existing.price = priceUsd || existing.price;
    existing.lastUpdate = Date.now();
    if (s.swapType === 'buy') existing.buys = (existing.buys || 0) + 1;
    else if (s.swapType === 'sell') existing.sells = (existing.sells || 0) + 1;
    existing.bsr = existing.buys / Math.max(existing.sells, 1);
    if (solInCurve >= CFG.GRAD_ENTRY_SOL && solInCurve <= CFG.GRAD_MAX_SOL) {
      existing.nearGrad = true;
      var gpct = Math.floor((solInCurve / CFG.GRAD_TARGET) * 100);
      if (!existing.logged || existing.loggedPct !== gpct) {
        existing.logged = true;
        existing.loggedPct = gpct;
        log('GRAD CANDIDATE ' + (existing.name || mint.slice(0, 8)) + ' | ' + solInCurve.toFixed(0) + ' SOL | ' + gpct + '% | BSR ' + existing.bsr.toFixed(1) + 'x', 'pump');
      }
    } else {
      existing.nearGrad = false;
    }
    S.gradCandidates.set(mint, existing);
  }
}

// ── SWAP FILTER MANAGEMENT ────────────────────────────────────
// Streams swaps for: every open PUMP trade + the newest bonding curves
// Recomputed every 5 seconds — only sent when the list actually changes
var SS_WATCH_CAP = 5; // Basic plan hard limit — confirmed via SolanaStreaming docs

function updateSSFilter() {
  if (!pumpWs || pumpWs.readyState !== WebSocket.OPEN) return;

  var amms = [];
  var seen = {};

  // Open PUMP trades are ALWAYS watched — exits depend on it
  S.open.forEach(function(t) {
    if (t.src === 'PUMP' && t.ammAccount && !seen[t.ammAccount]) {
      seen[t.ammAccount] = true;
      amms.push(t.ammAccount);
    }
  });

  // Newest PUMP pool tokens fill the rest, up to the cap
  var pumpToks = [];
  S.tokens.forEach(function(tok) {
    if (tok.src === 'PUMP' && tok.ammAccount && !seen[tok.ammAccount]) pumpToks.push(tok);
  });
  pumpToks.sort(function(a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
  for (var i = 0; i < pumpToks.length && amms.length < SS_WATCH_CAP; i++) {
    seen[pumpToks[i].ammAccount] = true;
    amms.push(pumpToks[i].ammAccount);
  }

  // Never send an empty or malformed filter — API rejects it as invalid params
  if (amms.length === 0) return;
  if (!Array.isArray(amms) || amms.some(function(a) { return typeof a !== 'string' || !a; })) return;

  var fingerprint = amms.join(',');
  if (fingerprint === ssLastSentFilter) return;

  if (ssSwapSubId === null) {
    // Prevent sending a second swapSubscribe before the first is confirmed —
    // only 1 swap subscription is permitted per connection
    if (ssSwapSubPending) return;
    ssSwapSubPending = true;
    pumpWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'swapSubscribe',
      params: { include: { ammAccount: amms } }
    }));
  } else {
    if (ssSwapSubPending) return;
    ssSwapSubPending = true;
    ssMsgId++;
    pumpWs.send(JSON.stringify({
      jsonrpc: '2.0', id: ssMsgId, method: 'updateSubscriptionParams',
      params: { subscription_id: ssSwapSubId, update: { include: { ammAccount: amms } } }
    }));
  }
  ssLastSentFilter = fingerprint;
}

var ssFilterI = setInterval(updateSSFilter, 5000);

// ── OPEN TRADE PRICE TRACKING ─────────────────────────────────
async function updateOpenTradePrices() {
  var trades = S.open.filter(function(t) { return !t.isGrad && t.src !== 'PUMP' && t.mint; });
  if (trades.length === 0) return;

  for (var i = 0; i < trades.length; i++) {
    var trade = trades[i];
    var price = await getDSPrice(trade.mint, trade.pairAddress, trade.chain);
    if (!price || price <= 0) continue;

    if (trade.currentPrice && trade.currentPrice > 0) {
      var change = Math.abs(price - trade.currentPrice) / trade.currentPrice;
      if (change > 0.90) {
        log('PRICE SANITY REJECT ' + trade.tok.n + ' | ' + (change * 100).toFixed(0) + '% move', 'warn');
        continue;
      }
    }

    trade.currentPrice = price;
    trade.priceUpdates = (trade.priceUpdates || 0) + 1;
    if (!trade.firstUpdateAt) trade.firstUpdateAt = Date.now();
    if (!trade.lastPrice || Math.abs(price - trade.lastPrice) / trade.lastPrice > 0.001) {
      trade.lastPriceChange = Date.now();
      trade.lastPrice = price;
    }

    if (!trade.entryPrice || trade.entryPrice <= 0) {
      trade.entryPrice = price;
      trade.peakPrice = price;
      log('PRICE SET ' + trade.tok.n + ' $' + price.toFixed(8), 'info');
      continue;
    }

    var pct = (price - trade.entryPrice) / trade.entryPrice;
    trade.realPnlPct = pct;
    trade.realPnl = trade.size * pct;
    if (price > (trade.peakPrice || 0)) trade.peakPrice = price;

    if (trade.tpl === 'FIXED' && pct >= (trade.tpPct / 100)) {
      log('TP HIT ' + trade.tok.n + ' | +' + (pct * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'win');
      closeTradeReal(trade.id, 'Take profit hit');
      continue;
    }

    if (trade.tpl === 'TRAIL' && trade.peakPrice && trade.entryPrice) {
      var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
      if (peakGain >= CFG.TRAIL_ACT) {
        var pullback = (trade.peakPrice - price) / trade.peakPrice;
        if (pullback >= CFG.TRAIL_PB) {
          log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'win');
          closeTradeReal(trade.id, 'Trail exit');
          continue;
        }
      }
    }

    if (pct <= -(trade.sl || 0.10)) {
      log('SL HIT ' + trade.tok.n + ' | ' + (pct * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'loss');
      closeTradeReal(trade.id, 'Stop loss hit');
    }
  }
}

// ── CLOSE TRADE ───────────────────────────────────────────────
function closeTradeReal(id, reason) {
  var i = S.open.findIndex(function(t) { return t.id === id; });
  if (i === -1) return;
  var tr = S.open[i];
  var closeReason = reason || 'Manual sell';

  var pnl = 0;
  if (tr.entryPrice && tr.currentPrice && tr.entryPrice > 0) {
    var pricePct = (tr.currentPrice - tr.entryPrice) / tr.entryPrice;
    pnl = tr.size * pricePct - tr.size * (tr.slip || 0.005) - CFG.SOL_GAS;
  } else {
    pnl = -CFG.SOL_GAS;
    closeReason = reason + ' (no price data)';
  }

  var feePaid = tr.size * (tr.slip || 0.005) + CFG.SOL_GAS;
  S.totalFees = parseFloat((S.totalFees + feePaid).toFixed(4));

  if (pnl > CFG.MIN_SPLIT_WIN) {
    var savings = parseFloat((pnl * CFG.SAVINGS_PCT).toFixed(4));
    var trading = parseFloat((pnl * (1 - CFG.SAVINGS_PCT)).toFixed(4));
    S.fund = parseFloat((S.fund + trading).toFixed(4));
    S.savings = parseFloat((S.savings + savings).toFixed(4));
    log((tr.isGrad ? 'GRAD ' : '') + tr.tok.n + ' +$' + pnl.toFixed(2) + ' | saved $' + savings.toFixed(2) + ' | ' + closeReason, 'win');
    S.stats.w++;
    if (tr.isGrad) S.stats.gw++;
    if (tr.chain === 'base') S.chainStats.baseW++; else S.chainStats.solW++;
  } else if (pnl > 0) {
    S.fund = parseFloat((S.fund + pnl).toFixed(4));
    log((tr.isGrad ? 'GRAD ' : '') + tr.tok.n + ' +$' + pnl.toFixed(2) + ' (below split min) | ' + closeReason, 'win');
    S.stats.w++;
    if (tr.isGrad) S.stats.gw++;
    if (tr.chain === 'base') S.chainStats.baseW++; else S.chainStats.solW++;
  } else {
    S.fund = parseFloat((S.fund + pnl).toFixed(4));
    log((tr.isGrad ? 'GRAD ' : '') + tr.tok.n + ' -$' + Math.abs(pnl).toFixed(2) + ' | ' + closeReason, 'loss');
    S.stats.l++;
    if (tr.isGrad) S.stats.gl++;
    if (tr.chain === 'base') S.chainStats.baseL++; else S.chainStats.solL++;
  }

  S.stats.t++;

  S.closed.unshift({
    tok: tr.tok,
    closeReason: closeReason,
    pnl: parseFloat(pnl.toFixed(4)),
    pnlPct: tr.entryPrice && tr.currentPrice
      ? parseFloat(((tr.currentPrice - tr.entryPrice) / tr.entryPrice * 100).toFixed(2)) : 0,
    entryPrice: tr.entryPrice,
    exitPrice: tr.currentPrice,
    size: tr.size,
    slip: tr.slip || 0,
    mint: tr.mint || '',
    openedAt: tr.openedAt,
    closedAt: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    src: tr.src || (tr.tok && tr.tok.src) || 'unknown',
    chain: tr.chain || 'solana',
    isGrad: tr.isGrad || false,
  });
  if (S.closed.length > 200) S.closed.pop();
  S.open.splice(i, 1);

  var portfolioTrade = {
    id: tr.id,
    name: tr.tok && tr.tok.n ? tr.tok.n : '?',
    mint: tr.mint || '',
    chain: tr.chain || 'solana',
    src: tr.src || 'unknown',
    entryPrice: tr.entryPrice || 0,
    exitPrice: tr.currentPrice || 0,
    size: tr.size || 0,
    pnl: parseFloat(pnl.toFixed(4)),
    pnlPct: tr.entryPrice && tr.currentPrice
      ? parseFloat(((tr.currentPrice - tr.entryPrice) / tr.entryPrice * 100).toFixed(2)) : 0,
    closeReason: closeReason,
    isGrad: tr.isGrad || false,
    openedAt: tr.openedAt || '',
    closedAt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    closedDate: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
    closedTime: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    slip: tr.slip || 0,
    fees: parseFloat(feePaid.toFixed(4)),
    priceUpdates: tr.priceUpdates || 0,
    peakGainPct: (tr.peakPrice && tr.entryPrice)
      ? parseFloat(((tr.peakPrice - tr.entryPrice) / tr.entryPrice * 100).toFixed(2)) : 0,
    secToFirstUpdate: (tr.firstUpdateAt && tr.startTime)
      ? parseFloat(((tr.firstUpdateAt - tr.startTime) / 1000).toFixed(1)) : null,
  };

  P.trades.unshift(portfolioTrade);
  P.allTime.t++;
  P.allTime.totalPnl = parseFloat((P.allTime.totalPnl + pnl).toFixed(4));
  P.allTime.totalFees = parseFloat((P.allTime.totalFees + feePaid).toFixed(4));
  if (pnl > 0) P.allTime.w++; else P.allTime.l++;
  if (pnl > P.allTime.bestPnl) P.allTime.bestPnl = parseFloat(pnl.toFixed(4));
  if (pnl < P.allTime.worstPnl) P.allTime.worstPnl = parseFloat(pnl.toFixed(4));
  if (!P.bestTrade || pnl > P.bestTrade.pnl) P.bestTrade = portfolioTrade;
  if (!P.worstTrade || pnl < P.worstTrade.pnl) P.worstTrade = portfolioTrade;
  if (P.allTime.t % 10 === 0) savePortfolio();

  if (!S.bestTrade || pnl > S.bestTrade.pnl) {
    S.bestTrade = {
      name: tr.tok && tr.tok.n ? tr.tok.n : '?',
      entryPrice: tr.entryPrice || 0,
      exitPrice: tr.currentPrice || 0,
      size: tr.size || 0,
      pnl: parseFloat(pnl.toFixed(4)),
      pnlPct: tr.entryPrice && tr.currentPrice
        ? parseFloat(((tr.currentPrice - tr.entryPrice) / tr.entryPrice * 100).toFixed(2)) : 0,
      closeReason: closeReason,
    };
  }

  var cooldownKey = (tr.tok && tr.tok.n || '') + (tr.mint || '');
  if (pnl < 0) {
    S.cooldowns.set(cooldownKey, Date.now());
    log('COOLDOWN ' + (tr.tok && tr.tok.n) + ' — blocked 30min after loss', 'warn');
  }
  if (pnl > 0) {
    S.cooldowns.set(cooldownKey, Date.now() - (CFG.COOLDOWN_MS - CFG.WIN_COOLDOWN_MS));
    log('COOLDOWN ' + (tr.tok && tr.tok.n) + ' — blocked 5min after win', 'info');
  }

  var lossLimit = S.fundStopLossPct / 100;
  var currentLoss = (S.dayStartFund - S.fund) / S.dayStartFund;
  if (currentLoss >= lossLimit && !S.windingDown) {
    S.windingDown = true;
    log('FUND LOSS LIMIT HIT — ' + S.fundStopLossPct + '% reached — no new entries', 'rug');
    var windDownCheck = setInterval(function() {
      if (S.open.length === 0) {
        clearInterval(windDownCheck);
        log('All trades closed — bot fully stopped', 'info');
        stopBot();
      }
    }, 2000);
  }
}

// ── EXIT CRITERIA ─────────────────────────────────────────────
function checkExitCriteria() {
  var now = Date.now();
  S.open.slice().forEach(function(t) {
    var age = now - t.startTime;

    if (!t.entryPrice && age > CFG.NO_PRICE_TIMEOUT) {
      log('TIMEOUT ' + t.tok.n + ' — no price after 3min', 'warn');
      closeTradeReal(t.id, 'Timeout — no price data');
      return;
    }

    if (!t.entryPrice || !t.currentPrice) return;

    var lastMove = t.lastPriceChange || t.startTime;
    if ((now - lastMove) > CFG.STALE_TIME && age > 30000) {
      log('STALE ' + t.tok.n + ' — no movement for 2min', 'warn');
      closeTradeReal(t.id, 'Token went stale');
      return;
    }

    if (t.isGrad && t.tpl === 'TRAIL' && t.entryPrice > 0 && t.currentPrice > 0) {
      var peakGain = (t.peakPrice - t.entryPrice) / t.entryPrice;
      if (peakGain >= CFG.TRAIL_ACT) {
        var pullback = (t.peakPrice - t.currentPrice) / t.peakPrice;
        if (pullback >= CFG.TRAIL_PB) {
          log('TRAIL EXIT ' + t.tok.n + ' | Peak +' + (peakGain * 100).toFixed(1) + '% | ticks:' + (t.priceUpdates||0), 'win');
          closeTradeReal(t.id, 'Trail exit');
          return;
        }
      }
      var pct = (t.currentPrice - t.entryPrice) / t.entryPrice;
      if (pct <= -(t.sl || 0.10)) {
        log('SL HIT ' + t.tok.n + ' | ' + (pct * 100).toFixed(1) + '% | ticks:' + (t.priceUpdates||0), 'loss');
        closeTradeReal(t.id, 'Stop loss hit');
      }
    }
  });
}

// ── GRADUATION SNIPER ─────────────────────────────────────────
async function runGradSniper() {
  if (!S.running || S.fund < 1) return;
  if (S.windingDown) return;
  var openGrads = S.open.filter(function(t) { return t.isGrad; }).length;
  if (openGrads >= Math.max(Math.floor(S.maxOpen * 0.25), 1)) return;

  for (var entry of S.gradCandidates.entries()) {
    var mint = entry[0];
    var cand = entry[1];
    if (!cand.nearGrad) continue;
    if (isBanned(mint)) continue;
    if (S.open.find(function(t) { return t.mint === mint; })) continue;
    if (!cand.price || cand.price <= 0) continue;
    var totalTxns = (cand.buys || 0) + (cand.sells || 0);
    if (totalTxns < CFG.GRAD_MIN_TXNS) continue;
    if (cand.bsr < CFG.GRAD_MIN_BSR) continue;

    var size = parseFloat((S.fund * Math.min(CFG.GRAD_POS, 0.10)).toFixed(4));
    if (size < 0.50) continue;

    var slip = 0.008;
    S.fund = parseFloat((S.fund - size * slip).toFixed(4));
    var pct2 = Math.floor((cand.solInCurve / CFG.GRAD_TARGET) * 100);

    var trade = {
      id: Math.random().toString(36).substr(2, 9),
      tok: { n: cand.name || mint.slice(0, 8), src: 'GRAD', liq: cand.solInCurve * SOL_PRICE_USD },
      sc: 90,
      size: size,
      tpl: 'TRAIL',
      tpPct: S.takeProfitPct,
      sl: S.stopLossPct / 100,
      slip: slip,
      mint: mint,
      src: 'GRAD',
      chain: 'solana',
      entryPrice: cand.price,
      currentPrice: cand.price,
      peakPrice: cand.price,
      lastPrice: cand.price,
      lastPriceChange: Date.now(),
      realPnl: 0,
      realPnlPct: 0,
      priceUpdates: 0,
      firstUpdateAt: null,
      isGrad: true,
      gradSolAtEntry: cand.solInCurve,
      openedAt: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
      startTime: Date.now(),
    };

    S.open.push(trade);
    S.gradCount++;
    log('GRAD ENTER ' + trade.tok.n + ' | ' + pct2 + '% to grad | ' + cand.solInCurve.toFixed(0) + ' SOL | $' + size.toFixed(2), 'entry');
    break;
  }
}

// ── MAIN SCANNER ──────────────────────────────────────────────
var scanI = null;
var scanIdx = 0;

async function runScan() {
  if (!S.running || S.tokens.size === 0) return;
  if (S.windingDown) return;
  if (S.fund < 1) { stopBot(); return; }
  if (S.open.length >= S.maxOpen) return;

  var tokens = Array.from(S.tokens.values());
  if (tokens.length === 0) return;

  var tok = tokens[scanIdx % tokens.length];
  scanIdx++;
  S.scanCount++;

  if (!tok || !tok.mint) return;

  // Diagnostic log every 200 scans — shows why current token is rejected
  var diag = (S.scanCount % 200 === 0);

  if (isBanned(tok.mint)) { S.tokens.delete(tok.mint); return; }

  if (tok.chain === 'base' && !S.baseEnabled) { if(diag) log('DIAG '+tok.n+' | SKIP: base disabled', 'info'); return; }
  if (tok.chain === 'solana' && !S.solEnabled) { if(diag) log('DIAG '+tok.n+' | SKIP: sol disabled', 'info'); return; }
  if (!tok.chain && !S.solEnabled) { if(diag) log('DIAG '+tok.n+' | SKIP: no chain + sol disabled', 'info'); return; }

  var bsr = tok.buys / Math.max(tok.sells || 1, 1);
  if (bsr < 0.8) { S.rejectCount++; if(diag) log('DIAG '+tok.n+' | SKIP: BSR '+bsr.toFixed(2)+' buys='+tok.buys+' sells='+tok.sells, 'info'); return; }

  var cooldownKey = tok.n + tok.mint;
  var lastCooldown = S.cooldowns.get(cooldownKey);
  if (lastCooldown && (Date.now() - lastCooldown) < CFG.COOLDOWN_MS) { if(diag) log('DIAG '+tok.n+' | SKIP: cooldown active', 'info'); return; }

  if (S.open.find(function(t) { return t.mint === tok.mint; })) { if(diag) log('DIAG '+tok.n+' | SKIP: already open', 'info'); return; }

  if (tok.buys < 3) { if(diag) log('DIAG '+tok.n+' | SKIP: buys='+tok.buys+' (need 3)', 'info'); return; }

  var size = parseFloat((S.fund * CFG.MAX_POS).toFixed(4));
  if (size < 0.50) { S.rejectCount++; if(diag) log('DIAG '+tok.n+' | SKIP: size $'+size+' too small', 'info'); return; }

  if (tok.src === 'DSC') { if(diag) log('DIAG '+tok.n+' | SKIP: DSC entries disabled — discovery only', 'info'); return; }

  var entryPrice = null;
  if (tok.src === 'PUMP') {
    // Only enter on a FRESH price — under 1 second old
    // Guarantees entry price is real AND token is actively trading right now
    var cached = pumpPrices[tok.mint];
    if (cached && (Date.now() - cached.ts) <= 1000) {
      entryPrice = cached.price;
    } else {
      if(diag) log('DIAG '+tok.n+' | SKIP: price stale ('+(cached ? ((Date.now()-cached.ts)/1000).toFixed(1)+'s old' : 'no cache')+')', 'info');
      S.rejectCount++;
      return;
    }
  } else {
    entryPrice = await getDSPrice(tok.mint, tok.pairAddress, tok.chain);
  }

  if (!entryPrice || entryPrice <= 0) { S.rejectCount++; if(diag) log('DIAG '+tok.n+' | SKIP: no price | src='+tok.src+' pumpCache='+(pumpPrices[tok.mint]?'YES':'NO'), 'info'); return; }

  var slip = parseFloat(
    Math.min(0.004 + (size / Math.max(tok.liq || 1000, 100)) * 2.5, 0.15).toFixed(4)
  );
  S.fund = parseFloat((S.fund - size * slip).toFixed(4));

  var trade = {
    id: Math.random().toString(36).substr(2, 9),
    tok: Object.assign({}, tok),
    sc: 85,
    size: parseFloat(size.toFixed(4)),
    tpl: S.takeProfitMode,
    tpPct: S.takeProfitPct,
    sl: S.stopLossPct / 100,
    slip: slip,
    mint: tok.mint,
    src: tok.src,
    chain: tok.chain || 'solana',
    ammAccount: tok.ammAccount || null,
    pairAddress: tok.pairAddress || null,
    entryPrice: entryPrice,
    currentPrice: entryPrice,
    peakPrice: entryPrice,
    lastPrice: entryPrice,
    lastPriceChange: Date.now(),
    realPnl: 0,
    realPnlPct: 0,
    isGrad: false,
    priceUpdates: 0,
    firstUpdateAt: null,
    openedAt: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    startTime: Date.now(),
  };

  S.open.push(trade);
  log('ENTER ' + tok.n + ' [' + tok.src + '] | $' + size.toFixed(2) + ' | Entry $' + entryPrice.toFixed(8), 'entry');
}

// ── POOL CLEANUP ──────────────────────────────────────────────
function cleanPool() {
  var now = Date.now();
  var removed = 0;
  S.tokens.forEach(function(tok, mint) {
    if (tok.addedAt && (now - tok.addedAt) > CFG.POOL_AGE_MS &&
        !S.open.find(function(t) { return t.mint === mint; })) {
      S.tokens.delete(mint);
      removed++;
    }
  });
  S.cooldowns.forEach(function(ts, key) {
    if (now - ts > CFG.COOLDOWN_MS) S.cooldowns.delete(key);
  });
  var gradRemoved = 0;
  S.gradCandidates.forEach(function(cand, mint) {
    if (!S.open.find(function(t) { return t.mint === mint; })) {
      if (now - cand.firstSeen > CFG.POOL_AGE_MS) {
        S.gradCandidates.delete(mint);
        gradRemoved++;
      }
    }
  });
  recheckExpiredBans();
  if (removed > 0) log('Pool cleaned: ' + removed + ' removed | Pool: ' + S.tokens.size, 'info');
  if (gradRemoved > 0) log('Grad candidates cleaned: ' + gradRemoved, 'info');
}

// ── BOT CONTROL ───────────────────────────────────────────────
var gradI = null, exitI = null, cleanI = null, priceI = null, dsI = null, solPriceI = null;

function startBot() {
  if (S.running) return;
  S.running = true;
  S.startTime = Date.now();
  S.stats = { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0 };
  S.savings = 0;
  S.dscPool = 0;
  S.solPool = 0;
  S.basePool = 0;
  S.dscKey = 0;
  S.bestTrade = null;
  S.totalFees = 0;
  S.windingDown = false;
  S.chainStats = { solW: 0, solL: 0, baseW: 0, baseL: 0 };
  S.solEnabled = true;
  S.scanCount = 0;
  S.rejectCount = 0;
  S.pumpCount = 0;
  S.gradCount = 0;
  S.dayStartFund = S.sessionFund;
  S.fund = S.sessionFund;

  connectSS();
  fetchDSTokens();
  updateSolPrice();

  scanI = setInterval(runScan, 500);
  gradI = setInterval(runGradSniper, 1000);
  exitI = setInterval(checkExitCriteria, 10000);
  priceI = setInterval(updateOpenTradePrices, 2000);
  dsI = setInterval(fetchDSTokens, CFG.DS_INTERVAL);
  cleanI = setInterval(cleanPool, 3600000);
  solPriceI = setInterval(updateSolPrice, 600000);

  log('BunkerBuster STARTED | Fund: $' + S.sessionFund + ' | SL: ' + S.stopLossPct + '% | Max: ' + S.maxOpen, 'info');
}

function stopBot() {
  S.running = false;
  if (scanI) clearInterval(scanI);
  if (gradI) clearInterval(gradI);
  if (exitI) clearInterval(exitI);
  if (priceI) clearInterval(priceI);
  if (dsI) clearInterval(dsI);
  if (cleanI) clearInterval(cleanI);
  if (solPriceI) clearInterval(solPriceI);

  if (S.stats.t > 0) {
    var session = {
      date: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
      startTime: S.startTime ? new Date(S.startTime).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '',
      endTime: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
      trades: S.stats.t,
      wins: S.stats.w,
      losses: S.stats.l,
      winRate: S.stats.t > 0 ? parseFloat((S.stats.w / S.stats.t * 100).toFixed(1)) : 0,
      startFund: S.sessionFund,
      endFund: parseFloat(S.fund.toFixed(2)),
      savings: parseFloat(S.savings.toFixed(2)),
      pnl: parseFloat((S.fund + S.savings - S.sessionFund).toFixed(2)),
      totalFees: parseFloat(S.totalFees.toFixed(4)),
    };
    P.sessions.unshift(session);
    savePortfolio();
  }

  log('Bot stopped | W: ' + S.stats.w + ' L: ' + S.stats.l + ' | Fund: $' + S.fund.toFixed(2), 'info');
}

// ── API ROUTES ────────────────────────────────────────────────
app.get('/api/state', function(req, res) {
  res.json({
    fund: S.fund,
    savings: S.savings,
    stats: S.stats,
    running: S.running,
    pumpLive: S.pumpLive,
    pumpCount: S.pumpCount,
    poolSize: S.tokens.size,
    scanCount: S.scanCount,
    rejectCount: S.rejectCount,
    openTrades: S.open.map(function(t) {
      return {
        id: t.id, sc: t.sc, size: t.size, tpl: t.tpl, tpPct: t.tpPct,
        sl: t.sl, chain: t.chain || 'solana', slip: t.slip, mint: t.mint, src: t.src,
        entryPrice: t.entryPrice, currentPrice: t.currentPrice, peakPrice: t.peakPrice,
        realPnl: t.realPnl, realPnlPct: t.realPnlPct, isGrad: t.isGrad,
        gradSolAtEntry: t.gradSolAtEntry, openedAt: t.openedAt, startTime: t.startTime,
        tok: { n: t.tok.n, src: t.tok.src, liq: t.tok.liq },
      };
    }),
    closedTrades: S.closed.slice(0, 20),
    gradCount: S.gradCount,
    gradCandidates: S.gradCandidates.size,
    permanentBans: S.permanentBans.size,
    tempBans: S.tempBans.size,
    dscPool: S.dscPool,
    solPool: S.solPool,
    basePool: S.basePool,
    dscKey: S.dscKey,
    bestTrade: S.bestTrade,
    sessionFund: S.sessionFund,
    takeProfitMode: S.takeProfitMode,
    takeProfitPct: S.takeProfitPct,
    stopLossPct: S.stopLossPct,
    totalFees: S.totalFees,
    maxOpen: S.maxOpen,
    fundStopLossPct: S.fundStopLossPct,
    windingDown: S.windingDown,
    currentLossPct: S.dayStartFund > 0
      ? parseFloat(((S.dayStartFund - S.fund) / S.dayStartFund * 100).toFixed(2)) : 0,
    chainStats: S.chainStats,
    solEnabled: S.solEnabled,
    baseEnabled: S.baseEnabled,
    maxPool: S.maxPool,
    logs: S.logs.slice(0, 100),
    sources: S.sources,
    startTime: S.startTime,
    wallets: {
      trading: TRADING_WALLET ? TRADING_WALLET.slice(0, 8) + '...' : 'not set',
      savings: SAVINGS_WALLET ? SAVINGS_WALLET.slice(0, 8) + '...' : 'not set',
      baseTrading: BASE_TRADING_WALLET ? BASE_TRADING_WALLET.slice(0, 8) + '...' : 'not set',
      baseSavings: BASE_SAVINGS_WALLET ? BASE_SAVINGS_WALLET.slice(0, 8) + '...' : 'not set',
    },
  });
});

app.post('/api/start', function(req, res) { startBot(); res.json({ success: true }); });
app.get('/api/start', function(req, res) { startBot(); res.json({ success: true }); });
app.post('/api/stop', function(req, res) { stopBot(); res.json({ success: true }); });
app.get('/api/stop', function(req, res) { stopBot(); res.json({ success: true }); });
app.post('/api/sell/:id', function(req, res) { closeTradeReal(req.params.id, 'Manual sell'); res.json({ success: true }); });

app.post('/api/settings', function(req, res) {
  if (req.body.tradingWallet) TRADING_WALLET = req.body.tradingWallet;
  if (req.body.savingsWallet) SAVINGS_WALLET = req.body.savingsWallet;
  if (req.body.baseTradingWallet) BASE_TRADING_WALLET = req.body.baseTradingWallet;
  if (req.body.baseSavingsWallet) BASE_SAVINGS_WALLET = req.body.baseSavingsWallet;
  if (req.body.sessionFund !== undefined) {
    var sf = parseFloat(req.body.sessionFund);
    if (!isNaN(sf) && sf > 0) { S.sessionFund = parseFloat(sf.toFixed(2)); log('Session fund: $' + S.sessionFund, 'info'); }
  }
  if (req.body.takeProfitMode && (req.body.takeProfitMode === 'TRAIL' || req.body.takeProfitMode === 'FIXED')) {
    S.takeProfitMode = req.body.takeProfitMode; log('Take profit mode: ' + S.takeProfitMode, 'info');
  }
  if (req.body.takeProfitPct !== undefined) {
    var tp = parseFloat(req.body.takeProfitPct);
    if (!isNaN(tp) && tp > 0 && tp <= 1000) { S.takeProfitPct = parseFloat(tp.toFixed(1)); log('TP target: ' + S.takeProfitPct + '%', 'info'); }
  }
  if (req.body.stopLossPct !== undefined) {
    var sl = parseFloat(req.body.stopLossPct);
    if (!isNaN(sl) && sl > 0 && sl <= 100) { S.stopLossPct = parseFloat(sl.toFixed(1)); log('Stop loss: ' + S.stopLossPct + '%', 'info'); }
  }
  if (req.body.maxOpen !== undefined) {
    var mo = parseInt(req.body.maxOpen);
    if (!isNaN(mo) && mo >= 1 && mo <= 20) { S.maxOpen = mo; log('Max open: ' + S.maxOpen, 'info'); }
  }
  if (req.body.fundStopLossPct !== undefined) {
    var fl = parseFloat(req.body.fundStopLossPct);
    if (!isNaN(fl) && fl >= 1 && fl <= 100) { S.fundStopLossPct = parseFloat(fl.toFixed(1)); log('Fund SL: ' + S.fundStopLossPct + '%', 'info'); }
  }
  if (req.body.maxPool !== undefined) {
    var mp = parseInt(req.body.maxPool);
    if (!isNaN(mp) && mp >= 1000 && mp <= 50000) { S.maxPool = mp; log('Max pool: ' + S.maxPool, 'info'); }
  }
  if (req.body.solEnabled !== undefined) {
    S.solEnabled = req.body.solEnabled === true || req.body.solEnabled === 'true';
    log('Solana: ' + (S.solEnabled ? 'ON' : 'OFF'), 'info');
  }
  if (req.body.baseEnabled !== undefined) {
    S.baseEnabled = req.body.baseEnabled === true || req.body.baseEnabled === 'true';
    log('Base: ' + (S.baseEnabled ? 'ON' : 'OFF'), 'info');
  }
  res.json({ success: true });
});

app.get('/api/portfolio', function(req, res) {
  res.json({
    allTime: P.allTime, bestTrade: P.bestTrade, worstTrade: P.worstTrade,
    sessions: P.sessions.slice(0, 50), totalSessions: P.sessions.length, totalTrades: P.trades.length,
  });
});

app.get('/api/portfolio/trades', function(req, res) {
  var trades = P.trades;
  var q = req.query;
  if (q.date) trades = trades.filter(function(t) { return t.closedDate === q.date; });
  if (q.token) { var tok = q.token.toUpperCase(); trades = trades.filter(function(t) { return t.name && t.name.toUpperCase().indexOf(tok) >= 0; }); }
  if (q.chain && q.chain !== 'all') trades = trades.filter(function(t) { return t.chain === q.chain; });
  if (q.src && q.src !== 'all') trades = trades.filter(function(t) { return t.src === q.src; });
  if (q.result === 'win') trades = trades.filter(function(t) { return t.pnl > 0; });
  if (q.result === 'loss') trades = trades.filter(function(t) { return t.pnl <= 0; });
  if (q.exit && q.exit !== 'all') trades = trades.filter(function(t) { return t.closeReason && t.closeReason.toLowerCase().indexOf(q.exit.toLowerCase()) >= 0; });
  var page = parseInt(q.page) || 0;
  var limit = parseInt(q.limit) || 50;
  if (limit > 99999) limit = trades.length;
  var total = trades.length;
  trades = trades.slice(page * limit, (page + 1) * limit);
  res.json({ trades: trades, total: total, page: page, pages: Math.ceil(total / limit) });
});

app.get('/api/portfolio/export', function(req, res) {
  var rows = [
    ['Name','Mint','Chain','Source','Size','EntryPrice','ExitPrice','PnL','PnLPct','TickCount','PeakGainPct','SecToFirstUpdate','CloseReason','OpenedAt','ClosedAt','ClosedDate','Fees'].join(',')
  ];
  P.trades.forEach(function(t) {
    rows.push([
      csvSafe(t.name),
      t.mint || '',
      t.chain || '',
      t.src || '',
      t.size || 0,
      t.entryPrice || 0,
      t.exitPrice || 0,
      t.pnl || 0,
      t.pnlPct || 0,
      t.priceUpdates || 0,
      t.peakGainPct !== undefined ? t.peakGainPct : '',
      t.secToFirstUpdate !== null && t.secToFirstUpdate !== undefined ? t.secToFirstUpdate : '',
      csvSafe(t.closeReason),
      csvSafe(t.openedAt),
      csvSafe(t.closedAt),
      t.closedDate || '',
      t.fees || 0,
    ].join(','));
  });
  var csv = rows.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bunkerbuster_trades_' + Date.now() + '.csv"');
  res.send(csv);
});

function csvSafe(val) {
  var s = (val === undefined || val === null) ? '' : String(val);
  if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

app.post('/api/portfolio/clear', function(req, res) {
  P = { allTime: { t: 0, w: 0, l: 0, totalPnl: 0, totalFees: 0, bestPnl: 0, worstPnl: 0 }, bestTrade: null, worstTrade: null, trades: [], sessions: [] };
  savePortfolio();
  res.json({ success: true });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', pool: S.tokens.size, pump: S.pumpCount, fund: S.fund });
});

app.get('/', function(req, res) { res.sendFile(__dirname + '/index.html'); });

app.listen(PORT, function() {
  console.log('BunkerBuster — Sniper Bot — running on port ' + PORT);
  loadPortfolio();
  connectSS();
  fetchDSTokens();
  updateSolPrice();
});
