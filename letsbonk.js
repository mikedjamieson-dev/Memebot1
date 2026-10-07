'use strict';
// -- LETSBONK BUY/SELL INSTRUCTION BUILDING ------------------------
// LetsBonk runs on Raydium's own "LaunchLab" program. This file wraps
// the OFFICIAL @raydium-io/raydium-sdk-v2 package the same way
// pumpfun.js wraps the pump.fun SDK: it only ever builds something we
// can extract plain instructions from -- it never signs or sends
// anything. All of that stays in execution.js, using logic we built
// and tested ourselves.
//
// One real architectural difference from pump.fun, confirmed directly
// from Raydium's own official demo code: buyToken()/sellToken() don't
// hand back plain instructions -- they hand back a whole built
// transaction, plus a convenience execute() function that would send
// it using RAYDIUM'S OWN logic. We deliberately never call that
// execute(). Instead we request a LEGACY (not versioned) transaction
// specifically because a legacy transaction exposes a plain, directly
// reusable .instructions array -- a versioned one stores compiled
// instructions referencing account indices, which isn't something we
// can cleanly pull back apart. We take that plain instructions array
// and feed it into our own flow exactly like pump.fun's instructions.
//
// The sell side's exact parameter list was confirmed to exist and be
// used this way in a real bug report, but not from a complete real
// example file the way buy was. Every step here is wrapped separately
// so a real test against a real token will tell us immediately, with
// real detail, if anything about that side needs adjusting.

const { Raydium, TxVersion, LAUNCHPAD_PROGRAM, getPdaLaunchpadPoolId, PlatformConfig } = require('@raydium-io/raydium-sdk-v2');
const { NATIVE_MINT } = require('@solana/spl-token');
const { PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');

function describe(label, value) {
  if (value === undefined) return label + '=undefined';
  if (value === null) return label + '=null';
  if (value instanceof BN) return label + '=BN(' + value.toString() + ')';
  if (typeof value === 'object') return label + '=object{' + Object.keys(value).join(',') + '}';
  return label + '=' + typeof value + '(' + value + ')';
}

// Gathers everything buyToken/sellToken need: the pool's own current
// state, its platform's fee configuration, both mints' info, and the
// current network epoch. Shared by both buy and sell since both need
// the same context.
// Things that rarely or never change are remembered instead of being looked
// up on-chain for every buy and sell: a token's own info (the same token is
// sold right after it was bought), the platform's fee settings, and the
// epoch info (changes about once every two days). All are short-lived or
// per-token, and cleared by clearCaches() whenever a real transaction fails.
var TOKEN_INFO_TTL_MS = 600000;
var PLATFORM_TTL_MS = 300000;
var EPOCH_TTL_MS = 20000;
var tokenInfoCache = new Map();
var platformCache = new Map();
var epochCache = { info: null, at: 0 };

function clearCaches() {
  tokenInfoCache = new Map();
  platformCache = new Map();
  epochCache = { info: null, at: 0 };
}

async function cachedTokenInfo(raydium, mint) {
  var key = mint.toBase58();
  var hit = tokenInfoCache.get(key);
  if (hit && (Date.now() - hit.at) < TOKEN_INFO_TTL_MS) return hit.info;
  var info = await raydium.token.getTokenInfo(mint);
  tokenInfoCache.set(key, { info: info, at: Date.now() });
  return info;
}

async function cachedEpochInfo(raydium) {
  if (epochCache.info && (Date.now() - epochCache.at) < EPOCH_TTL_MS) return epochCache.info;
  var info = await raydium.connection.getEpochInfo();
  epochCache = { info: info, at: Date.now() };
  return info;
}

async function gatherContext(raydium, mintA, mintB, programId) {
  var poolId;
  try {
    poolId = getPdaLaunchpadPoolId(programId, mintA, mintB).publicKey;
  } catch (e) {
    throw new Error('getPdaLaunchpadPoolId failed: ' + e.message);
  }

  // The pool, both tokens' info and the epoch do not depend on each other,
  // so they are looked up at the same time instead of one after another.
  // (The quote token is the one the pool address was built from, so its info
  // can be fetched without waiting for the pool.)
  var poolPromise = raydium.launchpad.getRpcPoolInfo({ poolId: poolId }).catch(function(e) {
    throw new Error(
      'getRpcPoolInfo failed: ' + e.message +
      ' -- computed poolId: ' + poolId.toBase58() +
      ' -- mintA (token): ' + mintA.toBase58() +
      ' -- mintB (quote): ' + mintB.toBase58() +
      ' -- programId: ' + programId.toBase58() +
      ' -- paste the poolId above into a block explorer to check directly whether it exists'
    );
  });
  var tokenInfoPromise = Promise.all([cachedTokenInfo(raydium, mintA), cachedTokenInfo(raydium, mintB)]).catch(function(e) {
    throw new Error('getTokenInfo failed: ' + e.message);
  });
  var epochPromise = cachedEpochInfo(raydium).catch(function(e) {
    throw new Error('getEpochInfo failed: ' + e.message);
  });
  var gathered = await Promise.all([poolPromise, tokenInfoPromise, epochPromise]);
  var poolInfo = gathered[0];
  var mintInfo = gathered[1][0];
  var mintBInfo = gathered[1][1];
  var epochInfo = gathered[2];

  if (!poolInfo) {
    throw new Error('getRpcPoolInfo returned nothing for this mint pair -- this token may not be on LetsBonk, or may have already graduated');
  }

  // Safety net: if the pool's own quote token is somehow not the one the
  // address was built from, use the pool's, exactly as before.
  if (poolInfo.mintB && typeof poolInfo.mintB.toBase58 === 'function' && poolInfo.mintB.toBase58() !== mintB.toBase58()) {
    try {
      mintBInfo = await cachedTokenInfo(raydium, poolInfo.mintB);
    } catch (e) {
      throw new Error('getTokenInfo failed: ' + e.message);
    }
  }

  var platformInfo;
  try {
    var platformKey = poolInfo.platformId.toBase58();
    var platformHit = platformCache.get(platformKey);
    if (platformHit && (Date.now() - platformHit.at) < PLATFORM_TTL_MS) {
      platformInfo = platformHit.info;
    } else {
      var accountData = await raydium.connection.getAccountInfo(poolInfo.platformId);
      if (!accountData) throw new Error('platform account not found on-chain');
      platformInfo = PlatformConfig.decode(accountData.data);
      platformCache.set(platformKey, { info: platformInfo, at: Date.now() });
    }
  } catch (e) {
    throw new Error('fetching/decoding platform config failed: ' + e.message + ' -- ' + describe('platformId', poolInfo.platformId));
  }

  return { poolId: poolId, poolInfo: poolInfo, platformInfo: platformInfo, mintInfo: mintInfo, mintBInfo: mintBInfo, epochInfo: epochInfo };
}

// Liquidity guard, same rule as pumpfun.js: refuse the buy, before anything is
// built or sent, if it would move the pool price by more than maxImpactPct.
// Uses the pool's own quote-side reserves (virtualB) already fetched for the
// buy. If the pool does not expose that number the check is skipped, never
// guessed.
function checkBuyImpact(poolInfo, buyAmountBN, maxImpactPct) {
  if (!maxImpactPct || !poolInfo || !poolInfo.virtualB || typeof poolInfo.virtualB.toString !== 'function') return;
  var reserves = new BN(poolInfo.virtualB.toString());
  if (reserves.isZero()) return;
  var impactPct = buyAmountBN.muln(10000).div(reserves).toNumber() / 100;
  if (impactPct > maxImpactPct) {
    var err = new Error('thin liquidity: this buy would move the price about ' + impactPct.toFixed(2) + '% (limit ' + maxImpactPct + '%) -- the pool holds about ' + (Number(reserves.toString()) / 1e9).toFixed(2) + ' SOL');
    err.code = 'THIN_LIQUIDITY';
    throw err;
  }
}

async function buildBuyInstructions(connection, mint, userPublicKey, solAmountLamports, slippageBps, maxImpactPct) {
  var raydium;
  try {
    raydium = await Raydium.load({ connection: connection, owner: userPublicKey, disableFeatureCheck: true, disableLoadToken: true });
  } catch (e) {
    throw new Error('Raydium.load failed: ' + e.message);
  }

  var programId = LAUNCHPAD_PROGRAM;
  var ctx;
  try {
    ctx = await gatherContext(raydium, mint, NATIVE_MINT, programId);
  } catch (e) {
    // gatherContext already produces a clear, specific message
    throw e;
  }

  var buyAmountBN = new BN(solAmountLamports.toString());
  checkBuyImpact(ctx.poolInfo, buyAmountBN, maxImpactPct);
  var slippageBN = new BN(slippageBps);

  var result;
  try {
    result = await raydium.launchpad.buyToken({
      programId: programId,
      mintA: mint,
      mintAProgram: new PublicKey(ctx.mintInfo.programId),
      poolInfo: ctx.poolInfo,
      mintB: ctx.poolInfo.mintB,
      mintBProgram: new PublicKey(ctx.mintBInfo.programId),
      slippage: slippageBN,
      configInfo: ctx.poolInfo.configInfo,
      platformFeeRate: ctx.platformInfo.feeRate,
      txVersion: TxVersion.LEGACY,
      buyAmount: buyAmountBN,
    });
  } catch (e) {
    throw new Error(
      'buyToken failed: ' + e.message +
      ' -- ' + describe('buyAmountBN', buyAmountBN) +
      ' -- ' + describe('poolInfo', ctx.poolInfo)
    );
  }

  if (!result || !result.transaction || !Array.isArray(result.transaction.instructions)) {
    throw new Error('buyToken returned no usable instructions -- ' + describe('result', result));
  }
  return result.transaction.instructions;
}

async function buildSellInstructions(connection, mint, userPublicKey, tokenAmount, slippageBps) {
  var raydium;
  try {
    raydium = await Raydium.load({ connection: connection, owner: userPublicKey, disableFeatureCheck: true, disableLoadToken: true });
  } catch (e) {
    throw new Error('Raydium.load failed: ' + e.message);
  }

  var programId = LAUNCHPAD_PROGRAM;
  var ctx;
  try {
    ctx = await gatherContext(raydium, mint, NATIVE_MINT, programId);
  } catch (e) {
    throw e;
  }

  var sellAmountBN = new BN(tokenAmount.toString());
  var slippageBN = new BN(slippageBps);

  var result;
  try {
    result = await raydium.launchpad.sellToken({
      programId: programId,
      mintA: mint,
      mintAProgram: new PublicKey(ctx.mintInfo.programId),
      poolInfo: ctx.poolInfo,
      mintB: ctx.poolInfo.mintB,
      mintBProgram: new PublicKey(ctx.mintBInfo.programId),
      slippage: slippageBN,
      configInfo: ctx.poolInfo.configInfo,
      platformFeeRate: ctx.platformInfo.feeRate,
      txVersion: TxVersion.LEGACY,
      sellAmount: sellAmountBN,
    });
  } catch (e) {
    throw new Error(
      'sellToken failed: ' + e.message +
      ' -- ' + describe('sellAmountBN', sellAmountBN) +
      ' -- ' + describe('poolInfo', ctx.poolInfo)
    );
  }

  if (!result || !result.transaction || !Array.isArray(result.transaction.instructions)) {
    throw new Error('sellToken returned no usable instructions -- ' + describe('result', result));
  }
  return result.transaction.instructions;
}

// Checks whether a LetsBonk token has migrated off its LaunchLab pool.
// Lighter than the full buy/sell context -- only needs the pool's status
// field. Confirmed from Raydium's own official migration documentation:
// 0 = still trading on the curve, 1 = migration triggered (trading
// stopped), 2 = fully migrated. Anything other than 0 means the
// bonding-curve path no longer applies.
async function isGraduated(connection, mint, userPublicKey) {
  var raydium;
  try {
    raydium = await Raydium.load({ connection: connection, owner: userPublicKey, disableFeatureCheck: true, disableLoadToken: true });
  } catch (e) {
    throw new Error('Raydium.load failed while checking graduation: ' + e.message);
  }

  var programId = LAUNCHPAD_PROGRAM;
  var poolId;
  try {
    poolId = getPdaLaunchpadPoolId(programId, mint, NATIVE_MINT).publicKey;
  } catch (e) {
    throw new Error('getPdaLaunchpadPoolId failed while checking graduation: ' + e.message);
  }

  var poolInfo;
  try {
    poolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId: poolId });
  } catch (e) {
    throw new Error('getRpcPoolInfo failed while checking graduation: ' + e.message + ' -- poolId: ' + poolId.toBase58());
  }
  if (!poolInfo || poolInfo.status === undefined) {
    throw new Error('getRpcPoolInfo returned no usable status while checking graduation -- ' + describe('poolInfo', poolInfo));
  }
  return poolInfo.status !== 0;
}

module.exports = {
  buildBuyInstructions,
  buildSellInstructions,
  checkBuyImpact,
  isGraduated,
  clearCaches,
};
