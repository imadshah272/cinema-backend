"use strict";
const torbox = require("../server/services/torboxService");
const { probeHindiAudio } = require("../server/services/audioTrackProbe");
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { hindiAudioKind } = require("../server/services/releaseAudio");
(async () => {
  const [path, season, episode] = process.argv.slice(2);
  const streams = ((await fetchTorrentio(path)).streams || []).filter((s) => hindiAudioKind(`${s.title || ""} ${s.name || ""}`, null));
  for (const s of streams.slice(0, 3)) {
    const hash = String(s.infoHash).toLowerCase();
    const tb = await torbox.resolveDirectTorboxStream(`magnet:?xt=urn:btih:${hash}`, { season: Number(season), episode: Number(episode), singleEpisode: false, fileName: s.behaviorHints?.filename || null });
    if (!tb?.streamUrl) { console.log(hash, "no stream"); continue; }
    const p = await probeHindiAudio(tb.streamUrl, tb.fileName);
    console.log(String(s.title).split("\n")[0].slice(0, 70), "| file:", String(tb.fileName).split("/").pop().slice(0, 60), "| size", Math.round((tb.fileSize || 0) / 1e6) + "MB", "| audio:", p ? p.tracks.map((t) => `${t.language || "und"}/${t.codec}`).join(",") : "probe-failed");
  }
})();
