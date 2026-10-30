"use strict";

/**
 * Release-name checks for Hindi audio, quality, and episode scope.
 *
 * The `language` column in media_sources is an ingestion label and is often
 * wrong: "Dual-Lat" (Spanish) and Brazilian "DUAL 5.1" releases were stored as
 * "Dual Audio [Hindi+Eng]". Only the release name itself is trusted here.
 */

/** Hindi / Urdu (Hindustani, as used in Bollywood) spelled out in the release name. */
const HINDI_RE = /\bhindi\b|\bhin\b|hin[ ._-]?eng|\burdu\b|hindustani/i;
/** Second (English) track markers. Only meaningful when Hindi is present. */
const ENGLISH_RE = /\beng\b|\benglish\b|dual|multi/i;

const QUALITY_RE = [
  ["2160p", /2160p|\b4k\b|\buhd\b/i],
  ["1080p", /1080p/i],
  ["720p", /720p/i],
  ["480p", /480p|\bsd\b/i],
  ["360p", /360p/i],
];

function magnetDisplayName(magnet) {
  const match = String(magnet || "").match(/[?&]dn=([^&]+)/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1].replace(/\+/g, " "));
  } catch {
    return match[1];
  }
}

/** Release name of a media_sources row: magnet dn plus the download file name. */
function releaseName(source) {
  const magnet = source?.magnet_link || (/^magnet:/i.test(source?.download_url || "") ? source.download_url : "");
  const parts = [magnetDisplayName(magnet)];
  const url = source?.download_url || "";
  if (url && !/^magnet:/i.test(url)) {
    try {
      parts.push(decodeURIComponent(url.split("?")[0].split("/").pop() || ""));
    } catch {
      parts.push(url);
    }
  }
  return parts.filter(Boolean).join(" ");
}

/** English named explicitly; "DUAL"/"MULTI" alone don't say which second track. */
const EXPLICIT_ENGLISH_RE = /\beng\b|\benglish\b|hin[ ._-]?eng/i;

/**
 * "dual" (Hindi + English), "hindi", or null when no Hindi track is named.
 * When the film's original language is known and is not English, "DUAL" is
 * usually Hindi + Tamil/Telugu, so English has to be named to count as dual.
 */
function hindiAudioKind(name, originalLanguage) {
  const text = String(name || "");
  if (!HINDI_RE.test(text)) return null;
  const lang = String(originalLanguage || "").toLowerCase();
  const englishRe = lang && lang !== "en" ? EXPLICIT_ENGLISH_RE : ENGLISH_RE;
  return englishRe.test(text) ? "dual" : "hindi";
}

function audioLabel(kind) {
  if (kind === "dual") return "Dual Audio [Hindi+Eng]";
  if (kind === "hindi") return "Hindi";
  return "Original";
}

function detectQuality(name, fallback) {
  for (const [label, re] of QUALITY_RE) {
    if (re.test(String(name || ""))) return label;
  }
  const fb = String(fallback || "").toLowerCase();
  return QUALITY_RE.some(([label]) => label === fb) ? fb : "";
}

/** Every SxxEyy tag in a name, e.g. [{ season: 1, episode: 5 }]. */
function episodeTags(name) {
  const tags = [];
  const re = /\bs(\d{1,2})[ ._-]?e(\d{1,3})(?!\d)/gi;
  let m;
  while ((m = re.exec(String(name || "")))) tags.push({ season: Number(m[1]), episode: Number(m[2]) });
  return tags;
}

/**
 * How a release relates to the requested episode:
 * "exact"  - names this episode,
 * "pack"   - names no single episode (season / complete pack),
 * "other"  - names a different episode only, so it must not be used.
 */
function episodeScope(name, season, episode) {
  const tags = episodeTags(name);
  if (tags.length === 0) return "pack";
  return tags.some((t) => t.season === Number(season) && t.episode === Number(episode)) ? "exact" : "other";
}

/**
 * True when a release without SxxEyy tags is a pack that contains `season`:
 * "S01", "Season 1", "S01-S05", "Seasons 1-5", or "Complete Series".
 * Rejects rows that point at an unrelated movie magnet.
 */
function packCoversSeason(name, season) {
  const text = String(name || "");
  const s = Number(season);
  const range = text.match(/\bs(?:easons?)?[ ._-]*0*(\d{1,2})\s*[-–~]\s*s?0*(\d{1,2})\b/i);
  if (range && s >= Number(range[1]) && s <= Number(range[2])) return true;
  const re = /\b(?:s|season[ ._-]*)0*(\d{1,2})(?!\d)/gi;
  let m;
  while ((m = re.exec(text))) if (Number(m[1]) === s) return true;
  return /\bcomplete\b|all[ ._-]seasons|full[ ._-]series/i.test(text);
}

module.exports = {
  packCoversSeason,
  magnetDisplayName,
  releaseName,
  hindiAudioKind,
  audioLabel,
  detectQuality,
  episodeTags,
  episodeScope,
};
