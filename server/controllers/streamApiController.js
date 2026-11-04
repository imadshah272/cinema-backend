"use strict";

const axios = require("axios");
const { getSupabaseClient } = require("../services/supabaseClient");
const { asyncHandler } = require("../utils/http");
const { memoryCache } = require("../services/memoryCache");
const torboxService = require("../services/torboxService");
const { releaseName, hindiAudioKind, audioLabel, detectQuality, deviceCompatPenalty, episodeScope, packCoversSeason } = require("../services/releaseAudio");
const { probeHindiAudio } = require("../services/audioTrackProbe");
const remuxService = require("../services/remuxService");

// Streaming starts small so playback begins fast on slow connections.
const STREAM_QUALITY_ORDER = ["480p", "720p", "1080p", "2160p", "360p", ""];
const DOWNLOAD_QUALITY_ORDER = ["720p", "1080p", "480p", "2160p", "360p", ""];
const MAX_TORBOX_ATTEMPTS = 4;
/** Release names that say the audio is AAC usually carry a phone-playable Hindi track. */
const AAC_NAME_RE = /\baac\b|\bhe-aac\b/i;
/** Dolby / DTS audio: skipped by most Android phones, so Hindi would be silent. */
const DOLBY_NAME_RE = /\b(dd\+?|ddp|ac3|eac3|e-ac-3|dts|truehd|atmos)\s*[\d.]*/i;
const CAM_PRINT_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|pre[ ._-]?dvd|dvdscr|hdtscr|screener|hqcam)\b/i;

function wantsHindiAudio(audio) {
  return /^(hi|hin|hindi|dual|ur|urdu)$/i.test(String(audio || ""));
}

/**
 * Load media_sources rows for a movie, or for one TV episode.
 * Episode rows are exact (tmdbId-sXXeYY) first; season-level rows are only
 * kept when their release is a pack, never another episode's single file.
 */
async function loadSourceRows(supabase, tmdbId, mediaType, season, episode) {
  const columns = "id, media_id, media_title, stream_url, download_url, magnet_link, language, quality, source_type, size_bytes, seeders, payload";
  // Rows hidden by scripts/repairMediaSources.js (wrong film, 4K, wrong season ...) are never served.
  const ready = () => supabase.from("media_sources").select(columns).eq("status", "ready");
  if (mediaType !== "tv") {
    const { data, error } = await ready().eq("media_id", String(tmdbId)).limit(50);
    if (error) throw error;
    return data || [];
  }

  const sPadded = String(season).padStart(2, "0");
  const ePadded = String(episode).padStart(2, "0");
  const exactIds = [`${tmdbId}-s${sPadded}e${ePadded}`, `${tmdbId}-s${season}e${episode}`];
  const { data: exact, error } = await ready().in("media_id", exactIds).limit(50);
  if (error) throw error;

  // Season-level rows: show id, or any row of the same season (packs are stored per episode).
  const { data: seasonRows } = await ready()
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
    // A row stored for exactly this episode was matched to its file when it was ingested. Its file name
    // often carries the episode tag the torrent name lacks ("...S01E01.mkv"), and its release name may not
    // say which season it is (many Hindi shows), so neither rejects it.
    const ownRow = mediaType === "tv" && new RegExp(`-s0*${season}e0*${episode}$`, "i").test(row.media_id || "");
    const scopeName = ownRow ? `${name} ${row.payload?.file_name || ""}` : name;
    const scope = mediaType === "tv" ? episodeScope(scopeName, season, episode) : "movie";
    if (scope === "other") continue;
    if (scope === "pack" && !ownRow && !packCoversSeason(scopeName, season)) continue;
    const kind = hindiAudioKind(name, row.payload?.original_language);
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
  // A clean print (WEB-DL / BluRay) replaces a cinema print as soon as one is stored.
  const camRank = (name) => (CAM_PRINT_RE.test(name) ? 1 : 0);

  return candidates.sort(
    (a, b) =>
      qRank(a.quality) - qRank(b.quality) ||
      camRank(a.name) - camRank(b.name) ||
      // Within a quality tier: the release a phone can actually decode comes first.
      deviceCompatPenalty(a.name) - deviceCompatPenalty(b.name) ||
      codecRank(a.name) - codecRank(b.name) ||
      audioRank(a.kind) - audioRank(b.kind) ||
      scopeRank(a.scope) - scopeRank(b.scope) ||
      (Number(b.row.seeders) || 0) - (Number(a.row.seeders) || 0)
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
async function resolveFirstPlayable(candidates, { season, episode, isTv, hindi = false, anyCodec = false }) {
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
      // A pack row's file_name names the file of the row's own episode, so it is only a
      // hint when the row belongs to the requested episode.
      const ownRow = !isTv || new RegExp(`-s0*${season}e0*${episode}$`, "i").test(cand.row.media_id || "");
      const tb = await torboxService.resolveDirectTorboxStream(magnet, {
        ...(isTv ? { season, episode, singleEpisode: cand.scope === "exact" } : {}),
        fileName: ownRow ? cand.row.payload?.file_name || null : null,
      });
      if (!tb || !tb.streamUrl) continue;
      const resolved = { cand, streamUrl: tb.streamUrl, downloadUrl: tb.downloadUrl, torbox: tb, audioProbe: null };
      if (!hindi) return resolved;
      resolved.audioProbe = await probeHindiAudio(tb.streamUrl, tb.fileName);
      if (!resolved.audioProbe || resolved.audioProbe.hindiPlayable) return resolved;
      // The app plays through libVLC, which decodes any codec: a file that has a Hindi track is fine as is.
      if (anyCodec && resolved.audioProbe.hindi.length > 0) return resolved;
      // H.264 video with a Hindi track the phone cannot decode (AC3 / E-AC3 / DTS): the server
      // converts just that audio to AAC (video copied), so the file plays instead of erroring.
      const probe = resolved.audioProbe;
      if (probe.videoCodec === "AVC" && probe.hindi.length > 0 && remuxService.isAvailable()) {
        resolved.remux = { audioIndex: probe.hindi[0].index };
        return resolved;
      }
      console.warn(`[streamApiController] Hindi track not phone-playable (${resolved.audioProbe.hindi.map((t) => t.codec).join(",") || "none"}): ${cand.name}`);
      silentHindiFallback ||= resolved;
    } catch (tbErr) {
      console.warn("[streamApiController] TorBox resolution skipped:", tbErr.message);
    }
  }
  return silentHindiFallback;
}

/**
 * Stream / download URLs of this server's own torrent engine for a row's magnet.
 * Season and episode are added so a pack serves the requested episode's file.
 */
function buildTorrentBridgeUrls(req, row, { isTv, season, episode }) {
  const magnet = candidateMagnet(row);
  const hash = torboxService.extractInfoHash(magnet) || torboxService.extractInfoHash(row.stream_url);
  if (!hash) return null;
  const base = (process.env.SERVER_BASE_URL || process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const q = new URLSearchParams();
  if (magnet) q.set("magnet", magnet);
  if (isTv) {
    q.set("s", String(season));
    q.set("ep", String(episode));
  }
  const query = q.toString();
  return {
    streamUrl: `${base}/api/media/stream/torrent/${hash}/video.mp4${query ? `?${query}` : ""}`,
    downloadUrl: `${base}/api/media/download/torrent/${hash}/video.mp4?download=1${query ? `&${query}` : ""}`,
  };
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

/**
 * Cloud fallback pages (only sent while TorBox is still caching a title). The app opens one in a
 * hidden WebView, intercepts the real .m3u8 / .mp4 and plays it in the NATIVE player; it switches
 * to TorBox as soon as TorBox is ready.
 */
function buildFallbackStreams(tmdbId, mediaType, season = 1, episode = 1) {
  const isTv = mediaType === "tv";
  const id = encodeURIComponent(tmdbId);
  return [
    { name: "Cloud 1", url: isTv ? `https://vidsrc.to/embed/tv/${id}/${season}/${episode}` : `https://vidsrc.to/embed/movie/${id}` },
    { name: "Cloud 2", url: isTv ? `https://vidlink.pro/tv/${id}/${season}/${episode}?autoplay=true` : `https://vidlink.pro/movie/${id}?autoplay=true` },
    { name: "Cloud 3", url: isTv ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}` : `https://multiembed.mov/?video_id=${id}&tmdb=1` },
    { name: "Cloud 4", url: isTv ? `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}` : `https://www.2embed.cc/embed/${id}` },
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
  const anyCodec = String(req.query.engine || "").toLowerCase() === "vlc";
  const cacheKey = `stream:${tmdbId}:${mediaType}:${season}:${episode}:${audio}:${quality}${anyCodec ? ":vlc" : ""}`;
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
      // No Hindi / Dual release stored for this title: play the original-audio release rather
      // than showing "Not available yet" (the player tells the user there is no Hindi track).
      const hindiMissing = candidates.length === 0 && wantsHindiAudio(audio);
      if (hindiMissing) {
        candidates = rankCandidates(rows, { mediaType, season, episode, audio: "any", quality, qualityOrder: STREAM_QUALITY_ORDER });
      }
      resolved = await resolveFirstPlayable(candidates, { season, episode, isTv, hindi: wantsHindiAudio(audio) && !hindiMissing, anyCodec });
      if (resolved) {
        directStreamUrl = resolved.streamUrl;
        directDownloadUrl = resolved.downloadUrl;
        torrentMagnet = candidateMagnet(resolved.cand.row);
        if (resolved.remux) {
          const base = (process.env.SERVER_BASE_URL || process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
          directStreamUrl = `${base}/api/media/remux?u=${encodeURIComponent(resolved.streamUrl)}&a=${resolved.remux.audioIndex}`;
        }
      } else {
        torrentMagnet = candidates.map((c) => candidateMagnet(c.row)).find(Boolean) || null;
      }
    } catch (e) {
      console.warn("[streamApiController] Supabase query failed:", e.message);
    }
  }

  // Step 2b: TorBox has not cached it yet. Start caching it now (only for a title a user opened)
  // and tell the app to wait: it polls this endpoint and starts the stream as soon as it is ready.
  if (!directStreamUrl && candidates.length) {
    // Try the best-ranked releases in turn: a dead swarm (stalled) moves on to the next release.
    let st = { state: "error" };
    const tried = new Set();
    for (const c of candidates) {
      const magnet = candidateMagnet(c.row);
      const hash = magnet && torboxService.extractInfoHash(magnet);
      if (!magnet || !hash || tried.has(hash)) continue;
      if (tried.size >= 3) break;
      tried.add(hash);
      st = await torboxService.ensureCaching(magnet).catch(() => ({ state: "error" }));
      if (st.state !== "stalled") break;
    }
    {
      if (st.state === "ready") {
        resolved = await resolveFirstPlayable(candidates, { season, episode, isTv, hindi: false });
        if (resolved) {
          directStreamUrl = resolved.streamUrl;
          directDownloadUrl = resolved.downloadUrl;
          torrentMagnet = candidateMagnet(resolved.cand.row);
        }
      } else if (st.state === "caching" || st.state === "busy" || st.state === "stalled") {
        const message =
          st.state === "busy"
            ? "Servers are busy preparing other movies. Please try again in a minute."
            : st.state === "stalled"
              ? "This movie is taking longer than usual to prepare. Please try again in a few minutes."
              : "Preparing this movie for you. Please wait 1-2 minutes.";
        return res.json({
          success: false,
          available: true,
          caching: true,
          state: st.state,
          progress: st.progress ?? 0,
          etaSeconds: st.etaSeconds ?? null,
          message,
          retryAfterSeconds: 8,
          streamUrl: null,
          // Played natively (via the app's hidden sniffer) while TorBox finishes caching.
          fallbackStreams: buildFallbackStreams(tmdbId, mediaType, season, episode),
          backupStreams: [],
          error: message,
        });
      }
    }
  }

  // Step 3: TorBox could not serve it (not cached yet / busy). Fall back to this server's own
  // torrent engine, which ExoPlayer plays natively. Web embed pages ("cloud player") are never served.
  if (!directStreamUrl) {
    // Prefer a candidate that has a magnet; the bridge URL is rebuilt from it so it always
    // names the requested episode (a bare bridge URL streams the pack's largest file).
    const torrentCand = candidates.find((c) => candidateMagnet(c.row) || c.row?.stream_url?.includes("/api/media/stream/torrent/"));
    if (torrentCand) {
      const bridge = buildTorrentBridgeUrls(req, torrentCand.row, { isTv, season, episode });
      if (bridge) {
        directStreamUrl = bridge.streamUrl;
        directDownloadUrl = bridge.downloadUrl;
        torrentMagnet = candidateMagnet(torrentCand.row);
        resolved = { cand: torrentCand, streamUrl: directStreamUrl, downloadUrl: directDownloadUrl, torbox: null };
        console.log(`[streamApiController] TorBox not ready; using native torrent engine stream for TMDB ${tmdbId}`);
      }
    }
  }

  const hasStream = Boolean(directStreamUrl);
  const responsePayload = {
    success: hasStream,
    available: hasStream,
    streamUrl: directStreamUrl,
    error: hasStream ? null : "No stream available for this title yet.",
    torrentMagnet: torrentMagnet || null,
    backupStreams: [],
    // Cloud pages the app falls back to (hidden sniffer -> native player) when the TorBox file is slow
    // to start or cannot be decoded on the phone (10-bit / HEVC / E-AC3 / REMUX).
    fallbackStreams: hasStream ? buildFallbackStreams(tmdbId, mediaType, season, episode) : [],
    deviceRisk: Boolean(resolved && !anyCodec && !resolved.remux && deviceCompatPenalty(resolved.cand.name) >= 3),
    remuxed: Boolean(resolved && resolved.remux),
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

/**
 * GET /api/series/:tmdbId/availability
 * Every season and episode of a series in ONE request: which episodes can be played, with the
 * quality / audio / size of the release the stream resolver would pick. Metadata only (no
 * TorBox calls), one light Supabase query, cached 10 minutes, so opening a series costs the
 * server almost nothing no matter how many seasons it has.
 */
const getSeriesAvailability = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  if (!/^\d+$/.test(String(tmdbId))) return res.status(400).json({ success: false, error: "Invalid tmdbId" });

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");

  const cacheKey = `series-availability:${tmdbId}`;
  const cachedPayload = memoryCache.get(cacheKey);
  if (cachedPayload) return res.json({ ...cachedPayload, cached: true });

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("media_sources")
    .select("media_id, quality, language, seeders, size_bytes, size_human, magnet_link, download_url, payload")
    .eq("status", "ready")
    .like("media_id", `${tmdbId}-s%`)
    .limit(3000);
  if (error) throw error;

  const byEpisode = new Map();
  for (const row of data || []) {
    const m = /-s(\d+)e(\d+)$/i.exec(row.media_id);
    if (!m) continue;
    const key = `${Number(m[1])}:${Number(m[2])}`;
    if (!byEpisode.has(key)) byEpisode.set(key, []);
    byEpisode.get(key).push(row);
  }

  const seasons = {};
  for (const [key, rows] of byEpisode) {
    const [season, episode] = key.split(":").map(Number);
    const args = { mediaType: "tv", season, episode, quality: "auto", qualityOrder: STREAM_QUALITY_ORDER };
    let ranked = rankCandidates(rows, { ...args, audio: "hi" });
    if (!ranked.length) ranked = rankCandidates(rows, { ...args, audio: "any" });
    const top = ranked[0];
    if (!top) continue;
    const bytes = Number(top.row.size_bytes) || 0;
    (seasons[season] ||= {})[episode] = {
      q: top.quality || null,
      a: top.kind === "dual" ? "dual" : top.kind === "hindi" ? "hindi" : "orig",
      sz: bytes > 0 && top.scope !== "pack" ? bytes : null,
      sh: top.scope !== "pack" ? top.row.size_human || null : null,
      c: top.row.payload?.torbox_cached === true ? 1 : 0,
    };
  }

  const payload = {
    success: true,
    tmdbId: String(tmdbId),
    seasons,
    episodeCount: Object.values(seasons).reduce((n, eps) => n + Object.keys(eps).length, 0),
  };
  memoryCache.set(cacheKey, payload, 10 * 60 * 1000);
  return res.json(payload);
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

  // Embed-player manifests are retired: playback is native only (TorBox / torrent engine).
  return res.status(410).send("#EXTM3U\n#EXT-X-ERROR: Embed manifests are no longer served. Use /api/stream/:tmdbId.\n");
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
      let candidates = rankCandidates(rows, { mediaType, season, episode, audio, quality, qualityOrder: DOWNLOAD_QUALITY_ORDER });
      const hindiMissing = candidates.length === 0 && wantsHindiAudio(audio);
      if (hindiMissing) {
        candidates = rankCandidates(rows, { mediaType, season, episode, audio: "any", quality, qualityOrder: DOWNLOAD_QUALITY_ORDER });
      }
      resolved = await resolveFirstPlayable(candidates, { season, episode, isTv, hindi: wantsHindiAudio(audio) && !hindiMissing });
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

  // TorBox could not serve it: use this server's torrent engine (never an embed page).
  if (!downloadUrl && torrentMagnet) {
    const bridge = buildTorrentBridgeUrls(req, { magnet_link: torrentMagnet }, { isTv, season, episode });
    downloadUrl = bridge?.downloadUrl || null;
  }

  if (!downloadUrl) {
    return res.json({ success: false, downloadUrl: null, error: "No download available for this title yet.", backupDownloads: [] });
  }

  const downloadPayload = {
    success: true,
    downloadUrl,
    torrentMagnet: torrentMagnet || null,
    backupDownloads: [],
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
  getSeriesAvailability,
  getManifest,
  getDownload,
};
