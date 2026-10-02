'use strict';
// -- TRANSACTION EXECUTION ----------------------------------------
// One reusable function, sendAndConfirm, that every future piece of
// real trading logic calls to put a transaction on-chain and find out
// for certain what happened. No silent guessing, no fixed-timeout
// assumption, no automatic retry that could double-execute something.
//
// Four honest outcomes, never fewer:
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

const { Transaction, SystemProgram } = require('@solana/web3.js');

function isSuccessStatus(status) {
  return !!status && !status.err &&
    (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');
}

// Sends a built (unsigned) Transaction, signs it with keypair, and
// polls until one of the four outcomes above is reached. Returns
// { outcome, signature, error? } -- signature is always present once
// the transaction has been sent, even for FAILED/EXPIRED/PENDING, so
// the real attempt can always be looked up later.
async function sendAndConfirm(transaction, keypair, connection, options) {
  options = options || {};
  var pollIntervalMs = options.pollIntervalMs || 1000;
  var maxPollMs = options.maxPollMs || 30000;

  var latest = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = keypair.publicKey;
  transaction.sign(keypair);

  var signature = await connection.sendRawTransaction(transaction.serialize());
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
      // status exists but is only 'processed' so far -- not yet
      // confirmed, fall through and keep polling
    }

    var currentBlockHeight = await connection.getBlockHeight();
    if (currentBlockHeight > latest.lastValidBlockHeight) {
      // Window closed. One final, direct re-check before calling this
      // expired -- the window closing alone doesn't fully prove the
      // transaction never landed.
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
      return { outcome: 'PENDING', signature: signature };
    }

    await new Promise(function(resolve) { setTimeout(resolve, pollIntervalMs); });
  }
}

// The one-time proof test: the smallest possible real transaction --
// 0.00001 SOL sent from the trading wallet to itself -- run through
// the exact same sendAndConfirm every real trade will use later.
// Not run automatically; only when explicitly triggered.
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

module.exports = {
  sendAndConfirm,
  testSelfTransfer,
};
