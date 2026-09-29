'use strict';
// -- LIVE WALLET LOADING -----------------------------------------
// Loads the real trading wallet from its private key, and the real
// savings wallet's address, from Render environment variables.
//
// The private key is NEVER logged, returned as a string, or written
// anywhere by this file -- only the derived public address is ever
// surfaced. Nothing else in the bot imports this file yet; paper
// trading does not use it and is unaffected by anything here.
//
// Deliberately named differently from the existing TRADING_WALLET /
// SAVINGS_WALLET settings already in server.js -- those are plain
// display addresses, editable from Settings and shown (truncated) on
// the dashboard. A private key must never share a name with something
// settable through the API or shown on screen.

const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const LIVE_KEY_ENV = 'LIVE_WALLET_PRIVATE_KEY';
const LIVE_SAVINGS_ENV = 'LIVE_SAVINGS_ADDRESS';

// Loads the trading wallet's keypair from LIVE_WALLET_PRIVATE_KEY.
// Throws with a clear .code on any problem -- callers decide what a
// failure means for them:
//   'WALLET_NOT_CONFIGURED' - the variable isn't set at all yet
//   'WALLET_INVALID'        - it's set, but not a usable key
function loadTradingWallet() {
  const raw = process.env[LIVE_KEY_ENV];
  if (!raw || !raw.trim()) {
    const err = new Error(LIVE_KEY_ENV + ' is not set');
    err.code = 'WALLET_NOT_CONFIGURED';
    throw err;
  }

  let secretKeyBytes;
  try {
    secretKeyBytes = bs58.decode(raw.trim());
  } catch (e) {
    const err = new Error(LIVE_KEY_ENV + ' is set but is not valid base58 -- check it was copied in full from Phantom');
    err.code = 'WALLET_INVALID';
    throw err;
  }

  // A Phantom-exported Solana key decodes to exactly 64 bytes
  // (32-byte secret seed + 32-byte public key). Anything else means
  // the wrong thing was pasted in -- e.g. a seed phrase, a truncated
  // key, or a key from a different chain.
  if (secretKeyBytes.length !== 64) {
    const err = new Error(
      LIVE_KEY_ENV + ' decoded to ' + secretKeyBytes.length +
      ' bytes, expected 64 -- this does not look like a Phantom-exported Solana private key'
    );
    err.code = 'WALLET_INVALID';
    throw err;
  }

  let keypair;
  try {
    keypair = Keypair.fromSecretKey(secretKeyBytes);
  } finally {
    // Best-effort scrub of the decoded bytes now that the keypair
    // exists. secretKeyBytes never leaves this function either way.
    secretKeyBytes.fill(0);
  }
  return keypair;
}

// Returns the savings wallet's public address as a plain string, or
// null if it hasn't been set yet. This is a destination address only
// -- no private key is ever needed or read for the savings wallet.
function getSavingsAddress() {
  const addr = process.env[LIVE_SAVINGS_ENV];
  return addr && addr.trim() ? addr.trim() : null;
}

module.exports = {
  loadTradingWallet,
  getSavingsAddress,
  LIVE_KEY_ENV,
  LIVE_SAVINGS_ENV,
};
