"use strict";
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { hindiAudioKind } = require("../server/services/releaseAudio");
const { checkCachedBatch } = require("./fillSeriesGaps");
(async () => {
  const path = process.argv[2];
  const res = await fetchTorrentio(path);
  const streams = res.streams || [];
  console.log("streams", streams.length);
  const hin = streams.filter((s) => hindiAudioKind(`${s.title || ""} ${s.name || ""}`, null));
  const cached = await checkCachedBatch(hin.map((s) => String(s.infoHash || "").toLowerCase()).filter(Boolean));
  for (const s of hin.slice(0, 12)) {
    const first = String(s.title || "").split("\n")[0];
    console.log(`${cached.has(String(s.infoHash).toLowerCase()) ? "CACHED  " : "uncached"} | ${first.slice(0, 100)} | ${String(s.title || "").match(/👤\s*(\d+)/)?.[1] || "?"} seeds`);
  }
  if (!hin.length) console.log("no Hindi / Dual stream in Torrentio");
})();
