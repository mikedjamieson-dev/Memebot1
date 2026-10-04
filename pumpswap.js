'use strict';
// -- PUMPSWAP SELL INSTRUCTION BUILDING ----------------------------
// PumpSwap is where pump.fun tokens land after graduating off their
// bonding curve. This file wraps the OFFICIAL @pump-fun/pump-swap-sdk
// package -- confirmed as the genuine package (not a look-alike) via
// npm's own registry and real pump.fun developer-channel posts.
//
// Only ever builds a sell -- we never buy an already-graduated token,
// since this bot's whole strategy is catching tokens before
// graduation. This exists purely so a token that graduates while
// we're holding it can still be sold.
//
// Honest gap: the exact call to fetch a pool's live on-chain state
// could not be fully confirmed from documentation alone -- different
// sources didn't agree, the same category of gap LetsBonk's sell side
// had. Built on the strongest available analogy (the same online/
// offline SDK split confirmed in the team's own Python SDK), with
// every step wrapped separately so a real test against a real
// graduated token will say exactly what, if anything, needs
// adjusting -- real detail, not another guess.

const { PumpAmmSdk, OnlinePumpAmmSdk, Direction } = require('@pump-fun/pump-swap-sdk');

function describe(label, value) {
  if (value === undefined) return label + '=undefined';
  if (value === null) return label + '=null';
  if (typeof value === 'object') return label + '=object{' + Object.keys(value).join(',') + '}';
  return label + '=' + typeof value + '(' + value + ')';
}

// Sells `tokenAmount` of `mint` on PumpSwap, for `user`. Returns a
// plain array of instructions -- nothing sent, nothing signed here.
async function buildSellInstructions(connection, mint, userPublicKey, tokenAmount, slippagePercent) {
  var onlineSdk;
  try {
    onlineSdk = new OnlinePumpAmmSdk(connection);
  } catch (e) {
    throw new Error('OnlinePumpAmmSdk construction failed: ' + e.message);
  }

  var pool;
  try {
    pool = await onlineSdk.fetchPoolForMint(mint);
  } catch (e) {
    throw new Error(
      'fetchPoolForMint failed: ' + e.message +
      ' -- this token may not have a PumpSwap pool, or the real fetch method has a different name than assumed'
    );
  }
  if (!pool) {
    throw new Error('fetchPoolForMint returned nothing -- this token may not actually be graduated to PumpSwap');
  }

  var offlineSdk = new PumpAmmSdk();
  try {
    var instructions = await offlineSdk.swapInstructions(
      pool,
      Direction.BaseToQuote,
      tokenAmount,
      slippagePercent,
      userPublicKey
    );
    if (!Array.isArray(instructions)) {
      throw new Error('swapInstructions did not return an array -- ' + describe('result', instructions));
    }
    return instructions;
  } catch (e) {
    throw new Error(
      'swapInstructions failed: ' + e.message +
      ' -- ' + describe('pool', pool) +
      ' -- tokenAmount=' + tokenAmount
    );
  }
}

module.exports = {
  buildSellInstructions,
};
