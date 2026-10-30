"use strict";

/**
 * Reads the audio track list of an MKV from its first few MB (one HTTP Range request),
 * so a stream is only offered as Hindi when its Hindi track can play on a phone.
 *
 * Why: many releases carry Hindi as AC3 / E-AC3 / DTS. Most Android phones cannot decode
 * those, ExoPlayer skips them, and the only AAC track left (often English) plays instead.
 */

const { memoryCache } = require("./memoryCache");

const PROBE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_BCP47 = 0x22b59d;
const ID_NAME = 0x536e;
const ID_CODEC = 0x86;
const ID_FLAG_DEFAULT = 0x88;
const ID_CLUSTER = 0x1f43b675;
const TRACK_TYPE_AUDIO = 2;

/** Codecs Android phones decode in software / on every device. */
const PHONE_SAFE_CODEC_RE = /^A_(AAC|MPEG\/L3|MPEG\/L2|OPUS|VORBIS|FLAC)/i;

function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    len += 1;
    mask >>= 1;
  }
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { value, len, unknownSize: !keepMarker && value === 2 ** (7 * len) - 1 };
}

/** Audio tracks of an MKV header buffer, or null when the Tracks element is not in it. */
function parseMkvAudioTracks(buf) {
  const tracks = [];
  let foundTracks = false;

  function walk(start, end, inEntry) {
    let pos = start;
    while (pos < end - 2) {
      const id = readVint(buf, pos, true);
      if (!id) return;
      const size = readVint(buf, pos + id.len, false);
      if (!size) return;
      const dataStart = pos + id.len + size.len;
      const dataEnd = size.unknownSize ? end : Math.min(end, dataStart + size.value);
      const str = () => buf.slice(dataStart, dataEnd).toString("utf8").replace(/\0/g, "");
      const num = () => {
        let v = 0;
        for (let i = dataStart; i < dataEnd; i++) v = v * 256 + buf[i];
        return v;
      };

      if (id.value === ID_CLUSTER) return; // media data: the header is over
      if (id.value === ID_SEGMENT) walk(dataStart, dataEnd, null);
      else if (id.value === ID_TRACKS) {
        foundTracks = true;
        walk(dataStart, dataEnd, null);
      } else if (id.value === ID_TRACK_ENTRY) {
        // Matroska default language is English when the element is absent.
        const entry = { type: 0, language: "eng", name: "", codec: "", isDefault: true };
        walk(dataStart, dataEnd, entry);
        if (entry.type === TRACK_TYPE_AUDIO) tracks.push(entry);
      } else if (inEntry) {
        if (id.value === ID_TRACK_TYPE) inEntry.type = num();
        else if (id.value === ID_LANGUAGE || id.value === ID_LANGUAGE_BCP47) inEntry.language = str().toLowerCase();
        else if (id.value === ID_NAME) inEntry.name = str();
        else if (id.value === ID_CODEC) inEntry.codec = str();
        else if (id.value === ID_FLAG_DEFAULT) inEntry.isDefault = num() === 1;
      }
      if (size.unknownSize) return;
      pos = dataEnd;
    }
  }

  walk(0, buf.length, null);
  return foundTracks ? tracks : null;
}

function isHindiTrack(track) {
  return /^(hi|hin|ur|urd)(?:[-_]|$)/.test(track.language) || /\b(hindi|urdu)\b/i.test(track.name);
}

/**
 * { tracks, hindi, hindiPlayable } for an MKV URL, or null when unknown
 * (not MKV, header not reachable, or Tracks beyond the probed bytes).
 */
async function probeHindiAudio(url, fileName = "") {
  if (!url || (fileName && !/\.mkv$/i.test(fileName))) return null;
  const cacheKey = `audio-probe:${url.split("?")[0]}`;
  const cached = memoryCache.get(cacheKey);
  if (cached !== undefined && cached !== null) return cached;

  let result = null;
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
        const tracks = parseMkvAudioTracks(buf);
        if (tracks) {
          const hindi = tracks.map((t, index) => ({ ...t, index })).filter(isHindiTrack);
          result = {
            tracks: tracks.map((t, index) => ({ index, language: t.language, codec: t.codec, name: t.name, isDefault: t.isDefault })),
            hindi: hindi.map((t) => ({ index: t.index, language: t.language, codec: t.codec })),
            hindiPlayable: hindi.some((t) => PHONE_SAFE_CODEC_RE.test(t.codec)),
          };
        }
      }
    }
  } catch (err) {
    console.warn("[audio-probe] header read failed:", err.message);
  }
  if (result) memoryCache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}

module.exports = {
  parseMkvAudioTracks,
  probeHindiAudio,
  PHONE_SAFE_CODEC_RE,
};
