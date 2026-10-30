"use strict";

/**
 * Torrentio requests for the ingestion scripts, paced so the autopilot is not rate limited.
 *
 * - One request at a time leaves this process at most every MIN_GAP_MS, however many
 *   workers call it in parallel.
 * - HTTP 429 (rate limited) waits 10s, 20s, 40s, 80s before giving up, and slows the
 *   shared pace for the rest of the run.
 */

const BASE = "https://torrentio.strem.fun/stream";
const MIN_GAP_MS = 800;
const MAX_GAP_MS = 5000;
const BACKOFF_MS = [10000, 20000, 40000, 80000];

let gapMs = MIN_GAP_MS;
let nextSlot = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs;
  if (at > now) await sleep(at - now);
}

/**
 * GET /stream/<path>.json, e.g. "movie/tt0848228" or "series/tt0903747:1:2".
 * @returns {Promise<{ streams: object[] }>}
 */
async function fetchTorrentio(path, timeoutMs = 20000) {
  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    let res;
    try {
      res = await fetch(`${BASE}/${path}.json`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(2000);
      continue;
    }
    if (res.status === 429) {
      if (attempt >= BACKOFF_MS.length) throw new Error("HTTP 429 (rate limited)");
      gapMs = Math.min(MAX_GAP_MS, gapMs * 2);
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    gapMs = Math.max(MIN_GAP_MS, Math.round(gapMs * 0.9));
    return res.json();
  }
}

module.exports = { fetchTorrentio };
