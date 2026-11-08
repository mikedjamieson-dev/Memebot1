'use strict';
// -- PUMPSWAP SELL INSTRUCTION BUILDING ----------------------------
// PumpSwap is where pump.fun coins go after graduating off their bonding curve. This file only builds
// a SELL there (the bot never buys a graduated coin), so a coin that graduates while it is held can
// still be sold. It never sends, signs or confirms anything; that stays in execution.js.
//
// Written from the real code of the installed @pump-fun/pump-swap-sdk 2.1.0 (read from the bot's own
// /api/library-info page), not from documents:
//   1. canonicalPumpPoolPda(mint)            -- the coin's SOL pool address (worked out locally, no request)
//   2. OnlinePumpAmmSdk.swapSolanaState(...)  -- reads the pool, its two balances, the coin and the
//                                               wallet's token accounts
//   3. PUMP_AMM_SDK.sellBaseInput(state, amount, slippage, { v2: true })
//                                             -- works out the minimum SOL out (slippage is a percentage,
//                                               as everywhere else in the bot) and builds the sell. The
//                                               library uses the newer v2 sell when the pool supports it
//                                               and its regular sell otherwise (cashback coins), by itself.
// The one step not shown on the library page is how the online reader is created; it is created the
// documented way (new OnlinePumpAmmSdk(connection)). The free "TEST PUMPSWAP SELL" button proves it on a
// real graduated coin before any real sale depends on it.

const BN = require('bn.js');
const swap = require('@pump-fun/pump-swap-sdk');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function describe(label, value) {
  if (value === undefined) return label + '=undefined';
  if (value === null) return label + '=null';
  if (value instanceof BN) return label + '=BN(' + value.toString() + ')';
  if (typeof value === 'object') return label + '=object{' + Object.keys(value).join(',') + '}';
  return label + '=' + typeof value + '(' + value + ')';
}

function asPublicKey(v) {
  var web3 = require('@solana/web3.js');
  if (Array.isArray(v)) v = v[0];              // some helpers return [address, bump]
  if (v && v.publicKey) v = v.publicKey;       // others return { publicKey }
  if (v instanceof web3.PublicKey) return v;
  if (v && typeof v.toBase58 === 'function') return new web3.PublicKey(v.toBase58());
  return new web3.PublicKey(v);
}

// Every part of the library this file calls must exist. A missing one means the wrong version is
// installed, and that is said plainly instead of failing somewhere deeper.
function missingSdkParts() {
  var missing = [];
  if (!swap) return ['@pump-fun/pump-swap-sdk'];
  if (typeof swap.canonicalPumpPoolPda !== 'function') missing.push('canonicalPumpPoolPda');
  if (typeof swap.OnlinePumpAmmSdk !== 'function') missing.push('OnlinePumpAmmSdk');
  else if (typeof swap.OnlinePumpAmmSdk.prototype.swapSolanaState !== 'function') missing.push('OnlinePumpAmmSdk.swapSolanaState');
  if (!swap.PUMP_AMM_SDK || typeof swap.PUMP_AMM_SDK.sellBaseInput !== 'function') missing.push('PUMP_AMM_SDK.sellBaseInput');
  return missing;
}

// The coin's PumpSwap pool (the SOL pool pump.fun creates when a coin graduates).
function poolAddressFor(mint) {
  return asPublicKey(swap.canonicalPumpPoolPda(asPublicKey(mint)));
}

// Sells `tokenAmount` (raw units) of `mint` on PumpSwap for `userPublicKey`. Returns a plain array of
// instructions -- nothing sent, nothing signed here.
async function buildSellInstructions(connection, mint, userPublicKey, tokenAmount, slippagePercent) {
  var missing = missingSdkParts();
  if (missing.length) throw new Error('the installed @pump-fun/pump-swap-sdk is missing ' + missing.join(', ') + ' -- the wrong version is installed');

  var mintPk = asPublicKey(mint);
  var poolKey;
  try {
    poolKey = poolAddressFor(mintPk);
  } catch (e) {
    throw new Error('canonicalPumpPoolPda failed: ' + e.message);
  }

  var state;
  try {
    var online = new swap.OnlinePumpAmmSdk(connection);
    state = await online.swapSolanaState(poolKey, userPublicKey);
  } catch (e) {
    throw new Error('swapSolanaState failed for pool ' + poolKey.toBase58() + ': ' + e.message +
      ' -- this coin may not have a PumpSwap pool yet (graduation can take a few seconds)');
  }
  if (!state || !state.pool) {
    throw new Error('swapSolanaState returned no pool -- ' + describe('state', state));
  }
  var quoteMint = state.pool.quoteMint ? asPublicKey(state.pool.quoteMint).toBase58() : null;
  if (quoteMint !== WSOL_MINT) {
    var qErr = new Error('the PumpSwap pool for this coin is not paired with SOL (its quote token is ' + quoteMint + ')');
    qErr.code = 'UNSUPPORTED_QUOTE';
    throw qErr;
  }

  var amountBN = new BN(String(tokenAmount));
  var ixs;
  try {
    ixs = await swap.PUMP_AMM_SDK.sellBaseInput(state, amountBN, slippagePercent, { v2: true });
  } catch (e) {
    throw new Error('sellBaseInput failed: ' + e.message + ' -- ' + describe('amount', amountBN) + ' -- slippage ' + slippagePercent + '%');
  }
  if (!Array.isArray(ixs) || ixs.length === 0 || !ixs.every(function(ix) { return ix && ix.programId; })) {
    throw new Error('sellBaseInput returned no usable instructions -- ' + describe('result', ixs));
  }
  var v2 = typeof swap.supportsTradeV2 === 'function' ? !!swap.supportsTradeV2(state.pool) : null;
  try { Object.defineProperty(ixs, 'pumpBuiltWith', { value: v2 === false ? 'pumpswap' : 'pumpswap-v2', enumerable: false, configurable: true }); } catch (e) { /* untagged is fine */ }
  return ixs;
}

module.exports = {
  buildSellInstructions,
  poolAddressFor,
};
