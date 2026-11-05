"use strict";
const BASE = process.env.API_BASE || "http://168.144.249.68:4555";
const tests = JSON.parse(process.argv[2]);
(async () => {
  for (const t of tests) {
    const q = new URLSearchParams({ mediaType: t.type, audio: "hi", engine: "vlc" });
    if (t.type === "tv") { q.set("season", t.s); q.set("episode", t.e); }
    const url = `${BASE}/api/stream/${t.id}?${q}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const j = await res.json();
      const sel = j.selected || {};
      const tracks = (sel.audioTracks || []).map((a) => `${a.language || "und"}/${a.codec}`).join(",");
      console.log(`${t.name} | ${res.status} avail=${j.available} caching=${j.caching ?? false} | ${String(sel.releaseName || j.error || "").slice(0, 70)} | hindiTrack=${sel.hindiAudioTrack ? sel.hindiAudioTrack.index + ":" + sel.hindiAudioTrack.language : "none"} | tracks=[${tracks}]`);
    } catch (e) {
      console.log(`${t.name} | ERROR ${e.message}`);
    }
  }
})();
