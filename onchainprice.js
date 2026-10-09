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

function createWatcher(opts) {
  var getRpcUrl = opts.getRpcUrl;
  var getSolPrice = opts.getSolPrice;       // returns USD per SOL, or null if not fresh
  var getConnection = opts.getConnection;
  var onPrice = opts.onPrice;               // (mint, priceUsd)
  var log = opts.log || function() {};

  var entries = new Map();                  // mint -> entry
  var failed = new Set();                   // mints we gave up on (until position closes)
  var reqToEntry = new Map();
  var subToEntry = new Map();
  var nextReqId = 1;

  var ws = null;
  var wsReady = false;
  var reconnectTimer = null;
  var backoff = BACKOFF_START_MS;
  var pingTimer = null;
  var lastPong = 0;
  var noUrlLogged = false;
  var stats = { notifications: 0, prices: 0, reconnects: 0, disabled: 0 };

  function clearPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function subscribe(entry) {
    if (!ws || !wsReady || entry.disabled) return;
    var id = nextReqId++;
    entry.reqId = id;
    reqToEntry.set(id, entry);
    try {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: id, method: 'accountSubscribe',
        params: [entry.address.toBase58(), { encoding: 'base64', commitment: 'processed' }],
      }));
    } catch (e) {
      log('ONCHAIN subscribe send failed for ' + entry.mint.slice(0, 8) + '...: ' + e.message, 'warn');
    }
  }

  function disable(entry, reason) {
    if (entry.disabled) return;
    entry.disabled = true;
    entry.live = false;
    stats.disabled++;
    failed.add(entry.mint);
    log('ONCHAIN PRICE OFF for ' + entry.mint.slice(0, 8) + '... (' + reason + ') -- this position keeps using the old price feed', 'warn');
    unsubscribe(entry);
  }

  function unsubscribe(entry) {
    if (entry.subId !== null && entry.subId !== undefined) {
      subToEntry.delete(entry.subId);
      if (ws && wsReady) {
        try {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextReqId++, method: 'accountUnsubscribe', params: [entry.subId] }));
        } catch (e) { /* closing anyway */ }
      }
    }
    if (entry.reqId) reqToEntry.delete(entry.reqId);
    entry.subId = null;
  }

  function handleData(entry, buf) {
    if (entry.disabled) return;
    stats.notifications++;
    var d;
    try {
      d = entry.adapter.decode(buf);
    } catch (e) {
      entry.badReads = (entry.badReads || 0) + 1;
      if (!entry.firstPrice || entry.badReads >= 5) disable(entry, 'could not read the pool data: ' + e.message);
      return;
    }
    if (d.complete) {
      if (!entry.completeLogged) {
        entry.completeLogged = true;
        log('ONCHAIN: ' + entry.mint.slice(0, 8) + '... has left its starting pool (graduated) -- on-chain prices from that pool stop; old feed covers it', 'warn');
      }
      entry.live = false;
      return;
    }
    var solUsd = getSolPrice();
    if (!solUsd || !(solUsd > 0)) return;     // no trustworthy SOL price right now: skip this tick, old feed covers it
    var quote = d.quoteLamports / 1e9;
    var tokens = d.tokenRaw / Math.pow(10, entry.decimals);
    var price = (quote * solUsd) / tokens;
    if (!isFinite(price) || price <= 0) {
      entry.badReads = (entry.badReads || 0) + 1;
      if (!entry.firstPrice || entry.badReads >= 5) disable(entry, 'pool data gave an unusable price');
      return;
    }
    if (!entry.firstPrice) {
      var ratio = entry.entryPriceUsd > 0 ? price / entry.entryPriceUsd : 1;
      if (ratio < CALIBRATION_MIN_RATIO || ratio > CALIBRATION_MAX_RATIO) {
        disable(entry, 'first on-chain price $' + price.toExponential(4) + ' is ' + ratio.toFixed(2) + 'x the price paid $' + entry.entryPriceUsd.toExponential(4) + ' -- the maths does not match this coin');
        return;
      }
      entry.firstPrice = true;
      log('ONCHAIN PRICE LIVE for ' + entry.mint.slice(0, 8) + '... [' + entry.platform + '] first price $' + price.toExponential(4) + ' (' + ratio.toFixed(3) + 'x the price paid) -- updates now come straight from the chain', 'info');
    }
    entry.badReads = 0;
    entry.live = true;
    entry.lastPriceAt = Date.now();
    stats.prices++;
    try { onPrice(entry.mint, price); } catch (e) { log('ONCHAIN onPrice error: ' + e.message, 'warn'); }
  }

  function onMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.method === 'accountNotification' && msg.params) {
      var entry = subToEntry.get(msg.params.subscription);
      if (!entry) return;
      try {
        var v = msg.params.result && msg.params.result.value;
        if (!v || !v.data) return;
        var b64 = Array.isArray(v.data) ? v.data[0] : v.data;
        handleData(entry, Buffer.from(b64, 'base64'));
      } catch (e) {
        log('ONCHAIN notification error: ' + e.message, 'warn');
      }
      return;
    }
    if (msg.id !== undefined && reqToEntry.has(msg.id)) {
      var ent = reqToEntry.get(msg.id);
      reqToEntry.delete(msg.id);
      if (msg.error) {
        log('ONCHAIN subscribe refused for ' + ent.mint.slice(0, 8) + '...: ' + (msg.error.message || JSON.stringify(msg.error)), 'warn');
        return;
      }
      if (typeof msg.result === 'number') {
        if (!entries.has(ent.mint) || ent.disabled) {
          // position closed (or feed disabled) while the request was in flight
          try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextReqId++, method: 'accountUnsubscribe', params: [msg.result] })); } catch (e) {}
          return;
        }
        ent.subId = msg.result;
        subToEntry.set(msg.result, ent);
        if (ent.firstPrice) readNow(ent);
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
      entries.forEach(function(entry) { if (!entry.disabled) subscribe(entry); });
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
      reqToEntry.clear();
      subToEntry.clear();
      entries.forEach(function(entry) { entry.subId = null; entry.live = false; });
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
    reqToEntry.clear();
    subToEntry.clear();
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
      decimals: pos.tokenDecimals,
      entryPriceUsd: pos.entryPriceUsd,
      adapter: adapter,
      address: adapter.address,
      subId: null, reqId: null,
      firstPrice: false, disabled: false, live: false,
      lastPriceAt: 0, badReads: 0, completeLogged: false,
    };
    entries.set(pos.mint, entry);
    log('ONCHAIN: watching ' + pos.mint.slice(0, 8) + '... [' + pos.platform + '] pool ' + entry.address.toBase58(), 'info');
    // Immediate first reading, in parallel with the subscription.
    readNow(entry);
    if (wsReady) subscribe(entry);
  }

  // One direct read of the pool right now. Used for the very first price and
  // again whenever a subscription (re)starts, because a fresh subscription
  // only reports FUTURE changes -- without this a quiet coin would sit with
  // no price until its next trade.
  function readNow(entry) {
    try {
      getConnection().getAccountInfo(entry.address, 'processed').then(function(info) {
        if (info && info.data && entries.get(entry.mint) === entry) handleData(entry, Buffer.from(info.data));
      }).catch(function(e) {
        log('ONCHAIN read failed for ' + entry.mint.slice(0, 8) + '...: ' + e.message + ' (the subscription will still deliver)', 'warn');
      });
    } catch (e) {
      log('ONCHAIN read could not start: ' + e.message, 'warn');
    }
  }

  // Called every second and right after a buy: makes the watched set match
  // the open positions.
  function sync(positions) {
    var want = new Map();
    (positions || []).forEach(function(p) {
      if (p && p.mint && p.entryPriceUsd > 0 && p.tokenDecimals !== undefined && p.tokenDecimals !== null) want.set(p.mint, p);
    });
    entries.forEach(function(entry, mint) {
      if (!want.has(mint)) {
        unsubscribe(entry);
        entries.delete(mint);
      }
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
    return !!(e && e.live && !e.disabled && wsReady && e.subId !== null && e.subId !== undefined);
  }

  function stop() {
    entries.clear();
    failed.clear();
    closeSocket();
  }

  return {
    sync: sync,
    isLive: isLive,
    stop: stop,
    stats: function() {
      return { watching: entries.size, connected: wsReady, notifications: stats.notifications, prices: stats.prices, reconnects: stats.reconnects, disabled: stats.disabled };
    },
  };
}

module.exports = { createWatcher, toWsUrl };
