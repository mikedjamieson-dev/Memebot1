'use strict';
// -- RPC GATE -------------------------------------------------------
// Every request the bot sends to the Helius node passes through here.
//
// It does four jobs:
//  1. COUNTS the requests, per second and per kind, so the real request rate is
//     measured instead of guessed (and so each trade can report it in the CSV).
//  2. LIMITS the rate to just under the plan limit (the Free plan allows 10 per
//     second; the default here is 9). Requests over the limit wait their turn instead of
//     being refused with a 429 -- a refused request is retried by the library for
//     several seconds, which is what made reads take 7-12 seconds in the last test.
//  3. PUTS SELLS FIRST. When requests are waiting, a request that belongs to a
//     sell goes ahead of buy and background requests.
//  4. WATCHES for a slow node. If requests are taking far longer than normal, or the
//     node is refusing them, new buys are paused until it recovers (open positions
//     are never touched by this -- only NEW entries wait).
//
// It never changes what a request says or what comes back.

const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

const LIMIT_PER_SEC = Math.max(1, parseInt(process.env.RPC_MAX_PER_SEC, 10) || 9);
// Slots in every second kept free for sells: buy and background requests stop at
// LIMIT - RESERVE, so a sell never has to wait for the second to roll over.
const SELL_RESERVE = Math.min(LIMIT_PER_SEC - 1, Math.max(0, parseInt(process.env.RPC_SELL_RESERVE, 10) || 2));
const SLOW_MS = Math.max(500, parseInt(process.env.RPC_SLOW_MS, 10) || 2500);   // one read slower than this counts as slow
const SLOW_WINDOW_S = Math.max(1, parseInt(process.env.RPC_SLOW_WINDOW_S, 10) || 15);   // how far back the slow check looks
const CALM_BEFORE_RESUME_MS = Math.max(500, parseInt(process.env.RPC_CALM_MS, 10) || 10000);
const KEEP_BUCKETS_MS = 6 * 3600 * 1000;

// Requests that are naturally slow (large replies). They never count as "the node is slow".
const HEAVY = { getParsedTokenAccountsByOwner: 1, getTokenAccountsByOwner: 1, getProgramAccounts: 1, getTransaction: 1, getSignaturesForAddress: 1 };

// Priority 0 goes first. Used when a request is not inside a tagged job.
const METHOD_PRIO = {
  sendTransaction: 0, simulateTransaction: 0,
  getLatestBlockhash: 1, getBlockHeight: 1, getSignatureStatuses: 1,
  getAccountInfo: 1, getMultipleAccounts: 1,
};

let log = function() {};
function setLogger(fn) { log = typeof fn === 'function' ? fn : function() {}; }

// -- the waiting line ------------------------------------------------
const sent = [];        // start times (ms) of requests sent in the last second (one entry per request)
const queue = [];       // waiting requests
let seq = 0;
let pumpTimer = null;

function pump() {
  if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  const now = Date.now();
  while (sent.length && now - sent[0] >= 1000) sent.shift();
  while (queue.length) {
    // The best waiting request: lowest priority number; a long wait moves a request up one
    // place every 5 seconds so nothing waits forever.
    let bi = 0, bScore = Infinity, bSeq = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      const score = q.prio - Math.floor((now - q.at) / 5000);
      if (score < bScore || (score === bScore && q.seq < bSeq)) { bi = i; bScore = score; bSeq = q.seq; }
    }
    const pick = queue[bi];
    const cap = pick.prio === 0 ? LIMIT_PER_SEC : (LIMIT_PER_SEC - SELL_RESERVE);
    const w = Math.min(pick.weight, cap);
    if (sent.length + w > cap) break;
    queue.splice(bi, 1);
    for (let k = 0; k < w; k++) sent.push(now);
    pick.resolve(now - pick.at);
  }
  if (queue.length) {
    const wake = Math.max(5, (sent[0] + 1000) - Date.now() + 2);
    pumpTimer = setTimeout(pump, wake);
  }
}

function acquire(prio, weight) {
  return new Promise(function(resolve) {
    queue.push({ prio: prio, weight: weight || 1, at: Date.now(), seq: seq++, resolve: resolve });
    pump();
  });
}

// -- the numbers ------------------------------------------------------
// One bucket per second that had any activity.
const buckets = new Map();
function bucketFor(ms) {
  const key = Math.floor(ms / 1000);
  let b = buckets.get(key);
  if (!b) { b = { n: 0, kinds: {}, maxLat: 0, slow: 0, n429: 0, errs: 0, maxWait: 0, maxWait0: 0 }; buckets.set(key, b); }
  return b;
}
const totals = { requests: 0, n429: 0, errs: 0, slowest: 0, byKind: {}, since: Date.now() };

function pruneBuckets() {
  const cutoff = Math.floor((Date.now() - KEEP_BUCKETS_MS) / 1000);
  buckets.forEach(function(_b, k) { if (k < cutoff) buckets.delete(k); });
}

// -- tagging jobs ------------------------------------------------------
// runTracked(prio, fn): everything fn does (including every await inside it) is tagged with
// this priority, and the time its requests spent waiting in line is recorded on `track`.
function runTracked(prio, fn) {
  const track = { prio: prio, requests: 0, maxWait: 0 };
  return als.run(track, function() { return fn(track); });
}
// Same, for one-off tagged calls where the numbers are not needed.
function runWithPriority(prio, fn) { return runTracked(prio, function() { return fn(); }); }
function currentPriority() {
  const s = als.getStore();
  return s && typeof s.prio === 'number' ? s.prio : null;
}

// -- the fetch that goes between the library and the node ---------------------
const METHOD_RE = /"method"\s*:\s*"([A-Za-z0-9_]+)"/g;
function readBody(init) {
  const body = init && init.body;
  if (typeof body !== 'string') return { method: 'unknown', weight: 1 };
  const head = body.length > 4000 ? body.slice(0, 4000) : body;
  const isBatch = head.charAt(0) === '[';
  let first = null, count = 0, m;
  METHOD_RE.lastIndex = 0;
  while ((m = METHOD_RE.exec(isBatch ? body : head)) !== null) {
    if (first === null) first = m[1];
    count++;
    if (!isBatch) break;
  }
  return { method: first || 'unknown', weight: Math.max(1, count) };
}

let realFetch = null;
function getRealFetch() {
  if (realFetch) return realFetch;
  if (typeof globalThis.fetch === 'function') realFetch = globalThis.fetch.bind(globalThis);
  else realFetch = require('node-fetch');
  return realFetch;
}
// Tests can put a fake node in place of the real fetch.
function _setRealFetch(fn) { realFetch = fn; }

function gatedFetch(url, init) {
  const info = readBody(init);
  const store = als.getStore();
  let prio = store && typeof store.prio === 'number' ? store.prio : null;
  if (prio === null) prio = METHOD_PRIO[info.method] !== undefined ? METHOD_PRIO[info.method] : 2;
  return acquire(prio, info.weight).then(function(waited) {
    const startedAt = Date.now();
    const b = bucketFor(startedAt);
    b.n += info.weight;
    b.kinds[info.method] = (b.kinds[info.method] || 0) + info.weight;
    if (waited > b.maxWait) b.maxWait = waited;
    if (prio === 0 && waited > b.maxWait0) b.maxWait0 = waited;
    totals.requests += info.weight;
    totals.byKind[info.method] = (totals.byKind[info.method] || 0) + info.weight;
    if (store) { store.requests += info.weight; if (waited > store.maxWait) store.maxWait = waited; }
    const done = function(status, failed) {
      const lat = Date.now() - startedAt;
      const bb = bucketFor(Date.now());
      if (!HEAVY[info.method]) {
        if (lat > bb.maxLat) bb.maxLat = lat;
        if (lat > totals.slowest) totals.slowest = lat;
        if (lat >= SLOW_MS) bb.slow++;
      }
      if (status === 429) { bb.n429++; totals.n429++; }
      if (failed) { bb.errs++; totals.errs++; }
      evaluate();
    };
    return getRealFetch()(url, init).then(function(res) {
      done(res && res.status, false);
      return res;
    }, function(err) {
      done(0, true);
      throw err;
    });
  });
}

// -- slow-node watch --------------------------------------------------
const state = { paused: false, reason: '', since: 0, lastBadAt: 0, episodes: [] };

function windowSums(seconds) {
  const nowKey = Math.floor(Date.now() / 1000);
  let slow = 0, n429 = 0, errs = 0, maxWait = 0;
  for (let k = nowKey - seconds; k <= nowKey; k++) {
    const b = buckets.get(k);
    if (!b) continue;
    slow += b.slow; n429 += b.n429; errs += b.errs;
    if (b.maxWait > maxWait) maxWait = b.maxWait;
  }
  return { slow: slow, n429: n429, errs: errs, maxWait: maxWait };
}

function badNow() {
  const w = windowSums(SLOW_WINDOW_S);
  if (w.n429 >= 2) return 'the node refused ' + w.n429 + ' requests as too many (429) in the last ' + SLOW_WINDOW_S + 's';
  if (w.slow >= 3) return w.slow + ' reads took over ' + (SLOW_MS / 1000) + 's in the last ' + SLOW_WINDOW_S + 's';
  if (queue.length > 15) return queue.length + ' requests are waiting in line';
  if (w.maxWait >= 4000) return 'requests waited ' + (w.maxWait / 1000).toFixed(1) + 's in line';
  return '';
}

function evaluate() {
  const now = Date.now();
  const why = badNow();
  if (why) {
    state.lastBadAt = now;
    if (!state.paused) {
      state.paused = true; state.reason = why; state.since = now;
      state.episodes.push({ start: now, end: null, reason: why, skipped: [] });
      if (state.episodes.length > 200) state.episodes.shift();
      log('RPC SLOW: new buys are PAUSED -- ' + why + '. Open positions and sells are not affected. Buying resumes after ' + (CALM_BEFORE_RESUME_MS / 1000) + 's of normal speed.', 'warn');
    }
  } else if (state.paused && now - state.lastBadAt >= CALM_BEFORE_RESUME_MS) {
    state.paused = false;
    const ep = state.episodes[state.episodes.length - 1];
    if (ep) ep.end = now;
    log('RPC RECOVERED: new buys resumed after ' + ((now - state.since) / 1000).toFixed(0) + 's paused' + (ep && ep.skipped.length ? ' (' + ep.skipped.length + ' buys were skipped)' : ''), 'info');
  }
}

// True while new buys must wait.
function entryPaused() { evaluate(); return state.paused; }
function pauseReason() { return state.reason; }
// A buy that every filter approved but that was held back because of a pause.
// Returns true the first time a given buy is held back in this pause (so it is logged once).
function noteSkippedEntry(label) {
  const ep = state.episodes[state.episodes.length - 1];
  if (!ep || ep.end) return false;
  const name = String(label || '?').slice(0, 24);
  if (ep.skipped.indexOf(name) !== -1) return false;
  ep.skipped.push(name);
  return true;
}

// -- reports ----------------------------------------------------------
function statsBetween(fromMs, toMs) {
  const a = Math.floor((fromMs || 0) / 1000);
  const z = Math.floor((toMs || Date.now()) / 1000);
  const out = { peak: 0, requests: 0, slow: 0, n429: 0, errs: 0, slowestMs: 0, maxWaitMs: 0, seconds: 0, byKind: {} };
  buckets.forEach(function(b, k) {
    if (k < a || k > z) return;
    out.seconds++;
    out.requests += b.n;
    if (b.n > out.peak) out.peak = b.n;
    out.slow += b.slow; out.n429 += b.n429; out.errs += b.errs;
    if (b.maxLat > out.slowestMs) out.slowestMs = b.maxLat;
    if (b.maxWait > out.maxWaitMs) out.maxWaitMs = b.maxWait;
    Object.keys(b.kinds).forEach(function(m) { out.byKind[m] = (out.byKind[m] || 0) + b.kinds[m]; });
  });
  return out;
}

function episodesSince(fromMs) {
  return state.episodes.filter(function(e) { return e.start >= (fromMs || 0); }).map(function(e) {
    return { start: e.start, end: e.end, reason: e.reason, skipped: e.skipped.slice() };
  });
}

function status() {
  return { limit: LIMIT_PER_SEC, queued: queue.length, paused: state.paused, reason: state.reason, totals: totals };
}

// A short line every 10 seconds while the node is busy (a quiet line once a minute otherwise).
let lastLineAt = 0, lastQuietAt = 0, lastLineFrom = Date.now();
function periodicLine() {
  const now = Date.now();
  evaluate();
  if (now - lastLineAt < 10000) return;
  const s = statsBetween(lastLineFrom, now);
  lastLineFrom = now; lastLineAt = now;
  if (s.requests === 0) return;
  const busy = s.peak >= 7 || s.slow > 0 || s.n429 > 0 || s.maxWaitMs >= 300 || state.paused;
  if (!busy && now - lastQuietAt < 60000) return;
  if (!busy) lastQuietAt = now;
  const kinds = Object.keys(s.byKind).sort(function(a, b) { return s.byKind[b] - s.byKind[a]; }).slice(0, 4)
    .map(function(m) { return m + ' ' + s.byKind[m]; }).join(', ');
  log('RPC USAGE (last 10s): ' + s.requests + ' requests, peak ' + s.peak + '/s (limit ' + LIMIT_PER_SEC + ') | most: ' + kinds +
    ' | slowest ' + s.slowestMs + 'ms | refused (429) ' + s.n429 + ' | longest wait in line ' + s.maxWaitMs + 'ms | waiting now ' + queue.length +
    (state.paused ? ' | NEW BUYS PAUSED' : ''), busy ? 'warn' : 'info');
}
let lastPruneAt = 0;
const periodicTimer = setInterval(function() {
  try {
    periodicLine();
    if (Date.now() - lastPruneAt > 60000) { lastPruneAt = Date.now(); pruneBuckets(); }
  } catch (e) { /* never let the report break the bot */ }
}, 2000);
if (periodicTimer.unref) periodicTimer.unref();

module.exports = {
  gatedFetch,
  runTracked,
  runWithPriority,
  currentPriority,
  entryPaused,
  pauseReason,
  noteSkippedEntry,
  statsBetween,
  episodesSince,
  status,
  setLogger,
  LIMIT_PER_SEC,
  SLOW_MS,
  _setRealFetch,
  _readBody: readBody,
};
