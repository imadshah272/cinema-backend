"use strict";
const { getSupabaseClient } = require("../server/services/supabaseClient");
const { releaseName, episodeScope, packCoversSeason } = require("../server/services/releaseAudio");
(async () => {
  const sb = getSupabaseClient();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("media_sources").select("media_id,media_title,magnet_link,download_url,payload").eq("status", "ready").like("media_id", "%-s%e%").range(from, from + 999).order("id");
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const cat = {}; const titles = new Map(); let old = 0, fixed = 0; const shows = new Map();
  for (const r of rows) {
    const m = /^(\d+)-s(\d+)e(\d+)$/i.exec(r.media_id); if (!m) continue;
    const s = +m[2], e = +m[3];
    const bad = (name) => { const sc = episodeScope(name, s, e); return sc === "other" || (sc === "pack" && !packCoversSeason(name, s)); };
    const n1 = releaseName(r);
    const n2 = `${n1} ${r.payload?.file_name || ""}`;
    if (bad(n1)) { const sc = episodeScope(n2, s, e); cat[sc] = (cat[sc] || 0) + 1; titles.set(r.media_title.replace(/ - Sd+Ed+.*/, ""), (titles.get(r.media_title.replace(/ - Sd+Ed+.*/, "")) || 0) + 1); old++; shows.set(m[1], (shows.get(m[1]) || 0) + 1); if (!bad(n2)) fixed++; }
  }
  console.log(cat, [...titles].sort((a, b) => b[1] - a[1]).slice(0, 25).map((x) => x.join(":")).join(" | "));
  console.log(`ready episode rows ${rows.length} | rejected by the server today ${old} | would pass with file_name ${fixed} | shows affected ${shows.size}`);
})();
