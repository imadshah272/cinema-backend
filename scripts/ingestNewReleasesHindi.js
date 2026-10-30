#!/usr/bin/env node
"use strict";

/**
 * New releases (Hollywood, Bollywood, Kollywood, Tollywood) with verified Hindi audio.
 *
 * 1. TMDB discover: newest popular movies per industry (original language en / hi / ta / te).
 * 2. Torrentio by IMDb id: every indexed release with its seeders and size.
 * 3. Strict release checks (release name only, never flags or DB labels):
 *    - Hindi / Hin / Urdu named in the release; "DUAL" or "DUBBED" alone is rejected.
 *    - "Dual Audio [Hindi+Eng]" only when English is a second track (named explicitly
 *      for non-English films, where DUAL is usually Hindi + Tamil/Telugu).
 *    - 480p / 720p / 1080p only (an unlabelled file <= 1.2 GB counts as 480p). 2160p / 4K ignored.
 *    - Cinema prints (CAM / TS / PreDVD / DVDScr) allowed but ranked below a clean print.
 *    - Release year must match the film (stops 1994 "Street Fighter" for the 2026 film).
 *    - Seeders >= --min-seeders.
 * 4. Best release per quality -> Supabase media_sources (magnet dn = real release name),
 *    catalog row -> media_content, full report -> scripts/.new-releases-hindi.json.
 *
 * Usage:
 *   node scripts/ingestNewReleasesHindi.js --dry-run
 *   node scripts/ingestNewReleasesHindi.js --industries=bollywood,kollywood --pages=3
 *   node scripts/ingestNewReleasesHindi.js --tmdb=1153576,1234139,937020
 * Flags:
 *   --industries=hollywood,bollywood,kollywood,tollywood,mollywood,sandalwood   (default: all)
 *   --from=YYYY-MM-DD --to=YYYY-MM-DD   release window (default: Jan 1 last year .. today)
 *   --days=N         release window = the last N days (used by scripts/autopilot.js)
 *   --pages=N        TMDB pages per industry, 20 films each (default 2)
 *   --mode=top       all-time top rated + trending per industry instead of new releases
 *   --mode=franchises  most watched films per industry + every part of their collections
 *   --count=N        films per list in --mode=top / franchises (default 20)
 *   --with-parts     also fetch every released part of each film's collection (Dune 1-3 ...)
 *   --parts-only     like --with-parts, but only the parts (base films already done)
 *   --tmdb=id,id     only these TMDB movie ids
 *   --min-seeders=N  (default 3)
 *   --dry-run        no Supabase writes; report file only
 *   --no-cam         skip cinema prints entirely
 *   --purge-wrong    delete this film's existing media_sources rows that fail the checks
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");

const env = require("../server/config/env");
const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { releaseName, hindiAudioKind, audioLabel, detectQuality } = require("../server/services/releaseAudio");
const { fetchTorrentio } = require("../server/services/torrentioClient");

const TMDB = "https://api.themoviedb.org/3";
const VPS_BASE_URL = process.env.BASE_URL || "http://168.144.249.68:4555";
const REPORT_FILE = path.join(__dirname, ".new-releases-hindi.json");
const CONCURRENCY = 3;

// minVotes keeps "top rated" to well-known films (a 9.5 with 12 votes is not top rated).
const INDUSTRIES = {
  hollywood: { lang: "en", label: "Hollywood", minVotes: 3000 },
  bollywood: { lang: "hi", label: "Bollywood", minVotes: 300 },
  kollywood: { lang: "ta", label: "Kollywood", minVotes: 50 },
  tollywood: { lang: "te", label: "Tollywood", minVotes: 50 },
  mollywood: { lang: "ml", label: "Mollywood", minVotes: 50 },
  sandalwood: { lang: "kn", label: "Sandalwood", minVotes: 50 },
};
const QUALITIES = ["1080p", "720p", "480p"];
const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** Stream-friendly size per tier. Larger releases are kept only when nothing smaller exists. */
const SOFT_MAX_BYTES = { "480p": 1.2 * GB, "720p": 2.5 * GB, "1080p": 5 * GB };
/** Never stored: remuxes (30-40 GB) are not streamable. */
const HARD_MAX_BYTES = { "480p": 1.5 * GB, "720p": 4 * GB, "1080p": 8 * GB };
const CAM_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|pre[ ._-]?dvd|scr|dvdscr|hdtscr|screener|hqcam)\b/i;
/** A file with no resolution in its name and at most this size is treated as 480p. */
const UNLABELLED_SD_MAX_BYTES = 1.2 * GB;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  const today = new Date().toISOString().slice(0, 10);
  return {
    industries: String(args.industries || Object.keys(INDUSTRIES).join(","))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => INDUSTRIES[s]),
    from:
      args.from ||
      (Number(args.days) > 0
        ? new Date(Date.now() - Number(args.days) * 86400000).toISOString().slice(0, 10)
        : `${new Date().getFullYear() - 1}-01-01`),
    to: args.to || today,
    pages: Math.max(1, Number(args.pages) || 2),
    tmdbIds: args.tmdb ? String(args.tmdb).split(",").map((s) => s.trim()).filter(Boolean) : [],
    minSeeders: Number(args["min-seeders"]) || 3,
    allowCam: !args["no-cam"],
    mode: ["top", "franchises"].includes(args.mode) ? args.mode : "new",
    withParts: Boolean(args["with-parts"] || args["parts-only"] || args.mode === "franchises"),
    partsOnly: Boolean(args["parts-only"]),
    count: Math.max(1, Number(args.count) || 20),
    dryRun: Boolean(args["dry-run"]),
    purgeWrong: Boolean(args["purge-wrong"]),
  };
}

async function getJson(url, timeoutMs = 15000, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 3000));
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

async function discoverIndustry(key, opts) {
  const { lang } = INDUSTRIES[key];
  const ids = [];
  for (let page = 1; page <= opts.pages; page++) {
    const q =
      `&with_original_language=${lang}&sort_by=popularity.desc&include_adult=false&page=${page}` +
      `&primary_release_date.gte=${opts.from}&primary_release_date.lte=${opts.to}`;
    const data = await tmdb("/discover/movie", q);
    for (const m of data.results || []) ids.push({ id: String(m.id), industry: key });
    if (page >= (data.total_pages || 1)) break;
  }
  return ids;
}

/** --mode=top: `count` top rated + `count` trending films of all time for one industry. */
async function discoverTop(key, count) {
  const { lang, minVotes } = INDUSTRIES[key];
  const today = new Date().toISOString().slice(0, 10);
  const lists = {
    "top rated": `&sort_by=vote_average.desc&vote_count.gte=${minVotes}`,
    trending: `&sort_by=popularity.desc&vote_count.gte=${Math.round(minVotes / 10)}`,
  };
  const ids = [];
  for (const [list, sort] of Object.entries(lists)) {
    const picked = [];
    for (let page = 1; picked.length < count && page <= 5; page++) {
      const data = await tmdb(
        "/discover/movie",
        `&with_original_language=${lang}&include_adult=false&primary_release_date.lte=${today}${sort}&page=${page}`
      );
      for (const m of data.results || []) if (picked.length < count) picked.push({ id: String(m.id), industry: key, list });
      if (page >= (data.total_pages || 1)) break;
    }
    ids.push(...picked);
  }
  return ids;
}

/** --mode=franchises: the most watched films (by vote count) of one industry; their parts are added later. */
async function discoverMostWatched(key, count) {
  const { lang } = INDUSTRIES[key];
  const ids = [];
  for (let page = 1; ids.length < count && page <= 10; page++) {
    const data = await tmdb("/discover/movie", `&with_original_language=${lang}&include_adult=false&sort_by=vote_count.desc&page=${page}`);
    for (const m of data.results || []) if (ids.length < count) ids.push({ id: String(m.id), industry: key, list: "most watched" });
    if (page >= (data.total_pages || 1)) break;
  }
  return ids;
}

/**
 * Every released part of each queued film's TMDB collection
 * (Spider-Man 1-3, Avengers 1-4, Dune 1-3, Dhoom 1-3 ...), so a viewer can watch the whole series.
 */
async function expandCollectionParts(queue) {
  const today = new Date().toISOString().slice(0, 10);
  const seenCollections = new Set();
  const parts = [];
  for (let i = 0; i < queue.length; i += 5) {
    const details = await Promise.all(
      queue.slice(i, i + 5).map((e) => tmdb(`/movie/${e.id}`).catch(() => null))
    );
    for (const d of details) {
      const col = d?.belongs_to_collection;
      if (!col || seenCollections.has(col.id)) continue;
      seenCollections.add(col.id);
      const data = await tmdb(`/collection/${col.id}`).catch(() => null);
      const released = (data?.parts || [])
        .filter((p) => p.release_date && p.release_date <= today)
        .sort((a, b) => a.release_date.localeCompare(b.release_date));
      for (const p of released) {
        parts.push({ id: String(p.id), industry: industryFor(p.original_language), list: `part of ${col.name}` });
      }
      if (released.length) console.log(`  collection ${col.name}: ${released.map((p) => p.title).join(" -> ")}`);
    }
  }
  return parts;
}

function industryFor(lang) {
  return Object.keys(INDUSTRIES).find((k) => INDUSTRIES[k].lang === lang) || "other";
}

function normalizeTitle(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleMatches(release, titles) {
  const rel = ` ${normalizeTitle(release)} `;
  return titles.some((t) => {
    const n = normalizeTitle(t);
    return n && rel.includes(` ${n} `);
  });
}

/** Years in a release name, ignoring resolutions like 1080/2160. */
function releaseYears(release) {
  return (String(release).match(/(?<!\d)(19[3-9]\d|20[0-4]\d)(?!\d|p)/gi) || []).map(Number);
}

function parseSize(text) {
  const m = String(text).match(/💾\s*([\d.]+)\s*(GB|MB)/i);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2].toUpperCase() === "GB" ? GB : MB));
}

function humanSize(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / MB)} MB`;
}

/** Torrentio stream -> candidate, or { reject } with the reason. */
function evaluateStream(stream, film, opts) {
  const lines = String(stream.title || "").split("\n");
  const statIdx = lines.findIndex((l) => l.includes("👤") || l.includes("💾"));
  const release = lines.slice(0, statIdx === -1 ? 1 : statIdx).join(" ").trim();
  const stats = statIdx === -1 ? "" : lines[statIdx];
  const nameQuality = String(stream.name || "").split("\n")[1] || "";

  if (!stream.infoHash || !release) return { reject: "no hash" };
  const cam = CAM_RE.test(release);
  if (cam && !opts.allowCam) return { reject: "cam/ts" };
  const sizeBytes = parseSize(stats);
  let quality = detectQuality(release, "") || detectQuality(nameQuality, "");
  if (quality === "2160p" || /\b4k\b/i.test(nameQuality)) return { reject: "4k ignored" };
  // Small files without a resolution ("Hindi HQ PreDVD - x264 - 700MB") are SD.
  if (!quality && sizeBytes && sizeBytes <= UNLABELLED_SD_MAX_BYTES) quality = "480p";
  if (!QUALITIES.includes(quality)) return { reject: "quality unknown" };
  if (/\bs\d{1,2}[ ._-]?e\d{1,3}\b/i.test(release)) return { reject: "episode" };

  const kind = hindiAudioKind(release, film.originalLanguage);
  if (!kind) return { reject: "no hindi in release name" };

  const years = releaseYears(release);
  const yearOk = years.some((y) => Math.abs(y - film.year) <= 1);
  if (years.length && !yearOk) return { reject: `wrong year ${years.join("/")}` };
  if (!yearOk && !titleMatches(release, film.titles)) return { reject: "title mismatch" };

  const seeders = Number((stats.match(/👤\s*(\d+)/) || [])[1]) || 0;
  if (seeders < opts.minSeeders) return { reject: "low seeders" };
  if (!sizeBytes) return { reject: "no size" };
  if (sizeBytes > HARD_MAX_BYTES[quality]) return { reject: "too large to stream" };

  const trackers = (stream.sources || [])
    .filter((s) => /^tracker:/i.test(s))
    .map((s) => `&tr=${encodeURIComponent(s.replace(/^tracker:/i, ""))}`)
    .join("");
  // Torrentio shows "pack name" + "file name" for a film inside a multi-film pack (MCU 2008-2018 ...).
  const pack = statIdx > 1 && stream.fileIdx != null;
  const fileName = pack ? stream.behaviorHints?.filename || lines[statIdx - 1].trim() : null;
  return {
    release,
    quality,
    kind,
    cam,
    pack,
    fileName,
    fileIdx: pack ? stream.fileIdx : null,
    label: audioLabel(kind),
    seeders,
    sizeBytes,
    sizeHuman: humanSize(sizeBytes),
    provider: (stats.match(/⚙️\s*(.+)$/) || [])[1]?.trim() || "torrentio",
    magnet: `magnet:?xt=urn:btih:${stream.infoHash.toLowerCase()}&dn=${encodeURIComponent(release)}${trackers}`,
  };
}

/**
 * Hindi audio a phone can play: AAC named in the release beats Dolby/DTS (AC3, DD+, DTS),
 * which most Android phones skip, leaving the English AAC track playing.
 */
function codecRank(release) {
  if (/\baac\b|\bhe-aac\b/i.test(release)) return 0;
  if (/\b(dd\+?|ddp|ac3|eac3|e-ac-3|dts|truehd|atmos)\b/i.test(release)) return 2;
  return 1;
}

/** Best per tier: clean print, phone-playable Hindi codec, Dual before Hindi, single film, size, seeders. */
function pickBestPerQuality(candidates) {
  const best = {};
  for (const q of QUALITIES) {
    const pool = candidates
      .filter((c) => c.quality === q)
      .sort(
        (a, b) =>
          (a.cam ? 1 : 0) - (b.cam ? 1 : 0) ||
          codecRank(a.release) - codecRank(b.release) ||
          (a.kind === "dual" ? 0 : 1) - (b.kind === "dual" ? 0 : 1) ||
          (a.pack ? 1 : 0) - (b.pack ? 1 : 0) ||
          (a.sizeBytes <= SOFT_MAX_BYTES[q] ? 0 : 1) - (b.sizeBytes <= SOFT_MAX_BYTES[q] ? 0 : 1) ||
          b.seeders - a.seeders
      );
    if (pool[0]) best[q] = pool[0];
  }
  return best;
}

async function loadFilm(id, industryHint) {
  const d = await tmdb(`/movie/${id}`, "&append_to_response=external_ids");
  const releaseDate = d.release_date || "";
  return {
    id: String(d.id),
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    title: d.title,
    titles: [d.title, d.original_title].filter((t) => t && /^[\x20-\x7e]+$/.test(t)),
    year: Number(releaseDate.slice(0, 4)) || null,
    releaseDate,
    originalLanguage: d.original_language,
    industry: industryHint || industryFor(d.original_language),
    raw: d,
  };
}

async function upsertCatalog(supabase, film) {
  const d = film.raw;
  const { data: existing } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("details")
    .eq("source", "tmdb")
    .eq("media_type", "movie")
    .eq("external_id", Number(film.id))
    .maybeSingle();
  const details = {
    ...(existing?.details || {}),
    id: d.id,
    year: film.year ? String(film.year) : "",
    title: d.title,
    overview: d.overview,
    genre_ids: (d.genres || []).map((g) => g.id),
    poster_url: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
    poster_path: d.poster_path,
    backdrop_url: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null,
    backdrop_path: d.backdrop_path,
    release_date: d.release_date,
    vote_average: d.vote_average,
    original_language: d.original_language,
    imdb_id: film.imdbId,
    industry: INDUSTRIES[film.industry]?.label || film.industry,
  };
  const { error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .upsert(
      { external_id: Number(film.id), source: "tmdb", title: String(d.title).slice(0, 255), media_type: "movie", details },
      { onConflict: "source,media_type,external_id" }
    );
  if (error) throw new Error(`media_content upsert: ${error.message}`);
  return details;
}

/** Existing rows for this film whose release fails the same checks. */
async function findWrongRows(supabase, film) {
  const { data } = await supabase.from(MEDIA_SOURCES_TABLE).select("id, quality, language, magnet_link, download_url").eq("media_id", film.id);
  return (data || []).filter((row) => {
    const name = releaseName(row);
    const years = releaseYears(name);
    const wrongYear = film.year && years.length && !years.some((y) => Math.abs(y - film.year) <= 1);
    return !hindiAudioKind(name) || wrongYear || detectQuality(name, row.quality) === "2160p";
  });
}

async function processFilm(supabase, entry, opts) {
  const film = await loadFilm(entry.id, entry.industry);
  const result = { tmdbId: film.id, imdbId: film.imdbId, title: film.title, year: film.year, industry: film.industry, saved: [], tiers: {}, rejects: {} };
  if (!film.imdbId) return { ...result, status: "no imdb id" };
  if (!film.year || film.releaseDate > new Date().toISOString().slice(0, 10)) return { ...result, status: "unreleased" };

  let streams = [];
  try {
    streams = (await fetchTorrentio(`movie/${film.imdbId}`)).streams || [];
  } catch (err) {
    return { ...result, status: `torrentio error: ${err.message}` };
  }

  const candidates = [];
  for (const s of streams) {
    const c = evaluateStream(s, film, opts);
    if (c.reject) result.rejects[c.reject] = (result.rejects[c.reject] || 0) + 1;
    else candidates.push(c);
  }
  const best = pickBestPerQuality(candidates);
  for (const [q, c] of Object.entries(best)) {
    result.tiers[q] = { label: c.label, print: c.cam ? "CAM/TS" : "clean", packFile: c.fileName, seeders: c.seeders, size: c.sizeHuman, release: c.release, provider: c.provider, magnet: c.magnet };
  }

  if (!opts.dryRun) {
    const details = await upsertCatalog(supabase, film);
    if (opts.purgeWrong) {
      const wrong = await findWrongRows(supabase, film);
      if (wrong.length) {
        await supabase.from(MEDIA_SOURCES_TABLE).delete().in("id", wrong.map((r) => r.id));
        result.purged = wrong.length;
      }
    }
    for (const [q, c] of Object.entries(best)) {
      const saved = await saveTorrentRelease(
        {
          mediaId: film.id,
          imdbId: film.imdbId,
          title: film.title,
          year: film.year,
          mediaType: "movie",
          language: c.label,
          quality: q,
          overview: details.overview,
          posterUrl: details.poster_url,
          backdropUrl: details.backdrop_url,
          rating: film.raw.vote_average ? Math.round(film.raw.vote_average * 10) : null,
          baseUrl: VPS_BASE_URL,
          allowCamPrint: c.cam,
        },
        {
          title: c.release,
          magnet_link: c.magnet,
          seeders: c.seeders,
          size_bytes: c.sizeBytes,
          size_human: c.sizeHuman,
          quality: q,
          language_label: c.label,
          provider: c.provider,
          primary: true,
          file_name: c.fileName,
          file_idx: c.fileIdx,
        }
      ).catch((err) => {
        console.warn(`   ! save ${film.title} ${q}: ${err.message}`);
        return null;
      });
      if (saved !== null && saved !== undefined) result.saved.push(q);
    }
  } else {
    result.wouldPurge = (await findWrongRows(supabase, film)).length;
  }

  return { ...result, status: Object.keys(best).length ? "found" : "no verified hindi release" };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!env.tmdbApiKey) throw new Error("TMDB_API_KEY is missing in .env");
  const supabase = getSupabaseClient();

  console.log("================================================================");
  console.log(" New releases · verified Hindi / Dual Audio [Hindi+Eng] · 480p/720p/1080p");
  console.log(` ${opts.dryRun ? "DRY RUN (no Supabase writes)" : "LIVE: writing to Supabase"} · min seeders ${opts.minSeeders}`);
  console.log("================================================================");

  let queue = [];
  if (opts.tmdbIds.length) {
    queue = opts.tmdbIds.map((id) => ({ id, industry: null }));
  } else {
    for (const key of opts.industries) {
      if (opts.mode === "top") {
        const ids = await discoverTop(key, opts.count);
        console.log(`TMDB ${INDUSTRIES[key].label}: ${opts.count} top rated + ${opts.count} trending (${ids.length} films)`);
        queue.push(...ids);
      } else if (opts.mode === "franchises") {
        const ids = await discoverMostWatched(key, opts.count);
        console.log(`TMDB ${INDUSTRIES[key].label}: ${ids.length} most watched films (collections expanded below)`);
        queue.push(...ids);
      } else {
        const ids = await discoverIndustry(key, opts);
        console.log(`TMDB ${INDUSTRIES[key].label}: ${ids.length} films (${opts.from} .. ${opts.to})`);
        queue.push(...ids);
      }
    }
  }
  if (opts.withParts) {
    console.log("Adding every released part of each film's collection...");
    const parts = await expandCollectionParts(queue);
    queue = opts.partsOnly ? parts : [...queue, ...parts];
  }
  const seen = new Set();
  queue = queue.filter((e) => !seen.has(e.id) && seen.add(e.id));
  console.log(`Queue: ${queue.length} films`);

  const results = [];
  let done = 0;
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const chunk = queue.slice(i, i + CONCURRENCY);
    const out = await Promise.all(
      chunk.map((e) =>
        processFilm(supabase, e, opts).catch((err) => ({ tmdbId: e.id, title: "?", status: `error: ${err.message}`, tiers: {}, saved: [] }))
      )
    );
    for (const r of out) {
      done++;
      results.push(r);
      const tiers = Object.entries(r.tiers || {})
        .map(([q, t]) => `${q} ${t.label === "Hindi" ? "Hindi" : "Dual"}${t.print === "CAM/TS" ? " CAM" : ""}${t.packFile ? " (pack)" : ""} ${t.size} 👤${t.seeders}`)
        .join(" | ");
      const tag = (INDUSTRIES[r.industry]?.label || r.industry || "").padEnd(9);
      const extra = r.purged ? ` (purged ${r.purged} wrong)` : r.wouldPurge ? ` (${r.wouldPurge} wrong rows in DB)` : "";
      console.log(`[${done}/${queue.length}] ${tag} ${r.title} (${r.year || "?"}) -> ${tiers || r.status}${extra}`);
    }
  }

  const summary = {
    ranAt: new Date().toISOString(),
    options: opts,
    films: results.length,
    withHindi: results.filter((r) => Object.keys(r.tiers || {}).length).length,
    tiersFound: results.reduce((n, r) => n + Object.keys(r.tiers || {}).length, 0),
    tiersSaved: results.reduce((n, r) => n + (r.saved || []).length, 0),
  };
  const reportFile = opts.tmdbIds.length
    ? REPORT_FILE.replace(".json", "-ids.json")
    : opts.mode !== "new" ? REPORT_FILE.replace(".json", `-${opts.mode}.json`) : REPORT_FILE;
  fs.writeFileSync(reportFile, JSON.stringify({ summary, results }, null, 2));

  console.log("================================================================");
  console.log(` Films checked: ${summary.films} · with verified Hindi: ${summary.withHindi}`);
  console.log(` Quality tiers found: ${summary.tiersFound} · saved to Supabase: ${summary.tiersSaved}`);
  console.log(` Full report: ${reportFile}`);
  console.log("================================================================");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
