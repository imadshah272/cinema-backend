/**
 * scripts/addPackRows.js
 *
 * Stores one row per missing episode of a season from a known TorBox-cached pack:
 *   node scripts/addPackRows.js --show 1399 --season 8 --hash <40 hex> --name "<release name>" [--dry-run]
 * The audio of the first mapped file is read first (MKV header): the rows are stored only when it has
 * a Hindi track.
 */
"use strict";
const { getSupabaseClient } = require("../server/services/supabaseClient");
const torbox = require("../server/services/torboxService");
const { parseMkvAudioTracks } = require("../server/services/audioTrackProbe");
const { hindiAudioKind, detectQuality } = require("../server/services/releaseAudio");
const { buildRow, tmdb } = require("./fillSeriesGaps");

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes("--dry-run");
const showId = opt("--show"), season = Number(opt("--season")), hash = String(opt("--hash") || "").toLowerCase(), name = opt("--name") || "";
const pad = (n) => String(n).padStart(2, "0");

(async () => {
  const sb = getSupabaseClient();
  const info = await tmdb(`/tv/${showId}?language=en-US`);
  const sd = await tmdb(`/tv/${showId}/season/${season}?language=en-US`);
  const today = new Date().toISOString().slice(0, 10);
  const { data: have } = await sb.from("media_sources").select("media_id").eq("status", "ready").like("media_id", `${showId}-s${pad(season)}e%`);
  const haveSet = new Set((have || []).map((r) => r.media_id.toLowerCase()));
  const missing = (sd?.episodes || []).filter((e) => e.air_date && e.air_date <= today && !haveSet.has(`${showId}-s${pad(season)}e${pad(e.episode_number)}`));
  console.log(`${info.name} S${pad(season)}: ${missing.length} episodes missing`);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
  const pack = await torbox.getPackFiles(magnet);
  if (!pack) return console.log("pack files unavailable");
  const poster = info.poster_path ? `https://image.tmdb.org/t/p/w500${info.poster_path}` : null;
  const template = { poster_url: poster, backdrop_url: info.backdrop_path ? `https://image.tmdb.org/t/p/w1280${info.backdrop_path}` : null, series_poster_url: poster, rating: Math.round((info.vote_average || 0) * 10), original_language: info.original_language };
  const rows = [];
  let checked = false;
  for (const e of missing) {
    const file = torbox.pickPrimaryVideoFile(pack.files, season, e.episode_number, { singleEpisode: false });
    if (!file) { console.log(`  E${pad(e.episode_number)}: no file in the pack`); continue; }
    if (!checked) {
      checked = true;
      const tb = await torbox.resolveDirectTorboxStream(magnet, { season, episode: e.episode_number, singleEpisode: false });
      const r = await fetch(tb.streamUrl, { headers: { Range: "bytes=0-1500000" }, signal: AbortSignal.timeout(90000) });
      const tracks = parseMkvAudioTracks(Buffer.from(await r.arrayBuffer()));
      console.log("  audio of the first file:", tracks.map((t) => `${t.language || "und"}/${t.codec}`).join(", "));
      if (!tracks.some((t) => /^(hin|hi|urd|ur)/i.test(t.language || "") || /hindi/i.test(t.name || ""))) return console.log("  no Hindi track: nothing stored");
    }
    rows.push(buildRow({ showId, showName: info.name, year: String(info.first_air_date || "").slice(0, 4), season, episode: e.episode_number,
      cand: { hash, releaseName: name, filename: file.name.split("/").pop(), seeders: 5, sizeBytes: Number(file.size) || 0, quality: detectQuality(`${name} ${file.name}`, "") || "720p", kind: hindiAudioKind(`${name} Hindi English`, null) || "dual" },
      cached: true, template, episodeInfo: e }));
    console.log(`  E${pad(e.episode_number)}: ${file.name.split("/").pop().slice(0, 70)}`);
  }
  if (!DRY && rows.length) {
    const { error } = await sb.from("media_sources").upsert(rows, { onConflict: "media_id,quality,language" });
    console.log(error ? "upsert failed: " + error.message : `stored ${rows.length} rows`);
  } else console.log(`${rows.length} rows ${DRY ? "(dry run)" : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
