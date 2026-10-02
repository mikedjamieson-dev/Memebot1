'use strict';
// -- PUMP.FUN BUY/SELL INSTRUCTION BUILDING -----------------------
// Thin wrapper around the OFFICIAL @pump-fun/pump-sdk package.
// This file only ever builds instructions -- it never sends, signs,
// or confirms anything. That stays entirely in execution.js, using
// logic we built and tested ourselves. The SDK's only job is
// correctly reading the current on-chain state (accounts, fees,
// creator vault) and handing back the right instructions, since
// that's the part pump.fun has changed before and could change
// again -- everything after "here are the instructions" is ours.
//
// Slippage protection is built directly into these instructions by
// the SDK itself (maxSolCost on a buy, minSolOutput on a sell) --
// not something this wrapper calculates by hand.
//
// Every step below is wrapped separately on purpose. The same
// "Cannot read properties of undefined (reading 'eq')" error
// happened even after the BN fix, which means something else in the
// chain is undefined somewhere we haven't pinned down yet, and this
// environment can't install the real library to inspect it directly.
// Rather than guess again, each step now reports exactly which step
// failed and what shape the real data actually had -- field names,
// whether something is a BN instance, whether something is null --
// never the trading wallet's key or anything sensitive, since all of
// this is just public on-chain token data.

const { OnlinePumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const BN = require('bn.js');

function describe(label, value) {
  if (value === undefined) return label + '=undefined';
  if (value === null) return label + '=null';
  if (value instanceof BN) return label + '=BN(' + value.toString() + ')';
  if (typeof value === 'object') return label + '=object{' + Object.keys(value).join(',') + '}';
  return label + '=' + typeof value + '(' + value + ')';
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

  var solAmountBN = new BN(solAmountLamports.toString());
  var amount;
  try {
    amount = getBuyTokenAmountFromSolAmount(global, buyState.bondingCurve, solAmountBN);
  } catch (e) {
    throw new Error(
      'getBuyTokenAmountFromSolAmount failed: ' + e.message +
      ' -- ' + describe('global', global) +
      ' -- ' + describe('bondingCurve', buyState.bondingCurve) +
      ' -- ' + describe('solAmountBN', solAmountBN)
    );
  }

  try {
    return await sdk.buyInstructions({
      global: global,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: buyState.bondingCurve,
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

  var tokenAmountBN = new BN(tokenAmount.toString());
  var solAmount;
  try {
    solAmount = getSellSolAmountFromTokenAmount(global, sellState.bondingCurve, tokenAmountBN);
  } catch (e) {
    throw new Error(
      'getSellSolAmountFromTokenAmount failed: ' + e.message +
      ' -- ' + describe('global', global) +
      ' -- ' + describe('bondingCurve', sellState.bondingCurve) +
      ' -- ' + describe('tokenAmountBN', tokenAmountBN)
    );
  }

  try {
    return await sdk.sellInstructions({
      global: global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
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

module.exports = {
  buildBuyInstructions,
  buildSellInstructions,
};
