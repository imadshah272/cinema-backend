"use strict";
const { getSupabaseClient } = require("../server/services/supabaseClient");
const { tmdb } = require("./fillSeriesGaps");
(async () => {
  const sb = getSupabaseClient();
  const q = process.argv[2];
  const type = process.argv[3] || "tv";
  const hit = (await tmdb(`/search/${type}?query=${encodeURIComponent(q)}`))?.results?.slice(0, 3) || [];
  for (const h of hit) {
    console.log("TMDB:", h.id, h.name || h.title, h.original_name || h.original_title, h.first_air_date || h.release_date);
  }
  if (!hit[0]) return;
  const like = type === "tv" ? `${hit[0].id}-s%` : `${hit[0].id}`;
  const { data } = await sb.from("media_sources").select("media_id,media_title,status,quality,language,magnet_link,download_url,stream_url,payload").like("media_id", like).limit(8);
  for (const r of data || []) {
    const dn = (r.magnet_link || r.download_url || "").match(/[?&]dn=([^&]+)/);
    console.log(r.media_id, "|", r.media_title, "|", r.status, r.quality, "|", dn ? decodeURIComponent(dn[1]).slice(0, 90) : "-", "|", r.payload?.file_name || "");
  }
})();
