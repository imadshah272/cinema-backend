/**
 * scripts/verifyHindiAudio.js
 *
 * Release names lie ("S01-S08 Complete ... Hindi English" whose S05 files are English only). This reads the
 * MKV header of the real file behind a row and hides the rows whose file has no Hindi / Urdu track.
 * One probe per torrent (and per season for a pack); a file that cannot be read (MP4, timeout) is kept.
 *
 *   node scripts/verifyHindiAudio.js --since 2026-11-05T00:00:00Z            # rows created since then
 *   node scripts/verifyHindiAudio.js --shows 1399,67915 --apply
 *   node scripts/verifyHindiAudio.js --all --limit 300 --apply                # oldest unverified first
 *
 * Result per probe: hindi | none | unknown. Verified torrents are remembered in verified-audio.json.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getSupabaseClient } = require("../server/services/supabaseClient");
const torbox = require("../server/services/torboxService");
const { parseMkvAudioTracks } = require("../server/services/audioTrackProbe");

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes("--apply");
const SINCE = opt("--since");
const SHOWS = (opt("--shows") || "").split(",").filter(Boolean);
const ALL = args.includes("--all");
const LIMIT = Number(opt("--limit")) || 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEMO = path.join(__dirname, "..", "verified-audio.json");
const memo = fs.existsSync(MEMO) ? JSON.parse(fs.readFileSync(MEMO, "utf8")) : {};

const hashOf = (row) => ((row.magnet_link || row.download_url || row.stream_url || "").match(/btih:([0-9a-f]{40})/i) || (row.stream_url || "").match(/torrent\/([0-9a-f]{40})/i) || [])[1]?.toLowerCase();
const hasHindi = (tracks) => tracks.some((t) => /^(hin|hi|urd|ur)(?:[-_]|$)/i.test(t.language || "") || /\b(hindi|urdu)\b/i.test(t.name || ""));

async function probe(row) {
  const m = /^(\d+)-s(\d+)e(\d+)$/i.exec(row.media_id);
  const magnet = row.magnet_link || `magnet:?xt=urn:btih:${hashOf(row)}`;
  const tb = await torbox.resolveDirectTorboxStream(magnet, {
    ...(m ? { season: +m[2], episode: +m[3], singleEpisode: false } : {}),
    fileName: row.payload?.file_name || null,
  });
  if (!tb?.streamUrl) return { result: "unknown", why: "no stream" };
  if (!/\.mkv/i.test(String(tb.fileName))) return { result: "unknown", why: "not mkv" };
  const res = await fetch(tb.streamUrl, { headers: { Range: "bytes=0-1500000" }, signal: AbortSignal.timeout(60000) });
  const tracks = parseMkvAudioTracks(Buffer.from(await res.arrayBuffer()));
  if (!tracks.length) return { result: "unknown", why: "no tracks parsed" };
  return { result: hasHindi(tracks) ? "hindi" : "none", tracks: tracks.map((t) => `${t.language || "und"}/${t.codec}`).join(",") };
}

(async () => {
  const sb = getSupabaseClient();
  let query = sb.from("media_sources").select("id,media_id,media_title,magnet_link,download_url,stream_url,payload,created_at").eq("status", "ready");
  if (SINCE) query = query.gte("updated_at", SINCE); // re-stored rows keep their created_at
  const rows = [];
  if (SHOWS.length) {
    for (const id of SHOWS) {
      const { data } = await sb.from("media_sources").select("id,media_id,media_title,magnet_link,download_url,stream_url,payload,created_at").eq("status", "ready").or(`media_id.eq.${id},media_id.like.${id}-s%`);
      rows.push(...(data || []));
    }
  } else {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await query.range(from, from + 999).order("id");
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
  }

  // One probe per torrent (per season for a series pack).
  const groups = new Map();
  for (const row of rows) {
    const hash = hashOf(row);
    if (!hash) continue;
    const m = /^(\d+)-s(\d+)e(\d+)$/i.exec(row.media_id);
    const key = m ? `${hash}:s${+m[2]}` : hash;
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key).rows.push(row);
  }
  // A torrent already known to have no Hindi track is hidden again without another probe (a script may store it anew).
  const knownNone = [...groups.values()].filter((g) => memo[g.key] === "none");
  if (APPLY) {
    for (const g of knownNone) await sb.from("media_sources").update({ status: "hidden" }).in("id", g.rows.map((r) => r.id));
  }
  if (knownNone.length) console.log(`known no-Hindi torrents hidden again: ${knownNone.length} (${knownNone.reduce((n, g) => n + g.rows.length, 0)} rows)`);
  const todo = [...groups.values()].filter((g) => !memo[g.key]).slice(0, LIMIT);
  console.log(`rows ${rows.length} | torrents/seasons ${groups.size} | to probe ${todo.length}`);

  const report = { hindi: 0, none: 0, unknown: 0, hidden: 0, hiddenTitles: new Set() };
  let n = 0;
  for (const g of todo) {
    n += 1;
    let out;
    try { out = await probe(g.rows[0]); } catch (e) { out = { result: "unknown", why: e.message.slice(0, 40) }; }
    report[out.result] += 1;
    if (out.result !== "unknown") memo[g.key] = out.result;
    if (out.result === "none") {
      const title = g.rows[0].media_title.replace(/ - S\d+E\d+.*/, "");
      report.hiddenTitles.add(title);
      console.log(`  NO HINDI  ${title} | ${g.key.slice(0, 14)} | tracks ${out.tracks} | rows ${g.rows.length}`);
      if (APPLY) {
        const { error } = await sb.from("media_sources").update({ status: "hidden" }).in("id", g.rows.map((r) => r.id));
        if (!error) report.hidden += g.rows.length;
      }
    }
    if (n % 25 === 0) { console.log(`  ... ${n}/${todo.length}`); fs.writeFileSync(MEMO, JSON.stringify(memo)); }
    await sleep(350);
  }
  fs.writeFileSync(MEMO, JSON.stringify(memo));
  console.log(JSON.stringify({ ...report, hiddenTitles: [...report.hiddenTitles] }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
