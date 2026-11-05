/**
 * scripts/precacheUncached.js
 *
 * Long-running job (run it under pm2): keeps TorBox busy caching the titles users open most, so "Preparing
 * this movie for you. Please wait 1-2 minutes." disappears. Rows are ordered by priority (series episodes
 * first, then rating, then seeders); torrents with fewer than 3 seeders are skipped (a dead swarm only
 * wastes a slot). At most MAX_ACTIVE downloads run at once: the TorBox plan has 3 active slots and one
 * is left free for users who open an uncached title.
 *
 *   node scripts/precacheUncached.js                   # run forever
 *   node scripts/precacheUncached.js --hours 6         # stop after 6 hours
 *   node scripts/precacheUncached.js --dry-run         # print the queue only
 *   pm2 start scripts/precacheUncached.js --name precache -- --hours 0
 */

"use strict";

const fs = require("fs");
const path = require("path");
require("../server/config/env");
const { getSupabaseClient } = require("../server/services/supabaseClient");
const torbox = require("../server/services/torboxService");
const { checkCachedBatch } = require("./fillSeriesGaps");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes("--dry-run");
const HOURS = Number(opt("--hours", 0));
const MAX_ACTIVE = Number(opt("--slots", 2));
const MIN_SEEDERS = Number(opt("--min-seeders", 3));
const API = "https://api.torbox.app/v1/api";
const KEY = process.env.TORBOX_API_KEY;
const STATE = path.join(__dirname, "..", "precache-state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { active: {}, done: [], dead: [] };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function tb(pathname, init, timeout = 15000) {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, ...(init?.headers || {}) }, signal: AbortSignal.timeout(timeout) });
  return res.json().catch(() => null);
}

async function buildQueue() {
  const sb = getSupabaseClient();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("media_sources").select("media_id,media_title,magnet_link,seeders,payload").eq("status", "ready").range(from, from + 999).order("id");
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const byHash = new Map();
  for (const r of rows) {
    const hash = ((r.magnet_link || "").match(/btih:([0-9a-f]{40})/i) || [])[1]?.toLowerCase();
    if (!hash || (Number(r.seeders) || 0) < MIN_SEEDERS) continue;
    const isEp = /-s\d+e\d+$/i.test(r.media_id);
    const score = (isEp ? 1000 : 0) + (Number(r.payload?.rating) || 0) * 3 + Math.min(Number(r.seeders) || 0, 200) / 10;
    const prev = byHash.get(hash);
    if (!prev || score > prev.score) byHash.set(hash, { hash, magnet: r.magnet_link, title: r.media_title, score });
  }
  const hashes = [...byHash.keys()];
  const cached = new Set();
  for (let i = 0; i < hashes.length; i += 80) (await checkCachedBatch(hashes.slice(i, i + 80))).forEach((h) => cached.add(h));
  return [...byHash.values()].filter((c) => !cached.has(c.hash) && !state.done.includes(c.hash) && !state.dead.includes(c.hash)).sort((a, b) => b.score - a.score);
}

async function main() {
  if (!KEY) throw new Error("TORBOX_API_KEY is not set");
  const stopAt = HOURS > 0 ? Date.now() + HOURS * 3600 * 1000 : Infinity;
  let queue = await buildQueue();
  log(`queue: ${queue.length} uncached torrents (top: ${queue.slice(0, 5).map((c) => c.title.replace(/ - S\d+E\d+.*/, "")).join(" | ")})`);
  if (DRY) return;
  let cycles = 0;
  while (Date.now() < stopAt) {
    // 1. Check the running downloads.
    for (const [hash, job] of Object.entries(state.active)) {
      const json = await tb(`/torrents/mylist?id=${job.torrentId}&bypass_cache=true`).catch(() => null);
      const item = json?.success ? (Array.isArray(json.data) ? json.data[0] : json.data) : null;
      const ageMin = (Date.now() - job.at) / 60000;
      if (item && (item.cached || item.download_present || item.progress === 1)) {
        state.done.push(hash); delete state.active[hash];
        log(`CACHED  ${job.title} (${Math.round(ageMin)} min)`);
      } else if (!item || /stalled|failed|error/i.test(String(item.download_state)) || (ageMin > 30 && !(item.progress > 0.02)) || ageMin > 360) {
        await tb("/torrents/controltorrent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ torrent_id: job.torrentId, operation: "delete" }) }).catch(() => null);
        state.dead.push(hash); delete state.active[hash];
        log(`DEAD    ${job.title} (${item ? String(item.download_state) : "gone"})`);
      }
    }
    // 2. Fill free slots.
    while (Object.keys(state.active).length < MAX_ACTIVE && queue.length) {
      const next = queue.shift();
      const created = await torbox.createTorrent(next.magnet);
      if (created?.torrent_id) {
        state.active[next.hash] = { torrentId: created.torrent_id, at: Date.now(), title: next.title.replace(/ - S\d+E\d+.*/, "") };
        log(`ADDED   ${state.active[next.hash].title}`);
      } else {
        state.dead.push(next.hash);
      }
      await sleep(2000);
    }
    save();
    cycles += 1;
    if (!queue.length && !Object.keys(state.active).length) { log("queue finished"); break; }
    if (cycles % 60 === 0) queue = await buildQueue(); // refresh once an hour
    await sleep(60 * 1000);
  }
  save();
}

main().catch((e) => { console.error(e); process.exit(1); });
