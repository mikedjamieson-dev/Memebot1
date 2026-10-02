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

const { Raydium, TxVersion, LAUNCHPAD_PROGRAM, getPdaLaunchpadPoolId, PlatformConfig, toTransferFeeConfig } = require('@raydium-io/raydium-sdk-v2');
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
async function gatherContext(raydium, mintA, mintB, programId) {
  var poolId;
  try {
    poolId = getPdaLaunchpadPoolId(programId, mintA, mintB).publicKey;
  } catch (e) {
    throw new Error('getPdaLaunchpadPoolId failed: ' + e.message);
  }

  var poolInfo;
  try {
    poolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId: poolId });
  } catch (e) {
    throw new Error(
      'getRpcPoolInfo failed: ' + e.message +
      ' -- computed poolId: ' + poolId.toBase58() +
      ' -- mintA (token): ' + mintA.toBase58() +
      ' -- mintB (quote): ' + mintB.toBase58() +
      ' -- programId: ' + programId.toBase58() +
      ' -- paste the poolId above into a block explorer to check directly whether it exists'
    );
  }
  if (!poolInfo) {
    throw new Error('getRpcPoolInfo returned nothing for this mint pair -- this token may not be on LetsBonk, or may have already graduated');
  }

  var platformInfo;
  try {
    var accountData = await raydium.connection.getAccountInfo(poolInfo.platformId);
    if (!accountData) throw new Error('platform account not found on-chain');
    platformInfo = PlatformConfig.decode(accountData.data);
  } catch (e) {
    throw new Error('fetching/decoding platform config failed: ' + e.message + ' -- ' + describe('platformId', poolInfo.platformId));
  }

  var mintInfo, mintBInfo;
  try {
    mintInfo = await raydium.token.getTokenInfo(mintA);
    mintBInfo = await raydium.token.getTokenInfo(poolInfo.mintB);
  } catch (e) {
    throw new Error('getTokenInfo failed: ' + e.message);
  }

  var epochInfo;
  try {
    epochInfo = await raydium.connection.getEpochInfo();
  } catch (e) {
    throw new Error('getEpochInfo failed: ' + e.message);
  }

  return { poolId: poolId, poolInfo: poolInfo, platformInfo: platformInfo, mintInfo: mintInfo, mintBInfo: mintBInfo, epochInfo: epochInfo };
}

async function buildBuyInstructions(connection, mint, userPublicKey, solAmountLamports, slippageBps) {
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
      transferFeeConfigB: toTransferFeeConfig(ctx.mintBInfo, ctx.epochInfo.epoch),
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
      transferFeeConfigB: toTransferFeeConfig(ctx.mintBInfo, ctx.epochInfo.epoch),
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

module.exports = {
  buildBuyInstructions,
  buildSellInstructions,
};
