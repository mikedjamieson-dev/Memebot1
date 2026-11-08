'use strict';
// -- LIVE ON-CHAIN PRICE FEED ---------------------------------------
// Gives every OPEN LIVE POSITION a real-time price straight from the
// blockchain, instead of waiting for the next trade to show up in the
// Bitquery feed.
//
// How: for each open position this opens a subscription (Helius websocket,
// the same RPC the bot already trades through) to the coin's own pool
// account -- the pump.fun bonding curve, or the LetsBonk pool. The chain
// pushes the new account data the instant any trade touches that coin, at
// the "processed" level (the earliest point a trade is visible, before it
// is even confirmed). The price is worked out from the pool's reserves, the
// same constant-product maths the pool itself uses.
//
// When a held pump.fun coin graduates, its bonding curve stops trading. The
// watcher then finds the coin's PumpSwap pool and keeps pricing it from there
// (see the PUMPSWAP section below), so the stop loss and trail keep working
// after graduation. The Bitquery trade feed only covers pump.fun's bonding
// curve, so before this a graduated coin had no price at all.
//
// This file only READS prices. It never builds, signs or sends anything and
// it never decides to sell -- it hands each price to the bot's existing exit
// logic (stop loss, tiers, trail), which is unchanged.
//
// Safety: the first on-chain price of each position is compared with the
// price the bot actually paid. If they disagree wildly the maths for that
// coin is wrong, so the on-chain feed is switched OFF for that position and
// the bot keeps using the old feed -- a wrong price can never trigger or
// block a sell. Any failure (socket drop, bad data, missing library) falls
// back to the old feed too; trading is never affected.

const WebSocket = require('ws');
const { PublicKey } = require('@solana/web3.js');

const CALIBRATION_MIN_RATIO = 0.5;  // first chain price must be within 0.5x ..
const CALIBRATION_MAX_RATIO = 2.0;  // .. 2x of the price the bot paid
const PING_MS = 25000;
const DEAD_AFTER_MS = 70000;        // no pong for this long = connection is dead
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 5000;

function toWsUrl(httpUrl) {
  if (!httpUrl) return null;
  var u = String(httpUrl).trim();
  if (u.indexOf('https://') === 0) return 'wss://' + u.slice(8);
  if (u.indexOf('http://') === 0) return 'ws://' + u.slice(7);
  if (u.indexOf('wss://') === 0 || u.indexOf('ws://') === 0) return u;
  return null;
}

function asPublicKey(v) {
  if (!v) return null;
  if (Array.isArray(v)) v = v[0];            // some SDK helpers return [address, bump]
  if (v && v.publicKey) v = v.publicKey;     // others return { publicKey }
  if (v instanceof PublicKey) return v;
  if (v && typeof v.toBase58 === 'function') return new PublicKey(v.toBase58());
  return new PublicKey(v);
}

function bnToNumber(x) {
  if (x === null || x === undefined) return NaN;
  return Number(x.toString());
}

// -- PUMP.FUN ---------------------------------------------------------
// Bonding curve account. Price = quote reserves / token reserves (virtual).
function pumpAdapter(mintStr) {
  var sdk = require('@pump-fun/pump-sdk');
  var address = asPublicKey(sdk.bondingCurvePda(new PublicKey(mintStr)));
  return {
    address: address,
    // returns { quoteLamports, tokenRaw, complete }
    decode: function(buf) {
      var bc = null;
      try {
        bc = sdk.PUMP_SDK.decodeBondingCurve({ data: buf });
      } catch (e) {
        bc = null;
      }
      if (bc && bc.virtualQuoteReserves && bc.virtualTokenReserves) {
        return {
          quoteLamports: bnToNumber(bc.virtualQuoteReserves),
          tokenRaw: bnToNumber(bc.virtualTokenReserves),
          complete: !!bc.complete,
        };
      }
      // Fallback: the classic fixed layout (8-byte header, then virtual token
      // reserves, virtual SOL reserves). Only trusted if the first-price
      // comparison against the price the bot paid agrees.
      if (buf.length >= 24) {
        return {
          quoteLamports: Number(buf.readBigUInt64LE(16)),
          tokenRaw: Number(buf.readBigUInt64LE(8)),
          complete: buf.length > 48 ? buf[48] === 1 : false,
        };
      }
      throw new Error('bonding curve data too short (' + buf.length + ' bytes)');
    },
  };
}

// -- LETSBONK (Raydium LaunchLab) --------------------------------------
// Pool account. Constant product with the pool's virtual + real amounts:
// price = (virtualB + realB) / (virtualA - realA).
function bonkAdapter(mintStr) {
  var raydium = require('@raydium-io/raydium-sdk-v2');
  var splToken = require('@solana/spl-token');
  if (!raydium.LaunchpadPool || typeof raydium.LaunchpadPool.decode !== 'function') {
    throw new Error('LaunchpadPool decoder not available in the installed Raydium library');
  }
  var address = asPublicKey(raydium.getPdaLaunchpadPoolId(raydium.LAUNCHPAD_PROGRAM, new PublicKey(mintStr), splToken.NATIVE_MINT));
  return {
    address: address,
    decode: function(buf) {
      var p = raydium.LaunchpadPool.decode(buf);
      var vA = bnToNumber(p.virtualA), rA = bnToNumber(p.realA);
      var vB = bnToNumber(p.virtualB), rB = bnToNumber(p.realB);
      return {
        quoteLamports: vB + rB,
        tokenRaw: vA - rA,
        complete: p.status !== undefined && Number(p.status) !== 0,
      };
    },
  };
}

// -- PUMPSWAP (a pump.fun coin after it graduates) -----------------------
// When a held pump.fun coin graduates, its bonding curve stops trading and the coin trades in its PumpSwap
// pool instead. The pool's price is worked out the same way the installed @pump-fun/pump-swap-sdk 2.1.0
// prices a sale (sellBaseInput): SOL side = the pool's SOL balance plus the pool's virtualQuoteReserves,
// coin side = the pool's coin balance. Three accounts are watched: the pool's coin balance account, its SOL
// balance account (both change on every trade) and the pool account itself (for virtualQuoteReserves).
const GRAD_RETRY_MS = 1500;       // the pool is created a few seconds after the curve completes
const GRAD_MAX_TRIES = 40;        // about a minute of looking for it, then the coin falls back to the old feed
const TOKEN_AMOUNT_OFFSET = 64;   // where a token account keeps its balance (same in both token programs)

function createWatcher(opts) {
  var getRpcUrl = opts.getRpcUrl;
  var getSolPrice = opts.getSolPrice;       // returns USD per SOL, or null if not fresh
  var getConnection = opts.getConnection;
  var onPrice = opts.onPrice;               // (mint, priceUsd)
  var log = opts.log || function() {};

  // One entry per watched coin. An entry has one or more subscriptions ("subs"): one for a coin still on
  // its bonding curve or LetsBonk pool, three once a pump.fun coin has moved to PumpSwap.
  var entries = new Map();                  // mint -> entry
  var failed = new Set();                   // mints we gave up on (until position closes)
  var reqToSub = new Map();
  var subToSub = new Map();
  var nextReqId = 1;

  var ws = null;
  var wsReady = false;
  var reconnectTimer = null;
  var backoff = BACKOFF_START_MS;
  var pingTimer = null;
  var lastPong = 0;
  var noUrlLogged = false;
  var stats = { notifications: 0, prices: 0, reconnects: 0, disabled: 0, graduated: 0 };

  function clearPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function makeSub(entry, role, address) {
    return { entry: entry, role: role, address: address, subId: null, reqId: null };
  }

  function isCurrent(entry) {
    return entries.get(entry.mint) === entry && !entry.disabled;
  }

  function subscribeSub(sub) {
    if (!ws || !wsReady || sub.entry.disabled) return;
    var id = nextReqId++;
    sub.reqId = id;
    reqToSub.set(id, sub);
    try {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: id, method: 'accountSubscribe',
        params: [sub.address.toBase58(), { encoding: 'base64', commitment: 'processed' }],
      }));
    } catch (e) {
      log('ONCHAIN subscribe send failed for ' + sub.entry.mint.slice(0, 8) + '...: ' + e.message, 'warn');
    }
  }

  function subscribeEntry(entry) {
    entry.subs.forEach(subscribeSub);
  }

  function unsubscribeSub(sub) {
    if (sub.subId !== null && sub.subId !== undefined) {
      subToSub.delete(sub.subId);
      if (ws && wsReady) {
        try {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextReqId++, method: 'accountUnsubscribe', params: [sub.subId] }));
        } catch (e) { /* closing anyway */ }
      }
    }
    if (sub.reqId) reqToSub.delete(sub.reqId);
    sub.subId = null;
    sub.reqId = null;
  }

  function unsubscribeEntry(entry) {
    entry.subs.forEach(unsubscribeSub);
  }

  function disable(entry, reason) {
    if (entry.disabled) return;
    entry.disabled = true;
    entry.live = false;
    stats.disabled++;
    failed.add(entry.mint);
    log('ONCHAIN PRICE OFF for ' + entry.mint.slice(0, 8) + '... (' + reason + ') -- this position keeps using the old price feed', 'warn');
    unsubscribeEntry(entry);
  }

  function noteBadRead(entry, reason) {
    entry.badReads = (entry.badReads || 0) + 1;
    if (!entry.firstPrice || entry.badReads >= 5) disable(entry, reason);
  }

  // Every price, from either kind of pool, goes through here. The first price of each pool is checked
  // against a price the bot already trusts (refPrice) before anything is passed on.
  function deliverPrice(entry, price, refPrice, refLabel) {
    if (!isFinite(price) || price <= 0) {
      noteBadRead(entry, 'pool data gave an unusable price');
      return;
    }
    if (!entry.firstPrice) {
      var ratio = refPrice > 0 ? price / refPrice : 1;
      if (ratio < CALIBRATION_MIN_RATIO || ratio > CALIBRATION_MAX_RATIO) {
        disable(entry, 'first ' + (entry.kind === 'pumpswap' ? 'PumpSwap pool' : 'on-chain') + ' price $' + price.toExponential(4) + ' is ' + ratio.toFixed(2) + 'x ' + refLabel + ' $' + (refPrice > 0 ? refPrice.toExponential(4) : '?') + ' -- the maths does not match this coin');
        return;
      }
      entry.firstPrice = true;
      log('ONCHAIN PRICE LIVE for ' + entry.mint.slice(0, 8) + '... [' + (entry.kind === 'pumpswap' ? 'PumpSwap pool' : entry.platform) + '] first price $' + price.toExponential(4) + ' (' + ratio.toFixed(3) + 'x ' + refLabel + ') -- updates now come straight from the chain', 'info');
    }
    entry.badReads = 0;
    entry.live = true;
    entry.lastPriceAt = Date.now();
    entry.lastPriceUsd = price;
    stats.prices++;
    try { onPrice(entry.mint, price); } catch (e) { log('ONCHAIN onPrice error: ' + e.message, 'warn'); }
  }

  // A coin still on its bonding curve (pump.fun) or LetsBonk pool.
  function handleCurveData(entry, buf) {
    var d;
    try {
      d = entry.adapter.decode(buf);
    } catch (e) {
      noteBadRead(entry, 'could not read the pool data: ' + e.message);
      return;
    }
    if (d.complete) {
      entry.live = false;
      if (!entry.completeLogged) {
        entry.completeLogged = true;
        if (entry.platform === 'letsbonk') {
          log('ONCHAIN: ' + entry.mint.slice(0, 8) + '... has left its starting pool (graduated) -- on-chain prices from that pool stop; old feed covers it', 'warn');
        } else {
          log('ONCHAIN: ' + entry.mint.slice(0, 8) + '... graduated off its bonding curve -- looking for its PumpSwap pool to keep pricing it', 'warn');
        }
      }
      if (entry.platform !== 'letsbonk') startGraduation(entry);
      return;
    }
    var solUsd = getSolPrice();
    if (!solUsd || !(solUsd > 0)) return;     // no trustworthy SOL price right now: skip this tick, old feed covers it
    var quote = d.quoteLamports / 1e9;
    var tokens = d.tokenRaw / Math.pow(10, entry.decimals);
    deliverPrice(entry, (quote * solUsd) / tokens, entry.entryPriceUsd, 'the price paid');
  }

  // A graduated pump.fun coin: one of its three PumpSwap accounts changed.
  function handlePoolData(entry, role, buf) {
    if (role === 'pool') {
      try {
        var swap = require('@pump-fun/pump-swap-sdk');
        var pool = swap.PUMP_AMM_SDK.decodePool({ data: buf });
        var vq = bnToNumber(pool.virtualQuoteReserves);
        entry.pool.virtualQuote = isFinite(vq) && vq > 0 ? vq : 0;
      } catch (e) {
        noteBadRead(entry, 'could not read the PumpSwap pool account: ' + e.message);
        return;
      }
    } else {
      if (!buf || buf.length < TOKEN_AMOUNT_OFFSET + 8) {
        noteBadRead(entry, 'PumpSwap balance account data too short (' + (buf ? buf.length : 0) + ' bytes)');
        return;
      }
      entry.pool[role] = Number(buf.readBigUInt64LE(TOKEN_AMOUNT_OFFSET));
    }
    var p = entry.pool;
    if (p.base === null || p.quote === null) return;   // the first price waits for both balances
    if (!(p.base > 0)) { noteBadRead(entry, 'the PumpSwap pool holds no coins'); return; }
    var solUsd = getSolPrice();
    if (!solUsd || !(solUsd > 0)) return;
    var quote = (p.quote + p.virtualQuote) / 1e9;
    var tokens = p.base / Math.pow(10, entry.decimals);
    deliverPrice(entry, (quote * solUsd) / tokens, entry.gradRefPrice, 'the last bonding-curve price');
  }

  function handleSubData(sub, buf) {
    var entry = sub.entry;
    if (!isCurrent(entry) || entry.subs.indexOf(sub) < 0) return;
    stats.notifications++;
    if (entry.kind === 'pumpswap') handlePoolData(entry, sub.role, buf);
    else handleCurveData(entry, buf);
  }

  // Finds the graduated coin's PumpSwap pool and moves the entry over to it. Looked for every
  // GRAD_RETRY_MS, because pump.fun creates the pool a short time after the curve completes.
  function startGraduation(entry) {
    if (entry.grad) return;
    entry.grad = { tries: 0 };
    var swap;
    try {
      swap = require('@pump-fun/pump-swap-sdk');
    } catch (e) {
      disable(entry, 'the PumpSwap library could not be loaded: ' + e.message);
      return;
    }
    var poolKey;
    try {
      poolKey = asPublicKey(swap.canonicalPumpPoolPda(new PublicKey(entry.mint)));
    } catch (e) {
      disable(entry, 'the PumpSwap pool address could not be worked out: ' + e.message);
      return;
    }
    var retryLater = function(why) {
      if (!isCurrent(entry)) return;
      if (entry.grad.tries >= GRAD_MAX_TRIES) {
        disable(entry, 'its PumpSwap pool could not be read (' + why + ')');
        return;
      }
      entry.grad.timer = setTimeout(tryOnce, GRAD_RETRY_MS);
    };
    var tryOnce = function() {
      if (!isCurrent(entry) || entry.kind === 'pumpswap') return;
      entry.grad.tries++;
      var conn;
      try { conn = getConnection(); } catch (e) { retryLater('no node connection: ' + e.message); return; }
      conn.getAccountInfo(poolKey, 'processed').then(function(info) {
        if (!isCurrent(entry) || entry.kind === 'pumpswap') return;
        if (!info || !info.data) { retryLater('the pool does not exist yet'); return; }
        var pool;
        try { pool = swap.PUMP_AMM_SDK.decodePool(info); }
        catch (e) { disable(entry, 'could not read its PumpSwap pool: ' + e.message); return; }
        var quoteMint;
        try { quoteMint = asPublicKey(pool.quoteMint).toBase58(); } catch (e) { quoteMint = null; }
        if (quoteMint !== 'So11111111111111111111111111111111111111112') {
          disable(entry, 'its PumpSwap pool is not paired with SOL (quote token ' + quoteMint + ')');
          return;
        }
        switchToPool(entry, poolKey, pool);
      }).catch(function(e) {
        retryLater('read failed: ' + (e && e.message ? e.message : e));
      });
    };
    tryOnce();
  }

  function switchToPool(entry, poolKey, pool) {
    unsubscribeEntry(entry);
    var vq = bnToNumber(pool.virtualQuoteReserves);
    entry.kind = 'pumpswap';
    entry.address = poolKey;
    entry.gradRefPrice = entry.lastPriceUsd || entry.entryPriceUsd;
    entry.pool = { base: null, quote: null, virtualQuote: isFinite(vq) && vq > 0 ? vq : 0 };
    entry.firstPrice = false;
    entry.live = false;
    entry.badReads = 0;
    entry.subs = [
      makeSub(entry, 'base', asPublicKey(pool.poolBaseTokenAccount)),
      makeSub(entry, 'quote', asPublicKey(pool.poolQuoteTokenAccount)),
      makeSub(entry, 'pool', poolKey),
    ];
    stats.graduated++;
    log('ONCHAIN: ' + entry.mint.slice(0, 8) + '... now priced from its PumpSwap pool ' + poolKey.toBase58() + ' (checked against the last bonding-curve price $' + (entry.gradRefPrice > 0 ? entry.gradRefPrice.toExponential(4) : '?') + ')', 'info');
    readEntryNow(entry);
    if (wsReady) subscribeEntry(entry);
  }

  function onMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.method === 'accountNotification' && msg.params) {
      var sub = subToSub.get(msg.params.subscription);
      if (!sub) return;
      try {
        var v = msg.params.result && msg.params.result.value;
        if (!v || !v.data) return;
        var b64 = Array.isArray(v.data) ? v.data[0] : v.data;
        handleSubData(sub, Buffer.from(b64, 'base64'));
      } catch (e) {
        log('ONCHAIN notification error: ' + e.message, 'warn');
      }
      return;
    }
    if (msg.id !== undefined && reqToSub.has(msg.id)) {
      var s = reqToSub.get(msg.id);
      reqToSub.delete(msg.id);
      if (msg.error) {
        log('ONCHAIN subscribe refused for ' + s.entry.mint.slice(0, 8) + '...: ' + (msg.error.message || JSON.stringify(msg.error)), 'warn');
        return;
      }
      if (typeof msg.result === 'number') {
        if (!isCurrent(s.entry) || s.entry.subs.indexOf(s) < 0) {
          // position closed, feed disabled, or the coin moved pools while the request was in flight
          try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextReqId++, method: 'accountUnsubscribe', params: [msg.result] })); } catch (e) {}
          return;
        }
        s.subId = msg.result;
        subToSub.set(msg.result, s);
        if (s.entry.firstPrice) readSubNow(s);
      }
    }
  }

  function connect() {
    if (ws || reconnectTimer) return;
    var url = toWsUrl(getRpcUrl());
    if (!url) {
      if (!noUrlLogged) { noUrlLogged = true; log('ONCHAIN: no usable RPC address for the live price socket -- using the old price feed', 'warn'); }
      return;
    }
    noUrlLogged = false;
    var sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      log('ONCHAIN socket could not start: ' + e.message, 'warn');
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.on('open', function() {
      if (ws !== sock) return;
      wsReady = true;
      backoff = BACKOFF_START_MS;
      lastPong = Date.now();
      clearPing();
      pingTimer = setInterval(function() {
        if (ws !== sock) return;
        if (Date.now() - lastPong > DEAD_AFTER_MS) {
          log('ONCHAIN socket went silent -- reconnecting', 'warn');
          try { sock.terminate(); } catch (e) {}
          return;
        }
        try { sock.ping(); } catch (e) {}
      }, PING_MS);
      entries.forEach(function(entry) { if (!entry.disabled) subscribeEntry(entry); });
    });
    sock.on('pong', function() { lastPong = Date.now(); });
    sock.on('message', function(raw) { if (ws === sock) onMessage(raw); });
    sock.on('error', function(e) {
      log('ONCHAIN socket error: ' + (e && e.message ? e.message : e), 'warn');
    });
    sock.on('close', function() {
      if (ws !== sock) return;
      ws = null;
      wsReady = false;
      clearPing();
      reqToSub.clear();
      subToSub.clear();
      entries.forEach(function(entry) {
        entry.live = false;
        entry.subs.forEach(function(sub) { sub.subId = null; sub.reqId = null; });
      });
      if (entries.size > 0) {
        stats.reconnects++;
        log('ONCHAIN socket closed -- old price feed covers until it reconnects', 'warn');
        scheduleReconnect();
      }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var wait = backoff;
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    reconnectTimer = setTimeout(function() {
      reconnectTimer = null;
      if (entries.size > 0) connect();
    }, wait);
  }

  function closeSocket() {
    clearPing();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    var sock = ws;
    ws = null;
    wsReady = false;
    reqToSub.clear();
    subToSub.clear();
    entries.forEach(function(entry) { entry.subs.forEach(function(sub) { sub.subId = null; sub.reqId = null; }); });
    if (sock) { try { sock.close(); } catch (e) { try { sock.terminate(); } catch (e2) {} } }
  }

  function addEntry(pos) {
    var adapter;
    try {
      adapter = pos.platform === 'letsbonk' ? bonkAdapter(pos.mint) : pumpAdapter(pos.mint);
    } catch (e) {
      failed.add(pos.mint);
      log('ONCHAIN: cannot watch ' + pos.mint.slice(0, 8) + '... [' + pos.platform + ']: ' + e.message + ' -- old price feed used', 'warn');
      return;
    }
    var entry = {
      mint: pos.mint,
      platform: pos.platform,
      kind: 'curve',
      decimals: pos.tokenDecimals,
      entryPriceUsd: pos.entryPriceUsd,
      adapter: adapter,
      address: adapter.address,
      subs: [],
      firstPrice: false, disabled: false, live: false,
      lastPriceAt: 0, lastPriceUsd: null, badReads: 0, completeLogged: false,
      grad: null, pool: null, gradRefPrice: null,
    };
    entry.subs = [makeSub(entry, 'curve', adapter.address)];
    entries.set(pos.mint, entry);
    log('ONCHAIN: watching ' + pos.mint.slice(0, 8) + '... [' + pos.platform + '] pool ' + entry.address.toBase58(), 'info');
    // Immediate first reading, in parallel with the subscription.
    readEntryNow(entry);
    if (wsReady) subscribeEntry(entry);
  }

  function removeEntry(entry) {
    if (entry.grad && entry.grad.timer) clearTimeout(entry.grad.timer);
    unsubscribeEntry(entry);
    entries.delete(entry.mint);
  }

  // One direct read of an account right now. Used for the very first price and again whenever a
  // subscription (re)starts, because a fresh subscription only reports FUTURE changes -- without this a
  // quiet coin would sit with no price until its next trade.
  function readSubNow(sub) {
    try {
      getConnection().getAccountInfo(sub.address, 'processed').then(function(info) {
        if (info && info.data) handleSubData(sub, Buffer.from(info.data));
      }).catch(function(e) {
        log('ONCHAIN read failed for ' + sub.entry.mint.slice(0, 8) + '...: ' + e.message + ' (the subscription will still deliver)', 'warn');
      });
    } catch (e) {
      log('ONCHAIN read could not start: ' + e.message, 'warn');
    }
  }

  function readEntryNow(entry) {
    entry.subs.forEach(readSubNow);
  }

  // Called every second and right after a buy: makes the watched set match
  // the open positions.
  function sync(positions) {
    var want = new Map();
    (positions || []).forEach(function(p) {
      if (p && p.mint && p.entryPriceUsd > 0 && p.tokenDecimals !== undefined && p.tokenDecimals !== null) want.set(p.mint, p);
    });
    entries.forEach(function(entry, mint) {
      if (!want.has(mint)) removeEntry(entry);
    });
    failed.forEach(function(mint) { if (!want.has(mint)) failed.delete(mint); });
    want.forEach(function(p, mint) {
      if (!entries.has(mint) && !failed.has(mint)) addEntry(p);
    });
    if (entries.size > 0) {
      if (!ws && !reconnectTimer) connect();
    } else if (ws || reconnectTimer) {
      closeSocket();
    }
  }

  // True while the chain is delivering for this coin, so the old feed can
  // stand aside instead of competing with it.
  function isLive(mint) {
    var e = entries.get(mint);
    if (!(e && e.live && !e.disabled && wsReady)) return false;
    return e.subs.every(function(sub) { return sub.subId !== null && sub.subId !== undefined; });
  }

  function stop() {
    entries.forEach(function(entry) { if (entry.grad && entry.grad.timer) clearTimeout(entry.grad.timer); });
    entries.clear();
    failed.clear();
    closeSocket();
  }

  return {
    sync: sync,
    isLive: isLive,
    stop: stop,
    stats: function() {
      return { watching: entries.size, connected: wsReady, notifications: stats.notifications, prices: stats.prices, reconnects: stats.reconnects, disabled: stats.disabled, graduated: stats.graduated };
    },
  };
}

module.exports = { createWatcher, toWsUrl };
