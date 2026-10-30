"use strict";

/**
 * TorBox Debrid Cloud Caching & Instant Streaming Service.
 *
 * Converts BitTorrent magnet links into high-speed, direct HTTPS streaming
 * and downloading URLs (up to 1-80 Gbps) with zero VPS bandwidth and zero seeder waits.
 */

const env = require("../config/env");
const { memoryCache } = require("./memoryCache");
const { episodeScope } = require("./releaseAudio");

const TORBOX_BASE_URL = "https://api.torbox.app/v1/api";

function getApiKey() {
  return env.torboxApiKey || process.env.TORBOX_API_KEY || "";
}

/**
 * Extract clean 40-character InfoHash from a magnet link or hash string.
 */
function extractInfoHash(magnetOrHash) {
  if (!magnetOrHash) return null;
  const str = String(magnetOrHash).trim();
  const hexMatch = str.match(/(?:urn:btih:)?([a-fA-F0-9]{40})/i);
  if (hexMatch) return hexMatch[1].toLowerCase();
  const b32Match = str.match(/(?:urn:btih:)?([a-zA-Z2-7]{32})/i);
  if (b32Match) return b32Match[1].toLowerCase();
  return null;
}

/**
 * Clean magnet link to avoid header/newline injection issues.
 */
function sanitizeMagnet(magnet) {
  if (!magnet) return "";
  return String(magnet).replace(/[\r\n\t]+/g, "").trim();
}

/**
 * Check if a torrent hash is already 100% cached on TorBox.
 * @param {string} hash - 40-char infoHash
 * @returns {Promise<boolean>}
 */
async function checkCached(hash) {
  const apiKey = getApiKey();
  if (!apiKey || !hash) return false;

  try {
    const res = await fetch(
      `${TORBOX_BASE_URL}/torrents/checkcached?hash=${hash}&format=object`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!res.ok) return false;
    const json = await res.json();
    if (json.success && json.data) {
      const entry = json.data[hash.toLowerCase()] || json.data[hash.toUpperCase()];
      return Boolean(entry);
    }
    return false;
  } catch (err) {
    console.warn("[TorboxService] checkCached error:", err.message);
    return false;
  }
}

/**
 * Submit magnet link to TorBox.
 * @param {string} magnet - Magnet URI
 * @returns {Promise<{ torrent_id: number, hash: string } | null>}
 */
async function createTorrent(magnet) {
  const apiKey = getApiKey();
  if (!apiKey || !magnet) return null;

  try {
    const clean = sanitizeMagnet(magnet);
    const body = new URLSearchParams();
    body.append("magnet", clean);
    body.append("seed", "1"); // Auto seed
    body.append("allow_zip", "false");

    const res = await fetch(`${TORBOX_BASE_URL}/torrents/createtorrent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(6000),
    });

    const json = await res.json();
    if (json.success && json.data) {
      return json.data;
    }
    console.warn("[TorboxService] createtorrent failed:", json.detail || json.error);
    return null;
  } catch (err) {
    console.warn("[TorboxService] createtorrent request error:", err.message);
    return null;
  }
}

/**
 * Retrieve file list for an added torrent.
 * @param {number} torrentId
 * @returns {Promise<Array<object> | null>}
 */
async function getTorrentFiles(torrentId) {
  const apiKey = getApiKey();
  if (!apiKey || !torrentId) return null;

  try {
    const res = await fetch(
      `${TORBOX_BASE_URL}/torrents/mylist?id=${torrentId}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!res.ok) return null;
    const json = await res.json();
    if (json.success && json.data) {
      const item = Array.isArray(json.data) ? json.data[0] : json.data;
      // If torrent has 0 seeds / 0% progress and is not cached (like 3 months ETA), return null to trigger instant server fallback
      if (item && !item.cached && !item.download_present && item.progress !== 1) {
        console.warn(`[TorboxService] Torrent ${torrentId} not ready/cached yet (progress: ${item.progress ?? 0}). Falling back to cloud servers.`);
        return null;
      }
      return item?.files || null;
    }
    return null;
  } catch (err) {
    console.warn("[TorboxService] getTorrentFiles error:", err.message);
    return null;
  }
}

/**
 * Pick the largest primary media/video file (ignoring samples, txt, nfo).
 */
function pickPrimaryVideoFile(files, season = null, episode = null, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return null;

  const videoFiles = files.filter((f) => {
    const name = String(f.name || f.short_name || "").toLowerCase();
    const isVideo =
      name.endsWith(".mp4") ||
      name.endsWith(".mkv") ||
      name.endsWith(".avi") ||
      name.endsWith(".mov") ||
      name.endsWith(".webm");
    const isSample = name.includes("sample") || (f.size && f.size < 50 * 1024 * 1024);
    return isVideo && !isSample;
  });

  if (videoFiles.length === 0) {
    const sorted = [...files].sort((a, b) => (b.size || 0) - (a.size || 0));
    return sorted[0] || null;
  }

  // If episode is provided (TV show), only the matching episode file inside the pack is valid.
  // Never fall back to the largest/first file: that served S01E01 for every episode.
  if (episode != null) {
    const epNum = Number(episode);
    const sNum = season != null ? Number(season) : 1;
    const fileName = (f) => String(f.name || f.short_name || "");

    // The episode's own file name, stored from Torrentio's per-episode index ("EP05.mkv").
    if (options.fileName) {
      const named = videoFiles.find((f) => baseName(fileName(f)) === baseName(options.fileName));
      if (named) return named;
    }

    // Files carrying their own SxxEyy tag must match season and episode exactly.
    const exact = videoFiles.find((f) => episodeScope(fileName(f), sNum, epNum) === "exact");
    if (exact) return exact;

    // Untagged files (e.g. "Season 1/05 - Title.mkv", "1x05", "Episode 5").
    const patterns = [
      new RegExp(`\\b${sNum}x0*${epNum}(?!\\d)`, "i"),
      new RegExp(`\\bep(?:isode)?[._ -]*0*${epNum}(?!\\d)`, "i"),
      new RegExp(`\\be0*${epNum}(?!\\d)`, "i"),
      new RegExp(`(?:^|/)0*${epNum}(?!\\d)[^/]*$`, "i"),
    ];
    const untagged = videoFiles.filter((f) => episodeScope(fileName(f), sNum, epNum) === "pack");
    for (const pattern of patterns) {
      const match = untagged.find((f) => pattern.test(fileName(f)));
      if (match) return match;
    }

    // A single-file torrent already scoped to this episode by its release name.
    if (options.singleEpisode && videoFiles.length === 1) return videoFiles[0];
    return null;
  }

  // Multi-film pack: only the named file is this film. The largest file would be another part.
  if (options.fileName) {
    const wanted = baseName(options.fileName);
    return videoFiles.find((f) => baseName(f.name || f.short_name) === wanted) || null;
  }

  // Fallback to largest video file
  videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
  return videoFiles[0];
}

function baseName(name) {
  return String(name || "").split(/[\\/]/).pop().trim().toLowerCase();
}

/**
 * Request high-speed direct download & streaming URL for a specific file.
 * @param {number} torrentId
 * @param {number} fileId
 * @returns {Promise<string | null>} Direct HTTPS URL
 */
async function requestDownloadLink(torrentId, fileId) {
  const apiKey = getApiKey();
  if (!apiKey || !torrentId) return null;

  try {
    const targetFile = fileId != null ? `&file_id=${fileId}` : "";
    const res = await fetch(
      `${TORBOX_BASE_URL}/torrents/requestdl?token=${encodeURIComponent(
        apiKey
      )}&torrent_id=${torrentId}${targetFile}&zip=false`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      }
    );

    if (!res.ok) return null;
    const json = await res.json();
    if (json.success && json.data) {
      return typeof json.data === "string" ? json.data : json.data.url || null;
    }
    return null;
  } catch (err) {
    console.warn("[TorboxService] requestDownloadLink error:", err.message);
    return null;
  }
}

/**
 * High-Level Orchestrator:
 * Resolves a BitTorrent Magnet Link into an instant high-speed HTTPS Stream & Download URL.
 *
 * @param {string} magnetLink
 * @returns {Promise<{ success: boolean, streamUrl: string, downloadUrl: string, fileName: string, isCached: boolean } | null>}
 */
async function resolveDirectTorboxStream(magnetLink, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey || !magnetLink) return null;

  const hash = extractInfoHash(magnetLink);
  if (!hash) return null;

  const season = options?.season ?? null;
  const episode = options?.episode ?? null;

  // 1. Check in-memory cache first (2-hour TTL to match link validity)
  const epKey = episode != null ? `:s${season ?? 1}e${episode}` : "";
  // Films of one pack share a hash, so the file name is part of the key.
  const fileKey = options?.fileName ? `:f:${baseName(options.fileName)}` : "";
  const cacheKey = `torbox:link:${hash}${epKey}${fileKey}`;
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  try {
    // 2. Add or fetch torrent on TorBox
    const created = await createTorrent(magnetLink);
    if (!created || !created.torrent_id) return null;

    // 3. Inspect files inside the torrent
    const files = await getTorrentFiles(created.torrent_id);
    if (!files || files.length === 0) return null;
    const primaryFile = pickPrimaryVideoFile(files, season, episode, {
      singleEpisode: options?.singleEpisode,
      fileName: options?.fileName,
    });
    if (!primaryFile || primaryFile.id == null) {
      if (episode != null) console.warn(`[TorboxService] S${season}E${episode} not found in torrent ${created.torrent_id}`);
      else if (options?.fileName) console.warn(`[TorboxService] "${options.fileName}" not found in torrent ${created.torrent_id}`);
      return null;
    }

    // 4. Request direct download URL
    const directUrl = await requestDownloadLink(created.torrent_id, primaryFile.id);
    if (!directUrl) return null;

    const result = {
      success: true,
      streamUrl: directUrl,
      downloadUrl: directUrl,
      fileName: primaryFile?.name || created.name || "video.mp4",
      fileSize: primaryFile?.size || 0,
      isCached: true,
      provider: "torbox",
    };

    // Cache for 2 hours (TorBox presigned links are valid for 3 hours)
    memoryCache.set(cacheKey, result, 2 * 60 * 60 * 1000);
    return result;
  } catch (err) {
    console.warn("[TorboxService] resolveDirectTorboxStream failed:", err.message);
    return null;
  }
}

module.exports = {
  checkCached,
  createTorrent,
  getTorrentFiles,
  requestDownloadLink,
  resolveDirectTorboxStream,
  extractInfoHash,
  pickPrimaryVideoFile,
};
