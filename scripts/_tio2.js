"use strict";
const { hindiAudioKind } = require("../server/services/releaseAudio");
const { checkCachedBatch } = require("./fillSeriesGaps");
const CFG = "providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tamilblasters,tamilmv,rutor,rutracker,torrent9|language=hindi";
(async () => {
  for (const p of process.argv.slice(2)) {
    const res = await fetch(`https://torrentio.strem.fun/${CFG}/stream/${p}.json`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch((e) => ({ err: e.message }));
    const streams = res.streams || [];
    const hin = streams.filter((s) => hindiAudioKind(`${s.title || ""} ${s.name || ""}`, null));
    const cached = await checkCachedBatch(hin.map((s) => String(s.infoHash || "").toLowerCase()).filter(Boolean));
    console.log(`${p}: ${streams.length} streams, ${hin.length} Hindi/Dual`);
    for (const s of hin.slice(0, 6)) console.log(`   ${cached.has(String(s.infoHash).toLowerCase()) ? "CACHED  " : "uncached"} ${String(s.title).split("\n")[0].slice(0, 95)} | ${String(s.infoHash).slice(0, 8)}`);
  }
})();
