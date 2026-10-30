"use strict";

const { asyncHandler, HttpError } = require("../utils/http");
const {
  findReadyDownload,
  saveCachedSource,
  listCachedSources,
  listPlayableCatalog,
  canonicalLanguage,
  canonicalQuality,
  isUnreleasedTitle,
  loadReleaseFacts,
  findCachedTorrent,
  saveTorrentRelease,
} = require("../services/mediaSourceService");
const { resolveDownloadLinks, buildRegionalQueries, confirmFullMovie } = require("../services/streamResolver");
const { isReadyVideoFile } = require("../services/videoFile");
const { normalizeSourceLinks, discoverCascadingTorrents, publicSize } = require("../services/torrentResolver");
const { buildTorrentStreamUrl, extractInfoHash, getEngineEpisodeFile } = require("../services/torrentStreamEngine");
const { memoryCache } = require("../services/memoryCache");

const FAST_BUDGET_MS = 6000;
const UNRELEASED_ERROR = "Title is unreleased. Torrents are not yet available.";

function readBody(req) {
  const body = req.body || {};
  return {
    mediaId: body.media_id ?? body.mediaId ?? body.tmdb_id ?? body.tmdbId ?? null,
    imdbId: body.imdb_id ?? body.imdbId ?? null,
    title: String(body.title || "").trim(),
    year: body.year ?? "",
    language: body.requested_lang ?? body.language ?? "all",
    quality: body.requested_quality ?? body.quality ?? "all",
    userId: body.user_id ?? body.userId ?? null,
    mediaType: body.media_type ?? body.mediaType ?? null,
    season: body.season ?? null,
    episode: body.episode ?? null,
    industry: body.industry ?? body.origin ?? "",
    country: body.country ?? body.origin_country ?? "",
    originalLanguage: body.original_language ?? body.originalLanguage ?? "",
  };
}

function presentTorrent(req, source, { cached = false, requestId = null } = {}) {
  const links = normalizeSourceLinks({ ...source, source_type: "torrent" });
  const size = publicSize(source);
  const magnet = links.magnet_link || links.download_url;
  const epNum = source.payload?.episode ?? source.episode ?? req?.body?.episode ?? req?.query?.episode ?? (String(source.media_id).match(/(?:-s\d+e|:e)(\d+)/i)?.[1]) ?? null;
  const seasonNum = source.payload?.season ?? source.season ?? req?.body?.season ?? req?.query?.season ?? (String(source.media_id).match(/(?:-s|:s)(\d+)/i)?.[1]) ?? null;

  const bridgeDownloadUrl = buildTorrentStreamUrl(req, { magnet, isDownload: true, episode: epNum, season: seasonNum });
  const bridgeStreamUrl = buildTorrentStreamUrl(req, { magnet, isDownload: false, episode: epNum, season: seasonNum });

  let epSizeBytes = size.size_bytes;
  let epSizeHuman = size.size_human;

  const isSingleEpRow = source.payload?.episode != null || /-s\d+e\d+/i.test(source.mediaId || source.media_id || "");
  const exactFile = epNum ? getEngineEpisodeFile(magnet, epNum, seasonNum) : null;
  if (exactFile && exactFile.length > 0) {
    epSizeBytes = exactFile.length;
    epSizeHuman = (exactFile.length / (1024 * 1024 * 1024) >= 1)
      ? `${(exactFile.length / (1024 * 1024 * 1024)).toFixed(1)} GB`
      : `${Math.round(exactFile.length / (1024 * 1024))} MB`;
  } else if (!isSingleEpRow && epNum && epSizeBytes && epSizeBytes > 5 * 1024 * 1024 * 1024) {
    const estCount = Number(source.payload?.episode_count) || 10;
    const approx = Math.round(epSizeBytes / Math.max(1, estCount));
    epSizeBytes = approx;
    epSizeHuman = approx >= 1024 * 1024 * 1024
      ? `~${(approx / (1024 * 1024 * 1024)).toFixed(1)} GB`
      : `~${Math.round(approx / (1024 * 1024))} MB`;
  }

  return {
    success: true,
    ok: true,
    status: "ready",
    source_type: "ddl",
    cached: Boolean(cached),
    quality: source.quality || "",
    language: source.language_label || source.language || "",
    seeders: source.seeders == null ? 0 : Number(source.seeders),
    size_bytes: epSizeBytes,
    size_human: epSizeHuman,
    size: epSizeHuman,
    download_url: bridgeDownloadUrl || links.download_url,
    magnet_link: links.magnet_link,
    stream_url: bridgeStreamUrl || links.stream_url,
    ...(requestId ? { request_id: requestId } : {}),
  };
}

function presentReady(source, { cached = false, requestId = null } = {}) {
  const links = normalizeSourceLinks(source);
  const size = publicSize(source);
  const fileUrl = isReadyVideoFile(source) ? source.download_url || source.stream_url : links.download_url;
  return {
    success: true,
    ok: true,
    status: source.source_type === "embed_stream" ? source.status || "ready" : "ready",
    source_type: links.source_type || "ddl",
    download_url: fileUrl,
    magnet_link: links.magnet_link,
    stream_url: source.source_type === "embed_stream" ? links.stream_url : fileUrl,
    size_bytes: size.size_bytes,
    size_human: size.size_human,
    size: size.size,
    quality: source.quality || source.resolution || "",
    language: source.language_label || source.language || "",
    seeders: source.seeders == null ? 0 : Number(source.seeders),
    cached: Boolean(cached),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

/** POST /api/media/download-source and /api/media/request-download */
const downloadSource = asyncHandler(async (req, res) => {
  const { mediaId, imdbId, title, year, language, quality, userId, mediaType, season, episode } = readBody(req);
  if (!title) {
    throw new HttpError(400, "Body field `title` is required", "MISSING_TITLE");
  }

  const sNum = Number(season);
  const eNum = Number(episode);
  const isEpisode = Number.isInteger(sNum) && sNum > 0 && Number.isInteger(eNum) && eNum > 0;
  const targetSeason = isEpisode ? sNum : null;
  const targetEpisode = isEpisode ? eNum : null;

  const languageKey = canonicalLanguage(language);
  const qualityKey = canonicalQuality(quality);
  const targetId = mediaId || imdbId || null;
  const cacheParams = {
    mediaId: targetId,
    imdbId,
    title,
    year,
    language: languageKey,
    quality: qualityKey,
    mediaType: isEpisode ? "tv" : mediaType,
    season: targetSeason,
    episode: targetEpisode,
  };

  try {
    const cachedTorrent = await findCachedTorrent(cacheParams);
    if (cachedTorrent) return res.json(presentTorrent(req, cachedTorrent, { cached: true }));
    const cached = await findReadyDownload(cacheParams);
    if (isReadyVideoFile(cached, mediaType)) {
      const confirmed = await confirmFullMovie(cached, { mediaType: isEpisode ? "tv" : mediaType });
      if (confirmed) return res.json(presentReady(confirmed, { cached: true }));
    }
  } catch (error) {
    console.warn("[download-source] cache lookup failed:", error.message);
  }

  const facts = await loadReleaseFacts({ mediaId: targetId, title, year });
  if (isUnreleasedTitle({ year: facts.year || year, releaseDate: facts.releaseDate })) {
    return res.status(400).json({ success: false, ok: false, error: UNRELEASED_ERROR });
  }

  try {
    const epCode = isEpisode ? `S${String(sNum).padStart(2, "0")}E${String(eNum).padStart(2, "0")}` : null;
    const searchQueries = isEpisode
      ? [
          `${title} ${epCode} Hindi`,
          `${title} ${epCode} Dual Audio`,
          `${title} ${epCode}`,
        ]
      : buildRegionalQueries(title).slice(0, 2);

    const resolved = await resolveDownloadLinks(title, year, language, quality, {
      userId,
      mediaId: targetId,
      tmdbId: mediaId,
      imdbId,
      mediaType: isEpisode ? "tv" : mediaType,
      season: targetSeason,
      episode: targetEpisode,
      skipCache: true,
      skipQueue: true,
      budgetMs: FAST_BUDGET_MS,
      queries: searchQueries,
    });

    if (resolved?.status === "ready" && resolved?.source_type === "torrent" && resolved.magnet_link) {
      let storedTorrent = resolved;
      try {
        storedTorrent = (await saveTorrentRelease(cacheParams, resolved)) || resolved;
      } catch (error) {
        console.warn("[download-source] torrent cache write failed:", error.message);
      }
      const videoCandidate = isReadyVideoFile(resolved, mediaType) ? await confirmFullMovie(resolved, { mediaType }) : null;
      if (videoCandidate) {
        return res.json(presentReady(videoCandidate));
      }
      return res.json(presentTorrent(req, storedTorrent));
    }

    const confirmed = resolved?.probed && isReadyVideoFile(resolved, mediaType)
      ? resolved
      : isReadyVideoFile(resolved, mediaType)
        ? await confirmFullMovie(resolved, { mediaType })
        : null;
    if (confirmed) {
      const storedQuality = canonicalQuality(confirmed.quality || confirmed.resolution || qualityKey);
      const detectedLanguage = confirmed.language_label || confirmed.language;
      const storedLanguage = ["Hindi", "Urdu", "Dual Audio [Hindi+Eng]", "English"].includes(detectedLanguage)
        ? detectedLanguage
        : languageKey;
      let stored = confirmed;
      try {
        stored = (await saveCachedSource({ ...cacheParams, language: storedLanguage, quality: storedQuality }, confirmed)) || confirmed;
      } catch (error) {
        console.warn("[download-source] cache write failed:", error.message);
      }
      const video = isReadyVideoFile(stored, mediaType) ? stored : confirmed;
      return res.json(presentReady(video));
    }

    return res.status(200).json({
      success: false,
      ok: false,
      status: "failed",
      error: "No direct video file found.",
    });
  } catch (error) {
    throw error;
  }
});

/** GET /api/media/sources — list cached torrent / DDL links. */
const getMediaSources = asyncHandler(async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  const mediaId = req.params?.mediaId ?? req.query?.media_id ?? req.query?.mediaId ?? null;
  const title = req.query?.title ?? req.query?.q ?? "";
  const season = req.query?.season ?? null;
  const episode = req.query?.episode ?? null;
  const language = req.query?.language ?? req.query?.lang ?? "";
  const quality = req.query?.quality ?? "";

  // In-Memory Cache Lookup (1-Hour TTL) to prevent Supabase over-limit loop
  const cacheKey = `media_sources:${mediaId || ""}:${title || ""}:${season || ""}:${episode || ""}:${language || ""}:${quality || ""}`;
  const cachedResult = memoryCache.get(cacheKey);
  if (cachedResult) {
    return res.json({ ...cachedResult, inMemoryCached: true });
  }

  let rawItems = [];
  try {
    rawItems = await listCachedSources({
      mediaId,
      title,
      language,
      quality,
      limit: req.query?.limit,
      season,
      episode,
    });
  } catch (dbErr) {
    console.warn("[getMediaSources] DB query busy or error:", dbErr.message);
  }
  const items = (rawItems || []).map((item) => {
    const magnet = item.magnet_link || (/^magnet:/i.test(item.download_url) ? item.download_url : null);
    if (magnet) {
      const epNum = item.payload?.episode ?? item.episode ?? req.query?.episode ?? (String(item.media_id).match(/(?:-s\d+e|:e)(\d+)/i)?.[1]) ?? null;
      const seasonNum = item.payload?.season ?? item.season ?? req.query?.season ?? (String(item.media_id).match(/(?:-s|:s)(\d+)/i)?.[1]) ?? null;
      const bridgeDownloadUrl = buildTorrentStreamUrl(req, { magnet, isDownload: true, episode: epNum, season: seasonNum });
      const bridgeStreamUrl = buildTorrentStreamUrl(req, { magnet, isDownload: false, episode: epNum, season: seasonNum });
      const infoHash = extractInfoHash(magnet);
      const webtorStreamUrl = infoHash ? `https://webtor.io/show?torrent=${encodeURIComponent(magnet)}` : null;
      const webtorDdlUrl = infoHash ? `https://webtor.io/${infoHash}?tool=magnet-to-ddl` : null;

      let epSizeBytes = item.size_bytes;
      let epSizeHuman = item.size_human;
      const isSingleEpRow = item.payload?.episode != null || /-s\d+e\d+/i.test(item.mediaId || item.media_id || "");
      const exactFile = epNum ? getEngineEpisodeFile(magnet, epNum, seasonNum) : null;
      if (exactFile && exactFile.length > 0) {
        epSizeBytes = exactFile.length;
        epSizeHuman = (exactFile.length / (1024 * 1024 * 1024) >= 1)
          ? `${(exactFile.length / (1024 * 1024 * 1024)).toFixed(1)} GB`
          : `${Math.round(exactFile.length / (1024 * 1024))} MB`;
      } else if (!isSingleEpRow && epNum && epSizeBytes && epSizeBytes > 5 * 1024 * 1024 * 1024) {
        const estCount = Number(item.payload?.episode_count) || 10;
        const approx = Math.round(epSizeBytes / Math.max(1, estCount));
        epSizeBytes = approx;
        epSizeHuman = approx >= 1024 * 1024 * 1024
          ? `~${(approx / (1024 * 1024 * 1024)).toFixed(1)} GB`
          : `~${Math.round(approx / (1024 * 1024))} MB`;
      }

      return {
        ...item,
        size_bytes: epSizeBytes,
        size_human: epSizeHuman,
        size: epSizeHuman,
        source_type: "ddl",
        download_url: bridgeDownloadUrl || item.download_url,
        stream_url: bridgeStreamUrl || item.stream_url || bridgeDownloadUrl,
        webtor_url: webtorDdlUrl,
        webtor_stream_url: webtorStreamUrl,
        magnet_link: magnet,
      };
    }
    return item;
  });

  // Cloud player as the last fallback, after every real Hindi release. Its audio is whatever
  // the player has (mostly English) and its quality is not known, so it is labelled as such.
  if (mediaId && !isNaN(Number(mediaId))) {
    const isTv = (season && Number(season) > 0) || (episode && Number(episode) > 0);
    const cleanStreamUrl = isTv
      ? `https://vidlink.pro/tv/${encodeURIComponent(mediaId)}/${season || 1}/${episode || 1}?primaryColor=E50914&autoplay=true`
      : `https://vidlink.pro/movie/${encodeURIComponent(mediaId)}?primaryColor=E50914&autoplay=true`;

    items.push({
      id: `cloud-${mediaId}`,
      media_id: String(mediaId),
      media_title: title || "HD Cloud Stream",
      language: "Original",
      language_label: "Original",
      quality: "auto",
      source_type: "embed_stream",
      stream_url: cleanStreamUrl,
      download_url: isTv
        ? `https://vidlink.pro/tv/${encodeURIComponent(mediaId)}/${season || 1}/${episode || 1}`
        : `https://vidlink.pro/movie/${encodeURIComponent(mediaId)}`,
      status: "ready",
      size_human: "Instant HD",
      size: "Instant HD",
    });
  }

  const responsePayload = {
    ok: true,
    cached: true,
    source: "supabase",
    total: items.length,
    items,
  };

  // Cache in memory for 1 Hour (3600000 ms)
  memoryCache.set(cacheKey, responsePayload, 3600000);

  return res.json(responsePayload);
});

/** GET /api/media/catalog — only titles with a Hindi, Dual, English, or Urdu download. */
const getPlayableCatalog = asyncHandler(async (req, res) => {
  const type = String(req.query.type || req.query.media_type || "").trim().toLowerCase();
  const payload = await listPlayableCatalog({
    mediaType: type === "movie" || type === "tv" || type === "series" ? type : "",
    page: req.query.page,
    limit: req.query.limit,
    genres: req.query.genres || req.query.genre || req.query.interest || "",
  });
  return res.json({ ok: true, source: "supabase", ...payload });
});

/** POST /api/media/resolve-source — cascade search, then HTTP 200 with a magnet or an embed. */
const resolveSource = asyncHandler(async (req, res) => {
  const { mediaId, imdbId, title, year, language, quality, mediaType, season, episode, industry, country, originalLanguage } = readBody(req);
  if (!title) {
    throw new HttpError(400, "Body field `title` is required", "MISSING_TITLE");
  }

  const languageKey = canonicalLanguage(language);
  const qualityKey = canonicalQuality(quality);
  const targetId = mediaId || imdbId || null;
  const cacheParams = { mediaId: targetId, imdbId, title, year, language: languageKey, quality: qualityKey, mediaType };

  try {
    const cachedTorrent = await findCachedTorrent(cacheParams);
    if (cachedTorrent?.download_url || cachedTorrent?.magnet_link) {
      return res.status(200).json(presentTorrent(req, cachedTorrent, { cached: true }));
    }
  } catch (error) {
    console.warn("[resolve-source] cache lookup failed:", error.message);
  }

  const found = await discoverCascadingTorrents({
    title,
    year,
    mediaType,
    industry,
    country,
    originalLanguage,
    imdbId,
    tmdbId: mediaId,
    season,
    episode,
  });

  if (found?.source_type === "torrent" && found.status === "ready" && found.magnet_link) {
    try {
      await saveTorrentRelease(cacheParams, found);
    } catch (error) {
      console.warn("[resolve-source] torrent cache write failed:", error.message);
    }
    return res.status(200).json(presentTorrent(req, found));
  }

  const stream = found?.stream_url || null;
  return res.status(200).json({
    success: Boolean(stream),
    source_type: "embed_stream",
    status: stream ? "ready" : "failed",
    download_url: stream,
    magnet_link: null,
    stream_url: stream,
    quality: found?.quality || "",
    size_human: found?.size_human || "",
    seeders: 0,
    ...(found?.error && !stream ? { error: found.error } : {}),
  });
});

module.exports = { downloadSource, resolveSource, getMediaSources, getPlayableCatalog, presentTorrent };
