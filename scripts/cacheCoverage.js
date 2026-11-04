/** Read-only: how many ready rows (movies / episodes) point at a torrent that TorBox has cached. */
"use strict";
const { getSupabaseClient } = require("../server/services/supabaseClient");
const { checkCachedBatch } = require("./fillSeriesGaps");
const torbox = require("../server/services/torboxService");

(async () => {
  const sb = getSupabaseClient();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("media_sources").select("media_id,media_title,magnet_link,download_url,stream_url,seeders").eq("status", "ready").range(from, from + 999).order("id");
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const hashOf = (r) => torbox.extractInfoHash(r.magnet_link) || torbox.extractInfoHash(r.download_url) || torbox.extractInfoHash(r.stream_url);
  const hashes = [...new Set(rows.map(hashOf).filter(Boolean))];
  const cached = new Set();
  for (let i = 0; i < hashes.length; i += 80) {
    const part = await checkCachedBatch(hashes.slice(i, i + 80));
    part.forEach((h) => cached.add(h));
  }
  const stat = { movie: { rows: 0, cached: 0 }, episode: { rows: 0, cached: 0 } };
  const uncachedTitles = new Map();
  for (const r of rows) {
    const kind = /-s\d+e\d+$/i.test(r.media_id) ? "episode" : "movie";
    stat[kind].rows++;
    const h = hashOf(r);
    if (h && cached.has(h)) stat[kind].cached++;
    else {
      const t = r.media_title.replace(/ - S\d+E\d+.*/, "");
      uncachedTitles.set(t, (uncachedTitles.get(t) || 0) + 1);
    }
  }
  const perTitle = new Map();
  for (const r of rows) {
    const key = /-s\d+e\d+$/i.test(r.media_id) ? r.media_id : r.media_id; // per movie / per episode
    const h = hashOf(r);
    const e = perTitle.get(key) || { any: false, cached: false };
    e.any = true;
    if (h && cached.has(h)) e.cached = true;
    perTitle.set(key, e);
  }
  const units = { movie: { total: 0, noCached: 0 }, episode: { total: 0, noCached: 0 } };
  for (const [key, e] of perTitle) {
    const kind = /-s\d+e\d+$/i.test(key) ? "episode" : "movie";
    units[kind].total++;
    if (!e.cached) units[kind].noCached++;
  }
  console.log("per movie / per episode (no cached row at all):", JSON.stringify(units));
  console.log(JSON.stringify({ distinctTorrents: hashes.length, cachedTorrents: cached.size, ...stat }, null, 1));
  console.log("titles with uncached rows:", uncachedTitles.size);
  console.log([...uncachedTitles].sort((a, b) => b[1] - a[1]).slice(0, 30).map((x) => x.join(":")).join(" | "));
})().catch((e) => { console.error(e); process.exit(1); });
