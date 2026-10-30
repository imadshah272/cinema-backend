"use strict";

const axios = require("axios");
const { getSupabaseClient } = require("../services/supabaseClient");
const { asyncHandler } = require("../utils/http");
const { memoryCache } = require("../services/memoryCache");
const torboxService = require("../services/torboxService");
const { releaseName, hindiAudioKind, audioLabel, detectQuality, episodeScope, packCoversSeason } = require("../services/releaseAudio");
const { probeHindiAudio } = require("../services/audioTrackProbe");

// Streaming starts small so playback begins fast on slow connections.
const STREAM_QUALITY_ORDER = ["480p", "720p", "1080p", "2160p", "360p", ""];
const DOWNLOAD_QUALITY_ORDER = ["720p", "1080p", "480p", "2160p", "360p", ""];
const MAX_TORBOX_ATTEMPTS = 4;
/** Release names that say the audio is AAC usually carry a phone-playable Hindi track. */
const AAC_NAME_RE = /\baac\b|\bhe-aac\b/i;
/** Dolby / DTS audio: skipped by most Android phones, so Hindi would be silent. */
const DOLBY_NAME_RE = /\b(dd\+?|ddp|ac3|eac3|e-ac-3|dts|truehd|atmos)\s*[\d.]*/i;

function wantsHindiAudio(audio) {
  return /^(hi|hin|hindi|dual|ur|urdu)$/i.test(String(audio || ""));
}

/**
 * Load media_sources rows for a movie, or for one TV episode.
 * Episode rows are exact (tmdbId-sXXeYY) first; season-level rows are only
 * kept when their release is a pack, never another episode's single file.
 */
async function loadSourceRows(supabase, tmdbId, mediaType, season, episode) {
  const columns = "id, media_id, media_title, stream_url, download_url, magnet_link, language, quality, source_type, size_bytes, payload";
  if (mediaType !== "tv") {
    const { data, error } = await supabase.from("media_sources").select(columns).eq("media_id", String(tmdbId)).limit(50);
    if (error) throw error;
    return data || [];
  }

  const sPadded = String(season).padStart(2, "0");
  const ePadded = String(episode).padStart(2, "0");
  const exactIds = [`${tmdbId}-s${sPadded}e${ePadded}`, `${tmdbId}-s${season}e${episode}`];
  const { data: exact, error } = await supabase.from("media_sources").select(columns).in("media_id", exactIds).limit(50);
  if (error) throw error;

  // Season-level rows: show id, or any row of the same season (packs are stored per episode).
  const { data: seasonRows } = await supabase
    .from("media_sources")
    .select(columns)
    .or(`media_id.eq.${tmdbId},media_id.ilike.${tmdbId}-s${sPadded}%`)
    .limit(200);

  const seen = new Set();
  return [...(exact || []), ...(seasonRows || [])].filter((row) => {
    const key = row.magnet_link || row.download_url || row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Annotate, filter, and rank rows for the requested audio and quality. */
function rankCandidates(rows, { mediaType, season, episode, audio, quality, qualityOrder }) {
  const hindiOnly = wantsHindiAudio(audio);
  const candidates = [];
  for (const row of rows) {
    const name = releaseName(row);
    const scope = mediaType === "tv" ? episodeScope(name, season, episode) : "movie";
    if (scope === "other") continue;
    if (scope === "pack" && !packCoversSeason(name, season)) continue;
    const kind = hindiAudioKind(name);
    if (hindiOnly && !kind) continue;
    candidates.push({
      row,
      name,
      scope,
      kind,
      audioLabel: audioLabel(kind),
      quality: detectQuality(name, row.quality),
    });
  }

  const order = quality !== "auto" && quality ? [quality, ...qualityOrder.filter((q) => q !== quality)] : qualityOrder;
  const qRank = (q) => (order.indexOf(q) === -1 ? order.length : order.indexOf(q));
  const audioRank = (kind) => (kind === "dual" ? 0 : kind === "hindi" ? 1 : 2);
  const scopeRank = (scope) => (scope === "exact" ? 0 : 1);
  // Hindi first: a release whose Hindi track a phone can play beats a Dolby-only Dual release.
  const codecRank = (name) => (AAC_NAME_RE.test(name) ? 0 : DOLBY_NAME_RE.test(name) ? 2 : 1);

  return candidates.sort(
    (a, b) =>
      qRank(a.quality) - qRank(b.quality) ||
      codecRank(a.name) - codecRank(b.name) ||
      audioRank(a.kind) - audioRank(b.kind) ||
      scopeRank(a.scope) - scopeRank(b.scope)
  );
}

function candidateMagnet(row) {
  return row.magnet_link || (row.download_url?.startsWith("magnet:") ? row.download_url : null);
}

function directRowUrl(row) {
  const url = row.stream_url || "";
  return url && !url.includes("/api/media/stream/torrent/") ? url : null;
}

/**
 * Try candidates in rank order until one yields a playable TorBox link or direct URL.
 * For Hindi requests the file's own track list is read: a file whose Hindi track is
 * AC3/DTS (silent on most phones, so English plays) is kept only as a last resort.
 */
async function resolveFirstPlayable(candidates, { season, episode, isTv, hindi = false }) {
  let attempts = 0;
  let silentHindiFallback = null;
  for (const cand of candidates) {
    const direct = directRowUrl(cand.row);
    // A stored direct URL is only trusted for a TV episode when the release names that episode.
    if (direct && (!isTv || cand.scope === "exact")) {
      return { cand, streamUrl: direct, downloadUrl: cand.row.download_url || direct, torbox: null };
    }
    const magnet = candidateMagnet(cand.row);
    if (!magnet || attempts >= MAX_TORBOX_ATTEMPTS) continue;
    attempts += 1;
    try {
      const tb = await torboxService.resolveDirectTorboxStream(magnet, isTv
        ? { season, episode, singleEpisode: cand.scope === "exact" }
        : { fileName: cand.row.payload?.file_name || null });
      if (!tb || !tb.streamUrl) continue;
      const resolved = { cand, streamUrl: tb.streamUrl, downloadUrl: tb.downloadUrl, torbox: tb, audioProbe: null };
      if (!hindi) return resolved;
      resolved.audioProbe = await probeHindiAudio(tb.streamUrl, tb.fileName);
      if (!resolved.audioProbe || resolved.audioProbe.hindiPlayable) return resolved;
      console.warn(`[streamApiController] Hindi track not phone-playable (${resolved.audioProbe.hindi.map((t) => t.codec).join(",") || "none"}): ${cand.name}`);
      silentHindiFallback ||= resolved;
    } catch (tbErr) {
      console.warn("[streamApiController] TorBox resolution skipped:", tbErr.message);
    }
  }
  return silentHindiFallback;
}

function describeCandidate(cand, resolved) {
  const tb = resolved?.torbox;
  return {
    quality: cand.quality || null,
    audio: cand.audioLabel,
    releaseName: cand.name,
    fileName: tb?.fileName || null,
    fileSize: tb?.fileSize || (cand.scope === "pack" ? null : Number(cand.row.size_bytes) || null),
    // Index among the file's audio tracks, for the player to select Hindi; null when unknown.
    hindiAudioTrack: resolved?.audioProbe?.hindi?.[0] || null,
    hindiAudioPlayable: resolved?.audioProbe ? resolved.audioProbe.hindiPlayable : null,
    audioTracks: resolved?.audioProbe?.tracks || null,
  };
}

/**
 * Controller for:
 * 1. GET /api/stream/:tmdbId
 * 2. GET /api/stream/manifest/:tmdbId
 * 3. GET /api/download/:tmdbId
 */

function buildProviderUrls(tmdbId, mediaType, season = 1, episode = 1) {
  const isTv = mediaType === "tv";
  const id = encodeURIComponent(tmdbId);

  // 1. MultiEmbed: Comprehensive Indian/Regional/Global coverage with 10+ mirror hosts (StreamWish, Filelions, etc.)
  const multiEmbedUrl = isTv
    ? `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=1&s=${season}&e=${episode}`
    : `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=1`;

  // 2. VidSrc: Global CDN player with broad coverage
  const vidSrcUrl = isTv
    ? `https://vidsrc.to/embed/tv/${id}/${season}/${episode}?autoplay=1`
    : `https://vidsrc.to/embed/movie/${id}?autoplay=1`;

  // 3. SmashyStream: High-speed embed player
  const smashyUrl = isTv
    ? `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${season}&episode=${episode}`
    : `https://embed.smashystream.com/playere.php?tmdb=${id}`;

  // 4. VidLink: Clean, fast, zero Cloudflare captcha, ad-free UI, instant autoplay
  const vidLinkUrl = isTv
    ? `https://vidlink.pro/tv/${id}/${season}/${episode}?primaryColor=E50914&autoplay=true`
    : `https://vidlink.pro/movie/${id}?primaryColor=E50914&autoplay=true`;

  // 5. 2Embed: Reliable fallback with high uptime
  const twoEmbedUrl = isTv
    ? `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`
    : `https://www.2embed.cc/embed/${id}`;

  return [
    { name: 'Server 1 (MultiCloud - 99% Hit Rate)', url: multiEmbedUrl },
    { name: 'Server 2 (VidSrc - Global)', url: vidSrcUrl },
    { name: 'Server 3 (Smashy - Fast)', url: smashyUrl },
    { name: 'Server 4 (VidLink - Clean HD)', url: vidLinkUrl },
    { name: 'Server 5 (2Embed - Stable)', url: twoEmbedUrl },
  ];
}

const getStream = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;
  const audio = String(req.query.audio || "hi").toLowerCase();
  const quality = String(req.query.quality || "auto").toLowerCase();

  if (!tmdbId) {
    return res.status(400).json({ success: false, error: "Missing tmdbId" });
  }

  // Set explicit media streaming & CORS headers on every response
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.header("Content-Type", "application/json; charset=utf-8");

  // Step 1: Check In-Memory Cache (1-Hour TTL) to prevent DB over-limit
  const cacheKey = `stream:${tmdbId}:${mediaType}:${season}:${episode}:${audio}:${quality}`;
  const cachedStream = memoryCache.get(cacheKey);
  if (cachedStream) {
    return res.json({ ...cachedStream, cached: true });
  }

  const supabase = getSupabaseClient();
  const isTv = mediaType === "tv";
  let directStreamUrl = null;
  let directDownloadUrl = null;
  let torrentMagnet = null;
  let resolved = null;
  let candidates = [];

  // Step 2: Rank real Hindi / Dual Audio releases for this exact movie or episode (lowest quality first)
  if (supabase) {
    try {
      const rows = await loadSourceRows(supabase, tmdbId, mediaType, season, episode);
      candidates = rankCandidates(rows, { mediaType, season, episode, audio, quality, qualityOrder: STREAM_QUALITY_ORDER });
      resolved = await resolveFirstPlayable(candidates, { season, episode, isTv, hindi: wantsHindiAudio(audio) });
      if (resolved) {
        directStreamUrl = resolved.streamUrl;
        directDownloadUrl = resolved.downloadUrl;
        torrentMagnet = candidateMagnet(resolved.cand.row);
      } else {
        torrentMagnet = candidates.map((c) => candidateMagnet(c.row)).find(Boolean) || null;
      }
    } catch (e) {
      console.warn("[streamApiController] Supabase query failed:", e.message);
    }
  }

  // Step 3: Multi-Provider Fallback (MultiEmbed -> VidSrc -> VidLink -> 2Embed)
  const providers = buildProviderUrls(tmdbId, mediaType, season, episode);

  if (!directStreamUrl) {
    // MultiEmbed is default primary because it has 99.8% hit rate on Hindi/Indian/Global titles
    directStreamUrl = providers[0].url;
    directDownloadUrl = providers[0].url;
  }

  const responsePayload = {
    success: true,
    streamUrl: directStreamUrl,
    torrentMagnet: torrentMagnet || null,
    backupStreams: providers,
    defaultAudio: "hi",
    availableAudios: [
      { label: "Hindi", code: "hi" },
      { label: "English", code: "en" },
      { label: "Original", code: "orig" },
    ],
    // Only qualities that really exist for this title / episode in the requested audio
    qualities: candidates.length
      ? ["auto", ...STREAM_QUALITY_ORDER.filter((q) => q && candidates.some((c) => c.quality === q))]
      : ["auto"],
    selected: resolved ? describeCandidate(resolved.cand, resolved) : null,
  };

  // Step 4: Save in Memory Cache
  // If direct TorBox 1Gbps stream is resolved, cache for 2 Hours (matches TorBox link expiry)
  // If temporary fallback was used because TorBox is still downloading, cache for only 30 seconds so it switches to TorBox as soon as it's ready!
  const isDirectTorbox = Boolean(resolved?.torbox);
  const cacheTtl = isDirectTorbox ? 2 * 60 * 60 * 1000 : 30 * 1000;
  memoryCache.set(cacheKey, responsePayload, cacheTtl);

  return res.json(responsePayload);
});

const getManifest = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  if (!tmdbId) {
    return res.status(400).send("#EXTM3U\n#EXT-X-ERROR: Missing tmdbId\n");
  }

  const providers = buildProviderUrls(tmdbId, mediaType, season, episode);
  return res.redirect(302, providers[0].url);
});

const getDownload = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;
  const audio = String(req.query.audio || "hi").toLowerCase();
  const quality = String(req.query.quality || "auto").toLowerCase();

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.header("Content-Type", "application/json; charset=utf-8");

  const cacheKey = `download:${tmdbId}:${mediaType}:${season}:${episode}:${audio}:${quality}`;
  const cachedDownload = memoryCache.get(cacheKey);
  if (cachedDownload) {
    return res.json({ ...cachedDownload, cached: true });
  }

  const supabase = getSupabaseClient();
  const isTv = mediaType === "tv";
  let downloadUrl = null;
  let torrentMagnet = null;
  let resolved = null;

  // Same release checks as streaming, with the requested episode passed to TorBox
  if (supabase) {
    try {
      const rows = await loadSourceRows(supabase, tmdbId, mediaType, season, episode);
      const candidates = rankCandidates(rows, { mediaType, season, episode, audio, quality, qualityOrder: DOWNLOAD_QUALITY_ORDER });
      resolved = await resolveFirstPlayable(candidates, { season, episode, isTv, hindi: wantsHindiAudio(audio) });
      if (resolved) {
        downloadUrl = resolved.downloadUrl;
        torrentMagnet = candidateMagnet(resolved.cand.row);
      } else {
        torrentMagnet = candidates.map((c) => candidateMagnet(c.row)).find(Boolean) || null;
      }
    } catch (e) {
      console.warn("[streamApiController] Download source lookup failed:", e.message);
    }
  }

  const providers = buildProviderUrls(tmdbId, mediaType, season, episode);

  if (!downloadUrl) {
    downloadUrl = providers[0].url;
  }

  const downloadPayload = {
    success: true,
    downloadUrl,
    torrentMagnet: torrentMagnet || null,
    backupDownloads: providers,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    supportsResume: true,
    selected: resolved ? describeCandidate(resolved.cand, resolved) : null,
  };

  const isDirectTbDownload = Boolean(resolved?.torbox);
  const dlCacheTtl = isDirectTbDownload ? 2 * 60 * 60 * 1000 : 30 * 1000;
  memoryCache.set(cacheKey, downloadPayload, dlCacheTtl);

  return res.json(downloadPayload);
});

module.exports = {
  getStream,
  getManifest,
  getDownload,
};
