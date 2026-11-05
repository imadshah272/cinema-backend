/**
 * scripts/discoverShows.js
 * Prints TMDB ids of popular series (by original language) that have no ready row in Supabase yet.
 *   node scripts/discoverShows.js --lang ko --pages 8 --min-votes 150
 *   node scripts/discoverShows.js --lang en --pages 6 --min-votes 1500
 */
"use strict";
const { getSupabaseClient } = require("../server/services/supabaseClient");
const { tmdb } = require("./fillSeriesGaps");
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
(async () => {
  const lang = opt("--lang", "ko"), pages = Number(opt("--pages", 8)), minVotes = Number(opt("--min-votes", 150));
  const today = new Date().toISOString().slice(0, 10);
  const sb = getSupabaseClient();
  const have = new Set();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("media_sources").select("media_id").like("media_id", "%-s%e%").range(from, from + 999).order("id");
    data.forEach((r) => have.add(r.media_id.split("-")[0]));
    if (data.length < 1000) break;
  }
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const res = await tmdb(`/discover/tv?with_original_language=${lang}&sort_by=popularity.desc&vote_count.gte=${minVotes}&first_air_date.lte=${today}&language=en-US&page=${p}`);
    for (const s of res?.results || []) {
      if (!have.has(String(s.id)) && /[A-Za-z]/.test(s.name || "")) out.push({ id: s.id, name: s.name });
    }
  }
  console.error(`${out.length} candidate shows (not in Supabase)`);
  console.error(out.slice(0, 25).map((s) => s.name).join(" | "));
  console.log(out.map((s) => s.id).join(","));
})();
