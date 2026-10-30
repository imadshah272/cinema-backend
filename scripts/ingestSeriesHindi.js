#!/usr/bin/env node
"use strict";

/**
 * Series with verified Hindi audio, one media_sources row per episode and quality.
 *
 * 1. TMDB discover: popular shows with an episode aired in the last --days days, per
 *    original language (en, hi, ko, ta, te, ml, kn).
 * 2. For each aired episode of the latest season (or every season with --all-seasons):
 *    Torrentio's per-episode index -> releases with the episode's own file inside any pack.
 * 3. Same strict rules as movies: Hindi / Hin / Urdu named in the release, Dual only with
 *    English, 480p / 720p / 1080p, file must be this episode, seeders, size per episode.
 * 4. Saved with the episode's file name and real size (never the whole pack size).
 *
 * Episodes that already have a verified Hindi row are skipped (--refresh re-checks them);
 * episodes without one are retried on every run, so a Hindi dub released later is picked up.
 *
 *   node scripts/ingestSeriesHindi.js --dry-run
 *   node scripts/ingestSeriesHindi.js --langs=hi,ko --pages=2
 *   node scripts/ingestSeriesHindi.js --tmdb=1396,66732 --all-seasons
 * Flags: --langs=  --pages=N (20 shows each, default 1)  --days=N (default 30)
 *        --tmdb=id,id  --all-seasons  --refresh  --min-seeders=N (default 2)  --dry-run
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");

const env = require("../server/config/env");
const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { releaseName, hindiAudioKind, audioLabel, detectQuality, episodeScope, packCoversSeason } = require("../server/services/releaseAudio");
const { fetchTorrentio } = require("../server/services/torrentioClient");

const TMDB = "https://api.themoviedb.org/3";
const VPS_BASE_URL = process.env.BASE_URL || "http://168.144.249.68:4555";
const REPORT_FILE = path.join(__dirname, ".new-releases-hindi-series.json");
const CONCURRENCY = 3;
const QUALITIES = ["1080p", "720p", "480p"];
const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** Per-episode file size limits for streaming. */
const MAX_EPISODE_BYTES = { "480p": 1 * GB, "720p": 2.5 * GB, "1080p": 5 * GB };
const LANG_LABELS = { en: "Hollywood", hi: "Bollywood", ko: "Korean", ta: "Kollywood", te: "Tollywood", ml: "Mollywood", kn: "Sandalwood" };

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return {
    langs: String(args.langs || Object.keys(LANG_LABELS).join(",")).split(",").map((s) => s.trim()).filter((l) => LANG_LABELS[l]),
    pages: Math.max(1, Number(args.pages) || 1),
    days: Math.max(1, Number(args.days) || 30),
    tmdbIds: args.tmdb ? String(args.tmdb).split(",").map((s) => s.trim()).filter(Boolean) : [],
    allSeasons: Boolean(args["all-seasons"]),
    refresh: Boolean(args.refresh),
    minSeeders: Number(args["min-seeders"]) || 2,
    dryRun: Boolean(args["dry-run"]),
  };
}

async function getJson(url, timeoutMs = 20000, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const tmdb = (p, query = "") => getJson(`${TMDB}${p}?api_key=${env.tmdbApiKey}${query}`);
const pad = (n) => String(n).padStart(2, "0");
const humanSize = (b) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${Math.round(b / MB)} MB`);
const baseName = (n) => String(n || "").split(/[\\/]/).pop();

/** AAC Hindi plays on phones; Dolby / DTS Hindi is skipped by most Android players. */
function codecRank(text) {
  if (/\baac\b|\bhe-aac\b/i.test(text)) return 0;
  if (/\b(dd\+?|ddp|ac3|eac3|e-ac-3|dts|truehd|atmos)\b/i.test(text)) return 2;
  return 1;
}

async function discoverShows(lang, opts) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - opts.days * 86400000).toISOString().slice(0, 10);
  const ids = [];
  for (let page = 1; page <= opts.pages; page++) {
    const data = await tmdb(
      "/discover/tv",
      `&with_original_language=${lang}&sort_by=popularity.desc&air_date.gte=${from}&air_date.lte=${today}&include_adult=false&page=${page}`
    );
    for (const s of data.results || []) ids.push(String(s.id));
    if (page >= (data.total_pages || 1)) break;
  }
  return ids;
}

/** Torrentio stream for one episode -> candidate, or { reject }. */
function evaluateStream(stream, show, season, episode, minSeeders) {
  const lines = String(stream.title || "").split("\n");
  const statIdx = lines.findIndex((l) => l.includes("👤") || l.includes("💾"));
  const release = lines.slice(0, statIdx === -1 ? 1 : statIdx).join(" ").trim();
  const stats = statIdx === -1 ? "" : lines[statIdx];
  if (!stream.infoHash || !release) return { reject: "no hash" };
  const fileName = stream.behaviorHints?.filename || (statIdx > 1 ? lines[statIdx - 1].trim() : "");

  const quality = detectQuality(release, "") || detectQuality(String(stream.name || "").split("\n")[1] || "", "");
  if (quality === "2160p") return { reject: "4k ignored" };
  if (!QUALITIES.includes(quality)) return { reject: "quality unknown" };

  const kind = hindiAudioKind(release, show.originalLanguage);
  if (!kind) return { reject: "no hindi in release name" };

  // The file itself must be this episode; an untagged file needs a pack of this season.
  const fileScope = fileName ? episodeScope(fileName, season, episode) : "pack";
  if (fileScope === "other") return { reject: "other episode" };
  if (fileScope === "pack" && episodeScope(release, season, episode) === "other") return { reject: "other episode" };
  if (fileScope === "pack" && episodeScope(release, season, episode) === "pack" && !packCoversSeason(release, season)) {
    return { reject: "not this season" };
  }

  const seeders = Number((stats.match(/👤\s*(\d+)/) || [])[1]) || 0;
  if (seeders < minSeeders) return { reject: "low seeders" };
  const m = stats.match(/💾\s*([\d.]+)\s*(GB|MB)/i);
  const sizeBytes = m ? Math.round(Number(m[1]) * (m[2].toUpperCase() === "GB" ? GB : MB)) : 0;
  if (!sizeBytes) return { reject: "no size" };
  if (sizeBytes > MAX_EPISODE_BYTES[quality]) return { reject: "too large" };

  const trackers = (stream.sources || [])
    .filter((s) => /^tracker:/i.test(s))
    .map((s) => `&tr=${encodeURIComponent(s.replace(/^tracker:/i, ""))}`)
    .join("");
  return {
    release,
    fileName: fileName || null,
    fileIdx: stream.fileIdx ?? null,
    quality,
    kind,
    label: audioLabel(kind),
    seeders,
    sizeBytes,
    magnet: `magnet:?xt=urn:btih:${stream.infoHash.toLowerCase()}&dn=${encodeURIComponent(release)}${trackers}`,
  };
}

function pickBestPerQuality(candidates) {
  const best = {};
  for (const q of QUALITIES) {
    const pool = candidates
      .filter((c) => c.quality === q)
      .sort(
        (a, b) =>
          codecRank(a.release) - codecRank(b.release) ||
          (a.kind === "dual" ? 0 : 1) - (b.kind === "dual" ? 0 : 1) ||
          b.seeders - a.seeders
      );
    if (pool[0]) best[q] = pool[0];
  }
  return best;
}

/** Episode keys ("1|5") that already have a ready, verified Hindi row of their own. */
async function episodesWithHindi(supabase, showId) {
  const done = new Set();
  const { data } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("media_id, magnet_link, download_url")
    .eq("status", "ready")
    .ilike("media_id", `${showId}-s%`)
    .limit(5000);
  for (const row of data || []) {
    const m = String(row.media_id).match(/-s(\d+)e(\d+)$/i);
    const name = releaseName(row);
    if (m && hindiAudioKind(name) && episodeScope(name, Number(m[1]), Number(m[2])) !== "other") done.add(`${Number(m[1])}|${Number(m[2])}`);
  }
  return done;
}

async function upsertShowCatalog(supabase, d, imdbId) {
  const { data: existing } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("details")
    .eq("source", "tmdb")
    .eq("media_type", "tv")
    .eq("external_id", Number(d.id))
    .maybeSingle();
  const details = {
    ...(existing?.details || {}),
    id: d.id,
    name: d.name,
    title: d.name,
    year: String(d.first_air_date || "").slice(0, 4),
    overview: d.overview,
    poster_url: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
    poster_path: d.poster_path,
    backdrop_url: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null,
    backdrop_path: d.backdrop_path,
    first_air_date: d.first_air_date,
    vote_average: d.vote_average,
    original_language: d.original_language,
    number_of_seasons: d.number_of_seasons,
    imdb_id: imdbId,
    industry: LANG_LABELS[d.original_language] || d.original_language,
  };
  const { error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .upsert(
      { external_id: Number(d.id), source: "tmdb", title: String(d.name).slice(0, 255), media_type: "tv", details },
      { onConflict: "source,media_type,external_id" }
    );
  if (error) throw new Error(`media_content upsert: ${error.message}`);
  return details;
}

async function processShow(supabase, showId, opts) {
  const d = await tmdb(`/tv/${showId}`, "&append_to_response=external_ids");
  const imdbId = d.external_ids?.imdb_id;
  const result = { tmdbId: String(d.id), title: d.name, lang: d.original_language, episodesChecked: 0, saved: 0, found: {}, skipped: 0 };
  if (!imdbId) return { ...result, status: "no imdb id" };

  const today = new Date().toISOString().slice(0, 10);
  const aired = (d.seasons || []).filter((s) => s.season_number > 0 && s.air_date && s.air_date <= today);
  const seasons = opts.allSeasons ? aired : aired.slice(-1);
  const already = opts.refresh ? new Set() : await episodesWithHindi(supabase, d.id);
  const details = opts.dryRun ? null : await upsertShowCatalog(supabase, d, imdbId);
  const show = { originalLanguage: d.original_language };

  for (const s of seasons) {
    const season = await tmdb(`/tv/${d.id}/season/${s.season_number}`).catch(() => null);
    const episodes = (season?.episodes || []).filter((e) => e.air_date && e.air_date <= today);
    for (const ep of episodes) {
      if (already.has(`${s.season_number}|${ep.episode_number}`)) {
        result.skipped++;
        continue;
      }
      result.episodesChecked++;
      let streams = [];
      try {
        streams = (await fetchTorrentio(`series/${imdbId}:${s.season_number}:${ep.episode_number}`)).streams || [];
      } catch {
        continue;
      }
      const candidates = streams.map((st) => evaluateStream(st, show, s.season_number, ep.episode_number, opts.minSeeders)).filter((c) => !c.reject);
      const best = pickBestPerQuality(candidates);
      const tag = `S${pad(s.season_number)}E${pad(ep.episode_number)}`;
      if (Object.keys(best).length) result.found[tag] = Object.entries(best).map(([q, c]) => `${q} ${c.label === "Hindi" ? "Hindi" : "Dual"} ${humanSize(c.sizeBytes)}`).join(" | ");
      if (opts.dryRun) continue;

      for (const [q, c] of Object.entries(best)) {
        const saved = await saveTorrentRelease(
          {
            mediaId: String(d.id),
            imdbId,
            title: `${d.name} - ${tag}`,
            year: details.year,
            mediaType: "tv",
            season: s.season_number,
            episode: ep.episode_number,
            language: c.label,
            quality: q,
            overview: ep.overview || details.overview,
            posterUrl: details.poster_url,
            seriesPosterUrl: details.poster_url,
            stillUrl: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
            backdropUrl: details.backdrop_url,
            rating: d.vote_average ? Math.round(d.vote_average * 10) : null,
            baseUrl: VPS_BASE_URL,
          },
          {
            // Episode-shaped title so the size check treats it as one episode, not a season pack.
            title: `${d.name} ${tag} ${q} ${baseName(c.fileName || c.release)}`,
            magnet_link: c.magnet,
            seeders: c.seeders,
            size_bytes: c.sizeBytes,
            size_human: humanSize(c.sizeBytes),
            quality: q,
            language_label: c.label,
            provider: "torrentio",
            primary: true,
            file_name: c.fileName,
            file_idx: c.fileIdx,
          }
        ).catch((err) => {
          console.warn(`   ! save ${d.name} ${tag} ${q}: ${err.message}`);
          return null;
        });
        if (saved) result.saved++;
      }
    }
  }
  return { ...result, status: "done" };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!env.tmdbApiKey) throw new Error("TMDB_API_KEY is missing in .env");
  const supabase = getSupabaseClient();
  console.log("================================================================");
  console.log(" Series · verified Hindi / Dual Audio [Hindi+Eng] · per-episode files · 480p/720p/1080p");
  console.log(` ${opts.dryRun ? "DRY RUN (no Supabase writes)" : "LIVE: writing to Supabase"} · min seeders ${opts.minSeeders}`);
  console.log("================================================================");

  let ids = opts.tmdbIds;
  if (!ids.length) {
    for (const lang of opts.langs) {
      const found = await discoverShows(lang, opts);
      console.log(`TMDB ${LANG_LABELS[lang]} series aired in the last ${opts.days} days: ${found.length}`);
      ids.push(...found);
    }
    ids = [...new Set(ids)];
  }

  const results = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const out = await Promise.all(
      ids.slice(i, i + CONCURRENCY).map((id) => processShow(supabase, id, opts).catch((err) => ({ tmdbId: id, title: "?", status: `error: ${err.message}`, found: {} })))
    );
    for (const r of out) {
      results.push(r);
      const eps = Object.keys(r.found || {});
      console.log(
        `[${results.length}/${ids.length}] ${r.title} -> ${eps.length ? `${eps.length} episodes with Hindi (${eps.slice(0, 3).join(", ")}${eps.length > 3 ? " ..." : ""})` : r.status === "done" ? "no new Hindi episodes" : r.status}` +
          (r.skipped ? ` · ${r.skipped} already had Hindi` : "") +
          (r.saved ? ` · saved ${r.saved}` : "")
      );
    }
  }

  const summary = {
    ranAt: new Date().toISOString(),
    shows: results.length,
    episodesChecked: results.reduce((n, r) => n + (r.episodesChecked || 0), 0),
    episodesWithHindi: results.reduce((n, r) => n + Object.keys(r.found || {}).length, 0),
    rowsSaved: results.reduce((n, r) => n + (r.saved || 0), 0),
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ summary, results }, null, 2));
  console.log("================================================================");
  console.log(` Shows: ${summary.shows} · episodes checked: ${summary.episodesChecked} · with Hindi: ${summary.episodesWithHindi} · rows saved: ${summary.rowsSaved}`);
  console.log(` Report: ${REPORT_FILE}`);
  console.log("================================================================");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
