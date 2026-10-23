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
//
// The number is kept for TIP_CACHE_TTL_MS and refreshed in the background
// (warmTipCache), so a real buy or sell no longer waits on this outside web
// request before it can be sent. If the web request fails, the last good
// number (up to TIP_CACHE_STALE_MS old) is used before falling back to the
// tier's minimum.
// Node's built-in fetch ignores a "timeout" option, so the two outside web
// requests in this file would wait forever if the other side stopped
// answering -- and a real sell waiting on one would never go out. This gives
// them a real time limit.
async function fetchWithTimeout(url, options, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

var TIP_CACHE_TTL_MS = 15000;
var TIP_CACHE_STALE_MS = 60000;
var tipCache = {};

async function fetchTipFloorLamports(tier) {
  var minLamports = tier.minLamports;
  try {
    var res = await fetchWithTimeout('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {}, 3000);
    if (!res.ok) return null;
    var data = await res.json();
    var row = Array.isArray(data) ? data[0] : data;
    var p75 = row && (row.landed_tips_75th_percentile || row.landedTips75thPercentile);
    if (typeof p75 !== 'number' || !(p75 > 0)) return null;
    var fetchedLamports = Math.round(p75 * 1000000000); // the endpoint reports SOL, not lamports
    return Math.max(fetchedLamports, minLamports);
  } catch (e) {
    return null;
  }
}

async function fetchCurrentTipLamports(tier, forceRefresh) {
  var key = String(tier.minLamports);
  var cached = tipCache[key];
  if (!forceRefresh && cached && (Date.now() - cached.at) < TIP_CACHE_TTL_MS) return cached.lamports;
  var fresh = await fetchTipFloorLamports(tier);
  if (fresh !== null) {
    tipCache[key] = { lamports: fresh, at: Date.now() };
    return fresh;
  }
  if (cached && (Date.now() - cached.at) < TIP_CACHE_STALE_MS) return cached.lamports;
  return tier.minLamports;
}

// Keeps the tip number fresh while live trading is on.
function warmTipCache() {
  return fetchCurrentTipLamports(SENDER_TIERS.SWQOS_ONLY, true).catch(function() {});
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

// Where buys and sells are submitted. Helius runs Sender in several places; their docs say a
// backend program should use the regional address closest to it (plain http), and the single
// global https address is for browsers. The bot runs in Ohio, so the default is Newark.
// SENDER_REGION in Render changes it without a code push: ewr (Newark), slc (Salt Lake City),
// lon (London), fra (Frankfurt), ams (Amsterdam), sg (Singapore), tyo (Tokyo), global (the old
// https address), or a full address starting with http.
// "ab" (the default for now) is a test: every send picks Newark or the global address at random, and
// the Live CSV records which one each buy and sell used, so the two can be compared in the same market.
var SENDER_REGIONS = { ewr: 1, slc: 1, lon: 1, fra: 1, ams: 1, sg: 1, tyo: 1 };
var SENDER_GLOBAL = 'https://sender.helius-rpc.com/fast';
var SENDER_NEWARK = 'http://ewr-sender.helius-rpc.com/fast';
function senderBase() {
  var raw = String(process.env.SENDER_REGION || '').trim();
  var v = raw.toLowerCase();
  if (v === '' || v === 'ab') return Math.random() < 0.5 ? SENDER_NEWARK : SENDER_GLOBAL;
  if (v === 'global') return SENDER_GLOBAL;
  if (SENDER_REGIONS[v]) return 'http://' + v + '-sender.helius-rpc.com/fast';
  if (/^https?:\/\/[^\s?]+$/i.test(raw)) return raw;
  return SENDER_NEWARK;
}
function hostOf(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/[\/?].*$/, '');
}
function senderHost() {
  var v = String(process.env.SENDER_REGION || '').trim().toLowerCase();
  if (v === '' || v === 'ab') return 'TEST: ' + hostOf(SENDER_NEWARK) + ' and ' + hostOf(SENDER_GLOBAL) + ' take turns at random';
  return hostOf(senderBase());
}

function buildSenderUrl(rpcUrl, tier) {
  var apiKey = extractApiKey(rpcUrl);
  var query = 'api-key=' + apiKey + (tier.queryParam ? '&' + tier.queryParam : '');
  return senderBase() + '?' + query;
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

// The block height is only used to tell when a transaction's window has closed,
// so it is read at most about once every 1.5 seconds and shared by every trade
// being watched at the same time, instead of one read per trade every 2 seconds.
var heightShared = { at: 0, value: null, inflight: null };
async function readBlockHeightShared(connection) {
  if (heightShared.value !== null && (Date.now() - heightShared.at) < 1500) return heightShared.value;
  if (heightShared.inflight) return heightShared.inflight;
  heightShared.inflight = connection.getBlockHeight().then(function(h) {
    heightShared.value = h;
    heightShared.at = Date.now();
    heightShared.inflight = null;
    return h;
  }, function(e) {
    heightShared.inflight = null;
    throw e;
  });
  return heightShared.inflight;
}

// The latest blockhash, kept for BLOCKHASH_MAX_AGE_MS and shared by every buy and sell that
// needs one in that time. A blockhash stays valid for about a minute, so one that is 2 seconds old
// is as good as a new one -- but reading it takes a request and a wait, and a buy or sell that is
// ready to go should not have to stand in line for it. Reads in flight are shared too.
var BLOCKHASH_MAX_AGE_MS = 2000;
var hashShared = { at: 0, value: null, inflight: null };
async function getBlockhashShared(connection) {
  if (hashShared.value && (Date.now() - hashShared.at) < BLOCKHASH_MAX_AGE_MS) return hashShared.value;
  if (hashShared.inflight) return hashShared.inflight;
  hashShared.inflight = connection.getLatestBlockhash().then(function(h) {
    hashShared.value = h;
    hashShared.at = Date.now();
    hashShared.inflight = null;
    return h;
  }, function(e) {
    hashShared.inflight = null;
    throw e;
  });
  return hashShared.inflight;
}
// Forgotten after any send the network refused, so the next try reads a fresh one.
function forgetBlockhash() { hashShared.value = null; hashShared.at = 0; }

// The request gate (counts requests, keeps them under the plan limit, puts sells first).
// If the file is missing everything still works, just without those protections.
var gateModule;
function gate() {
  if (gateModule === undefined) {
    try { gateModule = require('./rpcgate'); } catch (e) { gateModule = null; }
  }
  return gateModule;
}

// Runs fn tagged with a priority (0 = a sell is waiting on this answer). fn gets an object
// whose maxWait is how long the request waited in line.
function runWithGate(prio, fn) {
  var g = gate();
  if (g && prio !== null && prio !== undefined) return g.runTracked(prio, fn);
  return fn({ maxWait: 0 });
}

// -- THE SHARED CONFIRM CHECKER ------------------------------------
// Every transaction being waited on is registered here, and ONE request per tick asks
// the node about all of them together (getSignatureStatuses takes a list). Before this,
// each trade asked for itself about 2.5 times a second, so four trades in flight used
// the whole Free-plan allowance of 10 requests a second on confirming alone.
//
// The rules for each transaction are unchanged: a landed transaction is CONFIRMED, a
// failed one is FAILED, one past its block-height window is EXPIRED, and one that is not
// known by the time limit is PENDING (sent, outcome unknown) -- never a thrown error, and
// the signature is always kept.
var watchers = new Map();      // signature -> [watcher, ...]
var pollerRunning = false;
var STATUS_CHUNK = 200;
// A transaction's window (its blockhash) cannot close sooner than about 60 seconds after the
// blockhash was read: it lasts 150 blocks and the chain makes at most about 2.5 blocks a second.
// So the block height tells nothing before then, and it is not read at all until a watcher is this old.
var HEIGHT_CHECK_AFTER_MS = 50000;

function allWatchers() {
  var out = [];
  watchers.forEach(function(list) { list.forEach(function(w) { out.push(w); }); });
  return out;
}

function finishWatcher(w, result) {
  if (w.done) return;
  w.done = true;
  var list = watchers.get(w.signature);
  if (list) {
    var i = list.indexOf(w);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) watchers.delete(w.signature);
  }
  result.checks = w.checks;
  result.pollWaitMs = w.waitMs;
  // How the landing was noticed: 'ws' (the signature subscription, see below) or 'poll' (the checker).
  if ((result.outcome === 'CONFIRMED' || result.outcome === 'FAILED') && !result.landSource) result.landSource = 'poll';
  // Nobody is waiting on this signature any more: its subscription is released.
  if (!watchers.has(w.signature)) dropLanding(w.signature);
  w.resolve(result);
}

// -- NOTICING A LANDING THE MOMENT IT HAPPENS ---------------------
// The checker above asks the node "has it landed yet?" at 0.4 s, then every 0.8 s, so a buy that
// lands 100 ms after a check is noticed up to 800 ms late (that delay is in BuyLandMs, and the
// position is not watched until it ends). A signature subscription flips that around: the node
// pushes a message the moment the transaction is confirmed. The checker stays running as the
// backup, exactly as before; whichever hears first settles the transaction, with the same
// meaning (confirmed with no error = CONFIRMED, confirmed with an error = FAILED). Every result
// says which one heard it (landSource). If the socket is down, unavailable, or LANDING_SOCKET=off
// is set in Render, nothing changes: the checker alone does the job, as it always did.
var WS = null;
try { WS = require('ws'); } catch (e) { WS = null; }
var landing = {
  url: null, sock: null, open: false, pingTimer: null, lastPongAt: 0, nextId: 1,
  reqs: new Map(),   // request id -> signature, until the node answers with a subscription number
  subs: new Map(),   // subscription number -> signature
  want: new Map(),   // signature -> { at, subId, fired }
  stats: { opened: 0, closed: 0, subscribed: 0, notifications: 0, errors: 0, lastError: null },
};

function toWsUrl(u) {
  u = String(u || '').trim();
  if (u.indexOf('https://') === 0) return 'wss://' + u.slice(8);
  if (u.indexOf('http://') === 0) return 'ws://' + u.slice(7);
  if (u.indexOf('wss://') === 0 || u.indexOf('ws://') === 0) return u;
  return null;
}

function landingEnabled() {
  return !!WS && String(process.env.LANDING_SOCKET || '').trim().toLowerCase() !== 'off';
}

function landingSend(obj) {
  try { landing.sock.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function landingSubscribe(signature) {
  var id = landing.nextId++;
  landing.reqs.set(id, signature);
  if (!landingSend({ jsonrpc: '2.0', id: id, method: 'signatureSubscribe', params: [signature, { commitment: 'confirmed' }] })) landing.reqs.delete(id);
}

function dropLanding(signature) {
  var e = landing.want.get(signature);
  if (!e) return;
  landing.want.delete(signature);
  if (e.subId !== null && e.subId !== undefined) {
    landing.subs.delete(e.subId);
    // A subscription that already fired is removed by the node itself.
    if (!e.fired && landing.open) landingSend({ jsonrpc: '2.0', id: landing.nextId++, method: 'signatureUnsubscribe', params: [e.subId] });
  }
}

function onLandingMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg && msg.id !== undefined && landing.reqs.has(msg.id)) {
    var sigReq = landing.reqs.get(msg.id);
    landing.reqs.delete(msg.id);
    if (msg.error || typeof msg.result !== 'number') {
      landing.stats.errors++;
      landing.stats.lastError = JSON.stringify(msg.error || msg).slice(0, 200);
      return;
    }
    landing.stats.subscribed++;
    var entry = landing.want.get(sigReq);
    if (entry) {
      entry.subId = msg.result;
      landing.subs.set(msg.result, sigReq);
    } else {
      // Nobody is waiting for this signature any more.
      landingSend({ jsonrpc: '2.0', id: landing.nextId++, method: 'signatureUnsubscribe', params: [msg.result] });
    }
    return;
  }
  if (msg && msg.method === 'signatureNotification' && msg.params) {
    var sig = landing.subs.get(msg.params.subscription);
    if (!sig) return;
    var val = msg.params.result && msg.params.result.value;
    if (val === undefined || val === null || val === 'receivedSignature') return;
    landing.stats.notifications++;
    var e2 = landing.want.get(sig);
    if (e2) e2.fired = true;
    var err = val.err;
    var list = watchers.get(sig) ? watchers.get(sig).slice() : [];
    list.forEach(function(w) {
      finishWatcher(w, err ? { outcome: 'FAILED', signature: sig, error: JSON.stringify(err), landSource: 'ws' } : { outcome: 'CONFIRMED', signature: sig, landSource: 'ws' });
    });
    dropLanding(sig);
  }
}

function connectLanding(wsUrl) {
  if (!landingEnabled() || !wsUrl) return;
  if (landing.sock && landing.url === wsUrl && (landing.sock.readyState === 0 || landing.sock.readyState === 1)) return;
  if (landing.sock) { try { landing.sock.terminate(); } catch (e) {} landing.sock = null; landing.open = false; }
  landing.url = wsUrl;
  var sock;
  try { sock = new WS(wsUrl); } catch (e) { landing.sock = null; return; }
  landing.sock = sock;
  landing.open = false;
  sock.on('open', function() {
    if (landing.sock !== sock) return;
    landing.open = true;
    landing.stats.opened++;
    landing.lastPongAt = Date.now();
    clearInterval(landing.pingTimer);
    landing.pingTimer = setInterval(function() {
      // A socket that stopped answering is dropped, so the next send opens a fresh one.
      if (Date.now() - landing.lastPongAt > 70000) { try { sock.terminate(); } catch (e) {} return; }
      try { sock.ping(); } catch (e) {}
    }, 25000);
    if (landing.pingTimer.unref) landing.pingTimer.unref();
    landing.want.forEach(function(entry, signature) { if (entry.subId === null && !entry.fired) landingSubscribe(signature); });
  });
  sock.on('pong', function() { landing.lastPongAt = Date.now(); });
  sock.on('message', function(data) { onLandingMessage(String(data)); });
  sock.on('error', function() { /* a close follows; the checker is the backup meanwhile */ });
  sock.on('close', function() {
    if (landing.sock !== sock) return;
    landing.open = false;
    landing.sock = null;
    clearInterval(landing.pingTimer);
    landing.stats.closed++;
    landing.reqs.clear();
    landing.subs.clear();
    landing.want.forEach(function(entry) { entry.subId = null; });
  });
}

function watchLanding(signature, wsUrl) {
  if (!landingEnabled() || !wsUrl) return;
  try {
    var now = Date.now();
    landing.want.forEach(function(entry, sig) { if (now - entry.at > 120000) dropLanding(sig); });
    if (landing.want.has(signature)) return;
    landing.want.set(signature, { at: now, subId: null, fired: false });
    connectLanding(wsUrl);
    if (landing.open) landingSubscribe(signature);
  } catch (e) { /* the checker covers it */ }
}

// Opens the socket ahead of time (called while live trading is on) so the first buy does not wait for
// the connection to be made.
function warmLandingSocket(rpcUrl) {
  try { connectLanding(toWsUrl(rpcUrl)); } catch (e) { /* optional */ }
}

function landingStatus() {
  return { available: !!WS, enabled: landingEnabled(), connected: landing.open, waiting: landing.want.size, opened: landing.stats.opened, closed: landing.stats.closed, subscribed: landing.stats.subscribed, notifications: landing.stats.notifications, errors: landing.stats.errors, lastError: landing.stats.lastError };
}

// One batched request (or a few, if there are very many) for a list of signatures.
async function readStatuses(connection, signatures, prio, tickInfo) {
  var map = {};
  for (var i = 0; i < signatures.length; i += STATUS_CHUNK) {
    var chunk = signatures.slice(i, i + STATUS_CHUNK);
    var res = await runWithGate(prio, function(track) {
      return connection.getSignatureStatuses(chunk).then(function(r) {
        if (tickInfo && track && track.maxWait > tickInfo.maxWait) tickInfo.maxWait = track.maxWait;
        return r;
      });
    });
    var values = (res && res.value) || [];
    for (var k = 0; k < chunk.length; k++) map[chunk[k]] = values[k] || null;
  }
  return map;
}

function judgeStatus(w, status) {
  if (status) {
    if (isSuccessStatus(status)) { finishWatcher(w, { outcome: 'CONFIRMED', signature: w.signature }); return true; }
    if (status.err) { finishWatcher(w, { outcome: 'FAILED', signature: w.signature, error: JSON.stringify(status.err) }); return true; }
  }
  return false;
}

async function runPoller() {
  var lastHeightCheck = 0;
  while (watchers.size > 0) {
    var all = allWatchers();
    if (all.length === 0) break;
    var connection = all[0].connection;
    var now = Date.now();
    var interval = Infinity, prio = null;
    all.forEach(function(w) {
      var each = (now - w.startTime) < 3000 ? w.pollIntervalMs : w.pollIntervalMs * 2;
      if (each < interval) interval = each;
      var p = (w.prio === null || w.prio === undefined) ? 1 : w.prio;
      if (prio === null || p < prio) prio = p;
    });
    var waitMs = interval;
    var tickErr = null;
    var tickInfo = { maxWait: 0 };

    try {
      var signatures = [];
      var seen = {};
      all.forEach(function(w) { if (!seen[w.signature]) { seen[w.signature] = true; signatures.push(w.signature); } });
      var statusMap = await readStatuses(connection, signatures, prio, tickInfo);
      all.forEach(function(w) {
        if (w.done) return;
        w.checks++;
        if (tickInfo.maxWait > w.waitMs) w.waitMs = tickInfo.maxWait;
        judgeStatus(w, statusMap[w.signature]);
      });

      // The status is checked often so a landed transaction is noticed quickly; the
      // (slower-changing) block height only needs checking every couple of seconds.
      // A transaction can only be past its window after about a minute (see HEIGHT_CHECK_AFTER_MS), so
      // the block height is not read before a watcher is 50 seconds old.
      var oldestAgeMs = 0;
      allWatchers().forEach(function(w) { var a = Date.now() - w.startTime; if (a > oldestAgeMs) oldestAgeMs = a; });
      if (oldestAgeMs >= HEIGHT_CHECK_AFTER_MS && Date.now() - lastHeightCheck >= 2000 && allWatchers().length > 0) {
        lastHeightCheck = Date.now();
        var currentBlockHeight = await runWithGate(prio, function() { return readBlockHeightShared(connection); });
        var overdue = allWatchers().filter(function(w) { return currentBlockHeight > w.latest.lastValidBlockHeight; });
        if (overdue.length > 0) {
          var overdueSigs = [];
          var seenOverdue = {};
          overdue.forEach(function(w) { if (!seenOverdue[w.signature]) { seenOverdue[w.signature] = true; overdueSigs.push(w.signature); } });
          var finalMap = await readStatuses(connection, overdueSigs, prio, tickInfo);
          overdue.forEach(function(w) {
            if (w.done) return;
            if (!judgeStatus(w, finalMap[w.signature])) finishWatcher(w, { outcome: 'EXPIRED', signature: w.signature });
          });
        }
      }
    } catch (readErr) {
      // Could not read the chain this time. The transactions are already sent, so every
      // signature is kept and looked at again after a short pause.
      tickErr = readErr;
      waitMs = Math.max(waitMs, 800);
      lastHeightCheck = 0;
      allWatchers().forEach(function(w) { w.readErrors++; w.lastReadError = readErr; });
    }

    // Anything not settled by its time limit is PENDING.
    var after = Date.now();
    allWatchers().forEach(function(w) {
      if (after - w.startTime > w.maxPollMs) {
        var pending = { outcome: 'PENDING', signature: w.signature, lastValidBlockHeight: w.latest.lastValidBlockHeight };
        if (w.readErrors > 0) {
          pending.readErrors = w.readErrors;
          pending.lastReadError = String((w.lastReadError && w.lastReadError.message) || w.lastReadError);
        }
        finishWatcher(w, pending);
      }
    });

    if (watchers.size === 0) break;
    await new Promise(function(resolve) { setTimeout(resolve, waitMs); });
  }
}

function startPoller() {
  if (pollerRunning) return;
  pollerRunning = true;
  // Started a moment later so transactions registered at the same instant share the first request.
  Promise.resolve().then(function() { return runPoller(); }).catch(function(e) {
    // A bug here must never leave a transaction without an answer: everything still
    // being watched is settled as PENDING (sent, outcome unknown) with its signature.
    allWatchers().forEach(function(w) {
      finishWatcher(w, { outcome: 'PENDING', signature: w.signature, lastValidBlockHeight: w.latest.lastValidBlockHeight, readErrors: w.readErrors + 1, lastReadError: 'confirm checker error: ' + String((e && e.message) || e) });
    });
  }).then(function() {
    pollerRunning = false;
    if (watchers.size > 0) startPoller();
  });
}

// Same contract as always: returns { outcome, signature, ... }. The only difference is
// that waiting for the answer is shared with every other transaction in flight.
function pollForOutcome(signature, connection, latest, options) {
  options = options || {};
  return new Promise(function(resolve) {
    var g = gate();
    var w = {
      signature: signature, connection: connection, latest: latest, resolve: resolve, done: false,
      startTime: Date.now(),
      pollIntervalMs: options.pollIntervalMs || 400,
      maxPollMs: options.maxPollMs || 30000,
      readErrors: 0, lastReadError: null, checks: 0, waitMs: 0,
      prio: g ? g.currentPriority() : null,
    };
    var list = watchers.get(signature);
    if (!list) { list = []; watchers.set(signature, list); }
    list.push(w);
    if (options.wsUrl) watchLanding(signature, options.wsUrl);
    startPoller();
  });
}

// Normal path: send through the regular connection, same as before.
async function sendAndConfirm(transaction, keypair, connection, options) {
  options = options || {};
  var latest = await getBlockhashShared(connection);
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = keypair.publicKey;
  transaction.sign(keypair);
  var signature;
  try {
    signature = await connection.sendRawTransaction(transaction.serialize(), options.skipPreflight ? { skipPreflight: true } : undefined);
  } catch (sendErr) {
    forgetBlockhash();
    throw sendErr;
  }
  var outcome = await pollForOutcome(signature, connection, latest, options);
  if (outcome.outcome !== 'CONFIRMED') forgetBlockhash();
  return outcome;
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

  // The tip number and the latest blockhash do not depend on each other, so
  // they are fetched at the same time.
  // If the caller already started these two reads (while the transaction was still being built),
  // their answers are used. If that did not work out, they are simply read again here.
  var tipAndHash = null;
  if (options.prefetched) {
    try { tipAndHash = await options.prefetched; } catch (e) { tipAndHash = null; }
    if (!tipAndHash || !tipAndHash[1] || !tipAndHash[1].blockhash) tipAndHash = null;
  }
  if (!tipAndHash) tipAndHash = await Promise.all([fetchCurrentTipLamports(tier), getBlockhashShared(connection)]);
  var tipLamports = tipAndHash[0];
  var latest = tipAndHash[1];

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
  var senderUsed = hostOf(senderUrl);
  var body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [serialized.toString('base64'), { encoding: 'base64', skipPreflight: true }],
  };
  // From here on the transaction may already be on its way. A timeout or a broken reply does
  // NOT prove it was not received, so such errors are marked (mayHaveSent) and the caller
  // checks the wallet before treating the trade as not having happened.
  var json;
  try {
    var res = await fetchWithTimeout(senderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000);
    json = await res.json();
  } catch (sendErr) {
    forgetBlockhash();
    sendErr.mayHaveSent = true;
    throw sendErr;
  }
  if (json.error) {
    forgetBlockhash();
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
    err2.mayHaveSent = true;
    throw err2;
  }
  var outcome = await pollForOutcome(signature, connection, latest, Object.assign({}, options, { wsUrl: toWsUrl(rpcUrl) }));
  if (outcome.outcome !== 'CONFIRMED') forgetBlockhash();
  outcome.tipLamports = tipLamports;
  outcome.senderHost = senderUsed;
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

// Starts the two reads a send needs (the tip number and the latest blockhash) right now, so the
// caller can run them while the transaction is still being built. Pass the returned promise to
// sendAndConfirmViaSender as options.prefetched. Never rejects (a failed read is read again at send time).
function prefetchSendParts(connection, tierName) {
  var tier = SENDER_TIERS[tierName || 'SWQOS_ONLY'];
  if (!tier) return Promise.resolve(null);
  return Promise.all([fetchCurrentTipLamports(tier), getBlockhashShared(connection)]).catch(function() { return null; });
}

module.exports = {
  sendAndConfirm,
  sendAndConfirmViaSender,
  prefetchSendParts,
  readBlockHeightShared,
  warmLandingSocket,
  landingStatus,
  senderHost,
  testSelfTransfer,
  testSelfTransferViaSender,
  fetchCurrentTipLamports,
  warmTipCache,
  HELIUS_SENDER_TIP_ACCOUNTS,
  SENDER_TIERS,
};
