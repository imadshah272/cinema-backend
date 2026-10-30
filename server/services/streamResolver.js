"use strict";

/**
 * Multi-source download resolver.
 *
 * Primary: public torrent indexers (YTS / 1337x / torrent-search-api wrappers,
 *          plus optional TORRENT_INDEXER_ENDPOINTS).
 * Secondary: env-driven DDL / fast-direct APIs, then Internet Archive.
 * Last resort: embed fallback. A download_requests row is written only when the
 * caller did not set skipQueue, and that caller must close it off pending.
 */

const axios = require("axios");
const TorrentSearchApi = require("torrent-search-api");
const env = require("../config/env");
const { enqueueDownloadRequest, findCachedSource } = require("./mediaSourceService");
const { acceptTorrentRelease, magnetWrite } = require("./torrentResolver");
const { hindiAudioKind } = require("./releaseAudio");
const {
  MIN_VIDEO_BYTES,
  isTorrentArtifactUrl,
  isVideoFileUrl,
  isVideoFilename,
  isTrailerName,
  isFullVideoSize,
  isReadyVideoFile,
  fileExtension,
  contentTypeForExtension,
  videoMagicOk,
  minVideoBytes,
} = require("./videoFile");
const SearchFilters = require("../../src/searchFilters");
const {
  initTorrentProviders,
  fetchTorrentSearch,
  parseTorrentReleaseMeta,
} = require("../../src/torrentSearch");

const MIN_SEEDERS = Math.max(1, Number(env.streamMinSeeders) || 3);
const REGIONAL_MIN_SEEDERS = 2;
const REQUEST_TIMEOUT_MS = Math.max(2000, Number(env.streamResolverTimeoutMs) || 8000);
const TORRENT_SEARCH_BUDGET_MS = Math.min(8000, REQUEST_TIMEOUT_MS);

function safeDelay(ms, fallback = 100) {
  const value = Number(ms);
  const fallbackValue = Number(fallback);
  const base = Number.isFinite(value) && value > 0 ? value : Number.isFinite(fallbackValue) ? fallbackValue : 100;
  return Math.max(100, Math.floor(base));
}

let providersReady = false;

function ensureTorrentProviders() {
  if (providersReady) return;
  try {
    initTorrentProviders();
  } catch (error) {
    console.warn("[stream-resolver] indexer init skipped:", error.message);
  }
  providersReady = true;
}

function parseEndpointList(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      return (Array.isArray(parsed) ? parsed : []).map((item) => String(item || "").trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item));
}

function isHindiLanguage(language) {
  const lang = String(language || "").trim().toLowerCase();
  if (!lang || lang === "all" || lang === "english" || lang === "en") return false;
  return /\bhindi\b|\bhi\b|\burdu\b|\bdual\b|\bdubbed\b/.test(lang);
}

function normalizeLanguage(language) {
  if (isHindiLanguage(language)) return "hindi";
  const lang = String(language || "all").trim().toLowerCase();
  return lang || "all";
}

function normalizeQuality(quality) {
  const q = String(quality || "all").trim().toLowerCase();
  if (q === "4k" || q === "uhd") return "2160p";
  return q || "all";
}

function releaseYear(year) {
  return String(year || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function joinQuery(parts) {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function cleanReleaseTitle(title) {
  return String(title || "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Phase 1. High-yield Hindi / Dual Audio / Urdu phrases, with no year brackets. */
function buildRegionalQueries(title) {
  const name = cleanReleaseTitle(title);
  if (!name) return [];
  return [
    `${name} Hindi`,
    `${name} Dual Audio`,
    `${name} Dubbed Hindi`,
    `${name} Urdu`,
    `${name} Hindi clean`,
  ];
}

function seedFloorFor(language) {
  return isHindiLanguage(language) ? REGIONAL_MIN_SEEDERS : MIN_SEEDERS;
}

/**
 * Hindi / Urdu / Dual Audio always uses the regional phrase list.
 * English stays a single title + year + quality query and runs only after regional misses.
 */
function buildTorrentQueries(title, year, language, quality) {
  const cleanTitle = cleanReleaseTitle(title);
  if (!cleanTitle) return [];
  if (isHindiLanguage(language)) return buildRegionalQueries(cleanTitle);

  const yr = releaseYear(year);
  const qualityQuery = SearchFilters.qualityQueryFor(quality);
  return [joinQuery([cleanTitle, yr, qualityQuery])];
}

function buildTorrentQuery(title, year, language, quality) {
  return buildTorrentQueries(title, year, language, quality)[0] || "";
}

function parseEpisodeQuery(title, options = {}) {
  const seasonOpt = Number(options.season);
  if (Number.isInteger(seasonOpt) && seasonOpt > 0) {
    const episodeOpt = Number(options.episode);
    return { season: seasonOpt, episode: Number.isInteger(episodeOpt) && episodeOpt > 0 ? episodeOpt : null };
  }
  const match = /\bS(\d{1,2})\s*E(\d{1,2})\b/i.exec(String(title || ""));
  if (!match) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

function stripEpisodeCode(title) {
  return String(title || "")
    .replace(/\bS\d{1,2}\s*E\d{1,2}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Season-pack phrases used when a single episode has no healthy seeders. */
function buildSeasonPackQueries(title, season, language) {
  const show = stripEpisodeCode(title);
  const padded = String(season).padStart(2, "0");
  if (isHindiLanguage(language)) {
    return [...new Set([
      `${show} Season ${season} Dual Audio`,
      `${show} S${padded} Complete`,
      `${show} S${padded} Dual Audio Hindi`,
    ])];
  }
  return [...new Set([`${show} Season ${season}`, `${show} S${padded} Complete`])];
}

/** True only for an HTTPS mp4/mkv/webm file. Magnets and .torrent URLs are not the movie. */
function isDirectMediaUrl(url) {
  return isVideoFileUrl(url);
}

function archiveVideoUrl(identifier, filename) {
  const id = encodeURIComponent(String(identifier || "").trim());
  const file = String(filename || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  if (!id || !file || !isVideoFilename(file)) return "";
  return `https://archive.org/download/${id}/${file}`;
}

function pickArchiveVideoName(files, quality) {
  const wanted = normalizeQuality(quality);
  let videos = (Array.isArray(files) ? files : [])
    .map((file) => (typeof file === "string" ? { name: file } : file))
    .filter((file) => isVideoFilename(file?.name) && !isTrailerName(file?.name))
    .filter((file) => {
      const bytes = Number(file.size || file.length || 0);
      if (!Number.isFinite(bytes) || bytes < 1024) return true;
      return bytes >= MIN_VIDEO_BYTES;
    });
  if (wanted && wanted !== "all") {
    const matched = videos.filter((file) => String(file.name).toLowerCase().includes(wanted));
    if (!matched.length) return "";
    videos = matched;
  }
  if (!videos.length) return "";
  videos.sort((a, b) => Number(b.size || b.length || 0) - Number(a.size || a.length || 0));
  return videos[0].name;
}

function toTorrentCandidate(item) {
  const title = String(item?.title || "").trim();
  if (!title) return null;
  const meta = parseTorrentReleaseMeta(title);
  const seeds = Number(item.seeds ?? item.seeders ?? item.seed ?? 0) || 0;
  return {
    title,
    seeds,
    magnet: item.magnet || item.magnet_link || item.magnetLink || "",
    link: item.link || item.desc || item.url || item.download_url || "",
    provider: item.provider || item.source || "indexer",
    quality: item.quality || meta.quality,
    language_tags: item.language_tags || item.languageTags || meta.languageTags,
    language: item.language || "",
    size: item.size || item.size_human || "",
    size_bytes: item.size_bytes || item.sizeBytes || null,
  };
}

function pickHealthyTorrent(items, language, quality) {
  const mapped = (Array.isArray(items) ? items : []).map(toTorrentCandidate).filter(Boolean);
  if (normalizeLanguage(language) === "hindi") {
    for (const item of mapped) {
      if (/multi[ ._-]?audio/i.test(item.title) && !item.language_tags.includes("hindi")) {
        item.language_tags = [...item.language_tags, "hindi"];
      }
    }
  }
  const matched = SearchFilters.strictFilterTorrents(mapped, {
    language: normalizeLanguage(language),
    quality: normalizeQuality(quality),
  });
  const floor = seedFloorFor(language);
  const pool = matched.filter((item) => {
    if (item.seeds < floor) return false;
    const accepted = acceptTorrentRelease({
      title: item.title,
      sizeBytes: item.size_bytes,
      size: item.size,
      quality: item.quality,
      mediaType: item.media_type,
      metadata: item.title,
    });
    if (!accepted.ok) return false;
    item.quality = accepted.quality;
    item.size_bytes = accepted.size_bytes;
    item.size = accepted.size_human;
    return true;
  });
  pool.sort((a, b) => b.seeds - a.seeds);
  return pool[0] || null;
}

function withTimeout(promise, ms, fallback = null) {
  const delay = safeDelay(ms);
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), delay)),
  ]);
}

function parseSize(...candidates) {
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return { size_bytes: Math.round(raw), size_human: formatBytes(raw) };
    }
    const match = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(String(raw));
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = match[2].toUpperCase();
    const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit];
    const size_bytes = Math.round(amount * multiplier);
    const pretty = Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 10) / 10);
    return { size_bytes, size_human: `${pretty} ${unit}` };
  }
  return { size_bytes: null, size_human: "" };
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function describeRelease(item, requestedLanguage, requestedQuality) {
  const meta = parseTorrentReleaseMeta(item?.title || "");
  const fromItem = String(item?.quality || "").toLowerCase();
  const detected = ["2160p", "1080p", "720p", "480p"].includes(fromItem)
    ? fromItem
    : meta.quality;
  const quality = ["2160p", "1080p", "720p", "480p"].includes(detected)
    ? detected
    : normalizeQuality(requestedQuality || "1080p");
  const text = `${item?.title || ""} ${(item?.language_tags || []).join(" ")}`;
  const tags = item?.language_tags || meta.languageTags || [];
  const urdu = tags.includes("urdu") || (/\burdu\b/i.test(text) && !/\bhindi\b/i.test(text));
  // "DUAL" alone is usually Portuguese/Spanish + English, and bare "DUBBED" is an English dub.
  // Dual Audio [Hindi+Eng] needs Hindi named in the release itself.
  const dual = hindiAudioKind(item?.title || "") === "dual";
  const hindi =
    tags.includes("hindi") ||
    /\bhindi\b|\bhin\b|\bdesi\b|hq-hindi|hindi\s*5\.1|org\s*2ch/i.test(text);
  let language = "English";
  if (dual) language = "Dual Audio [Hindi+Eng]";
  else if (urdu) language = "Urdu";
  else if (hindi) language = "Hindi";
  const size = parseSize(item?.size_bytes, item?.size, item?.size_human);
  return {
    quality,
    ...size,
    language,
    seeders: Number(item?.seeds ?? item?.seeders) || 0,
  };
}

async function resolveMagnet(item, timeoutMs = 400) {
  if (item?.magnet && /^magnet:/i.test(item.magnet)) return item.magnet;
  if (!item) return "";
  const delay = safeDelay(timeoutMs, 400);
  try {
    const magnet = await withTimeout(TorrentSearchApi.getMagnet(item), delay, "");
    return typeof magnet === "string" && magnet ? magnet : item.magnet || "";
  } catch {
    return item.magnet || "";
  }
}

async function queryPrimaryIndexers(queries) {
  ensureTorrentProviders();
  const list = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q || "").trim()).filter(Boolean);
  const results = [];

  const batches = await Promise.all(
    list.map((query) =>
      withTimeout(
        fetchTorrentSearch(query, { maxTitles: 4, timeoutMs: REQUEST_TIMEOUT_MS }),
        REQUEST_TIMEOUT_MS,
        []
      )
    )
  );
  for (const local of batches) {
    if (Array.isArray(local)) results.push(...local);
  }

  const endpoints = parseEndpointList(env.torrentIndexerEndpoints);
  for (const url of endpoints) {
    for (const query of list) {
      try {
        const { data } = await axios({
          method: "GET",
          url,
          timeout: REQUEST_TIMEOUT_MS,
          headers: env.torrentIndexerApiKey
            ? { Authorization: `Bearer ${env.torrentIndexerApiKey}` }
            : {},
          params: { q: query, query },
        });
        const rows = Array.isArray(data)
          ? data
          : data?.results || data?.items || data?.torrents || [];
        results.push(...rows);
      } catch (error) {
        console.warn("[stream-resolver] indexer endpoint failed:", url, query, error.message);
      }
    }
  }

  return results;
}

function collectCandidateUrls(payload, urls, depth) {
  if (!payload || depth > 4) return;
  if (typeof payload === "string") {
    urls.push(payload);
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((entry) => collectCandidateUrls(entry, urls, depth + 1));
    return;
  }
  if (typeof payload !== "object") return;
  for (const key of ["download_url", "url", "stream_url", "fast_url", "link", "href", "file", "filename"]) {
    if (payload[key] != null) collectCandidateUrls(payload[key], urls, depth + 1);
  }
  for (const key of ["result", "data", "links", "mirrors", "files"]) {
    if (payload[key] != null) collectCandidateUrls(payload[key], urls, depth + 1);
  }
}

function extractDdlUrl(payload) {
  const urls = [];
  collectCandidateUrls(payload, urls, 0);
  const direct = urls.find((url) => isDirectMediaUrl(url) && !isTrailerName(url));
  if (!direct && urls.length) {
    console.warn("[stream-resolver] DDL payload had no direct mp4/mkv/webm file:", urls.slice(0, 3).join(" | "));
  }
  return direct || "";
}

const PROBE_BYTES = 2 * 1024 * 1024;

function rangeTotal(header) {
  const match = /\/(\d+)\s*$/.exec(String(header || ""));
  return match ? Number(match[1]) : NaN;
}

/**
 * HEAD plus a short start read and a short end read.
 * Rejects trailers, short files, wrong Content-Type, and a size that
 * does not match Content-Length. Does not download the movie.
 */
async function confirmFullMovie(source, { mediaType } = {}) {
  const url = String(source?.download_url || source?.stream_url || "").trim();
  if (!isVideoFileUrl(url)) return null;
  const ext = fileExtension(url);
  const floor = minVideoBytes(mediaType);
  const claimed = Number(source?.size_bytes);
  try {
    const head = await axios({
      method: "HEAD",
      url,
      timeout: 8000,
      maxRedirects: 2,
      validateStatus: (status) => status === 200,
    });
    const finalUrl = head.request?.res?.responseUrl || url;
    if (!isVideoFileUrl(finalUrl)) return null;
    if (!contentTypeForExtension(ext, head.headers["content-type"])) return null;
    const length = Number(head.headers["content-length"]);
    if (!Number.isFinite(length) || length < floor) return null;
    if (Number.isFinite(claimed) && claimed > 0 && claimed !== length) return null;
    const ranges = String(head.headers["accept-ranges"] || "").toLowerCase();

    const startEnd = Math.min(PROBE_BYTES, length) - 1;
    const start = await axios({
      method: "GET",
      url,
      timeout: 8000,
      maxRedirects: 2,
      responseType: "arraybuffer",
      maxContentLength: PROBE_BYTES + 65536,
      maxBodyLength: PROBE_BYTES + 65536,
      headers: { Range: `bytes=0-${startEnd}` },
      validateStatus: (status) => status === 206 || status === 200,
    });
    if (ranges.indexOf("bytes") === -1 && start.status !== 206) return null;
    const startTotal = rangeTotal(start.headers["content-range"]);
    if (Number.isFinite(startTotal) && startTotal !== length) return null;
    const startBuf = Buffer.from(start.data);
    if (!startBuf.length || !videoMagicOk(ext, startBuf)) return null;

    const tailFrom = Math.max(0, length - 1024);
    const tail = await axios({
      method: "GET",
      url,
      timeout: 8000,
      maxRedirects: 2,
      responseType: "arraybuffer",
      maxContentLength: 4096,
      maxBodyLength: 4096,
      headers: { Range: `bytes=${tailFrom}-${length - 1}` },
      validateStatus: (status) => status === 206,
    });
    const tailTotal = rangeTotal(tail.headers["content-range"]);
    if (tailTotal !== length) return null;
    if (!Buffer.from(tail.data).length) return null;

    const sizeHuman = formatBytes(length);
    return {
      ...source,
      source_type: "ddl",
      download_url: url,
      stream_url: url,
      size_bytes: length,
      size_human: sizeHuman,
      size: sizeHuman,
      status: "ready",
      probed: true,
      is_fallback: false,
    };
  } catch (error) {
    console.warn("[stream-resolver] full-movie probe failed:", error.message);
    return null;
  }
}

/** Keep a result only when the URL probes as the complete movie file. */
async function asDirectVideo(source, options = {}) {
  const url = String(source?.download_url || source?.stream_url || "").trim();
  if (!isVideoFileUrl(url)) return null;
  let bytes = Number(source?.size_bytes);
  if (!isFullVideoSize(bytes, options.mediaType)) {
    const parsed = Number(parseSize(source?.size, source?.size_human).size_bytes);
    bytes = isFullVideoSize(parsed, options.mediaType) ? parsed : NaN;
  }
  if (Number.isFinite(bytes) && bytes > 0 && !isFullVideoSize(bytes, options.mediaType)) return null;
  return confirmFullMovie(
    {
      ...source,
      download_url: url,
      stream_url: url,
      size_bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null,
    },
    options
  );
}

async function queryDdlProviders({ title, year, language, quality, query, tmdbId, imdbId, mediaType }) {
  const endpoints = parseEndpointList(env.ddlFallbackEndpoints);
  if (!endpoints.length) {
    console.log("[stream-resolver] STREAM_DDL_ENDPOINTS is empty — skipping cloud DDL providers");
  }
  for (const url of endpoints) {
    try {
      const { data } = await axios({
        method: "POST",
        url,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          ...(env.ddlFallbackApiKey ? { Authorization: `Bearer ${env.ddlFallbackApiKey}` } : {}),
        },
        data: {
          title,
          year,
          language,
          quality,
          query,
          tmdb_id: tmdbId || null,
          imdb_id: imdbId || null,
        },
      });
      const downloadUrl = extractDdlUrl(data);
      const sized = await asDirectVideo({
        source_type: "ddl",
        download_url: downloadUrl,
        stream_url: downloadUrl,
        resolution: normalizeQuality(quality),
        quality: normalizeQuality(quality),
        language: requestedLanguageLabel(language),
        language_label: requestedLanguageLabel(language),
        size_bytes: Number(data?.size_bytes) || null,
        size: data?.size || data?.size_human || "",
        is_fallback: false,
        provider: data?.provider || url,
      }, { mediaType });
      if (sized) {
        console.log("[stream-resolver] DDL file accepted:", sized.download_url);
        return sized;
      }
    } catch (error) {
      console.warn("[stream-resolver] DDL endpoint failed:", url, error.message);
    }
  }
  return null;
}

async function queryInternetArchive({ title, year, language, quality, mediaType }) {
  const q = [`"${String(title || "").trim()}"`, year, "mediatype:(movies OR moviesandfilms OR tv)"]
    .filter(Boolean)
    .join(" ");
  try {
    const { data } = await axios.get("https://archive.org/advancedsearch.php", {
      timeout: REQUEST_TIMEOUT_MS,
      params: {
        q,
        "fl[]": ["identifier", "title", "downloads"],
        "sort[]": "downloads desc",
        rows: 5,
        output: "json",
      },
    });
    const docs = data?.response?.docs || [];
    for (const doc of docs) {
      const identifier = doc?.identifier;
      if (!identifier) continue;
      const file = await resolveArchiveVideoFile(identifier, quality);
      if (!file?.url) {
        console.warn("[stream-resolver] Internet Archive item has no full mp4/mkv/webm:", identifier);
        continue;
      }
      const sized = await asDirectVideo({
        source_type: "ddl",
        download_url: file.url,
        stream_url: file.url,
        size_bytes: file.size_bytes,
        resolution: normalizeQuality(quality),
        quality: normalizeQuality(quality),
        language: requestedLanguageLabel(language),
        language_label: requestedLanguageLabel(language),
        is_fallback: false,
        provider: "internet-archive",
        title: doc.title || title,
      }, { mediaType });
      if (!sized) continue;
      const wanted = requestedLanguageLabel(language);
      const detected = describeRelease({ title: `${doc.title || ""} ${file.url}` }, wanted, quality).language;
      const regional = wanted === "Hindi" || wanted === "Urdu" || wanted === "Dual Audio [Hindi+Eng]";
      if (regional && detected !== wanted) continue;
      if (wanted === "English" && detected !== "English") continue;
      sized.language = detected === "English" && regional ? wanted : detected;
      sized.language_label = sized.language;
      console.log("[stream-resolver] Internet Archive file:", sized.download_url);
      return sized;
    }
    return null;
  } catch (error) {
    console.warn("[stream-resolver] Internet Archive lookup failed:", error.message);
    return null;
  }
}

async function resolveArchiveVideoFile(identifier, quality) {
  try {
    const { data } = await axios.get(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    const filename = pickArchiveVideoName(data?.files, quality);
    const match = (Array.isArray(data?.files) ? data.files : []).find((file) => file && file.name === filename);
    const sizeBytes = Number(match?.size || match?.length || 0);
    return {
      url: archiveVideoUrl(identifier, filename),
      size_bytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : null,
    };
  } catch (error) {
    console.warn("[stream-resolver] Internet Archive metadata failed:", identifier, error.message);
    return "";
  }
}

function buildEmbedUrl(provider, { imdbId, tmdbId, mediaType, season, episode } = {}) {
  const imdb = String(imdbId || "").trim();
  const tmdb = String(tmdbId || "").trim();
  const id = imdb || tmdb;
  if (!id) return "";
  const name = String(provider || "").trim().toLowerCase();
  const seasonNum = Number(season);
  const episodeNum = Number(episode);
  const isTv = mediaType === "tv" || (Number.isInteger(seasonNum) && seasonNum > 0);
  if (name === "vidlink") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return `https://vidlink.pro/tv/${encodeURIComponent(tmdb || id)}/${seasonNum}/${ep}?audio=hi&lang=hi`;
    }
    return `https://vidlink.pro/movie/${encodeURIComponent(tmdb || id)}?audio=hi&lang=hi`;
  }
  if (name === "autoembed") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return `https://player.autoembed.cc/embed/tv/${encodeURIComponent(tmdb || id)}/${seasonNum}/${ep}?audio=hi&lang=hi`;
    }
    return `https://player.autoembed.cc/embed/movie/${encodeURIComponent(tmdb || id)}?audio=hi&lang=hi`;
  }
  if (name === "vidsrc") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? `/${episodeNum}` : "";
      return `https://vidsrc.to/embed/tv/${encodeURIComponent(id)}/${seasonNum}${ep}?audio=hi&lang=hi`;
    }
    return `https://vidsrc.to/embed/movie/${encodeURIComponent(id)}?audio=hi&lang=hi`;
  }
  if (name === "2embed") {
    if (isTv && tmdb && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return `https://www.2embed.cc/embed/tmdb/tv?id=${encodeURIComponent(tmdb)}&s=${seasonNum}&e=${ep}&audio=hi`;
    }
    return `https://www.2embed.cc/embed/${encodeURIComponent(id)}?audio=hi`;
  }
  if (name === "multiembed") {
    return `https://multiembed.mov/?video_id=${encodeURIComponent(id)}&tmdb=${imdb ? 0 : 1}&audio=hindi`;
  }
  return "";
}

function embedProviderNames() {
  return String(env.fallbackEmbedProviders || "vidlink,autoembed,vidsrc,2embed,multiembed")
    .split(/[,\s]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function buildEmbedFallback({ imdbId, tmdbId, language, quality, mediaType, season, episode } = {}) {
  const names = embedProviderNames();
  const links = names
    .map((provider) => ({
      provider,
      stream_url: buildEmbedUrl(provider, { imdbId, tmdbId, mediaType, season, episode }),
    }))
    .filter((item) => item.stream_url);
  if (!links.length) return null;
  console.log(`[stream-resolver] embed fallback: ${links.map((item) => item.provider).join(", ")}`);
  return {
    source_type: "embed_stream",
    download_url: "",
    stream_url: links[0].stream_url,
    fallback_url: links[1]?.stream_url || "",
    resolution: normalizeQuality(quality),
    language: String(language || "all"),
    seeders: null,
    is_fallback: true,
    provider: links[0].provider,
    alternates: links.slice(1),
    status: "ready",
  };
}

async function lookupExternalIds({ title, year, tmdbId, imdbId, mediaType }) {
  let imdb = String(imdbId || "").trim();
  const tmdb = String(tmdbId || "").trim();

  if (!imdb && tmdb && env.tmdbApiKey) {
    try {
      const type = mediaType === "tv" ? "tv" : "movie";
      const { data } = await axios.get(`https://api.themoviedb.org/3/${type}/${encodeURIComponent(tmdb)}/external_ids`, {
        timeout: Math.max(100, REQUEST_TIMEOUT_MS),
        params: { api_key: env.tmdbApiKey },
      });
      imdb = data?.imdb_id || imdb;
    } catch (error) {
      console.warn("[stream-resolver] TMDb external id lookup failed:", error.message);
    }
  }

  if (!imdb && env.omdbApiKey && title) {
    try {
      const { data } = await axios.get("https://www.omdbapi.com/", {
        timeout: Math.max(100, REQUEST_TIMEOUT_MS),
        params: { apikey: env.omdbApiKey, t: title, y: releaseYear(year) || undefined },
      });
      if (data?.imdbID && data.imdbID !== "N/A") imdb = data.imdbID;
    } catch (error) {
      console.warn("[stream-resolver] OMDB lookup failed:", error.message);
    }
  }

  return { imdbId: imdb, tmdbId: tmdb };
}

async function queryYts(title, quality, timeoutMs = REQUEST_TIMEOUT_MS) {
  const term = String(title || "").trim();
  if (!term || !env.ytsApiUrl) return [];
  try {
    const { data } = await axios.get(`${env.ytsApiUrl}/list_movies.json`, {
      timeout: Math.max(100, Number(timeoutMs) || REQUEST_TIMEOUT_MS),
      params: { query_term: term, limit: 20 },
    });
    const movies = data?.data?.movies || [];
    const wanted = normalizeQuality(quality);
    const rows = [];
    for (const movie of movies) {
      for (const torrent of movie.torrents || []) {
        const hash = String(torrent.hash || "").trim();
        const seeds = Number(torrent.seeds) || 0;
        const torrentQuality = String(torrent.quality || "").toLowerCase();
        if (!hash || seeds < MIN_SEEDERS) continue;
        if (wanted !== "all" && torrentQuality && torrentQuality !== wanted && torrentQuality !== quality) continue;
        const name = `${movie.title || term} ${movie.year || ""} ${torrent.quality || ""} ${torrent.type || ""} ${torrent.video_codec || ""}`.trim();
        rows.push({
          title: name,
          seeds,
          quality: torrentQuality,
          language_tags: ["english"],
          provider: "yts",
          size: torrent.size || "",
          size_bytes: Number(torrent.size_bytes) || null,
          magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`,
        });
      }
    }
    console.log(`[stream-resolver] YTS rows=${rows.length} for "${term}"`);
    return rows;
  } catch (error) {
    console.warn("[stream-resolver] YTS API failed:", error.message);
    return [];
  }
}

/**
 * Run every query at once. The first healthy torrent (seeders >= MIN_SEEDERS)
 * wins and later responses are ignored. Hard stop at `deadline`.
 */
function raceHealthySources(jobs, { language, quality, deadline }) {
  const lang = isHindiLanguage(language) ? "hindi" : language;
  const list = (Array.isArray(jobs) ? jobs : []).filter(Boolean);
  return new Promise((resolve) => {
    let settled = false;
    let pending = list.length;
    const collected = [];
    const seen = new Set();
    const left = deadline - Date.now();
    const timer = setTimeout(() => finish(null), safeDelay(left));

    function consider(rows) {
      if (settled || !Array.isArray(rows) || !rows.length) return;
      for (const row of rows) {
        const key = `${row?.title || ""}|${row?.magnet || row?.link || row?.desc || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(row);
      }
      const healthy = pickHealthyTorrent(collected, lang, quality);
      const floor = seedFloorFor(language);
      if (healthy && healthy.seeds >= floor) {
        console.log(`[stream-resolver] early exit — ${healthy.seeds} seeders — ${healthy.title}`);
        finish(healthy);
      }
    }

    function finish(winner) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(winner || pickHealthyTorrent(collected, lang, quality));
    }

    if (!list.length || left <= 0) {
      finish(null);
      return;
    }

    for (const job of list) {
      const budget = safeDelay(deadline - Date.now());
      const task = job.run
        ? job.run(budget)
        : fetchTorrentSearch(job.query, {
            maxTitles: 1,
            timeoutMs: budget,
            skipTitleResolve: true,
            onBatch: consider,
          });
      Promise.resolve(task)
        .then((rows) => consider(rows))
        .catch((error) => {
          console.warn("[stream-resolver] query failed:", job.query || job.label || "job", error.message);
        })
        .finally(() => {
          pending -= 1;
          if (!settled && pending <= 0) finish(null);
        });
    }
  });
}

function indexerJobs(queries) {
  const endpoints = parseEndpointList(env.torrentIndexerEndpoints);
  const jobs = queries.map((query) => ({ query }));
  for (const url of endpoints) {
    for (const query of queries) {
      jobs.push({
        label: url,
        query,
        run: (budget) =>
          axios({
            method: "GET",
            url,
            timeout: safeDelay(budget),
            headers: env.torrentIndexerApiKey ? { Authorization: `Bearer ${env.torrentIndexerApiKey}` } : {},
            params: { q: query, query },
          }).then((response) => {
            const data = response.data;
            return Array.isArray(data) ? data : data?.results || data?.items || data?.torrents || [];
          }),
      });
    }
  }
  return jobs;
}

function requestedLanguageLabel(language) {
  const text = String(language || "").trim();
  if (/\burdu\b/i.test(text) && !/\bhindi\b/i.test(text) && !/dual/i.test(text)) return "Urdu";
  if (isHindiLanguage(text)) {
    if (/dual/i.test(text)) return "Dual Audio [Hindi+Eng]";
    return "Hindi";
  }
  if (!text || text.toLowerCase() === "all") return "English";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function queueBackgroundRetry(fields) {
  void enqueueDownloadRequest(fields).catch((error) => {
    console.warn("[stream-resolver] background queue skipped:", error.message);
  });
}

function torrentResult(item, language, quality, magnet) {
  const meta = describeRelease(item, language, quality);
  const accepted = acceptTorrentRelease({
    title: item?.title,
    sizeBytes: meta.size_bytes || item?.size_bytes,
    size: item?.size || meta.size_human,
    quality: meta.quality || quality,
    mediaType: item?.media_type,
    metadata: item?.title,
  });
  const link = String(item?.link || "");
  const videoUrl = isVideoFileUrl(link) ? link : "";
  const magnetLink = /^magnet:/i.test(String(magnet || item?.magnet || "")) ? magnet || item.magnet : "";
  const written = magnetWrite(magnetLink);
  if (!accepted.ok) {
    return {
      source_type: "torrent",
      download_url: written ? written.download_url : null,
      stream_url: "",
      magnet_link: written ? written.magnet_link : null,
      quality: meta.quality,
      resolution: meta.quality,
      size: "",
      size_human: "",
      size_bytes: null,
      language: meta.language,
      language_label: meta.language,
      seeders: meta.seeders,
      is_fallback: false,
      primary: meta.language !== "English",
      provider: item.provider,
      title: item.title,
      status: "unavailable",
      cached: false,
    };
  }
  return {
    source_type: "torrent",
    download_url: written ? written.download_url : videoUrl || null,
    stream_url: videoUrl || null,
    magnet_link: written ? written.magnet_link : videoUrl || null,
    quality: accepted.quality,
    resolution: accepted.quality,
    size: accepted.size_human,
    size_human: accepted.size_human,
    size_bytes: accepted.size_bytes,
    language: meta.language,
    language_label: meta.language,
    seeders: meta.seeders,
    is_fallback: false,
    primary: meta.language !== "English",
    provider: item.provider,
    title: item.title,
    status: "ready",
    cached: false,
  };
}

/**
 * Resolve a playable/downloadable source for a title.
 * Never throws — failures become `{ status: "queued" }`.
 */
async function resolveDownloadLinks(title, year, language, quality, options = {}) {
  const cleanTitle = String(title || "").trim();
  const lang = normalizeLanguage(language);
  const qual = normalizeQuality(quality);

  if (!cleanTitle) {
    return {
      source_type: null,
      download_url: null,
      resolution: qual,
      language: lang,
      is_fallback: false,
      status: "queued",
      error: "Title is required",
    };
  }

  if (!options.skipCache) {
    try {
      const cached = await findCachedSource({
        mediaId: options.mediaId || options.tmdbId || options.tmdb_id || options.media_id,
        imdbId: options.imdbId || options.imdb_id,
        title: cleanTitle,
        year,
        language,
        quality,
        season: options.season,
        episode: options.episode,
      });
      if (cached?.download_url && isReadyVideoFile(cached)) {
        console.log(`[stream-resolver] cache hit ${cached.mediaId || "-"} ${cached.language} ${cached.quality || cached.resolution}`);
        return { ...cached, source_type: "ddl", stream_url: cached.download_url, cached: true, status: "ready" };
      }
    } catch (error) {
      console.warn("[stream-resolver] cache lookup failed:", error.message);
    }
  }

  const regionalQueries = Array.isArray(options.queries) && options.queries.length
    ? options.queries.map((query) => String(query || "").trim()).filter(Boolean)
    : buildRegionalQueries(cleanTitle);
  const episode = parseEpisodeQuery(cleanTitle, options);
  const packQueries = episode ? buildSeasonPackQueries(cleanTitle, episode.season, "hindi") : [];
  const tmdbId = options.tmdbId || options.tmdb_id || options.mediaId || options.media_id || null;
  const knownImdb = String(options.imdbId || options.imdb_id || "").trim();
  const displayLanguage = requestedLanguageLabel(language);
  const budget = options.budgetMs != null ? safeDelay(options.budgetMs, 6000) : TORRENT_SEARCH_BUDGET_MS;
  const deadline = Date.now() + budget;
  const mediaType = options.mediaType || (episode ? "tv" : "movie");
  const idLookup = lookupExternalIds({
    title: stripEpisodeCode(cleanTitle),
    year,
    tmdbId,
    imdbId: knownImdb,
    mediaType,
  });
  console.log(`[stream-resolver] phase 1 Hindi/Dual/Urdu (${displayLanguage}/${qual}): ${[...regionalQueries, ...packQueries].join(" || ")}`);

  ensureTorrentProviders();
  try {
    const regionalJobs = indexerJobs([...regionalQueries, ...packQueries]);
    let healthy = await raceHealthySources(regionalJobs, { language: "hindi", quality: qual, deadline });
    if (!(healthy && healthy.seeds >= REGIONAL_MIN_SEEDERS)) {
      const epCode = episode && episode.episode ? `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}` : null;
      const englishQuery = epCode
        ? `${stripEpisodeCode(cleanTitle)} ${epCode} ${SearchFilters.qualityQueryFor(qual)}`.trim()
        : buildTorrentQueries(cleanTitle, year, "english", qual)[0];
      console.log(`[stream-resolver] phase 2 English (${englishQuery}) — no regional torrent with ${REGIONAL_MIN_SEEDERS}+ seeders`);
      const englishJobs = indexerJobs(englishQuery ? [englishQuery] : []);
      if (!epCode) {
        englishJobs.push({ label: "yts", run: (budget) => queryYts(cleanTitle, qual, safeDelay(budget, REQUEST_TIMEOUT_MS)) });
      }
      healthy = await raceHealthySources(englishJobs, { language: "english", quality: qual, deadline });
    }
    if (healthy) {
      const magnet =
        healthy.magnet && /^magnet:/i.test(healthy.magnet)
          ? healthy.magnet
          : healthy.link
            ? ""
            : await resolveMagnet(healthy, safeDelay(Math.min(400, deadline - Date.now()), 400));
      if (magnet || healthy.link || healthy.magnet) {
        const built = torrentResult(healthy, displayLanguage, qual, magnet || healthy.magnet);
        if (built.status === "ready" && (built.magnet_link || isReadyVideoFile(built))) return built;
      }
    }
  } catch (error) {
    console.warn("[stream-resolver] torrent strategy failed:", error.message);
  }

  try {
    const [ddl, archive] = await Promise.all([
      queryDdlProviders({
        title: cleanTitle,
        year,
        language: displayLanguage,
        quality: qual,
        query: regionalQueries[0] || cleanTitle,
        tmdbId,
        imdbId: knownImdb,
        mediaType,
      }),
      queryInternetArchive({ title: cleanTitle, year, language: displayLanguage, quality: qual, mediaType }),
    ]);
    const video = [ddl, archive].find((item) => isReadyVideoFile(item));
    if (video) return video;
  } catch (error) {
    console.warn("[stream-resolver] direct video lookup failed:", error.message);
  }

  let imdbId = knownImdb;
  let resolvedTmdb = tmdbId ? String(tmdbId) : "";
  if (!imdbId) {
    const lookedUp = await withTimeout(idLookup, Math.max(100, Math.min(400, deadline - Date.now())), null);
    if (lookedUp?.imdbId) imdbId = lookedUp.imdbId;
    if (!resolvedTmdb && lookedUp?.tmdbId) resolvedTmdb = lookedUp.tmdbId;
  }
  const embed = buildEmbedFallback({
    imdbId,
    tmdbId: resolvedTmdb,
    language: displayLanguage,
    quality: qual,
    mediaType,
    season: episode?.season,
    episode: episode?.episode,
  });
  if (embed?.stream_url) {
    if (!options.skipQueue) {
      queueBackgroundRetry({
        userId: options.userId || options.user_id,
        mediaId: tmdbId,
        title: cleanTitle,
        year,
        language: displayLanguage,
        quality: qual,
        notes: "Embed served after parallel torrent sweep. Background retry queued.",
      });
    }
    return {
      ...embed,
      quality: qual,
      resolution: qual,
      size: "",
      size_human: "",
      language: displayLanguage,
      language_label: displayLanguage,
      seeders: 0,
      cached: false,
    };
  }

  if (options.skipQueue) {
    return {
      source_type: null,
      download_url: null,
      resolution: qual,
      language: lang,
      seeders: null,
      is_fallback: false,
      status: "failed",
    };
  }

  const queued = await enqueueDownloadRequest({
    userId: options.userId || options.user_id,
    mediaId: tmdbId,
    title: cleanTitle,
    year,
    language: displayLanguage,
    quality: qual,
    notes: `Unresolved after regional then English search. queries="${regionalQueries.join(" | ")}"`,
  });

  return {
    source_type: null,
    download_url: null,
    resolution: qual,
    language: lang,
    seeders: null,
    is_fallback: false,
    status: "queued",
    request_id: queued?.id || null,
  };
}

/**
 * One parallel pass for Hindi, Dual Audio, and English.
 * Regional queries and the English/YTS lookup start together.
 * Each language keeps its healthiest release.
 */
async function collectCatalogTorrents(title, year, options = {}) {
  const name = cleanReleaseTitle(title);
  if (!name) return [];
  const timeout = safeDelay(options.timeoutMs, TORRENT_SEARCH_BUDGET_MS);
  const regional = buildRegionalQueries(name);
  const englishQuery = buildTorrentQueries(name, year, "english", "1080p")[0];
  ensureTorrentProviders();
  const jobs = [
    ...regional.map((query) =>
      fetchTorrentSearch(query, { maxTitles: 1, resultLimit: 20, timeoutMs: timeout, skipTitleResolve: true })
    ),
    englishQuery
      ? fetchTorrentSearch(englishQuery, { maxTitles: 1, resultLimit: 15, timeoutMs: timeout, skipTitleResolve: true })
      : Promise.resolve([]),
    queryYts(name, "all", timeout),
  ];
  const settled = await Promise.allSettled(jobs);
  const best = new Map();
  for (const entry of settled) {
    if (entry.status !== "fulfilled" || !Array.isArray(entry.value)) continue;
    for (const raw of entry.value) {
      const item = toTorrentCandidate(raw);
      if (!item) continue;
      const meta = describeRelease(item, "", item.quality);
      const language = meta.language;
      if (!["Hindi", "Dual Audio [Hindi+Eng]", "Urdu", "English"].includes(language)) continue;
      const floor = language === "English" ? MIN_SEEDERS : REGIONAL_MIN_SEEDERS;
      const download = item.magnet || item.link;
      const accepted = acceptTorrentRelease({
        title: item.title,
        sizeBytes: meta.size_bytes || item.size_bytes,
        size: item.size,
        quality: meta.quality,
        mediaType: options.mediaType,
        metadata: item.title,
      });
      if ((Number(item.seeds) || 0) < floor || !download || !accepted.ok) continue;
      const previous = best.get(language);
      if (!previous || item.seeds > previous.seeds) {
        best.set(language, torrentResult(item, language, accepted.quality || "1080p", item.magnet));
      }
    }
  }
  return [...best.values()];
}

module.exports = {
  resolveDownloadLinks,
  collectCatalogTorrents,
  buildTorrentQuery,
  buildTorrentQueries,
  buildRegionalQueries,
  pickHealthyTorrent,
  isHindiLanguage,
  isDirectMediaUrl,
  isVideoFileUrl,
  isTorrentArtifactUrl,
  isReadyVideoFile,
  confirmFullMovie,
  MIN_VIDEO_BYTES,
  archiveVideoUrl,
  pickArchiveVideoName,
  buildEmbedUrl,
  buildEmbedFallback,
  parseEpisodeQuery,
  buildSeasonPackQueries,
  parseSize,
  describeRelease,
  raceHealthySources,
  TORRENT_SEARCH_BUDGET_MS,
  REGIONAL_MIN_SEEDERS,
  MIN_SEEDERS,
};
