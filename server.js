const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── API KEYS ──────────────────────────────────────────────────
const ST_KEY = '75035862-d3fe-40a5-9a47-7d6338685930'; // Solana Tracker
const ST_URL = 'https://data.solanatracker.io';

// ── CONFIG ────────────────────────────────────────────────────
const CFG = {
  // Position & risk
  MAX_OPEN: 4,           // max simultaneous trades (all types)
  MAX_GRAD: 2,           // max graduation sniper trades at once
  MAX_POS: 0.08,         // max position size as % of fund
  SOL_GAS: 0.001,        // estimated gas cost per trade

  // Trail stop — NEVER CHANGE THESE
  TRAIL_ACT: 0.04,       // trail activates at 4% gain
  TRAIL_PB: 0.02,        // exit on 2% pullback from peak

  // Exit criteria
  LOSS_LIM: 0.10,        // daily loss limit 10%
  STALE_TIME: 300000,    // exit if no price movement for 5 minutes
  NO_PRICE_TIMEOUT: 180000, // exit if no price data after 3 minutes
  STOP_LOSS: 0.18,       // stop loss at -18%

  // Solana Tracker token filters — research based safety checklist
  MIN_MCAP: 100000,      // minimum market cap $100k — catch earlier momentum
  MAX_MCAP: 25000000,    // maximum market cap $25M — small caps only
  MIN_LIQ: 10000,        // minimum liquidity $10k
  MIN_VOL_1H: 10000,     // minimum 1h volume $10k — catch earlier momentum
  MAX_RISK: 5,           // maximum risk score — relaxed from 3 to 5
  MAX_DEV: 5,            // maximum dev holding % — stays strict
  MAX_TOP10: 30,         // maximum top 10 holders %
  MIN_BUYS: 5,           // minimum buy transactions — relaxed from 10
  MIN_HOLDERS: 10,       // minimum token holders — relaxed from 50

  // Graduation sniper config
  GRAD_ENTRY_SOL: 100,   // enter when bonding curve hits 100 SOL
  GRAD_MAX_SOL: 480,     // don't enter above 480 SOL
  GRAD_TARGET: 500,      // graduation at ~500 SOL
  GRAD_POS: 0.10,        // 10% position size for grad plays

  // Solana Tracker credit management
  ST_SEARCH_INTERVAL: 600000,  // search every 10 minutes
  ST_TREND_INTERVAL: 600000,   // trending every 10 minutes
  ST_PRICE_INTERVAL: 30000,    // price check every 30 seconds per open trade
};

// ── STATE ─────────────────────────────────────────────────────
const S = {
  tokens: new Map(),     // discovered tokens ready to trade
  open: [],              // open trades
  closed: [],            // closed trades history
  stats: { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0 },
  fund: 100,
  savings: 0,
  running: false,
  pumpLive: false,
  pumpCount: 0,
  scanCount: 0,
  rejectCount: 0,
  stCredits: 0,          // Solana Tracker credit usage counter
  logs: [],
  sources: {},
  startTime: null,
  dayStartFund: 100,
  gradCandidates: new Map(),
  gradCount: 0,
  staleCooldown: new Map(), // blocks re-entry after stale
};

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, type) {
  type = type || 'info';
  S.logs.unshift({ msg, type, time: new Date().toLocaleTimeString() });
  if (S.logs.length > 500) S.logs.pop();
  console.log('[' + type.toUpperCase() + '] ' + msg);
}

// ── SOL PRICE ─────────────────────────────────────────────────
var SOL_PRICE_USD = 150;

async function updateSolPrice() {
  try {
    var res = await fetch(ST_URL + '/price?token=So11111111111111111111111111111111111111112', {
      headers: { 'x-api-key': ST_KEY },
      timeout: 5000
    });
    if (!res.ok) return;
    var data = await res.json();
    if (data && data.price) {
      SOL_PRICE_USD = parseFloat(data.price);
      S.stCredits++;
    }
  } catch(e) {}
}

// ── SOLANA TRACKER — PRICE ────────────────────────────────────
// Gets real time price for a single token by mint address
async function getSTPrice(mint) {
  try {
    var res = await fetch(ST_URL + '/price?token=' + mint, {
      headers: { 'x-api-key': ST_KEY },
      timeout: 5000
    });
    if (!res.ok) return null;
    var data = await res.json();
    S.stCredits++;
    return data && data.price ? parseFloat(data.price) : null;
  } catch(e) { return null; }
}

// ── SOLANA TRACKER — TOKEN DISCOVERY ─────────────────────────
// Searches for tokens matching our safety checklist
// Modeled on BONKbot approach — simple checklist, let market do the rest
async function fetchSTTokens() {
  try {
    var params = new URLSearchParams({
      // Market cap range — small caps that can actually move
      minMarketCap: CFG.MIN_MCAP,
      maxMarketCap: CFG.MAX_MCAP,
      // Must have real liquidity
      minLiquidity: CFG.MIN_LIQ,
      // Must have 1h volume — active right now
      minVolume_1h: CFG.MIN_VOL_1H,
      // Hard safety checks — non negotiable
      freezeAuthority: 'null',
      mintAuthority: 'null',
      // Sort by current hour volume — most active first
      sortBy: 'volume_1h',
      sortOrder: 'desc',
      // Full format gives us riskScore, dev%, lpBurn, holders
      format: 'full',
      limit: 100,
    });

    var res = await fetch(ST_URL + '/search?' + params.toString(), {
      headers: { 'x-api-key': ST_KEY },
      timeout: 10000
    });
    if (!res.ok) throw new Error('ST search failed: ' + res.status);
    var data = await res.json();
    S.stCredits++;

    var tokens = data.data || [];
    var added = 0;

    tokens.forEach(function(t) {
      // Apply additional safety filters not available in search params
      if (!passesChecklist(t)) return;

      var tok = mapSTToken(t, 'ST-SEARCH');
      if (tok) {
        S.tokens.set(tok.n + tok.id, tok);
        added++;
      }
    });

    S.sources['ST-SEARCH'] = 'live:' + added;
    log('ST Search: ' + added + ' tokens passed safety checklist', 'info');
  } catch(e) {
    S.sources['ST-SEARCH'] = 'dead';
    log('ST Search failed: ' + e.message, 'warn');
  }
}

// ── SOLANA TRACKER — TRENDING ─────────────────────────────────
// Gets trending tokens by 1h volume — momentum tokens
async function fetchSTTrending() {
  try {
    var res = await fetch(ST_URL + '/tokens/trending/1h', {
      headers: { 'x-api-key': ST_KEY },
      timeout: 10000
    });
    if (!res.ok) throw new Error('ST trending failed: ' + res.status);
    var data = await res.json();
    S.stCredits++;

    var tokens = Array.isArray(data) ? data : (data.tokens || data.data || []);
    var added = 0;

    tokens.forEach(function(t) {
      // Apply safety checklist
      if (!passesChecklist(t)) return;

      var tok = mapSTToken(t, 'ST-TREND');
      if (tok) {
        S.tokens.set(tok.n + tok.id, tok);
        added++;
      }
    });

    S.sources['ST-TREND'] = 'live:' + added;
    log('ST Trending: ' + added + ' tokens passed safety checklist', 'info');
  } catch(e) {
    S.sources['ST-TREND'] = 'dead';
    log('ST Trending failed: ' + e.message, 'warn');
  }
}

// ── SAFETY CHECKLIST ─────────────────────────────────────────
// Hard rules based on deep dive research — protects against rugs
// while not eliminating good early stage tokens
function passesChecklist(t) {
  // HARD RULE — Must not be mintable — non negotiable
  if (t.mintAuthority !== null && t.mintAuthority !== undefined &&
      t.mintAuthority !== 'null' && t.mintAuthority !== '') return false;

  // HARD RULE — Must not be freezable — non negotiable
  if (t.freezeAuthority !== null && t.freezeAuthority !== undefined &&
      t.freezeAuthority !== 'null' && t.freezeAuthority !== '') return false;

  // LP must be at least 80% burned — research shows 95%+ is gold standard
  // but 80% still eliminates most rug risk
  if (t.lpBurn !== undefined && t.lpBurn !== null && t.lpBurn < 80) return false;

  // Risk score must be acceptable — 5 or under on 10 point scale
  if (t.riskScore !== undefined && t.riskScore !== null && t.riskScore > CFG.MAX_RISK) return false;

  // Dev holding must be low — stays strict at 5%
  if (t.dev !== undefined && t.dev !== null && t.dev > CFG.MAX_DEV) return false;

  // Top 10 holders must not be too concentrated
  if (t.top10 !== undefined && t.top10 !== null && t.top10 > CFG.MAX_TOP10) return false;

  // Must have market cap in range
  var mcap = t.marketCapUsd || 0;
  if (mcap < CFG.MIN_MCAP || mcap > CFG.MAX_MCAP) return false;

  // Must have real liquidity
  var liq = t.liquidityUsd || 0;
  if (liq < CFG.MIN_LIQ) return false;

  // Must have minimum buy activity
  if (t.buys !== undefined && t.buys < CFG.MIN_BUYS) return false;

  // Must have more buys than sells — buying pressure required
  if (t.buys !== undefined && t.sells !== undefined && t.sells > 0) {
    var bsr = t.buys / t.sells;
    if (bsr < 1.0) return false;
  }

  // NOTE: hasSocials removed — research shows social presence is a
  // lagging indicator. Best opportunities come BEFORE major social presence.
  // Rug protection comes from mint/freeze/LP/dev checks above.

  // Must have a valid mint address
  if (!t.mint) return false;

  return true;
}

// ── MAP SOLANA TRACKER TOKEN ──────────────────────────────────
// Converts Solana Tracker API response to our internal token format
function mapSTToken(t, src) {
  try {
    var symbol = (t.symbol || t.name || '???').toUpperCase().slice(0, 12);
    var mint = t.mint;
    var liq = t.liquidityUsd || 0;
    var mcap = t.marketCapUsd || 0;
    var price = t.priceUsd ? parseFloat(t.priceUsd) : null;
    var vol1h = t.volume_1h || 0;
    var vol24h = t.volume_24h || t.volume || 0;
    var buys = t.buys || 0;
    var sells = t.sells || 1;
    var bsr = buys / Math.max(sells, 1);
    var holders = t.holders || 0;
    var riskScore = t.riskScore || 0;
    var dev = t.dev || 0;
    var lpBurn = t.lpBurn || 0;

    // Age from createdAt timestamp
    var age = t.createdAt ?
      (Date.now() - t.createdAt) / 3600000 : 24;

    return {
      id: mint,
      n: symbol,
      src: src,
      mint: mint,
      liq, mcap, price,
      vol1: vol1h,
      vol24: vol24h,
      bsr,
      buys, sells,
      holders,
      riskScore,
      dev,
      lpBurn,
      age,
      isNew: age < 1,
      hot: age < 0.17,
      hasSocials: t.hasSocials || false,
      mintAuthority: t.mintAuthority,
      freezeAuthority: t.freezeAuthority,
      // Safety flags
      rug: false,
      hp: false,
    };
  } catch(e) { return null; }
}

// ── PUMP.FUN BONDING CURVE PRICE ──────────────────────────────
function calcPumpPrice(d) {
  var vSol = parseFloat(d.vSolInBondingCurve) || 0;
  var vTokens = parseFloat(d.vTokensInBondingCurve) || 0;
  if (vSol > 0 && vTokens > 0) {
    return (vSol / vTokens) * SOL_PRICE_USD;
  }
  var mcapSol = parseFloat(d.marketCapSol) || 0;
  if (mcapSol > 0) {
    return (mcapSol / 1000000000) * SOL_PRICE_USD;
  }
  return null;
}

var pumpPrices = {}; // mint -> { price, ts }

function updatePumpPrice(mint, d) {
  var price = calcPumpPrice(d);
  if (price && price > 0) {
    pumpPrices[mint] = { price, ts: Date.now() };
    // Update any open grad trades on this token
    S.open.forEach(function(trade) {
      if (trade.mint === mint && trade.isGrad) {
        trade.currentPrice = price;
        if (!trade.entryPrice) {
          trade.entryPrice = price;
          trade.peakPrice = price;
          log('GRAD PRICE SET ' + trade.tok.n + ' $' + price.toFixed(8), 'info');
        }
        if (trade.entryPrice > 0) {
          var pct = (price - trade.entryPrice) / trade.entryPrice;
          trade.realPnlPct = pct;
          trade.realPnl = trade.size * pct;
          if (price > trade.peakPrice) trade.peakPrice = price;
          if (!trade.lastPrice || Math.abs(price - trade.lastPrice) / trade.lastPrice > 0.001) {
            trade.lastPriceChange = Date.now();
            trade.lastPrice = price;
          }
          // Trail stop check for grad trades
          if (trade.tpl === 'TRAIL') {
            var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
            if (peakGain >= CFG.TRAIL_ACT) {
              var pullback = (trade.peakPrice - price) / trade.peakPrice;
              if (pullback >= CFG.TRAIL_PB) {
                log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain*100).toFixed(1) + '% | Pullback -' + (pullback*100).toFixed(1) + '%', 'win');
                closeTradeReal(trade.id, 'Trail exit');
                return;
              }
            }
          }
          // Stop loss check
          if (pct <= -CFG.STOP_LOSS) {
            log('SL HIT ' + trade.tok.n + ' | ' + (pct*100).toFixed(1) + '%', 'loss');
            closeTradeReal(trade.id, 'Stop loss hit');
          }
        }
      }
    });
  }
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
      log('Pump.fun WebSocket LIVE — Graduation Sniper active', 'pump');
    });
    pumpWs.on('message', function(raw) {
      try {
        var d = JSON.parse(raw.toString());
        // New token launch
        if (d.mint && (d.symbol || d.name)) {
          var mint = d.mint;
          var name = ((d.symbol || d.name || 'NEW') + '').toUpperCase().slice(0, 12);
          var launchPrice = calcPumpPrice(d);
          if (launchPrice) pumpPrices[mint] = { price: launchPrice, ts: Date.now() };
          S.pumpCount++;
          S.sources['PUMP.FUN'] = 'live:' + S.pumpCount;
          if (S.pumpCount % 20 === 0) {
            log('Pump.fun: ' + S.pumpCount + ' launches - latest: ' + name, 'pump');
          }
        }
        // Trade events — graduation tracking + price updates
        if (d.txType === 'buy' || d.txType === 'sell') {
          var mint2 = d.mint;
          if (mint2) {
            updatePumpPrice(mint2, d);
            // Graduation sniper tracking
            var solInCurve = parseFloat(d.vSolInBondingCurve) || 0;
            var mcapSol = parseFloat(d.marketCapSol) || 0;
            var tokenName = ((d.symbol || d.name || '') + '').toUpperCase().slice(0, 12);
            if (solInCurve > 0 || mcapSol > 0) {
              var existing = S.gradCandidates.get(mint2) || {
                name: tokenName, mint: mint2,
                firstSeen: Date.now(), buys: 0, sells: 0
              };
              existing.solInCurve = solInCurve;
              existing.mcapSol = mcapSol;
              existing.lastUpdate = Date.now();
              if (d.txType === 'buy') existing.buys = (existing.buys || 0) + 1;
              else existing.sells = (existing.sells || 0) + 1;
              existing.bsr = existing.buys / Math.max(existing.sells, 1);
              existing.price = calcPumpPrice(d);
              if (solInCurve >= CFG.GRAD_ENTRY_SOL && solInCurve <= CFG.GRAD_MAX_SOL) {
                existing.nearGrad = true;
                var pct = Math.floor((solInCurve / CFG.GRAD_TARGET) * 100);
                if (!existing.logged || existing.loggedPct !== pct) {
                  existing.logged = true;
                  existing.loggedPct = pct;
                  log('🎓 GRAD CANDIDATE ' + (existing.name || mint2.slice(0,8)) + ' | ' + solInCurve.toFixed(0) + ' SOL | ' + pct + '% to graduation | BSR ' + existing.bsr.toFixed(1) + 'x', 'pump');
                }
              } else {
                existing.nearGrad = false;
              }
              S.gradCandidates.set(mint2, existing);
            }
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
// Uses Solana Tracker price endpoint — real and reliable
// Runs every 2 minutes per trade to conserve credits
var priceTimers = {}; // tradeId -> interval

function startTradePrice(trade) {
  if (priceTimers[trade.id]) return;
  priceTimers[trade.id] = setInterval(async function() {
    if (!S.open.find(function(t) { return t.id === trade.id; })) {
      clearInterval(priceTimers[trade.id]);
      delete priceTimers[trade.id];
      return;
    }
    if (!trade.mint) return;

    // Grad trades priced via Pump.fun WebSocket — skip here
    if (trade.isGrad) return;

    var price = await getSTPrice(trade.mint);
    if (!price || price <= 0) return;

    trade.currentPrice = price;

    // Track price movement for stale detection
    if (!trade.lastPrice || Math.abs(price - trade.lastPrice) / trade.lastPrice > 0.001) {
      trade.lastPriceChange = Date.now();
      trade.lastPrice = price;
    }

    if (!trade.entryPrice || trade.entryPrice <= 0) {
      trade.entryPrice = price;
      trade.peakPrice = price;
      log('PRICE SET ' + trade.tok.n + ' entry $' + price.toFixed(8) + ' [ST]', 'info');
      return;
    }

    // Calculate P&L
    var pct = (price - trade.entryPrice) / trade.entryPrice;
    trade.realPnlPct = pct;
    trade.realPnl = trade.size * pct;

    // Update peak
    if (price > trade.peakPrice) trade.peakPrice = price;

    // Trail stop check
    if (trade.tpl === 'TRAIL') {
      var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
      if (peakGain >= CFG.TRAIL_ACT) {
        var pullback = (trade.peakPrice - price) / trade.peakPrice;
        if (pullback >= CFG.TRAIL_PB) {
          log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain*100).toFixed(1) + '% | Pullback -' + (pullback*100).toFixed(1) + '%', 'win');
          closeTradeReal(trade.id, 'Trail exit');
          return;
        }
      }
    }

    // Stop loss check
    if (pct <= -CFG.STOP_LOSS) {
      log('SL HIT ' + trade.tok.n + ' | ' + (pct*100).toFixed(1) + '%', 'loss');
      closeTradeReal(trade.id, 'Stop loss hit');
    }
  }, CFG.ST_PRICE_INTERVAL);
}

// ── CLOSE TRADE ───────────────────────────────────────────────
function closeTradeReal(id, reason) {
  var i = S.open.findIndex(function(t) { return t.id === id; });
  if (i === -1) return;
  var tr = S.open[i];

  // Stop price tracking
  if (priceTimers[id]) {
    clearInterval(priceTimers[id]);
    delete priceTimers[id];
  }

  var pnl = 0;
  var closeReason = reason || 'Manual sell';

  if (tr.entryPrice && tr.currentPrice) {
    var pricePct = (tr.currentPrice - tr.entryPrice) / tr.entryPrice;
    var slippage = tr.slip || 0.005;
    pnl = tr.size * pricePct - tr.size * slippage - CFG.SOL_GAS;
  } else {
    pnl = -(CFG.SOL_GAS);
    closeReason = reason + ' (no price data)';
  }

  if (pnl > 0) {
    S.fund = parseFloat((S.fund + pnl * 0.80).toFixed(4));
    S.savings = parseFloat((S.savings + pnl * 0.20).toFixed(4));
    var prefix = tr.isGrad ? '🎓 GRAD ' : '';
    log(prefix + tr.tok.n + ' +$' + pnl.toFixed(2) + ' | saved $' + (pnl*0.20).toFixed(2) + ' | ' + closeReason, 'win');
    S.stats.w++;
    if (tr.isGrad) S.stats.gw++;
  } else {
    S.fund = parseFloat((S.fund + pnl).toFixed(4));
    var prefix2 = tr.isGrad ? '🎓 GRAD ' : '';
    log(prefix2 + tr.tok.n + ' -$' + Math.abs(pnl).toFixed(2) + ' | ' + closeReason, 'loss');
    S.stats.l++;
    if (tr.isGrad) S.stats.gl++;
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

  // Stale cooldown — block re-entry for 30 minutes
  if (reason && reason.toLowerCase().indexOf('stale') >= 0) {
    var cooldownKey = tr.tok.n + (tr.mint || '');
    S.staleCooldown.set(cooldownKey, Date.now());
    log('COOLDOWN ' + tr.tok.n + ' — blocked 30min after stale', 'warn');
  }

  // Daily loss limit
  if (S.fund < S.dayStartFund * (1 - CFG.LOSS_LIM)) {
    log('Daily loss limit hit — bot stopped', 'rug');
    stopBot();
  }
}

// ── CRITERIA-BASED EXIT CHECKER ───────────────────────────────
function checkExitCriteria() {
  var now = Date.now();
  S.open.slice().forEach(function(t) {
    var age = now - t.startTime;

    // No price data after 3 minutes — close
    if (!t.entryPrice && age > CFG.NO_PRICE_TIMEOUT) {
      log('TIMEOUT ' + t.tok.n + ' — no price after 3min', 'warn');
      closeTradeReal(t.id, 'Timeout — no price data');
      return;
    }

    if (!t.entryPrice || !t.currentPrice) return;

    // Token went stale — no price movement for 2 minutes
    var lastMove = t.lastPriceChange || t.startTime;
    if ((now - lastMove) > CFG.STALE_TIME && age > 60000) {
      log('STALE ' + t.tok.n + ' — no movement for 2min', 'warn');
      closeTradeReal(t.id, 'Token went stale');
      return;
    }

    // Graduation trade — auto exit when graduated
    if (t.isGrad) {
      var gradCand = S.gradCandidates.get(t.mint);
      if (gradCand && gradCand.solInCurve >= CFG.GRAD_TARGET) {
        log('🎓 GRADUATED ' + t.tok.n + ' — listing on DEX, exiting', 'win');
        closeTradeReal(t.id, 'Token graduated to DEX');
        return;
      }
    }
  });
}

// ── GRADUATION SNIPER ─────────────────────────────────────────
async function runGradSniper() {
  if (!S.running) return;
  if (S.fund < 1) return;

  var openGrads = S.open.filter(function(t) { return t.isGrad; }).length;
  if (openGrads >= CFG.MAX_GRAD) return;

  var now = Date.now();

  if (S.gradCandidates.size > 0 && Math.random() < 0.01) {
    log('GRAD POOL: ' + S.gradCandidates.size + ' candidates tracked', 'info');
  }

  for (var entry of S.gradCandidates.entries()) {
    var mint = entry[0];
    var cand = entry[1];

    if (!cand.nearGrad) continue;
    var age = (now - cand.firstSeen) / 1000;
    if (age < 30) continue;
    if (cand.bsr < 1.2) continue;
    if (S.open.find(function(t) { return t.mint === mint; })) continue;
    if (!cand.price || cand.price <= 0) continue;
    var totalTxns = (cand.buys || 0) + (cand.sells || 0);
    if (totalTxns < 3) continue;

    var size = parseFloat((S.fund * Math.min(CFG.GRAD_POS, CFG.MAX_POS)).toFixed(4));
    if (size < 0.50) continue;

    var slip = 0.008;
    S.fund = parseFloat((S.fund - size * slip).toFixed(4));
    var solPct = Math.floor((cand.solInCurve / CFG.GRAD_TARGET) * 100);

    var trade = {
      id: Math.random().toString(36).substr(2, 9),
      tok: { n: cand.name || mint.slice(0, 8), src: 'GRAD', liq: cand.solInCurve * SOL_PRICE_USD },
      sc: 85,
      reasons: [
        'Near graduation ' + solPct + '%',
        'BSR ' + cand.bsr.toFixed(1) + 'x',
        cand.solInCurve.toFixed(0) + ' SOL in curve',
        age.toFixed(0) + 's building'
      ],
      size, tpl: 'TRAIL',
      sl: 0.12, slip, mint,
      entryPrice: cand.price,
      currentPrice: cand.price,
      peakPrice: cand.price,
      realPnl: 0, realPnlPct: 0,
      isGrad: true,
      gradSolAtEntry: cand.solInCurve,
      openedAt: new Date().toLocaleTimeString(),
      startTime: now
    };

    S.open.push(trade);
    S.gradCount++;
    log('🎓 GRAD ENTER ' + trade.tok.n + ' | ' + solPct + '% to grad | SOL ' + cand.solInCurve.toFixed(0) + ' | BSR ' + cand.bsr.toFixed(1) + 'x | $' + size.toFixed(2) + ' | Entry $' + cand.price.toFixed(8), 'entry');
    break;
  }
}

// ── MAIN SCAN ─────────────────────────────────────────────────
// Scans the token pool — tokens already passed safety checklist at discovery
var scanI = null, scanIdx = 0;
async function runScan() {
  if (!S.running || S.tokens.size === 0) return;
  if (S.fund < 1) { stopBot(); return; }

  var tokens = Array.from(S.tokens.values());
  if (tokens.length === 0) return;

  var tok = tokens[scanIdx % tokens.length];
  scanIdx++;
  S.scanCount++;

  // Skip WS tokens — graduation sniper only
  if (tok.src === 'WS') return;

  // Check stale cooldown
  var cooldownKey = tok.n + (tok.mint || '');
  var lastStale = S.staleCooldown.get(cooldownKey);
  if (lastStale && (Date.now() - lastStale) < 1800000) return;

  // Already in an open trade
  if (S.open.find(function(t) { return t.tok.n === tok.n; })) return;

  // Max open trades reached
  if (S.open.length >= CFG.MAX_OPEN) return;

  // Token must pass the checklist — should already have passed at discovery
  // but double check key fields
  if (!tok.mint) {
    S.rejectCount++;
    return;
  }

  // Must have real buy pressure
  if (tok.bsr < 1.0) {
    S.rejectCount++;
    log('SKIP ' + tok.n + ' [' + tok.src + '] — selling pressure (BSR ' + tok.bsr.toFixed(2) + ')', 'reject');
    // Remove from pool — conditions changed
    S.tokens.delete(tok.n + tok.id);
    return;
  }

  // Position sizing
  var size = parseFloat((S.fund * CFG.MAX_POS).toFixed(4));
  if (size < 0.50) { S.rejectCount++; return; }

  var slip = parseFloat(Math.min(0.004 + (size / Math.max(tok.liq, 100)) * 2.5, 0.15).toFixed(4));
  S.fund = parseFloat((S.fund - size * slip).toFixed(4));

  var trade = {
    id: Math.random().toString(36).substr(2, 9),
    tok: Object.assign({}, tok),
    sc: 85, // passed checklist — high confidence
    reasons: buildReasons(tok),
    size: parseFloat(size.toFixed(4)),
    tpl: 'TRAIL',
    sl: CFG.STOP_LOSS,
    slip, mint: tok.mint,
    entryPrice: tok.price || null,
    currentPrice: tok.price || null,
    peakPrice: tok.price || null,
    realPnl: 0, realPnlPct: 0,
    openedAt: new Date().toLocaleTimeString(),
    startTime: Date.now()
  };

  S.open.push(trade);

  // Start price tracking via Solana Tracker
  startTradePrice(trade);

  var priceStr = tok.price ? ' | Entry $' + tok.price.toFixed(8) : ' | Price tracking...';
  log('ENTER ' + tok.n + ' [' + tok.src + '] | MCap $' + (tok.mcap/1000).toFixed(0) + 'k | Liq $' + (tok.liq/1000).toFixed(0) + 'k | BSR ' + tok.bsr.toFixed(1) + 'x | $' + size.toFixed(2) + priceStr, 'entry');
}

// ── BUILD ENTRY REASONS ───────────────────────────────────────
function buildReasons(tok) {
  var reasons = [];
  if (tok.mintAuthority === null || tok.mintAuthority === 'null') reasons.push('✅ Not mintable');
  if (tok.freezeAuthority === null || tok.freezeAuthority === 'null') reasons.push('✅ Not freezable');
  if (tok.lpBurn >= 100) reasons.push('✅ LP burned');
  if (tok.hasSocials) reasons.push('✅ Has socials');
  if (tok.riskScore !== undefined) reasons.push('Risk score ' + tok.riskScore + '/10');
  if (tok.bsr > 0) reasons.push('BSR ' + tok.bsr.toFixed(1) + 'x');
  reasons.push('MCap $' + (tok.mcap/1000).toFixed(0) + 'k');
  return reasons;
}

// ── TOKEN POOL MANAGEMENT ─────────────────────────────────────
// Removes old tokens to keep pool fresh
function cleanPool() {
  var now = Date.now();
  var removed = 0;
  S.tokens.forEach(function(tok, key) {
    // Remove tokens older than 2 hours — stale data
    if (tok.age && tok.age > 2) {
      S.tokens.delete(key);
      removed++;
    }
  });
  // Clean expired cooldowns
  S.staleCooldown.forEach(function(ts, key) {
    if (now - ts > 1800000) S.staleCooldown.delete(key);
  });
  if (removed > 0) log('Pool cleaned: ' + removed + ' old tokens removed', 'info');
}

// ── BOT CONTROL ───────────────────────────────────────────────
var fetchSearchI = null, fetchTrendI = null, gradI = null, exitI = null, cleanI = null;

function startBot() {
  if (S.running) return;
  S.running = true;
  S.startTime = Date.now();
  S.dayStartFund = S.fund;

  // Connect Pump.fun WebSocket for graduation sniper
  connectPump();

  // Initial data fetch
  fetchSTTokens();
  fetchSTTrending();
  updateSolPrice();

  // Scheduled fetches — credit aware intervals
  fetchSearchI = setInterval(fetchSTTokens, CFG.ST_SEARCH_INTERVAL);
  fetchTrendI = setInterval(fetchSTTrending, CFG.ST_TREND_INTERVAL);

  // Main scan loop
  scanI = setInterval(runScan, 500);

  // Graduation sniper
  gradI = setInterval(runGradSniper, 1000);

  // Exit criteria checker
  exitI = setInterval(checkExitCriteria, 10000);

  // Pool cleanup
  cleanI = setInterval(cleanPool, 3600000);

  // SOL price update every 10 minutes
  setInterval(updateSolPrice, 600000);

  log('MemeBot V14 started | Solana Tracker powered | Safety checklist active | Graduation Sniper live', 'info');
  log('ST Credits available: 10,000/month | Budget: ~333/day', 'info');
}

function stopBot() {
  S.running = false;
  clearInterval(scanI);
  clearInterval(fetchSearchI);
  clearInterval(fetchTrendI);
  clearInterval(gradI);
  clearInterval(exitI);
  clearInterval(cleanI);
  // Stop all price tracking intervals
  Object.keys(priceTimers).forEach(function(id) {
    clearInterval(priceTimers[id]);
    delete priceTimers[id];
  });
  log('Bot stopped | ST Credits used this session: ' + S.stCredits, 'info');
}

// ── API ROUTES ────────────────────────────────────────────────
app.get('/api/state', function(req, res) {
  var openTrades = S.open.map(function(t) {
    return {
      id: t.id, sc: t.sc, size: t.size, tpl: t.tpl, sl: t.sl, slip: t.slip,
      mint: t.mint, entryPrice: t.entryPrice, currentPrice: t.currentPrice,
      peakPrice: t.peakPrice, realPnl: t.realPnl, realPnlPct: t.realPnlPct,
      isGrad: t.isGrad, gradSolAtEntry: t.gradSolAtEntry,
      openedAt: t.openedAt, startTime: t.startTime,
      reasons: (t.reasons || []).slice(0, 4),
      tok: { n: t.tok.n, src: t.tok.src, liq: t.tok.liq }
    };
  });
  res.json({
    fund: S.fund, savings: S.savings, stats: S.stats,
    running: S.running, pumpLive: S.pumpLive, pumpCount: S.pumpCount,
    poolSize: S.tokens.size, scanCount: S.scanCount, rejectCount: S.rejectCount,
    stCredits: S.stCredits,
    openTrades, closedTrades: S.closed.slice(0, 20),
    gradCount: S.gradCount, gradCandidates: S.gradCandidates.size,
    logs: S.logs.slice(0, 100), sources: S.sources, startTime: S.startTime
  });
});

app.post('/api/start', function(req, res) { startBot(); res.json({ success: true }); });
app.post('/api/stop', function(req, res) { stopBot(); res.json({ success: true }); });
app.post('/api/sell/:id', function(req, res) { closeTradeReal(req.params.id, 'Manual sell'); res.json({ success: true }); });
app.get('/health', function(req, res) { res.json({ status: 'ok', pool: S.tokens.size, pump: S.pumpCount, credits: S.stCredits }); });

app.get('/', function(req, res) {
  res.sendFile(__dirname + '/index.html');
});

// ── START SERVER ──────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('MemeBot V14 — Solana Tracker powered — running on port ' + PORT);
  connectPump();
  fetchSTTokens();
  fetchSTTrending();
  updateSolPrice();
  // Bot does NOT auto-start — Mike controls manually
});
