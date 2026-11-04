/**
 * scripts/auditTitles.js
 *
 * Read-only check of how a title is stored: for each name (or TMDB id) it prints the stored
 * rows by status / quality, and for a series the aired episodes that still have no ready row.
 *
 *   node scripts/auditTitles.js "Vikings" "Into the Badlands" "Barbarians"
 *   node scripts/auditTitles.js --movie "Jawan" "Pathaan"
 *   node scripts/auditTitles.js --id tv:44217
 */

"use strict";

const { getSupabaseClient } = require("../server/services/supabaseClient");
const { tmdb } = require("./fillSeriesGaps");

const args = process.argv.slice(2);
const MOVIE = args.includes("--movie");
const names = args.filter((a) => !a.startsWith("--"));
const pad = (n) => String(n).padStart(2, "0");

async function allRows(sb, like) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("media_sources")
      .select("media_id, status, quality, language, seeders, payload")
      .like("media_id", like)
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

const tally = (rows, key) => {
  const out = {};
  for (const r of rows) out[r[key] || "?"] = (out[r[key] || "?"] || 0) + 1;
  return Object.entries(out).map(([k, v]) => `${k}:${v}`).join("  ");
};

async function main() {
  const sb = getSupabaseClient();
  const targets = [];
  for (const name of names) {
    const idMatch = name.match(/^(tv|movie):(\d+)$/);
    if (idMatch) {
      targets.push({ type: idMatch[1], id: idMatch[2], name });
      continue;
    }
    const type = MOVIE ? "movie" : "tv";
    const res = await tmdb(`/search/${type}?query=${encodeURIComponent(name)}`);
    const hit = res?.results?.[0];
    if (!hit) {
      console.log(`\n${name}: not found on TMDB`);
      continue;
    }
    targets.push({ type, id: String(hit.id), name: hit.name || hit.title, year: String(hit.first_air_date || hit.release_date || "").slice(0, 4), lang: hit.original_language });
  }

  for (const t of targets) {
    console.log(`\n== ${t.name} (${t.type} ${t.id}${t.year ? `, ${t.year}` : ""}${t.lang ? `, ${t.lang}` : ""})`);
    const rows = await allRows(sb, t.type === "tv" ? `${t.id}-s%` : `${t.id}`);
    if (!rows.length) {
      console.log("  no rows stored");
    } else {
      console.log(`  rows ${rows.length}  status[${tally(rows, "status")}]  quality[${tally(rows, "quality")}]  language[${tally(rows, "language")}]`);
    }
    if (t.type !== "tv") continue;
    const info = await tmdb(`/tv/${t.id}`);
    const today = new Date().toISOString().slice(0, 10);
    const have = new Set(rows.filter((r) => r.status === "ready").map((r) => r.media_id.toLowerCase()));
    for (const s of info?.seasons || []) {
      if (s.season_number === 0) continue;
      const sd = await tmdb(`/tv/${t.id}/season/${s.season_number}`);
      const aired = (sd?.episodes || []).filter((e) => e.air_date && e.air_date <= today);
      const missing = aired.filter((e) => !have.has(`${t.id}-s${pad(s.season_number)}e${pad(e.episode_number)}`));
      console.log(`  S${pad(s.season_number)}: ${aired.length - missing.length}/${aired.length} ready${missing.length ? `, missing ${missing.length}` : ""}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
