'use strict';
// -- PUMP.FUN BUY/SELL INSTRUCTION BUILDING -----------------------
// Thin wrapper around the OFFICIAL @pump-fun/pump-sdk package.
// This file only ever builds instructions -- it never sends, signs,
// or confirms anything. That stays entirely in execution.js, using
// logic we built and tested ourselves.
//
// TWO WAYS TO BUILD A TRADE, ONE SAFETY NET
//   1. v3 (preferred): the newer, smaller buy/sell instructions from
//      @pump-fun/pump-sdk 4.1.0 (buyV3Instructions / sellV3Instructions).
//   2. The proven path: the 3.2.0 buy/sell builders this bot traded with
//      before, kept installed under the name "pump-sdk-legacy".
// A trade is built with v3 first. If v3 cannot be built, that one trade is
// built the proven way instead. If a v3 trade is then rejected by the chain
// (see noteTradeResult), v3 is switched off until the bot restarts and every
// trade uses the proven path. Nothing here can make a trade that worked before
// stop working: the proven path is always there.
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
const sdkMain = require('@pump-fun/pump-sdk');
var sdkBackup = null;
try { sdkBackup = require('pump-sdk-legacy'); } catch (e) { sdkBackup = null; }
// The proven builders: the backup 3.2.0 copy when it is installed, otherwise the main SDK's own.
const legacySdk = sdkBackup || sdkMain;

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

var hasV3 = !!(sdkMain && sdkMain.OnlinePumpSdk && sdkMain.PUMP_SDK &&
  typeof sdkMain.PUMP_SDK.buyV3Instructions === 'function' &&
  typeof sdkMain.PUMP_SDK.sellV3Instructions === 'function');

// enabled: v3 is used for new trades. failures: v3 trades rejected on chain in a row.
// confirmedOnce: a v3 trade has landed at least once since the bot started.
var v3 = { enabled: hasV3, failures: 0, confirmedOnce: false, announced: false };

var logger = function() {};
function setLogger(fn) { logger = (typeof fn === 'function') ? fn : function() {}; }
function say(msg, type) { try { logger(msg, type || 'info'); } catch (e) { /* logging must never break a trade */ } }

function getStatus() {
  return { v3Available: hasV3, v3Enabled: v3.enabled, hasBackupSdk: !!sdkBackup, v3ConfirmedOnce: v3.confirmedOnce };
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

// pump.fun's global settings and fee configuration almost never change, but
// they used to be fetched from the chain on every single buy and sell. They
// are now kept for CONFIG_TTL_MS and refreshed in the background (see
// warmCaches), and cleared whenever a real transaction does not go through
// (clearCaches), so a changed fee setup can never keep failing on stale data.
// Only the proven (legacy) builders use these; v3 reads what it needs itself.
var CONFIG_TTL_MS = 30000;
var configCache = { global: null, feeConfig: null, at: 0 };

function clearCaches() {
  configCache = { global: null, feeConfig: null, at: 0 };
}

async function refreshConfigs(sdk) {
  var fetched = await Promise.all([
    sdk.fetchGlobal().catch(function(e) { throw new Error('fetchGlobal failed: ' + e.message); }),
    sdk.fetchFeeConfig().catch(function(e) { throw new Error('fetchFeeConfig failed: ' + e.message); }),
  ]);
  configCache = { global: fetched[0], feeConfig: fetched[1], at: Date.now() };
  return configCache;
}

async function getConfigs(sdk) {
  if (configCache.global && configCache.feeConfig && (Date.now() - configCache.at) < CONFIG_TTL_MS) return configCache;
  return refreshConfigs(sdk);
}

// Called on a timer while live trading is on, so the settings are already
// in memory when a real buy or sell needs them.
async function warmCaches(connection) {
  // Called every 10 seconds; the settings are only fetched again once they are 15 seconds old
  // (they are good for 30), which halves these background requests.
  if (configCache.global && configCache.feeConfig && (Date.now() - configCache.at) < 15000) return configCache;
  return refreshConfigs(new legacySdk.OnlinePumpSdk(connection));
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

// -- THE PROVEN PATH (SDK 3.2.0 builders) --------------------------
async function buildBuyLegacy(connection, mint, user, solAmountLamports, slippagePercent, maxImpactPct) {
  var sdk = new legacySdk.OnlinePumpSdk(connection);

  // The lookups below do not depend on each other, so they run at the
  // same time instead of one after another.
  var fetched = await Promise.all([
    getConfigs(sdk),
    sdk.fetchBuyState(mint, user).catch(function(e) { throw new Error('fetchBuyState failed: ' + e.message); }),
    require('./wallet').getTokenProgramId(connection, mint).catch(function(e) { throw new Error('getTokenProgramId failed: ' + e.message); }),
  ]);
  var global = fetched[0].global;
  var feeConfig = fetched[0].feeConfig;
  var buyState = fetched[1];
  var tokenProgram = fetched[2];
  if (!buyState || !buyState.bondingCurve) {
    throw new Error('fetchBuyState returned no usable bondingCurve -- ' + describe('buyState', buyState));
  }
  var bc = buyState.bondingCurve;
  if (!bc.virtualQuoteReserves || !bc.virtualTokenReserves) {
    throw new Error('bondingCurve is missing expected reserve fields -- ' + describe('bondingCurve', bc));
  }
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

  try {
    return await legacySdk.PUMP_SDK.buyInstructions({
      global: global,
      feeConfig: feeConfig,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: bc,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint: mint,
      user: user,
      amount: amount,
      solAmount: solAmountBN,
      slippage: slippagePercent,
      tokenProgram: tokenProgram,
    });
  } catch (e) {
    throw new Error(
      'buyInstructions failed: ' + e.message +
      ' -- ' + describe('amount', amount) +
      ' -- ' + describe('solAmountBN', solAmountBN) +
      ' -- ' + describe('associatedUserAccountInfo', buyState.associatedUserAccountInfo) +
      ' -- ' + describe('feeConfig', feeConfig)
    );
  }
}

async function buildSellLegacy(connection, mint, user, tokenAmount, slippagePercent) {
  var sdk = new legacySdk.OnlinePumpSdk(connection);

  // Uses fetchBuyState, not fetchSellState -- the sell call below only
  // ever reads bondingCurve and bondingCurveAccountInfo, both of which
  // fetchBuyState also returns, and fetchBuyState doesn't gate on the
  // user's associated token account already existing. fetchSellState
  // does gate on that, which is a real, documented SDK behavior that
  // has nothing to do with the data actually needed here.
  // The lookups run at the same time instead of one after another.
  var fetched = await Promise.all([
    getConfigs(sdk),
    sdk.fetchBuyState(mint, user).catch(function(e) { throw new Error('fetchBuyState (used for sell data) failed: ' + e.message); }),
    require('./wallet').getTokenProgramId(connection, mint).catch(function(e) { throw new Error('getTokenProgramId failed: ' + e.message); }),
  ]);
  var global = fetched[0].global;
  var feeConfig = fetched[0].feeConfig;
  var sellState = fetched[1];
  var tokenProgram = fetched[2];
  if (!sellState || !sellState.bondingCurve) {
    throw new Error('fetchBuyState (used for sell data) returned no usable bondingCurve -- ' + describe('sellState', sellState));
  }
  var bc = sellState.bondingCurve;
  if (!bc.virtualQuoteReserves || !bc.virtualTokenReserves) {
    throw new Error('bondingCurve is missing expected reserve fields -- ' + describe('bondingCurve', bc));
  }

  if (bc.complete) {
    var gradErr = new Error('token has graduated off the bonding curve to PumpSwap');
    gradErr.code = 'GRADUATED';
    throw gradErr;
  }

  var tokenAmountBN = new BN(tokenAmount.toString());
  var solAmount;
  try {
    solAmount = quoteSolForTokens(bc, tokenAmountBN);
  } catch (e) {
    throw new Error(
      'quoteSolForTokens failed: ' + e.message +
      ' -- ' + describe('bondingCurve', bc) +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN)
    );
  }

  try {
    return await legacySdk.PUMP_SDK.sellInstructions({
      global: global,
      feeConfig: feeConfig,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: bc,
      mint: mint,
      user: user,
      amount: tokenAmountBN,
      solAmount: solAmount,
      slippage: slippagePercent,
      tokenProgram: tokenProgram,
      // The SDK's sell (unlike its buy) does NOT read these from the bonding
      // curve itself -- they must be passed in. A mayhem-mode coin has to use
      // the reserved fee recipients, and a cashback coin needs its volume
      // accumulator account; leaving them out makes the program reject the
      // sell ("not authorized", error 6000).
      mayhemMode: !!bc.isMayhemMode,
      cashback: !!bc.isCashbackCoin,
    });
  } catch (e) {
    throw new Error(
      'sellInstructions failed: ' + e.message +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN) +
      ' -- ' + describe('solAmount', solAmount) +
      ' -- ' + describe('feeConfig', feeConfig)
    );
  }
}

// -- THE v3 PATH (SDK 4.1.0 builders) ------------------------------
// Same quote, same slippage meaning (a percentage), same 15% / 95% limits as before.
// v3 needs no global or fee settings: it reads the fee schedule on chain itself, and it is
// given one of the 8 buyback recipients above.
function useLegacyError(why) {
  var e = new Error(why);
  e.code = 'USE_LEGACY';
  return e;
}

function checkInstructions(ixs, label) {
  if (!Array.isArray(ixs) || ixs.length === 0 || !ixs.every(function(ix) { return ix && ix.programId; })) {
    throw new Error(label + ' failed: the SDK returned no usable instructions');
  }
  return ixs;
}

async function buildBuyV3(connection, mint, user, solAmountLamports, slippagePercent, maxImpactPct) {
  var sdk = new sdkMain.OnlinePumpSdk(connection);
  var fetched = await Promise.all([
    sdk.fetchBuyState(mint, user).catch(function(e) { throw new Error('fetchBuyState failed: ' + e.message); }),
    require('./wallet').getTokenProgramId(connection, mint).catch(function(e) { throw new Error('getTokenProgramId failed: ' + e.message); }),
  ]);
  var buyState = fetched[0];
  var tokenProgram = fetched[1];
  if (!buyState || !buyState.bondingCurve) {
    throw new Error('fetchBuyState returned no usable bondingCurve -- ' + describe('buyState', buyState));
  }
  var bc = buyState.bondingCurve;
  if (!bc.virtualQuoteReserves || !bc.virtualTokenReserves) {
    throw new Error('bondingCurve is missing expected reserve fields -- ' + describe('bondingCurve', bc));
  }
  checkSolPaired(bc, buyState);
  // v3 refuses cashback coins; the proven path handles them.
  if (bc.isCashbackCoin) throw useLegacyError('cashback coin -- built the proven way');

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

  var ixs;
  try {
    ixs = await sdkMain.PUMP_SDK.buyV3Instructions({
      bondingCurve: bc,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint: mint,
      user: user,
      amount: amount,
      quoteAmount: solAmountBN,
      slippage: slippagePercent,
      buybackFeeRecipient: pickBuybackRecipient(),
      tokenProgram: tokenProgram,
    });
  } catch (e) {
    throw new Error(
      'buyV3Instructions failed: ' + e.message +
      ' -- ' + describe('amount', amount) +
      ' -- ' + describe('solAmountBN', solAmountBN) +
      ' -- ' + describe('associatedUserAccountInfo', buyState.associatedUserAccountInfo)
    );
  }
  return checkInstructions(ixs, 'buyV3Instructions');
}

async function buildSellV3(connection, mint, user, tokenAmount, slippagePercent) {
  var sdk = new sdkMain.OnlinePumpSdk(connection);
  // fetchBuyState is used for sell data too, as in the proven path: it does not insist that
  // the user's token account is found under the default token program.
  var fetched = await Promise.all([
    sdk.fetchBuyState(mint, user).catch(function(e) { throw new Error('fetchBuyState (used for sell data) failed: ' + e.message); }),
    require('./wallet').getTokenProgramId(connection, mint).catch(function(e) { throw new Error('getTokenProgramId failed: ' + e.message); }),
  ]);
  var sellState = fetched[0];
  var tokenProgram = fetched[1];
  if (!sellState || !sellState.bondingCurve) {
    throw new Error('fetchBuyState (used for sell data) returned no usable bondingCurve -- ' + describe('sellState', sellState));
  }
  var bc = sellState.bondingCurve;
  if (!bc.virtualQuoteReserves || !bc.virtualTokenReserves) {
    throw new Error('bondingCurve is missing expected reserve fields -- ' + describe('bondingCurve', bc));
  }

  if (bc.complete) {
    var gradErr = new Error('token has graduated off the bonding curve to PumpSwap');
    gradErr.code = 'GRADUATED';
    throw gradErr;
  }
  if (bc.isCashbackCoin) throw useLegacyError('cashback coin -- built the proven way');

  var tokenAmountBN = new BN(tokenAmount.toString());
  var solAmount;
  try {
    solAmount = quoteSolForTokens(bc, tokenAmountBN);
  } catch (e) {
    throw new Error(
      'quoteSolForTokens failed: ' + e.message +
      ' -- ' + describe('bondingCurve', bc) +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN)
    );
  }

  var ixs;
  try {
    ixs = await sdkMain.PUMP_SDK.sellV3Instructions({
      bondingCurve: bc,
      mint: mint,
      user: user,
      amount: tokenAmountBN,
      quoteAmount: solAmount,
      slippage: slippagePercent,
      tokenProgram: tokenProgram,
      buybackFeeRecipient: pickBuybackRecipient(),
    });
  } catch (e) {
    throw new Error(
      'sellV3Instructions failed: ' + e.message +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN) +
      ' -- ' + describe('solAmount', solAmount)
    );
  }
  return checkInstructions(ixs, 'sellV3Instructions');
}

// -- CHOOSING THE PATH ---------------------------------------------
// Errors that mean "do not trade this coin right now": they are passed straight on, never
// retried on the other path.
function isBusinessError(e) {
  return !!(e && (e.code === 'THIN_LIQUIDITY' || e.code === 'UNSUPPORTED_QUOTE' || e.code === 'GRADUATED'));
}

// An error that says the NEW SDK could not build the trade (as opposed to a network hiccup
// reading the chain, which would fail the same way on the proven path and must not double the wait).
function isSdkBuildProblem(e) {
  if (e instanceof TypeError || e instanceof ReferenceError) return true;
  var m = String((e && e.message) || '');
  if (/^(buyV3Instructions|sellV3Instructions) failed/.test(m)) return true;
  return /returned no usable|missing expected reserve fields|no valid buyback|cannot read prop|is not a function|is not a constructor|is not defined|not iterable|undefined/i.test(m);
}

function tagBuiltWith(ixs, label) {
  try { Object.defineProperty(ixs, 'pumpBuiltWith', { value: label, enumerable: false, configurable: true }); } catch (e) { /* untagged is fine */ }
  return ixs;
}

async function buildWithFallback(kind, buildV3Fn, buildLegacyFn) {
  if (v3.enabled) {
    try {
      var ixs = await buildV3Fn();
      if (!v3.announced) {
        v3.announced = true;
        say('PUMP SDK: building trades with the new v3 instructions' + (sdkBackup ? ' (the 3.2.0 buy and sell stay ready as a backup)' : ' (no backup SDK is installed)'), 'info');
      }
      return tagBuiltWith(ixs, 'v3');
    } catch (e) {
      if (isBusinessError(e)) throw e;
      if (e && e.code === 'USE_LEGACY') {
        // Not a problem: v3 simply does not cover this kind of coin.
      } else if (isSdkBuildProblem(e)) {
        say('PUMP SDK: the v3 ' + kind + ' could not be built (' + String(e.message).slice(0, 140) + ') -- building this ' + kind + ' the proven way instead', 'warn');
      } else {
        throw e;
      }
    }
  }
  return tagBuiltWith(await buildLegacyFn(), 'legacy');
}

async function buildBuyInstructions(connection, mint, user, solAmountLamports, slippagePercent, maxImpactPct) {
  return buildWithFallback('buy',
    function() { return buildBuyV3(connection, mint, user, solAmountLamports, slippagePercent, maxImpactPct); },
    function() { return buildBuyLegacy(connection, mint, user, solAmountLamports, slippagePercent, maxImpactPct); });
}

async function buildSellInstructions(connection, mint, user, tokenAmount, slippagePercent) {
  return buildWithFallback('sell',
    function() { return buildSellV3(connection, mint, user, tokenAmount, slippagePercent); },
    function() { return buildSellLegacy(connection, mint, user, tokenAmount, slippagePercent); });
}

// -- WATCHING v3 ON CHAIN --------------------------------------------
// Called by the bot after every real pump.fun trade with what the chain said. A v3 trade
// that lands resets the count. A v3 trade the program rejects for a reason that is not the
// ordinary price-moved kind counts as a v3 failure: after 2 in a row -- or after the very
// first one, if no v3 trade has ever landed yet -- v3 is switched off until the bot restarts
// and every trade goes the proven way.
var NOT_A_V3_FAULT_CODES = { 6002: true, 6003: true, 6005: true, 6020: true, 6040: true, 6042: true };

function isV3Fault(errText) {
  var t = String(errText || '');
  if (!/InstructionError/i.test(t)) return false;
  var m = /"?Custom"?\s*:\s*(\d+)/.exec(t);
  if (m && NOT_A_V3_FAULT_CODES[parseInt(m[1], 10)]) return false;
  return true;
}

function noteTradeResult(ixs, outcome, errText) {
  if (!ixs || ixs.pumpBuiltWith !== 'v3') return;
  if (outcome === 'CONFIRMED') {
    v3.failures = 0;
    if (!v3.confirmedOnce) {
      v3.confirmedOnce = true;
      say('PUMP SDK: the first v3 trade landed on chain -- v3 buys and sells are working', 'win');
    }
    return;
  }
  if (!isV3Fault(errText)) return;
  v3.failures++;
  var limit = v3.confirmedOnce ? 2 : 1;
  if (v3.enabled && v3.failures >= limit) {
    v3.enabled = false;
    say('PUMP SDK: a v3 trade was rejected by the chain (' + String(errText).slice(0, 140) + ') -- switching back to the proven 3.2.0 buy and sell until the bot restarts', 'warn');
  }
}

// Checks whether a pump.fun token has graduated off its bonding curve
// to PumpSwap. Uses the exact same fetchBuyState call buildSellInstructions
// already makes -- confirmed from six independent raw Rust account-layout
// sources that 'complete' is the real, correct field for this.
async function isGraduated(connection, mint, userPublicKey) {
  var sdk = new (v3.enabled ? sdkMain : legacySdk).OnlinePumpSdk(connection);
  var buyState;
  try {
    buyState = await sdk.fetchBuyState(mint, userPublicKey);
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
  checkBuyImpact,
  isGraduated,
  warmCaches,
  clearCaches,
  setLogger,
  noteTradeResult,
  getStatus,
  BUYBACK_RECIPIENTS,
};
