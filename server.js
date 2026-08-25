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
const BITQUERY_TOKEN = process.env.BITQUERY_TOKEN || '';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
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
  MIN_SPLIT_WIN: 0.05,
  SAVINGS_PCT: 0.20,
  MIN_LIQ_USD: 5000,
  MAX_MCAP_USD: 25000000,
  MIN_MCAP_USD: 2750,
  BQ_SUBSCRIBE_MIN_MCAP: 2750,
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
  MAX_DEV_HOLD_PCT: 0.10,
  EVICT_SAMPLE_SIZE: 200,
  PORTFOLIO_SAVE_EVERY: 3,
  PORTFOLIO_AUTOSAVE_MS: 300000,
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
      try {
        P = JSON.parse(raw);
        log('Portfolio loaded — ' + P.trades.length + ' trades in history', 'info');
      } catch (parseErr) {
        // File exists but is corrupted — do NOT silently discard it as if it never
        // existed. Back it up so the trade history isn't lost forever, and log
        // loudly since this is a real data integrity problem, not a fresh start.
        log('PORTFOLIO FILE CORRUPTED — could not parse ' + PORTFOLIO_FILE + '. Backing up and starting fresh.', 'rug');
        try { fs.copyFileSync(PORTFOLIO_FILE, PORTFOLIO_FILE + '.corrupted.' + Date.now()); } catch(e2) {}
      }
    } else {
      log('No portfolio file found — starting fresh', 'info');
    }
  } catch(e) {
    log('Portfolio load error: ' + (e && e.message ? e.message : 'unknown'), 'warn');
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
  stats: { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0, mcapCeiling: 0 },
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
  gradEnabled: false,
  autoLockEnabled: false,
  sessionHighFund: 0,
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

// ── WALLET CONCENTRATION CHECK ────────────────────────────────
// Held for later per user's explicit instruction: not needed while paper
// trading, to be addressed before real money is used. Left unchanged.
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
      if (addr === SOLANA_INCINERATOR) return;
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

// ── MINT / FREEZE AUTHORITY CHECK (real, via Solana RPC) ───────
// Research-confirmed (standard getAccountInfo/getMint pattern): a single,
// low-cost Solana RPC call returns a mint's current mintAuthority and
// freezeAuthority directly. Fails OPEN (allows the trade through) on any
// RPC error or missing data — same design philosophy as the existing
// wallet-concentration check — since public RPC flakiness is common and
// blocking every trade on an infra hiccup would defeat the bot's purpose.
// This is a deliberate design choice, not an oversight.
async function checkMintFreezeAuthority(mint) {
  try {
    var res = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed' }],
      }),
      timeout: 4000,
    });
    if (!res.ok) return { safe: true, reason: 'RPC query failed, allowing through' };
    var data = await res.json();
    var value = data && data.result && data.result.value;
    var info = value && value.data && value.data.parsed && value.data.parsed.info;
    if (!info) return { safe: true, reason: 'no mint account data, allowing through' };
    if (info.mintAuthority) return { safe: false, reason: 'mint authority not renounced' };
    if (info.freezeAuthority) return { safe: false, reason: 'freeze authority retained' };
    return { safe: true, reason: 'authorities renounced' };
  } catch (e) {
    return { safe: true, reason: 'authority check errored, allowing through' };
  }
}

// ── DEV WALLET HOLDING % CHECK (real) ───────────────────────────
// Dev/creator wallet is approximated as the transaction Signer on the
// create instruction — a well-established heuristic (the wallet that
// submits the create transaction is virtually always the deploying dev),
// but NOT the same as a guaranteed "creator" field. Known limitation,
// stated plainly per user's research discussion: sophisticated bad actors
// split holdings across many wallets (bundlers) specifically to defeat a
// single-wallet check like this one. This catches unsophisticated cases,
// not all of them. Estimated total supply is derived from mcap/price
// (works for both PUMP and BONK) rather than assuming a fixed 1B supply.
async function checkDevHoldingPct(mint, devWallet, mcap, price) {
  if (!BITQUERY_TOKEN || !devWallet) return { safe: true, reason: 'no dev wallet available, allowing through' };
  try {
    var query = 'query { Solana { BalanceUpdates(limit: {count: 1} where: {BalanceUpdate: {Currency: {MintAddress: {is: "' + mint + '"}}, Account: {Address: {is: "' + devWallet + '"}}}, Transaction: {Result: {Success: true}}}) { BalanceUpdate { Holding: PostBalance(maximum: Block_Slot) } } } }';
    var res = await fetch('https://streaming.bitquery.io/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + BITQUERY_TOKEN },
      body: JSON.stringify({ query: query }),
    });
    if (!res.ok) return { safe: true, reason: 'dev query failed, allowing through' };
    var data = await res.json();
    var updates = data && data.data && data.data.Solana && data.data.Solana.BalanceUpdates;
    if (!updates || !updates.length) return { safe: true, reason: 'no dev balance data' };
    var devBalance = parseFloat(updates[0].BalanceUpdate.Holding || 0);
    if (devBalance <= 0) return { safe: true, reason: 'dev holds 0' };
    var estSupply = (mcap && price) ? (mcap / price) : 1000000000;
    if (!estSupply || estSupply <= 0) return { safe: true, reason: 'supply unknown, allowing through' };
    var devPct = devBalance / estSupply;
    if (devPct >= CFG.MAX_DEV_HOLD_PCT) {
      return { safe: false, reason: 'dev holds ' + (devPct * 100).toFixed(1) + '% of supply' };
    }
    return { safe: true, reason: 'dev holding OK (' + (devPct * 100).toFixed(1) + '%)' };
  } catch (e) {
    return { safe: true, reason: 'dev check errored, allowing through' };
  }
}

// ── SAFETY CHECKLIST (discovery-time — authority + dev holding only) ────
// isPumpFun parameter and the old lpBurn/dev-null checks are removed —
// research confirmed LP burn does not apply pre-graduation on either
// platform. mintAuthority/freezeAuthority/dev-holding are populated from
// real checks instead of always being null/undefined.
//
// The honeypot (Jupiter quote) check is DELIBERATELY NOT run here anymore.
// A token this function evaluates is often milliseconds old — Jupiter has
// no real trading activity to route against yet, so "no quote available"
// was being treated as "confirmed honeypot" and permanently banning
// almost every brand-new token before it ever had a chance to trade. This
// is why the pool got stuck near-empty. Mint/freeze authority is static
// metadata set at creation, so it's still safe and correct to check here.
// The honeypot check itself now runs at entry time instead, in
// tryEnterTokenInner(), once the token has real buys (buys >= 3 already
// required to reach entry) for Jupiter to actually have something to quote.
var pendingDiscoveryChecks = new Set();

async function runSafetyChecklist(mint, devWallet, mcap, price) {
  var authCheck = await checkMintFreezeAuthority(mint);
  if (!authCheck.safe) {
    if (authCheck.reason.indexOf('freeze') >= 0) permanentBan(mint, authCheck.reason);
    else tempBan(mint, authCheck.reason);
    return { safe: false, reason: authCheck.reason };
  }

  var devCheck = await checkDevHoldingPct(mint, devWallet, mcap, price);
  if (!devCheck.safe) {
    tempBan(mint, devCheck.reason);
    return { safe: false, reason: devCheck.reason };
  }

  return { safe: true, reason: 'passed' };
}

// ── SOLANA HONEYPOT CHECK ─────────────────────────────────────
// Research-confirmed applicable pre-graduation on both Pump.fun and
// LetsBonk (Jupiter's own changelog documents optimized pre-graduation
// bonding-curve routing; LetsBonk's own docs state Jupiter routing from
// launch). Fails CLOSED (treats errors as a honeypot) — kept as-is from
// the original design, since this is the actual scam-detection signal
// and erring toward caution here is the safer default, unlike the
// infra-availability checks above.
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
        var safe = await runSafetyChecklist(mint, null, mcap, price);
        if (!safe.safe) continue;
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

// ── POOL EVICTION (shared, sampled instead of full scan) ───────
// Previously ran a full forEach over the entire pool (up to maxPool, i.e.
// up to 10,000 entries) on EVERY new token once the pool was full — real,
// frequent CPU cost given discovery rate. Now samples a bounded number of
// candidates instead of scanning everything; still evicts a genuinely low
// BSR token, just doesn't guarantee finding the single global worst one.
function evictWorstToken() {
  var worstKey = null;
  var worstBSR = Infinity;
  var sampled = 0;
  for (var entry of S.tokens) {
    if (sampled >= CFG.EVICT_SAMPLE_SIZE) break;
    var key = entry[0];
    var tok = entry[1];
    if (S.open.find(function(t) { return t.mint === key; })) continue;
    sampled++;
    var bsr = tok.buys / Math.max(tok.sells || 1, 1);
    if (bsr < worstBSR) { worstBSR = bsr; worstKey = key; }
  }
  if (worstKey) S.tokens.delete(worstKey);
}

// ── BITQUERY — REAL TIME DATA ─────────────────────────────────
var pumpPrices = {};
var pumpWs = null;
var bqPairSubActive = false;
var bqTradeSubActive = false;
var bqReconnectDelay = 3000;
var bqDeliberateStop = false;
var bqPingI = null;
var bqTradeLogCount = 0;

var BQ_SOURCES = [
  {
    src: 'PUMP', chain: 'solana', protocolFamily: 'Pumpfun',
    programAddress: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    createMethods: ['create', 'create_v2'],
    queryShape: 'tokenSupplyUpdate',
  },
  {
    src: 'BONK', chain: 'solana', protocolFamily: 'raydium_launchpad',
    programAddress: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
    platformConfigAddress: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1',
    createMethods: ['initialize_v2'],
    queryShape: 'instructions',
  },
];

function connectBQ() {
  if (pumpWs && (pumpWs.readyState === WebSocket.OPEN || pumpWs.readyState === WebSocket.CONNECTING)) return;
  if (!BITQUERY_TOKEN) {
    log('BITQUERY_TOKEN missing — add it in Render Environment tab', 'rug');
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
      log('Bitquery LIVE — real time data connected', 'pump');
      sendBQConnectionInit();
      setTimeout(function() {
        if (!bqPairSubActive && pumpWs && pumpWs.readyState === WebSocket.OPEN) {
          log('BQ WARNING: no connection_ack received after 10s — subscriptions may not have started', 'warn');
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
    if (data.Solana && data.Solana.Instructions) {
      data.Solana.Instructions.forEach(function(i) { handleNewPairFromInstruction(i); });
    }
    if (data.Trading && data.Trading.Trades) {
      data.Trading.Trades.forEach(function(t) { handleSwap(t); });
    }
    if (data.Solana && data.Solana.DEXPools) {
      data.Solana.DEXPools.forEach(function(p) { handleBQPool(p); });
    }
  }
}

// Combined new-pair query now also requests Transaction { Signer } — needed
// as the dev/creator wallet heuristic for the new dev-holding % check.
// This did not exist in the query before; it's a real addition, not just a
// re-read of existing data.
function buildCombinedPairQuery() {
  var conditions = BQ_SOURCES.map(function(source) {
    var methods = source.createMethods.map(function(m) { return '"' + m + '"'; }).join(', ');
    return '{ Instruction: { Program: { Address: { is: "' + source.programAddress + '" }, Method: { in: [' + methods + '] } } } }';
  }).join(' ');

  return 'subscription { Solana { Instructions(where: { Transaction: { Result: { Success: true } }, any: [' + conditions + '] }) { Instruction { Accounts { Address Token { Mint Owner } } Program { Address Method Arguments { Name Type Value { ... on Solana_ABI_String_Value_Arg { string } ... on Solana_ABI_Address_Value_Arg { address } ... on Solana_ABI_Integer_Value_Arg { integer } ... on Solana_ABI_BigInt_Value_Arg { bigInteger } ... on Solana_ABI_Json_Value_Arg { json } } } } } Transaction { Signer } } } }';
}

function sendBQSubscriptions() {
  pumpWs.send(JSON.stringify({
    id: 'pairs_all',
    type: 'start',
    payload: { query: buildCombinedPairQuery() }
  }));
  bqPairSubActive = true;
  log('New pair stream active (' + BQ_SOURCES.map(function(s){return s.src;}).join(', ') + ')', 'pump');

  var families = BQ_SOURCES.map(function(s) { return '"' + s.protocolFamily + '"'; }).join(', ');
  pumpWs.send(JSON.stringify({
    id: 'trades_all',
    type: 'start',
    payload: {
      query: 'subscription { Trading { Trades(where: {Pair: {Market: {ProtocolFamily: {in: [' + families + ']}}}, Supply: {MarketCap: {gt: ' + CFG.BQ_SUBSCRIBE_MIN_MCAP + '}}}) { Side Trader { Address } AmountsInUsd { Base Quote } Supply { MarketCap TotalSupply } Pair { Token { Address } Market { ProtocolFamily } } PriceInUsd } } }'
    }
  }));
  bqTradeSubActive = true;
  log('Swap stream active — all sources', 'pump');
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
  var signer = (i.Transaction || {}).Signer || null;

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

  S.pumpCount++;
  S.sources['BITQUERY'] = 'live:' + S.pumpCount;
  if (S.pumpCount % 20 === 0) log(src + ': ' + S.pumpCount + ' launches — latest: ' + name, 'pump');

  if (isBanned(mint)) return;
  if (S.tokens.has(mint)) return;

  // Guard against the same brand-new mint's discovery event firing more
  // than once in quick succession (duplicate stream delivery, or a
  // genuinely duplicated on-chain instruction) and running the safety
  // checklist — and therefore a permanent ban — twice concurrently. This
  // was confirmed happening (same mint banned twice in the same second).
  if (pendingDiscoveryChecks.has(mint)) return;
  pendingDiscoveryChecks.add(mint);

  if (S.tokens.size >= S.maxPool) evictWorstToken();

  // Real safety checklist now — no more hardcoded nulls/isPumpFun=true.
  // mcap/price aren't known yet at discovery time for a brand new token,
  // so the dev-holding check runs again at entry time too (where real
  // price/mcap exist and matter more); this discovery-time call covers
  // mint/freeze authority, which is static and doesn't need price data.
  // Honeypot check no longer runs here — see runSafetyChecklist comment.
  var safe;
  try {
    safe = await runSafetyChecklist(mint, signer, 0, 0);
  } finally {
    pendingDiscoveryChecks.delete(mint);
  }
  if (!safe.safe) return;
  if (S.tokens.has(mint)) return; // re-check: another path may have added it while we awaited

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
    dev: signer,
  });

  log('NEW TOKEN ' + name + ' | ' + src + ' | Added to pool', 'info');
}

// ── ENTRY LOGIC (shared — event-driven AND scanner both call this) ─────
// Previously entry was decided ONLY by runScan() polling one token every
// 500ms round-robin, requiring the cached price to be under 1 second old
// at the exact moment that token's turn came up. With large pools this
// created a real, structural miss window — worse for BONK specifically,
// since its swaps arrive less often than PUMP's. This function now runs
// the SAME rules (unchanged — no filter thresholds were touched) but can
// be triggered the instant a fresh swap price arrives for a token, not
// just when the round-robin scanner happens to land on it. runScan() below
// still calls this too, as a backup path using its cached-price check.
var pendingEntryChecks = new Set();

async function tryEnterToken(tok, freshPrice) {
  if (!S.running || S.windingDown) return;
  if (!tok || !tok.mint) return;
  if (pendingEntryChecks.has(tok.mint)) return;
  if (S.open.find(function(t) { return t.mint === tok.mint; })) return;

  pendingEntryChecks.add(tok.mint);
  try {
    await tryEnterTokenInner(tok, freshPrice);
  } finally {
    pendingEntryChecks.delete(tok.mint);
  }
}

async function tryEnterTokenInner(tok, freshPrice) {
  if (S.fund < 1) return;
  if (S.open.length >= S.maxOpen) return;
  if (isBanned(tok.mint)) { S.tokens.delete(tok.mint); return; }

  if (tok.chain === 'base' && !S.baseEnabled) return;
  if (tok.chain === 'solana' && !S.solEnabled) return;
  if (!tok.chain && !S.solEnabled) return;

  var bsr = tok.buys / Math.max(tok.sells || 1, 1);
  if (bsr < 0.8) { S.rejectCount++; return; }

  if ((tok.src === 'PUMP' || tok.src === 'BONK') && tok.mcap > 0 && tok.mcap < CFG.MIN_MCAP_USD) return;

  var cooldownKey = tok.n + tok.mint;
  var lastCooldown = S.cooldowns.get(cooldownKey);
  if (lastCooldown && (Date.now() - lastCooldown) < CFG.COOLDOWN_MS) return;

  if (S.open.find(function(t) { return t.mint === tok.mint; })) return;
  if (tok.buys < 3) return;

  var size = parseFloat((S.fund * CFG.MAX_POS).toFixed(4));
  if (size < 0.50) { S.rejectCount++; return; }

  if (tok.src === 'DSC') return;

  var entryPrice = freshPrice;
  if (!entryPrice || entryPrice <= 0) {
    if (tok.src === 'PUMP' || tok.src === 'BONK') {
      var cached = pumpPrices[tok.mint];
      if (cached && (Date.now() - cached.ts) <= 1000) entryPrice = cached.price;
    } else {
      entryPrice = await getDSPrice(tok.mint, tok.pairAddress, tok.chain);
    }
  }
  if (!entryPrice || entryPrice <= 0) { S.rejectCount++; return; }

  if (tok.src === 'PUMP' || tok.src === 'BONK') {
    // Mint/freeze authority already ran at discovery time (static data,
    // no need to re-check). Dev-holding % needs real price/mcap, which we
    // have now — check it here, right before entry.
    var devCheck = await checkDevHoldingPct(tok.mint, tok.dev, tok.mcap, entryPrice);
    if (!devCheck.safe) {
      S.rejectCount++;
      log('DIAG ' + tok.n + ' | SKIP: ' + devCheck.reason, 'info');
      return;
    }

    // Honeypot check moved here from discovery time — by entry, the token
    // has already cleared buys >= 3, meaning real trades have happened, so
    // Jupiter has actual activity to route/quote against. Running this at
    // discovery (when a token is often milliseconds old) was causing
    // near-100% false-positive bans since Jupiter had nothing to quote yet.
    var isHoneypot = await checkHoneypot(tok.mint);
    if (isHoneypot) {
      permanentBan(tok.mint, 'Honeypot confirmed — sell simulation failed');
      S.rejectCount++;
      return;
    }

    if (pendingConcentrationChecks.has(tok.mint)) return;
    pendingConcentrationChecks.add(tok.mint);
    var concCheck = await checkWalletConcentration(tok.mint);
    pendingConcentrationChecks.delete(tok.mint);
    if (!concCheck.safe) {
      S.rejectCount++;
      log('DIAG ' + tok.n + ' | SKIP: ' + concCheck.reason, 'info');
      return;
    }
  }

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
    entryMcap: tok.mcap || 0,
    entryBuys: tok.buys || 0,
    entrySells: tok.sells || 0,
    currentPrice: entryPrice,
    currentMcap: tok.mcap || 0,
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
    sessionId: S.startTime,
  };

  S.open.push(trade);
  log('ENTER ' + tok.n + ' [' + tok.src + '] | $' + size.toFixed(2) + ' | Entry $' + entryPrice.toFixed(8), 'entry');
}

async function handleNewPair(u) {
  // Dead path removed — no subscription sends the TokenSupplyUpdates shape
  // this function was written for; buildCombinedPairQuery() (the only
  // pair-launch subscription actually sent) uses the Instructions shape
  // handled by handleNewPairFromInstruction() above. Left as a no-op stub
  // rather than fully deleted in case a future TokenSupplyUpdates
  // subscription is intentionally reintroduced.
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
  }

  if (priceUsd) {
    pumpPrices[mint] = { price: priceUsd, solInCurve: 0, ts: Date.now() };

    // Event-driven entry: the instant a fresh swap price arrives for a
    // pool token that isn't open yet, try entering right here — instead of
    // waiting for the round-robin scanner to eventually land on it. Fire
    // and forget (async, guarded against re-entrancy inside tryEnterToken)
    // so this never blocks processing of the next incoming swap message.
    if (poolTok && !S.open.find(function(t2) { return t2.mint === mint; })) {
      tryEnterToken(poolTok, priceUsd);
    }

    // Real-time open-trade tracking — previously gated to src === 'PUMP'
    // only, meaning BONK trades never got instant swap-driven price/trail/
    // stop-loss updates at all. That restriction is removed: any open
    // trade sourced from the swap stream (PUMP or BONK) gets tracked here.
    S.open.forEach(function(trade) {
      if (trade.mint !== mint || (trade.src !== 'PUMP' && trade.src !== 'BONK')) return;

      if (trade.currentPrice && trade.currentPrice > 0) {
        var change = Math.abs(priceUsd - trade.currentPrice) / trade.currentPrice;
        if (change > 0.90) {
          log('PRICE SANITY REJECT ' + trade.tok.n + ' | ' + (change * 100).toFixed(0) + '% single tick', 'warn');
          return;
        }
      }

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
}

// ── GRADUATION TRACKING ────────────────────────────────────────
// On hold per user — left unchanged, still dormant (subscriptions not sent).
function sendBQPoolSubscription() {
  pumpWs.send(JSON.stringify({
    id: 'pools_pump',
    type: 'start',
    payload: {
      query: 'subscription { Solana { DEXPools(where: {Pool: {Dex: {ProtocolName: {is: "pump"}}}}) { Pool { Market { BaseCurrency { MintAddress Symbol Name } } Base { PostAmount } Quote { PostAmount } } } } }'
    }
  }));
  log('Graduation stream active', 'pump');
}

function handleBQPool(p) {
  var pool = p.Pool || {};
  var market = pool.Market || {};
  var baseCurrency = market.BaseCurrency || {};
  var mint = baseCurrency.MintAddress;
  if (!mint) return;

  var baseReserve = parseFloat((pool.Base || {}).PostAmount || 0);
  var quoteReserveSol = parseFloat((pool.Quote || {}).PostAmount || 0);
  if (!baseReserve) return;

  var progressPct = Math.max(0, Math.min(100, ((793100000 - (baseReserve - 206900000)) / 793100000) * 100));
  var solInCurve = quoteReserveSol;

  if (solInCurve >= CFG.GRAD_ENTRY_SOL && solInCurve <= CFG.GRAD_MAX_SOL) {
    var name = (baseCurrency.Symbol || baseCurrency.Name || mint.slice(0, 8)).toUpperCase().slice(0, 12);
    var existing = S.gradCandidates.get(mint) || {
      name: name, mint: mint, firstSeen: Date.now(), buys: 0, sells: 0,
    };
    existing.solInCurve = solInCurve;
    existing.price = pumpPrices[mint] ? pumpPrices[mint].price : existing.price;
    existing.lastUpdate = Date.now();
    var pt = S.tokens.get(mint);
    if (pt) { existing.buys = pt.buys; existing.sells = pt.sells; }
    existing.bsr = existing.buys / Math.max(existing.sells || 1, 1);
    existing.nearGrad = true;
    var pct = Math.floor((solInCurve / CFG.GRAD_TARGET) * 100);
    if (!existing.logged || existing.loggedPct !== pct) {
      existing.logged = true;
      existing.loggedPct = pct;
      log('GRAD CANDIDATE ' + name + ' | ' + solInCurve.toFixed(0) + ' SOL | ' + pct + '% | BSR ' + existing.bsr.toFixed(1) + 'x', 'pump');
    }
    S.gradCandidates.set(mint, existing);
  } else {
    var cand = S.gradCandidates.get(mint);
    if (cand) cand.nearGrad = false;
  }
}

function sendBQLetsBonkGradSubscription() {
  var bonkSource = BQ_SOURCES.filter(function(s) { return s.src === 'BONK'; })[0];
  if (!bonkSource) return;
  pumpWs.send(JSON.stringify({
    id: 'pools_bonk',
    type: 'start',
    payload: {
      query: 'subscription { Solana { Instructions(where: {Instruction: {Program: {Address: {is: "' + bonkSource.programAddress + '"}, Method: {in: ["migrate_to_amm", "migrate_to_cpswap"]}}, Accounts: {includes: {Address: {is: "' + bonkSource.platformConfigAddress + '"}}}}, Transaction: {Result: {Success: true}}}) { Instruction { Accounts { Address Token { Mint } } } } } }'
    }
  }));
  log('LetsBonk graduation stream active', 'pump');
}

function handleBQLetsBonkGraduation(i) {
  var instr = (i.Instruction || {});
  var accounts = instr.Accounts || [];
  var mint = null;
  for (var k = 0; k < accounts.length; k++) {
    if (accounts[k].Token && accounts[k].Token.Mint) { mint = accounts[k].Token.Mint; break; }
  }
  if (!mint) return;

  var tok = S.tokens.get(mint);
  var name = tok ? tok.n : mint.slice(0, 8);
  log('LETSBONK GRADUATED ' + name + ' | migrated to Raydium AMM', 'pump');

  if (tok) tok.graduated = true;
}


// ── OPEN TRADE PRICE TRACKING ─────────────────────────────────
// Previously filtered t.src !== 'PUMP', meaning every non-PUMP trade
// (including BONK) fell back to this 2-second DexScreener HTTP poll — a
// fundamentally slower, weaker tracking path than the instant swap-driven
// updates in handleSwap(). BONK now gets real-time updates there instead
// (see handleSwap above), so this poll is now correctly scoped to ONLY the
// sources that genuinely have no swap-stream coverage (DSC/DexScreener-
// discovered tokens on Solana or Base).
async function updateOpenTradePrices() {
  var trades = S.open.filter(function(t) { return !t.isGrad && t.src !== 'PUMP' && t.src !== 'BONK' && t.mint; });
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

  if (S.autoLockEnabled && S.fund > S.sessionHighFund) {
    S.sessionHighFund = S.fund;
    var oldBase = S.dayStartFund;
    S.dayStartFund = S.fund;
    S.windingDown = false;
    var newTrigger = S.fund * (1 - S.fundStopLossPct / 100);
    log('AUTO-LOCK: new high $' + S.fund.toFixed(2) + ' — stop loss raised (was $' + oldBase.toFixed(2) + ') | triggers below $' + newTrigger.toFixed(2), 'info');
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

  // sessionStartedAt is now captured per-trade at close time from the
  // trade's own sessionId (set to S.startTime when the trade was opened),
  // NOT recomputed from whatever the server's CURRENT session state
  // happens to be at CSV export time. sessionEndedAt is filled in later by
  // stopBot() for every trade sharing that sessionId. This fixes the
  // export previously showing wrong/blank session boundaries for older
  // trades after any server restart.
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
    sessionId: tr.sessionId || S.startTime || null,
    sessionStartedAt: tr.sessionId ? new Date(tr.sessionId).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '',
    sessionEndedAt: '',
    slip: tr.slip || 0,
    fees: parseFloat(feePaid.toFixed(4)),
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
  // Save cadence tightened from every 10 trades to every 3 — reduces the
  // data-loss window on an unexpected restart/crash between saves.
  if (P.allTime.t % CFG.PORTFOLIO_SAVE_EVERY === 0) savePortfolio();

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
// On hold per user — left entirely unchanged.
async function runGradSniper() {
  if (!S.gradEnabled) return;
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
    var gradCooldownKey = (cand.name || mint.slice(0, 8)) + mint;
    var lastGradCooldown = S.cooldowns.get(gradCooldownKey);
    if (lastGradCooldown && (Date.now() - lastGradCooldown) < CFG.COOLDOWN_MS) continue;
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
      sessionId: S.startTime,
    };

    S.open.push(trade);
    S.gradCount++;
    log('GRAD ENTER ' + trade.tok.n + ' | ' + pct2 + '% to grad | ' + cand.solInCurve.toFixed(0) + ' SOL | $' + size.toFixed(2), 'entry');
    break;
  }
}

// ── MAIN SCANNER ──────────────────────────────────────────────
// Still runs as a backup/fallback path (and the only path for DSC, though
// DSC entries remain disabled) — but entry logic itself now lives in
// tryEnterToken()/tryEnterTokenInner(), shared with the event-driven path
// in handleSwap(). No filter thresholds changed here; this just stopped
// duplicating the entry rules inline and calls the shared function instead.
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

  var diag = (S.scanCount % 200 === 0);
  if (diag) log('DIAG ' + tok.n + ' | scanner pass (backup path — entry also tried live on each swap)', 'info');

  await tryEnterToken(tok, null);
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
var gradI = null, exitI = null, cleanI = null, priceI = null, dsI = null, solPriceI = null, portfolioSaveI = null;

function startBot() {
  if (S.running) return;
  S.running = true;
  S.startTime = Date.now();
  S.stats = { w: 0, l: 0, r: 0, t: 0, gw: 0, gl: 0, mcapCeiling: 0 };
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
  S.autoLockEnabled = false;
  S.sessionHighFund = S.sessionFund;

  connectBQ();
  fetchDSTokens();
  updateSolPrice();

  scanI = setInterval(runScan, 500);
  gradI = setInterval(runGradSniper, 1000);
  exitI = setInterval(checkExitCriteria, 10000);
  priceI = setInterval(updateOpenTradePrices, 2000);
  dsI = setInterval(fetchDSTokens, CFG.DS_INTERVAL);
  cleanI = setInterval(cleanPool, 3600000);
  solPriceI = setInterval(updateSolPrice, 600000);
  portfolioSaveI = setInterval(savePortfolio, CFG.PORTFOLIO_AUTOSAVE_MS);

  log('BunkerBuster STARTED | Fund: $' + S.sessionFund + ' | SL: ' + S.stopLossPct + '% | Max: ' + S.maxOpen, 'info');
}

function stopBot() {
  S.running = false;
  S.lastStopTime = Date.now();
  if (scanI) clearInterval(scanI);
  if (gradI) clearInterval(gradI);
  if (exitI) clearInterval(exitI);
  if (priceI) clearInterval(priceI);
  if (dsI) clearInterval(dsI);
  if (cleanI) clearInterval(cleanI);
  if (solPriceI) clearInterval(solPriceI);
  if (portfolioSaveI) clearInterval(portfolioSaveI);
  if (pumpWs) {
    bqDeliberateStop = true;
    try { pumpWs.close(); } catch(e) {}
    pumpWs = null;
  }

  // Fill in sessionEndedAt for every trade from this session that doesn't
  // have it yet, instead of recomputing session boundaries from current
  // server state at CSV-export time. This is the real fix for the export
  // showing wrong/blank session timestamps after any restart.
  var endedAtStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  P.trades.forEach(function(t) {
    if (t.sessionId === S.startTime && !t.sessionEndedAt) {
      t.sessionEndedAt = endedAtStr;
    }
  });

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
  } else {
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
    gradEnabled: S.gradEnabled,
    autoLockEnabled: S.autoLockEnabled,
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
app.post('/api/lock-fund', function(req, res) {
  var oldBase = S.dayStartFund;
  S.dayStartFund = S.fund;
  S.windingDown = false;
  var newTrigger = S.fund * (1 - S.fundStopLossPct / 100);
  log('Fund stop loss locked to current balance — new base $' + S.fund.toFixed(2) + ' (was $' + oldBase.toFixed(2) + ') | triggers below $' + newTrigger.toFixed(2), 'info');
  res.json({ success: true, newBase: S.fund, triggerAt: parseFloat(newTrigger.toFixed(2)) });
});

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
  if (req.body.gradEnabled !== undefined) {
    S.gradEnabled = req.body.gradEnabled === true || req.body.gradEnabled === 'true';
    log('Graduation sniper: ' + (S.gradEnabled ? 'ON' : 'OFF'), 'info');
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
  var rows = [
    ['Name','Mint','Chain','Source','Size','EntryPrice','ExitPrice','PnL','PnLPct','TickCount','PeakGainPct','SecToFirstUpdate','CloseReason','OpenedAt','ClosedAt','ClosedDate','Fees','EntryMcap','ExitMcap','EntryBuys','EntrySells','SessionStartedAt','SessionEndedAt','LargestSellUsd','MaxRepeatSellerCount'].join(',')
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
      // Now reads the per-trade stored session fields set at close/stop
      // time, not a recomputation from current server state.
      csvSafe(t.sessionStartedAt || ''),
      csvSafe(t.sessionEndedAt || ''),
      t.largestSellUsd || 0,
      t.maxRepeatSellerCount || 0,
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
  fetchDSTokens();
  updateSolPrice();
});
