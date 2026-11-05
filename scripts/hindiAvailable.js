/** Keeps only the TMDB tv ids whose S01E01 (or S01E02) has a Hindi / Dual release on Torrentio.  node scripts/hindiAvailable.js 1,2,3 */
"use strict";
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { hindiAudioKind } = require("../server/services/releaseAudio");
const { tmdb } = require("./fillSeriesGaps");
(async () => {
  const ids = (process.argv[2] || "").split(",").filter(Boolean);
  const keep = [];
  for (const id of ids) {
    const ext = await tmdb(`/tv/${id}/external_ids`);
    if (!ext?.imdb_id) continue;
    let ok = false;
    for (const ep of [1, 2]) {
      try {
        const streams = (await fetchTorrentio(`series/${ext.imdb_id}:1:${ep}`)).streams || [];
        if (streams.some((s) => hindiAudioKind(`${s.title || ""} ${s.name || ""}`, null))) { ok = true; break; }
      } catch { /* ignore */ }
    }
    if (ok) keep.push(id);
  }
  console.error(`${keep.length}/${ids.length} shows have a Hindi / Dual release`);
  console.log(keep.join(","));
})();
