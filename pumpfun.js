'use strict';
// -- PUMP.FUN BUY/SELL INSTRUCTION BUILDING -----------------------
// Thin wrapper around the OFFICIAL @pump-fun/pump-sdk package.
// This file only ever builds instructions -- it never sends, signs,
// or confirms anything. That stays entirely in execution.js, using
// logic we built and tested ourselves.
//
// ONE SDK, ONE PATH PER KIND OF COIN
// Every trade is built by @pump-fun/pump-sdk 4.2.0 -- nothing else is installed.
//   - Normal coins: the v3 instructions (buyV3Instructions / sellV3Instructions).
//   - Cashback coins: v3 refuses them on purpose (CashbackCoinNotSupportedError), so they use
//     the same package's regular buyInstructions / sellInstructions, with the cashback flag
//     on the sell.
// There is no second SDK and no fallback. If a trade cannot be built, or the chain rejects it,
// it fails and the failure is reported as it is.
//
// IMPORTANT: this file deliberately does NOT use the SDK's own
// getBuyTokenAmountFromSolAmount / getSellSolAmountFromTokenAmount
// helpers. Real production data confirmed the bonding curve's fields
// were renamed (virtualSolReserves -> virtualQuoteReserves, etc.) when
// the SDK was generalized to support non-SOL-quoted coins, and
// different official sources showed that helper being called with
// genuinely different, inconsistent argument shapes. Rather than keep
// guessing at an external function's exact current interface, the
// quote is computed directly here using the standard constant-product
// formula (independently confirmed many times over during this
// project's research, and unchanged regardless of the SDK's own field
// renames) against the real, confirmed field names.
//
// The SDK still does the part that's actually complex and has
// genuinely changed before -- building the real instructions with the
// correct accounts, creator vault, and fee config. The quote computed
// here doesn't need to be exact to the last lamport: the real safety
// mechanism is the slippage tolerance built directly into the
// instruction itself (maxSolCost / minSolOutput), which the SDK
// applies on top of whatever amount is requested.

const BN = require('bn.js');
const sdk = require('@pump-fun/pump-sdk');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_KEY = '11111111111111111111111111111111';

// The 8 buyback fee recipient wallets listed in Pump's official docs
// (docs/FEE_RECIPIENTS.md). A v3 trade must be given exactly one of them; any one works.
const BUYBACK_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
];

// Every builder this file calls must exist in the installed SDK. A missing one means the wrong
// package or version is installed, which is reported plainly the first time a trade is built.
var REQUIRED_SDK_PARTS = ['buyV3Instructions', 'sellV3Instructions', 'buyInstructions', 'sellInstructions'];
function missingSdkParts() {
  var missing = [];
  if (!sdk || typeof sdk.OnlinePumpSdk !== 'function') missing.push('OnlinePumpSdk');
  if (!sdk || !sdk.PUMP_SDK) { missing.push('PUMP_SDK'); return missing; }
  REQUIRED_SDK_PARTS.forEach(function(n) { if (typeof sdk.PUMP_SDK[n] !== 'function') missing.push('PUMP_SDK.' + n); });
  return missing;
}
function assertSdk() {
  var m = missingSdkParts();
  if (m.length) throw new Error('the installed @pump-fun/pump-sdk is missing ' + m.join(', ') + ' -- the wrong version is installed');
}

var logger = function() {};
function setLogger(fn) { logger = (typeof fn === 'function') ? fn : function() {}; }
function say(msg, type) { try { logger(msg, type || 'info'); } catch (e) { /* logging must never break a trade */ } }

function getStatus() {
  var m = missingSdkParts();
  return { sdkOk: m.length === 0, missing: m };
}

function describe(label, value) {
  if (value === undefined) return label + '=undefined';
  if (value === null) return label + '=null';
  if (value instanceof BN) return label + '=BN(' + value.toString() + ')';
  if (typeof value === 'object') return label + '=object{' + Object.keys(value).join(',') + '}';
  return label + '=' + typeof value + '(' + value + ')';
}

// Constant-product quote: tokens out for a given SOL (quote) amount in.
// tokensOut = (solIn * virtualTokenReserves) / (virtualQuoteReserves + solIn)
function quoteTokensForSol(bondingCurve, solInBN) {
  var numerator = solInBN.mul(bondingCurve.virtualTokenReserves);
  var denominator = bondingCurve.virtualQuoteReserves.add(solInBN);
  return numerator.div(denominator);
}

// Constant-product quote: SOL (quote) out for a given token amount in.
// solOut = (tokensIn * virtualQuoteReserves) / (virtualTokenReserves + tokensIn)
function quoteSolForTokens(bondingCurve, tokensInBN) {
  var numerator = tokensInBN.mul(bondingCurve.virtualQuoteReserves);
  var denominator = bondingCurve.virtualTokenReserves.add(tokensInBN);
  return numerator.div(denominator);
}

// -- WHAT THE CURVE CAN REALLY PAY ----------------------------------
// A sell is quoted from the curve's VIRTUAL reserves, but the program pays it out of the curve's
// REAL SOL. On a coin that has been dumped on, the virtual quote can be more than the real SOL the
// curve holds, and the program then fails the sale with error 6024 (overflow). That is the working
// explanation for the 6024 failures seen on SLK and Skullie; the evidence line logged with every sell
// (see pumpSellInfo) will show whether it is right.
// So a sell is sized to what the curve can actually pay: if the quote is above SELL_RESERVE_SHARE_PCT
// percent of the real SOL, only as many tokens as that amount buys are sold now, and the rest stay in
// the wallet to be sold next (the caller keeps the position open and sells the remainder).
// The percentage is a safety margin for the reserves moving while the sale is in flight; it is not
// tuned from data.
const SELL_RESERVE_SHARE_PCT = 85;

function realQuoteOf(bc) {
  var r = bc && bc.realQuoteReserves;
  if (r === undefined || r === null) r = bc && bc.realSolReserves;
  if (r === undefined || r === null) return null;
  return (r instanceof BN) ? r : new BN(r.toString());
}

// Returns { tokens, capped, wanted, real, limit }. tokens is the amount to sell now.
function capSellToRealReserves(bc, tokensBN) {
  var wanted = quoteSolForTokens(bc, tokensBN);
  var real = realQuoteOf(bc);
  var out = { tokens: tokensBN, capped: false, wanted: wanted, real: real, limit: null };
  if (!real) return out;
  var limit = real.muln(SELL_RESERVE_SHARE_PCT).divn(100);
  out.limit = limit;
  if (wanted.lte(limit)) return out;
  if (limit.isZero() || limit.gte(bc.virtualQuoteReserves)) {
    var emptyErr = new Error('the curve holds almost no real SOL (' + real.toString() + ' lamports) -- it cannot pay for this sale right now');
    emptyErr.code = 'CURVE_EMPTY';
    throw emptyErr;
  }
  // tokens that buy exactly `limit` SOL: t = limit * virtualTokens / (virtualQuote - limit)
  var t = limit.mul(bc.virtualTokenReserves).div(bc.virtualQuoteReserves.sub(limit));
  if (t.isZero()) {
    var tinyErr = new Error('the curve holds almost no real SOL (' + real.toString() + ' lamports) -- it cannot pay for this sale right now');
    tinyErr.code = 'CURVE_EMPTY';
    throw tinyErr;
  }
  out.tokens = t.lt(tokensBN) ? t : tokensBN;
  out.capped = out.tokens.lt(tokensBN);
  return out;
}

function annotate(ixs, name, value) {
  try { Object.defineProperty(ixs, name, { value: value, enumerable: false, configurable: true }); } catch (e) { /* optional */ }
  return ixs;
}

// pump.fun's global settings almost never change. Only the cashback-coin builders need them
// (v3 reads what it needs on chain itself), so they are kept for CONFIG_TTL_MS and refreshed in
// the background (see warmCaches), and cleared whenever a real transaction does not go
// through (clearCaches), so changed settings can never keep failing on stale data.
var CONFIG_TTL_MS = 30000;
var configCache = { global: null, at: 0 };

function clearCaches() {
  configCache = { global: null, at: 0 };
}

async function refreshGlobal(onlineSdk) {
  var g = await onlineSdk.fetchGlobal().catch(function(e) { throw new Error('fetchGlobal failed: ' + e.message); });
  configCache = { global: g, at: Date.now() };
  return configCache;
}

async function getGlobal(onlineSdk) {
  if (configCache.global && (Date.now() - configCache.at) < CONFIG_TTL_MS) return configCache.global;
  return (await refreshGlobal(onlineSdk)).global;
}

// Called on a timer while live trading is on, so the settings are already
// in memory when a real cashback-coin buy or sell needs them.
async function warmCaches(connection) {
  // Called every 10 seconds; the settings are only fetched again once they are 15 seconds old
  // (they are good for 30).
  if (configCache.global && (Date.now() - configCache.at) < 15000) return configCache;
  return refreshGlobal(new sdk.OnlinePumpSdk(connection));
}

// Liquidity guard. For a constant-product pool, buying solIn moves the price
// by about solIn / (quote-side reserves). If that is more than maxImpactPct the
// pool is too thin for this buy and the buy is refused BEFORE anything is
// built or sent. Uses reserves the buy already reads, so it adds no lookup.
function checkBuyImpact(quoteReservesBN, solInBN, maxImpactPct) {
  if (!maxImpactPct || !quoteReservesBN || quoteReservesBN.isZero()) return;
  var impactPct = solInBN.muln(10000).div(quoteReservesBN).toNumber() / 100;
  if (impactPct > maxImpactPct) {
    var err = new Error('thin liquidity: this buy would move the price about ' + impactPct.toFixed(2) + '% (limit ' + maxImpactPct + '%) -- the pool holds about ' + (Number(quoteReservesBN.toString()) / 1e9).toFixed(2) + ' SOL');
    err.code = 'THIN_LIQUIDITY';
    throw err;
  }
}

// Pump now has coins that are not paired with SOL (USDC or another pump coin as the
// quote token). The buy instructions this bot builds only work for SOL-paired coins, and
// the chain rejects anything else with error 6063 ("Unsupported quote mint"). The coin's
// quote token is stored on the coin itself: all zeros for every SOL-paired coin. If it is
// anything else the coin is skipped before anything is built or sent.
function quoteMintOf(bc, state) {
  var q = bc && bc.quoteMint;
  if (q === undefined || q === null) q = state && state.quoteMint;
  if (q === undefined || q === null) return null;
  try { return (typeof q.toBase58 === 'function') ? q.toBase58() : String(q); } catch (e) { return null; }
}

function checkSolPaired(bc, state) {
  var q = quoteMintOf(bc, state);
  if (q === null || q === DEFAULT_KEY || q === WSOL_MINT) return;
  var err = new Error('this coin is not paired with SOL (its quote token is ' + q + ') -- the bot only trades SOL-paired coins, so it was skipped');
  err.code = 'UNSUPPORTED_QUOTE';
  err.quoteMint = q;
  throw err;
}

function pickBuybackRecipient() {
  var web3 = require('@solana/web3.js');
  var start = Math.floor(Math.random() * BUYBACK_RECIPIENTS.length);
  for (var i = 0; i < BUYBACK_RECIPIENTS.length; i++) {
    try { return new web3.PublicKey(BUYBACK_RECIPIENTS[(start + i) % BUYBACK_RECIPIENTS.length]); }
    catch (e) { /* try the next address */ }
  }
  throw new Error('no valid buyback fee recipient address');
}

// -- BUILDING A TRADE ----------------------------------------------
// Same quote, same slippage meaning (a percentage), same 15% / 95% limits as before.
// v3 needs no global or fee settings: it reads the fee schedule on chain itself, and it is
// given one of the 8 buyback recipients above.
function checkInstructions(ixs, label) {
  if (!Array.isArray(ixs) || ixs.length === 0 || !ixs.every(function(ix) { return ix && ix.programId; })) {
    throw new Error(label + ' failed: the SDK returned no usable instructions');
  }
  return ixs;
}

function tagBuiltWith(ixs, label) {
  try { Object.defineProperty(ixs, 'pumpBuiltWith', { value: label, enumerable: false, configurable: true }); } catch (e) { /* untagged is fine */ }
  return ixs;
}

// Reads the coin and the wallet's token account, and checks the coin is usable.
// fetchBuyState is used for sells too: it does not insist that the user's token account exists.
async function readCoin(connection, onlineSdk, mint, user, what) {
  var fetched = await Promise.all([
    onlineSdk.fetchBuyState(mint, user).catch(function(e) { throw new Error('fetchBuyState' + what + ' failed: ' + e.message); }),
    require('./wallet').getTokenProgramId(connection, mint).catch(function(e) { throw new Error('getTokenProgramId failed: ' + e.message); }),
  ]);
  var state = fetched[0];
  if (!state || !state.bondingCurve) {
    throw new Error('fetchBuyState' + what + ' returned no usable bondingCurve -- ' + describe('state', state));
  }
  var bc = state.bondingCurve;
  if (!bc.virtualQuoteReserves || !bc.virtualTokenReserves) {
    throw new Error('bondingCurve is missing expected reserve fields -- ' + describe('bondingCurve', bc));
  }
  return { state: state, bc: bc, tokenProgram: fetched[1] };
}

async function buildBuyInstructions(connection, mint, user, solAmountLamports, slippagePercent, maxImpactPct) {
  assertSdk();
  var onlineSdk = new sdk.OnlinePumpSdk(connection);
  var coin = await readCoin(connection, onlineSdk, mint, user, '');
  var bc = coin.bc;
  var buyState = coin.state;
  checkSolPaired(bc, buyState);

  var solAmountBN = new BN(solAmountLamports.toString());
  checkBuyImpact(bc.virtualQuoteReserves, solAmountBN, maxImpactPct);
  var amount;
  try {
    amount = quoteTokensForSol(bc, solAmountBN);
  } catch (e) {
    throw new Error(
      'quoteTokensForSol failed: ' + e.message +
      ' -- ' + describe('bondingCurve', bc) +
      ' -- ' + describe('solAmountBN', solAmountBN)
    );
  }

  var cashback = !!bc.isCashbackCoin;
  var ixs;
  try {
    if (cashback) {
      ixs = await sdk.PUMP_SDK.buyInstructions({
        global: await getGlobal(onlineSdk),
        bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
        bondingCurve: bc,
        associatedUserAccountInfo: buyState.associatedUserAccountInfo,
        mint: mint,
        user: user,
        amount: amount,
        solAmount: solAmountBN,
        slippage: slippagePercent,
        tokenProgram: coin.tokenProgram,
      });
    } else {
      ixs = await sdk.PUMP_SDK.buyV3Instructions({
        bondingCurve: bc,
        associatedUserAccountInfo: buyState.associatedUserAccountInfo,
        mint: mint,
        user: user,
        amount: amount,
        quoteAmount: solAmountBN,
        slippage: slippagePercent,
        buybackFeeRecipient: pickBuybackRecipient(),
        tokenProgram: coin.tokenProgram,
      });
    }
  } catch (e) {
    throw new Error(
      (cashback ? 'buyInstructions (cashback coin)' : 'buyV3Instructions') + ' failed: ' + e.message +
      ' -- ' + describe('amount', amount) +
      ' -- ' + describe('solAmountBN', solAmountBN) +
      ' -- ' + describe('associatedUserAccountInfo', buyState.associatedUserAccountInfo)
    );
  }
  return tagBuiltWith(checkInstructions(ixs, cashback ? 'buyInstructions' : 'buyV3Instructions'), cashback ? 'cashback' : 'v3');
}

async function buildSellInstructions(connection, mint, user, tokenAmount, slippagePercent) {
  assertSdk();
  var onlineSdk = new sdk.OnlinePumpSdk(connection);
  var coin = await readCoin(connection, onlineSdk, mint, user, ' (used for sell data)');
  var bc = coin.bc;
  var sellState = coin.state;

  if (bc.complete) {
    var gradErr = new Error('token has graduated off the bonding curve to PumpSwap');
    gradErr.code = 'GRADUATED';
    throw gradErr;
  }

  var tokenAmountBN = new BN(tokenAmount.toString());
  var asked = tokenAmountBN;
  var solAmount;
  var cap;
  try {
    cap = capSellToRealReserves(bc, tokenAmountBN);
    tokenAmountBN = cap.tokens;
    solAmount = quoteSolForTokens(bc, tokenAmountBN);
  } catch (e) {
    if (e && e.code === 'CURVE_EMPTY') throw e;
    throw new Error(
      'quoteSolForTokens failed: ' + e.message +
      ' -- ' + describe('bondingCurve', bc) +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN)
    );
  }
  var sellInfo = {
    asked: asked.toString(),
    selling: tokenAmountBN.toString(),
    capped: cap.capped,
    quoteLamports: solAmount.toString(),
    wantedLamports: cap.wanted.toString(),
    realQuoteLamports: cap.real ? cap.real.toString() : null,
    limitLamports: cap.limit ? cap.limit.toString() : null,
    virtualQuoteLamports: bc.virtualQuoteReserves.toString(),
    virtualTokens: bc.virtualTokenReserves.toString(),
    cashbackCoin: !!bc.isCashbackCoin,
  };

  var cashback = !!bc.isCashbackCoin;
  var ixs;
  try {
    if (cashback) {
      ixs = await sdk.PUMP_SDK.sellInstructions({
        global: await getGlobal(onlineSdk),
        bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
        bondingCurve: bc,
        mint: mint,
        user: user,
        amount: tokenAmountBN,
        solAmount: solAmount,
        slippage: slippagePercent,
        tokenProgram: coin.tokenProgram,
        // The SDK's regular sell (unlike its buy) does NOT read these from the bonding curve
        // itself -- they must be passed in. A mayhem-mode coin has to use the reserved fee
        // recipients, and a cashback coin needs its volume accumulator account; leaving them
        // out makes the program reject the sell ("not authorized", error 6000).
        mayhemMode: !!bc.isMayhemMode,
        cashback: true,
      });
    } else {
      ixs = await sdk.PUMP_SDK.sellV3Instructions({
        bondingCurve: bc,
        mint: mint,
        user: user,
        amount: tokenAmountBN,
        quoteAmount: solAmount,
        slippage: slippagePercent,
        tokenProgram: coin.tokenProgram,
        buybackFeeRecipient: pickBuybackRecipient(),
      });
    }
  } catch (e) {
    throw new Error(
      (cashback ? 'sellInstructions (cashback coin)' : 'sellV3Instructions') + ' failed: ' + e.message +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN) +
      ' -- ' + describe('solAmount', solAmount)
    );
  }
  var builtSell = tagBuiltWith(checkInstructions(ixs, cashback ? 'sellInstructions' : 'sellV3Instructions'), cashback ? 'cashback' : 'v3');
  // What this instruction set really sells (less than asked when the curve could not pay for all of it)
  // and the numbers behind that, read by the caller for its accounting and its log.
  annotate(builtSell, 'pumpSellAmount', tokenAmountBN.toString());
  annotate(builtSell, 'pumpSellInfo', sellInfo);
  return builtSell;
}

// Checks whether a pump.fun token has graduated off its bonding curve
// to PumpSwap. Uses the exact same fetchBuyState call buildSellInstructions
// already makes -- confirmed from six independent raw Rust account-layout
// sources that 'complete' is the real, correct field for this.
async function isGraduated(connection, mint, userPublicKey) {
  var onlineSdk = new sdk.OnlinePumpSdk(connection);
  var buyState;
  try {
    buyState = await onlineSdk.fetchBuyState(mint, userPublicKey);
  } catch (e) {
    throw new Error('fetchBuyState failed while checking graduation: ' + e.message);
  }
  if (!buyState || !buyState.bondingCurve) {
    throw new Error('fetchBuyState returned no usable bondingCurve while checking graduation -- ' + describe('buyState', buyState));
  }
  return !!buyState.bondingCurve.complete;
}

module.exports = {
  buildBuyInstructions,
  buildSellInstructions,
  quoteTokensForSol,
  quoteSolForTokens,
  capSellToRealReserves,
  SELL_RESERVE_SHARE_PCT,
  checkBuyImpact,
  isGraduated,
  warmCaches,
  clearCaches,
  setLogger,
  getStatus,
  BUYBACK_RECIPIENTS,
};
