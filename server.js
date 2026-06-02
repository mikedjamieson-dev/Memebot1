'use strict';
const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── API KEYS & CONFIG FROM ENV ────────────────────────────────
const ST_KEY = process.env.ST_KEY || '75035862-d3fe-40a5-9a47-7d6338685930';
const ST_URL = 'https://data.solanatracker.io';

var TRADING_WALLET = process.env.TRADING_WALLET || '';
var SAVINGS_WALLET = process.env.SAVINGS_WALLET || '';

// ── BOT CONFIGURATION ─────────────────────────────────────────
const CFG = {
  MAX_POS: 0.05,
  MAX_OPEN: 8,
  MAX_GRAD: 2,
  SOL_GAS: 0.001,

  // Trail stop — NEVER CHANGE THESE TWO VALUES
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
  stCredits: 0,
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
  dscKey: 0,
  bestTrade: null,
  sessionFund: 100,
  takeProfitMode: "TRAIL",
  takeProfitPct: 5,
  stopLossPct: 10,
};

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, type) {
  type = type || 'info';
  var entry = { msg, type, time: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) };
  S.logs.unshift(entry);
  if (S.logs.length > 500) S.logs.pop();
  console.log('[' + type.toUpperCase() + '] ' + msg);
}

// ── SOL PRICE ─────────────────────────────────────────────────
var SOL_PRICE_USD = 150;
async function updateSolPrice() {
  try {
    var res = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana/So11111111111111111111111111111111111111112', { timeout: 5000 });
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
  log('PERMANENT BAN ' + mint.slice(0,8) + '... | ' + reason, 'warn');
}

function tempBan(mint, reason) {
  S.tempBans.set(mint, { bannedAt: Date.now(), reason });
  log('12HR BAN ' + mint.slice(0,8) + '... | ' + reason, 'warn');
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
      log('RECHECK ' + mint.slice(0,8) + '... — 12hr ban expired, reconsidering', 'info');
    }
  });
}

// ── SAFETY CHECKLIST ─────────────────────────────────────────
async function runSafetyChecklist(mint, tokenData, isPumpFun) {
  if (tokenData.mintAuthority && tokenData.mintAuthority !== 'null' && tokenData.mintAuthority !== '') {
    tempBan(mint, 'Mint authority not renounced');
    return false;
  }

  if (tokenData.freezeAuthority && tokenData.freezeAuthority !== 'null' && tokenData.freezeAuthority !== '') {
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

// ── HONEYPOT CHECK ────────────────────────────────────────────
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

// ── DEXSCREENER PRICE ─────────────────────────────────────────
async function getDSPrice(mint, pairAddress) {
  try {
    var url = pairAddress
      ? 'https://api.dexscreener.com/latest/dex/pairs/solana/' + pairAddress
      : 'https://api.dexscreener.com/tokens/v1/solana/' + mint;
    var res = await fetch(url, { timeout: 5000 });
    if (!res.ok) return null;
    var data = await res.json();
    var pairs = data.pairs || (Array.isArray(data) ? data : []);
    if (pairs.length > 0 && pairs[0].priceUsd) {
      return parseFloat(pairs[0].priceUsd);
    }
    return null;
  } catch(e) { return null; }
}

// ── DEXSCREENER TOKEN DISCOVERY ─────────────────────────────
// Rotating keyword search every 5 minutes
// Feeds into the pool with the same safety checklist

var DS_QUERIES = ['solana meme', 'pump fun sol', 'pepe sol', 'dog sol', 'cat sol', 'moon sol', 'ai sol', 'degen sol'];
var dsQueryIdx = 0;

async function fetchDSTokens() {
  var now = Date.now();
  var query = DS_QUERIES[dsQueryIdx % DS_QUERIES.length];
  dsQueryIdx++;
  try {
    var res = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(query), { timeout: 10000 });
    if (res.ok) {
      var data = await res.json();
      var pairs = (data.pairs || []).filter(function(p) { return p.chainId === 'solana'; });
      var added = 0;
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
        var tokenData = {
          mintAuthority: null,
          freezeAuthority: null,
          lpBurn: undefined,
          dev: undefined,
        };
        var safe = await runSafetyChecklist(mint, tokenData, true);
        if (!safe) continue;
        S.tokens.set(mint, {
          mint, price,
          n: (pair.baseToken && pair.baseToken.symbol || '???').toUpperCase().slice(0, 12),
          src: 'DSC',
          liq, mcap, vol1h, buys, sells,
          age,
          pairAddress: pair.pairAddress || null,
          addedAt: Date.now(),
        });
        added++;
        S.dscKey++;
      }
      if (added > 0) log('DS Keyword [' + query + ']: ' + added + ' added | Pool: ' + S.tokens.size, 'info');
    }
  } catch(e) {}

  S.dscPool = Array.from(S.tokens.values()).filter(function(t) { return t.src === 'DSC'; }).length;
  S.sources['DSC'] = 'live:' + S.tokens.size;
}

// ── PUMP.FUN PRICE CALCULATION ────────────────────────────────
function calcPumpPrice(d) {
  var vSol = parseFloat(d.vSolInBondingCurve) || 0;
  var vTokens = parseFloat(d.vTokensInBondingCurve) || 0;
  if (vSol > 0 && vTokens > 0) return (vSol / vTokens) * SOL_PRICE_USD;
  var mcapSol = parseFloat(d.marketCapSol) || 0;
  if (mcapSol > 0) return (mcapSol / 1000000000) * SOL_PRICE_USD;
  return null;
}

// ── PUMP.FUN WEBSOCKET ────────────────────────────────────────
var pumpPrices = {};
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
      log('Pump.fun WebSocket LIVE — Sniper + Graduation active', 'pump');
    });

    pumpWs.on('message', async function(raw) {
      try {
        var d = JSON.parse(raw.toString());

        // ── NEW TOKEN LAUNCH ──────────────────────────────────
        var isNewToken = d.mint && (d.symbol || d.name) &&
                         d.txType !== 'buy' && d.txType !== 'sell';
        if (isNewToken) {
          var mint = d.mint;
          var name = ((d.symbol || d.name || 'NEW') + '').toUpperCase().slice(0, 12);
          S.pumpCount++;
          S.sources['PUMP.FUN'] = 'live:' + S.pumpCount;
          if (S.pumpCount % 20 === 0) log('Pump.fun: ' + S.pumpCount + ' launches — latest: ' + name, 'pump');

          if (isBanned(mint)) return;
          if (S.tokens.has(mint)) return;

          if (S.tokens.size >= CFG.MAX_POOL) {
            var worstKey = null;
            var worstBSR = Infinity;
            S.tokens.forEach(function(tok, key) {
              if (S.open.find(function(t) { return t.mint === key; })) return;
              var bsr = tok.buys / Math.max(tok.sells || 1, 1);
              if (bsr < worstBSR) {
                worstBSR = bsr;
                worstKey = key;
              }
            });
            if (worstKey) S.tokens.delete(worstKey);
          }

          var tokenData = {
            mintAuthority: null,
            freezeAuthority: d.freezeAuthority || null,
            lpBurn: undefined,
            dev: undefined,
          };

          var safe = await runSafetyChecklist(mint, tokenData, true);
          if (!safe) return;

          var price = calcPumpPrice(d);
          if (price) pumpPrices[mint] = { price, solInCurve: 0, ts: Date.now() };

          S.tokens.set(mint, {
            mint, price,
            n: name,
            src: 'PUMP',
            liq: parseFloat(d.initialBuy || 0) * SOL_PRICE_USD,
            mcap: parseFloat(d.marketCapSol || 0) * SOL_PRICE_USD,
            vol1h: 0,
            buys: 1, sells: 0,
            age: 0,
            pairAddress: null,
            addedAt: Date.now(),
            isNew: true,
          });
          log('NEW TOKEN ' + name + ' | $' + (price ? price.toFixed(8) : 'pending') + ' | Added to pool', 'info');
        }

        // ── TRADE EVENT — price + graduation tracking ─────────
        if ((d.txType === 'buy' || d.txType === 'sell') && d.mint) {
          var mint2 = d.mint;
          var price2 = calcPumpPrice(d);
          var solInCurve = parseFloat(d.vSolInBondingCurve) || 0;

          if (price2) {
            pumpPrices[mint2] = { price: price2, solInCurve, ts: Date.now() };
          }

          var poolTok = S.tokens.get(mint2);
          if (poolTok && price2) {
            poolTok.price = price2;
            if (d.txType === 'buy') poolTok.buys = (poolTok.buys || 0) + 1;
            else poolTok.sells = (poolTok.sells || 0) + 1;
          }

          S.open.forEach(function(trade) {
            if (trade.mint === mint2 && trade.src === 'PUMP') {
              trade.currentPrice = price2 || trade.currentPrice;
              if (price2 && trade.entryPrice > 0) {
                if (price2 > (trade.peakPrice || 0)) trade.peakPrice = price2;
                trade.realPnlPct = (price2 - trade.entryPrice) / trade.entryPrice;
                trade.realPnl = trade.size * trade.realPnlPct;
                if (!trade.lastPrice || Math.abs(price2 - trade.lastPrice) / trade.lastPrice > 0.001) {
                  trade.lastPriceChange = Date.now();
                  trade.lastPrice = price2;
                }
              }
            }
          });

          // ── GRADUATION SNIPER TRACKING ────────────────────
          var name2 = ((d.symbol || d.name || '') + '').toUpperCase().slice(0, 12);
          if (solInCurve > 0) {
            var existing = S.gradCandidates.get(mint2) || {
              name: name2, mint: mint2, firstSeen: Date.now(), buys: 0, sells: 0
            };
            existing.solInCurve = solInCurve;
            existing.price = price2;
            existing.lastUpdate = Date.now();
            if (d.txType === 'buy') existing.buys = (existing.buys || 0) + 1;
            else existing.sells = (existing.sells || 0) + 1;
            existing.bsr = existing.buys / Math.max(existing.sells, 1);
            if (solInCurve >= CFG.GRAD_ENTRY_SOL && solInCurve <= CFG.GRAD_MAX_SOL) {
              existing.nearGrad = true;
              var pct = Math.floor((solInCurve / CFG.GRAD_TARGET) * 100);
              if (!existing.logged || existing.loggedPct !== pct) {
                existing.logged = true;
                existing.loggedPct = pct;
                log('🎓 GRAD CANDIDATE ' + (name2 || mint2.slice(0,8)) + ' | ' + solInCurve.toFixed(0) + ' SOL | ' + pct + '% to graduation | BSR ' + existing.bsr.toFixed(1) + 'x', 'pump');
              }
            } else {
              existing.nearGrad = false;
            }
            S.gradCandidates.set(mint2, existing);
          }
        }
      } catch(e) {}
    });

    pumpWs.on('error', function() {
      S.pumpLive = false;
      S.sources['PUMP.FUN'] = 'dead';
    });
    pumpWs.on('close', function() {
      S.pumpLive = false;
      S.sources['PUMP.FUN'] = 'dead';
      setTimeout(connectPump, 10000);
    });
  } catch(e) { setTimeout(connectPump, 15000); }
}

// ── PRICE TRACKING FOR OPEN TRADES ───────────────────────────
// Polls DexScreener every 2 seconds for non-Pump.fun trades
async function updateOpenTradePrices() {
  var trades = S.open.filter(function(t) { return !t.isGrad && t.src !== 'PUMP' && t.mint; });
  if (trades.length === 0) return;

  for (var i = 0; i < trades.length; i++) {
    var trade = trades[i];
    var price = await getDSPrice(trade.mint, trade.pairAddress);
    if (!price || price <= 0) continue;

    if (trade.currentPrice && trade.currentPrice > 0) {
      var change = Math.abs(price - trade.currentPrice) / trade.currentPrice;
      if (change > 0.90) {
        log('PRICE SANITY REJECT ' + trade.tok.n + ' | ' + (change*100).toFixed(0) + '% move — ignoring', 'warn');
        continue;
      }
    }

    trade.currentPrice = price;
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

    // Fixed take profit check
    if (trade.tpl === 'FIXED' && pct >= (trade.tpPct / 100)) {
      log('TP HIT ' + trade.tok.n + ' | +' + (pct*100).toFixed(1) + '% | Target ' + trade.tpPct + '%', 'win');
      closeTradeReal(trade.id, 'Take profit hit');
      continue;
    }

    // Trail stop check
    if (trade.tpl === 'TRAIL' && trade.peakPrice && trade.entryPrice) {
      var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
      if (peakGain >= CFG.TRAIL_ACT) {
        var pullback = (trade.peakPrice - price) / trade.peakPrice;
        if (pullback >= CFG.TRAIL_PB) {
          log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain*100).toFixed(1) + '% | Pullback -' + (pullback*100).toFixed(1) + '%', 'win');
          closeTradeReal(trade.id, 'Trail exit');
          continue;
        }
      }
    }

    // Stop loss — uses trade's own sl set at entry
    if (pct <= -(trade.sl || 0.10)) {
      log('SL HIT ' + trade.tok.n + ' | ' + (pct*100).toFixed(1) + '%', 'loss');
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

  if (pnl > CFG.MIN_SPLIT_WIN) {
    var savings = parseFloat((pnl * CFG.SAVINGS_PCT).toFixed(4));
    var trading = parseFloat((pnl * (1 - CFG.SAVINGS_PCT)).toFixed(4));
    S.fund = parseFloat((S.fund + trading).toFixed(4));
    S.savings = parseFloat((S.savings + savings).toFixed(4));
    log((tr.isGrad ? '🎓 ' : '') + tr.tok.n + ' +$' + pnl.toFixed(2) + ' | saved $' + savings.toFixed(2) + ' | ' + closeReason, 'win');
    S.stats.w++;
    if (tr.isGrad) S.stats.gw++;
  } else if (pnl > 0) {
    S.fund = parseFloat((S.fund + pnl).toFixed(4));
    log((tr.isGrad ? '🎓 ' : '') + tr.tok.n + ' +$' + pnl.toFixed(2) + ' (below split min) | ' + closeReason, 'win');
    S.stats.w++;
    if (tr.isGrad) S.stats.gw++;
  } else {
    S.fund = parseFloat((S.fund + pnl).toFixed(4));
    log((tr.isGrad ? '🎓 ' : '') + tr.tok.n + ' -$' + Math.abs(pnl).toFixed(2) + ' | ' + closeReason, 'loss');
    S.stats.l++;
    if (tr.isGrad) S.stats.gl++;
  }

  S.stats.t++;
  S.closed.unshift({
    tok: tr.tok,
    closeReason: closeReason,
    pnl: parseFloat(pnl.toFixed(4)),
    pnlPct: tr.entryPrice && tr.currentPrice ? parseFloat(((tr.currentPrice - tr.entryPrice) / tr.entryPrice * 100).toFixed(2)) : 0,
    entryPrice: tr.entryPrice,
    exitPrice: tr.currentPrice,
    size: tr.size,
    slip: tr.slip || 0,
    openedAt: tr.openedAt,
    closedAt: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    src: tr.src || (tr.tok && tr.tok.src) || 'unknown',
    isGrad: tr.isGrad || false,
  });
  if (S.closed.length > 200) S.closed.pop();
  S.open.splice(i, 1);

  // Track best trade of session — never resets
  if (!S.bestTrade || pnl > S.bestTrade.pnl) {
    S.bestTrade = {
      name: tr.tok && tr.tok.n ? tr.tok.n : "?",
      entryPrice: tr.entryPrice || 0,
      exitPrice: tr.currentPrice || 0,
      size: tr.size || 0,
      pnl: parseFloat(pnl.toFixed(4)),
      pnlPct: tr.entryPrice && tr.currentPrice ? parseFloat(((tr.currentPrice - tr.entryPrice) / tr.entryPrice * 100).toFixed(2)) : 0,
    };
  }

  var cooldownKey = (tr.tok && tr.tok.n || '') + (tr.mint || '');

  // Loss cooldown — 30 minutes full block
  if (pnl < 0) {
    S.cooldowns.set(cooldownKey, Date.now());
    log('COOLDOWN ' + (tr.tok && tr.tok.n) + ' — blocked 30min after loss', 'warn');
  }

  // Win cooldown — 5 minutes only
  // Store timestamp offset so the 30min check expires after 5min
  if (pnl > 0) {
    S.cooldowns.set(cooldownKey, Date.now() - (CFG.COOLDOWN_MS - CFG.WIN_COOLDOWN_MS));
    log('COOLDOWN ' + (tr.tok && tr.tok.n) + ' — blocked 5min after win', 'info');
  }

  if (S.fund < S.dayStartFund * (1 - CFG.LOSS_LIM)) {
    log('Daily loss limit hit — bot stopped', 'rug');
    stopBot();
  }
}

// ── EXIT CRITERIA CHECKER ─────────────────────────────────────
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

    if (t.isGrad && t.tok && t.tpl === 'TRAIL' && t.entryPrice > 0 && t.currentPrice > 0) {
      var peakGain = (t.peakPrice - t.entryPrice) / t.entryPrice;
      if (peakGain >= CFG.TRAIL_ACT) {
        var pullback = (t.peakPrice - t.currentPrice) / t.peakPrice;
        if (pullback >= CFG.TRAIL_PB) {
          log('TRAIL EXIT ' + t.tok.n + ' | Peak +' + (peakGain*100).toFixed(1) + '% | Pullback -' + (pullback*100).toFixed(1) + '%', 'win');
          closeTradeReal(t.id, 'Trail exit');
          return;
        }
      }
      var pct = (t.currentPrice - t.entryPrice) / t.entryPrice;
      if (pct <= -(t.sl || 0.10)) {
        log('SL HIT ' + t.tok.n + ' | ' + (pct*100).toFixed(1) + '%', 'loss');
        closeTradeReal(t.id, 'Stop loss hit');
      }
    }
  });
}

// ── GRADUATION SNIPER ─────────────────────────────────────────
async function runGradSniper() {
  if (!S.running || S.fund < 1) return;
  var openGrads = S.open.filter(function(t) { return t.isGrad; }).length;
  if (openGrads >= CFG.MAX_GRAD) return;

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
    var pct = Math.floor((cand.solInCurve / CFG.GRAD_TARGET) * 100);

    var trade = {
      id: Math.random().toString(36).substr(2, 9),
      tok: { n: cand.name || mint.slice(0,8), src: 'GRAD', liq: cand.solInCurve * SOL_PRICE_USD },
      sc: 90,
      size, tpl: 'TRAIL',
      sl: CFG.STOP_LOSS,
      slip, mint,
      src: 'GRAD',
      entryPrice: cand.price,
      currentPrice: cand.price,
      peakPrice: cand.price,
      realPnl: 0, realPnlPct: 0,
      isGrad: true,
      gradSolAtEntry: cand.solInCurve,
      openedAt: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
      startTime: Date.now(),
      lastPriceChange: Date.now(),
    };

    S.open.push(trade);
    S.gradCount++;
    log('🎓 GRAD ENTER ' + trade.tok.n + ' | ' + pct + '% to grad | ' + cand.solInCurve.toFixed(0) + ' SOL | BSR ' + cand.bsr.toFixed(1) + 'x | $' + size.toFixed(2) + ' | Entry $' + cand.price.toFixed(8), 'entry');
    break;
  }
}

// ── MAIN SNIPER SCAN ──────────────────────────────────────────
var scanI = null;
var scanIdx = 0;

async function runScan() {
  if (!S.running || S.tokens.size === 0) return;
  if (S.fund < 1) { stopBot(); return; }
  if (S.open.length >= CFG.MAX_OPEN) return;

  var tokens = Array.from(S.tokens.values());
  if (tokens.length === 0) return;

  var tok = tokens[scanIdx % tokens.length];
  scanIdx++;
  S.scanCount++;

  if (!tok || !tok.mint) return;

  if (isBanned(tok.mint)) {
    S.tokens.delete(tok.mint);
    return;
  }

  var bsr = tok.buys / Math.max(tok.sells || 1, 1);
  if (bsr < 0.8) {
    S.rejectCount++;
    return;
  }

  var cooldownKey = tok.n + tok.mint;
  var lastCooldown = S.cooldowns.get(cooldownKey);
  if (lastCooldown && (Date.now() - lastCooldown) < CFG.COOLDOWN_MS) return;

  if (S.open.find(function(t) { return t.mint === tok.mint; })) return;

  if (tok.buys < 3) return;

  var size = parseFloat((S.fund * CFG.MAX_POS).toFixed(4));
  if (size < 0.50) { S.rejectCount++; return; }

  var entryPrice = null;
  if (tok.src === 'PUMP' && pumpPrices[tok.mint]) {
    entryPrice = pumpPrices[tok.mint].price;
  } else {
    entryPrice = await getDSPrice(tok.mint, tok.pairAddress);
  }

  if (!entryPrice || entryPrice <= 0) {
    S.rejectCount++;
    return;
  }

  var slip = parseFloat(Math.min(0.004 + (size / Math.max(tok.liq || 1000, 100)) * 2.5, 0.15).toFixed(4));
  S.fund = parseFloat((S.fund - size * slip).toFixed(4));

  var trade = {
    id: Math.random().toString(36).substr(2, 9),
    tok: Object.assign({}, tok),
    sc: 85,
    size: parseFloat(size.toFixed(4)),
    tpl: S.takeProfitMode,
    tpPct: S.takeProfitPct,
    sl: S.stopLossPct / 100,
    slip, mint: tok.mint,
    src: tok.src,
    pairAddress: tok.pairAddress || null,
    entryPrice,
    currentPrice: entryPrice,
    peakPrice: entryPrice,
    lastPrice: entryPrice,
    lastPriceChange: Date.now(),
    realPnl: 0, realPnlPct: 0,
    isGrad: false,
    openedAt: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    startTime: Date.now(),
  };

  S.open.push(trade);
  log('ENTER ' + tok.n + ' [' + tok.src + '] | MCap $' + ((tok.mcap || 0)/1000).toFixed(0) + 'k | Liq $' + ((tok.liq || 0)/1000).toFixed(0) + 'k | $' + size.toFixed(2) + ' | Entry $' + entryPrice.toFixed(8), 'entry');
}

// ── POOL CLEANUP ──────────────────────────────────────────────
function cleanPool() {
  var now = Date.now();
  var removed = 0;
  S.tokens.forEach(function(tok, mint) {
    if (tok.addedAt && (now - tok.addedAt) > CFG.POOL_AGE_MS && !S.open.find(function(t) { return t.mint === mint; })) {
      S.tokens.delete(mint);
      removed++;
    }
  });
  S.cooldowns.forEach(function(ts, key) {
    if (now - ts > CFG.COOLDOWN_MS) S.cooldowns.delete(key);
  });
  recheckExpiredBans();
  if (removed > 0) log('Pool cleaned: ' + removed + ' old tokens removed | Pool: ' + S.tokens.size, 'info');
}

// ── BOT CONTROL ───────────────────────────────────────────────
var gradI = null, exitI = null, cleanI = null, priceI = null, dsI = null, solPriceI = null;

function startBot() {
  if (S.running) return;
  S.running = true;
  S.startTime = Date.now();
  S.dscPool = 0;
  S.dscKey = 0;
  S.bestTrade = null;
  S.dayStartFund = S.sessionFund;
  S.fund = S.sessionFund;

  connectPump();
  fetchDSTokens();
  updateSolPrice();

  scanI = setInterval(runScan, 500);
  gradI = setInterval(runGradSniper, 1000);
  exitI = setInterval(checkExitCriteria, 10000);
  priceI = setInterval(updateOpenTradePrices, 2000);
  dsI = setInterval(fetchDSTokens, CFG.DS_INTERVAL);
  cleanI = setInterval(cleanPool, 3600000);
  solPriceI = setInterval(updateSolPrice, 600000);

  log('🚀 MemeBot V15 STARTED | Sniper Bot | Pump.fun WebSocket LIVE | Graduation Sniper ACTIVE', 'info');
  log('Settings: ' + CFG.MAX_POS*100 + '% position | ' + CFG.STOP_LOSS*100 + '% SL | Trail ' + CFG.TRAIL_ACT*100 + '%/' + CFG.TRAIL_PB*100 + '% | ' + CFG.MAX_OPEN + ' max trades', 'info');
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
  log('Bot stopped | Trades: ' + S.stats.t + ' | W: ' + S.stats.w + ' L: ' + S.stats.l + ' | Fund: $' + S.fund.toFixed(2) + ' | Savings: $' + S.savings.toFixed(2), 'info');
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
    stCredits: S.stCredits,
    openTrades: S.open.map(function(t) {
      return {
        id: t.id, sc: t.sc, size: t.size, tpl: t.tpl, sl: t.sl,
        slip: t.slip, mint: t.mint, src: t.src,
        entryPrice: t.entryPrice, currentPrice: t.currentPrice,
        peakPrice: t.peakPrice, realPnl: t.realPnl, realPnlPct: t.realPnlPct,
        isGrad: t.isGrad, gradSolAtEntry: t.gradSolAtEntry,
        openedAt: t.openedAt, startTime: t.startTime,
        tok: { n: t.tok.n, src: t.tok.src, liq: t.tok.liq }
      };
    }),
    closedTrades: S.closed.slice(0, 20),
    gradCount: S.gradCount,
    gradCandidates: S.gradCandidates.size,
    permanentBans: S.permanentBans.size,
    tempBans: S.tempBans.size,
    dscPool: S.dscPool,
    dscKey: S.dscKey,
    bestTrade: S.bestTrade,
    sessionFund: S.sessionFund,
    takeProfitMode: S.takeProfitMode,
    takeProfitPct: S.takeProfitPct,
    stopLossPct: S.stopLossPct,
    logs: S.logs.slice(0, 100),
    sources: S.sources,
    startTime: S.startTime,
    wallets: {
      trading: TRADING_WALLET ? TRADING_WALLET.slice(0,8) + '...' : 'not set',
      savings: SAVINGS_WALLET ? SAVINGS_WALLET.slice(0,8) + '...' : 'not set',
    }
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
  if (req.body.sessionFund !== undefined) {
    var sf = parseFloat(req.body.sessionFund);
    if (!isNaN(sf) && sf > 0) {
      S.sessionFund = parseFloat(sf.toFixed(2));
      log('Session fund updated to ' + S.sessionFund, 'info');
    }
  }
  if (req.body.takeProfitMode && (req.body.takeProfitMode === 'TRAIL' || req.body.takeProfitMode === 'FIXED')) {
    S.takeProfitMode = req.body.takeProfitMode;
    log('Take profit mode: ' + S.takeProfitMode, 'info');
  }
  if (req.body.takeProfitPct !== undefined) {
    var tp = parseFloat(req.body.takeProfitPct);
    if (!isNaN(tp) && tp > 0 && tp <= 1000) {
      S.takeProfitPct = parseFloat(tp.toFixed(1));
      log('Take profit target: ' + S.takeProfitPct + '%', 'info');
    }
  }
  if (req.body.stopLossPct !== undefined) {
    var sl = parseFloat(req.body.stopLossPct);
    if (!isNaN(sl) && sl > 0 && sl <= 100) {
      S.stopLossPct = parseFloat(sl.toFixed(1));
      log('Stop loss: ' + S.stopLossPct + '%', 'info');
    }
  }
  log('Settings updated | Trading: ' + (TRADING_WALLET || 'not set') + ' | Savings: ' + (SAVINGS_WALLET || 'not set'), 'info');
  res.json({ success: true });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', pool: S.tokens.size, pump: S.pumpCount, fund: S.fund });
});

app.get('/', function(req, res) { res.sendFile(__dirname + '/index.html'); });

// ── START SERVER ──────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('MemeBot V15 — Sniper Bot — running on port ' + PORT);
  connectPump();
  fetchDSTokens();
  updateSolPrice();
});
