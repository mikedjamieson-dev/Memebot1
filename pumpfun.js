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
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
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

async function buildBuyInstructions(connection, mint, user, solAmountLamports, slippagePercent) {
  var sdk = new OnlinePumpSdk(connection);

  var global;
  try {
    global = await sdk.fetchGlobal();
  } catch (e) {
    throw new Error('fetchGlobal failed: ' + e.message);
  }

  var buyState;
  try {
    buyState = await sdk.fetchBuyState(mint, user);
  } catch (e) {
    throw new Error('fetchBuyState failed: ' + e.message);
  }
  if (!buyState || !buyState.bondingCurve) {
    throw new Error('fetchBuyState returned no usable bondingCurve -- ' + describe('buyState', buyState));
  }
  var bc = buyState.bondingCurve;
  if (!bc.virtualQuoteReserves || !bc.virtualTokenReserves) {
    throw new Error('bondingCurve is missing expected reserve fields -- ' + describe('bondingCurve', bc));
  }

  var solAmountBN = new BN(solAmountLamports.toString());
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
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: bc,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint: mint,
      user: user,
      amount: amount,
      solAmount: solAmountBN,
      slippage: slippagePercent,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
  } catch (e) {
    throw new Error(
      'buyInstructions failed: ' + e.message +
      ' -- ' + describe('amount', amount) +
      ' -- ' + describe('solAmountBN', solAmountBN) +
      ' -- ' + describe('associatedUserAccountInfo', buyState.associatedUserAccountInfo)
    );
  }
}

async function buildSellInstructions(connection, mint, user, tokenAmount, slippagePercent) {
  var sdk = new OnlinePumpSdk(connection);

  var global;
  try {
    global = await sdk.fetchGlobal();
  } catch (e) {
    throw new Error('fetchGlobal failed: ' + e.message);
  }

  var sellState;
  try {
    sellState = await sdk.fetchSellState(mint, user);
  } catch (e) {
    throw new Error('fetchSellState failed: ' + e.message);
  }
  if (!sellState || !sellState.bondingCurve) {
    throw new Error('fetchSellState returned no usable bondingCurve -- ' + describe('sellState', sellState));
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
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: bc,
      mint: mint,
      user: user,
      amount: tokenAmountBN,
      solAmount: solAmount,
      slippage: slippagePercent,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
  } catch (e) {
    throw new Error(
      'sellInstructions failed: ' + e.message +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN) +
      ' -- ' + describe('solAmount', solAmount)
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
  isGraduated,
};
