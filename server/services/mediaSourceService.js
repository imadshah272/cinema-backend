"use strict";

/**
 * Persistence for verified download sources and failed-resolution queues.
 */

const {
  getSupabaseClient,
  toFriendlySupabaseError,
  MEDIA_SOURCES_TABLE,
  MEDIA_CONTENT_TABLE,
  DOWNLOAD_REQUESTS_TABLE,
} = require("./supabaseClient");
const { isTorrentArtifactUrl, isVideoFileUrl, isReadyVideoFile, minVideoBytes } = require("./videoFile");
const { acceptTorrentRelease, magnetWrite, normalizeSourceLinks, publicSize, lookupReleaseBytes } = require("./torrentResolver");

function normalizePart(value, fallback = "all") {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return text || fallback;
}

/** Stored language label. Lookup is case-insensitive, so "hindi" and "Hindi" hit one row. */
function canonicalLanguage(language) {
  const raw = String(language || "").trim();
  if (
    raw === "Hindi" ||
    raw === "Urdu" ||
    raw === "Dual Audio [Hindi+Eng]" ||
    raw === "Hindi / Dual Audio" ||
    raw === "Turkish / Urdu" ||
    raw === "Turkish" ||
    raw === "Original" ||
    raw === "English"
  ) {
    return raw;
  }
  const lang = raw.toLowerCase();
  if (!lang || lang === "all" || lang === "original") return "All";
  if (/\bturkish\b|\bturk\b|\btrt\b/.test(lang)) return "Turkish / Urdu";
  if (/\burdu\b/.test(lang) && !/\bhindi\b/.test(lang) && !/\bdual\b/.test(lang)) return "Urdu";
  if (/\bdual\b/.test(lang)) return "Dual Audio [Hindi+Eng]";
  if (/\bhindi\b|\bhi\b|\bdubbed\b|\bdesi\b/.test(lang)) return "Hindi";
  if (lang === "english" || lang === "en") return "English";
  return lang.charAt(0).toUpperCase() + lang.slice(1);
}

function canonicalQuality(quality) {
  const q = String(quality || "").trim().toLowerCase();
  if (!q || q === "all" || q === "any") return "All";
  if (q === "4k" || q === "uhd" || q === "2160p") return "2160p";
  return q;
}

function isPlayableUrl(value) {
  const text = String(value || "").trim();
  return text.length > 8 && (/^magnet:\?/i.test(text) || /^https?:\/\//i.test(text));
}

function scopedMediaId(mediaId, season, episode) {
  if (!mediaId) return null;
  const raw = String(mediaId).trim();
  const s = Number(season);
  const e = Number(episode);
  if (Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0) {
    const sPad = String(s).padStart(2, "0");
    const ePad = String(e).padStart(2, "0");
    if (/-s\d+e\d+/i.test(raw)) return raw;
    if (/:s\d+:e\d+/i.test(raw)) return raw.replace(/:s(\d+):e(\d+)/i, (_, sN, eN) => `-s${String(sN).padStart(2, "0")}e${String(eN).padStart(2, "0")}`);
    return `${raw}-s${sPad}e${ePad}`;
  }
  return raw;
}

function buildCacheKey({ mediaId, title, year, language, quality, season, episode } = {}) {
  const id = String(mediaId == null ? "" : mediaId).trim() || "-";
  const name = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const yr = String(year || "").replace(/\D/g, "").slice(0, 4) || "-";
  const s = Number(season);
  const e = Number(episode);
  const isEp = Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0;
  const epPart = isEp ? `s${String(s).padStart(2, "0")}::e${String(e).padStart(2, "0")}` : null;
  const parts = [id, name, yr];
  if (epPart) parts.push(epPart);
  parts.push(normalizePart(language), normalizePart(quality));
  return parts.join("::");
}

function mapSourceRow(row) {
  if (!row) return null;
  const languageLabel = row.payload?.language_label || row.language;
  const links = normalizeSourceLinks(row);
  const size = publicSize(row);
  return {
    id: row.id,
    cacheKey: row.cache_key,
    mediaId: row.media_id,
    title: row.media_title,
    year: row.year,
    source_type: links.source_type,
    download_url: links.download_url,
    magnet_link: links.magnet_link,
    quality: row.quality,
    resolution: row.quality,
    language: languageLabel,
    language_label: languageLabel,
    size: size.size,
    size_human: size.size_human,
    size_bytes: size.size_bytes,
    seeders: row.seeders == null ? undefined : Number(row.seeders),
    stream_url: links.stream_url,
    fallback_url: row.payload?.alternates?.[0]?.stream_url || row.payload?.fallback_url || "",
    is_fallback: Boolean(row.is_fallback),
    cached: true,
    status: row.status || "ready",
  };
}

async function findCachedSource(params) {
  const language = canonicalLanguage(params.language);
  const quality = canonicalQuality(params.quality);
  const s = Number(params.season);
  const e = Number(params.episode);
  const isEp = Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0;
  const expectedCacheKey = buildCacheKey({ ...params, language, quality });
  const rawIds = [...new Set([params.mediaId, params.imdbId, params.tmdbId].map((value) => String(value || "").trim()).filter(Boolean))];
  const ids = isEp ? rawIds.map((id) => scopedMediaId(id, s, e)) : rawIds;

  try {
    const supabase = getSupabaseClient();
    let query = supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("*")
      .ilike("language", language)
      .ilike("quality", quality)
      .eq("status", "ready")
      .not("download_url", "is", null)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (isEp) {
      query = ids.length ? query.in("media_id", ids) : query.eq("cache_key", expectedCacheKey);
    } else if (ids.length) {
      query = query.in("media_id", ids);
    } else {
      query = query.eq("cache_key", expectedCacheKey);
    }

    let { data, error } = await query;
    if (error && /status/i.test(error.message || "")) {
      let retry = supabase
        .from(MEDIA_SOURCES_TABLE)
        .select("*")
        .ilike("language", language)
        .ilike("quality", quality)
        .not("download_url", "is", null)
        .order("updated_at", { ascending: false })
        .limit(20);
      if (isEp) {
        retry = ids.length ? retry.in("media_id", ids) : retry.eq("cache_key", expectedCacheKey);
      } else if (ids.length) {
        retry = retry.in("media_id", ids);
      } else {
        retry = retry.eq("cache_key", expectedCacheKey);
      }
      ({ data, error } = await retry);
    }
    if (error) throw toFriendlySupabaseError(error, "read media_sources");
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const candidate = rows.find((row) => {
      if (isEp) {
        return (
          row.cache_key === expectedCacheKey ||
          (Number(row.payload?.season) === s && Number(row.payload?.episode) === e) ||
          (row.media_id && row.media_id.endsWith(`:s${s}:e${e}`))
        );
      }
      return !row.payload?.episode && !/::e\d+::/i.test(row.cache_key || "") && !/:s\d+:e\d+/i.test(row.media_id || "");
    });
    if (!candidate) return null;
    const mapped = mapSourceRow(candidate);
    if (!isReadyVideoFile(mapped)) return null;
    return mapped;
  } catch (error) {
    console.warn("[media-sources] cache lookup skipped:", error.message);
    return null;
  }
}

function readyScore(row, language, quality) {
  let score = 0;
  const wantedLanguage = canonicalLanguage(language);
  const wantedQuality = canonicalQuality(quality);
  if (wantedLanguage !== "All" && canonicalLanguage(row.language) === wantedLanguage) score += 100;
  if (wantedQuality !== "All" && canonicalQuality(row.quality) === wantedQuality) score += 40;
  if (row.source_type === "torrent" || row.source_type === "ddl") score += 25;
  score += Math.min(Number(row.seeders) || 0, 40) / 10;
  return score;
}

/**
 * Any ready row with a real download URL for this id, or this title + year.
 * Language and quality only change which row wins. They do not hide a hit.
 */
async function findReadyDownload({ mediaId, imdbId, title, year, language, quality, season, episode } = {}) {
  const s = Number(season);
  const e = Number(episode);
  const isEp = Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0;
  const rawIds = [...new Set([mediaId, imdbId].map((value) => String(value || "").trim()).filter(Boolean))];
  const ids = isEp ? rawIds.map((id) => scopedMediaId(id, s, e)) : rawIds;
  const name = String(title || "").trim();
  if (!ids.length && !name) return null;
  const expectedCacheKey = buildCacheKey({ mediaId, imdbId, title, year, language, quality, season, episode });

  async function readRows(apply) {
    const supabase = getSupabaseClient();
    const run = (withStatus) => {
      let query = supabase
        .from(MEDIA_SOURCES_TABLE)
        .select("*")
        .or("download_url.not.is.null,magnet_link.not.is.null")
        .order("updated_at", { ascending: false })
        .limit(25);
      if (withStatus) query = query.eq("status", "ready");
      return apply(query);
    };
    let { data, error } = await run(true);
    if (error && /status/i.test(error.message || "")) ({ data, error } = await run(false));
    if (error) throw toFriendlySupabaseError(error, "read ready media_sources");
    return (Array.isArray(data) ? data : []).map(mapSourceRow).filter((row) => isReadyVideoFile(row));
  }

  try {
    let rows = [];
    if (isEp) {
      if (ids.length) rows = await readRows((query) => query.in("media_id", ids));
      if (!rows.length) rows = await readRows((query) => query.eq("cache_key", expectedCacheKey));
      rows = rows.filter(
        (r) =>
          r.cacheKey === expectedCacheKey ||
          (Number(r.payload?.season) === s && Number(r.payload?.episode) === e) ||
          (r.mediaId && r.mediaId.endsWith(`:s${s}:e${e}`))
      );
    } else {
      if (ids.length) rows = await readRows((query) => query.in("media_id", ids));
      if (!rows.length && name) {
        const exact = name.replace(/[\\%_]/g, "\\$&");
        rows = await readRows((query) => {
          let next = query.ilike("media_title", exact);
          if (year != null && String(year).trim()) next = next.eq("year", String(year).trim());
          return next;
        });
        if (!rows.length && year != null && String(year).trim()) {
          rows = await readRows((query) => query.ilike("media_title", exact));
        }
      }
      rows = rows.filter((r) => !r.payload?.episode && !/::e\d+::/i.test(r.cacheKey || "") && !/:s\d+:e\d+/i.test(r.mediaId || ""));
    }
    if (!rows.length) return null;
    rows.sort((a, b) => readyScore(b, language, quality) - readyScore(a, language, quality));
    return rows[0];
  } catch (error) {
    console.warn("[media-sources] ready lookup skipped:", error.message);
    return null;
  }
}

/** A future premiere date is unreleased. Year-only titles are unreleased only after this calendar year. */
function isUnreleasedTitle({ year, releaseDate } = {}, now = Date.now()) {
  const rawDate = String(releaseDate || "").trim();
  if (rawDate) {
    const date = new Date(rawDate);
    if (!Number.isNaN(date.getTime())) return date.getTime() > now;
  }
  const match = String(year || "").match(/\b(?:19|20)\d{2}\b/);
  const numericYear = match ? Number(match[0]) : NaN;
  return Number.isInteger(numericYear) && numericYear > new Date(now).getFullYear();
}

async function loadReleaseFacts({ mediaId, title, year } = {}) {
  const fallback = { year: year == null ? "" : String(year), releaseDate: "" };
  try {
    const supabase = getSupabaseClient();
    let query = supabase.from(MEDIA_CONTENT_TABLE).select("title, details").limit(1);
    const id = Number(mediaId);
    if (Number.isInteger(id) && id > 0) query = query.eq("external_id", id);
    else if (title && String(title).trim()) query = query.ilike("title", String(title).trim().replace(/[\\%_]/g, "\\$&"));
    else return fallback;
    const { data, error } = await query;
    if (error) return fallback;
    const row = Array.isArray(data) ? data[0] : data;
    const details = row?.details || {};
    return {
      year: fallback.year || details.year || "",
      releaseDate: details.release_date || details.first_air_date || details.premiered || "",
    };
  } catch (error) {
    console.warn("[media-sources] release lookup skipped:", error.message);
    return fallback;
  }
}

async function resolvePosterAndBackdrop(params, release, rawMediaId) {
  let posterUrl =
    params?.posterUrl ||
    params?.poster_url ||
    params?.poster ||
    release?.poster_url ||
    release?.posterUrl ||
    release?.poster ||
    null;

  let backdropUrl =
    params?.backdropUrl ||
    params?.backdrop_url ||
    params?.backdrop ||
    release?.backdrop_url ||
    release?.backdropUrl ||
    release?.backdrop ||
    null;

  let overview = params?.overview || release?.overview || null;
  let rating = params?.rating != null ? params.rating : (release?.rating != null ? release.rating : null);

  if (posterUrl && typeof posterUrl === "string" && posterUrl.startsWith("/") && !posterUrl.startsWith("//")) {
    posterUrl = `https://image.tmdb.org/t/p/w500${posterUrl}`;
  }
  if (backdropUrl && typeof backdropUrl === "string" && backdropUrl.startsWith("/") && !backdropUrl.startsWith("//")) {
    backdropUrl = `https://image.tmdb.org/t/p/w1280${backdropUrl}`;
  }

  // 1. Look up Supabase media_content table if poster is missing
  if (!posterUrl && (rawMediaId || params?.title)) {
    try {
      const supabase = getSupabaseClient();
      const baseId = rawMediaId ? String(rawMediaId).split(/[-:]/)[0] : null;
      let data = null;

      if (baseId && /^\d+$/.test(baseId)) {
        const res = await supabase
          .from(MEDIA_CONTENT_TABLE)
          .select("title, details")
          .or(`external_id.eq.${baseId},id.eq.${baseId}`)
          .limit(1);
        data = res.data;
      }

      if ((!data || !data.length) && params?.title) {
        const res = await supabase
          .from(MEDIA_CONTENT_TABLE)
          .select("title, details")
          .ilike("title", String(params.title).trim())
          .limit(1);
        data = res.data;
      }

      if (data && data[0]?.details) {
        const d = data[0].details;
        posterUrl = d.poster_url || d.poster || (d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null);
        if (!backdropUrl) {
          backdropUrl = d.backdrop_url || d.backdrop || (d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null);
        }
        if (!overview) overview = d.overview || d.description || null;
        if (rating == null) rating = d.rating_percent || (d.vote_average ? Math.round(Number(d.vote_average) * 10) : null);
      }
    } catch (_) {}
  }

  // 2. Direct TMDB API fallback
  const env = require("../config/env");
  const tmdbKey = env.tmdbApiKey || process.env.TMDB_API_KEY;
  if (!posterUrl && tmdbKey && (rawMediaId || params?.title)) {
    try {
      const axios = require("axios");
      const baseId = rawMediaId ? String(rawMediaId).split(/[-:]/)[0] : null;
      const isNum = baseId && /^\d+$/.test(baseId) && Number(baseId) > 0;
      const isTv = params?.mediaType === "series" || params?.mediaType === "tv";

      if (isNum) {
        const type = isTv ? "tv" : "movie";
        const tmdbRes = await axios.get(`https://api.themoviedb.org/3/${type}/${baseId}`, {
          params: { api_key: tmdbKey },
          timeout: 3000,
        });
        const hit = tmdbRes.data;
        if (hit?.poster_path) posterUrl = `https://image.tmdb.org/t/p/w500${hit.poster_path}`;
        if (!backdropUrl && hit?.backdrop_path) backdropUrl = `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}`;
        if (!overview && hit?.overview) overview = hit.overview;
        if (rating == null && hit?.vote_average) rating = Math.round(Number(hit.vote_average) * 10);
      } else if (params?.title) {
        const searchType = isTv ? "tv" : "movie";
        const tmdbRes = await axios.get(`https://api.themoviedb.org/3/search/${searchType}`, {
          params: { api_key: tmdbKey, query: params.title, year: params.year || undefined },
          timeout: 3000,
        });
        const hit = tmdbRes.data?.results?.[0];
        if (hit?.poster_path) posterUrl = `https://image.tmdb.org/t/p/w500${hit.poster_path}`;
        if (!backdropUrl && hit?.backdrop_path) backdropUrl = `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}`;
        if (!overview && hit?.overview) overview = hit.overview;
        if (rating == null && hit?.vote_average) rating = Math.round(Number(hit.vote_average) * 10);
      }
    } catch (_) {}
  }

  if (posterUrl && typeof posterUrl === "string" && posterUrl.startsWith("/") && !posterUrl.startsWith("//")) {
    posterUrl = `https://image.tmdb.org/t/p/w500${posterUrl}`;
  }
  if (backdropUrl && typeof backdropUrl === "string" && backdropUrl.startsWith("/") && !backdropUrl.startsWith("//")) {
    backdropUrl = `https://image.tmdb.org/t/p/w1280${backdropUrl}`;
  }

  return {
    posterUrl: posterUrl || null,
    backdropUrl: backdropUrl || null,
    overview: overview || null,
    rating: rating != null ? rating : null,
  };
}

async function saveCachedSource(params, resolved) {
  const storedUrl = resolved?.download_url || resolved?.stream_url;
  const magnet = magnetWrite(resolved?.magnet_link) || magnetWrite(storedUrl);
  if (magnet && resolved?.source_type !== "embed_stream") {
    return saveTorrentRelease(params, { ...resolved, ...magnet });
  }
  if (isTorrentArtifactUrl(storedUrl)) return null;
  // A cloud player link (vidsrc / vidlink ...) is rebuilt from the TMDB id on every request.
  // Stored, it was labelled with the *requested* language ("Hindi") and a made-up 1080p,
  // although these players mostly play English, so it is never written to media_sources.
  if (resolved?.source_type === "embed_stream") return null;
  const embed = false;
  const size = publicSize(resolved);
  const sizeBytes = size.size_bytes;
  if (!embed) {
    if (!isVideoFileUrl(storedUrl)) return null;
    if (!sizeBytes || sizeBytes < minVideoBytes(params.mediaType)) return null;
  } else if (!isPlayableUrl(storedUrl)) {
    return null;
  }
  const s = Number(params.season);
  const e = Number(params.episode);
  const isEp = Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0;
  const rawMediaId = params.mediaId == null || String(params.mediaId).trim() === "" ? null : String(params.mediaId).trim();
  const mediaId = scopedMediaId(rawMediaId, s, e);
  const language = canonicalLanguage(params.language);
  const isDubOrDesi = language === "Hindi" || language === "Urdu" || language === "Dual Audio [Hindi+Eng]" || language === "Hindi / Dual Audio" || language === "Turkish / Urdu" || language === "Turkish";
  if (!isDubOrDesi && !params.allowEnglish) {
    console.log(`[media-sources] Skipping cache write for non-dubbed stream "${params.title}" (${language})`);
    return null;
  }
  const quality = canonicalQuality(params.quality);
  const sizeHuman = size.size_human;
  const meta = await resolvePosterAndBackdrop(params, resolved, rawMediaId);
  const row = {
    cache_key: buildCacheKey({ ...params, language, quality }),
    media_id: mediaId,
    media_title: String(params.title || resolved.title || "").trim(),
    year: params.year == null ? null : String(params.year),
    language,
    quality,
    source_type: embed ? "embed_stream" : "ddl",
    download_url: storedUrl,
    stream_url: embed ? resolved.stream_url || storedUrl : storedUrl,
    magnet_link: /^magnet:/i.test(String(resolved.magnet_link || "")) ? resolved.magnet_link : null,
    seeders: Number.isFinite(Number(resolved.seeders)) ? Number(resolved.seeders) : null,
    size_human: sizeHuman || null,
    size_bytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : null,
    is_fallback: Boolean(resolved.is_fallback),
    status: "ready",
    updated_at: new Date().toISOString(),
    payload: {
      provider: resolved.provider || null,
      title: resolved.title || params.title || null,
      imdb_id: params.imdbId || null,
      stream_url: resolved.stream_url || null,
      language_label: resolved.language_label || resolved.language || language,
      primary: Boolean(resolved.primary),
      size_human: sizeHuman || null,
      size_bytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : null,
      alternates: resolved.alternates || [],
      resolvedAt: new Date().toISOString(),
      overview: meta.overview,
      poster_url: meta.posterUrl,
      series_poster_url: meta.posterUrl,
      still_url: params.stillUrl || params.still_url || null,
      backdrop_url: meta.backdropUrl,
      rating: meta.rating,
      tmdb_id: rawMediaId || null,
      ...(isEp ? { season: s, episode: e } : {}),
    },
  };

  try {
    const supabase = getSupabaseClient();
    const onConflict = mediaId ? "media_id,quality,language" : "cache_key";
    let { data, error } = await supabase.from(MEDIA_SOURCES_TABLE).upsert(row, { onConflict }).select("*").maybeSingle();
    if (error && /size_human|size_bytes/i.test(error.message || "")) {
      const withoutSize = { ...row };
      delete withoutSize.size_human;
      delete withoutSize.size_bytes;
      ({ data, error } = await supabase.from(MEDIA_SOURCES_TABLE).upsert(withoutSize, { onConflict }).select("*").maybeSingle());
    }
    if (error) throw toFriendlySupabaseError(error, "upsert media_sources");
    return mapSourceRow(data) || { ...resolved, download_url: storedUrl, cached: true, status: "ready" };
  } catch (error) {
    console.warn("[media-sources] cache write skipped:", error.message);
    return { ...resolved, download_url: storedUrl, cached: false, status: "ready" };
  }
}

async function lookupSourceSize({ mediaId, downloadUrl, magnetLink } = {}) {
  const magnet = /^magnet:/i.test(String(magnetLink || ""))
    ? String(magnetLink)
    : /^magnet:/i.test(String(downloadUrl || ""))
      ? String(downloadUrl)
      : "";
  const url = String(downloadUrl || "").trim();
  const id = mediaId == null ? "" : String(mediaId).trim();
  if (!magnet && !url && !id) return { size_bytes: null, size_human: null, size: null };

  const selectCols = "size_bytes, size_human, payload, download_url, magnet_link, media_title";
  try {
    const supabase = getSupabaseClient();
    const attempts = [];
    if (magnet) {
      attempts.push(() => supabase.from(MEDIA_SOURCES_TABLE).select(selectCols).eq("magnet_link", magnet).limit(5));
      attempts.push(() => supabase.from(MEDIA_SOURCES_TABLE).select(selectCols).eq("download_url", magnet).limit(5));
    }
    if (url && url !== magnet) {
      attempts.push(() => supabase.from(MEDIA_SOURCES_TABLE).select(selectCols).eq("download_url", url).limit(5));
      attempts.push(() => supabase.from(MEDIA_SOURCES_TABLE).select(selectCols).eq("magnet_link", url).limit(5));
    }
    if (id) {
      attempts.push(() =>
        supabase
          .from(MEDIA_SOURCES_TABLE)
          .select(selectCols)
          .eq("media_id", id)
          .order("updated_at", { ascending: false })
          .limit(10)
      );
    }

    for (const run of attempts) {
      const { data, error } = await run();
      if (error || !data?.length) continue;
      for (const row of data) {
        const size = publicSize(row);
        if (size.size_bytes) return size;
      }
    }
  } catch (error) {
    console.warn("[download-requests] size lookup skipped:", error.message);
  }
  return { size_bytes: null, size_human: null, size: null };
}

async function enqueueDownloadRequest() {
  return { id: null, status: "ready" };
}

async function completeDownloadRequest() {
  return null;
}

async function listCachedSources({ mediaId, title, language, quality, limit = 50, season, episode } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const s = Number(season);
  const e = Number(episode);
  const isEp = Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0;
  try {
    const supabase = getSupabaseClient();
    let query = supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(pageSize);

    if (mediaId != null && String(mediaId).trim()) {
      const rawId = String(mediaId).trim();
      if (isEp) {
        const epScoped = scopedMediaId(rawId, s, e);
        query = query.in("media_id", [epScoped, rawId]);
      } else {
        query = query.eq("media_id", rawId);
      }
    }
    if (title && String(title).trim()) {
      query = query.ilike("media_title", `%${String(title).trim()}%`);
    }
    if (language && String(language).trim() && canonicalLanguage(language) !== "All") {
      query = query.ilike("language", canonicalLanguage(language));
    }
    if (quality && String(quality).trim() && canonicalQuality(quality) !== "All") {
      query = query.ilike("quality", canonicalQuality(quality));
    }

    const { data, error } = await query;
    if (error) throw toFriendlySupabaseError(error, "list media_sources");
    const rows = (Array.isArray(data) ? data : []).map(mapSourceRow).filter(Boolean);
    if (isEp && mediaId != null) {
      const epScoped = scopedMediaId(mediaId, s, e);
      rows.sort((a, b) => (a.mediaId === epScoped ? -1 : b.mediaId === epScoped ? 1 : 0));
    }
    return rows;
  } catch (error) {
    if (error?.status) throw error;
    console.warn("[media-sources] list skipped:", error.message);
    return [];
  }
}

const CATALOG_LANGUAGES = [
  "Hindi",
  "hindi",
  "Dual Audio [Hindi+Eng]",
  "dual audio [hindi+eng]",
  "dual audio",
  "Dual Audio",
  "English",
  "english",
  "Hindi / Dual Audio",
  "hindi / dual audio",
  "Urdu",
  "urdu",
  "Turkish",
  "turkish",
  "Turkish / Urdu",
  "Turkish [Eng Subs]",
];

function catalogLanguage(language) {
  const text = String(language || "").trim().toLowerCase();
  if (text.includes("turkish") || text.includes("turk")) return "Turkish / Urdu";
  if (text === "urdu") return "Urdu";
  if (text.includes("dual")) return "Dual Audio [Hindi+Eng]";
  if (text === "english" || text === "en") return "English";
  if (text === "hindi" || text === "hi") return "Hindi";
  return "";
}

function isDownloadUrl(value) {
  const text = String(value || "").trim();
  return /^magnet:\?/i.test(text) || /^https?:\/\//i.test(text);
}

/** Titles that have a real Hindi, Dual Audio, English, or Urdu download. Embeds are excluded. */
async function listPlayableCatalog(options = {}) {
  const { mediaType = "", page = 1, limit = 24 } = options;
  const supabase = getSupabaseClient();
  let { data, error } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("media_id, media_title, year, language, quality, source_type, download_url, magnet_link, payload, size_bytes, size_human, updated_at")
    .in("source_type", ["torrent", "ddl"])
    .in("language", CATALOG_LANGUAGES)
    .eq("status", "ready")
    .not("download_url", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error && /size_bytes|size_human/i.test(error.message || "")) {
    ({ data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("media_id, media_title, year, language, quality, source_type, download_url, magnet_link, payload, updated_at")
      .in("source_type", ["torrent", "ddl"])
      .in("language", CATALOG_LANGUAGES)
      .eq("status", "ready")
      .not("download_url", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1000));
  }
  if (error) throw toFriendlySupabaseError(error, "list playable catalog");

  const grouped = new Map();
  for (const row of data || []) {
    const language = catalogLanguage(row.language);
    const rawMediaId = String(row.media_id || "").trim();
    if (!language || !rawMediaId || !isDownloadUrl(row.download_url)) continue;

    // Group episodes of a series under the base show ID (e.g. "99966-s01e01" -> "99966")
    const baseId = rawMediaId.replace(/-s\d+e\d+/i, "").split(":")[0];
    const showTitle = String(row.media_title || "").replace(/\s*-\s*s\d+e\d+.*$/i, "").trim();

    const isEpisode = /-s\d+e\d+/i.test(rawMediaId);
    const seriesPoster = row.payload?.series_poster_url || (!isEpisode ? row.payload?.poster_url : null);
    if (!grouped.has(baseId)) {
      grouped.set(baseId, {
        media_id: baseId,
        title: showTitle || row.media_title,
        year: row.year || "",
        languages: new Set(),
        qualities: new Set(),
        size_bytes: null,
        size_human: null,
        size: null,
        payload_poster: seriesPoster || null,
        payload_backdrop: row.payload?.backdrop_url || null,
        payload_overview: row.payload?.overview || null,
        payload_rating: row.payload?.rating || null,
      });
    }
    const card = grouped.get(baseId);
    if (!card.payload_poster && seriesPoster) card.payload_poster = seriesPoster;
    if (!card.payload_backdrop && row.payload?.backdrop_url) card.payload_backdrop = row.payload.backdrop_url;
    if (!card.payload_overview && row.payload?.overview) card.payload_overview = row.payload.overview;
    if (card.payload_rating == null && row.payload?.rating != null) card.payload_rating = row.payload.rating;
    card.languages.add(language);
    if (row.quality && row.quality !== "all") card.qualities.add(row.quality);
    const size = publicSize(row);
    if (size.size_bytes && (!card.size_bytes || size.size_bytes > card.size_bytes)) {
      card.size_bytes = size.size_bytes;
      card.size_human = size.size_human;
      card.size = size.size;
    }
  }

  const ids = [...grouped.keys()]
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const contentById = new Map();
  for (let index = 0; index < ids.length; index += 150) {
    const chunk = ids.slice(index, index + 150);
    const { data: content, error: contentError } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("external_id, title, media_type, details")
      .in("external_id", chunk);
    if (contentError) throw toFriendlySupabaseError(contentError, "join media_content");
    for (const row of content || []) contentById.set(String(row.external_id), row);
  }

  let items = [...grouped.values()].map((card) => {
    const content = contentById.get(String(card.media_id));
    const details = content?.details || {};
    const genres = Array.isArray(details.genres) ? details.genres.map((g) => (typeof g === "string" ? g : g?.name || "")).filter(Boolean) : [];
    return {
      media_id: card.media_id,
      title: content?.title || card.title,
      year: String(details.year || card.year || ""),
      media_type: content?.media_type || "",
      poster: details.poster || details.poster_url || card.payload_poster || null,
      backdrop: details.backdrop || details.backdrop_url || card.payload_backdrop || null,
      overview: details.overview || details.description || card.payload_overview || "",
      rating_percent: details.rating_percent || (details.vote_average ? Math.round(Number(details.vote_average) * 10) : card.payload_rating || null),
      genres,
      languages: [...card.languages],
      qualities: [...card.qualities],
      size_bytes: card.size_bytes,
      size_human: card.size_human,
      size: card.size,
    };
  });

  if (mediaType === "movie" || mediaType === "tv" || mediaType === "series") {
    const targetType = mediaType === "series" ? "tv" : mediaType;
    items = items.filter((item) => item.media_type === mediaType || item.media_type === targetType);
  }

  // Genre & User Interests Filter (e.g. Action, Sci-Fi, Animation, Drama, Korean, Comedy)
  if (options.genre || options.genres || options.interest) {
    const rawFilter = String(options.genre || options.genres || options.interest || "");
    const requestedGenres = rawFilter.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);

    if (requestedGenres.length > 0) {
      items = items.filter((item) => {
        const itemGenres = item.genres.map((g) => g.toLowerCase());
        const itemTitle = (item.title || "").toLowerCase();
        const itemOverview = (item.overview || "").toLowerCase();

        return requestedGenres.some((reqG) =>
          itemGenres.some((ig) => ig.includes(reqG) || reqG.includes(ig)) ||
          itemTitle.includes(reqG) ||
          itemOverview.includes(reqG)
        );
      });
    }
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 24), 50);
  const total = items.length;
  const from = (safePage - 1) * safeLimit;
  return {
    items: items.slice(from, from + safeLimit),
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.max(1, Math.ceil(total / safeLimit) || 1),
  };
}

async function findCachedTorrent({ mediaId, imdbId, title, language, quality, mediaType, season, episode } = {}) {
  const s = Number(season);
  const e = Number(episode);
  const isEp = Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0;
  const rawIds = [...new Set([mediaId, imdbId].map((value) => String(value || "").trim()).filter(Boolean))];
  const ids = isEp ? rawIds.map((id) => scopedMediaId(id, s, e)) : rawIds;
  const name = String(title || "").trim();
  if (!ids.length && !name) return null;
  const expectedCacheKey = buildCacheKey({ mediaId, imdbId, title, language, quality, season, episode });

  try {
    const supabase = getSupabaseClient();
    let query = supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("*")
      .eq("source_type", "torrent")
      .eq("status", "ready")
      .order("updated_at", { ascending: false })
      .limit(25);
    if (isEp) {
      query = ids.length ? query.in("media_id", ids) : query.eq("cache_key", expectedCacheKey);
    } else {
      query = ids.length ? query.in("media_id", ids) : query.ilike("media_title", name.replace(/[\\%_]/g, "\\$&"));
    }
    const { data, error } = await query;
    if (error) return null;
    const wantedLanguage = canonicalLanguage(language);
    const wantedQuality = canonicalQuality(quality);
    const matches = [];
    for (const row of data || []) {
      if (isEp) {
        const matchesEp =
          row.cache_key === expectedCacheKey ||
          (Number(row.payload?.season) === s && Number(row.payload?.episode) === e) ||
          (row.media_id && row.media_id.endsWith(`:s${s}:e${e}`));
        if (!matchesEp) continue;
      } else {
        if (row.payload?.episode || /::e\d+::/i.test(row.cache_key || "") || /:s\d+:e\d+/i.test(row.media_id || "")) continue;
      }
      const magnet = /^magnet:/i.test(String(row.magnet_link || ""))
        ? row.magnet_link
        : /^magnet:/i.test(String(row.download_url || ""))
          ? row.download_url
          : "";
      if (!magnet) continue;
      const size = publicSize({
        ...row,
        size_bytes: row.size_bytes ?? row.payload?.size_bytes,
        size_human: row.size_human || row.payload?.size_human,
        title: row.payload?.title || row.media_title,
        magnet_link: magnet,
      });
      const accepted = acceptTorrentRelease({
        title: row.payload?.title || row.media_title,
        sizeBytes: size.size_bytes,
        size: size.size_human,
        quality: row.quality,
        mediaType,
        metadata: row.payload?.title || row.media_title,
      });
      if (!accepted.ok) continue;
      const languageLabel = row.payload?.language_label || row.language;
      matches.push({
        source_type: "torrent",
        status: "ready",
        cached: true,
        ...magnetWrite(magnet),
        stream_url: null,
        quality: accepted.quality,
        language: languageLabel,
        language_label: languageLabel,
        seeders: row.seeders == null ? 0 : Number(row.seeders),
        size_bytes: accepted.size_bytes,
        size_human: accepted.size_human,
        size: accepted.size_human,
        title: row.media_title,
        mediaId: row.media_id,
        languageScore: canonicalLanguage(languageLabel) === wantedLanguage ? 2 : 0,
        qualityScore: canonicalQuality(accepted.quality) === wantedQuality ? 1 : 0,
      });
    }
    matches.sort((a, b) => b.languageScore + b.qualityScore - (a.languageScore + a.qualityScore));
    return matches[0] || null;
  } catch (error) {
    console.warn("[media-sources] torrent cache lookup skipped:", error.message);
    return null;
  }
}

async function saveTorrentRelease(params, release) {
  const s = Number(params?.season);
  const e = Number(params?.episode);
  const isEp = Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0;
  const magnet = String(release?.magnet_link || release?.download_url || "").trim();
  const written = magnetWrite(magnet, params?.baseUrl || params?.req || null, isEp ? e : null);
  if (!written) return null;
  let hinted = publicSize({ ...release, magnet_link: magnet });
  if (!hinted.size_bytes) hinted = await lookupReleaseBytes({ ...release, magnet_link: magnet });
  const accepted = acceptTorrentRelease({
    title: release.title || params.title,
    sizeBytes: hinted.size_bytes,
    size: hinted.size_human,
    quality: release.quality || params?.quality,
    mediaType: params.mediaType,
    metadata: release.title || params.title,
    seeders: release.seeders ?? release.seeds ?? 5,
    allowCamPrint: Boolean(params.allowCamPrint),
  });
  if (!accepted.ok) return null;
  const size = publicSize({ ...release, ...accepted, magnet_link: magnet });
  const rawMediaId = params.mediaId == null || String(params.mediaId).trim() === "" ? null : String(params.mediaId).trim();
  const mediaId = scopedMediaId(rawMediaId, s, e);
  const language = canonicalLanguage(release.language_label || release.language || params.language || "Hindi");
  const isDubOrDesi = language === "Hindi" || language === "Urdu" || language === "Dual Audio [Hindi+Eng]" || language === "Hindi / Dual Audio" || language === "Turkish / Urdu" || language === "Turkish";
  if (!isDubOrDesi && !params.allowEnglish) {
    console.log(`[media-sources] Skipping save for non-dubbed release "${release.title || params.title}" (${language})`);
    return null;
  }
  const meta = await resolvePosterAndBackdrop(params, release, rawMediaId);
  const row = {
    cache_key: buildCacheKey({ ...params, language, quality: accepted.quality }),
    media_id: mediaId,
    media_title: String(params.title || release.title || "").trim(),
    year: params.year == null ? null : String(params.year),
    language,
    quality: accepted.quality,
    source_type: written.source_type,
    download_url: written.download_url,
    stream_url: written.stream_url,
    magnet_link: written.magnet_link,
    seeders: Number.isFinite(Number(release.seeders)) ? Number(release.seeders) : null,
    size_human: size.size_human,
    size_bytes: size.size_bytes,
    is_fallback: false,
    status: "ready",
    updated_at: new Date().toISOString(),
    payload: {
      provider: release.provider || null,
      title: release.title || params.title || null,
      language_label: language,
      size_human: size.size_human,
      size_bytes: size.size_bytes,
      primary: Boolean(release.primary),
      resolvedAt: new Date().toISOString(),
      overview: meta.overview,
      poster_url: params.seriesPosterUrl || params.series_poster_url || meta.posterUrl,
      series_poster_url: params.seriesPosterUrl || params.series_poster_url || meta.posterUrl,
      still_url: params.stillUrl || params.still_url || null,
      backdrop_url: meta.backdropUrl,
      rating: meta.rating,
      tmdb_id: rawMediaId || null,
      ...(isEp ? { season: s, episode: e } : {}),
      // Multi-film packs (MCU collection ...): the file inside the torrent that is this film.
      ...(release.file_name ? { file_name: release.file_name, file_idx: release.file_idx ?? null } : {}),
      // The film's own language: a Hindi-original release is Hindi without saying so.
      ...(params.originalLanguage ? { original_language: params.originalLanguage } : {}),
    },
  };
  try {
    const supabase = getSupabaseClient();
    const onConflict = mediaId ? "media_id,quality,language" : "cache_key";
    let { error } = await supabase.from(MEDIA_SOURCES_TABLE).upsert(row, { onConflict });
    if (error && /size_human|size_bytes/i.test(error.message || "")) {
      const withoutSize = { ...row };
      delete withoutSize.size_human;
      delete withoutSize.size_bytes;
      ({ error } = await supabase.from(MEDIA_SOURCES_TABLE).upsert(withoutSize, { onConflict }));
    }
    if (error) throw error;
  } catch (error) {
    console.warn("[media-sources] torrent cache write skipped:", error.message);
  }
  return {
    ...release,
    quality: accepted.quality,
    size_bytes: size.size_bytes,
    size_human: size.size_human,
    size: size.size,
    ...written,
    language,
    language_label: language,
  };
}

module.exports = {
  buildCacheKey,
  canonicalLanguage,
  canonicalQuality,
  findCachedSource,
  findReadyDownload,
  findCachedTorrent,
  saveTorrentRelease,
  isUnreleasedTitle,
  loadReleaseFacts,
  saveCachedSource,
  listCachedSources,
  listPlayableCatalog,
  enqueueDownloadRequest,
  completeDownloadRequest,
  lookupSourceSize,
  mapSourceRow,
};
