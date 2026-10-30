#!/usr/bin/env node
"use strict";

/**
 * Re-label every media_sources row from the release it actually plays (magnet dn),
 * not from the ingestion label or payload.title (which often names another release).
 *
 *  - Hindi named + English  -> "Dual Audio [Hindi+Eng]"
 *    (for non-English films English must be named; "DUAL Hindi" there is Hindi + Tamil/Telugu)
 *  - Hindi / Hin / Urdu named -> "Hindi"
 *  - no Hindi named           -> "Original" (e.g. Dual-Lat, Brazilian DUAL 5.1, English DUBBED)
 *  - quality column           -> quality in the release name (480p/720p/1080p/2160p)
 *  - movie whose release year differs from the film's year -> deleted (wrong film)
 *  - rows that collide on (media_id, quality, language) after the fix -> best seeded kept
 *
 * --no-delete: nothing is deleted; wrong films are relabelled "Original" and duplicates left as is.
 * Dry run by default. --apply writes. Every changed or deleted row is backed up first to
 * scripts/.media-sources-fix-backup-<timestamp>.json.
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { releaseName, hindiAudioKind, audioLabel, detectQuality } = require("../server/services/releaseAudio");

const APPLY = process.argv.includes("--apply");
/** Relabel only: wrong films become "Original" (never served as Hindi), duplicates are left as they are. */
const NO_DELETE = process.argv.includes("--no-delete");
const WRITE_CONCURRENCY = 10;

async function readAll(supabase, table, columns) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

function releaseYears(name) {
  return (String(name).match(/(?<!\d)(19[3-9]\d|20[0-4]\d)(?!\d|p)/gi) || []).map(Number);
}

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += WRITE_CONCURRENCY) {
    await Promise.all(items.slice(i, i + WRITE_CONCURRENCY).map(fn));
  }
}

async function main() {
  const supabase = getSupabaseClient();
  console.log(APPLY ? "APPLY: writing fixes to Supabase" : "DRY RUN: nothing is written (use --apply)");

  const content = await readAll(supabase, MEDIA_CONTENT_TABLE, "id, external_id, media_type, year:details->>year, lang:details->>original_language");
  const films = new Map();
  for (const c of content) {
    const key = `${c.media_type === "tv" ? "tv" : "movie"}:${c.external_id}`;
    if (!films.has(key) || c.year) films.set(key, { year: Number(c.year) || null, lang: c.lang || "" });
  }

  const rows = await readAll(supabase, MEDIA_SOURCES_TABLE, "id, media_id, media_title, language, quality, seeders, magnet_link, download_url, payload");
  console.log(`media_sources rows: ${rows.length}`);

  const toDelete = new Map(); // id -> { row, reason }
  const planned = [];
  for (const row of rows) {
    const name = releaseName(row);
    const isTv = /-s\d+e\d+/i.test(row.media_id || "");
    const baseId = String(row.media_id || "").replace(/-.*/, "");
    const film = films.get(`${isTv ? "tv" : "movie"}:${baseId}`) || {};

    if (!isTv && film.year) {
      const years = releaseYears(name);
      if (years.length && !years.some((y) => Math.abs(y - film.year) <= 1)) {
        if (NO_DELETE) {
          planned.push({ row, language: "Original", quality: detectQuality(name, row.quality) || row.quality, wrongFilm: true });
        } else {
          toDelete.set(row.id, { row, reason: `wrong film: release ${years.join("/")} vs ${film.year}` });
        }
        continue;
      }
    }

    const language = audioLabel(hindiAudioKind(name, film.lang));
    const quality = detectQuality(name, row.quality) || row.quality;
    planned.push({ row, language, quality });
  }

  // One row per (media_id, quality, language): keep the best seeded, drop the rest.
  const groups = new Map();
  for (const p of planned) {
    const key = `${p.row.media_id}|${p.quality}|${p.language}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const toUpdate = [];
  const skipped = [];
  for (const group of groups.values()) {
    // A row that already holds this key must keep it; otherwise the best seeded one takes it.
    group.sort(
      (a, b) =>
        (a.language === a.row.language && a.quality === a.row.quality ? 0 : 1) -
          (b.language === b.row.language && b.quality === b.row.quality ? 0 : 1) ||
        (Number(b.row.seeders) || 0) - (Number(a.row.seeders) || 0)
    );
    const [keep, ...dupes] = group;
    for (const d of dupes) {
      if (NO_DELETE) skipped.push(d);
      else toDelete.set(d.row.id, { row: d.row, reason: "duplicate after relabel" });
    }
    if (keep.language !== keep.row.language || keep.quality !== keep.row.quality) toUpdate.push(keep);
  }
  if (NO_DELETE) {
    console.log(`wrong films relabelled "Original": ${toUpdate.filter((p) => p.wrongFilm).length}`);
    console.log(`left unchanged (would collide on media_id+quality+language): ${skipped.length}`);
  }

  const count = (list, f) => list.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  console.log("relabel (old -> new language):", count(toUpdate, (p) => `${p.row.language} -> ${p.language}`));
  console.log("quality corrections:", toUpdate.filter((p) => p.quality !== p.row.quality).length);
  console.log("deletes:", count([...toDelete.values()], (d) => d.reason.replace(/:.*/, "")));
  for (const d of [...toDelete.values()].filter((d) => d.reason.startsWith("wrong film")).slice(0, 10)) {
    console.log(`  wrong film: ${d.row.media_title} (${d.row.media_id}) <- ${releaseName(d.row).slice(0, 80)}`);
  }
  const after = count(planned.filter((p) => !toDelete.has(p.row.id)), (p) => p.language);
  console.log("labels after fix:", after);

  if (!APPLY) return;

  const backupFile = path.join(__dirname, `.media-sources-fix-backup-${Date.now()}.json`);
  fs.writeFileSync(
    backupFile,
    JSON.stringify({ deleted: [...toDelete.values()], updated: toUpdate.map((p) => ({ before: p.row, language: p.language, quality: p.quality })) }, null, 2)
  );
  console.log(`backup written: ${backupFile}`);

  // Deletes first so relabelled rows never hit the unique (media_id, quality, language) key.
  const ids = [...toDelete.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabase.from(MEDIA_SOURCES_TABLE).delete().in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`delete: ${error.message}`);
  }
  console.log(`deleted ${ids.length}`);

  let ok = 0;
  const failed = [];
  await inBatches(toUpdate, async (p) => {
    const payload = { ...(p.row.payload || {}), language_label: p.language, previous_language: p.row.language, previous_quality: p.row.quality };
    const { error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .update({ language: p.language, quality: p.quality, payload, updated_at: new Date().toISOString() })
      .eq("id", p.row.id);
    if (error) failed.push(`${p.row.id}: ${error.message}`);
    else ok++;
  });
  console.log(`updated ${ok}, failed ${failed.length}`);
  for (const f of failed.slice(0, 10)) console.log("  ", f);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
