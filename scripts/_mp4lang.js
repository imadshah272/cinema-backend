"use strict";
const torbox = require("../server/services/torboxService");
async function range(url, start, end) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(60000) });
  return Buffer.from(await r.arrayBuffer());
}
function tracks(buf) {
  const out = [];
  let i = 0;
  while ((i = buf.indexOf("trak", i)) >= 0) {
    const seg = buf.subarray(i, i + 4000);
    const m = seg.indexOf("mdhd");
    const h = seg.indexOf("hdlr");
    let lang = "?", kind = "?";
    if (m >= 0) {
      const ver = seg[m + 4];
      const off = m + 4 + (ver === 1 ? 4 + 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4 + 4);
      const packed = seg.readUInt16BE(off);
      lang = String.fromCharCode(((packed >> 10) & 31) + 96, ((packed >> 5) & 31) + 96, (packed & 31) + 96);
    }
    if (h >= 0) kind = seg.subarray(h + 12, h + 16).toString();
    out.push(`${kind}:${lang}`);
    i += 4;
  }
  return out;
}
(async () => {
  const [hash, season, episode] = process.argv.slice(2);
  const tb = await torbox.resolveDirectTorboxStream(`magnet:?xt=urn:btih:${hash}`, { season: Number(season), episode: Number(episode), singleEpisode: false });
  if (!tb?.streamUrl) return console.log("no stream");
  const head = await range(tb.streamUrl, 0, 3_000_000);
  let t = tracks(head);
  if (!t.length) {
    const size = tb.fileSize || 0;
    const tail = await range(tb.streamUrl, Math.max(0, size - 4_000_000), size - 1);
    t = tracks(tail);
  }
  console.log(String(tb.fileName).split("/").pop(), "=>", t.join(" | ") || "no mp4 tracks found");
})();
