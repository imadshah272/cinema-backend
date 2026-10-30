"use strict";

/**
 * Shared torrent discovery for catalog enrich and POST /api/media/resolve-source.
 * Hindi-dub cascade for Hollywood, Asian, European, and Indian regional titles.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

const MIN_RELEASE_BYTES = 600 * MB;
const MOVIE_FLOOR_BYTES = 600 * MB;
const EPISODE_FLOOR_BYTES = 150 * MB;
const SEASON_PACK_FLOOR_BYTES = Math.round(1.5 * GB);
const MIN_SEEDERS = 2;
const QUERY_TIMEOUT_MS = 4000;

const PRIMARY_PROVIDERS = ["1337x", "TorrentGalaxy", "ThePirateBay", "Limetorrents", "TorrentProject"];
const SECONDARY_PROVIDERS = ["Yts", "Eztv", "KickassTorrents", "Torrentz2"];

const JUNK_TITLE_RE = /\b(sample|trailer|teaser|camrip|telesync|screener)\b/i;
/** Never a full film, even when cinema prints are allowed. */
const NOT_A_FILM_RE = /\b(sample|trailer|teaser)\b/i;
const CONTAINER_RE = /\.(mkv|mp4|avi|webm)\b|\bx264\b|\bx265\b|\bhevc\b|\bweb[\s._-]*dl\b|\bblu[\s._-]?ray\b|\bhdrip\b|\bwebrip\b|\bbrrip\b|\bdvdrip\b|\bhdtv\b|\baac\b/i;
const DUB_MARKER_RE = /\b(hindi|hin|urdu|dual|multi|dubbed|dha)\b/i;
const INDIAN_INDUSTRY_RE = /\b(india|indian|bollywood|tollywood|kollywood|mollywood|sandalwood|hindi|tamil|telugu|malayalam|kannada)\b|\b(hi|ta|te|ml|kn|in)\b/i;

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= GB) {
    const gb = Math.round((value / GB) * 10) / 10;
    return `${gb} GB`;
  }
  return `${Math.round(value / MB)} MB`;
}

function parseByteSize(...candidates) {
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw);
    const match = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(String(raw));
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const multiplier = { KB: 1024, MB, GB, TB: 1024 * GB }[match[2].toUpperCase()];
    return Math.round(amount * multiplier);
  }
  return null;
}

function magnetLength(magnet) {
  const match = /(?:^|[?&])xl=(\d+)/i.exec(String(magnet || ""));
  if (!match) return null;
  const bytes = Number(match[1]);
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null;
}

/**
 * Real byte size from indexer fields, payload, a magnet xl= value, or a size in the title.
 * Zero is treated as unknown.
 */
function publicSize(source = {}) {
  const payload = source.payload && typeof source.payload === "object" ? source.payload : {};
  const bytes = parseByteSize(
    source.size_bytes,
    source.sizeBytes,
    source.filesize,
    source.length,
    payload.size_bytes,
    payload.filesize,
    payload.length,
    source.size,
    source.size_human,
    payload.size,
    payload.size_human,
    magnetLength(source.magnet_link || source.magnet || source.download_url || payload.magnet_link),
    payload.title,
    source.title,
    source.media_title
  );
  if (!bytes) return { size_bytes: null, size_human: null, size: null };
  const human = formatSize(bytes);
  return { size_bytes: bytes, size_human: human, size: human };
}

function torrentInfoLength(buffer) {
  function decode(buf, index) {
    const marker = buf[index];
    if (marker === 105) {
      const end = buf.indexOf(101, index + 1);
      return [Number(buf.slice(index + 1, end).toString()), end + 1];
    }
    if (marker === 108) {
      const list = [];
      let cursor = index + 1;
      while (buf[cursor] !== 101) {
        const [value, next] = decode(buf, cursor);
        list.push(value);
        cursor = next;
      }
      return [list, cursor + 1];
    }
    if (marker === 100) {
      const record = {};
      let cursor = index + 1;
      while (buf[cursor] !== 101) {
        const [key, keyEnd] = decode(buf, cursor);
        const [value, valueEnd] = decode(buf, keyEnd);
        record[Buffer.isBuffer(key) ? key.toString("utf8") : String(key)] = value;
        cursor = valueEnd;
      }
      return [record, cursor + 1];
    }
    const colon = buf.indexOf(58, index);
    const length = Number(buf.slice(index, colon).toString());
    const start = colon + 1;
    return [buf.slice(start, start + length), start + length];
  }

  try {
    const [root] = decode(buffer, 0);
    const info = root?.info;
    if (!info) return null;
    if (typeof info.length === "number" && info.length > 0) return Math.round(info.length);
    if (!Array.isArray(info.files)) return null;
    const total = info.files.reduce((sum, file) => sum + (Number(file.length) > 0 ? Number(file.length) : 0), 0);
    return total > 0 ? Math.round(total) : null;
  } catch {
    return null;
  }
}

async function lookupReleaseBytes(source = {}) {
  const known = publicSize(source);
  if (known.size_bytes) return known;
  const magnet = source.magnet_link || source.magnet || source.download_url || "";
  const hash = /btih:([a-f0-9]{40})/i.exec(String(magnet))?.[1] || "";
  const torrentUrl = /\.torrent(\?|$)/i.test(String(source.download_url || source.link || ""))
    ? source.download_url || source.link
    : hash
      ? `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent`
      : "";
  if (torrentUrl && !/^magnet:/i.test(torrentUrl)) {
    try {
      const axios = require("axios");
      const response = await axios.get(torrentUrl, {
        responseType: "arraybuffer",
        timeout: 8000,
        maxContentLength: 2 * 1024 * 1024,
        validateStatus: (status) => status === 200,
      });
      const bytes = torrentInfoLength(Buffer.from(response.data));
      if (bytes) return publicSize({ size_bytes: bytes });
    } catch {
      // A missing torrent file leaves the size unknown.
    }
  }
  const httpUrl = /^https:\/\//i.test(String(source.download_url || "")) ? source.download_url : source.stream_url;
  if (httpUrl && /\.(mp4|mkv|webm)(\?|$)/i.test(httpUrl)) {
    try {
      const axios = require("axios");
      const response = await axios.head(httpUrl, { timeout: 8000, maxRedirects: 3, validateStatus: () => true });
      const length = Number(response.headers?.["content-length"]);
      if (response.status === 200 && Number.isFinite(length) && length >= 50 * MB) return publicSize({ size_bytes: length });
    } catch {
      // HEAD is optional. Unknown stays null.
    }
  }
  return { size_bytes: null, size_human: null, size: null };
}

function canonicalReleaseQuality(quality) {
  const text = String(quality || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "4k" || text === "uhd" || text === "2160p") return "2160p";
  if (text === "1080p" || text === "720p" || text === "480p") return text;
  return "";
}

function detectQuality(text) {
  const value = String(text || "");
  if (/\b(?:2160p|4k|uhd)\b/i.test(value)) return "2160p";
  if (/\b1080p\b/i.test(value)) return "1080p";
  if (/\b720p\b/i.test(value)) return "720p";
  if (/\b480p\b/i.test(value)) return "480p";
  return canonicalReleaseQuality(value);
}

function releaseKind(title, mediaType) {
  const text = String(title || "");
  const episode = /\bS\d{1,2}\s*E\d{1,2}\b/i.test(text);
  const pack = !episode && /\b(season\s*\d+|complete(?:\s+(?:series|season|pack))?|S\d{1,2}\b(?!\s*E))/i.test(text);
  if (mediaType === "tv" || episode || pack) return pack ? "season" : "episode";
  return "movie";
}

function hasCleanContainer(title, metadata) {
  return CONTAINER_RE.test(`${title || ""} ${metadata || ""}`);
}

/**
 * Movies stay at 600 MB. Episodes may be 150 MB. Season packs must be larger than 1.5 GB.
 * Seeders are enforced only when the caller supplies a number.
 * @returns {{ ok: true, quality: string, size_bytes: number, size_human: string, kind: string } | { ok: false }}
 */
function acceptTorrentRelease({ title, sizeBytes, size, quality, mediaType, metadata, seeders, allowCamPrint = false } = {}) {
  const name = String(title || "");
  const extra = String(metadata || "");
  const junkRe = allowCamPrint ? NOT_A_FILM_RE : JUNK_TITLE_RE;
  if (!name || junkRe.test(name) || junkRe.test(extra)) return { ok: false };
  if (!hasCleanContainer(name, extra) && !quality) return { ok: false };

  const bytes = parseByteSize(sizeBytes, size, extra);
  if (!bytes) return { ok: false };
  // Require at least MIN_SEEDERS shown connected seeders to treat a swarm as
  // healthy. A torrent that reports 0 seeders, or omits the seeder count
  // entirely, can never prove it has live uploads, so presenting it would
  // 503 with TORRENT_NO_PEERS for every client that tries it.
  if (seeders == null || Number(seeders) < MIN_SEEDERS) return { ok: false };
  if (mediaType === "movie" && /\b(?:s\d{1,2}e\d{1,2}|s0\d|season\s*\d+|episode\s*\d+|ep\s*\d+)\b/i.test(`${name} ${extra}`)) return { ok: false };

  const detected = detectQuality(quality) || detectQuality(name) || detectQuality(extra) || "1080p";
  const kind = releaseKind(`${name} ${extra}`, mediaType);
  if (mediaType === "movie" && kind !== "movie") return { ok: false };
  if (kind === "season") {
    if (bytes <= SEASON_PACK_FLOOR_BYTES) return { ok: false };
  } else {
    const floor = kind === "episode" ? EPISODE_FLOOR_BYTES : detected === "480p" ? 200 * MB : MOVIE_FLOOR_BYTES;
    if (bytes < floor) return { ok: false };
  }

  return { ok: true, quality: detected, size_bytes: bytes, size_human: formatSize(bytes), kind };
}

/**
 * Magnet converted into pre-converted DDL HTTP stream endpoints (.mp4/.mkv).
 * NEVER stores raw magnet in download_url or stream_url!
 */
function magnetWrite(magnetLink, reqOrBaseUrl = null, episode = null) {
  const magnet = String(magnetLink || "").trim();
  if (!/^magnet:/i.test(magnet)) return null;
  const hash = /btih:([a-f0-9]{40}|[a-z2-7]{32})/i.exec(magnet)?.[1]?.toLowerCase();
  if (hash) {
    const { buildTorrentStreamUrl } = require("./torrentStreamEngine");
    const downloadUrl = buildTorrentStreamUrl(reqOrBaseUrl, { magnet, infoHash: hash, isDownload: true, episode });
    const streamUrl = buildTorrentStreamUrl(reqOrBaseUrl, { magnet, infoHash: hash, isDownload: false, episode });
    return {
      download_url: downloadUrl,
      stream_url: streamUrl,
      magnet_link: magnet,
      source_type: "ddl",
      status: "ready",
    };
  }
  return {
    download_url: magnet,
    magnet_link: magnet,
    stream_url: null,
    source_type: "torrent",
    status: "ready",
  };
}

/** API shape: automatically transforms any torrent magnet into direct HTTP stream DDL endpoints. */
function normalizeSourceLinks(record = {}, reqOrBaseUrl = null) {
  const download = record.download_url || null;
  const magnet = record.magnet_link || null;
  const sourceType = record.source_type || null;
  if (sourceType === "embed_stream") {
    const stream = record.stream_url || record.payload?.stream_url || null;
    return {
      source_type: "embed_stream",
      download_url: download || null,
      magnet_link: magnet || null,
      stream_url: stream,
    };
  }
  const effectiveMagnet = /^magnet:/i.test(String(magnet || ""))
    ? magnet
    : /^magnet:/i.test(String(download || ""))
      ? download
      : null;
  if (effectiveMagnet) {
    const written = magnetWrite(effectiveMagnet, reqOrBaseUrl);
    if (written) {
      return {
        source_type: "ddl",
        download_url: written.download_url,
        stream_url: written.stream_url,
        magnet_link: written.magnet_link,
      };
    }
  }
  return {
    source_type: sourceType || "ddl",
    download_url: download || magnet || null,
    magnet_link: magnet || download || null,
    stream_url: record.stream_url || null,
  };
}

/** Keep the Romanized name, then drop punctuation and release qualifiers that break indexers. */
function cleanSearchTitle(title) {
  const primary = String(title || "").split(/\s*(?:\/|\baka\b)\s*/i)[0];
  return primary
    .replace(/\s*\((?:19|20)\d{2}\)\s*/g, " ")
    .replace(/[''‘’"`“”]/g, "")
    .replace(/[:;!?.,&]/g, " ")
    .replace(/[-–—_/\\|+]/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\b(extended|unrated|remastered|theatrical|directors?\s*cut|proper|repack)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseYear(year) {
  return String(year || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function isIndianIndustry({ industry, country, originalLanguage } = {}) {
  return INDIAN_INDUSTRY_RE.test([industry, country, originalLanguage].filter(Boolean).join(" "));
}

/**
 * Hindi Dubbed, Dual Audio, then a short Hindi query.
 * Indian cinema adds a Hindi/Tamil/Telugu query. The plain title is last.
 */
function buildCascadeQueries(title, year, options = {}) {
  const name = cleanSearchTitle(title);
  if (!name) return [];
  const yr = releaseYear(year);
  const withYear = yr ? `${name} ${yr}` : name;
  const s = options.season != null && Number(options.season) > 0 ? Number(options.season) : null;
  const ep = options.episode != null && Number(options.episode) > 0 ? Number(options.episode) : null;

  if (s != null && ep != null) {
    const sPad = String(s).padStart(2, "0");
    const ePad = String(ep).padStart(2, "0");
    return [
      `${name} S${sPad}E${ePad} Dual Audio`,
      `${name} S${sPad}E${ePad} Hindi`,
      `${name} S${sPad}E${ePad}`,
      `${name} Season ${s} Episode ${ep} Hindi`,
      `${name} S${sPad} Dual Audio`,
      `${name} S${sPad} Hindi`,
    ];
  }

  if (s != null) {
    const sPad = String(s).padStart(2, "0");
    return [
      `${name} Season ${s} Dual Audio`,
      `${name} Season ${s} Hindi`,
      `${name} S${sPad} Complete Dual Audio`,
      `${name} S${sPad} Complete Hindi`,
      `${name} S${sPad} Dual Audio`,
      `${name} S${sPad} Hindi`,
    ];
  }

  const queries = [`${withYear} Hindi Dubbed`, `${withYear} Dual Audio`, `${name} Hindi`];
  if (isIndianIndustry(options)) queries.push(`${withYear} Hindi Tamil Telugu`);
  queries.push(withYear);
  return queries;
}

function hasDubMarker(title) {
  return DUB_MARKER_RE.test(String(title || ""));
}

/** Confirmed dub tags become Dual Audio, Hindi, Urdu, or English. */
function languageForRelease(title) {
  const t = String(title || "");
  if (/\bdual[ ._-]?audio\b|\bmulti[ ._-]?audio\b|dual\s*\[\s*hindi|hindi\s*[-+&/]\s*eng|eng\s*[-+&/]\s*hindi|hin\s*[-+&/]\s*eng|\b(multi)\b/i.test(t)) {
    return "Dual Audio [Hindi+Eng]";
  }
  if (/\burdu\b/i.test(t) && !/\bhindi\b/i.test(t)) return "Urdu";
  if (/\bhindi\b|\bhin\b|\bdubbed\b|\bdesi\b|\bdha\b/i.test(t)) return "Hindi";
  if (/\bturkish\b|\bturk\b|\btrt\b/i.test(t)) {
    if (/\burdu\b/i.test(t)) return "Urdu";
    if (/\bhindi\b/i.test(t)) return "Hindi";
    return "English";
  }
  return "English";
}

function seedCount(item) {
  const value = Number(item?.seeds ?? item?.seeders ?? item?.seed);
  return Number.isFinite(value) ? value : 0;
}

function extractCandidateCoreTitle(candidate) {
  let s = String(candidate || "").replace(/[._]/g, " ").trim();
  const metaRegex = /\b(?:s\d{1,2}|season\s*\d+|\d{1,2}x\d{1,2}|e\d{1,2}|ep\s*\d+|episode\s*\d+|19\d{2}|20\d{2}|480p|720p|1080p|2160p|4k|uhd|bluray|web-?dl|webrip|brrip|hdtv|nf|amzn|dsnp|hbo|complete|repack|dual|hindi|dubbed)\b/i;
  const match = s.match(metaRegex);
  if (match && match.index > 0) {
    s = s.slice(0, match.index);
  }
  return s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

function matchesTargetTitle(candidateTitle, targetTitle) {
  if (!targetTitle) return true;
  const cleanTarget = String(targetTitle || "").replace(/[\s_-]+s\d{1,2}(?:e\d{1,2})?.*$/i, "").trim();
  const normT = cleanTarget.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  if (!normT) return true;

  const STOP_WORDS = new Set([
    "the", "and", "a", "an", "of", "in", "to", "for", "with", "all",
    "season", "complete", "series", "hindi", "dual", "audio", "dubbed", "part"
  ]);

  const tWords = normT.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  if (tWords.length === 0) return true;

  const cCore = extractCandidateCoreTitle(candidateTitle);
  const cWords = cCore.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  // 1. Every single target word must be present in the candidate core title
  for (const tw of tWords) {
    if (!cWords.includes(tw)) return false;
  }

  // 2. Candidate must NOT have extra major content words (e.g. Love & Death vs Love Death and Robots)
  const extraWords = cWords.filter((cw) => !tWords.includes(cw));
  if (extraWords.length > 0) {
    return false;
  }

  return true;
}

function rankValidReleases(items, mediaType, expectedTitle = "", targetSeason = null, targetEpisode = null) {
  const ranked = [];
  const sNum = targetSeason != null && Number(targetSeason) > 0 ? Number(targetSeason) : null;
  const epNum = targetEpisode != null && Number(targetEpisode) > 0 ? Number(targetEpisode) : null;

  for (const item of Array.isArray(items) ? items : []) {
    const title = String(item?.title || "").trim();
    if (!title) continue;
    if (expectedTitle && !matchesTargetTitle(title, expectedTitle)) {
      continue;
    }

    // Season / Episode mismatch filter for TV series
    if (mediaType === "tv" || mediaType === "series") {
      const seMatch = title.match(/s0*(\d+)[^a-z0-9]*e0*(\d+)/i) || title.match(/\b(\d+)x0*(\d+)\b/i);
      if (seMatch) {
        const foundSeason = Number(seMatch[1]);
        const foundEpisode = Number(seMatch[2]);
        if (sNum != null && foundSeason !== sNum) continue; // Different season
        if (epNum != null && foundEpisode !== epNum) continue; // Different episode
      } else if (epNum != null) {
        // Episode-level requests must come from a torrent whose filename marks
        // the exact episode. A bare season torrent has no single file for the
        // requested episode and would 404 with TORRENT_EPISODE_NOT_FOUND at
        // stream time, so reject it now instead of presenting a bad source.
        continue;
      } else {
        const sOnly = title.match(/\b(?:s|season)\s*0*(\d+)\b/i);
        if (sOnly && sNum != null && Number(sOnly[1]) !== sNum) {
          continue; // Different season
        }
      }
    }

    const seeders = seedCount(item);
    const accepted = acceptTorrentRelease({
      title,
      sizeBytes: item.size_bytes || item.sizeBytes,
      size: item.size || item.size_human,
      quality: item.quality || detectQuality(title),
      mediaType,
      metadata: [item.type, item.codec, item.video_codec].filter(Boolean).join(" "),
      seeders,
    });
    if (!accepted.ok) continue;
    ranked.push({ item, accepted, seeders });
  }
  ranked.sort((a, b) => b.seeders - a.seeders);
  return ranked;
}

function buildEmbedStream({ imdbId, tmdbId, mediaType, season, episode } = {}) {
  const imdb = String(imdbId || "").trim();
  const tmdb = String(tmdbId || "").trim();
  const id = imdb || tmdb;
  if (!id) return null;
  const encoded = encodeURIComponent(id);
  const kind = mediaType === "tv" ? "tv" : "movie";
  let stream = `https://vidsrc.to/embed/${kind}/${encoded}`;
  if (mediaType === "tv" && Number(season) > 0) {
    stream += `/${Number(season)}`;
    if (Number(episode) > 0) stream += `/${Number(episode)}`;
  }
  return {
    success: true,
    source_type: "embed_stream",
    status: "ready",
    download_url: stream,
    magnet_link: null,
    stream_url: stream,
    quality: "1080p",
    size_human: "",
    seeders: 0,
    is_fallback: true,
  };
}

let providersReady = false;

function ensureSearchProviders() {
  if (providersReady) return;
  const { initTorrentProviders, getActiveProviderNames } = require("../../src/torrentSearch");
  const requested = [...PRIMARY_PROVIDERS, ...SECONDARY_PROVIDERS];
  initTorrentProviders(requested);
  const active = getActiveProviderNames();
  const missing = requested.filter((name) => !active.some((item) => item.toLowerCase() === name.toLowerCase()));
  if (missing.length) {
    console.log(`[torrent-resolver] providers unavailable, skipped: ${missing.join(", ")}`);
  }
  console.log(`[torrent-resolver] provider order: ${active.join(" > ") || "(none)"}`);
  providersReady = true;
}

async function readMagnet(item, timeoutMs) {
  const direct = String(item?.magnet || item?.magnet_link || "").trim();
  if (/^magnet:/i.test(direct)) return direct;
  const link = String(item?.link || item?.desc || "").trim();
  if (/^magnet:/i.test(link)) return link;
  try {
    const TorrentSearchApi = require("torrent-search-api");
    const magnet = await Promise.race([
      Promise.resolve(TorrentSearchApi.getMagnet(item)).catch(() => ""),
      new Promise((resolve) => setTimeout(() => resolve(""), timeoutMs)),
    ]);
    return /^magnet:/i.test(String(magnet || "")) ? String(magnet) : "";
  } catch {
    return "";
  }
}

async function searchProviders(query, providers, timeoutMs, search) {
  try {
    const rows = await search(query, {
      maxTitles: 1,
      resultLimit: 25,
      timeoutMs,
      skipTitleResolve: true,
      providers,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn(`[torrent-resolver] search failed for "${query}": ${error.message}`);
    return [];
  }
}

const TORRENTIO_OPTS = "providers=eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex,rutor,rutracker,comando,bludv,torrent9,ilcorsaronero,mejortorrent,wolfmax4k,cinecalidad,besttorrents|sort=qualitysize|qualityfilter=scr,cam";

async function searchTorrentio({ title, year, mediaType = "movie", season = 1, episode = 1, imdbId: explicitImdbId } = {}) {
  try {
    let imdbId = explicitImdbId;
    if (!imdbId && title) {
      const clean = cleanSearchTitle(title);
      const yr = releaseYear(year);
      const q = yr ? `${clean} ${yr}` : clean;
      const kind = mediaType === "tv" ? "series" : "movie";
      const searchUrl = `https://v3-cinemeta.strem.io/catalog/${kind}/top/search=${encodeURIComponent(q)}.json`;
      const res = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(3000),
      });
      const meta = await res.json();
      imdbId = meta?.metas?.[0]?.id;
    }
    if (!imdbId || !imdbId.startsWith("tt")) return [];

    const streamPath = mediaType === "tv"
      ? `series/${imdbId}:${season || 1}:${episode || 1}.json`
      : `movie/${imdbId}.json`;
    const res = await fetch(`https://torrentio.strem.fun/${TORRENTIO_OPTS}/stream/${streamPath}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const streams = Array.isArray(data?.streams) ? data.streams : [];

    return streams.map((s) => {
      const fullTitle = [s.behaviorHints?.filename, s.title, s.name].filter(Boolean).join(" ");
      const seedsMatch = s.title?.match(/👤\s*(\d+)/);
      const sizeMatch = s.title?.match(/💾\s*([\d.]+\s*[GMK]B)/i);
      const seeds = seedsMatch ? Number(seedsMatch[1]) : 5;
      const sizeStr = sizeMatch ? sizeMatch[1] : null;
      const quality = detectQuality(fullTitle) || (s.name?.includes("4k") ? "2160p" : s.name?.includes("1080p") ? "1080p" : "720p");
      return {
        title: s.behaviorHints?.filename || s.title?.split("\n")[0] || fullTitle,
        magnet: `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(s.behaviorHints?.filename || title)}`,
        seeds,
        seeders: seeds,
        size: sizeStr,
        quality,
        provider: "Torrentio",
      };
    });
  } catch {
    return [];
  }
}

/**
 * Hindi Dubbed, then Dual Audio, then a short Hindi query. Indian cinema adds
 * Hindi/Tamil/Telugu. The plain title runs last. Each query waits at most 4000ms.
 * Primary indexers run first. Secondary indexers run only when that query is empty.
 */
async function discoverCascadingTorrents({
  title,
  year,
  mediaType = "movie",
  industry,
  country,
  originalLanguage,
  imdbId,
  tmdbId,
  season,
  episode,
  timeoutMs = QUERY_TIMEOUT_MS,
  shouldStop,
  search,
  queries: queriesOverride,
  allowEmbed = true,
  requireDubMarker = true,
} = {}) {
  // Step 0: Ultra-fast Torrentio Multi-Indexer Check (Prioritize Hindi & Dual Audio)
  let torrentioFallback = null;
  try {
    const torrentioResults = await searchTorrentio({ title, year, mediaType, season, episode, imdbId });
    if (torrentioResults.length) {
      console.log(`[torrent-resolver] Torrentio found ${torrentioResults.length} multi-indexer streams`);
      const valid = rankValidReleases(torrentioResults, mediaType, title, season, episode);
      const hindiOrDual = valid.filter((candidate) => {
        const lang = languageForRelease(candidate.item.title);
        return lang === "Dual Audio [Hindi+Eng]" || lang === "Hindi" || lang === "Urdu";
      });

      if (hindiOrDual.length) {
        const best = hindiOrDual[0];
        const written = magnetWrite(best.item.magnet);
        if (written) {
          const language = languageForRelease(best.item.title);
          console.log(`[torrent-resolver] Torrentio matched ${language} ${best.accepted.quality} ${best.accepted.size_human} · ${best.seeders} seeders`);
          return {
            ...written,
            success: true,
            quality: best.accepted.quality,
            size_human: best.accepted.size_human,
            size_bytes: best.accepted.size_bytes,
            seeders: best.seeders,
            language,
            language_label: language,
            title: best.item.title,
            provider: "Torrentio",
            primary: true,
          };
        }
      } else if (valid.length && !requireDubMarker) {
        torrentioFallback = valid[0];
      }
    }
  } catch (err) {
    console.warn(`[torrent-resolver] Torrentio check skipped: ${err.message}`);
  }

  const queries = Array.isArray(queriesOverride) && queriesOverride.length
    ? queriesOverride.map((query) => String(query || "").trim()).filter(Boolean)
    : buildCascadeQueries(title, year, { industry, country, originalLanguage, season, episode });
  if (!queries.length) return null;
  const requestedTimeout = Number(timeoutMs);
  const timeout = Math.max(100, Math.min(6000, Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : QUERY_TIMEOUT_MS));
  if (typeof search !== "function") ensureSearchProviders();
  const searchFn = typeof search === "function" ? search : require("../../src/torrentSearch").fetchTorrentSearch;
  const lastStep = queries.length - 1;

  for (let index = 0; index < queries.length; index += 1) {
    if (typeof shouldStop === "function" && shouldStop()) return null;
    const query = queries[index];
    const step = index + 1;
    console.log(`[torrent-resolver] step ${step}/${queries.length} "${query}" · ${timeout}ms · ${PRIMARY_PROVIDERS.join(", ")}`);
    let rows = await searchProviders(query, PRIMARY_PROVIDERS, timeout, searchFn);
    let valid = rankValidReleases(rows, mediaType, title, season, episode);
    if (requireDubMarker || index < lastStep) valid = valid.filter((candidate) => hasDubMarker(candidate.item.title));
    if (!valid.length) {
      console.log(`[torrent-resolver] step ${step} primary empty, trying ${SECONDARY_PROVIDERS.join(", ")}`);
      rows = await searchProviders(query, SECONDARY_PROVIDERS, timeout, searchFn);
      valid = rankValidReleases(rows, mediaType, title, season, episode);
      if (requireDubMarker || index < lastStep) valid = valid.filter((candidate) => hasDubMarker(candidate.item.title));
    }
    if (!valid.length) {
      console.log(`[torrent-resolver] step ${step} no valid release`);
      continue;
    }
    console.log(`[torrent-resolver] step ${step} ${rows.length} raw, ${valid.length} valid, best ${valid[0].seeders} seeders`);
    for (const candidate of valid) {
      const magnet = await readMagnet(candidate.item, timeout);
      if (!/^magnet:/i.test(magnet)) continue;
      const written = magnetWrite(magnet);
      const language = languageForRelease(candidate.item.title);
      if (language === "English" || language === "Original") {
        console.log(`[torrent-resolver] skipping English/Original release "${candidate.item.title}"`);
        continue;
      }
      console.log(
        `[torrent-resolver] ready ${language} ${candidate.accepted.quality} ${candidate.accepted.size_human} · ${candidate.seeders} seeders`
      );
      return {
        ...written,
        success: true,
        quality: candidate.accepted.quality,
        size_human: candidate.accepted.size_human,
        size_bytes: candidate.accepted.size_bytes,
        seeders: candidate.seeders,
        language,
        language_label: language,
        title: candidate.item.title,
        provider: candidate.item.provider || "",
        primary: true,
      };
    }
    console.log(`[torrent-resolver] step ${step} had releases but no magnet`);
  }

  if (torrentioFallback) {
    const language = languageForRelease(torrentioFallback.item.title);
    if (language !== "English" && language !== "Original") {
      const written = magnetWrite(torrentioFallback.item.magnet);
      if (written) {
        console.log(`[torrent-resolver] using Torrentio fallback: ${language} ${torrentioFallback.accepted.quality} · ${torrentioFallback.seeders} seeders`);
        return {
          ...written,
          success: true,
          quality: torrentioFallback.accepted.quality,
          size_human: torrentioFallback.accepted.size_human,
          size_bytes: torrentioFallback.accepted.size_bytes,
          seeders: torrentioFallback.seeders,
          language,
          language_label: language,
          title: torrentioFallback.item.title,
          provider: "Torrentio",
          primary: false,
        };
      }
    }
  }

  if (!allowEmbed) return null;
  const embed = buildEmbedStream({ imdbId, tmdbId, mediaType, season, episode });
  if (embed) {
    console.log("[torrent-resolver] no torrent, embed stream fallback");
    return embed;
  }
  console.log("[torrent-resolver] no torrent and no embed id");
  return {
    success: false,
    source_type: "embed_stream",
    status: "failed",
    download_url: null,
    magnet_link: null,
    stream_url: null,
    quality: "",
    size_human: "",
    seeders: 0,
    error: "No torrent or embed id found",
  };
}

module.exports = {
  MB,
  GB,
  MIN_RELEASE_BYTES,
  MIN_SEEDERS,
  QUERY_TIMEOUT_MS,
  PRIMARY_PROVIDERS,
  SECONDARY_PROVIDERS,
  MOVIE_FLOOR_BYTES,
  EPISODE_FLOOR_BYTES,
  SEASON_PACK_FLOOR_BYTES,
  acceptTorrentRelease,
  magnetWrite,
  normalizeSourceLinks,
  cleanSearchTitle,
  buildCascadeQueries,
  languageForRelease,
  isIndianIndustry,
  discoverCascadingTorrents,
  buildEmbedStream,
  formatSize,
  parseByteSize,
  publicSize,
  magnetLength,
  lookupReleaseBytes,
  releaseKind,
  canonicalReleaseQuality,
  searchTorrentio,
  rankValidReleases,
};
