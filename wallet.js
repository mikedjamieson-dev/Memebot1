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

const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58raw = require('bs58');
// Some versions/bundlers of bs58 expose decode/encode directly on the
// module; others nest them under .default. Try both shapes rather than
// assume one -- a wrong assumption here would fail identically on
// every single key, regardless of what was actually pasted in.
const bs58 = (bs58raw && typeof bs58raw.decode === 'function')
  ? bs58raw
  : (bs58raw && bs58raw.default && typeof bs58raw.default.decode === 'function')
    ? bs58raw.default
    : null;

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

  if (!bs58) {
    const err = new Error(
      'the bs58 library did not load the way this code expects (its decode function was not found) -- ' +
      'this is a code/dependency problem, not a problem with the key itself'
    );
    err.code = 'WALLET_INVALID';
    throw err;
  }

  let secretKeyBytes;
  try {
    secretKeyBytes = bs58.decode(raw.trim());
  } catch (e) {
    // Build a diagnostic from facts about the value, never the value
    // itself -- a length, a yes/no, a count. Nothing here can be used
    // to reconstruct any part of the actual key.
    const trimmed = raw.trim();
    const facts = [];
    facts.push('length ' + trimmed.length + ' chars');
    if (raw.length !== trimmed.length) {
      facts.push('had ' + (raw.length - trimmed.length) + ' leading/trailing whitespace char(s) removed before this count');
    }
    if (/[\n\r\t]/.test(trimmed)) {
      facts.push('contains a line break or tab in the middle of it');
    }
    if (/\s/.test(trimmed.replace(/[\n\r\t]/g, ''))) {
      facts.push('contains a space character in the middle of it');
    }
    const BASE58_ALPHABET = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]*$/;
    if (!BASE58_ALPHABET.test(trimmed.replace(/\s/g, ''))) {
      const invalidCount = (trimmed.match(/[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g) || []).length;
      facts.push(invalidCount + ' character(s) outside the standard key alphabet (e.g. 0, O, I, l, or punctuation are never valid in a real key)');
    }
    // Surface the real underlying error too -- if none of the facts
    // above explain anything (the string looks completely clean), this
    // is the only remaining clue, and it's safe: a library's own error
    // message never contains the input data itself.
    facts.push('underlying error: ' + (e && e.message ? e.message : String(e)));
    const err = new Error(
      LIVE_KEY_ENV + ' is set but is not valid base58 -- ' + facts.join('; ') +
      '. A real Phantom-exported key is one continuous block of about 87-88 characters with none of the above.'
    );
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
      ' bytes (from a ' + raw.trim().length + '-character value), expected 64 bytes from an ~87-88 character value -- this does not look like a Phantom-exported Solana private key'
    );
    err.code = 'WALLET_INVALID';
    throw err;
  }

  const keypair = Keypair.fromSecretKey(secretKeyBytes);
  return keypair;
}

// Returns the savings wallet's public address as a plain string, or
// null if it hasn't been set yet. This is a destination address only
// -- no private key is ever needed or read for the savings wallet.
function getSavingsAddress() {
  const addr = process.env[LIVE_SAVINGS_ENV];
  return addr && addr.trim() ? addr.trim() : null;
}

const LIVE_RPC_ENV = 'LIVE_RPC_URL';

// Shared by anything that needs to talk to the chain. Throws the same
// clear, specific error whether it's a balance check, a transaction
// send, or anything else -- one source of truth for this instead of
// each caller re-implementing "read the env var, throw if missing."
function getConnection() {
  const rpcUrl = process.env[LIVE_RPC_ENV];
  if (!rpcUrl || !rpcUrl.trim()) {
    const err = new Error(LIVE_RPC_ENV + ' is not set');
    err.code = 'RPC_NOT_CONFIGURED';
    throw err;
  }
  return new Connection(rpcUrl.trim(), 'confirmed');
}

// Reads the real, current SOL balance for a given public key from the
// chain. Throws on any failure (missing RPC URL, bad key, network
// timeout, rate limit) -- there is no fallback value and no retry here
// by design. The caller must treat a thrown error as "unable to read
// right now" and show that honestly, never a stale or guessed number.
async function getTradingWalletBalance(publicKey) {
  var connection = getConnection();
  var lamports = await connection.getBalance(publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

// Reads the real, current balance of a specific SPL token for a given
// wallet. Returns { amount: raw integer string, decimals } so the
// caller can work with the exact on-chain value, not a rounded one.
// Returns a zero balance (not an error) if the account simply doesn't
// exist yet -- that's a real, valid state (never held this token),
// not a failure. Any other failure throws, same no-fallback rule as
// the SOL balance reader above.
async function getTokenBalance(connection, mint, ownerPublicKey) {
  const { getAssociatedTokenAddress } = require('@solana/spl-token');
  var tokenProgram = await getTokenProgramId(connection, mint);
  var tokenAccount = await getAssociatedTokenAddress(mint, ownerPublicKey, false, tokenProgram);
  var diagnostic = {
    tokenProgram: tokenProgram.toString(),
    tokenAccount: tokenAccount.toString(),
  };
  try {
    var balance = await connection.getTokenAccountBalance(tokenAccount);
    return { amount: balance.value.amount, decimals: balance.value.decimals, diagnostic: diagnostic };
  } catch (e) {
    // Only treat this as a genuine zero balance for the specific,
    // confirmed "the account doesn't exist" case -- anything else is a
    // real, different failure and must not be silently reported as
    // zero, which would hide the actual problem.
    var isAccountNotFound = e.message && (
      e.message.indexOf('could not find account') !== -1 ||
      e.message.indexOf('Invalid param') !== -1 ||
      e.message.indexOf('AccountNotFound') !== -1
    );
    if (isAccountNotFound) {
      diagnostic.rawError = e.message;
      return { amount: '0', decimals: 0, diagnostic: diagnostic };
    }
    diagnostic.rawError = e.message;
    var err = new Error('getTokenAccountBalance failed unexpectedly -- ' + e.message + ' -- tokenProgram: ' + diagnostic.tokenProgram + ' -- tokenAccount: ' + diagnostic.tokenAccount);
    err.diagnostic = diagnostic;
    throw err;
  }
}

// Determines which token standard a specific mint actually uses --
// the original Token Program, or the newer Token-2022 -- by reading
// its real on-chain owner field rather than assuming. Confirmed
// directly from Solana's own documentation: assuming the original
// program for a Token-2022 mint produces an IncorrectProgramId
// failure, exactly the kind this exists to prevent.
async function getTokenProgramId(connection, mint) {
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
  var accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    var err = new Error('Mint account not found on-chain: ' + mint.toString());
    err.code = 'MINT_NOT_FOUND';
    throw err;
  }
  if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return TOKEN_2022_PROGRAM_ID;
  }
  return TOKEN_PROGRAM_ID;
}

// Reads the real, actual network fee a confirmed transaction paid,
// straight from its own on-chain record -- not an estimate. Returns
// the fee in lamports. Throws if the transaction can't be found
// (e.g. called too soon after confirmation, before it's indexed).
async function getRealTransactionFee(connection, signature) {
  var tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta || tx.meta.fee === undefined) {
    var err = new Error('Could not read the real fee for this transaction -- it may not be indexed yet');
    err.code = 'FEE_NOT_FOUND';
    throw err;
  }
  return tx.meta.fee;
}

// Reads the wallet's real, net SOL balance change caused by a specific
// confirmed transaction -- negative for a buy (SOL left the wallet),
// positive for a sell (SOL came in). This already naturally includes
// every real cost that happened in that same transaction (the trade
// itself, the network fee, the tip), since all of them are real SOL
// movements out of the same wallet -- more accurate than summing
// separate estimated pieces by hand. Returns lamports.
async function getRealBalanceChange(connection, signature, publicKey) {
  var tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
    var err = new Error('Could not read the real balance change for this transaction -- it may not be indexed yet');
    err.code = 'BALANCE_CHANGE_NOT_FOUND';
    throw err;
  }
  var accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  var idx = accountKeys.findIndex(function(k) { return k.toString() === publicKey.toString(); });
  if (idx === -1) {
    var err2 = new Error('Could not find this wallet in the transaction\'s account list');
    err2.code = 'ACCOUNT_NOT_IN_TX';
    throw err2;
  }
  return tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
}

module.exports = {
  loadTradingWallet,
  getSavingsAddress,
  getTradingWalletBalance,
  getTokenBalance,
  getTokenProgramId,
  getRealTransactionFee,
  getRealBalanceChange,
  getConnection,
  LIVE_KEY_ENV,
  LIVE_SAVINGS_ENV,
  LIVE_RPC_ENV,
};
