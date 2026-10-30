#!/usr/bin/env node
"use strict";

/**
 * Read-only health report for media_sources, checked against the strict rules:
 * label from the release name, 480p/720p/1080p only, right film / right episode,
 * stream-friendly size, live seeders, clean print preferred over CAM, pack files named.
 *
 *   node scripts/auditMediaSources.js            summary
 *   node scripts/auditMediaSources.js --examples summary + up to 5 rows per issue
 */

require("dotenv").config({ quiet: true });
const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { releaseName, hindiAudioKind, audioLabel, detectQuality, episodeScope, packCoversSeason } = require("../server/services/releaseAudio");

const SHOW_EXAMPLES = process.argv.includes("--examples");
const GB = 1024 ** 3;
const HARD_MAX_BYTES = { "480p": 1.5 * GB, "720p": 4 * GB, "1080p": 8 * GB };
const CAM_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|pre[ ._-]?dvd|scr|dvdscr|hdtscr|screener|hqcam)\b/i;
const MULTI_FILM_RE = /\b(collection|trilogy|duology|quadrilogy|franchise|anthology|\d+[ ._-]?movies|phase[ ._-]?[iv1-6]+)\b|\b(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\b/i;

async function readAll(supabase, table, columns) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

function releaseYears(name) {
  return (String(name).match(/(?<!\d)(19[3-9]\d|20[0-4]\d)(?!\d|p)/gi) || []).map(Number);
}

async function main() {
  const supabase = getSupabaseClient();
  const content = await readAll(supabase, MEDIA_CONTENT_TABLE, "external_id, media_type, year:details->>year, lang:details->>original_language");
  const films = new Map();
  for (const c of content) films.set(`${c.media_type === "tv" ? "tv" : "movie"}:${c.external_id}`, { year: Number(c.year) || null, lang: c.lang || "" });

  const allRows = await readAll(
    supabase,
    MEDIA_SOURCES_TABLE,
    "id, media_id, media_title, language, quality, seeders, size_bytes, magnet_link, download_url, payload, updated_at, status"
  );
  // Hidden rows (scripts/repairMediaSources.js) are never served, so only ready rows are audited.
  const rows = allRows.filter((r) => r.status === "ready");
  console.log(`hidden rows (not served): ${allRows.length - rows.length}`);

  const issues = {};
  const add = (key, row, note = "") => {
    (issues[key] ||= []).push({ id: row.id, media_id: row.media_id, title: row.media_title, quality: row.quality, language: row.language, note });
  };

  const movieTitles = new Map(); // tmdb id -> { hindi:boolean, rows: [] }
  const episodeSizes = new Map(); // show|season -> Map(size -> count)
  const showIds = new Set();

  for (const row of rows) {
    const name = releaseName(row);
    const isEp = /-s\d+e\d+/i.test(row.media_id || "");
    const baseId = String(row.media_id || "").replace(/-.*/, "");
    const film = films.get(`${isEp ? "tv" : "movie"}:${baseId}`) || {};
    const kind = hindiAudioKind(name, film.lang);
    const expectedLabel = audioLabel(kind);
    const quality = detectQuality(name, row.quality);
    const size = Number(row.size_bytes) || 0;

    if (row.language !== expectedLabel) add("label differs from release name", row, `${row.language} -> ${expectedLabel}`);
    if (quality && quality !== row.quality) add("quality differs from release name", row, `${row.quality} -> ${quality}`);
    if (quality === "2160p" || row.quality === "2160p") add("4K / 2160p row (rule: ignore)", row);
    if (!size) add("no size", row);
    if (row.seeders == null || Number(row.seeders) < 3) add("seeders < 3 or unknown", row, String(row.seeders));
    if (size && HARD_MAX_BYTES[quality] && size > HARD_MAX_BYTES[quality] && !isEp) add("too large to stream", row, `${(size / GB).toFixed(1)} GB`);

    if (isEp) {
      showIds.add(baseId);
      const m = row.media_id.match(/-s(\d+)e(\d+)/i);
      const scope = episodeScope(name, Number(m[1]), Number(m[2]));
      if (scope === "other") add("episode row points at another episode", row, name.slice(0, 80));
      if (scope === "pack" && !packCoversSeason(name, Number(m[1]))) add("episode row is not a pack of its season", row, name.slice(0, 80));
      if (scope === "pack" && size) {
        const key = `${baseId}|${m[1]}`;
        if (!episodeSizes.has(key)) episodeSizes.set(key, new Map());
        const sizes = episodeSizes.get(key);
        sizes.set(size, (sizes.get(size) || 0) + 1);
      }
    } else {
      if (film.year) {
        const years = releaseYears(name);
        if (years.length && !years.some((y) => Math.abs(y - film.year) <= 1)) add("wrong film (release year)", row, `${years.join("/")} vs ${film.year}`);
      }
      if (MULTI_FILM_RE.test(name) && !row.payload?.file_name) add("multi-film pack without file name", row, name.slice(0, 80));
      if (!movieTitles.has(baseId)) movieTitles.set(baseId, { hindi: false, rows: [] });
      const t = movieTitles.get(baseId);
      if (kind) t.hindi = true;
      t.rows.push({ row, quality, kind, cam: CAM_RE.test(name) });
    }
  }

  // CAM print still stored for a quality that already has a clean Hindi print.
  for (const t of movieTitles.values()) {
    for (const r of t.rows) {
      if (r.cam && r.kind && t.rows.some((o) => o !== r && !o.cam && o.kind && o.quality === r.quality)) {
        add("CAM print where a clean print exists", r.row);
      }
    }
  }
  // Season packs stored on every episode with the whole pack size.
  let packSizeRows = 0;
  for (const sizes of episodeSizes.values()) for (const n of sizes.values()) if (n > 1) packSizeRows += n;

  const movies = [...movieTitles.values()];
  console.log("================================================================");
  console.log(` media_sources rows: ${rows.length}`);
  console.log(` movies: ${movies.length} · with a verified Hindi release: ${movies.filter((t) => t.hindi).length}`);
  console.log(` series: ${showIds.size} · episode rows: ${rows.filter((r) => /-s\d+e\d+/i.test(r.media_id)).length}`);
  console.log(` episode rows sharing one season-pack size: ${packSizeRows}`);
  const labels = rows.reduce((m, r) => ((m[r.language] = (m[r.language] || 0) + 1), m), {});
  console.log(" labels:", labels);
  console.log("================================================================");
  for (const [key, list] of Object.entries(issues).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(list.length).padStart(6)}  ${key}`);
    if (SHOW_EXAMPLES) for (const e of list.slice(0, 5)) console.log(`          ${e.media_id} ${e.title} ${e.quality} ${e.language} ${e.note}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
