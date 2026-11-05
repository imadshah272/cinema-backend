"use strict";
const torbox = require("../server/services/torboxService");
const { parseMkvAudioTracks } = require("../server/services/audioTrackProbe");
(async () => {
  const [hash, season, episode] = process.argv.slice(2);
  const tb = await torbox.resolveDirectTorboxStream(`magnet:?xt=urn:btih:${hash}`, { season: Number(season), episode: Number(episode), singleEpisode: false });
  if (!tb?.streamUrl) return console.log("no stream");
  const r = await fetch(tb.streamUrl, { headers: { Range: "bytes=0-1500000" }, signal: AbortSignal.timeout(90000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const tracks = parseMkvAudioTracks(buf);
  console.log(String(tb.fileName).split("/").pop().slice(0, 60), "=>", tracks.map((t) => `${t.language || "und"}/${t.codec}${t.name ? "(" + t.name + ")" : ""}`).join(" | ") || "no audio tracks parsed", "| bytes", buf.length);
})();
