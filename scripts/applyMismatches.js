/**
 * scripts/applyMismatches.js
 *
 * Hides the rows listed in mismatches.json (written by auditMismatches.js), except titles that
 * have no word of 3+ letters ("The 355", "IB 71", "AK vs AK"): those cannot be checked by words.
 *
 *   node scripts/applyMismatches.js            # report
 *   node scripts/applyMismatches.js --apply    # hide
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getSupabaseClient } = require("../server/services/supabaseClient");

const APPLY = process.argv.includes("--apply");
const list = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "mismatches.json"), "utf8"));
const hasWord = (title) => /[\p{L}]{3,}/u.test(String(title || "").replace(/\s-\sS\d+E\d+.*$/i, "").replace(/\b(vs|the)\b/gi, ""));
const keep = list.filter((row) => hasWord(row.title) && !/^(The 355|IB 71|AK vs AK)$/i.test(String(row.title).trim()));
const titles = new Set(keep.map((row) => row.title));
console.log(`mismatching rows ${list.length}, to hide ${keep.length}, titles ${titles.size}`);
console.log([...titles].join(" | "));

(async () => {
  if (!APPLY) return;
  const sb = getSupabaseClient();
  for (let i = 0; i < keep.length; i += 200) {
    const ids = keep.slice(i, i + 200).map((row) => row.id);
    const { error } = await sb.from("media_sources").update({ status: "hidden" }).in("id", ids);
    if (error) console.warn("hide failed:", error.message);
  }
  console.log(`hidden ${keep.length} rows`);
})();
