'use strict';
// -- PUMP.FUN BUY/SELL INSTRUCTION BUILDING -----------------------
// Thin wrapper around the OFFICIAL @pump-fun/pump-sdk package.
// This file only ever builds instructions -- it never sends, signs,
// or confirms anything. That stays entirely in execution.js, using
// logic we built and tested ourselves.
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

const { OnlinePumpSdk, PUMP_SDK } = require('@pump-fun/pump-sdk');
const BN = require('bn.js');

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
  return refreshConfigs(new OnlinePumpSdk(connection));
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

async function buildBuyInstructions(connection, mint, user, solAmountLamports, slippagePercent, maxImpactPct) {
  var sdk = new OnlinePumpSdk(connection);

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
    return await PUMP_SDK.buyInstructions({
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

async function buildSellInstructions(connection, mint, user, tokenAmount, slippagePercent) {
  var sdk = new OnlinePumpSdk(connection);

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
    return await PUMP_SDK.sellInstructions({
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

// Checks whether a pump.fun token has graduated off its bonding curve
// to PumpSwap. Uses the exact same fetchSellState call buildSellInstructions
// already makes -- confirmed from six independent raw Rust account-layout
// sources that 'complete' is the real, correct field for this.
async function isGraduated(connection, mint, userPublicKey) {
  var sdk = new OnlinePumpSdk(connection);
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
};
