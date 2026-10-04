'use strict';
// -- RAYDIUM CPMM SELL INSTRUCTION BUILDING ------------------------
// Where LetsBonk tokens land after migrating off their LaunchLab pool.
// Confirmed from Raydium's own official documentation (consistent
// across multiple language versions of the same page) that new
// LaunchLab tokens migrate exclusively to CPMM pools, not the older
// AMM type -- and confirmed this is the exact same package already
// installed for LetsBonk's own buy/sell, so no new dependency here.
//
// Only ever builds a sell, same reasoning as pumpswap.js -- this bot
// never buys an already-migrated token, this exists purely to exit
// one that migrated while we were holding it.

const { Raydium, TxVersion, CurveCalculator } = require('@raydium-io/raydium-sdk-v2');
const { PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');

function describe(label, value) {
  if (value === undefined) return label + '=undefined';
  if (value === null) return label + '=null';
  if (value instanceof BN) return label + '=BN(' + value.toString() + ')';
  if (typeof value === 'object') return label + '=object{' + Object.keys(value).join(',') + '}';
  return label + '=' + typeof value + '(' + value + ')';
}

// Sells `tokenAmount` of `mint` on its post-migration Raydium CPMM
// pool. poolId must be the migrated pool's own address -- confirmed
// from Raydium's own docs that getRpcPoolInfo({poolId}) (already used
// for the LaunchLab pool) exposes the migrated pool's ID once status
// is no longer 0, which is how the caller is expected to get this.
async function buildSellInstructions(connection, poolId, mint, userPublicKey, tokenAmount, slippagePercent) {
  var raydium;
  try {
    raydium = await Raydium.load({ connection: connection, owner: userPublicKey, disableFeatureCheck: true, disableLoadToken: true });
  } catch (e) {
    throw new Error('Raydium.load failed: ' + e.message);
  }

  var poolData;
  try {
    poolData = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  } catch (e) {
    throw new Error('getPoolInfoFromRpc failed: ' + e.message + ' -- poolId: ' + poolId.toString());
  }
  if (!poolData || !poolData.poolInfo) {
    throw new Error('getPoolInfoFromRpc returned nothing usable -- ' + describe('poolData', poolData));
  }
  var poolInfo = poolData.poolInfo;
  var poolKeys = poolData.poolKeys;
  var rpcData = poolData.rpcData;

  var baseIn = mintMatchesA(poolInfo, mint.toString());
  var inputAmountBN = new BN(tokenAmount.toString());
  var swapResult;
  try {
    swapResult = CurveCalculator.swapBaseInput(
      inputAmountBN,
      baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
      baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
      rpcData.configInfo.tradeFeeRate,
      rpcData.configInfo.creatorFeeRate,
      rpcData.configInfo.protocolFeeRate,
      rpcData.configInfo.fundFeeRate,
      true
    );
  } catch (e) {
    throw new Error(
      'CurveCalculator.swapBaseInput failed: ' + e.message +
      ' -- ' + describe('rpcData', rpcData) +
      ' -- inputAmountBN=' + inputAmountBN.toString()
    );
  }

  try {
    var result = await raydium.cpmm.swap({
      poolInfo: poolInfo,
      poolKeys: poolKeys,
      inputAmount: inputAmountBN,
      swapResult: swapResult,
      slippage: slippagePercent / 100,
      baseIn: baseIn,
      txVersion: TxVersion.LEGACY,
    });
    if (!result || !result.transaction || !Array.isArray(result.transaction.instructions)) {
      throw new Error('cpmm.swap returned no usable instructions -- ' + describe('result', result));
    }
    return result.transaction.instructions;
  } catch (e) {
    throw new Error(
      'cpmm.swap failed: ' + e.message +
      ' -- ' + describe('poolInfo', poolInfo)
    );
  }
}

// Determines which side of the pool our token actually sits on.
// Real orientation varies per pool, confirmed from Raydium's own docs
// -- never assume, always check.
function mintMatchesA(poolInfo, tokenMintStr) {
  return poolInfo.mintA && poolInfo.mintA.address === tokenMintStr;
}

module.exports = {
  buildSellInstructions,
};
