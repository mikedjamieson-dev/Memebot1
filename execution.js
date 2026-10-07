'use strict';
// -- TRANSACTION EXECUTION ----------------------------------------
// Two ways to submit a transaction (normal, and via Helius Sender for
// priority speed), sharing one confirm-polling core so the already
// -verified logic for knowing what actually happened is never
// duplicated or rewritten.
//
// Four honest outcomes, never fewer, from either path:
//   CONFIRMED - it landed and succeeded
//   FAILED    - it landed, but the instruction itself was rejected
//               on-chain (e.g. would-be slippage exceeded) -- this is
//               NOT the same as expired or pending, and the caller
//               must not treat it as "maybe it'll still go through"
//   EXPIRED   - the blockhash's window closed with nothing landing,
//               confirmed via one final direct re-check first (an
//               expired window alone doesn't fully prove a
//               transaction never landed)
//   PENDING   - we stopped checking before reaching either of the
//               above; genuinely unresolved, not a guess at either
//               outcome

const { Transaction, SystemProgram, ComputeBudgetProgram, PublicKey } = require('@solana/web3.js');

// Helius Sender's own required tip accounts -- confirmed directly from
// a real rejection response ("transaction must send a tip ... to one
// of the following Helius wallets"), NOT the same list as Jito's own
// 8 tip accounts used for direct bundle submission. Those are a
// different list for a different service -- do not merge them.
const HELIUS_SENDER_TIP_ACCOUNTS = [
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'tKq5esiQyvgRyfFa4JEz4uAUmppKyKB1PiQD9JhyGJY',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
  'D1Mc6j9xQWgR1o1Z7yU5nVVXFQiAYx7FG9AW1aVfwrUM',
];

function randomTipAccount() {
  var address = HELIUS_SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_SENDER_TIP_ACCOUNTS.length)];
  return new PublicKey(address);
}

// Sender's two tiers, with their documented minimum tip in lamports.
const SENDER_TIERS = {
  SWQOS_ONLY: { minLamports: 5000, queryParam: 'swqos_only=true' },      // 0.000005 SOL
  MAX: { minLamports: 1000000, queryParam: '' },                         // 0.001 SOL
};

// Fetches the real, current 75th-percentile landed tip from Jito's own
// public endpoint -- a genuine, current number, not a guess. Falls
// back to the tier's documented minimum if the fetch fails or the
// response shape isn't what's expected, rather than ever blocking a
// real trade on this being unavailable.
async function fetchCurrentTipLamports(tier) {
  var minLamports = tier.minLamports;
  try {
    var res = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { timeout: 3000 });
    if (!res.ok) return minLamports;
    var data = await res.json();
    var row = Array.isArray(data) ? data[0] : data;
    var p75 = row && (row.landed_tips_75th_percentile || row.landedTips75thPercentile);
    if (typeof p75 !== 'number' || !(p75 > 0)) return minLamports;
    var fetchedLamports = Math.round(p75 * 1000000000); // the endpoint reports SOL, not lamports
    return Math.max(fetchedLamports, minLamports);
  } catch (e) {
    return minLamports;
  }
}

// Pulls the api-key out of the already-configured LIVE_RPC_URL rather
// than needing a separate secret -- Sender authenticates with the same
// key as the regular RPC connection.
function extractApiKey(rpcUrl) {
  var match = /[?&]api-key=([^&]+)/.exec(rpcUrl || '');
  if (!match) {
    var err = new Error('could not find api-key in LIVE_RPC_URL');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return match[1];
}

function buildSenderUrl(rpcUrl, tier) {
  var apiKey = extractApiKey(rpcUrl);
  var query = 'api-key=' + apiKey + (tier.queryParam ? '&' + tier.queryParam : '');
  return 'https://sender.helius-rpc.com/fast?' + query;
}

function describe(label, value) {
  if (value === undefined) return label + '=undefined';
  if (value === null) return label + '=null';
  if (typeof value === 'object') return label + '=object{' + Object.keys(value).join(',') + '}';
  return label + '=' + typeof value + '(' + value + ')';
}

function isSuccessStatus(status) {
  return !!status && !status.err &&
    (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');
}

// The shared confirm-polling core. Identical logic regardless of how
// the transaction was actually submitted -- a signature is a
// signature, checked the same honest way either time.
async function pollForOutcome(signature, connection, latest, options) {
  var pollIntervalMs = options.pollIntervalMs || 1000;
  var maxPollMs = options.maxPollMs || 30000;
  var startTime = Date.now();

  while (true) {
    var statuses = await connection.getSignatureStatuses([signature]);
    var status = statuses && statuses.value && statuses.value[0];

    if (status) {
      if (isSuccessStatus(status)) {
        return { outcome: 'CONFIRMED', signature: signature };
      }
      if (status.err) {
        return { outcome: 'FAILED', signature: signature, error: JSON.stringify(status.err) };
      }
    }

    var currentBlockHeight = await connection.getBlockHeight();
    if (currentBlockHeight > latest.lastValidBlockHeight) {
      var finalStatuses = await connection.getSignatureStatuses([signature]);
      var finalStatus = finalStatuses && finalStatuses.value && finalStatuses.value[0];
      if (isSuccessStatus(finalStatus)) {
        return { outcome: 'CONFIRMED', signature: signature };
      }
      if (finalStatus && finalStatus.err) {
        return { outcome: 'FAILED', signature: signature, error: JSON.stringify(finalStatus.err) };
      }
      return { outcome: 'EXPIRED', signature: signature };
    }

    if (Date.now() - startTime > maxPollMs) {
      return { outcome: 'PENDING', signature: signature, lastValidBlockHeight: latest.lastValidBlockHeight };
    }

    await new Promise(function(resolve) { setTimeout(resolve, pollIntervalMs); });
  }
}

// Normal path: send through the regular connection, same as before.
async function sendAndConfirm(transaction, keypair, connection, options) {
  options = options || {};
  var latest = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = keypair.publicKey;
  transaction.sign(keypair);
  var signature = await connection.sendRawTransaction(transaction.serialize());
  return pollForOutcome(signature, connection, latest, options);
}

// Priority path: adds a tip (real, current amount) and a priority
// fee, submits through Sender's dedicated address instead of the
// regular connection, then confirms through the exact same polling
// logic as the normal path -- confirmation is always checked against
// the real chain via our regular connection either way, only the
// initial submission differs.
//
// microLamportsPerCu is a conservative, fixed default for the
// priority fee specifically -- unlike the tip, this has not been
// built to fetch a live recommended value yet. That is a reasonable
// next refinement, not something this build claims to already do.
async function sendAndConfirmViaSender(transaction, keypair, connection, rpcUrl, options) {
  options = options || {};
  var tierName = options.tier || 'SWQOS_ONLY';
  var tier = SENDER_TIERS[tierName];
  if (!tier) throw new Error('unknown Sender tier: ' + tierName);
  var microLamportsPerCu = options.microLamportsPerCu || 100000;

  var tipLamports = await fetchCurrentTipLamports(tier);

  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu })
  );
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: randomTipAccount(),
      lamports: tipLamports,
    })
  );

  var latest = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = keypair.publicKey;

  var instructionSummary = transaction.instructions.map(function(ix, i) {
    var programIdStr = (ix.programId && typeof ix.programId.toBase58 === 'function')
      ? ix.programId.toBase58()
      : 'INVALID (' + describe('programId', ix.programId) + ')';
    return 'ix[' + i + ']: program=' + programIdStr + ' keys=' + (ix.keys ? ix.keys.length : 'none');
  }).join(' | ');
  if (options.onDiagnostic) options.onDiagnostic(instructionSummary);

  transaction.sign(keypair);

  var serialized = transaction.serialize();
  var senderUrl = buildSenderUrl(rpcUrl, tier);
  var body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [serialized.toString('base64'), { encoding: 'base64', skipPreflight: true }],
  };
  var res = await fetch(senderUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 10000,
  });
  var json = await res.json();
  if (json.error) {
    var err = new Error('Sender rejected the submission: ' + JSON.stringify(json.error));
    err.code = 'SENDER_REJECTED';
    throw err;
  }
  var signature = json.result;
  if (typeof signature !== 'string' || signature.length === 0) {
    var err2 = new Error(
      'Sender did not return a usable signature -- full response: ' + JSON.stringify(json)
    );
    err2.code = 'SENDER_NO_SIGNATURE';
    throw err2;
  }
  var outcome = await pollForOutcome(signature, connection, latest, options);
  outcome.tipLamports = tipLamports;
  return outcome;
}

// The one-time proof test, normal path: the smallest possible real
// transaction -- 0.00001 SOL sent from the trading wallet to itself.
async function testSelfTransfer(keypair, connection) {
  var transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: keypair.publicKey,
      lamports: 10000,
    })
  );
  return sendAndConfirm(transaction, keypair, connection);
}

// Same proof test, routed through Sender instead, to prove the tip +
// priority fee + Sender submission path against real infrastructure.
async function testSelfTransferViaSender(keypair, connection, rpcUrl) {
  var transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: keypair.publicKey,
      lamports: 10000,
    })
  );
  return sendAndConfirmViaSender(transaction, keypair, connection, rpcUrl, { tier: 'SWQOS_ONLY' });
}

module.exports = {
  sendAndConfirm,
  sendAndConfirmViaSender,
  testSelfTransfer,
  testSelfTransferViaSender,
  fetchCurrentTipLamports,
  HELIUS_SENDER_TIP_ACCOUNTS,
  SENDER_TIERS,
};
