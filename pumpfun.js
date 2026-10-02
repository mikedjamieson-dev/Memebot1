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

const { PumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// Builds the instructions to spend `solAmountLamports` buying `mint`,
// for `user` (a PublicKey), with `slippagePercent` protection (e.g.
// 15 for 15%). Returns a plain array of instructions -- nothing sent.
async function buildBuyInstructions(connection, mint, user, solAmountLamports, slippagePercent) {
  var sdk = new PumpSdk(connection);
  var global = await sdk.fetchGlobal();
  var buyState = await sdk.fetchBuyState(mint, user);
  var amount = getBuyTokenAmountFromSolAmount(global, buyState.bondingCurve, solAmountLamports);

  return sdk.buyInstructions({
    global: global,
    bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
    bondingCurve: buyState.bondingCurve,
    associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint: mint,
    user: user,
    amount: amount,
    solAmount: solAmountLamports,
    slippage: slippagePercent,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

// Builds the instructions to sell `tokenAmount` of `mint`, for `user`,
// with `slippagePercent` protection. Returns a plain array of
// instructions -- nothing sent.
async function buildSellInstructions(connection, mint, user, tokenAmount, slippagePercent) {
  var sdk = new PumpSdk(connection);
  var global = await sdk.fetchGlobal();
  var sellState = await sdk.fetchSellState(mint, user);
  var solAmount = getSellSolAmountFromTokenAmount(global, sellState.bondingCurve, tokenAmount);

  return sdk.sellInstructions({
    global: global,
    bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
    bondingCurve: sellState.bondingCurve,
    mint: mint,
    user: user,
    amount: tokenAmount,
    solAmount: solAmount,
    slippage: slippagePercent,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

module.exports = {
  buildBuyInstructions,
  buildSellInstructions,
};
