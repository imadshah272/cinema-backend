"use strict";
const torbox = require("../server/services/torboxService");
(async () => {
  const magnet = process.argv[2];
  const out = await torbox.resolveDirectTorboxStream(magnet, { season: Number(process.argv[3]), episode: Number(process.argv[4]), singleEpisode: false, fileName: process.argv[5] || null });
  console.log(JSON.stringify(out, null, 1).slice(0, 700));
})();
