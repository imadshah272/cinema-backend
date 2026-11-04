/** Read-only: how many ready movies / episodes have a 480p, 720p and 1080p Hindi / Dual row. */
"use strict";
const { getSupabaseClient } = require("../server/services/supabaseClient");

(async () => {
  const sb = getSupabaseClient();
  const byId = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("media_sources").select("media_id, quality").eq("status", "ready").range(from, from + 999).order("id");
    if (error) throw error;
    for (const r of data) {
      const set = byId.get(r.media_id) || new Set();
      set.add(String(r.quality || "").toLowerCase());
      byId.set(r.media_id, set);
    }
    if (data.length < 1000) break;
  }
  const report = { movies: { total: 0 }, episodes: { total: 0 } };
  for (const [id, set] of byId) {
    const bucket = /-s\d+e\d+$/i.test(id) ? report.episodes : report.movies;
    bucket.total++;
    for (const q of ["480p", "720p", "1080p"]) if (set.has(q)) bucket[q] = (bucket[q] || 0) + 1;
    if (!set.has("480p") && !set.has("360p")) bucket.noLow = (bucket.noLow || 0) + 1;
  }
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
