"use strict";
const torbox = require("../server/services/torboxService");
const { probeHindiAudio } = require("../server/services/audioTrackProbe");
const { checkCachedBatch } = require("./fillSeriesGaps");
const { hindiAudioKind, packCoversSeason } = require("../server/services/releaseAudio");
const [show, season, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tpb(q) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=200`, { signal: AbortSignal.timeout(15000) });
      const l = await r.json();
      return Array.isArray(l) ? l.filter((x) => x.info_hash && !/^0+$/.test(x.info_hash)) : [];
    } catch { await sleep(700); }
  }
  return [];
}
(async () => {
  const found = new Map();
  for (const q of [`${show} S0${season} hindi`, `${show} season ${season} hindi`, `${show} S0${season} dual audio`, `${show} complete hindi`, `${show} hindi dubbed`]) {
    for (const r of await tpb(q)) {
      if (!hindiAudioKind(r.name, null) || !packCoversSeason(r.name, Number(season))) continue;
      found.set(r.info_hash.toLowerCase(), { hash: r.info_hash.toLowerCase(), name: r.name, seeders: Number(r.seeders) || 0 });
    }
    await sleep(300);
  }
  const cached = await checkCachedBatch([...found.keys()]);
  const list = [...found.values()].sort((a, b) => b.seeders - a.seeders).slice(0, 12);
  for (const c of list) {
    let audio = "-";
    if (cached.has(c.hash)) {
      try {
        const tb = await torbox.resolveDirectTorboxStream(`magnet:?xt=urn:btih:${c.hash}`, { season: Number(season), episode: 1, singleEpisode: false });
        if (tb?.streamUrl) {
          const p = await probeHindiAudio(tb.streamUrl, tb.fileName);
          audio = p ? p.tracks.map((t) => `${t.language || "und"}/${t.codec}`).join(",") : "probe-failed";
        }
      } catch (e) { audio = "err:" + e.message.slice(0, 40); }
    }
    console.log(`${cached.has(c.hash) ? "CACHED  " : "uncached"} ${String(c.seeders).padStart(4)} seeds | ${c.name.slice(0, 85)} | audio=[${audio}]`);
  }
  if (!list.length) console.log("no Hindi release found");
})();
