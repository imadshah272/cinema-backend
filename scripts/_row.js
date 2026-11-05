"use strict";
const { getSupabaseClient } = require("../server/services/supabaseClient");
const torbox = require("../server/services/torboxService");
(async () => {
  const sb = getSupabaseClient();
  const { data } = await sb.from("media_sources").select("*").eq("media_id", process.argv[2]).eq("status", "ready").limit(3);
  for (const r of data || []) {
    console.log(JSON.stringify({ q: r.quality, stream_url: r.stream_url, download_url: String(r.download_url || "").slice(0, 120), magnet: String(r.magnet_link || "").slice(0, 100), seeders: r.seeders, src: r.source_type, payload: r.payload }, null, 1).slice(0, 900));
    const hash = torbox.extractInfoHash(r.magnet_link || r.download_url || r.stream_url);
    console.log("hash", hash);
    if (hash && torbox.checkCached) {
      try { console.log("cached?", JSON.stringify(await torbox.checkCached([hash])).slice(0, 200)); } catch (e) { console.log("checkCached err", e.message); }
    }
  }
})();
