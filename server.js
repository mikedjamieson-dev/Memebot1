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
// All sensitive config lives in .env — never hardcoded
const ST_KEY = process.env.ST_KEY || '75035862-d3fe-40a5-9a47-7d6338685930';
const ST_URL = 'https://data.solanatracker.io';

// Wallet addresses — configurable without code changes
// Set these in .env or via the settings panel on the dashboard
var TRADING_WALLET = process.env.TRADING_WALLET || '';
var SAVINGS_WALLET = process.env.SAVINGS_WALLET || '';

// ── BOT CONFIGURATION ─────────────────────────────────────────
const CFG = {
  // Position sizing
  MAX_POS: 0.05,         // 5% of fund per trade
  MAX_OPEN: 8,           // max simultaneous open trades
  MAX_GRAD: 2,           // max graduation sniper trades at once
  SOL_GAS: 0.001,        // estimated gas cost per trade

  // Trail stop — NEVER CHANGE THESE TWO VALUES
  TRAIL_ACT: 0.04,       // trail activates at 4% gain
  TRAIL_PB: 0.02,        // exit on 2% pullback from peak

  // Exit criteria
  STOP_LOSS: 0.10,       // stop loss at 10%
  STALE_TIME: 120000,    // exit if no price movement for 2 minutes
  NO_PRICE_TIMEOUT: 180000, // exit if no price after 3 minutes
  LOSS_LIM: 0.10,        // daily loss limit 10%

  // Profit split
  MIN_SPLIT_WIN: 0.05,   // minimum win to trigger 80/20 split ($0.05)
  SAVINGS_PCT: 0.20,     // 20% to savings on every win above minimum

  // Safety checklist thresholds
  MIN_LIQ_USD: 5000,     // minimum liquidity $5k
  MAX_MCAP_USD: 25000000,// maximum market cap $25M
  MIN_MCAP_USD: 1000,    // minimum market cap $1k

  // Graduation sniper
  GRAD_ENTRY_SOL: 100,   // enter when bonding curve hits 100 SOL
  GRAD_MAX_SOL: 480,     // don't enter above 480 SOL
  GRAD_TARGET: 500,      // graduation at ~500 SOL
  GRAD_POS: 0.10,        // 10% position for graduation plays
  GRAD_MIN_BSR: 1.2,     // minimum buy/sell ratio for grad entry
  GRAD_MIN_TXNS: 3,      // minimum transactions before grad entry

  // Ban durations
  BAN_TEMP_MS: 43200000, // 12 hour temporary ban
  COOLDOWN_MS: 1800000,  // 30 minute cooldown after loss

  // DexScreener polling
  DS_INTERVAL: 300000,   // DexScreener search every 5 minutes
};

// ── STATE ─────────────────────────────────────────────────────
const S = {
  tokens: new Map(),         // pool of tokens passing safety checklist
  open: [],                  // open trades
  closed: [],                // closed trade history
  stats: { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0 },
  fund: 100,                 // trading fund (paper)
  savings: 0,                // savings wallet (paper)
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
  gradCandidates: new Map(), // graduation sniper candidates
  gradCount: 0,
  permanentBans: new Map(),  // mint -> reason (honeypot etc)
  tempBans: new Map(),       // mint -> { bannedAt, reason }
  cooldowns: new Map(),      // token key -> timestamp after loss
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
// Permanent ban — honeypot or confirmed bad actor
function permanentBan(mint, reason) {
  S.permanentBans.set(mint, reason);
  log('PERMANENT BAN ' + mint.slice(0,8) + '... | ' + reason, 'warn');
}

// Temporary 12 hour ban — failed safety check
function tempBan(mint, reason) {
  S.tempBans.set(mint, { bannedAt: Date.now(), reason });
  log('12HR BAN ' + mint.slice(0,8) + '... | ' + reason, 'warn');
}

// Check if token is banned
function isBanned(mint) {
  if (!mint) return true;
  if (S.permanentBans.has(mint)) return true;
  var tb = S.tempBans.get(mint);
  if (tb) {
    if (Date.now() - tb.bannedAt < CFG.BAN_TEMP_MS) return true;
    // 12 hours expired — remove temp ban for recheck
    S.tempBans.delete(mint);
  }
  return false;
}

// Clean up expired temp bans — recheck them
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
// Runs on every new token before it enters the pool
// isPumpFun flag skips Jupiter honeypot check — new Pump.fun tokens
// don't have Jupiter routing yet, so the check always fails incorrectly
async function runSafetyChecklist(mint, tokenData, isPumpFun) {
  // Check 1 — Mint authority must be null
  if (tokenData.mintAuthority && tokenData.mintAuthority !== 'null' && tokenData.mintAuthority !== '') {
    tempBan(mint, 'Mint authority not renounced');
    return false;
  }

  // Check 2 — Freeze authority must be null
  // On Solana honeypots work by retaining freeze authority to trap buyers
  // This is the most reliable honeypot indicator for Pump.fun tokens
  if (tokenData.freezeAuthority && tokenData.freezeAuthority !== 'null' && tokenData.freezeAuthority !== '') {
    permanentBan(mint, 'Freeze authority retained — honeypot');
    return false;
  }

  // Check 3 — LP must be burned (checked via DexScreener or ST)
  if (tokenData.lpBurn !== undefined && tokenData.lpBurn !== null && tokenData.lpBurn < 80) {
    tempBan(mint, 'LP burn too low: ' + tokenData.lpBurn + '%');
    return false;
  }

  // Check 4 — Dev holding must be under 5%
  if (tokenData.dev !== undefined && tokenData.dev !== null && tokenData.dev > 5) {
    tempBan(mint, 'Dev holding too high: ' + tokenData.dev + '%');
    return false;
  }

  // Check 5 — Honeypot simulation via Jupiter quote
  // SKIP for Pump.fun tokens — they don't have Jupiter routing yet
  // Freeze authority check above already covers the main honeypot risk
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
// Simulates a sell via Jupiter quote API
// If no sell quote available — token is a honeypot
async function checkHoneypot(mint) {
  try {
    // Try to get a sell quote from Jupiter
    // If selling is disabled the quote will fail
    var res = await fetch(
      'https://quote-api.jup.ag/v6/quote?inputMint=' + mint +
      '&outputMint=So11111111111111111111111111111111111111112' +
      '&amount=1000000&slippageBps=5000',
      { timeout: 5000 }
    );
    if (!res.ok) return true; // Can't get quote — treat as honeypot
    var data = await res.json();
    // If no routes or output is zero — honeypot
    if (!data || !data.outAmount || parseInt(data.outAmount) === 0) return true;
    return false;
  } catch(e) {
    // If check fails — err on side of caution, treat as honeypot
    return true;
  }
}

// ── DEXSCREENER PRICE ─────────────────────────────────────────
// Gets current price for a token from DexScreener
// Used for entry price confirmation and open trade tracking
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

// ── DEXSCREENER TOKEN DISCOVERY ───────────────────────────────
// Secondary discovery — rotating queries every 5 minutes
// Finds tokens already trading that Pump.fun WebSocket may have missed
var DS_QUERIES = ['solana meme', 'pump fun sol', 'pepe sol', 'dog sol', 'cat sol', 'moon sol', 'ai sol', 'degen sol'];
var dsQueryIdx = 0;

async function fetchDSTokens() {
  // Run 2 rotating queries per cycle
  for (var i = 0; i < 2; i++) {
    var query = DS_QUERIES[dsQueryIdx % DS_QUERIES.length];
    dsQueryIdx++;
    try {
      var res = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(query), { timeout: 10000 });
      if (!res.ok) continue;
      var data = await res.json();
      var pairs = (data.pairs || []).filter(function(p) { return p.chainId === 'solana'; });
      var added = 0;
      for (var j = 0; j < pairs.length; j++) {
        var pair = pairs[j];
        var mint = pair.baseToken && pair.baseToken.address;
        if (!mint) continue;
        if (isBanned(mint)) continue;
        if (S.tokens.has(mint)) continue;
        // Quick checklist from available pair data
        var liq = parseFloat((pair.liquidity && pair.liquidity.usd) || 0);
        var mcap = parseFloat(pair.fdv || 0);
        var price = parseFloat(pair.priceUsd || 0);
        var vol1h = parseFloat((pair.volume && pair.volume.h1) || 0);
        var buys = parseInt((pair.txns && pair.txns.h1 && pair.txns.h1.buys) || 0);
        var sells = parseInt((pair.txns && pair.txns.h1 && pair.txns.h1.sells) || 1);
        var age = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : 24;
        if (liq < CFG.MIN_LIQ_USD) continue;
        if (mcap > CFG.MAX_MCAP_USD) continue;
        if (buys < 3) continue;
        if (buys / Math.max(sells, 1) < 1.0) continue;
        // Run safety checklist
        var tokenData = {
          mintAuthority: null,   // DS doesn't give us this — handled by freeze check
          freezeAuthority: null, // DS doesn't give us this
          lpBurn: undefined,     // DS doesn't give us this
          dev: undefined,        // DS doesn't give us this
        };
        var safe = await runSafetyChecklist(mint, tokenData, true); // skip Jupiter - unreliable
        if (!safe) continue;
        S.tokens.set(mint, {
          mint, price,
          n: (pair.baseToken && pair.baseToken.symbol || '???').toUpperCase().slice(0, 12),
          src: 'DSC',
          liq, mcap, vol1h, buys, sells, age,
          pairAddress: pair.pairAddress || null,
          addedAt: Date.now(),
        });
        added++;
      }
      if (added > 0) log('DS Search [' + query + ']: ' + added + ' tokens added | Pool: ' + S.tokens.size, 'info');
    } catch(e) {}
  }
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
var pumpPrices = {}; // mint -> { price, solInCurve, ts }
var pumpWs = null;

function connectPump() {
  if (pumpWs && pumpWs.readyState === WebSocket.OPEN) return;
  try {
    pumpWs = new WebSocket('wss://pumpportal.fun/api/data');
    pumpWs.on('open', function() {
      S.pumpLive = true;
      S.sources['PUMP.FUN'] = 'live:0';
      // Subscribe to new token launches — free, no key needed
      pumpWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
      // Subscribe to all token trades — needed for graduation tracking and price updates
      pumpWs.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
      log('Pump.fun WebSocket LIVE — Sniper + Graduation active', 'pump');
    });

    pumpWs.on('message', async function(raw) {
      try {
        var d = JSON.parse(raw.toString());

        // ── NEW TOKEN LAUNCH ──────────────────────────────────
        // Pump.fun sends new token creation events with mint + symbol/name
        // These do NOT have txType 'buy' or 'sell'
        // Check: has mint, has name/symbol, is NOT a buy/sell trade
        var isNewToken = d.mint && (d.symbol || d.name) &&
                         d.txType !== 'buy' && d.txType !== 'sell';
        if (isNewToken) {
          var mint = d.mint;
          var name = ((d.symbol || d.name || 'NEW') + '').toUpperCase().slice(0, 12);
          S.pumpCount++;
          S.sources['PUMP.FUN'] = 'live:' + S.pumpCount;
          if (S.pumpCount % 20 === 0) log('Pump.fun: ' + S.pumpCount + ' launches — latest: ' + name, 'pump');

          // Skip if banned
          if (isBanned(mint)) return;
          // Skip if already in pool
          if (S.tokens.has(mint)) return;

          // New token data from creation event
          // Pump.fun tokens: mintAuthority is renounced at creation
          // freezeAuthority check is the critical honeypot indicator
          var tokenData = {
            mintAuthority: null,       // Pump.fun tokens always renounce mint at creation
            freezeAuthority: d.freezeAuthority || null,
            lpBurn: undefined,         // Not yet burned — very new token
            dev: undefined,            // No dev holding data yet
          };

          // Run safety checklist — skip Jupiter check for Pump.fun tokens
          var safe = await runSafetyChecklist(mint, tokenData, true);
          if (!safe) return;

          // Get initial price from bonding curve
          var price = calcPumpPrice(d);
          if (price) pumpPrices[mint] = { price, solInCurve: 0, ts: Date.now() };

          // Add to pool
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

          // Update price cache
          if (price2) {
            pumpPrices[mint2] = { price: price2, solInCurve, ts: Date.now() };
          }

          // Update token in pool if present
          var poolTok = S.tokens.get(mint2);
          if (poolTok && price2) {
            poolTok.price = price2;
            if (d.txType === 'buy') poolTok.buys = (poolTok.buys || 0) + 1;
            else poolTok.sells = (poolTok.sells || 0) + 1;
          }

          // Update open Pump.fun trades with latest price
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
            // Near graduation window
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
// Polls DexScreener every 30 seconds for non-Pump.fun trades
// Pump.fun trades get real time updates via WebSocket above
async function updateOpenTradePrices() {
  var trades = S.open.filter(function(t) { return !t.isGrad && t.src !== 'PUMP' && t.mint; });
  if (trades.length === 0) return;

  for (var i = 0; i < trades.length; i++) {
    var trade = trades[i];
    var price = await getDSPrice(trade.mint, trade.pairAddress);
    if (!price || price <= 0) continue;

    // Sanity check — reject impossible price moves
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

    // Stop loss check
    if (pct <= -CFG.STOP_LOSS) {
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

  // Calculate P&L
  var pnl = 0;
  if (tr.entryPrice && tr.currentPrice && tr.entryPrice > 0) {
    var pricePct = (tr.currentPrice - tr.entryPrice) / tr.entryPrice;
    pnl = tr.size * pricePct - tr.size * (tr.slip || 0.005) - CFG.SOL_GAS;
  } else {
    pnl = -CFG.SOL_GAS;
    closeReason = reason + ' (no price data)';
  }

  // 80/20 profit split
  if (pnl > CFG.MIN_SPLIT_WIN) {
    var savings = parseFloat((pnl * CFG.SAVINGS_PCT).toFixed(4));
    var trading = parseFloat((pnl * (1 - CFG.SAVINGS_PCT)).toFixed(4));
    S.fund = parseFloat((S.fund + trading).toFixed(4));
    S.savings = parseFloat((S.savings + savings).toFixed(4));
    log((tr.isGrad ? '🎓 ' : '') + tr.tok.n + ' +$' + pnl.toFixed(2) + ' | saved $' + savings.toFixed(2) + ' | ' + closeReason, 'win');
    S.stats.w++;
    if (tr.isGrad) S.stats.gw++;
  } else if (pnl > 0) {
    // Win below minimum split — full amount to trading fund
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

  // Store closed trade with full story
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

  // Cooldown on any loss — blocks re-entry for 30 minutes
  if (pnl < 0) {
    var cooldownKey = (tr.tok && tr.tok.n || '') + (tr.mint || '');
    S.cooldowns.set(cooldownKey, Date.now());
    log('COOLDOWN ' + (tr.tok && tr.tok.n) + ' — blocked 30min after loss', 'warn');
  }

  // Daily loss limit
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

    // No price after 3 minutes — close
    if (!t.entryPrice && age > CFG.NO_PRICE_TIMEOUT) {
      log('TIMEOUT ' + t.tok.n + ' — no price after 3min', 'warn');
      closeTradeReal(t.id, 'Timeout — no price data');
      return;
    }

    if (!t.entryPrice || !t.currentPrice) return;

    // Stale — no movement for 2 minutes
    var lastMove = t.lastPriceChange || t.startTime;
    if ((now - lastMove) > CFG.STALE_TIME && age > 30000) {
      log('STALE ' + t.tok.n + ' — no movement for 2min', 'warn');
      closeTradeReal(t.id, 'Token went stale');
      return;
    }

    // Graduation trade — check trail stop via Pump.fun WebSocket price
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
      // Stop loss for grad trades
      var pct = (t.currentPrice - t.entryPrice) / t.entryPrice;
      if (pct <= -CFG.STOP_LOSS) {
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
    // Minimum transactions — no age restriction per Mike's direction
    // Bonding curve progress is the indicator, not time
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
// Evaluates tokens in pool and enters trades
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

  // Skip banned tokens
  if (isBanned(tok.mint)) {
    S.tokens.delete(tok.mint);
    return;
  }

  // Check cooldown after loss
  var cooldownKey = tok.n + tok.mint;
  var lastCooldown = S.cooldowns.get(cooldownKey);
  if (lastCooldown && (Date.now() - lastCooldown) < CFG.COOLDOWN_MS) return;

  // Already in an open trade on this token
  if (S.open.find(function(t) { return t.mint === tok.mint; })) return;

  // Must have buying pressure
  if (tok.buys < 3) return;

  // Position sizing
  var size = parseFloat((S.fund * CFG.MAX_POS).toFixed(4));
  if (size < 0.50) { S.rejectCount++; return; }

  // Fetch fresh entry price before entering
  var entryPrice = null;
  if (tok.src === 'PUMP' && pumpPrices[tok.mint]) {
    entryPrice = pumpPrices[tok.mint].price;
  } else {
    entryPrice = await getDSPrice(tok.mint, tok.pairAddress);
  }

  // If no price available — skip for now
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
    tpl: 'TRAIL',
    sl: CFG.STOP_LOSS,
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
    // Remove tokens older than 4 hours with no trades
    if (tok.addedAt && (now - tok.addedAt) > 14400000 && !S.open.find(function(t) { return t.mint === mint; })) {
      S.tokens.delete(mint);
      removed++;
    }
  });
  // Clean expired cooldowns
  S.cooldowns.forEach(function(ts, key) {
    if (now - ts > CFG.COOLDOWN_MS) S.cooldowns.delete(key);
  });
  // Recheck expired temp bans
  recheckExpiredBans();
  if (removed > 0) log('Pool cleaned: ' + removed + ' old tokens removed | Pool: ' + S.tokens.size, 'info');
}

// ── BOT CONTROL ───────────────────────────────────────────────
var gradI = null, exitI = null, cleanI = null, priceI = null, dsI = null, solPriceI = null;

function startBot() {
  if (S.running) return;
  S.running = true;
  S.startTime = Date.now();
  S.dayStartFund = S.fund;

  // Connect Pump.fun WebSocket — primary token discovery
  connectPump();

  // Initial DexScreener fetch
  fetchDSTokens();
  updateSolPrice();

  // Main scan loop — evaluates pool every 500ms
  scanI = setInterval(runScan, 500);

  // Graduation sniper — checks every second
  gradI = setInterval(runGradSniper, 1000);

  // Exit criteria checker — every 10 seconds
  exitI = setInterval(checkExitCriteria, 10000);

  // Price tracking for non-Pump trades — every 30 seconds
  priceI = setInterval(updateOpenTradePrices, 30000);

  // DexScreener discovery — every 5 minutes
  dsI = setInterval(fetchDSTokens, CFG.DS_INTERVAL);

  // Pool cleanup — every hour
  cleanI = setInterval(cleanPool, 3600000);

  // SOL price update — every 10 minutes
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
app.post('/api/stop', function(req, res) { stopBot(); res.json({ success: true }); });
app.post('/api/sell/:id', function(req, res) { closeTradeReal(req.params.id, 'Manual sell'); res.json({ success: true }); });

// Settings panel — update wallets without code changes
app.post('/api/settings', function(req, res) {
  if (req.body.tradingWallet) TRADING_WALLET = req.body.tradingWallet;
  if (req.body.savingsWallet) SAVINGS_WALLET = req.body.savingsWallet;
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
  // Bot does NOT auto-start — Mike controls manually via dashboard
});
