/**
 * scripts/findSeason.js
 * Lists Hindi / Dual releases for one missing season: apibay (all categories, many queries) + Torrentio,
 * with TorBox cache state and, for cached ones, the real audio tracks of the season's first file.
 *   node scripts/findSeason.js "The Walking Dead" 2 tt1520211
 */
"use strict";
const torbox = require("../server/services/torboxService");
const { parseMkvAudioTracks } = require("../server/services/audioTrackProbe");
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { hindiAudioKind } = require("../server/services/releaseAudio");
const { checkCachedBatch } = require("./fillSeriesGaps");
const [show, seasonArg, imdb] = process.argv.slice(2);
const season = Number(seasonArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STOP = new Set(["the", "of", "and", "a"]);
const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !STOP.has(w));
const showWords = words(show);
const pad = (n) => String(n).padStart(2, "0");

async function tpb(q) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=0`, { signal: AbortSignal.timeout(15000) });
      const l = await r.json();
      return Array.isArray(l) ? l.filter((x) => x.info_hash && !/^0+$/.test(x.info_hash)) : [];
    } catch { await sleep(700); }
  }
  return [];
}
// The release must be about this show AND this season (tag, range, or a "complete" pack).
function matches(name) {
  const w = new Set(words(name));
  if (!showWords.every((x) => w.has(x))) return false;
  const s = season;
  const tag = [...name.matchAll(/\bs0*(\d{1,2})(?!\d|e\d)/gi)].map((m) => +m[1]);
  const seasonWord = [...name.matchAll(/season[ ._-]*0*(\d{1,2})/gi)].map((m) => +m[1]);
  const range = name.match(/\bs0*(\d{1,2})\s*[-–~to]+\s*s?0*(\d{1,2})/i) || name.match(/seasons?[ ._-]*0*(\d{1,2})\s*[-–~to]+\s*0*(\d{1,2})/i);
  if ([...tag, ...seasonWord].includes(s)) return true;
  if (range && s >= +range[1] && s <= +range[2]) return true;
  if (!tag.length && !seasonWord.length && /complete|all[ ._-]seasons|full[ ._-]series/i.test(name)) return true;
  return false;
}

(async () => {
  const found = new Map();
  const qs = [`${show} S${pad(season)}`, `${show} season ${season}`, `${show} S${pad(season)} hindi`, `${show} season ${season} hindi dubbed`, `${show} S${pad(season)} dual audio`, `${show} hindi english`, `${show} complete series`, `${show} hindi dubbed`, `${show} S01-S`];
  for (const q of qs) {
    for (const r of await tpb(q)) {
      if (!hindiAudioKind(r.name, null) || !matches(r.name)) continue;
      found.set(r.info_hash.toLowerCase(), { hash: r.info_hash.toLowerCase(), name: r.name, seeders: Number(r.seeders) || 0, src: "apibay" });
    }
    await sleep(300);
  }
  if (imdb) {
    for (const ep of [1, 2, 3]) {
      try {
        for (const s of (await fetchTorrentio(`series/${imdb}:${season}:${ep}`)).streams || []) {
          const text = `${s.title || ""} ${s.name || ""}`;
          const name = String(s.title || "").split("\n")[0];
          if (!s.infoHash || !hindiAudioKind(text, null)) continue;
          found.set(String(s.infoHash).toLowerCase(), { hash: String(s.infoHash).toLowerCase(), name, seeders: Number((String(s.title).match(/👤\s*(\d+)/) || [])[1]) || 0, src: "torrentio" });
        }
      } catch { /* ignore */ }
    }
  }
  const cached = await checkCachedBatch([...found.keys()]);
  const list = [...found.values()].sort((a, b) => (cached.has(b.hash) - cached.has(a.hash)) || b.seeders - a.seeders).slice(0, 10);
  if (!list.length) return console.log(`${show} S${pad(season)}: no Hindi / Dual release found`);
  for (const c of list) {
    let audio = "-";
    if (cached.has(c.hash)) {
      try {
        const tb = await torbox.resolveDirectTorboxStream(`magnet:?xt=urn:btih:${c.hash}`, { season, episode: 1, singleEpisode: false });
        if (tb?.streamUrl) {
          if (!/\.mkv/i.test(tb.fileName)) audio = "not-mkv(" + String(tb.fileName).split(".").pop() + ")";
          else {
            const r = await fetch(tb.streamUrl, { headers: { Range: "bytes=0-1500000" }, signal: AbortSignal.timeout(60000) });
            const tr = parseMkvAudioTracks(Buffer.from(await r.arrayBuffer()));
            audio = tr.map((t) => `${t.language || "und"}/${t.codec}`).join(",") || "no-tracks";
          }
        } else audio = "S" + season + "E1 not in pack";
      } catch (e) { audio = "err"; }
    }
    console.log(`${cached.has(c.hash) ? "CACHED  " : "uncached"} ${String(c.seeders).padStart(4)}s ${c.src.slice(0, 4)} | ${c.hash} | ${c.name.slice(0, 80)} | audio=[${audio}]`);
  }
})();
