/**
 * scripts/auditMismatches.js
 *
 * Finds ready rows whose release (torrent / file name) has nothing to do with the title the row
 * is stored under: e.g. the Korean show "고기서 만나" pointing at "Musafir Cafe S01", which plays
 * the wrong video. A row passes when its release shares a significant word with the stored
 * title, the TMDB titles, or the TMDB alternative titles.
 *
 *   node scripts/auditMismatches.js                 # report only
 *   node scripts/auditMismatches.js --apply         # set the mismatching rows to status=hidden
 *   node scripts/auditMismatches.js --limit 400     # only check the first N distinct titles
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getSupabaseClient } = require("../server/services/supabaseClient");
const { tmdb } = require("./fillSeriesGaps");
const { releaseName } = require("../server/services/releaseAudio");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STOP = new Set([
  "the", "and", "for", "with", "from", "part", "season", "episode", "movie", "film", "series", "web", "dl", "rip", "hdrip",
  "hindi", "dual", "audio", "english", "eng", "dubbed", "dub", "bluray", "webrip", "x264", "x265", "hevc", "aac", "esub", "esubs",
  "1080p", "720p", "480p", "2160p", "complete", "full", "org", "line", "multi", "amzn", "nf", "hdr", "10bit", "ddp", "atmos",
]);

const words = (text) =>
  String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/s\d{1,2}e\d{1,3}|season\s*\d+|\b(19|20)\d{2}\b/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

function overlaps(releaseWords, titleWords) {
  const set = new Set(titleWords);
  return releaseWords.some((w) => set.has(w));
}

async function titleVariants(mediaId, isTv) {
  const id = isTv ? mediaId.split("-")[0] : mediaId;
  const kind = isTv ? "tv" : "movie";
  const out = [];
  const info = await tmdb(`/${kind}/${id}`);
  if (info) out.push(info.name, info.title, info.original_name, info.original_title);
  const alt = await tmdb(`/${kind}/${id}/alternative_titles`);
  for (const t of alt?.results || alt?.titles || []) out.push(t.title);
  const tr = await tmdb(`/${kind}/${id}/translations`);
  for (const t of tr?.translations || []) out.push(t.data?.name, t.data?.title);
  return out.filter(Boolean);
}

async function main() {
  const sb = getSupabaseClient();
  const byTitle = new Map(); // root id -> { isTv, title, rows: [] }
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("media_sources")
      .select("id, media_id, media_title, magnet_link, download_url, payload")
      .eq("status", "ready")
      .range(from, from + 999)
      .order("id");
    if (error) throw error;
    for (const r of data) {
      const isTv = /-s\d+e\d+$/i.test(r.media_id);
      const root = isTv ? r.media_id.split("-")[0] : r.media_id;
      // A movie and a series can share a TMDB id (1402 = a movie and The Walking Dead): keep them apart.
      const key = `${isTv ? "tv" : "movie"}:${root}`;
      if (!byTitle.has(key)) byTitle.set(key, { root, isTv, title: r.media_title, rows: [] });
      byTitle.get(key).rows.push(r);
    }
    if (data.length < 1000) break;
  }

  const bad = [];
  let checked = 0;
  for (const [, t] of byTitle) {
    const root = t.root;
    if (checked++ >= LIMIT) break;
    const baseWords = words(String(t.title || "").replace(/\s-\sS\d+E\d+.*$/i, ""));
    let variantWords = null;
    for (const r of t.rows) {
      const name = `${releaseName(r)} ${r.payload?.file_name || ""} ${r.payload?.release_name || ""}`;
      const rw = words(name);
      if (!rw.length) continue; // nothing to compare
      if (overlaps(rw, baseWords)) continue;
      if (!variantWords) {
        variantWords = (await titleVariants(root, t.isTv)).flatMap(words);
        await sleep(120);
      }
      if (overlaps(rw, variantWords)) continue;
      // Titles made only of short words / numbers ("65", "PK", "IF", "24") cannot be compared by words.
      if (!baseWords.length && !variantWords.length) continue;
      const shortTitle = String(t.title || "").replace(/\s-\sS\d+E\d+.*$/i, "").replace(/[^\p{L}\p{N}]/gu, "");
      if (shortTitle.length <= 3 || /^\d+$/.test(shortTitle)) continue;
      bad.push({ id: r.id, media_id: r.media_id, title: t.title, release: name.trim().slice(0, 110) });
    }
  }

  const perTitle = new Map();
  for (const b of bad) perTitle.set(b.media_id.split("-")[0], (perTitle.get(b.media_id.split("-")[0]) || 0) + 1);
  console.log(`titles checked ${Math.min(checked, byTitle.size)} | mismatching rows ${bad.length} | titles affected ${perTitle.size}`);
  for (const b of bad.slice(0, 60)) console.log(`  ${b.media_id} | ${String(b.title).slice(0, 40)} | ${b.release}`);
  const out = path.join(__dirname, "..", "mismatches.json");
  fs.writeFileSync(out, JSON.stringify(bad, null, 2));
  console.log(`full list: ${out}`);

  if (APPLY && bad.length) {
    for (let i = 0; i < bad.length; i += 200) {
      const ids = bad.slice(i, i + 200).map((b) => b.id);
      const { error } = await sb.from("media_sources").update({ status: "hidden" }).in("id", ids);
      if (error) console.warn("hide failed:", error.message);
    }
    console.log(`hidden ${bad.length} rows`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
