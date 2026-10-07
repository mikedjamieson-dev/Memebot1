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

// -- API KEYS --------------------------------------------------
const ST_KEY = process.env.ST_KEY || '75035862-d3fe-40a5-9a47-7d6338685930';
const BITQUERY_TOKEN = process.env.BITQUERY_TOKEN || '';

// -- CONFIGURATION ---------------------------------------------
const CFG = {
  MAX_POS: 0.05,
  MAX_OPEN: 4,
  SOL_GAS: 0.001,
  TRAIL_ACT: 0.04,
  TRAIL_PB: 0.02,
  STOP_LOSS: 0.10,
  STALE_TIME: 60000,
  NO_PRICE_TIMEOUT: 180000,
  LOSS_LIM: 0.10,
  MIN_SPLIT_WIN: 0.05,
  SAVINGS_PCT: 0.20,
  MIN_LIQ_USD: 5000,
  MAX_MCAP_USD: 25000000,
  MIN_MCAP_USD: 2750,
  BQ_SUBSCRIBE_MIN_MCAP: 2750,
  MAX_POOL: 10000,
  POOL_AGE_MS: 14400000,
  COOLDOWN_MS: 1800000,
  BAN_TEMP_MS: 43200000,
  DS_INTERVAL: 300000,
  WIN_COOLDOWN_MS: 300000,
};

// -- PORTFOLIO DATA --------------------------------------------
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
      log('Portfolio loaded - ' + P.trades.length + ' trades in history', 'info');
    }
  } catch(e) {
    log('Portfolio file not found - starting fresh', 'info');
  }
}

function savePortfolio() {
  try {
    var dir = path.dirname(PORTFOLIO_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(P, null, 2));
  } catch(e) {}
}

// -- STATE -----------------------------------------------------
const S = {
  tokens: new Map(),
  open: [],
  closed: [],
  stats: { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0, mcapCeiling: 0 },
  fund: 100,
  savings: 0,
  running: false,
  pumpLive: false,
  pumpCount: 0,
  bonkCount: 0,
  scanCount: 0,
  rejectCount: 0,
  rejectReasons: {},
  logs: [],
  sources: {},
  startTime: null,
  dayStartFund: 100,
  permanentBans: new Map(),
  tempBans: new Map(),
  cooldowns: new Map(),
  dscPool: 0,
  solPool: 0,
  dscKey: 0,
  sessionFund: 100,
  takeProfitMode: 'TIERED',
  takeProfitPct: 5,
  stopLossPct: 10,
  totalFees: 0,
  maxOpen: 4,
  fundStopLossPct: 20,
  liveFund: 0,
  liveDayStartFund: 0,
  liveMaxOpen: 4,
  liveFundStopLossPct: 20,
  liveStopLossPct: 10,
  liveTakeProfitMode: 'TIERED',
  liveTakeProfitPct: 5,
  liveWindingDown: false,
  liveOpen: [],
  liveClosed: [],
  liveStats: { w: 0, l: 0, r: 0, t: 0 },
  liveAllTime: { t: 0, w: 0, l: 0, totalPnl: 0, totalFees: 0, bestPnl: 0, worstPnl: 0 },
  liveBestTrade: null,
  liveWorstTrade: null,
  liveSessions: [],
  liveSession: null,
  liveSavings: 0,
  livePendingSavings: 0,
  liveSavingsSent: 0,
  liveSavingsTransfers: [],
  liveSavingsInFlight: null,
  liveStartFund: 0,
  liveRealizedPnl: 0,
  liveSessionHighFund: 0,
  liveAutoLockEnabled: false,
  liveTipsPaidUsd: 0,
  liveNetworkFeesUsd: 0,
  liveLogs: [],
  liveTradingEnabled: false,
  windingDown: false,
  maxPool: 10000,
  autoLockEnabled: false,
  sessionHighFund: 0,
  bestTrade: null,
};

// -- LOGGING ---------------------------------------------------
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

// Separate from the paper log above -- real trading's own activity,
// its own array, never mixed with paper's.
function liveLog(msg, type) {
  type = type || 'info';
  var entry = {
    msg: msg,
    type: type,
    time: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
  };
  S.liveLogs.unshift(entry);
  if (S.liveLogs.length > 500) S.liveLogs.pop();
  console.log('[LIVE-' + type.toUpperCase() + '] ' + msg);
}

// -- LIVE WALLET -------------------------------------------------
// liveWalletState holds everything the dashboard's Settings panel
// needs to show, refreshed on its own schedule below. Every field
// here is either a public address or a plain number/error message --
// the private key itself is never stored in this object, logged, or
// exposed through any API response.
var liveWalletKeypair = null;   // kept in memory only to sign later; never logged
var liveWalletModule = null;
var liveWalletState = {
  address: null,
  configured: false,
  configError: null,
  balanceSol: null,
  balanceError: null,
  savingsAddress: null,
};

(function loadLiveWalletAtStartup() {
  try {
    liveWalletModule = require('./wallet');
    try {
      liveWalletKeypair = liveWalletModule.loadTradingWallet();
      liveWalletState.address = liveWalletKeypair.publicKey.toBase58();
      liveWalletState.configured = true;
      liveLog('LIVE WALLET loaded: ' + liveWalletState.address, 'info');
    } catch (e) {
      liveWalletState.configError = e.code === 'WALLET_NOT_CONFIGURED' ? 'Not configured yet' : e.message;
      if (e.code === 'WALLET_NOT_CONFIGURED') {
        liveLog('LIVE WALLET not configured yet (paper trading unaffected)', 'info');
      } else {
        liveLog('LIVE WALLET ERROR: ' + e.message + ' (paper trading unaffected)', 'warn');
      }
    }
    liveWalletState.savingsAddress = liveWalletModule.getSavingsAddress();
    liveLog(liveWalletState.savingsAddress
      ? 'LIVE SAVINGS WALLET address: ' + liveWalletState.savingsAddress
      : 'LIVE SAVINGS WALLET not configured yet (paper trading unaffected)', 'info');
  } catch (e) {
    liveWalletState.configError = 'Wallet module could not load: ' + e.message;
    liveLog('LIVE WALLET module could not load (' + e.message + ') -- paper trading unaffected', 'warn');
  }
})();

// Refreshes the real on-chain balance for the live trading wallet.
// On any failure, balanceError is set and balanceSol is left as null
// (or whatever it already was cleared to) -- the dashboard must show
// an honest "unable to read" state, never a stale or guessed number.
async function refreshLiveWalletBalance() {
  if (!liveWalletKeypair || !liveWalletModule) return;
  try {
    var sol = await liveWalletModule.getTradingWalletBalance(liveWalletKeypair.publicKey);
    liveWalletState.balanceSol = sol;
    liveWalletState.balanceError = null;
  } catch (e) {
    liveWalletState.balanceSol = null;
    liveWalletState.balanceError = e.code === 'RPC_NOT_CONFIGURED' ? 'Not configured yet' : e.message;
  }
}
refreshLiveWalletBalance();
var liveWalletI = setInterval(refreshLiveWalletBalance, 30000);

// -- SOL PRICE -------------------------------------------------
var SOL_PRICE_USD = 170;
var SOL_PRICE_LAST_UPDATED = null; // ms timestamp of the last GENUINE successful fetch, not just "a value exists"
var SOL_PRICE_FRESH_WINDOW_MS = 15 * 60 * 1000; // 15 min: covers the normal 10-min cycle plus one missed attempt

function isSolPriceFresh() {
  return SOL_PRICE_LAST_UPDATED !== null && (Date.now() - SOL_PRICE_LAST_UPDATED) < SOL_PRICE_FRESH_WINDOW_MS;
}

async function updateSolPrice(attempt) {
  attempt = attempt || 1;
  var MAX_ATTEMPTS = 3;
  try {
    var res = await fetch(
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
      { timeout: 5000 }
    );
    if (res.status === 429) {
      if (attempt < MAX_ATTEMPTS) {
        var waitMs = attempt * 1000;
        log('SOL PRICE: rate limited (429), retrying in ' + waitMs + 'ms (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')', 'warn');
        await new Promise(function(resolve) { setTimeout(resolve, waitMs); });
        return updateSolPrice(attempt + 1);
      }
      log('SOL PRICE: rate limited (429) on final attempt ' + attempt + '/' + MAX_ATTEMPTS + ' -- price may be stale', 'warn');
      return;
    }
    if (!res.ok) {
      log('SOL PRICE: fetch failed, HTTP ' + res.status + ' -- price may be stale', 'warn');
      return;
    }
    var data = await res.json();
    var pairs = data.pairs || [];
    if (pairs.length === 0) {
      log('SOL PRICE: fetch succeeded but returned no pairs -- price may be stale', 'warn');
      return;
    }
    var best = pairs[0];
    for (var i = 1; i < pairs.length; i++) {
      var liq = (pairs[i].liquidity && pairs[i].liquidity.usd) || 0;
      var bestLiq = (best.liquidity && best.liquidity.usd) || 0;
      if (liq > bestLiq) best = pairs[i];
    }
    if (!best.priceUsd) {
      log('SOL PRICE: best pair had no priceUsd field -- price may be stale', 'warn');
      return;
    }
    SOL_PRICE_USD = parseFloat(best.priceUsd);
    SOL_PRICE_LAST_UPDATED = Date.now();
  } catch(e) {
    log('SOL PRICE: fetch threw -- ' + e.message + ' -- price may be stale', 'warn');
  }
}

// Real, current price for any specific token mint -- same proven
// pattern as updateSolPrice (correct tokens endpoint, most liquid
// pair), generalized so a real held position's price can be tracked
// independent of whether it's still in the paper discovery pool.
// Returns null on any failure -- caller must treat that as "unable
// to check right now," never a guessed or stale price.
async function getRealTokenPriceUsd(mint) {
  try {
    var res = await fetch(
      'https://api.dexscreener.com/latest/dex/tokens/' + mint,
      { timeout: 5000 }
    );
    if (!res.ok) return null;
    var data = await res.json();
    var pairs = data.pairs || [];
    if (pairs.length === 0) return null;
    var best = pairs[0];
    for (var i = 1; i < pairs.length; i++) {
      var liq = (pairs[i].liquidity && pairs[i].liquidity.usd) || 0;
      var bestLiq = (best.liquidity && best.liquidity.usd) || 0;
      if (liq > bestLiq) best = pairs[i];
    }
    if (!best.priceUsd) return null;
    return parseFloat(best.priceUsd);
  } catch (e) {
    return null;
  }
}

// -- BAN SYSTEM ------------------------------------------------
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
      log('RECHECK ' + mint.slice(0, 8) + '... - 12hr ban expired', 'info');
    }
  });
}

// -- WALLET CONCENTRATION CHECK --------------------------------
// One-off HTTP query (not the WebSocket stream) - only called on tokens that
// already passed every other filter, right before entry, to avoid spending
// extra calls on candidates we'd reject anyway.
// SOLANA_INCINERATOR is a known burn address: tokens sent here are permanently
// destroyed and can never be sold, but still count as a "holder" balance-wise ?
// must be excluded or we'd wrongly reject tokens that burned supply this way.
var SOLANA_INCINERATOR = '1nc1nerator11111111111111111111111111111111';
var pendingConcentrationChecks = new Set();

async function checkWalletConcentration(mint) {
  if (!BITQUERY_TOKEN) return { safe: true, reason: 'no token' };
  try {
    var query = 'query { Solana { BalanceUpdates(limit: {count: 5} orderBy: {descendingByField: "BalanceUpdate_Holding_maximum"} where: {BalanceUpdate: {Currency: {MintAddress: {is: "' + mint + '"}}}, Transaction: {Result: {Success: true}}}) { BalanceUpdate { Account { Address } Holding: PostBalance(maximum: Block_Slot) } } } }';
    var res = await fetch('https://streaming.bitquery.io/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + BITQUERY_TOKEN },
      body: JSON.stringify({ query: query }),
    });
    if (!res.ok) return { safe: true, reason: 'query failed, allowing through' };
    var data = await res.json();
    var updates = data && data.data && data.data.Solana && data.data.Solana.BalanceUpdates;
    if (!updates || !updates.length) return { safe: true, reason: 'no holder data' };

    var totalHeld = 0;
    var holders = [];
    updates.forEach(function(u) {
      var addr = u.BalanceUpdate.Account.Address;
      var bal = parseFloat(u.BalanceUpdate.Holding || 0);
      if (addr === SOLANA_INCINERATOR) return; // burned supply, not a real holder risk
      totalHeld += bal;
      holders.push({ addr: addr, bal: bal });
    });
    if (!holders.length || totalHeld <= 0) return { safe: true, reason: 'no non-burn holders found' };

    holders.sort(function(a, b) { return b.bal - a.bal; });
    var topPct = holders[0].bal / totalHeld;
    if (topPct >= 0.50) {
      return { safe: false, reason: 'top wallet holds ' + (topPct * 100).toFixed(0) + '% of supply' };
    }
    return { safe: true, reason: 'concentration OK (' + (topPct * 100).toFixed(0) + '% top holder)' };
  } catch (e) {
    return { safe: true, reason: 'check errored, allowing through' };
  }
}

// -- SAFETY CHECKLIST ------------------------------------------
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
    permanentBan(mint, 'Freeze authority retained - honeypot');
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
      permanentBan(mint, 'Honeypot confirmed - sell simulation failed');
      return false;
    }
  }
  return true;
}

// -- SOLANA HONEYPOT CHECK -------------------------------------
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

// -- DEXSCREENER PRICE -----------------------------------------
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

// Real reported liquidity-in-USD for a mint, from the same DexScreener
// pair data used for price above. IMPORTANT DIFFERENCE from the earlier,
// reverted attempt: this is ONLY ever called in the background at
// discovery time (fire-and-forget, never awaited by anything else), never
// in the entry path. It cannot block, delay, or fail an entry - it just
// populates a value on the pool token whenever it happens to come back,
// for data collection only. No filter behavior anywhere depends on this.
async function fetchLiquidityInBackground(mint, chain) {
  try {
    var chainId = chain || 'solana';
    var url = 'https://api.dexscreener.com/tokens/v1/' + chainId + '/' + mint;
    var res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return;
    var data = await res.json();
    var pairs = data.pairs || (Array.isArray(data) ? data : []);
    if (pairs.length > 0 && pairs[0].liquidity && pairs[0].liquidity.usd !== undefined) {
      var tok = S.tokens.get(mint);
      if (tok) tok.liquidityUsd = parseFloat(pairs[0].liquidity.usd);
    }
  } catch(e) {
    // Silent failure by design - this is background data collection, not
    // a gate. A token simply keeps its liquidityUsd as null/unknown.
  }
}

// -- DEXSCREENER TOKEN DISCOVERY -------------------------------
var SOL_QUERIES = [
  'solana meme', 'pump fun sol', 'pepe sol', 'dog sol',
  'cat sol', 'moon sol', 'ai sol', 'degen sol'
];
var solQueryIdx = 0;

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

      var tokenData = { mintAuthority: null, freezeAuthority: null, lpBurn: undefined, dev: undefined };
      var safe = await runSafetyChecklist(mint, tokenData, true);
      if (!safe) continue;

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
  var solQuery = SOL_QUERIES[solQueryIdx % SOL_QUERIES.length];
  solQueryIdx++;
  var solAdded = await fetchDSChain(solQuery, 'solana');
  if (solAdded > 0) log('DS SOL [' + solQuery + ']: ' + solAdded + ' added | Pool: ' + S.tokens.size, 'info');
  S.dscPool = Array.from(S.tokens.values()).filter(function(t) { return t.src === 'DSC'; }).length;
  S.solPool = Array.from(S.tokens.values()).filter(function(t) { return t.chain === 'solana'; }).length;
  S.sources['DSC'] = 'live:' + S.tokens.size;
}

// -- BITQUERY - REAL TIME DATA ---------------------------------
var pumpPrices = {};
var pumpWs = null;
var bqSubId = 1;
var bqPairSubActive = false;
var bqTradeSubActive = false;
var bqReconnectDelay = 3000;
var bqDeliberateStop = false;
var bqPingI = null;
var bqTradeLogCount = 0;

var BQ_SOURCES = [
  {
    src: 'PUMP', chain: 'solana', protocolFamily: 'Pumpfun', protocol: 'pump',
    programAddress: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    createMethods: ['create', 'create_v2'],
    queryShape: 'tokenSupplyUpdate',
  },
  {
    src: 'BONK', chain: 'solana', protocolFamily: 'raydium_launchpad', protocol: 'raydium_launchpad',
    programAddress: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
    platformConfigAddress: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1',
    createMethods: ['initialize_v2'],
    queryShape: 'instructions',
  },
];

function connectBQ() {
  if (pumpWs && (pumpWs.readyState === WebSocket.OPEN || pumpWs.readyState === WebSocket.CONNECTING)) return;
  if (!BITQUERY_TOKEN) {
    log('BITQUERY_TOKEN missing - add it in Render Environment tab', 'rug');
    return;
  }
  try {
    var wsUrl = 'wss://streaming.bitquery.io/graphql?token=' + encodeURIComponent(BITQUERY_TOKEN);
    pumpWs = new WebSocket(wsUrl, 'graphql-ws');

    pumpWs.on('open', function() {
      S.pumpLive = true;
      bqPairSubActive = false;
      bqTradeSubActive = false;
      bqReconnectDelay = 3000;
      S.sources['BITQUERY'] = 'live:0';
      log('Bitquery LIVE - real time data connected', 'pump');
      if (S.liveTradingEnabled || S.liveOpen.length > 0) liveLog('LIVE FEED: price feed connected -- real positions are being watched', 'info');
      sendBQConnectionInit();
      setTimeout(function() {
        if (!bqPairSubActive && pumpWs && pumpWs.readyState === WebSocket.OPEN) {
          log('BQ WARNING: no connection_ack received after 10s - subscriptions may not have started', 'warn');
        }
      }, 10000);
      if (bqPingI) clearInterval(bqPingI);
      bqPingI = setInterval(function() {
        try { if (pumpWs && pumpWs.readyState === WebSocket.OPEN) pumpWs.ping(); } catch(e) {}
      }, 30000);
    });

    pumpWs.on('message', function(raw) {
      try {
        var msg = JSON.parse(raw.toString());
        handleBQMessage(msg);
      } catch(e) {
        log('BQ MSG HANDLER ERROR: ' + (e && e.message ? e.message : 'unknown').slice(0, 150), 'warn');
      }
    });

    pumpWs.on('error', function() { S.pumpLive = false; S.sources['BITQUERY'] = 'dead'; });
    pumpWs.on('close', function() {
      S.pumpLive = false;
      S.sources['BITQUERY'] = 'dead';
      if (bqPingI) clearInterval(bqPingI);
      if (bqDeliberateStop) { bqDeliberateStop = false; return; }
      var delay = bqReconnectDelay;
      if (S.liveTradingEnabled || S.liveOpen.length > 0) liveLog('LIVE FEED: price feed DISCONNECTED -- reconnecting in ' + (delay / 1000) + 's. Exits on real positions cannot trigger from live prices until it is back (the 60-second stale exit still runs)', 'warn');
      bqReconnectDelay = Math.min(bqReconnectDelay * 2, 30000);
      setTimeout(connectBQ, delay);
    });
  } catch(e) { setTimeout(connectBQ, 5000); }
}

function sendBQConnectionInit() {
  pumpWs.send(JSON.stringify({ type: 'connection_init' }));
}

var bqMsgLogCount = 0;

function handleBQMessage(msg) {
  bqMsgLogCount++;
  if (bqMsgLogCount <= 5) log('BQ MSG #' + bqMsgLogCount + ' type=' + msg.type, 'info');

  if (msg.type === 'connection_ack') {
    sendBQSubscriptions();
    return;
  }
  if (msg.type === 'ka') return;
  if (msg.type === 'error') {
    log('BQ ERROR: ' + JSON.stringify(msg.payload || msg).slice(0, 200), 'warn');
    return;
  }
  if (msg.type === 'complete') return;
  if (msg.type === 'next' || msg.type === 'data') {
    var payload = msg.payload || msg;
    var data = payload.data;
    if (!data) return;
    if (data.Solana && data.Solana.TokenSupplyUpdates) {
      data.Solana.TokenSupplyUpdates.forEach(function(u) { handleNewPair(u); });
    }
    if (data.Solana && data.Solana.Instructions) {
      data.Solana.Instructions.forEach(function(i) { handleNewPairFromInstruction(i); });
    }
    if (data.Trading && data.Trading.Trades) {
      data.Trading.Trades.forEach(function(t) { handleSwap(t); });
    }
  }
}

function buildCombinedPairQuery() {
  var conditions = BQ_SOURCES.map(function(source) {
    var methods = source.createMethods.map(function(m) { return '"' + m + '"'; }).join(', ');
    return '{ Instruction: { Program: { Address: { is: "' + source.programAddress + '" }, Method: { in: [' + methods + '] } } } }';
  }).join(' ');

  return 'subscription { Solana { Instructions(where: { Transaction: { Result: { Success: true } }, any: [' + conditions + '] }) { Instruction { Accounts { Address Token { Mint Owner } } Program { Address Method Arguments { Name Type Value { ... on Solana_ABI_String_Value_Arg { string } ... on Solana_ABI_Address_Value_Arg { address } ... on Solana_ABI_Integer_Value_Arg { integer } ... on Solana_ABI_BigInt_Value_Arg { bigInteger } ... on Solana_ABI_Json_Value_Arg { json } } } } } } } }';
}

function sendBQSubscriptions() {
  pumpWs.send(JSON.stringify({
    id: 'pairs_all',
    type: 'start',
    payload: { query: buildCombinedPairQuery() }
  }));
  bqPairSubActive = true;
  log('New pair stream active (' + BQ_SOURCES.map(function(s){return s.src;}).join(', ') + ')', 'pump');

  // Fix confirmed directly with Bitquery: "raydium_launchpad" is a
  // Market.Protocol value, not a Market.ProtocolFamily value - its real
  // ProtocolFamily is "Raydium". The old filter matched nothing for BONK
  // (silently, since these are free-text strings that don't error on a
  // wrong value) and only appeared to work for Pump.fun because "Pumpfun"
  // happens to be a genuine ProtocolFamily value too. Filtering on
  // Protocol with the correct values ("pump", "raydium_launchpad") was
  // verified live by Bitquery against real trade counts before this fix.
  // Market cap floor (CFG.BQ_SUBSCRIBE_MIN_MCAP) is deliberately left
  // unchanged - not touching trade quality just to see more volume.
  var protocols = BQ_SOURCES.map(function(s) { return '"' + s.protocol + '"'; }).join(', ');
  pumpWs.send(JSON.stringify({
    id: 'trades_all',
    type: 'start',
    payload: {
      query: 'subscription { Trading { Trades(where: {Pair: {Market: {Protocol: {in: [' + protocols + ']}}}, Supply: {MarketCap: {gt: ' + CFG.BQ_SUBSCRIBE_MIN_MCAP + '}}}) { Side Trader { Address } AmountsInUsd { Base Quote } Supply { MarketCap TotalSupply } Pair { Token { Address } Market { ProtocolFamily } } PriceInUsd } } }'
    }
  }));
  bqTradeSubActive = true;
  log('Swap stream active - all sources', 'pump');
}

function findArgValue(args, candidateNames) {
  if (!args) return null;
  for (var i = 0; i < args.length; i++) {
    var argName = (args[i].Name || '').toLowerCase();
    for (var j = 0; j < candidateNames.length; j++) {
      if (argName === candidateNames[j] || argName.indexOf(candidateNames[j]) !== -1) {
        var v = args[i].Value || {};
        return v.string || v.address || null;
      }
    }
  }
  return null;
}

function findStructNameSymbol(args, structArgNames) {
  if (!args) return { name: null, symbol: null };
  for (var i = 0; i < args.length; i++) {
    var argName = (args[i].Name || '').toLowerCase();
    for (var j = 0; j < structArgNames.length; j++) {
      if (argName === structArgNames[j]) {
        var v = args[i].Value || {};
        if (v.json) {
          try {
            var parsed = typeof v.json === 'string' ? JSON.parse(v.json) : v.json;
            return {
              name: parsed.name || parsed.Name || null,
              symbol: parsed.symbol || parsed.Symbol || parsed.ticker || null,
            };
          } catch (e) {
            return { name: null, symbol: null };
          }
        }
      }
    }
  }
  return { name: null, symbol: null };
}

var bqInstrLogCounts = { PUMP: 0, BONK: 0, unknown: 0 };

async function handleNewPairFromInstruction(i) {
  var instr = (i.Instruction || {});
  var accounts = instr.Accounts || [];
  var program = instr.Program || {};
  var programArgs = program.Arguments || [];
  var programAddress = program.Address || '';

  var matchedSource = BQ_SOURCES.filter(function(s) { return s.programAddress === programAddress; })[0];
  var srcKey = matchedSource ? matchedSource.src : 'unknown';
  bqInstrLogCounts[srcKey] = (bqInstrLogCounts[srcKey] || 0) + 1;

  if (bqInstrLogCounts[srcKey] <= 5) {
    log('BQ INSTR [' + srcKey + '] #' + bqInstrLogCounts[srcKey] + ' addr=' + programAddress.slice(0,8) + ' Arguments: ' + JSON.stringify(programArgs).slice(0, 400), 'warn');
  }

  if (!matchedSource) return;
  var src = matchedSource.src;

  var mint = null;
  for (var k = 0; k < accounts.length; k++) {
    if (accounts[k].Token && accounts[k].Token.Mint) { mint = accounts[k].Token.Mint; break; }
  }
  if (!mint) return;

  var symbol = findArgValue(programArgs, ['symbol', 'ticker']);
  var tokenName = findArgValue(programArgs, ['name']);
  if (!symbol && !tokenName) {
    var structResult = findStructNameSymbol(programArgs, ['base_mint_param']);
    symbol = structResult.symbol;
    tokenName = structResult.name;
  }
  var name = ((symbol || tokenName || 'NEW') + '').toUpperCase().slice(0, 12);
  // New investigation: the dev/creator wallet, pulled from the same raw
  // creation data already used above - confirmed present for Pump.fun,
  // not yet verified for LetsBonk. Stored so real-time trade activity can
  // be checked against it (does the dev buy more or sell), a genuinely
  // different, behavioral signal from the static dev-holding-% already
  // tested and found non-predictive.
  var devWallet = findArgValue(programArgs, ['creator']);

  S.pumpCount++;
  if (src === 'BONK') S.bonkCount++;
  S.sources['BITQUERY'] = 'live:' + S.pumpCount;
  if (S.pumpCount % 20 === 0) log(src + ': ' + S.pumpCount + ' launches - latest: ' + name, 'pump');

  if (isBanned(mint)) return;
  if (S.tokens.has(mint)) return;

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

  var tokenData = {
    mintAuthority: null,
    freezeAuthority: null,
    lpBurn: undefined,
    dev: undefined,
  };
  var safe = await runSafetyChecklist(mint, tokenData, true);
  if (!safe) return;

  S.tokens.set(mint, {
    mint: mint,
    price: null,
    n: name,
    src: src,
    chain: 'solana',
    liq: 0,
    mcap: 0,
    vol1h: 0,
    buys: 1,
    sells: 0,
    age: 0,
    pairAddress: null,
    addedAt: Date.now(),
    isNew: true,
    devWallet: devWallet || null,
  });

  log('NEW TOKEN ' + name + ' | ' + src + ' | ' + mint + ' | Added to pool', 'info');

  // Fire-and-forget - no await here. Whatever comes back (or doesn't)
  // just populates tok.liquidityUsd whenever it happens to arrive, with
  // zero effect on discovery, scanning, or entry timing.
  fetchLiquidityInBackground(mint, 'solana');
}

async function handleNewPair(u) {
  var update = u.TokenSupplyUpdate || {};
  var currency = update.Currency || {};
  var mint = currency.MintAddress;
  if (!mint) return;

  var name = ((currency.Symbol || currency.Name || 'NEW') + '').toUpperCase().slice(0, 12);

  S.pumpCount++;
  S.sources['BITQUERY'] = 'live:' + S.pumpCount;
  if (S.pumpCount % 20 === 0) log('Pump.fun: ' + S.pumpCount + ' launches - latest: ' + name, 'pump');

  if (isBanned(mint)) return;
  if (S.tokens.has(mint)) return;

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

  var tokenData = {
    mintAuthority: null,
    freezeAuthority: null,
    lpBurn: undefined,
    dev: undefined,
  };
  var safe = await runSafetyChecklist(mint, tokenData, true);
  if (!safe) return;

  S.tokens.set(mint, {
    mint: mint,
    price: null,
    n: name,
    src: 'PUMP',
    chain: 'solana',
    liq: 0,
    mcap: 0,
    vol1h: 0,
    buys: 1,
    sells: 0,
    age: 0,
    pairAddress: null,
    addedAt: Date.now(),
    isNew: true,
  });

  log('NEW TOKEN ' + name + ' | ' + mint + ' | Added to pool', 'info');
}

function handleSwap(t) {
  var pair = t.Pair || {};
  var token = pair.Token || {};
  var mint = token.Address;
  if (!mint) return;

  var traderAddress = (t.Trader || {}).Address || null;
  var swapUsd = 0;
  if (t.AmountsInUsd) {
    var baseUsd = parseFloat(t.AmountsInUsd.Base || 0);
    var quoteUsd = parseFloat(t.AmountsInUsd.Quote || 0);
    swapUsd = Math.max(baseUsd, quoteUsd) || 0;
  }

  bqTradeLogCount++;
  if (bqTradeLogCount <= 3) log('BQ SWAP #' + bqTradeLogCount + ' | ' + (t.Side || '?') + ' | ' + mint.slice(0, 8) + '...', 'info');

  var priceUsd = null;
  if (t.PriceInUsd) {
    var p = parseFloat(t.PriceInUsd);
    if (!isNaN(p) && p > 0) priceUsd = p;
  }

  var protocolFamily = (pair.Market || {}).ProtocolFamily || '';

  var mcap = 0;
  if (t.Supply && t.Supply.MarketCap) {
    var mc = parseFloat(t.Supply.MarketCap);
    if (!isNaN(mc) && mc > 0) mcap = mc;
  } else if (t.Supply && t.Supply.TotalSupply && priceUsd) {
    var ts = parseFloat(t.Supply.TotalSupply);
    if (!isNaN(ts) && ts > 0) mcap = priceUsd * ts;
  } else if (protocolFamily === 'Pumpfun' && priceUsd) {
    mcap = priceUsd * 1000000000;
  }

  var poolTok = S.tokens.get(mint);
  if (poolTok) {
    if (t.Side === 'Buy') poolTok.buys = (poolTok.buys || 0) + 1;
    else if (t.Side === 'Sell') poolTok.sells = (poolTok.sells || 0) + 1;
    if (poolTok.src === 'BONK') {
      log('BONK BUYS ' + poolTok.n + ' | buys=' + poolTok.buys + ' sells=' + (poolTok.sells||0) + ' (need buys>=3)', 'info');
    }
    if (priceUsd) {
      poolTok.price = priceUsd;
      poolTok.mcap = mcap;
    }

    // Data collection only - not used as a filter yet. Every current
    // entry-time metric (buy/sell counts, BSR, mcap, pool size) was
    // checked against real stop-loss vs. trail-exit outcomes and showed
    // no consistent predictive pattern across two full sessions. These
    // two are genuinely different dimensions never tested before:
    // unique wallet count (raw tx counts can't tell a token with 15 real
    // buyers apart from one with 300 buys from a handful of wallets
    // trading back and forth) and transaction size (a $2 dust swap counts
    // the same as a $500 real one in every existing count).
    if (traderAddress) {
      if (t.Side === 'Buy') {
        poolTok.uniqueBuyers = poolTok.uniqueBuyers || new Set();
        poolTok.uniqueBuyers.add(traderAddress);
      } else if (t.Side === 'Sell') {
        poolTok.uniqueSellers = poolTok.uniqueSellers || new Set();
        poolTok.uniqueSellers.add(traderAddress);
      }
      if (poolTok.devWallet && traderAddress === poolTok.devWallet) {
        if (t.Side === 'Buy') poolTok.devBought = true;
        else if (t.Side === 'Sell') poolTok.devSold = true;
      }
    }
    if (swapUsd > 0) {
      if (swapUsd < 5) {
        poolTok.dustSwaps = (poolTok.dustSwaps || 0) + 1;
      } else {
        poolTok.realSwaps = (poolTok.realSwaps || 0) + 1;
      }
    }

    // New investigation: everything tracked so far measures activity
    // COUNTS at entry (buys, sells, wallets) - none of it measures how
    // fast price was already moving right before entry. A token that's
    // calm at entry could behave very differently from one already
    // whipping around violently, even with identical buy/wallet counts.
    // Keep a short rolling window of recent prices per pool token so we
    // can measure pre-entry volatility directly, distinct from anything
    // checked before.
    if (priceUsd) {
      poolTok.recentPrices = poolTok.recentPrices || [];
      poolTok.recentPrices.push(priceUsd);
      if (poolTok.recentPrices.length > 10) poolTok.recentPrices.shift();
    }
  }

  if (priceUsd) {
    pumpPrices[mint] = { price: priceUsd, solInCurve: 0, ts: Date.now() };

    // Event-driven entry - the actual fix for the round-robin scanning
    // bottleneck. Previously a token could only get checked for entry
    // whenever the fixed 500ms scanner happened to land on it, which at a
    // large pool could be 30+ minutes between checks - nearly guaranteeing
    // its price was no longer fresh enough by the time its turn came up.
    // Now the check happens the instant real trading activity happens on
    // it, exactly when the price genuinely IS fresh. Fire-and-forget: not
    // awaited, so this never delays processing of the next incoming swap.
    // tryEnterToken's own internal guard prevents this from double-firing
    // against the same mint the 500ms backup scanner might also be
    // checking at nearly the same moment.
    if (poolTok) {
      tryEnterToken(poolTok, priceUsd, 'event');
    }

    S.open.forEach(function(trade) {
      if (trade.mint !== mint || trade.src !== 'PUMP') return;

      if (trade.currentPrice && trade.currentPrice > 0) {
        // Directional fix: only reject a downward crash - a genuine large
        // GAIN is never rejected anymore. We've proven extensively that
        // huge single-tick upward moves (100%, 300%, 500%+) are real,
        // common market behavior on these coins, not bad data - the old
        // symmetric check was silently discarding real winning trades
        // (confirmed: SEND closed with TickCount 0, price never once
        // updated, small stale loss, while likely mooning in reality).
        // A sudden near-total price collapse is still the one thing worth
        // guarding against, since that's the scenario a real feed glitch
        // could falsely trigger a stop-loss on a trade that's actually fine.
        var drop = (trade.currentPrice - priceUsd) / trade.currentPrice;
        if (drop > 0.90) {
          log('PRICE SANITY REJECT ' + trade.tok.n + ' | ' + (drop * 100).toFixed(0) + '% single-tick crash', 'warn');
          return;
        }
      }

      // Change: capture the price immediately before this tick is applied,
      // so we can measure exactly how big the single tick that triggers a
      // stop loss actually was - distinct from the trade's overall PnL%,
      // which mixes this together with every prior tick. This is what lets
      // us tell "one violent trade" apart from "a series of smaller ticks
      // adding up" for well-covered trades that still overshoot badly.
      var priceBeforeThisTick = trade.currentPrice || trade.entryPrice;

      trade.currentPrice = priceUsd;
      trade.currentMcap = mcap;
      trade.priceUpdates = (trade.priceUpdates || 0) + 1;
      if (t.Side === 'Sell' && swapUsd > 0) {
        if (swapUsd > (trade.largestSellUsd || 0)) trade.largestSellUsd = swapUsd;
        if (traderAddress) {
          trade.sellerWallets = trade.sellerWallets || {};
          trade.sellerWallets[traderAddress] = (trade.sellerWallets[traderAddress] || 0) + 1;
        }
      }
      if (!trade.firstUpdateAt) trade.firstUpdateAt = Date.now();
      if (priceUsd > (trade.peakPrice || 0)) trade.peakPrice = priceUsd;
      // Tracks the worst drawdown a trade experienced at any point while
      // open, separate from the final exit result - answers whether
      // eventual big winners first dipped hard before recovering, which
      // is needed before considering tightening the stop loss.
      if (!trade.troughPrice || priceUsd < trade.troughPrice) trade.troughPrice = priceUsd;
      if (trade.entryPrice > 0 && trade.priceHistory && trade.priceHistory.length < 300) {
        var secSinceEntry = parseFloat(((Date.now() - trade.startTime) / 1000).toFixed(1));
        var gainPctNow = parseFloat((((priceUsd - trade.entryPrice) / trade.entryPrice) * 100).toFixed(2));
        trade.priceHistory.push({ t: secSinceEntry, pct: gainPctNow });
      }
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

        if (trade.tpl === 'TIERED' && !trade.tieredSold && pct >= 1.0) {
          performTierOneSale(trade, priceUsd);
          // Do not return - the trade stays open, remaining half continues
          // to be checked against the trail/SL logic below on this same tick.
        }

        if (trade.tpl === 'TIERED' && trade.tieredSold && !trade.tieredSold2 && pct >= 5.0) {
          performTierTwoSale(trade, priceUsd);
        }

        if ((trade.tpl === 'TRAIL' || trade.tpl === 'TIERED') && trade.peakPrice) {
          var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
          if (peakGain >= CFG.TRAIL_ACT) {
            var pullback = (trade.peakPrice - priceUsd) / trade.peakPrice;
            if (pullback >= CFG.TRAIL_PB) {
              if (priceBeforeThisTick && priceBeforeThisTick > 0) {
                trade.trailTriggerTickJumpPct = parseFloat((((priceUsd - priceBeforeThisTick) / priceBeforeThisTick) * 100).toFixed(2));
              }
              log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain * 100).toFixed(1) + '% | Pullback -' + (pullback * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'win');
              closeTradeReal(trade.id, 'Trail exit');
              return;
            }
          }
        }

        if (pct <= -(trade.sl || 0.10)) {
          if (priceBeforeThisTick && priceBeforeThisTick > 0) {
            trade.triggerTickJumpPct = parseFloat((((priceUsd - priceBeforeThisTick) / priceBeforeThisTick) * 100).toFixed(2));
          }
          log('SL HIT ' + trade.tok.n + ' | ' + (pct * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0) + ' | trigger tick: ' + (trade.triggerTickJumpPct !== undefined ? trade.triggerTickJumpPct.toFixed(1)+'%' : 'n/a'), 'loss');
          closeTradeReal(trade.id, 'Stop loss hit');
          return;
        }
      }
    });

    // Live positions are checked on this same tick, same moment as paper.
    handleLiveTick(mint, priceUsd);
  }
}

// -- OPEN TRADE PRICE TRACKING ---------------------------------
async function updateOpenTradePrices() {
  var trades = S.open.filter(function(t) { return !t.isGrad && t.src !== 'PUMP' && t.mint; });
  if (trades.length === 0) return;

  for (var i = 0; i < trades.length; i++) {
    var trade = trades[i];
    var price = await getDSPrice(trade.mint, trade.pairAddress, trade.chain);
    if (!price || price <= 0) continue;

    if (trade.currentPrice && trade.currentPrice > 0) {
      var drop = (trade.currentPrice - price) / trade.currentPrice;
      if (drop > 0.90) {
        log('PRICE SANITY REJECT ' + trade.tok.n + ' | ' + (drop * 100).toFixed(0) + '% single-tick crash', 'warn');
        continue;
      }
    }

    var priceBeforeThisTick = trade.currentPrice || trade.entryPrice;

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
    if (!trade.troughPrice || price < trade.troughPrice) trade.troughPrice = price;
    if (trade.entryPrice > 0 && trade.priceHistory && trade.priceHistory.length < 300) {
      var secSinceEntry2 = parseFloat(((Date.now() - trade.startTime) / 1000).toFixed(1));
      var gainPctNow2 = parseFloat((((price - trade.entryPrice) / trade.entryPrice) * 100).toFixed(2));
      trade.priceHistory.push({ t: secSinceEntry2, pct: gainPctNow2 });
    }

    if (trade.tpl === 'FIXED' && pct >= (trade.tpPct / 100)) {
      log('TP HIT ' + trade.tok.n + ' | +' + (pct * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'win');
      closeTradeReal(trade.id, 'Take profit hit');
      continue;
    }

    if (trade.tpl === 'TIERED' && !trade.tieredSold && pct >= 1.0) {
      performTierOneSale(trade, price);
    }

    if (trade.tpl === 'TIERED' && trade.tieredSold && !trade.tieredSold2 && pct >= 5.0) {
      performTierTwoSale(trade, price);
    }

    if ((trade.tpl === 'TRAIL' || trade.tpl === 'TIERED') && trade.peakPrice && trade.entryPrice) {
      var peakGain = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
      if (peakGain >= CFG.TRAIL_ACT) {
        var pullback = (trade.peakPrice - price) / trade.peakPrice;
        if (pullback >= CFG.TRAIL_PB) {
          if (priceBeforeThisTick && priceBeforeThisTick > 0) {
            trade.trailTriggerTickJumpPct = parseFloat((((price - priceBeforeThisTick) / priceBeforeThisTick) * 100).toFixed(2));
          }
          log('TRAIL EXIT ' + trade.tok.n + ' | Peak +' + (peakGain * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'win');
          closeTradeReal(trade.id, 'Trail exit');
          continue;
        }
      }
    }

    if (pct <= -(trade.sl || 0.10)) {
      if (priceBeforeThisTick && priceBeforeThisTick > 0) {
        trade.triggerTickJumpPct = parseFloat((((price - priceBeforeThisTick) / priceBeforeThisTick) * 100).toFixed(2));
      }
      log('SL HIT ' + trade.tok.n + ' | ' + (pct * 100).toFixed(1) + '% | ticks:' + (trade.priceUpdates||0), 'loss');
      closeTradeReal(trade.id, 'Stop loss hit');
    }
  }
}

// -- CLOSE TRADE -----------------------------------------------
// -- TIERED PROFIT-TAKING - partial close ------------------------
// New capability, not previously possible: closes HALF of a trade's
// position immediately when it reaches +100% gain, banking that profit
// right away - slippage, fees, and the fund/savings split all applied
// at that exact moment, not deferred. The other half keeps running under
// the same trail-stop logic as every other trade. Built from a retroactive
// simulation against 553 real trades showing this specific rule (single
// tier at +100%, sell 50%) gives real protection against a winner fully
// reversing into a loss, while costing much less of the upside on clean
// winners than a two-tier version would.
function performTierOneSale(trade, currentPriceUsd) {
  if (trade.tieredSold) return;
  var sellSize = parseFloat((trade.originalSize * 0.5).toFixed(4));
  var pricePct = (currentPriceUsd - trade.entryPrice) / trade.entryPrice;
  var slip = trade.slip || 0.005;
  var pnl = parseFloat((sellSize * pricePct - sellSize * slip - CFG.SOL_GAS).toFixed(4));
  var feePaid = parseFloat((sellSize * slip + CFG.SOL_GAS).toFixed(4));
  S.totalFees = parseFloat((S.totalFees + feePaid).toFixed(4));

  var fundAmount = 0;
  var savingsAmount = 0;
  if (pnl > CFG.MIN_SPLIT_WIN) {
    savingsAmount = parseFloat((pnl * CFG.SAVINGS_PCT).toFixed(4));
    fundAmount = parseFloat((pnl * (1 - CFG.SAVINGS_PCT)).toFixed(4));
  } else {
    fundAmount = pnl;
  }
  S.fund = parseFloat((S.fund + fundAmount).toFixed(4));
  S.savings = parseFloat((S.savings + savingsAmount).toFixed(4));

  // Reduce the trade's remaining live size - everything downstream (the
  // eventual trail/SL close of the other half) now naturally operates on
  // just the remaining half, since it reads trade.size directly.
  trade.size = parseFloat((trade.size - sellSize).toFixed(4));

  trade.tieredSold = true;
  trade.tier1Size = sellSize;
  trade.tier1ExitPrice = currentPriceUsd;
  trade.tier1RealizedPnl = pnl;
  trade.tier1RealizedPct = parseFloat((pricePct * 100).toFixed(2));
  trade.tier1ClosedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  trade.tier1SlipCost = feePaid;
  trade.tier1FundAmount = fundAmount;
  trade.tier1SavingsAmount = savingsAmount;

  log('TIER SALE ' + trade.tok.n + ' | sold 50% at +' + (pricePct * 100).toFixed(1) + '% | realized $' + pnl.toFixed(2) + ' | remaining 50% still running', 'win');

  // Auto-lock ratchet - same logic as in closeTradeReal. This is a real,
  // immediately realized profit event and can create a genuine new fund
  // high the instant it happens, per explicit instruction: protect
  // profits as soon as they exist, don't wait for the whole trade to close.
  if (S.autoLockEnabled && S.fund > S.sessionHighFund) {
    S.sessionHighFund = S.fund;
    var oldBase = S.dayStartFund;
    S.dayStartFund = S.fund;
    S.windingDown = false;
    var newTrigger = S.fund * (1 - S.fundStopLossPct / 100);
    log('AUTO-LOCK: new high $' + S.fund.toFixed(2) + ' - stop loss raised (was $' + oldBase.toFixed(2) + ') | triggers below $' + newTrigger.toFixed(2), 'info');
  }
}

// Rare second tier, confirmed against real data: only 2 of 112 tiered
// trades ever have reached +500% gain (SEED, BGOON), but both showed
// substantial improvement with zero downside - unlike the +200% level,
// which was tested and rejected because it cut off a trade (SEED) that
// still had real further upside ahead of it. At +500%, a coin has
// already captured nearly all its realistic upside, so there's very
// little left to sacrifice by locking in more profit here. Sells 50% of
// whatever remains (25% of the original position), leaving the final 25%
// to keep riding the same trail-stop logic.
function performTierTwoSale(trade, currentPriceUsd) {
  if (!trade.tieredSold || trade.tieredSold2) return;
  var sellSize = parseFloat((trade.size * 0.5).toFixed(4));
  var pricePct = (currentPriceUsd - trade.entryPrice) / trade.entryPrice;
  var slip = trade.slip || 0.005;
  var pnl = parseFloat((sellSize * pricePct - sellSize * slip - CFG.SOL_GAS).toFixed(4));
  var feePaid = parseFloat((sellSize * slip + CFG.SOL_GAS).toFixed(4));
  S.totalFees = parseFloat((S.totalFees + feePaid).toFixed(4));

  var fundAmount = 0;
  var savingsAmount = 0;
  if (pnl > CFG.MIN_SPLIT_WIN) {
    savingsAmount = parseFloat((pnl * CFG.SAVINGS_PCT).toFixed(4));
    fundAmount = parseFloat((pnl * (1 - CFG.SAVINGS_PCT)).toFixed(4));
  } else {
    fundAmount = pnl;
  }
  S.fund = parseFloat((S.fund + fundAmount).toFixed(4));
  S.savings = parseFloat((S.savings + savingsAmount).toFixed(4));

  trade.size = parseFloat((trade.size - sellSize).toFixed(4));

  trade.tieredSold2 = true;
  trade.tier2Size = sellSize;
  trade.tier2ExitPrice = currentPriceUsd;
  trade.tier2RealizedPnl = pnl;
  trade.tier2RealizedPct = parseFloat((pricePct * 100).toFixed(2));
  trade.tier2ClosedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  trade.tier2SlipCost = feePaid;
  trade.tier2FundAmount = fundAmount;
  trade.tier2SavingsAmount = savingsAmount;

  log('TIER 2 SALE ' + trade.tok.n + ' | sold half of remaining at +' + (pricePct * 100).toFixed(1) + '% | realized $' + pnl.toFixed(2) + ' | final 25% still running', 'win');

  if (S.autoLockEnabled && S.fund > S.sessionHighFund) {
    S.sessionHighFund = S.fund;
    var oldBase2 = S.dayStartFund;
    S.dayStartFund = S.fund;
    S.windingDown = false;
    var newTrigger2 = S.fund * (1 - S.fundStopLossPct / 100);
    log('AUTO-LOCK: new high $' + S.fund.toFixed(2) + ' - stop loss raised (was $' + oldBase2.toFixed(2) + ') | triggers below $' + newTrigger2.toFixed(2), 'info');
  }
}

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

  // For a TIERED trade, tier 1's profit was already realized and banked
  // the instant it happened - this "pnl" here is only the REMAINING
  // half's own result. Win/loss classification and logging need to
  // reflect the TRUE overall outcome of the whole original trade, so a
  // trade that banked real profit on tier 1 and then gives back a little
  // on the remaining half is correctly counted as a win, not a loss.
  var tier1Pnl = tr.tieredSold ? tr.tier1RealizedPnl : 0;
  var tier2Pnl = tr.tieredSold2 ? tr.tier2RealizedPnl : 0;
  var blendedPnl = parseFloat((tier1Pnl + tier2Pnl + pnl).toFixed(4));

  // Tracks exactly how this trade's PnL was actually split between the
  // trading fund and savings (80/20 on qualifying wins), so the CSV can
  // show the real fund-vs-savings breakdown per trade instead of only the
  // combined PnL - this was the exact confusion that caused the $12.32
  // (combined) vs $1.53 (fund-only) mismatch to require manual investigation.
  var fundAmount = 0;
  var savingsAmount = 0;

  if (pnl > CFG.MIN_SPLIT_WIN) {
    var savings = parseFloat((pnl * CFG.SAVINGS_PCT).toFixed(4));
    var trading = parseFloat((pnl * (1 - CFG.SAVINGS_PCT)).toFixed(4));
    fundAmount = trading;
    savingsAmount = savings;
  } else {
    fundAmount = pnl;
  }
  S.fund = parseFloat((S.fund + fundAmount).toFixed(4));
  S.savings = parseFloat((S.savings + savingsAmount).toFixed(4));

  // Win/loss classification and the log message use blendedPnl - the
  // TRUE overall result of the original trade - not just this leg's own
  // number, since a tiered trade's tier-1 profit is real money already
  // banked, regardless of what the remaining half does afterward.
  if (blendedPnl > 0) {
    var tierNote = tr.tieredSold ? ' | tier1 +$' + tier1Pnl.toFixed(2) + ' already banked' + (tr.tieredSold2 ? ' + tier2 +$' + tier2Pnl.toFixed(2) : '') : '';
    log((tr.isGrad ? 'GRAD ' : '') + tr.tok.n + ' +$' + blendedPnl.toFixed(2) + tierNote + ' | ' + closeReason, 'win');
    S.stats.w++;
    if (tr.isGrad) S.stats.gw++;
  } else {
    var tierNoteLoss = tr.tieredSold ? ' | tier1 +$' + tier1Pnl.toFixed(2) + ' already banked' + (tr.tieredSold2 ? ' + tier2 +$' + tier2Pnl.toFixed(2) : '') : '';
    log((tr.isGrad ? 'GRAD ' : '') + tr.tok.n + ' -$' + Math.abs(blendedPnl).toFixed(2) + tierNoteLoss + ' | ' + closeReason, 'loss');
    S.stats.l++;
    if (tr.isGrad) S.stats.gl++;
  }

  S.stats.t++;
  // A rug: the trade closed with the price at half its entry or worse.
  if (tr.entryPrice > 0 && tr.currentPrice > 0 && tr.currentPrice / tr.entryPrice <= 0.5) S.stats.r++;

  if (S.autoLockEnabled && S.fund > S.sessionHighFund) {
    S.sessionHighFund = S.fund;
    var oldBase = S.dayStartFund;
    S.dayStartFund = S.fund;
    S.windingDown = false;
    var newTrigger = S.fund * (1 - S.fundStopLossPct / 100);
    log('AUTO-LOCK: new high $' + S.fund.toFixed(2) + ' - stop loss raised (was $' + oldBase.toFixed(2) + ') | triggers below $' + newTrigger.toFixed(2), 'info');
  }

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
    entryMcap: (tr.src === 'PUMP') ? (tr.entryMcap || 0) : 0,
    exitMcap: tr.currentMcap || 0,
    entryBuys: tr.entryBuys || 0,
    entrySells: tr.entrySells || 0,
    openedAt: tr.openedAt,
    closedAt: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    src: tr.src || (tr.tok && tr.tok.src) || 'unknown',
    chain: tr.chain || 'solana',
    isGrad: tr.isGrad || false,
  });
  if (S.closed.length > 200) S.closed.pop();
  S.open.splice(i, 1);

  var finalLegPct = (tr.entryPrice && tr.currentPrice)
    ? ((tr.currentPrice - tr.entryPrice) / tr.entryPrice * 100) : 0;
  var blendedPnlPct;
  if (tr.tieredSold2) {
    blendedPnlPct = parseFloat((0.5 * tr.tier1RealizedPct + 0.25 * tr.tier2RealizedPct + 0.25 * finalLegPct).toFixed(2));
  } else if (tr.tieredSold) {
    blendedPnlPct = parseFloat((0.5 * tr.tier1RealizedPct + 0.5 * finalLegPct).toFixed(2));
  } else {
    blendedPnlPct = parseFloat(finalLegPct.toFixed(2));
  }

  var portfolioTrade = {
    id: tr.id,
    name: tr.tok && tr.tok.n ? tr.tok.n : '?',
    mint: tr.mint || '',
    chain: tr.chain || 'solana',
    src: tr.src || 'unknown',
    entryPrice: tr.entryPrice || 0,
    exitPrice: tr.currentPrice || 0,
    size: tr.originalSize || tr.size || 0,
    pnl: blendedPnl,
    pnlPct: blendedPnlPct,
    closeReason: closeReason,
    isGrad: tr.isGrad || false,
    openedAt: tr.openedAt || '',
    closedAt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    closedDate: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
    closedTime: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    sessionStartedAt: '',
    sessionEndedAt: '',
    slip: tr.slip || 0,
    fees: parseFloat((feePaid + (tr.tieredSold ? tr.tier1SlipCost : 0) + (tr.tieredSold2 ? tr.tier2SlipCost : 0)).toFixed(4)),
    priceUpdates: tr.priceUpdates || 0,
    entryMcap: (tr.src === 'PUMP') ? (tr.entryMcap || 0) : 0,
    exitMcap: tr.currentMcap || 0,
    entryBuys: tr.entryBuys || 0,
    entrySells: tr.entrySells || 0,
    peakGainPct: (tr.peakPrice && tr.entryPrice)
      ? parseFloat(((tr.peakPrice - tr.entryPrice) / tr.entryPrice * 100).toFixed(2)) : 0,
    secToFirstUpdate: (tr.firstUpdateAt && tr.startTime)
      ? parseFloat(((tr.firstUpdateAt - tr.startTime) / 1000).toFixed(1)) : null,
    largestSellUsd: parseFloat((tr.largestSellUsd || 0).toFixed(2)),
    maxRepeatSellerCount: tr.sellerWallets
      ? Math.max.apply(null, Object.values(tr.sellerWallets).concat([0]))
      : 0,
    // Change 1: entry-side slippage/gas - previously charged to the fund
    // but never exported anywhere, so PnL summed across trades never
    // matched the actual fund change (that gap caused a real, confusing
    // reconciliation problem - see session review 8/26).
    entrySlipCost: parseFloat((tr.entrySlipCost || 0).toFixed(4)),
    // Change 2: Net Fund Impact - the trade's true effect on the trading
    // fund specifically (fundAmount, i.e. PnL after the fund/savings split)
    // minus the entry-side cost that was never in PnL to begin with. This
    // is the number that should always sum to match the fund's real
    // all-time change - this exact check is what would have caught the
    // $12.32-vs-$1.53 confusion immediately instead of requiring a
    // manual investigation.
    netFundImpact: parseFloat(((fundAmount + (tr.tieredSold ? tr.tier1FundAmount : 0) + (tr.tieredSold2 ? tr.tier2FundAmount : 0)) - (tr.entrySlipCost || 0)).toFixed(4)),
    // Change 3: explicit fund vs savings split, per trade - not just the
    // combined PnL. Zero savingsAmount on losses/small wins is correct,
    // not a display bug.
    fundAmount: parseFloat((fundAmount + (tr.tieredSold ? tr.tier1FundAmount : 0) + (tr.tieredSold2 ? tr.tier2FundAmount : 0)).toFixed(4)),
    savingsAmount: parseFloat((savingsAmount + (tr.tieredSold ? tr.tier1SavingsAmount : 0) + (tr.tieredSold2 ? tr.tier2SavingsAmount : 0)).toFixed(4)),
    // Change 4: total time the trade was open, in seconds - distinct from
    // secToFirstUpdate (time to first price tick). Lets fast-crash losses
    // be separated from slow-bleed losses, which are likely different
    // failure modes needing different fixes.
    holdTimeSec: tr.startTime ? parseFloat(((Date.now() - tr.startTime) / 1000).toFixed(1)) : null,
    // Change 5: pool size and scan count at the moment this trade entered
    // - lets performance be checked against how congested the pool was.
    poolSizeAtEntry: tr.poolSizeAtEntry || 0,
    scanCountAtEntry: tr.scanCountAtEntry || 0,
    // Change (overshoot investigation): the % price move on the single
    // tick that actually crossed the stop-loss threshold, distinct from
    // the trade's overall PnL%. Only set on stop-loss exits - blank for
    // trail/stale/TP exits, since this investigation is specifically
    // about whether SL overshoots are one violent single trade vs. a
    // series of smaller ticks adding up.
    triggerTickJumpPct: tr.triggerTickJumpPct !== undefined ? tr.triggerTickJumpPct : null,
    // New investigation: same concept as triggerTickJumpPct above, but for
    // trail exits - the % move on the single tick that crossed the 2%
    // pullback line, distinct from the trade's overall giveback (peak
    // minus final exit %). Testing whether trail-exit giveback is mostly
    // one violent tick (matching the stop-loss pattern, nothing to fix)
    // or gradual multi-tick decline (real room to tighten the pullback).
    trailTriggerTickJumpPct: tr.trailTriggerTickJumpPct !== undefined ? tr.trailTriggerTickJumpPct : null,
    // New investigation: the worst drawdown this trade experienced at any
    // point while open, distinct from the final exit %. Answers whether
    // eventual big winners typically dipped hard before recovering - the
    // real data needed before considering tightening the stop loss from
    // -10% toward -5%, since that would only be safe if big winners
    // rarely pass through a deep dip first.
    lowestPricePct: (tr.troughPrice && tr.entryPrice)
      ? parseFloat((((tr.troughPrice - tr.entryPrice) / tr.entryPrice) * 100).toFixed(2)) : null,
    // Full tick-by-tick price path for this trade, serialized as
    // "secondsSinceEntry:pctGain" pairs separated by "|" - e.g.
    // "0:0|1.2:3.4|2.8:9.1|5.0:-2.1". Lets the actual growth SHAPE of a
    // coin be studied directly (continuous surge vs. stair-steps vs.
    // sudden spike) rather than only summary numbers like peak/trough.
    // Temporary, focused data-gathering field - not a permanent column.
    priceHistory: tr.priceHistory
      ? tr.priceHistory.map(function(p) { return p.t + ':' + p.pct; }).join('|')
      : '',
    // New data-collection fields (not yet used as a filter) - testing
    // whether unique wallet count or transaction-size distribution at
    // entry predicts stop-loss vs. trail-exit outcomes, since every
    // metric checked so far (mcap, buy/sell counts, BSR, pool size) showed
    // no consistent pattern across two full sessions.
    entryUniqueBuyers: tr.entryUniqueBuyers || 0,
    entryUniqueSellers: tr.entryUniqueSellers || 0,
    entryDustSwaps: tr.entryDustSwaps || 0,
    entryRealSwaps: tr.entryRealSwaps || 0,
    // New investigation: how much price was already swinging tick-to-tick
    // right before entry, distinct from every activity-count metric
    // checked so far (all of which showed no consistent pattern across
    // multiple sessions). entryPreVolTickCount tells you how solid the
    // reading is - a low count means the volatility number is based on
    // very little data.
    entryPreVolatilityPct: tr.entryPreVolatilityPct !== undefined && tr.entryPreVolatilityPct !== null ? tr.entryPreVolatilityPct : null,
    entryPreVolTickCount: tr.entryPreVolTickCount || 0,
    // Real DexScreener liquidity at the moment of entry - fetched in the
    // BACKGROUND at discovery time, never blocking anything. Null means
    // the background fetch simply hadn't returned yet when this trade
    // opened, not that liquidity was zero. Pure data collection: testing
    // whether thin liquidity correlates with blow-through severity before
    // building anything that acts on it (e.g. scaling position size).
    entryLiquidityUsd: tr.entryLiquidityUsd !== undefined ? tr.entryLiquidityUsd : null,
    // New investigation: how long a token had been sitting in the pool
    // before we actually entered it. The event-driven entry fix means a
    // token can now be traded the instant it first qualifies, with zero
    // time to prove it isn't already dying - testing whether very
    // freshly-discovered entries perform worse, independent of anything
    // else already tested (which found no predictive signal).
    secondsSinceDiscovery: tr.secondsSinceDiscovery !== undefined ? tr.secondsSinceDiscovery : null,
    // New investigation: real-time dev wallet activity (buying more vs
    // selling) rather than the static dev-holding-% already tested and
    // found non-predictive. HasDevWalletData lets us confirm whether the
    // creator address is actually being captured (confirmed present for
    // Pump.fun; not yet verified for LetsBonk) before trusting the other
    // two columns as meaningful.
    entryDevBought: tr.entryDevBought || 'No',
    entryDevSold: tr.entryDevSold || 'No',
    hasDevWalletData: tr.hasDevWalletData || 'No',
    // New - Tiered Profits mode: whether this trade's first half was sold
    // at +100% gain, and the details of that partial sale if so. Lets
    // tiered trades be reviewed with the same rigor as everything else ?
    // did this actually rescue reversals the way the retroactive
    // simulation predicted, without meaningfully costing clean winners.
    tieredSold: tr.tieredSold ? 'Yes' : 'No',
    tier1ExitPrice: tr.tieredSold ? tr.tier1ExitPrice : null,
    tier1RealizedPct: tr.tieredSold ? tr.tier1RealizedPct : null,
    tier1RealizedPnl: tr.tieredSold ? tr.tier1RealizedPnl : null,
    tier1ClosedAt: tr.tieredSold ? tr.tier1ClosedAt : '',
    tieredSold2: tr.tieredSold2 ? 'Yes' : 'No',
    tier2ExitPrice: tr.tieredSold2 ? tr.tier2ExitPrice : null,
    tier2RealizedPct: tr.tieredSold2 ? tr.tier2RealizedPct : null,
    tier2RealizedPnl: tr.tieredSold2 ? tr.tier2RealizedPnl : null,
    tier2ClosedAt: tr.tieredSold2 ? tr.tier2ClosedAt : '',
    // Lets any session be reviewed after the fact to see the real split
    // between event-driven and backup-scanner entries, instead of only
    // being checkable live via /api/state while the bot is running.
    entryTrigger: tr.entryTrigger || 'scanner',
    // Captures whether the bot was in wind-down mode at the exact moment
    // this trade closed - lets the auto-resume behavior be verified
    // directly from the data instead of just trusting the activity log.
    windingDownAtClose: S.windingDown ? 'Yes' : 'No',
    // Diagnostic tracking for the autolock investigation - snapshotted
    // from real server-side state at the exact moment THIS trade closes,
    // not something read from the UI. If autolock is genuinely working,
    // FundSLTriggerAt should climb in step with FundAfterTrade as new
    // highs are made. If FundAfterTrade ever drops below FundSLTriggerAt
    // without the bot stopping, or AutoLockStatus ever reads OFF when it
    // should be ON, that pinpoints exactly which trade it happened on ?
    // no need to catch it live in the activity log.
    fundAfterTrade: parseFloat(S.fund.toFixed(4)),
    fundSLTriggerAt: parseFloat((S.dayStartFund * (1 - S.fundStopLossPct / 100)).toFixed(4)),
    autoLockStatus: S.autoLockEnabled ? 'ON' : 'OFF',
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
    log('COOLDOWN ' + (tr.tok && tr.tok.n) + ' - blocked 30min after loss', 'warn');
  }
  if (pnl > 0) {
    S.cooldowns.set(cooldownKey, Date.now() - (CFG.COOLDOWN_MS - CFG.WIN_COOLDOWN_MS));
    log('COOLDOWN ' + (tr.tok && tr.tok.n) + ' - blocked 5min after win', 'info');
  }

  var lossLimit = S.fundStopLossPct / 100;
  var currentLoss = (S.dayStartFund - S.fund) / S.dayStartFund;
  if (currentLoss >= lossLimit && !S.windingDown) {
    S.windingDown = true;
    log('FUND LOSS LIMIT HIT - ' + S.fundStopLossPct + '% reached - no new entries', 'rug');
    S.windDownCheckInterval = setInterval(function() {
      if (S.open.length === 0) {
        clearInterval(S.windDownCheckInterval);
        S.windDownCheckInterval = null;
        log('All trades closed - bot fully stopped', 'info');
        stopBot();
      }
    }, 2000);
  } else if (S.windingDown && currentLoss < lossLimit) {
    // Auto-resume: the fund recovered back above the loss line while
    // still-open trades were finishing out naturally (exactly the
    // scenario that used to force a full stop even after the fund had
    // already recovered). Uses the exact same comparison the trigger
    // itself uses - if that math says we're no longer past the limit,
    // cancel the wind-down and resume taking new entries.
    S.windingDown = false;
    if (S.windDownCheckInterval) {
      clearInterval(S.windDownCheckInterval);
      S.windDownCheckInterval = null;
    }
    log('FUND RECOVERED - back above ' + S.fundStopLossPct + '% loss limit, resuming entries', 'win');
  }
}

// -- EXIT CRITERIA ---------------------------------------------
function checkExitCriteria() {
  var now = Date.now();
  S.open.slice().forEach(function(t) {
    var age = now - t.startTime;

    if (!t.entryPrice && age > CFG.NO_PRICE_TIMEOUT) {
      log('TIMEOUT ' + t.tok.n + ' - no price after 3min', 'warn');
      closeTradeReal(t.id, 'Timeout - no price data');
      return;
    }

    if (!t.entryPrice || !t.currentPrice) return;

    var lastMove = t.lastPriceChange || t.startTime;
    if ((now - lastMove) > CFG.STALE_TIME && age > 30000) {
      log('STALE ' + t.tok.n + ' - no movement for 2min', 'warn');
      closeTradeReal(t.id, 'Token went stale');
      return;
    }
  });
}

// -- MAIN SCANNER ----------------------------------------------
// Change 6: reject/skip reason tracking at the session level - the raw
// "SKIPPED" count on the dashboard never said WHY tokens were being
// skipped, which made it impossible to tell filters working as intended
// apart from filters silently blocking almost everything (exactly what
// happened with the Jupiter honeypot deprecation in a parallel build).
// Biggest single tick-to-tick % swing across a token's recent price
// window, used to measure how volatile a token already was right before
// entry - distinct from every activity-count metric checked so far.
function computeMaxTickSwing(prices) {
  if (!prices || prices.length < 2) return null;
  var maxSwing = 0;
  for (var i = 1; i < prices.length; i++) {
    var prev = prices[i - 1];
    if (!prev || prev <= 0) continue;
    var swing = Math.abs((prices[i] - prev) / prev) * 100;
    if (swing > maxSwing) maxSwing = swing;
  }
  return parseFloat(maxSwing.toFixed(2));
}

function trackSkip(reason) {
  S.rejectReasons[reason] = (S.rejectReasons[reason] || 0) + 1;
}

var scanI = null;
var scanIdx = 0;

// -- ENTRY LOGIC (shared - event-driven AND scanner both call this) -----
// Extracted from the old inline runScan() body. Every filter and
// threshold below is UNCHANGED from before - this is purely a structural
// change in WHEN a token gets checked, not what it's checked against.
// freshPrice is passed by the event-driven caller (handleSwap) with a
// price that just arrived, bypassing the "is the cache <=1000ms old"
// check entirely since we already know it's fresh - it's the exact price
// that just came in. The backup scanner (runScan) calls this with no
// freshPrice, falling back to the original cache-freshness check.
var pendingEntryChecks = new Set();

// Live entries are decided separately from paper. These are live's own
// bookkeeping: mints with a real buy in flight (so the same token can't be
// bought twice, and in-flight buys count against Max Open), and live's own
// cooldowns (paper's cooldowns never block live, and the reverse).
var livePendingBuys = new Set();
var liveCooldowns = new Map();

function paperSlotFree() {
  return S.running && !S.windingDown && S.open.length < S.maxOpen;
}

function liveSlotFree() {
  return S.liveTradingEnabled && !S.liveWindingDown && (S.liveOpen.length + livePendingBuys.size) < S.liveMaxOpen;
}

function liveWantsEntry(tok) {
  if (!tok || !tok.mint) return false;
  if (tok.src !== 'PUMP' && tok.src !== 'BONK') return false;
  if (!liveSlotFree()) return false;
  if (livePendingBuys.has(tok.mint)) return false;
  if (S.liveOpen.find(function(p) { return p.mint === tok.mint; })) return false;
  var lastLive = liveCooldowns.get(tok.mint);
  if (lastLive && (Date.now() - lastLive) < CFG.COOLDOWN_MS) return false;
  return true;
}

function startLiveEntry(tok) {
  var platformName = tok.src === 'PUMP' ? 'pump.fun' : 'LetsBonk';
  var platformKey = tok.src === 'PUMP' ? 'pumpfun' : 'letsbonk';
  var buildBuyFn = tok.src === 'PUMP' ? require('./pumpfun').buildBuyInstructions : require('./letsbonk').buildBuyInstructions;
  livePendingBuys.add(tok.mint);
  performRealBuy(tok.mint, platformName, platformKey, buildBuyFn, 'LIVE AUTO ENTRY').then(function(r) {
    // A token skipped for thin liquidity is left alone for the same cooldown
    // as any other live exit, instead of being re-checked on every tick.
    if (r && r.skipped) liveCooldowns.set(tok.mint, Date.now());
  }).catch(function(e) {
    liveLog('LIVE AUTO ENTRY (' + platformName + ') unexpected error: ' + e.message, 'warn');
  }).then(function() {
    livePendingBuys.delete(tok.mint);
  });
}

async function tryEnterToken(tok, freshPrice, triggerSource) {
  if (!tok || !tok.mint) return;
  if (pendingEntryChecks.has(tok.mint)) return;
  if (S.open.find(function(t) { return t.mint === tok.mint; }) && !liveWantsEntry(tok)) return;
  pendingEntryChecks.add(tok.mint);
  try {
    await tryEnterTokenInner(tok, freshPrice, triggerSource);
  } finally {
    pendingEntryChecks.delete(tok.mint);
  }
}

async function tryEnterTokenInner(tok, freshPrice, triggerSource) {
  if (S.tokens.size === 0) return;
  if (S.running && !S.windingDown && S.fund < 1) stopBot();
  if (!tok || !tok.mint) return;

  // Paper and live each decide for themselves whether they want this token.
  // The filters below are shared and unchanged; each side only acts if it
  // wanted the token to begin with and still does after the last async check.
  var paperOk = paperSlotFree() && !S.open.find(function(t) { return t.mint === tok.mint; });
  var liveOk = liveWantsEntry(tok);
  if (!paperOk && !liveOk) return;

  var diag = (S.scanCount % 200 === 0);

  if (isBanned(tok.mint)) { S.tokens.delete(tok.mint); return; }

  var bsr = tok.buys / Math.max(tok.sells || 1, 1);
  if (bsr < 0.8) { S.rejectCount++; trackSkip('bsr_too_low'); if(diag) log('DIAG '+tok.n+' | SKIP: BSR '+bsr.toFixed(2)+' buys='+tok.buys+' sells='+tok.sells, 'info'); return; }

  // Confirmed with real data: 386 trades across 8 sessions showed a
  // consistent, stable ~17-point win-rate gap (24% vs 41%) between tokens
  // where the dev wallet had already sold before entry vs. hadn't. Only
  // real sell-side swaps trigger devSold - a burn (dev sends tokens to a
  // dead wallet, no swap involved) is invisible to this check and
  // correctly still passes, since that's not something to filter out.
  if (tok.devSold) {
    S.rejectCount++;
    trackSkip('dev_wallet_sold');
    if(diag) log('DIAG '+tok.n+' | SKIP: dev wallet already sold', 'info');
    return;
  }

  // Confirmed with real data, measured specifically within the group that
  // already passed the dev-sold filter above (not confounded with it):
  // entries under 5 seconds since discovery showed a 53.1% win rate and
  // +$0.55 avg profit/trade; 5s+ dropped to 36.3% win rate and roughly
  // breakeven. Held consistently across 12 of 13 sessions checked.
  if (tok.addedAt && (Date.now() - tok.addedAt) >= 5000) {
    S.rejectCount++;
    trackSkip('too_stale_at_entry');
    if(diag) log('DIAG '+tok.n+' | SKIP: '+((Date.now()-tok.addedAt)/1000).toFixed(1)+'s since discovery (>=5s)', 'info');
    return;
  }

  if ((tok.src === 'PUMP' || tok.src === 'BONK') && tok.mcap > 0 && tok.mcap < CFG.MIN_MCAP_USD) {
    trackSkip('mcap_below_floor');
    if(diag) log('DIAG '+tok.n+' | SKIP: mcap $'+tok.mcap.toFixed(0)+' below floor $'+CFG.MIN_MCAP_USD, 'info');
    return;
  }

  var cooldownKey = tok.n + tok.mint;
  var lastCooldown = S.cooldowns.get(cooldownKey);
  if (lastCooldown && (Date.now() - lastCooldown) < CFG.COOLDOWN_MS) paperOk = false;
  if (!paperOk && !liveOk) { trackSkip('cooldown_active'); if(diag) log('DIAG '+tok.n+' | SKIP: cooldown active', 'info'); return; }

  if (tok.buys < 3) { trackSkip('buys_below_3'); if(diag) log('DIAG '+tok.n+' | SKIP: buys='+tok.buys+' (need 3)', 'info'); return; }

  // Paper's size check applies to paper only; live sizes its own buy.
  var size = parseFloat((S.fund * CFG.MAX_POS).toFixed(4));
  if (paperOk && size < 0.50) paperOk = false;
  if (!paperOk && !liveOk) { S.rejectCount++; trackSkip('position_too_small'); if(diag) log('DIAG '+tok.n+' | SKIP: size $'+size+' too small', 'info'); return; }

  if (tok.src === 'DSC') { trackSkip('dsc_disabled'); if(diag) log('DIAG '+tok.n+' | SKIP: DSC entries disabled - discovery only', 'info'); return; }

  var entryPrice = null;
  if (freshPrice && freshPrice > 0) {
    entryPrice = freshPrice;
  } else if (tok.src === 'PUMP' || tok.src === 'BONK') {
    var cached = pumpPrices[tok.mint];
    if (cached && (Date.now() - cached.ts) <= 1000) {
      entryPrice = cached.price;
    } else {
      trackSkip('price_stale');
      if(diag) log('DIAG '+tok.n+' | SKIP: price stale ('+(cached ? ((Date.now()-cached.ts)/1000).toFixed(1)+'s old' : 'no cache')+')', 'info');
      S.rejectCount++;
      return;
    }
  } else {
    entryPrice = await getDSPrice(tok.mint, tok.pairAddress, tok.chain);
  }

  if (!entryPrice || entryPrice <= 0) { S.rejectCount++; trackSkip('no_price'); if(diag) log('DIAG '+tok.n+' | SKIP: no price | src='+tok.src+' pumpCache='+(pumpPrices[tok.mint]?'YES':'NO'), 'info'); return; }

  if (tok.src === 'PUMP' || tok.src === 'BONK') {
    if (pendingConcentrationChecks.has(tok.mint)) return;
    pendingConcentrationChecks.add(tok.mint);
    var concCheck = await checkWalletConcentration(tok.mint);
    pendingConcentrationChecks.delete(tok.mint);
    if (!concCheck.safe) {
      S.rejectCount++;
      trackSkip('wallet_concentration');
      if(diag) log('DIAG '+tok.n+' | SKIP: '+concCheck.reason, 'info');
      return;
    }
  }

  // Final re-check, right before anything commits - closes the race
  // window the event-driven entry fix opened. Multiple different tokens
  // can now have entry checks in flight at once (each passing the
  // original check at the top of this function before any of them
  // actually finishes), so the count needs to be verified again one more
  // time here, with nothing async between this check and the trade
  // actually being created, so nothing else can slip in between.
  if (paperOk && (!paperSlotFree() || S.open.find(function(t) { return t.mint === tok.mint; }))) {
    paperOk = false;
    trackSkip('max_open_reached_race');
  }
  if (liveOk && !liveWantsEntry(tok)) {
    liveOk = false;
    trackSkip('live_max_open_reached_race');
  }
  if (!paperOk && !liveOk) return;

  // Same idea for the dev-sold filter: the early check at the top of this
  // function can pass, and then the dev's sell lands while the wallet
  // concentration call above is waiting on the network (measured at about
  // 2.5-3.6% of all trades, winning only ~22% of the time). The flag is
  // read again here, synchronously, with no await before the trade is
  // created, so what was checked is exactly what gets recorded.
  if (tok.devSold) {
    S.rejectCount++;
    trackSkip('dev_wallet_sold_race');
    return;
  }

  // Live buys first, the instant every check has passed, so real money is
  // never waiting on paper's bookkeeping below. It runs in the background.
  if (liveOk) startLiveEntry(tok);
  if (!paperOk) return;

  var slip =parseFloat(
    Math.min(0.004 + (size / Math.max(tok.liq || 1000, 100)) * 2.5, 0.15).toFixed(4)
  );
  var entrySlipCost = parseFloat((size * slip).toFixed(4));
  S.fund = parseFloat((S.fund - entrySlipCost).toFixed(4));

  var trade = {
    id: Math.random().toString(36).substr(2, 9),
    tok: Object.assign({}, tok),
    sc: 85,
    size: parseFloat(size.toFixed(4)),
    originalSize: parseFloat(size.toFixed(4)),
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
    entryMcap: tok.mcap || 0,
    entryBuys: tok.buys || 0,
    entrySells: tok.sells || 0,
    currentPrice: entryPrice,
    peakPrice: entryPrice,
    troughPrice: entryPrice,
    // Full tick-by-tick history for this investigation - recorded as
    // (seconds since entry, % gain at that moment) pairs, so the actual
    // SHAPE of a coin's growth is visible, not just entry/peak/trough/exit
    // summary numbers. Capped at 300 ticks per trade to keep file size
    // sane; no trade so far in this project has come close to that.
    priceHistory: [{ t: 0, pct: 0 }],
    lastPrice: entryPrice,
    lastPriceChange: Date.now(),
    realPnl: 0,
    realPnlPct: 0,
    isGrad: false,
    priceUpdates: 0,
    firstUpdateAt: null,
    openedAt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    startTime: Date.now(),
    entrySlipCost: entrySlipCost,
    poolSizeAtEntry: S.tokens.size,
    scanCountAtEntry: S.scanCount,
    entryUniqueBuyers: tok.uniqueBuyers ? tok.uniqueBuyers.size : 0,
    entryUniqueSellers: tok.uniqueSellers ? tok.uniqueSellers.size : 0,
    entryDustSwaps: tok.dustSwaps || 0,
    entryRealSwaps: tok.realSwaps || 0,
    entryPreVolatilityPct: computeMaxTickSwing(tok.recentPrices),
    entryLiquidityUsd: tok.liquidityUsd !== undefined ? tok.liquidityUsd : null,
    secondsSinceDiscovery: tok.addedAt ? parseFloat(((Date.now() - tok.addedAt) / 1000).toFixed(2)) : null,
    entryDevBought: tok.devBought ? 'Yes' : 'No',
    entryDevSold: tok.devSold ? 'Yes' : 'No',
    hasDevWalletData: tok.devWallet ? 'Yes' : 'No',
    entryPreVolTickCount: tok.recentPrices ? tok.recentPrices.length : 0,
    entryTrigger: triggerSource || 'scanner',
  };

  S.open.push(trade);
  log('ENTER ' + tok.n + ' [' + tok.src + '] | ' + tok.mint + ' | $' + size.toFixed(2) + ' | Entry $' + entryPrice.toFixed(8), 'entry');
}

// -- MAIN SCANNER (now a thin backup pass) -----------------------
// Still runs every 500ms as a safety net - covers DSC tokens (though DSC
// entries remain disabled) and catches anything the event-driven trigger
// might have missed - but entry logic itself now lives in the shared
// function above, not duplicated here.
async function runScan() {
  if (S.tokens.size === 0) return;
  if (S.running && !S.windingDown && S.fund < 1) { stopBot(); }
  if (!paperSlotFree() && !liveSlotFree()) return;

  var tokens = Array.from(S.tokens.values());
  if (tokens.length === 0) return;

  var tok = tokens[scanIdx % tokens.length];
  scanIdx++;
  S.scanCount++;

  if (!tok || !tok.mint) return;

  await tryEnterToken(tok, null, 'scanner');
}

// -- POOL CLEANUP ----------------------------------------------
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
  liveCooldowns.forEach(function(ts, key) {
    if (now - ts > CFG.COOLDOWN_MS) liveCooldowns.delete(key);
  });
  recheckExpiredBans();
  if (removed > 0) log('Pool cleaned: ' + removed + ' removed | Pool: ' + S.tokens.size, 'info');
}

// -- BOT CONTROL -----------------------------------------------
var exitI = null, cleanI = null, priceI = null, dsI = null, solPriceI = null;

// The data feed (Bitquery socket, entry scanner, pool cleanup, SOL price) is
// shared by paper and live. Either one being on keeps it running; it only shuts
// down when both are off. Safe to call repeatedly.
function startFeed() {
  connectBQ();
  if (!scanI) scanI = setInterval(runScan, 500);
  if (!cleanI) cleanI = setInterval(cleanPool, 3600000);
  if (!solPriceI) solPriceI = setInterval(updateSolPrice, 600000);
  updateSolPrice();
}

function stopFeed() {
  if (scanI) { clearInterval(scanI); scanI = null; }
  if (cleanI) { clearInterval(cleanI); cleanI = null; }
  if (solPriceI) { clearInterval(solPriceI); solPriceI = null; }
  if (pumpWs) {
    bqDeliberateStop = true;
    try { pumpWs.close(); } catch(e) {}
    pumpWs = null;
  }
}

function startBot() {
  if (S.running) return;
  S.running = true;
  S.startTime = Date.now();
  S.stats = { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0, mcapCeiling: 0 };
  S.savings = 0;
  S.dscPool = 0;
  S.solPool = 0;
  S.dscKey = 0;
  S.bestTrade = null;
  S.totalFees = 0;
  S.windingDown = false;
  S.scanCount = 0;
  S.rejectCount = 0;
  S.rejectReasons = {};
  S.pumpCount = 0;
  S.bonkCount = 0;
  S.dayStartFund = S.sessionFund;
  S.fund = S.sessionFund;
  S.sessionHighFund = S.sessionFund;

  startFeed();
  fetchDSTokens();

  exitI = setInterval(checkExitCriteria, 10000);
  priceI = setInterval(updateOpenTradePrices, 2000);
  dsI = setInterval(fetchDSTokens, CFG.DS_INTERVAL);

  log('BunkerBuster STARTED | Fund: $' + S.sessionFund + ' | SL: ' + S.stopLossPct + '% | Max: ' + S.maxOpen, 'info');
}

function stopBot() {
  S.running = false;
  S.lastStopTime = Date.now();
  // Reset moved here from startBot() - the bug was that pressing Start
  // unconditionally wiped autolock back to off every single time, even
  // when the user had just turned it on beforehand, so it never actually
  // took effect once trading began. Resetting here instead means it turns
  // off once a session ends, ready to be explicitly turned on again before
  // the next one - matching the user's confirmed intended workflow.
  S.autoLockEnabled = false;
  if (exitI) clearInterval(exitI);
  if (priceI) clearInterval(priceI);
  if (dsI) clearInterval(dsI);
  if (S.windDownCheckInterval) { clearInterval(S.windDownCheckInterval); S.windDownCheckInterval = null; }
  // Live may still need the feed -- only shut it down once nothing needs it.
  if (!feedNeeded()) stopFeed();

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

// -- LIVE PORTFOLIO HISTORY ------------------------------------
// Current live session numbers, same formula as paper's session: what the
// fund (counting money still in open positions) plus savings is worth now,
// compared with where the session started.
function liveSessionSummary() {
  var ls = S.liveSession;
  if (!ls) return null;
  var pnl = parseFloat((liveEffectiveFund() + S.liveSavings - ls.startFund - ls.startSavings).toFixed(2));
  return {
    date: new Date(ls.startTime).toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
    startTime: new Date(ls.startTime).toLocaleString('en-US', { timeZone: 'America/New_York' }),
    trades: ls.t, wins: ls.w, losses: ls.l,
    winRate: ls.t > 0 ? parseFloat((ls.w / ls.t * 100).toFixed(1)) : 0,
    startFund: parseFloat(ls.startFund.toFixed(2)),
    pnl: pnl,
    returnPct: ls.startFund > 0 ? parseFloat((pnl / ls.startFund * 100).toFixed(2)) : 0,
    totalFees: parseFloat(ls.fees.toFixed(4)),
  };
}

// Saved when automatic live trading is turned off, like paper saves a
// session when it stops. Only recorded once, and only if trades happened.
function endLiveSession() {
  var ls = S.liveSession;
  if (!ls || ls.recorded) return;
  ls.recorded = true;
  if (ls.t <= 0) return;
  var sum = liveSessionSummary();
  sum.endTime = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  sum.endFund = parseFloat(liveEffectiveFund().toFixed(2));
  sum.savings = parseFloat(S.liveSavings.toFixed(2));
  S.liveSessions.unshift(sum);
}

app.get('/api/live/portfolio', function(req, res) {
  res.json({
    allTime: S.liveAllTime, bestTrade: S.liveBestTrade, worstTrade: S.liveWorstTrade,
    sessions: S.liveSessions.slice(0, 50), totalSessions: S.liveSessions.length, totalTrades: S.liveClosed.length,
    session: liveSessionSummary(),
  });
});

app.get('/api/live/portfolio/trades', function(req, res) {
  var q = req.query;
  var trades = S.liveClosed.slice().reverse().map(function(t) {
    return { name: t.name, mint: t.mint, size: t.size, closedDate: t.closedDate, chain: 'solana',
      src: t.platform === 'pumpfun' ? 'PUMP' : 'BONK', pnl: t.pnl, pnlPct: t.pnlPct, closeReason: t.closeReason };
  });
  if (q.date) trades = trades.filter(function(t) { return t.closedDate === q.date; });
  if (q.token) { var tok = q.token.toUpperCase(); trades = trades.filter(function(t) { return t.name && t.name.toUpperCase().indexOf(tok) >= 0; }); }
  if (q.src && q.src !== 'all') trades = trades.filter(function(t) { return t.src === q.src; });
  if (q.result === 'win') trades = trades.filter(function(t) { return t.pnl !== null && t.pnl > 0; });
  if (q.result === 'loss') trades = trades.filter(function(t) { return t.pnl !== null && t.pnl <= 0; });
  if (q.exit && q.exit !== 'all') trades = trades.filter(function(t) { return t.closeReason && t.closeReason.toLowerCase().indexOf(q.exit.toLowerCase()) >= 0; });
  var page = parseInt(q.page) || 0;
  var limit = parseInt(q.limit) || 50;
  if (limit > 99999) limit = trades.length || 1;
  var total = trades.length;
  trades = trades.slice(page * limit, (page + 1) * limit);
  res.json({ trades: trades, total: total, page: page, pages: Math.ceil(total / limit) });
});

// -- API ROUTES ------------------------------------------------
app.get('/api/state', function(req, res) {
  res.json({
    fund: S.fund,
    savings: S.savings,
    stats: S.stats,
    running: S.running,
    pumpLive: S.pumpLive,
    pumpCount: S.pumpCount,
    bonkCount: S.bonkCount,
    poolSize: S.tokens.size,
    scanCount: S.scanCount,
    rejectCount: S.rejectCount,
    rejectReasons: S.rejectReasons,
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
    permanentBans: S.permanentBans.size,
    tempBans: S.tempBans.size,
    dscPool: S.dscPool,
    solPool: S.solPool,
    dscKey: S.dscKey,
    bestTrade: S.bestTrade,
    sessionFund: S.sessionFund,
    dayStartFund: S.dayStartFund,
    takeProfitMode: S.takeProfitMode,
    takeProfitPct: S.takeProfitPct,
    stopLossPct: S.stopLossPct,
    totalFees: S.totalFees,
    maxOpen: S.maxOpen,
    fundStopLossPct: S.fundStopLossPct,
    windingDown: S.windingDown,
    currentLossPct: S.dayStartFund > 0
      ? parseFloat(((S.dayStartFund - S.fund) / S.dayStartFund * 100).toFixed(2)) : 0,
    autoLockEnabled: S.autoLockEnabled,
    maxPool: S.maxPool,
    logs: S.logs.slice(0, 100),
    sources: S.sources,
    startTime: S.startTime,
    liveWallet: liveWalletState,
    liveFund: S.liveFund,
    liveTradingEnabled: S.liveTradingEnabled,
    liveMaxOpen: S.liveMaxOpen,
    liveFundStopLossPct: S.liveFundStopLossPct,
    liveStopLossPct: S.liveStopLossPct,
    liveTakeProfitMode: S.liveTakeProfitMode,
    liveTakeProfitPct: S.liveTakeProfitPct,
    liveWindingDown: S.liveWindingDown,
    liveStats: S.liveStats,
    liveEffectiveFund: liveEffectiveFund(),
    liveSavings: S.liveSavings,
    livePendingSavings: S.livePendingSavings,
    liveSavingsSent: S.liveSavingsSent,
    liveStartFund: S.liveStartFund,
    liveRealizedPnl: S.liveRealizedPnl,
    liveAutoLockEnabled: S.liveAutoLockEnabled,
    liveClosedTrades: S.liveClosed.slice(-15).reverse(),
    liveTipsPaidUsd: S.liveTipsPaidUsd,
    liveNetworkFeesUsd: S.liveNetworkFeesUsd,
    liveOpen: S.liveOpen,
    liveLogs: S.liveLogs,
    solPriceUsd: SOL_PRICE_USD,
    solPriceFresh: isSolPriceFresh(),
  });
});

app.post('/api/start', function(req, res) { startBot(); res.json({ success: true }); });
app.get('/api/start', function(req, res) { startBot(); res.json({ success: true }); });
app.post('/api/stop', function(req, res) { stopBot(); res.json({ success: true }); });
app.get('/api/stop', function(req, res) { stopBot(); res.json({ success: true }); });
app.post('/api/sell/:id', function(req, res) { closeTradeReal(req.params.id, 'Manual sell'); res.json({ success: true }); });
app.post('/api/lock-fund', function(req, res) {
  var oldBase = S.dayStartFund;
  S.dayStartFund = S.fund;
  S.windingDown = false;
  var newTrigger = S.fund * (1 - S.fundStopLossPct / 100);
  log('Fund stop loss locked to current balance - new base $' + S.fund.toFixed(2) + ' (was $' + oldBase.toFixed(2) + ') | triggers below $' + newTrigger.toFixed(2), 'info');
  res.json({ success: true, newBase: S.fund, triggerAt: parseFloat(newTrigger.toFixed(2)) });
});

// Manually-triggered only -- never runs on startup or on a schedule.
// Sends a real 0.00001 SOL self-transfer through the same
// sendAndConfirm logic every future real trade will use, so we can
// prove it against real infrastructure before any trading exists.
app.post('/api/live/test-transaction', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  try {
    var execution = require('./execution');
    var connection = liveWalletModule.getConnection();
    liveLog('LIVE TEST: sending self-transfer...', 'info');
    var result = await execution.testSelfTransfer(liveWalletKeypair, connection);
    liveLog('LIVE TEST result: ' + result.outcome + ' | signature: ' + result.signature +
      (result.error ? ' | error: ' + result.error : ''), result.outcome === 'CONFIRMED' ? 'win' : 'warn');
    res.json({ ok: true, result: result });
  } catch (e) {
    liveLog('LIVE TEST ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// Same proof test, routed through Helius Sender with a real tip and
// priority fee -- the actual fast-submission path real trades will
// use. Manually-triggered only, same as the normal-path test above.
app.post('/api/live/test-transaction-sender', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  try {
    var execution = require('./execution');
    var connection = liveWalletModule.getConnection();
    var rpcUrl = process.env[liveWalletModule.LIVE_RPC_ENV];
    liveLog('LIVE TEST (Sender): sending self-transfer with tip + priority fee...', 'info');
    var result = await execution.testSelfTransferViaSender(liveWalletKeypair, connection, rpcUrl);
    liveLog('LIVE TEST (Sender) result: ' + result.outcome + ' | signature: ' + result.signature +
      (result.error ? ' | error: ' + result.error : ''), result.outcome === 'CONFIRMED' ? 'win' : 'warn');
    res.json({ ok: true, result: result });
  } catch (e) {
    liveLog('LIVE TEST (Sender) ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// Safe, read-only proof test: builds real buy instructions against a
// real, live token mint using current on-chain state, but never sends
// anything. Proves the pump.fun SDK integration works against reality
// before it's ever combined with actual execution. Pass a real
// pump.fun token's mint address in the request body as "mint".
app.post('/api/live/test-pumpfun-quote', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  var mintStr = req.body && req.body.mint;
  if (!mintStr) {
    return res.json({ ok: false, error: 'Provide a real pump.fun token mint address in the request body as "mint"' });
  }
  try {
    var { PublicKey } = require('@solana/web3.js');
    var pumpfun = require('./pumpfun');
    var connection = liveWalletModule.getConnection();
    var mint = new PublicKey(mintStr);
    var solAmountLamports = 1000000; // 0.001 SOL -- tiny, just to prove the quote/build path
    liveLog('LIVE TEST (pump.fun quote): building buy instructions for ' + mintStr + '...', 'info');
    var instructions = await pumpfun.buildBuyInstructions(connection, mint, liveWalletKeypair.publicKey, solAmountLamports, 15);
    liveLog('LIVE TEST (pump.fun quote) result: built ' + instructions.length + ' instruction(s) successfully -- nothing sent', 'win');
    res.json({ ok: true, instructionCount: instructions.length });
  } catch (e) {
    liveLog('LIVE TEST (pump.fun quote) ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// Same safe, read-only proof test, for LetsBonk (Raydium's LaunchLab)
// instead. Builds real buy instructions against a real, live token
// using current on-chain state, but never sends anything.
app.post('/api/live/test-letsbonk-quote', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  var mintStr = req.body && req.body.mint;
  if (!mintStr) {
    return res.json({ ok: false, error: 'Provide a real LetsBonk token mint address in the request body as "mint"' });
  }
  try {
    var { PublicKey } = require('@solana/web3.js');
    var letsbonk = require('./letsbonk');
    var connection = liveWalletModule.getConnection();
    var mint = new PublicKey(mintStr);
    var solAmountLamports = 1000000; // 0.001 SOL -- tiny, just to prove the quote/build path
    liveLog('LIVE TEST (LetsBonk quote): building buy instructions for ' + mintStr + '...', 'info');
    var instructions = await letsbonk.buildBuyInstructions(connection, mint, liveWalletKeypair.publicKey, solAmountLamports, 1500);
    liveLog('LIVE TEST (LetsBonk quote) result: built ' + instructions.length + ' instruction(s) successfully -- nothing sent', 'win');
    res.json({ ok: true, instructionCount: instructions.length });
  } catch (e) {
    liveLog('LIVE TEST (LetsBonk quote) ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// Graduation check: pump.fun. Reports true/false, nothing sent.
app.post('/api/live/test-pumpfun-graduated', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  var mintStr = req.body && req.body.mint;
  if (!mintStr) {
    return res.json({ ok: false, error: 'Provide a real pump.fun token mint address in the request body as "mint"' });
  }
  try {
    var { PublicKey } = require('@solana/web3.js');
    var pumpfun = require('./pumpfun');
    var connection = liveWalletModule.getConnection();
    var mint = new PublicKey(mintStr);
    var graduated = await pumpfun.isGraduated(connection, mint, liveWalletKeypair.publicKey);
    liveLog('LIVE TEST (pump.fun graduation check) result: ' + (graduated ? 'GRADUATED' : 'still on curve'), 'win');
    res.json({ ok: true, graduated: graduated });
  } catch (e) {
    liveLog('LIVE TEST (pump.fun graduation check) ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// Graduation check: LetsBonk. Reports true/false, nothing sent.
app.post('/api/live/test-letsbonk-graduated', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  var mintStr = req.body && req.body.mint;
  if (!mintStr) {
    return res.json({ ok: false, error: 'Provide a real LetsBonk token mint address in the request body as "mint"' });
  }
  try {
    var { PublicKey } = require('@solana/web3.js');
    var letsbonk = require('./letsbonk');
    var connection = liveWalletModule.getConnection();
    var mint = new PublicKey(mintStr);
    var graduated = await letsbonk.isGraduated(connection, mint, liveWalletKeypair.publicKey);
    liveLog('LIVE TEST (LetsBonk graduation check) result: ' + (graduated ? 'GRADUATED/MIGRATED' : 'still on curve'), 'win');
    res.json({ ok: true, graduated: graduated });
  } catch (e) {
    liveLog('LIVE TEST (LetsBonk graduation check) ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// Safe, read-only proof test: builds a real sell on PumpSwap for a
// real, already-graduated token. Nothing sent, nothing needs to be
// owned -- building the instruction doesn't require holding the token.
app.post('/api/live/test-pumpswap-quote', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  var mintStr = req.body && req.body.mint;
  if (!mintStr) {
    return res.json({ ok: false, error: 'Provide a real, already-graduated pump.fun token mint address in the request body as "mint"' });
  }
  try {
    var { PublicKey } = require('@solana/web3.js');
    var pumpswap = require('./pumpswap');
    var connection = liveWalletModule.getConnection();
    var mint = new PublicKey(mintStr);
    var tokenAmount = 1000000; // small made-up amount, just to prove the build path
    liveLog('LIVE TEST (PumpSwap quote): building sell instructions for ' + mintStr + '...', 'info');
    var instructions = await pumpswap.buildSellInstructions(connection, mint, liveWalletKeypair.publicKey, tokenAmount, 15);
    liveLog('LIVE TEST (PumpSwap quote) result: built ' + instructions.length + ' instruction(s) successfully -- nothing sent', 'win');
    res.json({ ok: true, instructionCount: instructions.length });
  } catch (e) {
    liveLog('LIVE TEST (PumpSwap quote) ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// Same safe, read-only proof test, for a real, already-migrated
// LetsBonk token's new Raydium CPMM pool. Requires both the token's
// mint and its post-migration pool address (both in the request body).
app.post('/api/live/test-raydiumcpmm-quote', async function(req, res) {
  if (!liveWalletKeypair) {
    return res.json({ ok: false, error: liveWalletState.configError || 'Live wallet not configured' });
  }
  var mintStr = req.body && req.body.mint;
  var poolStr = req.body && req.body.poolId;
  if (!mintStr || !poolStr) {
    return res.json({ ok: false, error: 'Provide both a real, migrated token mint and its post-migration pool address as "mint" and "poolId"' });
  }
  try {
    var { PublicKey } = require('@solana/web3.js');
    var raydiumcpmm = require('./raydiumcpmm');
    var connection = liveWalletModule.getConnection();
    var mint = new PublicKey(mintStr);
    var poolId = new PublicKey(poolStr);
    var tokenAmount = 1000000; // small made-up amount, just to prove the build path
    liveLog('LIVE TEST (Raydium CPMM quote): building sell instructions for ' + mintStr + '...', 'info');
    var instructions = await raydiumcpmm.buildSellInstructions(connection, poolId, mint, liveWalletKeypair.publicKey, tokenAmount, 15);
    liveLog('LIVE TEST (Raydium CPMM quote) result: built ' + instructions.length + ' instruction(s) successfully -- nothing sent', 'win');
    res.json({ ok: true, instructionCount: instructions.length });
  } catch (e) {
    liveLog('LIVE TEST (Raydium CPMM quote) ERROR: ' + e.message, 'warn');
    res.json({ ok: false, error: e.message });
  }
});

// -- LIVE TRADE TEST (real money, manually triggered only) --------
// $1 buy and real-balance sell, one platform at a time. Every step
// uses exactly the pieces already proven tonight -- nothing new
// invented, just wired together for the first real trade.

// Capital currently sitting in open real positions, at cost (the trade size,
// scaled down by whatever share a tier sale already sold). The live fund drops
// by the full buy cost the moment a buy confirms and gets it back on the sale,
// so without this the fund stop loss would read every open position as a loss.
// Paper's fund never drops at entry, only at close -- this makes live measure
// the same way. Fees and tips are NOT added back: those are real money spent.
function liveDeployedUsd() {
  var total = 0;
  (S.liveOpen || []).forEach(function(p) {
    var frac = 1;
    if (p.startTokenAmountRaw && p.tokenAmountRaw) {
      var s0 = Number(p.startTokenAmountRaw), s1 = Number(p.tokenAmountRaw);
      if (s0 > 0 && s1 >= 0) frac = Math.min(1, s1 / s0);
    }
    total += (p.sizeUsd || 0) * frac;
  });
  return total;
}

// The fund as paper measures it: cash plus capital deployed in open positions.
function liveEffectiveFund() {
  return S.liveFund + liveDeployedUsd();
}

// Checks real fund drawdown against the configured live fund stop
// loss, mirroring paper's exact mechanism: once the threshold is
// crossed, new automatic entries stop (existing positions keep being
// watched normally), and it auto-resumes if the fund recovers back
// above the line before everything closes.
function checkLiveFundStopLoss() {
  if (!S.liveDayStartFund || S.liveDayStartFund <= 0) return;
  var lossLimit = S.liveFundStopLossPct / 100;
  var currentLoss = (S.liveDayStartFund - liveEffectiveFund()) / S.liveDayStartFund;
  if (currentLoss >= lossLimit && !S.liveWindingDown) {
    S.liveWindingDown = true;
    liveLog('LIVE FUND LOSS LIMIT HIT - ' + S.liveFundStopLossPct + '% reached - no new automatic real entries until it recovers or you reset the fund', 'rug');
  } else if (S.liveWindingDown && currentLoss < lossLimit) {
    S.liveWindingDown = false;
    liveLog('LIVE FUND recovered back above the ' + S.liveFundStopLossPct + '% loss line -- automatic real entries resumed', 'win');
  }
}

// Automatic Fund Protection, mirroring paper's auto-lock exactly: when ON, every
// time the live fund reaches a NEW high this session, the fund stop loss base
// is raised to that high (so the loss line is measured from the new high). It
// only ever moves up. Runs after every confirmed real sale, the same moments
// paper runs its own ratchet.
function liveAutoLockCheck() {
  var eff = liveEffectiveFund();
  if (S.liveAutoLockEnabled && eff > S.liveSessionHighFund) {
    S.liveSessionHighFund = eff;
    var oldBase = S.liveDayStartFund;
    S.liveDayStartFund = eff;
    S.liveWindingDown = false;
    var newTrigger = eff * (1 - S.liveFundStopLossPct / 100);
    liveLog('LIVE AUTO-LOCK: new high $' + eff.toFixed(2) + ' - stop loss raised (was $' + oldBase.toFixed(2) + ') | triggers below $' + newTrigger.toFixed(2), 'info');
  }
}

// Real position sizing: 5% of the live fund (mirroring paper
// trading's exact CFG.MAX_POS formula), hard capped at $15 -- the cap
// paper trading decided on but never actually had built into its own
// code. Returns null if the fund isn't configured or the resulting
// size is too small to be worth trading, same floor paper trading uses.
function computeLivePositionSizeUsd() {
  if (!S.liveFund || S.liveFund <= 0) return null;
  // Sized from the whole fund (cash plus what is deployed in open trades),
  // exactly as paper sizes from its whole fund -- not from the cash left over
  // after other trades are open. It can never be more than the cash actually
  // available to spend.
  var size = parseFloat((liveEffectiveFund() * CFG.MAX_POS).toFixed(4));
  if (size > S.liveFund) size = parseFloat(S.liveFund.toFixed(4));
  if (size > 15) size = 15;
  if (size < 0.50) return null;
  return size;
}

// Reads the two real, separate costs of a confirmed transaction: the Sender
// tip (exact -- we set it ourselves) and the network fee (read from the
// transaction's own on-chain record; base fee + priority fee). Never throws:
// a cost that cannot be read comes back null, never guessed. Both are also
// already inside the wallet-impact number that moves the Live Fund -- these
// are tracked on top of that, purely so they can be shown on their own.
async function readRealTxCosts(connection, result) {
  var out = { tipLamports: null, feeLamports: null, tipUsd: null, feeUsd: null };
  if (typeof result.tipLamports === 'number') {
    out.tipLamports = result.tipLamports;
    out.tipUsd = (result.tipLamports / 1000000000) * SOL_PRICE_USD;
  }
  try {
    var feeLamports = await liveWalletModule.getRealTransactionFee(connection, result.signature);
    out.feeLamports = feeLamports;
    out.feeUsd = (feeLamports / 1000000000) * SOL_PRICE_USD;
  } catch (e) { /* stays null */ }
  if (out.tipUsd !== null) S.liveTipsPaidUsd = parseFloat((S.liveTipsPaidUsd + out.tipUsd).toFixed(6));
  if (out.feeUsd !== null) S.liveNetworkFeesUsd = parseFloat((S.liveNetworkFeesUsd + out.feeUsd).toFixed(6));
  return out;
}

// If a real buy or sell does not go through, the remembered settings used to
// build it (see pumpfun.js / letsbonk.js) are thrown away, so the next
// attempt starts from fresh on-chain data instead of anything that might be
// stale.
function invalidateBuilderCaches() {
  try { require('./pumpfun').clearCaches(); } catch (e) {}
  try { require('./letsbonk').clearCaches(); } catch (e) {}
}

// While automatic live trading is on (or a real position is still open), keep
// the things a real buy or sell needs already in memory -- the current tip
// number and pump.fun's settings -- so none of them is waited on at the
// moment of the trade.
async function warmLiveExecution() {
  if (!liveWalletKeypair || !liveWalletModule) return;
  if (!S.liveTradingEnabled && S.liveOpen.length === 0) return;
  try {
    require('./execution').warmTipCache();
    require('./pumpfun').warmCaches(liveWalletModule.getConnection()).catch(function() {});
  } catch (e) { /* warming is only a speed-up; a real trade still works without it */ }
}
setInterval(warmLiveExecution, 10000);

// -- WEEKLY PUMP.FUN SDK VERSION CHECK -----------------------------
// pump.fun has changed its on-chain accounts and fees before, and the official
// SDK is updated to follow. Once at startup and then once a week, ask the npm
// registry for the newest version of @pump-fun/pump-sdk and say in the live
// log whether the installed one is behind. It only reports -- it never
// installs or changes anything.
var PUMP_SDK_PACKAGE = '@pump-fun/pump-sdk';
var PUMP_SDK_CHECK_MS = 7 * 24 * 60 * 60 * 1000;

function compareVersions(a, b) {
  var pa = String(a).split('-')[0].split('.').map(function(x) { return parseInt(x, 10) || 0; });
  var pb = String(b).split('-')[0].split('.').map(function(x) { return parseInt(x, 10) || 0; });
  for (var i = 0; i < 3; i++) {
    var d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Reads the installed version straight from the package's own package.json.
// Some packages block requiring that file directly, so if that fails the
// folders above the package's entry file are searched for it instead.
function readInstalledPackageVersion(name) {
  try { return require(name + '/package.json').version; } catch (e) { /* try the folder search */ }
  try {
    var dir = path.dirname(require.resolve(name));
    for (var i = 0; i < 6; i++) {
      var file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        var pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (pkg.name === name) return pkg.version;
      }
      var up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch (e) { /* unreadable */ }
  return null;
}

async function checkPumpSdkVersion() {
  try {
    var installed = readInstalledPackageVersion(PUMP_SDK_PACKAGE);
    var ctl = new AbortController();
    var timer = setTimeout(function() { ctl.abort(); }, 10000);
    var res;
    try {
      res = await fetch('https://registry.npmjs.org/' + PUMP_SDK_PACKAGE.replace('/', '%2f') + '/latest', { signal: ctl.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error('registry answered HTTP ' + res.status);
    var latest = (await res.json()).version;
    if (!latest) throw new Error('registry reply had no version');
    if (!installed) {
      liveLog('PUMP SDK CHECK: newest ' + PUMP_SDK_PACKAGE + ' is ' + latest + ' but the installed version could not be read -- check it manually', 'warn');
    } else if (compareVersions(installed, latest) < 0) {
      liveLog('PUMP SDK CHECK: a NEWER ' + PUMP_SDK_PACKAGE + ' is available -- installed ' + installed + ', newest ' + latest + '. Tell Claude so it can be reviewed and tested before updating', 'warn');
    } else {
      liveLog('PUMP SDK CHECK: ' + PUMP_SDK_PACKAGE + ' ' + installed + ' is the newest version', 'info');
    }
    return { installed: installed, latest: latest };
  } catch (e) {
    liveLog('PUMP SDK CHECK: could not check for a newer ' + PUMP_SDK_PACKAGE + ' (' + e.message + ') -- will try again next week', 'info');
    return null;
  }
}
setTimeout(checkPumpSdkVersion, 30000);
setInterval(checkPumpSdkVersion, PUMP_SDK_CHECK_MS);

// -- AUTOMATIC SAVINGS TRANSFER ----------------------------------
// Every winning trade sets aside 20% of its profit as savings (bookkeeping,
// above). Once $20 of it has built up, the real SOL is sent from the trading
// wallet to the savings wallet automatically -- no approval step. The
// savings wallet only ever RECEIVES; the bot has no key for it.
//
// Safety rules: only one transfer at a time; a transfer whose outcome is not
// known yet is waited on and never re-sent until it is proven it did not
// land; the trading wallet must keep a cushion of SOL for fees; and if the
// savings address is missing or invalid the savings simply stay in the
// trading wallet as "waiting" and trading carries on.
var SAVINGS_SEND_THRESHOLD_USD = 20;
var SAVINGS_FEE_CUSHION_LAMPORTS = 10000000;   // 0.01 SOL always left behind
var savingsXfer = { busy: false, retryAfter: 0, fails: 0, warned: {} };

function savingsWarnOnce(key, msg) {
  if (savingsXfer.warned[key]) return;
  savingsXfer.warned[key] = true;
  liveLog(msg, 'warn');
}

async function finishSavingsTransfer(connection, result, usd, lamports, address) {
  S.livePendingSavings = parseFloat(Math.max(0, S.livePendingSavings - usd).toFixed(4));
  S.liveSavingsSent = parseFloat((S.liveSavingsSent + usd).toFixed(4));
  S.liveSavingsTransfers.push({ at: Date.now(), usd: usd, lamports: lamports, address: address, signature: result.signature });
  S.liveSavingsInFlight = null;
  savingsXfer.fails = 0;
  savingsXfer.warned = {};
  liveLog('LIVE SAVINGS SENT: $' + usd.toFixed(2) + ' (' + (lamports / 1000000000).toFixed(6) + ' SOL) to the savings wallet ' + address + ' | signature: ' + result.signature + ' | total sent $' + S.liveSavingsSent.toFixed(2) + ', $' + S.livePendingSavings.toFixed(2) + ' still waiting', 'win');
  // The savings amount already left the Live Fund when it was set aside; only
  // the transfer's own tip and network fee are new costs to the wallet.
  var costs = await readRealTxCosts(connection, result);
  var costUsd = (costs.tipUsd || 0) + (costs.feeUsd || 0);
  if (costUsd > 0) {
    S.liveFund = parseFloat((S.liveFund - costUsd).toFixed(4));
    liveLog('LIVE SAVINGS SENT: transfer cost $' + costUsd.toFixed(4) + ' (' + describeRealCosts(costs) + ') -- Live Fund now $' + S.liveFund.toFixed(4), 'info');
  }
}

// Checks on a transfer whose outcome was not known when it was sent.
// Settles it one way or the other, or leaves it waiting while it is still unresolved.
async function resolveSavingsInFlight(connection) {
  var f = S.liveSavingsInFlight;
  var readStatus = async function() {
    var st = await connection.getSignatureStatuses([f.signature], { searchTransactionHistory: true });
    return st && st.value && st.value[0];
  };
  var st = await readStatus();
  if (!st) {
    var height = await connection.getBlockHeight();
    if (!f.lastValidBlockHeight || height <= f.lastValidBlockHeight) {
      if (Date.now() - f.at > 600000) savingsWarnOnce('inflight', 'LIVE SAVINGS: transfer ' + f.signature + ' is still unresolved after 10 minutes -- NOT sending again until it is settled; check it on a block explorer');
      return false;
    }
    st = await readStatus();   // an expired window alone does not prove it never landed
  }
  if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
    liveLog('LIVE SAVINGS: the earlier transfer ' + f.signature + ' has CONFIRMED -- recording it, NOT sending again', 'win');
    await finishSavingsTransfer(connection, { signature: f.signature, tipLamports: f.tipLamports }, f.usd, f.lamports, f.address);
    return true;
  }
  liveLog('LIVE SAVINGS: the earlier transfer ' + f.signature + (st && st.err ? ' landed but was rejected on-chain' : ' expired without landing') + ' -- nothing was sent, the savings are still waiting', 'warn');
  S.liveSavingsInFlight = null;
  return true;
}

async function maybeSendSavings() {
  if (savingsXfer.busy || !liveWalletKeypair || !liveWalletModule) return;
  if (Date.now() < savingsXfer.retryAfter) return;
  if (!S.liveSavingsInFlight && S.livePendingSavings < SAVINGS_SEND_THRESHOLD_USD) return;
  savingsXfer.busy = true;
  try {
    var web3 = require('@solana/web3.js');
    var connection = liveWalletModule.getConnection();
    if (S.liveSavingsInFlight) {
      await resolveSavingsInFlight(connection);
      // Whatever the answer, a new transfer (if one is still due) starts on the
      // next check, never in the same breath as settling the old one.
      return;
    }

    var address = liveWalletState.savingsAddress;
    if (!address) {
      savingsWarnOnce('noaddr', 'LIVE SAVINGS: $' + S.livePendingSavings.toFixed(2) + ' is waiting but no savings wallet address is set -- it stays safe in the trading wallet and will be sent automatically once the address is set (restart needed after setting it)');
      savingsXfer.retryAfter = Date.now() + 300000;
      return;
    }
    if (address === liveWalletState.address) {
      savingsWarnOnce('same', 'LIVE SAVINGS: the savings address is the same as the trading wallet -- not sending; fix the savings address');
      savingsXfer.retryAfter = Date.now() + 300000;
      return;
    }
    var toKey;
    try { toKey = new web3.PublicKey(address); } catch (e) {
      savingsWarnOnce('badaddr', 'LIVE SAVINGS: the savings address is not a valid wallet address -- not sending; $' + S.livePendingSavings.toFixed(2) + ' stays in the trading wallet');
      savingsXfer.retryAfter = Date.now() + 300000;
      return;
    }
    if (!SOL_PRICE_USD || SOL_PRICE_USD <= 0 || !isSolPriceFresh()) {
      savingsXfer.retryAfter = Date.now() + 60000;
      return;
    }

    var usd = S.livePendingSavings;
    var lamports = Math.floor((usd / SOL_PRICE_USD) * 1000000000);
    var balanceSol = await liveWalletModule.getTradingWalletBalance(liveWalletKeypair.publicKey);
    var balanceLamports = Math.floor(balanceSol * 1000000000);
    if (balanceLamports - lamports < SAVINGS_FEE_CUSHION_LAMPORTS) {
      liveLog('LIVE SAVINGS: not sending $' + usd.toFixed(2) + ' yet -- the trading wallet would be left with under 0.01 SOL for fees. Will try again shortly', 'warn');
      savingsXfer.retryAfter = Date.now() + 300000;
      return;
    }

    liveLog('LIVE SAVINGS: $' + usd.toFixed(2) + ' has built up -- sending ' + (lamports / 1000000000).toFixed(6) + ' SOL to the savings wallet ' + address + '...', 'info');
    var tx = new web3.Transaction();
    tx.add(web3.SystemProgram.transfer({ fromPubkey: liveWalletKeypair.publicKey, toPubkey: toKey, lamports: lamports }));
    var rpcUrl = process.env[liveWalletModule.LIVE_RPC_ENV];
    var result = await require('./execution').sendAndConfirmViaSender(tx, liveWalletKeypair, connection, rpcUrl, { tier: 'SWQOS_ONLY' });
    if (result.outcome === 'CONFIRMED') {
      await finishSavingsTransfer(connection, result, usd, lamports, address);
    } else if (result.outcome === 'PENDING') {
      S.liveSavingsInFlight = { signature: result.signature, lastValidBlockHeight: result.lastValidBlockHeight, tipLamports: result.tipLamports, usd: usd, lamports: lamports, address: address, at: Date.now() };
      liveLog('LIVE SAVINGS: transfer ' + result.signature + ' was submitted but not confirmed yet -- waiting on it, NOT sending again', 'warn');
      savingsXfer.retryAfter = Date.now() + 5000;
    } else {
      throw new Error('transfer outcome ' + result.outcome + (result.error ? ' -- ' + result.error : ''));
    }
  } catch (e) {
    savingsXfer.fails++;
    var wait = savingsXfer.fails >= 5 ? 600000 : 60000;
    savingsXfer.retryAfter = Date.now() + wait;
    liveLog('LIVE SAVINGS: transfer did not go through (' + e.message + ') -- the savings are still waiting, trying again in ' + (wait / 60000) + ' min' + (savingsXfer.fails >= 5 ? ' (' + savingsXfer.fails + ' failures in a row -- needs attention)' : ''), 'warn');
  } finally {
    savingsXfer.busy = false;
  }
}
setInterval(function() { maybeSendSavings().catch(function() {}); }, 30000);

function describeRealCosts(c) {
  return 'tip ' + (c.tipUsd !== null ? '$' + c.tipUsd.toFixed(4) + ' (' + c.tipLamports + ' lamports)' : 'unreadable') +
    ' | network fee ' + (c.feeUsd !== null ? '$' + c.feeUsd.toFixed(4) + ' (' + c.feeLamports + ' lamports)' : 'unreadable') +
    ' -- tracked separately';
}

// Shared real-buy core -- used by both the manual Live Trade Test
// button and the automatic entry trigger below. One real
// implementation, so the two can never behave differently.
// A real buy is refused if it would move the pool price by more than this
// (a sign the pool is too thin to get in and out of cleanly).
var LIVE_MAX_BUY_IMPACT_PCT = 5;

async function performRealBuy(mintStr, platformName, platformKey, buildBuyFn, logPrefix) {
  if (!liveWalletKeypair) {
    return { ok: false, error: liveWalletState.configError || 'Live wallet not configured' };
  }
  try {
    var { PublicKey, Transaction } = require('@solana/web3.js');
    var execution = require('./execution');
    var connection = liveWalletModule.getConnection();
    var rpcUrl = process.env[liveWalletModule.LIVE_RPC_ENV];
    var mint = new PublicKey(mintStr);

    if (!SOL_PRICE_USD || SOL_PRICE_USD <= 0 || !isSolPriceFresh()) {
      return { ok: false, error: 'Real SOL price is not genuinely fresh right now -- cannot safely size a real buy' };
    }
    var sizeUsd = computeLivePositionSizeUsd();
    if (sizeUsd === null) {
      return { ok: false, error: 'Live Trading Fund is not configured or too small to size a trade -- set it in Settings first' };
    }
    var solAmountLamports = Math.round((sizeUsd / SOL_PRICE_USD) * 1000000000);

    var buyT0 = Date.now();
    liveLog(logPrefix + ' (' + platformName + ' buy): building $' + sizeUsd.toFixed(2) + ' buy for ' + mintStr + '...', 'info');
    var instructions = await buildBuyFn(connection, mint, liveWalletKeypair.publicKey, solAmountLamports, 15, LIVE_MAX_BUY_IMPACT_PCT);
    var buyBuiltMs = Date.now() - buyT0;

    var tx = new Transaction();
    instructions.forEach(function(ix) { tx.add(ix); });

    liveLog(logPrefix + ' (' + platformName + ' buy): submitting real transaction...', 'info');
    var buySendT0 = Date.now();
    var result = await execution.sendAndConfirmViaSender(tx, liveWalletKeypair, connection, rpcUrl, { tier: 'SWQOS_ONLY', onDiagnostic: function(summary) { liveLog(logPrefix + ' (' + platformName + '): ' + summary, 'info'); } });
    var buySendMs = Date.now() - buySendT0;

    liveLog(logPrefix + ' (' + platformName + ' buy) result: ' + result.outcome + ' | signature: ' + result.signature +
      (result.error ? ' | error: ' + result.error : ''), result.outcome === 'CONFIRMED' ? 'win' : 'warn');
    if (result.outcome !== 'CONFIRMED') invalidateBuilderCaches();

    if (result.outcome === 'CONFIRMED') {
      // The three reads below (what the buy cost the wallet, the tip and fee,
      // and how many tokens arrived) do not depend on each other, so they run
      // together. The position cannot be watched for exits until all three are
      // in, so every millisecond here is a millisecond without a stop loss.
      var postBuyT0 = Date.now();
      var balanceChangePromise = liveWalletModule.getRealBalanceChange(connection, result.signature, liveWalletKeypair.publicKey).then(
        function(v) { return { value: v }; }, function(e) { return { error: e }; });
      var costsPromise = readRealTxCosts(connection, result);
      var heldPromise = liveWalletModule.getTokenBalance(connection, mint, liveWalletKeypair.publicKey).then(
        function(v) { return { value: v }; }, function(e) { return { error: e }; });
      var postBuy = await Promise.all([balanceChangePromise, costsPromise, heldPromise]);

      if (postBuy[0].error) {
        liveLog(logPrefix + ' (' + platformName + ' buy): could not read real balance change to update Live Fund -- ' + postBuy[0].error.message, 'warn');
      } else {
        var changeLamports = postBuy[0].value;
        var changeUsd = (changeLamports / 1000000000) * SOL_PRICE_USD;
        S.liveFund = parseFloat((S.liveFund + changeUsd).toFixed(4));
        liveLog(logPrefix + ' (' + platformName + ' buy): real wallet impact $' + changeUsd.toFixed(4) +
          ' (' + changeLamports + ' lamports, includes the trade, fee, and tip) -- Live Fund now $' + S.liveFund.toFixed(4), 'info');
      }

      var buyCosts = postBuy[1];
      liveLog(logPrefix + ' (' + platformName + ' buy): ' + describeRealCosts(buyCosts), 'info');

      try {
        if (postBuy[2].error) throw postBuy[2].error;
        var heldBalance = postBuy[2].value;
        var tokensHeld = parseFloat(heldBalance.amount) / Math.pow(10, heldBalance.decimals);
        if (tokensHeld > 0) {
          var entryPriceUsd = sizeUsd / tokensHeld;
          S.liveOpen.push({
            id: result.signature,
            mint: mintStr,
            platform: platformKey,
            entryPriceUsd: entryPriceUsd,
            tokenAmountRaw: heldBalance.amount,
            startTokenAmountRaw: heldBalance.amount,
            tokenDecimals: heldBalance.decimals,
            sizeUsd: sizeUsd,
            openedAt: Date.now(),
            name: ((S.tokens && S.tokens.get(mintStr)) || {}).n || '',
            buyImpactUsd: (typeof changeUsd === 'number') ? changeUsd : null,
            sellImpactUsd: 0,
            sellImpactKnown: true,
            buyTipUsd: buyCosts.tipUsd,
            buyFeeUsd: buyCosts.feeUsd,
            sellTipUsd: 0,
            sellFeeUsd: 0,
            tipKnown: buyCosts.tipUsd !== null,
            feeKnown: buyCosts.feeUsd !== null,
            tpl: S.liveTakeProfitMode,
            tpPct: S.liveTakeProfitPct,
            peakPriceUsd: entryPriceUsd,
            tier1Done: false,
            tier2Done: false,
            busy: false,
            retryAfter: 0,
          });
          liveLog('LIVE ENTER ' + (S.tokens.get(mintStr) ? S.tokens.get(mintStr).n : mintStr.slice(0, 6) + '...') + ' [' + platformName + '] | ' + mintStr + ' | $' + sizeUsd.toFixed(2) + ' | Entry $' + entryPriceUsd.toFixed(10) + ' | ' + tokensHeld + ' tokens held', 'entry');
          liveLog('LIVE BUY TIMING: build ' + buyBuiltMs + 'ms | submit to landed ' + buySendMs + 'ms | reads before position was watched ' + (Date.now() - postBuyT0) + 'ms | total ' + (Date.now() - buyT0) + 'ms', 'info');
        } else {
          liveLog(logPrefix + ' (' + platformName + ' buy): confirmed but real token balance reads zero -- position NOT recorded, check manually', 'warn');
        }
      } catch (posErr) {
        liveLog(logPrefix + ' (' + platformName + ' buy): could not record real position -- ' + posErr.message + ' -- check manually', 'warn');
      }

      // Fund stop loss is checked only now, after the new position is on the
      // books, so the capital it just deployed is counted (see liveDeployedUsd).
      checkLiveFundStopLoss();
    }

    return { ok: true, result: result, liveFund: S.liveFund };
  } catch (e) {
    if (e.code === 'THIN_LIQUIDITY') {
      // Nothing was sent. Not a failure of the lookups, so the remembered settings stay.
      liveLog(logPrefix + ' (' + platformName + ' buy) SKIPPED for ' + mintStr + ': ' + e.message, 'warn');
      return { ok: false, skipped: true, error: e.message };
    }
    liveLog(logPrefix + ' (' + platformName + ' buy) ERROR: ' + e.message, 'warn');
    invalidateBuilderCaches();
    return { ok: false, error: e.message };
  }
}

async function executeRealBuy(req, res, platformName, platformKey, buildBuyFn) {
  var mintStr = req.body && req.body.mint;
  if (!mintStr) {
    return res.json({ ok: false, error: 'Provide a real token mint address in the request body as "mint"' });
  }
  var outcome = await performRealBuy(mintStr, platformName, platformKey, buildBuyFn, 'LIVE TRADE TEST');
  res.json(outcome);
}

// Shared real-sell core -- used by both the manual Live Trade Test
// button and the automatic stop-loss checker below. One real
// implementation, so the two can never behave differently from each
// other. logPrefix lets each caller label its own log lines clearly
// (e.g. "LIVE TRADE TEST" vs "LIVE STOP LOSS") while sharing the same
// underlying logic.
// After a real sell is confirmed: reads what it actually did to the wallet
// (proceeds, fee and tip all included), moves the Live Fund by that, and reads
// the tip and network fee separately. Shared by a normal sell and by a sell
// that confirmed late (see resolvePendingSell), so both are recorded the same way.
async function settleConfirmedRealSell(connection, result, logPrefix, platformName) {
  var changeUsd = null;
  try {
    var changeLamports = await liveWalletModule.getRealBalanceChange(connection, result.signature, liveWalletKeypair.publicKey);
    changeUsd = (changeLamports / 1000000000) * SOL_PRICE_USD;
    S.liveFund = parseFloat((S.liveFund + changeUsd).toFixed(4));
    liveLog(logPrefix + ' (' + platformName + ' sell): real wallet impact $' + changeUsd.toFixed(4) +
      ' (' + changeLamports + ' lamports, includes proceeds, fee, and tip) -- Live Fund now $' + S.liveFund.toFixed(4), 'info');
  } catch (feeErr) {
    liveLog(logPrefix + ' (' + platformName + ' sell): could not read real balance change to update Live Fund -- ' + feeErr.message, 'warn');
  }
  var sellCosts = await readRealTxCosts(connection, result);
  liveLog(logPrefix + ' (' + platformName + ' sell): ' + describeRealCosts(sellCosts), 'info');
  return { changeUsd: changeUsd, costs: sellCosts };
}

// expectedRaw (optional) is how many tokens the bot believes this position
// holds right now. For a partial sale the amount is worked out from that, not
// from whatever the wallet shows at this moment -- so if an earlier attempt of
// the same sale actually landed without the bot hearing about it, the wallet
// already shows the reduced balance and the sale is recognised as done instead
// of being sold a second time.
async function performRealSell(mintStr, platformName, buildSellFn, logPrefix, fraction, expectedRaw) {
  if (!liveWalletKeypair) {
    return { ok: false, error: liveWalletState.configError || 'Live wallet not configured' };
  }
  try {
    var { PublicKey, Transaction } = require('@solana/web3.js');
    var execution = require('./execution');
    var connection = liveWalletModule.getConnection();
    var rpcUrl = process.env[liveWalletModule.LIVE_RPC_ENV];
    var mint = new PublicKey(mintStr);

    var sellT0 = Date.now();
    liveLog(logPrefix + ' (' + platformName + ' sell): reading real token balance...', 'info');
    var balance = await liveWalletModule.getTokenBalance(connection, mint, liveWalletKeypair.publicKey);
    var sellBalanceMs = Date.now() - sellT0;
    var diag = balance && balance.diagnostic;
    liveLog(logPrefix + ' (' + platformName + ' sell) balance check: amount=' + (balance && balance.amount) +
      (diag ? ' | tokenProgram=' + diag.tokenProgram + ' | tokenAccount=' + diag.tokenAccount + (diag.rawError ? ' | rawError=' + diag.rawError : '') : ''), 'info');
    if (!balance || balance.amount === '0') {
      return { ok: false, zeroBalance: true, error: 'Real balance for this token is zero -- nothing to sell', diagnostic: diag };
    }

    // Optional fraction (0 < fraction < 1) sells only part of the real
    // balance -- used by the tiered exits. Left empty it sells everything,
    // exactly as before.
    var sellAmount = balance.amount;
    if (fraction !== undefined && fraction !== null && fraction > 0 && fraction < 1) {
      var baseAmount = (expectedRaw && /^[0-9]+$/.test(String(expectedRaw)) && BigInt(expectedRaw) > BigInt(0)) ? BigInt(expectedRaw) : BigInt(balance.amount);
      sellAmount = (baseAmount * BigInt(Math.round(fraction * 10000)) / BigInt(10000)).toString();
      if (sellAmount === '0') {
        return { ok: false, error: 'Partial sell amount rounds to zero -- nothing sold' };
      }
      var expectedAfter = baseAmount - BigInt(sellAmount);
      if (BigInt(balance.amount) <= expectedAfter) {
        liveLog(logPrefix + ' (' + platformName + ' sell): the wallet already shows the reduced balance (' + balance.amount + ' <= ' + expectedAfter.toString() + ') -- this sale already landed earlier, NOT selling again. Its proceeds could not be matched to a transaction, so they are recorded as unknown.', 'warn');
        return { ok: true, alreadyLanded: true, result: { outcome: 'CONFIRMED', signature: '' }, soldAmount: sellAmount, remainingAmount: balance.amount, liveFund: S.liveFund, realImpactUsd: null, tipUsd: null, feeUsd: null };
      }
    }
    var remainingAmount = (BigInt(balance.amount) - BigInt(sellAmount)).toString();

    liveLog(logPrefix + ' (' + platformName + ' sell): building sell for ' + sellAmount + ' of real balance ' + balance.amount + '...', 'info');
    var sellBuildT0 = Date.now();
    var instructions = await buildSellFn(connection, mint, liveWalletKeypair.publicKey, sellAmount, 15);
    var sellBuildMs = Date.now() - sellBuildT0;

    var tx = new Transaction();
    instructions.forEach(function(ix) { tx.add(ix); });

    liveLog(logPrefix + ' (' + platformName + ' sell): submitting real transaction...', 'info');
    var sellSendT0 = Date.now();
    var result = await execution.sendAndConfirmViaSender(tx, liveWalletKeypair, connection, rpcUrl, { tier: 'SWQOS_ONLY', onDiagnostic: function(summary) { liveLog(logPrefix + ' (' + platformName + '): ' + summary, 'info'); } });
    liveLog('LIVE SELL TIMING: balance read ' + sellBalanceMs + 'ms | build ' + sellBuildMs + 'ms | submit to ' + result.outcome.toLowerCase() + ' ' + (Date.now() - sellSendT0) + 'ms | total ' + (Date.now() - sellT0) + 'ms', 'info');

    liveLog(logPrefix + ' (' + platformName + ' sell) result: ' + result.outcome + ' | signature: ' + result.signature +
      (result.error ? ' | error: ' + result.error : ''), result.outcome === 'CONFIRMED' ? 'win' : 'warn');
    if (result.outcome !== 'CONFIRMED') invalidateBuilderCaches();

    var settled = null;
    if (result.outcome === 'CONFIRMED') {
      settled = await settleConfirmedRealSell(connection, result, logPrefix, platformName);
    }

    return { ok: true, result: result, soldAmount: sellAmount, remainingAmount: remainingAmount, liveFund: S.liveFund, realImpactUsd: settled ? settled.changeUsd : null, tipUsd: settled ? settled.costs.tipUsd : null, feeUsd: settled ? settled.costs.feeUsd : null };
  } catch (e) {
    liveLog(logPrefix + ' (' + platformName + ' sell) ERROR: ' + e.message, 'warn');
    invalidateBuilderCaches();
    return { ok: false, error: e.message };
  }
}

async function executeRealSell(req, res, platformName, buildSellFn) {
  var mintStr = req.body && req.body.mint;
  if (!mintStr) {
    return res.json({ ok: false, error: 'Provide the real token mint address you bought, in the request body as "mint"' });
  }
  // If the bot is tracking an open real position in this token, sell it through
  // the normal manual-sell path so it is recorded and removed from the open
  // list. Anything the bot is not tracking is sold directly, as before.
  var tracked = S.liveOpen.find(function(p) { return p.mint === mintStr; });
  if (tracked) {
    if (tracked.busy) return res.json({ ok: false, error: 'A real sell is already in progress for this position -- try again in a moment' });
    var out = await manualSellLivePosition(tracked);
    checkLiveFundStopLoss();
    if (!out.closed) return res.json({ ok: false, error: 'The real sell did not confirm -- the position is still open, check the Live Activity Log' });
    var rec = S.liveClosed[S.liveClosed.length - 1];
    return res.json({ ok: true, result: { outcome: 'CONFIRMED', signature: (rec && rec.sellSignature) || '' }, soldAmount: out.soldAmount });
  }
  var outcome = await performRealSell(mintStr, platformName, buildSellFn, 'LIVE TRADE TEST');
  checkLiveFundStopLoss();
  res.json(outcome);
}

// Per-tick live exit check. Called from handleSwap for every incoming
// Bitquery trade, so a real position is checked the instant its token
// trades -- the same moment, and the same feed, paper trades use. Same
// rules and same order as paper: fixed TP, tier 1 (+100%, sell 50%),
// tier 2 (+500%, sell half of what's left), trail (activates at
// CFG.TRAIL_ACT, exits on CFG.TRAIL_PB pullback), then stop loss.
// The check itself is synchronous and cheap; the real sell runs in the
// background so the feed is never held up. pos.busy stops two sells
// ever running on the same position at once.
function handleLiveTick(mint, priceUsd) {
  if (!S.liveOpen || S.liveOpen.length === 0) return;
  for (var i = 0; i < S.liveOpen.length; i++) {
    var pos = S.liveOpen[i];
    if (pos.mint !== mint) continue;
    if (!pos.entryPriceUsd || pos.entryPriceUsd <= 0) continue;

    // Same guard paper has: a single-tick crash of more than 90% is
    // treated as a bad tick, not a real price.
    if (pos.currentPriceUsd && pos.currentPriceUsd > 0) {
      var drop = (pos.currentPriceUsd - priceUsd) / pos.currentPriceUsd;
      if (drop > 0.90) {
        liveLog('LIVE PRICE SANITY REJECT ' + mint.slice(0, 8) + '... | ' + (drop * 100).toFixed(0) + '% single-tick crash', 'warn');
        continue;
      }
    }

    pos.currentPriceUsd = priceUsd;
    if (priceUsd > (pos.peakPriceUsd || 0)) pos.peakPriceUsd = priceUsd;
    // Same movement clock paper uses for its stale check: a tick only counts
    // as movement if the price changed by more than 0.1%.
    if (!pos.lastPriceUsd || Math.abs(priceUsd - pos.lastPriceUsd) / pos.lastPriceUsd > 0.001) {
      pos.lastPriceChange = Date.now();
      pos.lastPriceUsd = priceUsd;
    }

    if (pos.busy || pos.stuck || Date.now() < (pos.retryAfter || 0)) continue;

    var pct = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
    var action = null;

    if (pos.tpl === 'FIXED' && pct >= (pos.tpPct / 100)) {
      action = { kind: 'FIXED', fraction: null };
    } else if (pos.tpl === 'TIERED' && !pos.tier1Done && pct >= 1.0) {
      action = { kind: 'TIER1', fraction: 0.5 };
    } else if (pos.tpl === 'TIERED' && pos.tier1Done && !pos.tier2Done && pct >= 5.0) {
      action = { kind: 'TIER2', fraction: 0.5 };
    } else if ((pos.tpl === 'TRAIL' || pos.tpl === 'TIERED') && pos.peakPriceUsd) {
      var peakGain = (pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
      if (peakGain >= CFG.TRAIL_ACT) {
        var pullback = (pos.peakPriceUsd - priceUsd) / pos.peakPriceUsd;
        if (pullback >= CFG.TRAIL_PB) {
          action = { kind: 'TRAIL', fraction: null, peakGain: peakGain, pullback: pullback };
        }
      }
    }
    if (!action && pct <= -(S.liveStopLossPct / 100)) {
      action = { kind: 'SL', fraction: null };
    }

    if (action) {
      runLiveExit(pos, action, priceUsd, pct).catch(function(e) {
        liveLog('LIVE EXIT error: ' + e.message, 'warn');
      });
    }
  }
}

// Live's own version of paper's stale exit (paper: no price movement for
// CFG.STALE_TIME on a trade older than 30s). It matters even more for real
// money: a token whose price falls below the market-cap floor stops sending
// ticks altogether, so no stop loss could ever fire on it. Checked every
// second, locally -- no network call -- and sells for real through the same
// exit path as every other exit.
function checkLiveStale() {
  if (!S.liveOpen || S.liveOpen.length === 0) return;
  var now = Date.now();
  S.liveOpen.slice().forEach(function(pos) {
    if (pos.busy || pos.stuck || now < (pos.retryAfter || 0)) return;
    var lastMove = pos.lastPriceChange || pos.openedAt;
    if ((now - lastMove) > CFG.STALE_TIME && (now - pos.openedAt) > 30000) {
      var price = (pos.currentPriceUsd && pos.currentPriceUsd > 0) ? pos.currentPriceUsd : pos.entryPriceUsd;
      var pct = (price - pos.entryPriceUsd) / pos.entryPriceUsd;
      runLiveExit(pos, { kind: 'STALE', fraction: null, staleSecs: Math.round((now - lastMove) / 1000) }, price, pct).catch(function(e) {
        liveLog('LIVE STALE EXIT error: ' + e.message, 'warn');
      });
    }
  });
}
setInterval(checkLiveStale, 1000);

// The shared data feed has to stay up for as long as anything needs it:
// paper running, automatic live trading on, or a real position still open
// (its exits depend on the same price feed).
function feedNeeded() {
  return S.running || S.liveTradingEnabled || (S.liveOpen && S.liveOpen.length > 0);
}

// Records one failed real sell on a position and decides how soon to try
// again. Retries stay fast (1.5s) for the first 10 failures, then slow to
// every 10s; at 30 in a row the position is flagged STUCK and automatic
// attempts stop (the SELL button still works). A zero real balance is retried
// more slowly (5s) since it is counted separately, see closeLiveOutsideBot.
function noteLiveSellFailure(pos, zeroBalance) {
  pos.sellFails = (pos.sellFails || 0) + 1;
  pos.zeroFails = zeroBalance ? (pos.zeroFails || 0) + 1 : 0;
  if (zeroBalance) pos.retryAfter = Date.now() + 5000;
  else pos.retryAfter = Date.now() + (pos.sellFails <= 10 ? 1500 : 10000);
  if (!pos.stuck && pos.sellFails >= 30) {
    pos.stuck = true;
    liveLog('LIVE STUCK POSITION ' + (pos.name || pos.mint) + ' | ' + pos.mint + ' -- ' + pos.sellFails + ' real sell attempts in a row have failed. Automatic selling has STOPPED for this position so it is not retried forever. It needs your attention: use its SELL button to try again, or check the token in your wallet.', 'warn');
  }
}

// A position whose real token balance has read as zero three times in a row
// (5 seconds apart) holds nothing to sell -- the tokens left the wallet some
// way the bot did not record. It is removed so it stops using up a Max Open
// slot and stops counting as money still deployed. Its real result cannot be
// known, so it is recorded with a blank P&L and left out of the win/loss
// counts, never guessed.
function closeLiveOutsideBot(pos, priceUsd, prefix) {
  var idx = S.liveOpen.indexOf(pos);
  if (idx !== -1) S.liveOpen.splice(idx, 1);
  S.liveClosed.push({
    name: pos.name || '', mint: pos.mint, platform: pos.platform,
    size: pos.sizeUsd, entryPrice: pos.entryPriceUsd, exitPrice: priceUsd,
    pnl: null, pnlPct: null,
    peakGainPct: (pos.peakPriceUsd && pos.entryPriceUsd) ? parseFloat(((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100).toFixed(2)) : null,
    closeReason: 'Closed outside bot',
    openedAt: new Date(pos.openedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }),
    closedAt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    closedDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    holdTimeSec: Math.round((Date.now() - pos.openedAt) / 1000),
    takeProfitMode: pos.tpl, stopLossPct: S.liveStopLossPct,
    buyImpactUsd: pos.buyImpactUsd, totalSellProceedsUsd: null,
    tieredSold: !!pos.tier1Done, tieredSold2: !!pos.tier2Done,
    buyTipUsd: pos.buyTipUsd, sellTipUsd: null, totalTipUsd: null,
    buyFeeUsd: pos.buyFeeUsd, sellFeeUsd: null, totalFeeUsd: null,
    fundAfterTrade: S.liveFund, buySignature: pos.id, sellSignature: '',
    savingsAmount: null, fundAmount: null
  });
  liveCooldowns.set(pos.mint, Date.now());
  liveLog(prefix + ': real balance for ' + pos.mint + ' read as zero ' + pos.zeroFails + ' times in a row -- nothing left to sell. Position removed from tracking and recorded as "Closed outside bot" with an unknown P&L (not counted as a win or a loss).', 'warn');
  if (!feedNeeded()) stopFeed();
}

// An earlier sell for this position was submitted but its outcome was never
// learned (the bot stopped checking before it confirmed or expired). Before
// ANY new sell, that exact transaction is looked up:
//   landed OK        -> recorded as done, no second sale (CONFIRMED)
//   landed, rejected -> dead, safe to try again (CLEARED)
//   expired unseen   -> can never land now, safe to try again (CLEARED)
//   still possible   -> do nothing yet (WAIT)
// If the lookup keeps failing for 5 minutes it stops waiting; the real wallet
// balance check in performRealSell is still there to prevent a double sale.
async function resolvePendingSell(pos, platformName) {
  var ps = pos.pendingSell;
  var prefix = 'LIVE PENDING SELL CHECK';
  try {
    var connection = liveWalletModule.getConnection();
    var sig = ps.result.signature;
    var readStatus = async function() {
      var st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
      return st && st.value && st.value[0];
    };
    var st1 = await readStatus();
    if (!st1) {
      var height = await connection.getBlockHeight();
      var deadline = ps.result.lastValidBlockHeight;
      var expired = deadline ? height > deadline : (Date.now() - ps.at) > 90000;
      if (!expired) {
        if (Date.now() - ps.at > 300000) {
          liveLog(prefix + ': ' + sig + ' still unresolved after 5 minutes -- no longer waiting on it; the real balance check will prevent a double sale', 'warn');
          return { state: 'CLEARED' };
        }
        return { state: 'WAIT' };
      }
      st1 = await readStatus();   // an expired window alone does not prove it never landed
    }
    if (st1 && !st1.err && (st1.confirmationStatus === 'confirmed' || st1.confirmationStatus === 'finalized')) {
      liveLog(prefix + ': the earlier sell ' + sig + ' has CONFIRMED -- recording it now, NOT selling again', 'win');
      var settled = await settleConfirmedRealSell(connection, ps.result, prefix, platformName);
      return { state: 'CONFIRMED', outcome: { ok: true, result: { outcome: 'CONFIRMED', signature: sig, tipLamports: ps.result.tipLamports }, soldAmount: ps.soldAmount, remainingAmount: ps.remainingAmount, realImpactUsd: settled.changeUsd, tipUsd: settled.costs.tipUsd, feeUsd: settled.costs.feeUsd } };
    }
    if (st1 && st1.err) {
      liveLog(prefix + ': the earlier sell ' + sig + ' landed but was rejected on-chain -- nothing was sold, safe to try again', 'warn');
      return { state: 'CLEARED' };
    }
    if (!st1) {
      liveLog(prefix + ': the earlier sell ' + sig + ' expired without ever landing -- safe to try again', 'warn');
      return { state: 'CLEARED' };
    }
    return { state: 'WAIT' };
  } catch (e) {
    if (Date.now() - ps.at > 300000) {
      liveLog(prefix + ': could not check ' + ps.result.signature + ' for 5 minutes (' + e.message + ') -- no longer waiting on it; the real balance check will prevent a double sale', 'warn');
      return { state: 'CLEARED' };
    }
    liveLog(prefix + ': could not check the earlier sell yet (' + e.message + ') -- waiting', 'warn');
    return { state: 'WAIT' };
  }
}

async function runLiveExit(pos, action, priceUsd, pct) {
  pos.busy = true;
  try {
    var pumpfun = require('./pumpfun');
    var letsbonk = require('./letsbonk');
    var platformName = pos.platform === 'pumpfun' ? 'pump.fun' : 'LetsBonk';
    var buildSellFn = pos.platform === 'pumpfun' ? pumpfun.buildSellInstructions : letsbonk.buildSellInstructions;

    // Settle any earlier unresolved sell first. If it turns out it did land,
    // THAT sale is what gets recorded below (with its own action and price),
    // and nothing new is sold on this pass.
    var outcome = null;
    if (pos.pendingSell) {
      var oldPending = pos.pendingSell;
      var pend = await resolvePendingSell(pos, platformName);
      if (pend.state === 'WAIT') { pos.retryAfter = Date.now() + 1000; return; }
      pos.pendingSell = null;
      if (pend.state === 'CONFIRMED') {
        action = oldPending.action; priceUsd = oldPending.priceUsd; pct = oldPending.pct;
        outcome = pend.outcome;
      } else {
        noteLiveSellFailure(pos, false);
      }
    }

    var prefix, kindText, logType;
    if (action.kind === 'SL') { prefix = 'LIVE STOP LOSS'; kindText = 'STOP LOSS HIT'; logType = 'loss'; }
    else if (action.kind === 'TRAIL') { prefix = 'LIVE TRAIL EXIT'; kindText = 'TRAIL EXIT | Peak +' + (action.peakGain * 100).toFixed(1) + '% | Pullback -' + (action.pullback * 100).toFixed(1) + '%'; logType = 'win'; }
    else if (action.kind === 'FIXED') { prefix = 'LIVE TAKE PROFIT'; kindText = 'TP HIT'; logType = 'win'; }
    else if (action.kind === 'TIER1') { prefix = 'LIVE TIER 1'; kindText = 'TIER 1 (+100%) -- selling 50% of the position'; logType = 'win'; }
    else if (action.kind === 'MANUAL') { prefix = 'LIVE MANUAL SELL'; kindText = 'MANUAL SELL requested'; logType = 'info'; }
    else if (action.kind === 'STALE') { prefix = 'LIVE STALE EXIT'; kindText = 'TOKEN WENT STALE -- no price movement for ' + action.staleSecs + 's'; logType = 'loss'; }
    else { prefix = 'LIVE TIER 2'; kindText = 'TIER 2 (+500%) -- selling half of what is left'; logType = 'win'; }

    liveLog(prefix + ': ' + kindText + ' | ' + pos.mint + ' | entry $' + pos.entryPriceUsd.toFixed(10) + ' -> $' + priceUsd.toFixed(10) + ' (' + (pct * 100).toFixed(1) + '%) -- selling for real', logType);

    if (!outcome) outcome = await performRealSell(pos.mint, platformName, buildSellFn, prefix, action.fraction, pos.tokenAmountRaw);
    var confirmed = !!(outcome.ok && outcome.result && outcome.result.outcome === 'CONFIRMED');
    var nowEst = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    // Real wallet change from this sale, added to the position's running total.
    if (confirmed) {
      pos.sellFails = 0; pos.zeroFails = 0; pos.stuck = false;
      if (typeof outcome.realImpactUsd === 'number') pos.sellImpactUsd = (pos.sellImpactUsd || 0) + outcome.realImpactUsd;
      else pos.sellImpactKnown = false;
      if (typeof outcome.tipUsd === 'number') pos.sellTipUsd = (pos.sellTipUsd || 0) + outcome.tipUsd;
      else pos.tipKnown = false;
      if (typeof outcome.feeUsd === 'number') pos.sellFeeUsd = (pos.sellFeeUsd || 0) + outcome.feeUsd;
      else pos.feeKnown = false;
    }

    if (confirmed && action.fraction) {
      pos.tokenAmountRaw = outcome.remainingAmount;
      if (action.kind === 'TIER1') {
        pos.tier1Done = true; pos.tier1ExitPrice = priceUsd; pos.tier1ClosedAt = nowEst;
        pos.tier1ProceedsUsd = (typeof outcome.realImpactUsd === 'number') ? outcome.realImpactUsd : null;
        pos.tier1RealizedPct = parseFloat((pct * 100).toFixed(2));
      } else {
        pos.tier2Done = true; pos.tier2ExitPrice = priceUsd; pos.tier2ClosedAt = nowEst;
        pos.tier2ProceedsUsd = (typeof outcome.realImpactUsd === 'number') ? outcome.realImpactUsd : null;
        pos.tier2RealizedPct = parseFloat((pct * 100).toFixed(2));
      }
      liveLog(prefix + ': partial sell confirmed -- position stays open, remaining raw amount ' + pos.tokenAmountRaw + ' -- ' + pos.mint, 'win');
    } else if (confirmed) {
      var idx = S.liveOpen.indexOf(pos);
      if (idx !== -1) S.liveOpen.splice(idx, 1);

      // Closed-trade record for the Live CSV. PnL is the REAL wallet result:
      // what the buy cost plus everything every sale brought back, including
      // fees and tips -- blank if any of those real numbers could not be read.
      var realKnown = pos.buyImpactUsd !== null && pos.buyImpactUsd !== undefined && pos.sellImpactKnown !== false;
      var realPnl = realKnown ? parseFloat((pos.buyImpactUsd + pos.sellImpactUsd).toFixed(4)) : null;
      var closeReason = action.kind === 'SL' ? 'Stop loss hit' : action.kind === 'TRAIL' ? 'Trail exit' : action.kind === 'MANUAL' ? 'Manual close' : action.kind === 'STALE' ? 'Token went stale' : 'Take profit hit';
      S.liveClosed.push({
        name: pos.name || '', mint: pos.mint, platform: pos.platform,
        size: pos.sizeUsd, entryPrice: pos.entryPriceUsd, exitPrice: priceUsd,
        pnl: realPnl,
        pnlPct: (realPnl !== null && pos.sizeUsd > 0) ? parseFloat((realPnl / pos.sizeUsd * 100).toFixed(2)) : null,
        peakGainPct: (pos.peakPriceUsd && pos.entryPriceUsd) ? parseFloat(((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100).toFixed(2)) : null,
        closeReason: closeReason,
        openedAt: new Date(pos.openedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }),
        closedAt: nowEst,
        closedDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        holdTimeSec: Math.round((Date.now() - pos.openedAt) / 1000),
        takeProfitMode: pos.tpl, stopLossPct: S.liveStopLossPct,
        buyImpactUsd: pos.buyImpactUsd, totalSellProceedsUsd: realKnown ? parseFloat(pos.sellImpactUsd.toFixed(4)) : null,
        tieredSold: !!pos.tier1Done, tier1ExitPrice: pos.tier1Done ? pos.tier1ExitPrice : null,
        tier1RealizedPct: pos.tier1Done ? pos.tier1RealizedPct : null, tier1ProceedsUsd: pos.tier1Done ? pos.tier1ProceedsUsd : null,
        tier1ClosedAt: pos.tier1Done ? pos.tier1ClosedAt : '',
        tieredSold2: !!pos.tier2Done, tier2ExitPrice: pos.tier2Done ? pos.tier2ExitPrice : null,
        tier2RealizedPct: pos.tier2Done ? pos.tier2RealizedPct : null, tier2ProceedsUsd: pos.tier2Done ? pos.tier2ProceedsUsd : null,
        tier2ClosedAt: pos.tier2Done ? pos.tier2ClosedAt : '',
        buyTipUsd: pos.buyTipUsd, sellTipUsd: pos.tipKnown !== false ? parseFloat((pos.sellTipUsd || 0).toFixed(6)) : null,
        totalTipUsd: (pos.tipKnown !== false && pos.buyTipUsd !== null && pos.buyTipUsd !== undefined) ? parseFloat((pos.buyTipUsd + (pos.sellTipUsd || 0)).toFixed(6)) : null,
        buyFeeUsd: pos.buyFeeUsd, sellFeeUsd: pos.feeKnown !== false ? parseFloat((pos.sellFeeUsd || 0).toFixed(6)) : null,
        totalFeeUsd: (pos.feeKnown !== false && pos.buyFeeUsd !== null && pos.buyFeeUsd !== undefined) ? parseFloat((pos.buyFeeUsd + (pos.sellFeeUsd || 0)).toFixed(6)) : null,
        fundAfterTrade: S.liveFund,
        buySignature: pos.id, sellSignature: outcome.result.signature || ''
      });
      var closedRec = S.liveClosed[S.liveClosed.length - 1];

      // Win/loss counters, same rule as paper: the trade's overall result above
      // zero is a win, otherwise a loss. A trade whose real result could not be
      // read is left out of both rather than guessed.
      // A rug: the trade closed with the price at half its entry or worse.
      if (pos.entryPriceUsd > 0 && priceUsd > 0 && priceUsd / pos.entryPriceUsd <= 0.5) S.liveStats.r++;
      if (realPnl !== null) {
        if (realPnl > 0) S.liveStats.w++; else S.liveStats.l++;
        S.liveStats.t++;
      } else {
        liveLog(prefix + ': real result for this trade could not be read -- not counted as a win or a loss', 'warn');
      }

      // Savings split, same rule as paper: a win bigger than MIN_SPLIT_WIN sends
      // SAVINGS_PCT of its profit to savings and leaves the rest in the fund.
      // The real SOL is sent to the savings wallet automatically once $20 has
      // built up (see maybeSendSavings).
      // Done once per trade on its overall real result.
      if (realPnl !== null) {
        S.liveRealizedPnl = parseFloat((S.liveRealizedPnl + realPnl).toFixed(4));
        var liveSavingsAmt = 0;
        if (realPnl > CFG.MIN_SPLIT_WIN) {
          liveSavingsAmt = parseFloat((realPnl * CFG.SAVINGS_PCT).toFixed(4));
          S.liveFund = parseFloat((S.liveFund - liveSavingsAmt).toFixed(4));
          S.liveSavings = parseFloat((S.liveSavings + liveSavingsAmt).toFixed(4));
          S.livePendingSavings = parseFloat((S.livePendingSavings + liveSavingsAmt).toFixed(4));
          liveLog(prefix + ': +$' + realPnl.toFixed(4) + ' -- $' + liveSavingsAmt.toFixed(4) + ' to Savings, $' + (realPnl - liveSavingsAmt).toFixed(4) + ' stays in the Live Fund | $' + S.livePendingSavings.toFixed(2) + ' waiting to be sent (sent automatically at $' + SAVINGS_SEND_THRESHOLD_USD + ')', 'win');
          maybeSendSavings().catch(function() {});
        }
        closedRec.savingsAmount = liveSavingsAmt;
        closedRec.fundAmount = parseFloat((realPnl - liveSavingsAmt).toFixed(4));
      } else {
        closedRec.savingsAmount = null;
        closedRec.fundAmount = null;
      }
      closedRec.fundAfterTrade = S.liveFund;

      // Live portfolio history: all-time totals, best/worst trade and the
      // current session, same rules as paper's portfolio (a win is above $0,
      // anything else is a loss). Results that could not be read are left out.
      var liveTradeFees = (closedRec.totalTipUsd !== null && closedRec.totalFeeUsd !== null) ? closedRec.totalTipUsd + closedRec.totalFeeUsd : null;
      if (liveTradeFees !== null) {
        S.liveAllTime.totalFees = parseFloat((S.liveAllTime.totalFees + liveTradeFees).toFixed(6));
        if (S.liveSession) S.liveSession.fees = parseFloat((S.liveSession.fees + liveTradeFees).toFixed(6));
      }
      if (realPnl !== null) {
        S.liveAllTime.t++;
        S.liveAllTime.totalPnl = parseFloat((S.liveAllTime.totalPnl + realPnl).toFixed(4));
        if (realPnl > 0) S.liveAllTime.w++; else S.liveAllTime.l++;
        if (realPnl > S.liveAllTime.bestPnl) S.liveAllTime.bestPnl = realPnl;
        if (realPnl < S.liveAllTime.worstPnl) S.liveAllTime.worstPnl = realPnl;
        var livePortTrade = { name: closedRec.name || '?', entryPrice: closedRec.entryPrice, exitPrice: closedRec.exitPrice, size: closedRec.size, pnl: realPnl, pnlPct: closedRec.pnlPct, closeReason: closedRec.closeReason };
        if (!S.liveBestTrade || realPnl > S.liveBestTrade.pnl) S.liveBestTrade = livePortTrade;
        if (!S.liveWorstTrade || realPnl < S.liveWorstTrade.pnl) S.liveWorstTrade = livePortTrade;
        if (S.liveSession) {
          S.liveSession.t++;
          if (realPnl > 0) S.liveSession.w++; else S.liveSession.l++;
        }
      }

      // Live's own cooldown, same lengths as paper (30 min after a loss, 5 min
      // after a win), kept separate so paper trades never block live entries.
      // A result that could not be read is treated like a loss, the safe side.
      liveCooldowns.set(pos.mint, (realPnl !== null && realPnl > 0) ? Date.now() - (CFG.COOLDOWN_MS - CFG.WIN_COOLDOWN_MS) : Date.now());
      liveLog(prefix + ': position closed for real, removed from tracking -- ' + pos.mint, 'win');
    } else if (outcome.ok && outcome.result && outcome.result.outcome === 'PENDING') {
      // Submitted but not yet known to have landed or expired. Remember the
      // exact transaction so the next attempt checks it BEFORE selling anything.
      pos.pendingSell = { result: outcome.result, soldAmount: outcome.soldAmount, remainingAmount: outcome.remainingAmount, action: action, priceUsd: priceUsd, pct: pct, at: Date.now() };
      pos.retryAfter = Date.now() + 1000;
      liveLog(prefix + ': the sell was submitted but has not confirmed yet (' + outcome.result.signature + ') -- the bot will check that exact transaction before any retry and will NOT sell this twice', 'warn');
    } else {
      noteLiveSellFailure(pos, outcome.zeroBalance === true);
      liveLog(prefix + ': real sell did not confirm (' + (outcome.error || (outcome.result && outcome.result.outcome)) + ') -- position kept, attempt ' + pos.sellFails + (pos.stuck ? ', now flagged STUCK' : ', will retry'), 'warn');
      if (pos.zeroFails >= 3) closeLiveOutsideBot(pos, priceUsd, prefix);
    }

    if (confirmed) {
      liveAutoLockCheck();
      checkLiveFundStopLoss();
      if (S.liveOpen.indexOf(pos) === -1 && !feedNeeded()) stopFeed();
    }
  } catch (e) {
    noteLiveSellFailure(pos, false);
    liveLog('LIVE EXIT error for ' + pos.mint + ': ' + e.message + ' -- position kept, attempt ' + pos.sellFails + (pos.stuck ? ', now flagged STUCK' : ', will retry'), 'warn');
  } finally {
    pos.busy = false;
  }
}

// Live CSV: real closed trades only, built from S.liveClosed. PnL is the
// real wallet result (buy cost + sale proceeds, including fees and tips).
app.get('/api/live/export', function(req, res) {
  var cols = ['Name','Mint','Platform','Size','EntryPrice','ExitPrice','PnL','PnLPct','PeakGainPct','CloseReason','OpenedAt','ClosedAt','ClosedDate','HoldTimeSec','TakeProfitMode','StopLossPct','BuyImpactUsd','TotalSellProceedsUsd','BuyTipUsd','SellTipUsd','TotalTipUsd','BuyNetworkFeeUsd','SellNetworkFeeUsd','TotalNetworkFeeUsd','TieredSold','Tier1ExitPrice','Tier1RealizedPct','Tier1ProceedsUsd','Tier1ClosedAt','TieredSold2','Tier2ExitPrice','Tier2RealizedPct','Tier2ProceedsUsd','Tier2ClosedAt','FundAmount','SavingsAmount','FundAfterTrade','BuySignature','SellSignature'];
  var rows = [cols.join(',')];
  S.liveClosed.forEach(function(t) {
    rows.push([
      csvSafe(t.name), t.mint || '', t.platform || '', t.size, t.entryPrice, t.exitPrice,
      t.pnl, t.pnlPct, t.peakGainPct, csvSafe(t.closeReason), csvSafe(t.openedAt), csvSafe(t.closedAt), t.closedDate || '',
      t.holdTimeSec, t.takeProfitMode || '', t.stopLossPct, t.buyImpactUsd, t.totalSellProceedsUsd,
      t.buyTipUsd, t.sellTipUsd, t.totalTipUsd, t.buyFeeUsd, t.sellFeeUsd, t.totalFeeUsd,
      t.tieredSold ? 'Yes' : 'No', t.tier1ExitPrice, t.tier1RealizedPct, t.tier1ProceedsUsd, csvSafe(t.tier1ClosedAt || ''),
      t.tieredSold2 ? 'Yes' : 'No', t.tier2ExitPrice, t.tier2RealizedPct, t.tier2ProceedsUsd, csvSafe(t.tier2ClosedAt || ''),
      t.fundAmount, t.savingsAmount, t.fundAfterTrade, t.buySignature || '', t.sellSignature || ''
    ].map(function(v) { return (v === null || v === undefined) ? '' : v; }).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bunkerbuster_live_trades_' + Date.now() + '.csv"');
  res.send(rows.join('\n'));
});

// On-demand real price refresh -- triggers an immediate, genuine fetch
// rather than waiting on the passive background cycle. Used when the
// Live tab opens, so the number shown is actually current at that
// moment, not whatever the last background check happened to find.
// Live version of paper's "raise stop loss to current fund" -- same effect:
// the fund loss line is now measured from the current live fund.
app.post('/api/live/lock-fund', function(req, res) {
  var oldBase = S.liveDayStartFund;
  var eff = liveEffectiveFund();
  S.liveDayStartFund = eff;
  S.liveSessionHighFund = Math.max(S.liveSessionHighFund, eff);
  S.liveWindingDown = false;
  var newTrigger = eff * (1 - S.liveFundStopLossPct / 100);
  liveLog('Live fund stop loss locked to current balance - new base $' + eff.toFixed(2) + ' (was $' + oldBase.toFixed(2) + ') | triggers below $' + newTrigger.toFixed(2), 'info');
  res.json({ success: true, newBase: eff, triggerAt: parseFloat(newTrigger.toFixed(2)) });
});

// Manual sell for a real open position -- same job paper's /api/sell/:id does,
// but for real money. Uses the exact same real-sell path as the automatic
// exits (so the same busy lock, fund update, tip/fee tracking, and CSV record),
// just with the reason "Manual close". Sells the full real balance.
// One manual-sell routine for a tracked real position, shared by the Open
// Positions SELL button and the Live Trade Test panel's sell buttons, so a
// manual sale always goes through the same recording path as an automatic one
// (closed-trades list, history, fund, savings) and always removes the position.
async function manualSellLivePosition(pos) {
  var price = pos.currentPriceUsd;
  if (!price || price <= 0) {
    var fetched = await getRealTokenPriceUsd(pos.mint);
    price = (fetched && fetched > 0) ? fetched : pos.entryPriceUsd;
  }
  var pct = (price - pos.entryPriceUsd) / pos.entryPriceUsd;
  var rawBefore = pos.tokenAmountRaw;
  await runLiveExit(pos, { kind: 'MANUAL', fraction: null }, price, pct);
  return { closed: S.liveOpen.indexOf(pos) === -1, soldAmount: rawBefore };
}

app.post('/api/live/sell/:id', async function(req, res) {
  var pos = S.liveOpen.find(function(p) { return p.id === req.params.id; });
  if (!pos) return res.json({ ok: false, error: 'No such real open position -- it may already be closed' });
  if (pos.busy) return res.json({ ok: false, error: 'A real sell is already in progress for this position -- try again in a moment' });
  var out = await manualSellLivePosition(pos);
  res.json({ ok: out.closed, closed: out.closed, error: out.closed ? undefined : 'The real sell did not confirm -- the position is still open, check the Live Activity Log' });
});

app.post('/api/live/refresh-price', async function(req, res) {
  await updateSolPrice();
  res.json({ ok: true, solPriceUsd: SOL_PRICE_USD, solPriceFresh: isSolPriceFresh() });
});

app.post('/api/live/buy-pumpfun-real', async function(req, res) {
  var pumpfun = require('./pumpfun');
  await executeRealBuy(req, res, 'pump.fun', 'pumpfun', pumpfun.buildBuyInstructions);
});

app.post('/api/live/buy-letsbonk-real', async function(req, res) {
  var letsbonk = require('./letsbonk');
  await executeRealBuy(req, res, 'LetsBonk', 'letsbonk', letsbonk.buildBuyInstructions);
});

app.post('/api/live/sell-pumpfun-real', async function(req, res) {
  var pumpfun = require('./pumpfun');
  await executeRealSell(req, res, 'pump.fun', pumpfun.buildSellInstructions);
});

app.post('/api/live/sell-letsbonk-real', async function(req, res) {
  var letsbonk = require('./letsbonk');
  await executeRealSell(req, res, 'LetsBonk', letsbonk.buildSellInstructions);
});

app.post('/api/settings', function(req, res) {
  if (req.body.sessionFund !== undefined) {
    var sf = parseFloat(req.body.sessionFund);
    if (!isNaN(sf) && sf > 0) { S.sessionFund = parseFloat(sf.toFixed(2)); log('Session fund: $' + S.sessionFund, 'info'); }
  }
  if (req.body.liveFund !== undefined) {
    var lf = parseFloat(req.body.liveFund);
    if (!isNaN(lf) && lf >= 0) {
      S.liveFund = parseFloat(lf.toFixed(4));
      S.liveDayStartFund = S.liveFund;
      S.liveStartFund = S.liveFund;
      S.liveSessionHighFund = S.liveFund;
      S.liveSavings = 0;
      S.liveRealizedPnl = 0;
      S.liveWindingDown = false;
      liveLog('LIVE TRADING FUND set to $' + S.liveFund, 'info');
    }
  }
  if (req.body.liveTradingEnabled !== undefined) {
    S.liveTradingEnabled = req.body.liveTradingEnabled === true || req.body.liveTradingEnabled === 'true';
    if (S.liveTradingEnabled) {
      S.liveDayStartFund = liveEffectiveFund();
      S.liveSessionHighFund = liveEffectiveFund();
      S.liveWindingDown = false;
      S.liveSession = { startTime: Date.now(), startFund: liveEffectiveFund(), startSavings: S.liveSavings, t: 0, w: 0, l: 0, fees: 0, recorded: false };
    } else {
      endLiveSession();
      // Same as paper's stopBot: auto fund protection turns off when a session ends.
      S.liveAutoLockEnabled = false;
    }
    // Live runs on its own: turning it on starts the shared feed even if paper
    // is stopped, and turning it off shuts the feed down only if paper is off too.
    if (S.liveTradingEnabled) { startFeed(); warmLiveExecution(); } else if (!feedNeeded()) stopFeed();
    liveLog('AUTOMATIC LIVE TRADING: ' + (S.liveTradingEnabled ? 'ON -- the bot will now buy for real on qualifying entries' : 'OFF'), S.liveTradingEnabled ? 'win' : 'info');
  }
  if (req.body.liveAutoLockEnabled !== undefined) {
    S.liveAutoLockEnabled = req.body.liveAutoLockEnabled === true || req.body.liveAutoLockEnabled === 'true';
    liveLog('LIVE AUTO FUND PROTECTION: ' + (S.liveAutoLockEnabled ? 'ON' : 'OFF'), 'info');
  }
  if (req.body.liveMaxOpen !== undefined) {
    var lmo = parseInt(req.body.liveMaxOpen);
    if (!isNaN(lmo) && lmo >= 1 && lmo <= 20) { S.liveMaxOpen = lmo; liveLog('LIVE MAX OPEN TRADES: ' + S.liveMaxOpen, 'info'); }
  }
  if (req.body.liveFundStopLossPct !== undefined) {
    var lfsl = parseFloat(req.body.liveFundStopLossPct);
    if (!isNaN(lfsl) && lfsl > 0 && lfsl <= 100) { S.liveFundStopLossPct = parseFloat(lfsl.toFixed(1)); liveLog('LIVE FUND STOP LOSS: ' + S.liveFundStopLossPct + '%', 'info'); }
  }
  if (req.body.liveStopLossPct !== undefined) {
    var lsl = parseFloat(req.body.liveStopLossPct);
    if (!isNaN(lsl) && lsl > 0 && lsl <= 100) { S.liveStopLossPct = parseFloat(lsl.toFixed(1)); liveLog('LIVE STOP LOSS: ' + S.liveStopLossPct + '%', 'info'); }
  }
  if (req.body.liveTakeProfitMode && (req.body.liveTakeProfitMode === 'TRAIL' || req.body.liveTakeProfitMode === 'FIXED' || req.body.liveTakeProfitMode === 'TIERED')) {
    S.liveTakeProfitMode = req.body.liveTakeProfitMode; liveLog('LIVE TAKE PROFIT MODE: ' + S.liveTakeProfitMode, 'info');
  }
  if (req.body.liveTakeProfitPct !== undefined) {
    var ltp = parseFloat(req.body.liveTakeProfitPct);
    if (!isNaN(ltp) && ltp > 0 && ltp <= 1000) { S.liveTakeProfitPct = parseFloat(ltp.toFixed(1)); liveLog('LIVE TP TARGET: ' + S.liveTakeProfitPct + '%', 'info'); }
  }
  if (req.body.takeProfitMode && (req.body.takeProfitMode === 'TRAIL' || req.body.takeProfitMode === 'FIXED' || req.body.takeProfitMode === 'TIERED')) {
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
  if (req.body.autoLockEnabled !== undefined) {
    S.autoLockEnabled = req.body.autoLockEnabled === true || req.body.autoLockEnabled === 'true';
    log('Auto fund protection: ' + (S.autoLockEnabled ? 'ON' : 'OFF'), 'info');
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
  var sessionStartedAtStr = S.startTime ? new Date(S.startTime).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '';
  var sessionEndedAtStr = (S.lastStopTime && !S.running) ? new Date(S.lastStopTime).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '';
  var rows = [
    ['Name','Mint','Chain','Source','Size','EntryPrice','ExitPrice','PnL','PnLPct','TickCount','PeakGainPct','SecToFirstUpdate','CloseReason','OpenedAt','ClosedAt','ClosedDate','Fees','EntryMcap','ExitMcap','EntryBuys','EntrySells','SessionStartedAt','SessionEndedAt','LargestSellUsd','MaxRepeatSellerCount','EntrySlipCost','NetFundImpact','FundAmount','SavingsAmount','HoldTimeSec','PoolSizeAtEntry','ScanCountAtEntry','TriggerTickJumpPct','EntryUniqueBuyers','EntryUniqueSellers','EntryDustSwaps','EntryRealSwaps','EntryPreVolatilityPct','EntryPreVolTickCount','FundAfterTrade','FundSLTriggerAt','AutoLockStatus','TrailTriggerTickJumpPct','LowestPricePct','PriceHistory','EntryLiquidityUsd','TieredSold','Tier1ExitPrice','Tier1RealizedPct','Tier1RealizedPnl','Tier1ClosedAt','EntryTrigger','WindingDownAtClose','SecondsSinceDiscovery','EntryDevBought','EntryDevSold','HasDevWalletData','TieredSold2','Tier2ExitPrice','Tier2RealizedPct','Tier2RealizedPnl','Tier2ClosedAt'].join(',')
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
      t.entryMcap || 0,
      t.exitMcap || 0,
      t.entryBuys || 0,
      t.entrySells || 0,
      csvSafe(sessionStartedAtStr),
      csvSafe(sessionEndedAtStr),
      t.largestSellUsd || 0,
      t.maxRepeatSellerCount || 0,
      t.entrySlipCost || 0,
      t.netFundImpact !== undefined ? t.netFundImpact : '',
      t.fundAmount !== undefined ? t.fundAmount : '',
      t.savingsAmount !== undefined ? t.savingsAmount : '',
      t.holdTimeSec !== null && t.holdTimeSec !== undefined ? t.holdTimeSec : '',
      t.poolSizeAtEntry || 0,
      t.scanCountAtEntry || 0,
      t.triggerTickJumpPct !== null && t.triggerTickJumpPct !== undefined ? t.triggerTickJumpPct : '',
      t.entryUniqueBuyers || 0,
      t.entryUniqueSellers || 0,
      t.entryDustSwaps || 0,
      t.entryRealSwaps || 0,
      t.entryPreVolatilityPct !== null && t.entryPreVolatilityPct !== undefined ? t.entryPreVolatilityPct : '',
      t.entryPreVolTickCount || 0,
      t.fundAfterTrade !== undefined ? t.fundAfterTrade : '',
      t.fundSLTriggerAt !== undefined ? t.fundSLTriggerAt : '',
      csvSafe(t.autoLockStatus || ''),
      t.trailTriggerTickJumpPct !== null && t.trailTriggerTickJumpPct !== undefined ? t.trailTriggerTickJumpPct : '',
      t.lowestPricePct !== null && t.lowestPricePct !== undefined ? t.lowestPricePct : '',
      csvSafe(t.priceHistory || ''),
      t.entryLiquidityUsd !== null && t.entryLiquidityUsd !== undefined ? t.entryLiquidityUsd : '',
      csvSafe(t.tieredSold || 'No'),
      t.tier1ExitPrice !== null && t.tier1ExitPrice !== undefined ? t.tier1ExitPrice : '',
      t.tier1RealizedPct !== null && t.tier1RealizedPct !== undefined ? t.tier1RealizedPct : '',
      t.tier1RealizedPnl !== null && t.tier1RealizedPnl !== undefined ? t.tier1RealizedPnl : '',
      csvSafe(t.tier1ClosedAt || ''),
      csvSafe(t.entryTrigger || 'scanner'),
      csvSafe(t.windingDownAtClose || 'No'),
      t.secondsSinceDiscovery !== null && t.secondsSinceDiscovery !== undefined ? t.secondsSinceDiscovery : '',
      csvSafe(t.entryDevBought || 'No'),
      csvSafe(t.entryDevSold || 'No'),
      csvSafe(t.hasDevWalletData || 'No'),
      csvSafe(t.tieredSold2 || 'No'),
      t.tier2ExitPrice !== null && t.tier2ExitPrice !== undefined ? t.tier2ExitPrice : '',
      t.tier2RealizedPct !== null && t.tier2RealizedPct !== undefined ? t.tier2RealizedPct : '',
      t.tier2RealizedPnl !== null && t.tier2RealizedPnl !== undefined ? t.tier2RealizedPnl : '',
      csvSafe(t.tier2ClosedAt || ''),
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

app.get('/', function(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(__dirname + '/index.html');
});

app.listen(PORT, function() {
  console.log('BunkerBuster - Sniper Bot - running on port ' + PORT);
  loadPortfolio();
  fetchDSTokens();
  updateSolPrice();
});
