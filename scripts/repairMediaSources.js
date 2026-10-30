#!/usr/bin/env node
"use strict";

/**
 * Repairs media_sources against the strict rules. Never deletes: a bad row gets
 * status "hidden" (every app endpoint reads only status "ready") with the reason in
 * payload.hidden_reason, so it can be restored.
 *
 *  - hidden: wrong film (release year), 2160p / 4K, too large to stream, an episode row
 *    pointing at another episode or at a pack of another season, CAM print when a clean
 *    Hindi print of the same quality exists
 *  - quality column set from the release name
 *  - episode rows: real per-episode size + file name inside the season pack, from
 *    Torrentio's per-episode index (season packs were stored with the whole pack size)
 *  - movie rows without a size: size from Torrentio
 *
 *   node scripts/repairMediaSources.js            dry run
 *   node scripts/repairMediaSources.js --apply    write
 *   --skip-sizes                                  skip the Torrentio size pass
 */

require("dotenv").config({ quiet: true });
const env = require("../server/config/env");
const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { releaseName, hindiAudioKind, detectQuality, episodeScope, packCoversSeason } = require("../server/services/releaseAudio");
const { fetchTorrentio } = require("../server/services/torrentioClient");

const APPLY = process.argv.includes("--apply");
const SKIP_SIZES = process.argv.includes("--skip-sizes");
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const HARD_MAX_BYTES = { "480p": 1.5 * GB, "720p": 4 * GB, "1080p": 8 * GB };
const CAM_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|pre[ ._-]?dvd|scr|dvdscr|hdtscr|screener|hqcam)\b/i;
const CONCURRENCY = 3;

async function readAll(supabase, table, columns, filter = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(supabase.from(table).select(columns)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

function releaseYears(name) {
  return (String(name).match(/(?<!\d)(19[3-9]\d|20[0-4]\d)(?!\d|p)/gi) || []).map(Number);
}

function infoHash(row) {
  return (String(row.magnet_link || "").match(/btih:([a-f0-9]{40})/i) || [])[1]?.toLowerCase() || null;
}

function humanSize(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / MB)} MB`;
}

async function getJson(url, timeoutMs = 20000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

const imdbCache = new Map();
async function imdbIdFor(kind, tmdbId) {
  const key = `${kind}:${tmdbId}`;
  if (!imdbCache.has(key)) {
    const data = await getJson(`https://api.themoviedb.org/3/${kind}/${tmdbId}/external_ids?api_key=${env.tmdbApiKey}`);
    imdbCache.set(key, data?.imdb_id || null);
  }
  return imdbCache.get(key);
}

/** hash -> { size, fileName, fileIdx } for one Torrentio item (movie or one episode). */
async function torrentioFiles(path) {
  const data = await fetchTorrentio(path).catch(() => null);
  const out = new Map();
  for (const s of data?.streams || []) {
    if (!s.infoHash) continue;
    const m = String(s.title || "").match(/💾\s*([\d.]+)\s*(GB|MB)/i);
    if (!m) continue;
    out.set(s.infoHash.toLowerCase(), {
      size: Math.round(Number(m[1]) * (m[2].toUpperCase() === "GB" ? GB : MB)),
      fileName: s.behaviorHints?.filename || null,
      fileIdx: s.fileIdx ?? null,
    });
  }
  return out;
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function main() {
  const supabase = getSupabaseClient();
  console.log(APPLY ? "APPLY: writing repairs" : "DRY RUN (use --apply to write)");

  const content = await readAll(supabase, MEDIA_CONTENT_TABLE, "external_id, media_type, year:details->>year");
  const years = new Map(content.map((c) => [`${c.media_type === "tv" ? "tv" : "movie"}:${c.external_id}`, Number(c.year) || null]));
  const rows = await readAll(
    supabase,
    MEDIA_SOURCES_TABLE,
    "id, media_id, media_title, language, quality, seeders, size_bytes, magnet_link, download_url, payload, status",
    (q) => q.eq("status", "ready")
  );
  console.log(`ready rows: ${rows.length}`);

  const hide = new Map(); // id -> reason
  const qualityFix = new Map(); // id -> quality
  const byMovieQuality = new Map();

  for (const row of rows) {
    const name = releaseName(row);
    const ep = String(row.media_id || "").match(/^(\d+)-s(\d+)e(\d+)$/i);
    const quality = detectQuality(name, row.quality);
    const size = Number(row.size_bytes) || 0;

    if (quality === "2160p" || row.quality === "2160p") hide.set(row.id, "4k ignored");
    else if (!ep && size && HARD_MAX_BYTES[quality] && size > HARD_MAX_BYTES[quality]) hide.set(row.id, "too large to stream");

    if (ep) {
      const scope = episodeScope(name, Number(ep[2]), Number(ep[3]));
      if (scope === "other") hide.set(row.id, "release is another episode");
      else if (scope === "pack" && !packCoversSeason(name, Number(ep[2]))) hide.set(row.id, "pack of another season");
    } else {
      const year = years.get(`movie:${row.media_id}`);
      const ry = releaseYears(name);
      if (year && ry.length && !ry.some((y) => Math.abs(y - year) <= 1)) hide.set(row.id, `wrong film: release ${ry.join("/")} vs ${year}`);
      const key = `${row.media_id}|${quality}`;
      if (!byMovieQuality.has(key)) byMovieQuality.set(key, []);
      byMovieQuality.get(key).push({ row, cam: CAM_RE.test(name), hindi: Boolean(hindiAudioKind(name)) });
    }
    if (quality && quality !== row.quality && quality !== "2160p" && !hide.has(row.id)) qualityFix.set(row.id, quality);
  }
  for (const group of byMovieQuality.values()) {
    if (!group.some((g) => !g.cam && g.hindi && !hide.has(g.row.id))) continue;
    for (const g of group) if (g.cam && !hide.has(g.row.id)) hide.set(g.row.id, "cam print, clean print exists");
  }

  // Quality changes must not collide with another ready row on (media_id, quality, language).
  const taken = new Set(rows.filter((r) => !hide.has(r.id)).map((r) => `${r.media_id}|${r.quality}|${r.language}`));
  for (const [id, q] of qualityFix) {
    const row = rows.find((r) => r.id === id);
    const key = `${row.media_id}|${q}|${row.language}`;
    if (taken.has(key)) qualityFix.delete(id);
    else {
      taken.delete(`${row.media_id}|${row.quality}|${row.language}`);
      taken.add(key);
    }
  }

  const reasons = [...hide.values()].reduce((m, r) => ((m[r.replace(/:.*/, "")] = (m[r.replace(/:.*/, "")] || 0) + 1), m), {});
  console.log("hide:", reasons);
  console.log("quality fixes:", qualityFix.size);

  // Size pass: one Torrentio lookup per episode / movie that needs it.
  const sizeFix = new Map(); // id -> { size, fileName, fileIdx }
  const sizeMissing = new Set(); // looked up, not in Torrentio
  if (!SKIP_SIZES) {
    const packSize = new Map();
    for (const row of rows) {
      const ep = String(row.media_id || "").match(/^(\d+)-s(\d+)e(\d+)$/i);
      if (ep && row.size_bytes) packSize.set(`${ep[1]}|${ep[2]}|${row.size_bytes}`, (packSize.get(`${ep[1]}|${ep[2]}|${row.size_bytes}`) || 0) + 1);
    }
    const recheckAfter = Date.now() - 7 * 86400000;
    const targets = rows.filter((row) => {
      if (hide.has(row.id) || !infoHash(row)) return false;
      // Not in Torrentio last time: try again after a week, not every autopilot run.
      if (row.payload?.size_lookup_at && Date.parse(row.payload.size_lookup_at) > recheckAfter) return false;
      const ep = String(row.media_id || "").match(/^(\d+)-s(\d+)e(\d+)$/i);
      if (!ep) return !row.size_bytes;
      // Episode rows that carry a whole-pack size (shared by other episodes) or no size.
      return !row.size_bytes || packSize.get(`${ep[1]}|${ep[2]}|${row.size_bytes}`) > 1 || !row.payload?.file_name;
    });
    const groups = new Map();
    for (const row of targets) {
      const ep = String(row.media_id).match(/^(\d+)-s(\d+)e(\d+)$/i);
      const key = ep ? `tv|${ep[1]}|${Number(ep[2])}|${Number(ep[3])}` : `movie|${row.media_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    console.log(`size lookups: ${groups.size} (${targets.length} rows)`);
    let done = 0;
    await inBatches([...groups.entries()], CONCURRENCY, async ([key, list]) => {
      const [kind, id, s, e] = key.split("|");
      const imdb = await imdbIdFor(kind === "tv" ? "tv" : "movie", id);
      if (imdb) {
        const files = await torrentioFiles(kind === "tv" ? `series/${imdb}:${s}:${e}` : `movie/${imdb}`);
        for (const row of list) {
          const f = files.get(infoHash(row));
          if (f && f.size) sizeFix.set(row.id, f);
          else sizeMissing.add(row.id);
        }
      }
      done += 1;
      if (done % 200 === 0) console.log(`  ... ${done}/${groups.size} lookups, ${sizeFix.size} sizes found`);
    });
    console.log(`sizes found: ${sizeFix.size}`);
  }

  if (!APPLY) return;

  const now = new Date().toISOString();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const writes = new Map();
  const patch = (id, fields, payloadFields) => {
    const row = byId.get(id);
    const w = writes.get(id) || { payload: { ...(row.payload || {}) } };
    Object.assign(w, fields);
    Object.assign(w.payload, payloadFields);
    writes.set(id, w);
  };
  for (const [id, reason] of hide) patch(id, { status: "hidden" }, { hidden_reason: reason, hidden_at: now });
  for (const [id, q] of qualityFix) patch(id, { quality: q }, { previous_quality: byId.get(id).quality });
  for (const [id, f] of sizeFix) {
    patch(
      id,
      { size_bytes: f.size, size_human: humanSize(f.size) },
      { size_bytes: f.size, size_human: humanSize(f.size), size_lookup_at: now, ...(f.fileName ? { file_name: f.fileName, file_idx: f.fileIdx } : {}) }
    );
  }
  for (const id of sizeMissing) patch(id, {}, { size_lookup_at: now });

  let ok = 0;
  const failed = [];
  await inBatches([...writes.entries()], 10, async ([id, w]) => {
    const { error } = await supabase.from(MEDIA_SOURCES_TABLE).update({ ...w, updated_at: now }).eq("id", id);
    if (error) failed.push(`${id}: ${error.message}`);
    else ok++;
  });
  console.log(`updated ${ok} rows, failed ${failed.length}`);
  for (const f of failed.slice(0, 10)) console.log("  ", f);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
